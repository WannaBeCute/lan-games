'use strict';
/**
 * 好友系统（平台层，所有游戏通用）
 *
 * 设计要点：
 *   - 身份以「IP」为单位：同一台电脑重开页面、换游戏、换房间，好友关系与聊天记录都还在。
 *     服务端重启后也不丢（pairs / chats 会落盘，见 _persist）。
 *   - 本模块挂在平台层，不属于任何游戏：消息类型统一用 friends. 前缀，
 *     由 server.cjs 在游戏路由之前直接处理（和 ping / hello 一个层级）。
 *   - 服务端零依赖：只用 Node 内置模块，落盘用「写临时文件再 rename」的土法原子写。
 *
 * 消息一览（C=客户端 S=服务端）：
 *   C→S  friends.add        { ip }                  加好友（发邀请）
 *   C→S  friends.accept     { ip }                  接受好友邀请
 *   C→S  friends.reject     { ip }                  拒绝好友邀请
 *   C→S  friends.remove     { ip }                  删除好友
 *   C→S  friends.chat       { ip, text, mid }       发消息（mid 由客户端生成，用于回显去重）
 *   C→S  friends.history    { ip }                  拉取与某好友的聊天记录
 *   C→S  friends.team       { ip, game, entry, param, data, text } 发起组队邀请（免邀请码直达）
 *   C→S  friends.teamReply  { ip, accept }          应答组队邀请
 *   S→C  friends.state      { me, online, friends, requests }   全量状态（首次 hello 后下发）
 *   S→C  friends.invited    { from, name, ip }      收到好友邀请（左下角弹窗）
 *   S→C  friends.result     { ok, msg }             操作结果提示
 *   S→C  friends.presence   { ip, name, online }    好友上下线
 *   S→C  friends.chat       { from, name, text, ts, mid, self }  聊天消息（self=true 是自己的回显）
 *   S→C  friends.history    { ip, list }            聊天记录
 *   S→C  friends.teamInvited{ from, name, ip, game, data, text } 收到组队邀请（左下角弹窗）
 *   S→C  friends.teamResult { ip, name, accept, game }           组队邀请被应答
 */
const fs = require('fs');
const path = require('path');

const REQUEST_TTL = 5 * 60 * 1000;    // 好友邀请 5 分钟过期
const TEAM_TTL = 2 * 60 * 1000;       // 组队邀请 2 分钟过期
const CHAT_CAP = 300;                 // 每对好友最多保留的聊天条数
const CHAT_MAX_LEN = 500;             // 单条消息长度上限
const DATA_FILE = process.env.WB_FRIENDS_FILE || path.join(__dirname, 'friends-data.json');

function pairKey(a, b) { return a < b ? (a + '|' + b) : (b + '|' + a); }

const TEAM_DATA_MAX = 1024;           // 组队邀请附带的 data 序列化后的长度上限
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;

/**
 * 受邀方可能正停在别的页面（最常见的就是平台主页），那个页面根本不认识这个游戏，
 * 所以邀请里必须带一句「怎么跳过去」：站内入口路径 + 参数名。
 *
 * 入口路径只放行站内相对路径 —— 挡掉 http://、//host 这种协议相对写法，
 * 也挡掉带 ? # \ 的花样（否则就成了把一个外来 URL 塞给别人的浏览器去跳）。
 */
function safeEntryPath(v) {
  const s = typeof v === 'string' ? v.trim().slice(0, 120) : '';
  if (!s || s.charAt(0) !== '/' || s.charAt(1) === '/') return '';
  if (/[\\?#]/.test(s) || !/^\/[A-Za-z0-9._/-]+$/.test(s)) return '';
  return s;
}

/** 参数名：老老实实一个标识符，别混进 & 之类的分隔符 */
function safeParamName(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return PARAM_NAME.test(s) ? s : '';
}

/** 组队邀请的 data 只用来带"房间号 / 邀请码"这种小东西，过大的直接丢弃 */
function safeTeamData(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  try {
    return JSON.stringify(v).length <= TEAM_DATA_MAX ? v : {};
  } catch (e) { return {}; }
}

class Friends {
  constructor(ctx) {
    this.ctx = ctx;
    /** ip -> Set<ip>：好友关系（双向都存，删除时任删一侧即可） */
    this.pairs = new Map();
    /** pairKey -> [{from,name,text,ts,mid}]：聊天记录 */
    this.chats = new Map();
    /** toIp -> [{from,name,ts}]：待处理的好友邀请 */
    this.requests = new Map();
    /** toIp -> [{from,name,game,data,text,ts}]：待处理的组队邀请 */
    this.teamInvites = new Map();
    /** ip -> { count, name, code, client }：当前在线的 IP（同一台电脑可能开多个页面） */
    this.online = new Map();
    /**
     * ip -> 最后一次用过的昵称。
     * 只靠 online 里的名字的话，人一下线名字就没了，好友列表会退化成显示 IP；
     * 昵称跟着"这台电脑"走，和好友关系一样是长期的，所以单独记一份。
     */
    this.names = new Map();
    /** ip -> 上次算出来的「组队中」摘要（用来发现变化，变了才广播，别每秒都刷屏） */
    this._busyKeys = new Map();
    this._timers = new Set();
    this._saveTimer = null;
    this._load();
  }

  /* ================= 持久化 ================= */
  _load() {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.pairs && typeof raw.pairs === 'object') {
          for (const ip of Object.keys(raw.pairs)) {
            const list = Array.isArray(raw.pairs[ip]) ? raw.pairs[ip] : [];
            this.pairs.set(ip, new Set(list.filter(x => typeof x === 'string')));
          }
        }
        if (raw.chats && typeof raw.chats === 'object') {
          for (const k of Object.keys(raw.chats)) {
            const list = Array.isArray(raw.chats[k]) ? raw.chats[k] : [];
            this.chats.set(k, list.filter(m => m && typeof m.text === 'string').slice(-CHAT_CAP));
          }
        }
        if (raw.names && typeof raw.names === 'object') {
          for (const ip of Object.keys(raw.names)) {
            if (typeof raw.names[ip] === 'string') this.names.set(ip, raw.names[ip]);
          }
        }
        /*
         * 历史数据回填：早期的存档只记了"好友关系 + 聊天记录"，没有昵称表。
         * 结果是升级之后老朋友只要不在线，好友列表里就只剩一个 IP。
         * 聊天记录的每一条都带着发送者昵称，正好用来把名字补回来。
         */
        for (const list of this.chats.values()) {
          for (const m of list) {
            if (m && m.from && m.name && !this.names.has(m.from)) this.names.set(m.from, m.name);
          }
        }
      }
    } catch (e) { /* 数据损坏就当作没有存档，不影响开服 */ }
  }

  /** 防抖落盘：临时文件 + rename，避免写一半把存档写坏 */
  _persist() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const pairs = {};
        for (const [ip, set] of this.pairs) pairs[ip] = Array.from(set);
        const chats = {};
        for (const [k, list] of this.chats) chats[k] = list;
        const names = {};
        for (const [ip, n] of this.names) names[ip] = n;
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), pairs, chats, names }));
        fs.renameSync(tmp, DATA_FILE);
      } catch (e) { /* 磁盘出问题不影响内存里的好友关系 */ }
    }, 600);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /* ================= 生命周期钩子（由 server.cjs 调用） ================= */

  /**
   * 客户端首次 hello（昵称已定）后调用：
   * 登记在线状态、给本人下发全量状态、通知他的好友「我上线了」。
   * 同一 IP 多个页面只算一个在线实体，count 用于引用计数。
   */
  onHello(client) {
    // 记住这台电脑最后用过的昵称：掉线后好友列表还能显示名字，而不是一个光秃秃的 IP
    this._rememberName(client.ip, client.name);
    if (client._friendsSeen) {
      // 改名：刷新在线记录并让好友看到新名字
      const rec = this.online.get(client.ip);
      if (rec && rec.name !== client.name) {
        rec.name = client.name;
        rec.client = client;
        this._notifyPresence(client.ip, true);
      }
      return;
    }
    client._friendsSeen = true;
    const rec = this.online.get(client.ip);
    if (rec) {
      rec.count++;
      rec.name = client.name;
      rec.code = client.inviteCode;
      rec.client = client;
    } else {
      this.online.set(client.ip, { count: 1, name: client.name, code: client.inviteCode, client });
      this._notifyPresence(client.ip, true);
    }
    // 记下此刻的组队状态：状态是随 _sendState 一起发出去的，
    // 不先对齐的话，下一秒的巡检会以为"变了"而多广播一次
    const busy = this._teamOf(client.ip);
    this._busyKeys.set(client.ip, busy ? (busy.game + ':' + (busy.code || busy.label)) : '');
    this._sendState(client);
  }

  /** 连接断开：引用计数归零才真正算离线，并通知好友 */
  onClose(client) {
    const rec = this.online.get(client.ip);
    if (!rec) return;
    rec.count = Math.max(0, rec.count - 1);
    if (rec.count > 0) {
      if (rec.client === client) {
        // 这个页面没了，但同一 IP 还有别的页面：在线实体转交给剩下的连接
        rec.client = null;
      }
      return;
    }
    this.online.delete(client.ip);
    this._busyKeys.delete(client.ip);
    this._notifyPresence(client.ip, false);
  }

  /* ================= 内部工具 ================= */
  _send(client, obj) { this.ctx.send(client, obj); }

  _clientByIp(ip) {
    const rec = this.online.get(ip);
    return rec && rec.client ? rec.client : null;
  }

  friendsOf(ip) { return this.pairs.get(ip) || new Set(); }

  areFriends(a, b) { return this.friendsOf(a).has(b); }

  _addPair(a, b) {
    if (!this.pairs.has(a)) this.pairs.set(a, new Set());
    if (!this.pairs.has(b)) this.pairs.set(b, new Set());
    this.pairs.get(a).add(b);
    this.pairs.get(b).add(a);
  }

  _removePair(a, b) {
    const sa = this.pairs.get(a); if (sa) sa.delete(b);
    const sb = this.pairs.get(b); if (sb) sb.delete(a);
    if (sa && sa.size === 0) this.pairs.delete(a);
    if (sb && sb.size === 0) this.pairs.delete(b);
  }

  /**
   * 广播上下线。发给**所有**在线者（不只是好友）—— 否则「在线人员」列表
   * 看不到后才进来的人。friend / requested 按接收方个性化计算。
   */
  _notifyPresence(ip, online) {
    const rec = this.online.get(ip);
    const name = this._nameOf(ip, rec);
    for (const [cip, crec] of this.online) {
      if (cip === ip) continue;
      const c = crec.client;
      if (!c) continue;
      this._send(c, {
        t: 'friends.presence', ip, name, online,
        busy: this._teamOf(ip),                 // 在不在组队里（列表据此显示「组队中」）
        friend: this.areFriends(cip, ip),
        requested: this._hasRequest(ip, cip)
      });
    }
  }

  _later(ms, fn) {
    const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms);
    this._timers.add(t);
    if (t.unref) t.unref();
    return t;
  }

  _sendState(client) {
    const me = client.ip;
    const online = [];
    for (const [ip, rec] of this.online) {
      if (ip === me) continue;
      online.push({
        ip, name: rec.name, code: rec.code,
        friend: this.areFriends(me, ip),
        // 我已加对方为好友 / 我已邀请对方（等待回应）/ 可以发邀请
        requested: this._hasRequest(ip, me)
      });
    }
    const friends = [];
    for (const fip of this.friendsOf(me)) {
      const rec = this.online.get(fip);
      // 离线的好友也保留昵称（记在 names 里），别退化成只显示 IP
      friends.push({
        ip: fip, name: this._nameOf(fip, rec) || fip,
        online: !!rec, code: rec ? rec.code : '',
        busy: this._teamOf(fip)          // 对方正在组队 → 列表里显示「组队中」并禁掉邀请
      });
    }
    const requests = [];
    for (const r of (this.requests.get(me) || [])) {
      requests.push({ ip: r.from, name: r.name, ts: r.ts });
    }
    // busy 是"我自己"的状态：我已经在别人房里，就不该再接受第三方的邀请
    this._send(client, {
      t: 'friends.state', me, online, friends, requests,
      busy: this._teamOf(me)
    });
  }

  /**
   * 记下这台电脑的昵称。
   * 好友身份是 IP，但人看的是名字 —— 只要见过一次就存下来，
   * 这样对方以后一直不在线，列表里也还是「小明」而不是「10.1.1.9」。
   */
  _rememberName(ip, name) {
    const n = String(name || '').trim();
    if (!ip || !n) return;
    if (this.names.get(ip) === n) return;
    this.names.set(ip, n);
    this._persist();
  }

  /** 某台电脑现在该显示什么名字：在线记录最准，其次昵称表，最后才退回 IP */
  _nameOf(ip, rec) {
    const r = rec || this.online.get(ip);
    if (r && r.name) return r.name;
    return this.names.get(ip) || '';
  }

  /**
   * 这台电脑现在是不是在「组队」里（哪个游戏、哪个房间由游戏自己说，见 ctx.teamOf）。
   * 同一台电脑可能开着好几个页面，只要有一个在组队里就算 —— 否则"一边挂机一边被邀请"会漏判。
   * 离线 / 没在房间里 → null。
   */
  _teamOf(ip) {
    if (!this.ctx || !this.ctx.teamOf) return null;
    if (!this.online.has(ip)) return null;              // 人都不在，谈不上组队
    for (const c of this.ctx.clients.values()) {
      if (c.ip !== ip) continue;
      const b = this.ctx.teamOf(c);
      if (b) return b;
    }
    return null;
  }

  /**
   * 每秒对一遍「组队中」状态（由 server.cjs 的主循环调用）。
   * 有变化才广播 —— 建房、入房、离开、开局都能让好友列表实时跟着变，
   * 但没人组队时这里一直什么都不做，不产生任何流量。
   */
  detectTeamChanges() {
    for (const ip of this.online.keys()) {
      const busy = this._teamOf(ip);
      const key = busy ? (busy.game + ':' + (busy.code || busy.label)) : '';
      if (this._busyKeys.get(ip) === key) continue;
      this._busyKeys.set(ip, key);
      this._notifyPresence(ip, true);       // 让别人看到「组队中」
      /*
       * 也要把新状态告诉**本人**：presence 只发给别人，而"我自己在不在组队里"
       * 决定了要不要拦住别人的组队邀请（见 friends.js 的 myBusy）。
       * 这一步只能在状态真变了的时候做，别每秒刷。
       */
      for (const c of this.ctx.clients.values()) if (c.ip === ip) this._sendState(c);
    }
  }

  _hasRequest(toIp, fromIp) {
    return (this.requests.get(toIp) || []).some(r => r.from === fromIp);
  }

  _takeRequest(toIp, fromIp) {
    const list = this.requests.get(toIp) || [];
    const i = list.findIndex(r => r.from === fromIp);
    if (i < 0) return null;
    const [r] = list.splice(i, 1);
    if (!list.length) this.requests.delete(toIp);
    return r;
  }

  _takeTeamInvite(toIp, fromIp) {
    const list = this.teamInvites.get(toIp) || [];
    const i = list.findIndex(r => r.from === fromIp);
    if (i < 0) return null;
    const [r] = list.splice(i, 1);
    if (!list.length) this.teamInvites.delete(toIp);
    return r;
  }

  /* ================= 消息处理 ================= */

  /** 加好友：只能邀请当前在线的人 */
  add(client, msg) {
    const ip = String((msg && msg.ip) || '').trim();
    if (!ip) { this._send(client, { t: 'friends.result', ok: false, msg: '缺少对方 IP' }); return; }
    if (ip === client.ip) { this._send(client, { t: 'friends.result', ok: false, msg: '不能添加自己' }); return; }
    if (this.areFriends(client.ip, ip)) { this._send(client, { t: 'friends.result', ok: false, msg: '你们已经是好友了' }); return; }
    if (this._hasRequest(ip, client.ip)) { this._send(client, { t: 'friends.result', ok: false, msg: '好友邀请已发送，等待对方回应' }); return; }
    const target = this._clientByIp(ip);
    if (!target) { this._send(client, { t: 'friends.result', ok: false, msg: '对方不在线' }); return; }

    if (!this.requests.has(ip)) this.requests.set(ip, []);
    this.requests.get(ip).push({ from: client.ip, name: client.name, ts: Date.now() });
    // 加好友这一刻双方都在线，名字一定拿得到 —— 趁机存下来，别等以后再靠 IP 认人
    this._rememberName(client.ip, client.name);
    this._rememberName(ip, target.name);
    this._send(target, { t: 'friends.invited', from: client.ip, name: client.name });
    this._send(client, { t: 'friends.result', ok: true, msg: '好友邀请已发送给 ' + target.name });

    // 过期自动清理，避免 requests 里堆陈旧数据
    this._later(REQUEST_TTL, () => { this._takeRequest(ip, client.ip); });
  }

  accept(client, msg) {
    const ip = String((msg && msg.ip) || '').trim();
    const req = this._takeRequest(client.ip, ip);
    if (!req) { this._send(client, { t: 'friends.result', ok: false, msg: '邀请不存在或已过期' }); return; }
    this._addPair(client.ip, ip);
    this._rememberName(ip, req.name);          // 邀请里带着发起方的昵称，记下来
    this._rememberName(client.ip, client.name);
    this._persist();
    const other = this._clientByIp(ip);
    if (other) {
      this._send(other, { t: 'friends.result', ok: true, msg: client.name + ' 接受了你的好友邀请，你们已是好友' });
      this._sendState(other);
    }
    this._send(client, { t: 'friends.result', ok: true, msg: '已添加 ' + (req.name || ip) + ' 为好友' });
    this._sendState(client);
  }

  reject(client, msg) {
    const ip = String((msg && msg.ip) || '').trim();
    const req = this._takeRequest(client.ip, ip);
    if (!req) return;
    const other = this._clientByIp(ip);
    if (other) this._send(other, { t: 'friends.result', ok: false, msg: client.name + ' 拒绝了你的好友邀请' });
    this._send(client, { t: 'friends.result', ok: true, msg: '已拒绝 ' + (req.name || ip) + ' 的好友邀请' });
  }

  remove(client, msg) {
    const ip = String((msg && msg.ip) || '').trim();
    if (!this.areFriends(client.ip, ip)) { this._send(client, { t: 'friends.result', ok: false, msg: '对方不是你的好友' }); return; }
    this._removePair(client.ip, ip);
    this._persist();
    const other = this._clientByIp(ip);
    if (other) {
      this._send(other, { t: 'friends.result', ok: false, msg: client.name + ' 把你从好友列表移除了' });
      this._sendState(other);
    }
    this._send(client, { t: 'friends.result', ok: true, msg: '已删除好友' });
    this._sendState(client);
  }

  /** 好友聊天：只有好友能聊；对方在线立即送达，不在线存记录（上线后不补推，拉历史可见） */
  chat(client, msg) {
    const ip = String((msg && msg.ip) || '').trim();
    const text = String((msg && msg.text) || '').slice(0, CHAT_MAX_LEN).trim();
    if (!ip || !text) return;
    if (!this.areFriends(client.ip, ip)) { this._send(client, { t: 'friends.result', ok: false, msg: '只能和好友聊天' }); return; }
    const mid = String((msg && msg.mid) || '').slice(0, 40) || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    const entry = { from: client.ip, name: client.name, text, ts: Date.now(), mid };
    const key = pairKey(client.ip, ip);
    if (!this.chats.has(key)) this.chats.set(key, []);
    const list = this.chats.get(key);
    list.push(entry);
    if (list.length > CHAT_CAP) list.splice(0, list.length - CHAT_CAP);

    const target = this._clientByIp(ip);
    if (target) this._send(target, { t: 'friends.chat', from: client.ip, name: client.name, text, ts: entry.ts, mid, self: false });
    // 回显给发送者（self=true）：多页面时只有当前连接收到，客户端按 mid 去重
    this._send(client, { t: 'friends.chat', from: client.ip, name: client.name, text, ts: entry.ts, mid, self: true });
    this._persist();
  }

  history(client, msg) {
    const ip = String((msg && msg.ip) || '').trim();
    if (!ip || !this.areFriends(client.ip, ip)) return;
    const list = (this.chats.get(pairKey(client.ip, ip)) || []).slice(-100);
    this._send(client, { t: 'friends.history', ip, list });
  }

  /** 组队邀请：免邀请码直达。data 由调用方游戏自定义（房间号 / 邀请码等） */
  team(client, msg) {
    const ip = String((msg && msg.ip) || '').trim();
    if (!this.areFriends(client.ip, ip)) { this._send(client, { t: 'friends.result', ok: false, msg: '只能邀请好友组队' }); return; }
    const target = this._clientByIp(ip);
    if (!target) { this._send(client, { t: 'friends.result', ok: false, msg: '对方不在线' }); return; }
    /*
     * 对方正在跟别人组队（人已经在房间里了）→ 别打扰。
     * 他那边点接受也会被拦（见 teamReply），所以在这里就挡下来，两边都清爽。
     */
    const targetBusy = this._teamOf(ip);
    if (targetBusy) {
      this._send(client, {
        t: 'friends.result', ok: false,
        msg: '对方正在' + (targetBusy.gameTitle ? '「' + targetBusy.gameTitle + '」' : '') + '组队中，暂时无法邀请'
      });
      return;
    }
    const game = String((msg && msg.game) || '').slice(0, 24);
    if (!game) { this._send(client, { t: 'friends.result', ok: false, msg: '缺少游戏标识' }); return; }
    const data = safeTeamData(msg && msg.data);
    const text = String((msg && msg.text) || '').slice(0, 80);
    // 受邀方不一定待在同一个游戏页面，带上显示名 / 入口 / 参数名，让它自己跳过去
    const label = String((msg && msg.label) || '').slice(0, 24);
    const entry = safeEntryPath(msg && msg.entry);
    const param = safeParamName(msg && msg.param);

    if (!this.teamInvites.has(ip)) this.teamInvites.set(ip, []);
    this.teamInvites.get(ip).push({ from: client.ip, name: client.name, game, label, entry, param, data, text, ts: Date.now() });
    this._send(target, { t: 'friends.teamInvited', from: client.ip, name: client.name, game, label, entry, param, data, text });
    this._send(client, { t: 'friends.result', ok: true, msg: '组队邀请已发送给 ' + target.name });

    this._later(TEAM_TTL, () => { this._takeTeamInvite(ip, client.ip); });
  }

  /** 组队邀请应答：结果转告发起人；「接受」后的跳转/入座由客户端自己完成 */
  teamReply(client, msg) {
    const ip = String((msg && msg.ip) || '').trim();
    const inv = this._takeTeamInvite(client.ip, ip);
    if (!inv) return;
    /*
     * 自己已经在组队里了（在别人的房间/对局中）→ 不能接受邀请。
     * 客户端点「接受」时会先自查并弹提示，这里再兜一道：
     * 旧页面、刷新了半天没更新的标签页，都别想绕过去。
     */
    const mineBusy = this._teamOf(client.ip);
    if (msg.accept && mineBusy) {
      const other = this._clientByIp(ip);
      if (other) {
        this._send(other, {
          t: 'friends.teamResult', ip: client.ip, name: client.name,
          accept: false, game: inv.game, reason: 'busy'
        });
      }
      this._send(client, { t: 'friends.result', ok: false, msg: '你已在组队状态中，无法接受邀请' });
      return;
    }
    const other = this._clientByIp(ip);
    if (other) {
      this._send(other, {
        t: 'friends.teamResult', ip: client.ip, name: client.name,
        accept: !!msg.accept, game: inv.game,
        reason: String((msg && msg.reason) || '').slice(0, 16)   // 比如 'busy'：对方那会儿正在组队
      });
    }
    // 因"自己正在组队"而拒绝的，客户端点的时候就自己提示过了，别再回一条重复的
    if (msg.reason !== 'busy') {
      this._send(client, {
        t: 'friends.result',
        ok: true,
        msg: msg.accept ? ('已接受 ' + inv.name + ' 的组队邀请') : ('已拒绝 ' + inv.name + ' 的组队邀请')
      });
    }
  }

  /** 客户端主动拉一次全量状态（打开好友面板时用，保证列表是最新的） */
  refresh(client) {
    this._sendState(client);
  }

  /** 给 /api/status 用的统计 */
  stats() {
    let pairCount = 0;
    for (const set of this.pairs.values()) pairCount += set.size;
    return { friendPairs: pairCount / 2, friendOnlineIps: this.online.size };
  }
}

Friends.routes = {
  'friends.add': 'add',
  'friends.accept': 'accept',
  'friends.reject': 'reject',
  'friends.remove': 'remove',
  'friends.chat': 'chat',
  'friends.history': 'history',
  'friends.team': 'team',
  'friends.teamReply': 'teamReply',
  'friends.refresh': 'refresh'
};

/* 落盘文件位置暴露给启动横幅：让开服的人一眼看到"数据存在哪" */
Friends.DATA_FILE = DATA_FILE;

module.exports = Friends;
