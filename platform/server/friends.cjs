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
 *   C→S  friends.team       { ip, game, data, text } 发起组队邀请（免邀请码直达）
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
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), pairs, chats }));
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
    const name = rec ? rec.name : '';
    for (const [cip, crec] of this.online) {
      if (cip === ip) continue;
      const c = crec.client;
      if (!c) continue;
      this._send(c, {
        t: 'friends.presence', ip, name, online,
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
      friends.push({ ip: fip, name: rec ? rec.name : fip, online: !!rec, code: rec ? rec.code : '' });
    }
    const requests = [];
    for (const r of (this.requests.get(me) || [])) {
      requests.push({ ip: r.from, name: r.name, ts: r.ts });
    }
    this._send(client, { t: 'friends.state', me, online, friends, requests });
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
    const game = String((msg && msg.game) || '').slice(0, 24);
    if (!game) { this._send(client, { t: 'friends.result', ok: false, msg: '缺少游戏标识' }); return; }
    const data = (msg && msg.data && typeof msg.data === 'object') ? msg.data : {};
    const text = String((msg && msg.text) || '').slice(0, 80);

    if (!this.teamInvites.has(ip)) this.teamInvites.set(ip, []);
    this.teamInvites.get(ip).push({ from: client.ip, name: client.name, game, data, text, ts: Date.now() });
    this._send(target, { t: 'friends.teamInvited', from: client.ip, name: client.name, game, data, text });
    this._send(client, { t: 'friends.result', ok: true, msg: '组队邀请已发送给 ' + target.name });

    this._later(TEAM_TTL, () => { this._takeTeamInvite(ip, client.ip); });
  }

  /** 组队邀请应答：结果转告发起人；「接受」后的跳转/入座由客户端自己完成 */
  teamReply(client, msg) {
    const ip = String((msg && msg.ip) || '').trim();
    const inv = this._takeTeamInvite(client.ip, ip);
    if (!inv) return;
    const other = this._clientByIp(ip);
    if (other) {
      this._send(other, {
        t: 'friends.teamResult', ip: client.ip, name: client.name,
        accept: !!msg.accept, game: inv.game
      });
    }
    this._send(client, {
      t: 'friends.result',
      ok: true,
      msg: msg.accept ? ('已接受 ' + inv.name + ' 的组队邀请') : ('已拒绝 ' + inv.name + ' 的组队邀请')
    });
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

module.exports = Friends;
