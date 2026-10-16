'use strict';
/**
 * 坦克大战 —— 房间 / 局数制对局 / 服务端权威模拟
 * 规则：房主设置对局局数（默认 20，上限 999），每局结束后累计战绩，
 *       所有局打完后结算总排名。
 */
const TankCore = require('../shared/tankcore.js');

/**
 * 单局时限涉及两个"变量"，职责必须严格分开，别再混成一坨：
 *
 *   ROUND_LIMIT（tankcore 常量，默认 150 秒）
 *     —— 游戏真实的单局时长，唯一权威来源。本地对局、客户端 HUD、联机快照都读它。
 *        它是"配置"，正式服运行时任何地方都不应该改写它。
 *
 *   WB_ROUND_LIMIT（环境变量）
 *     —— 仅供自动化测试压缩单局时长（例如 nettest 用 6 秒快速跑完多局）。
 *        它是"开关"，只用来算出下面这个服务端本局生效值，**绝不回写内核常量**。
 *
 * 之前直接用 TankCore.ROUND_LIMIT = v 覆盖内核常量，等于把测试开关接到了配置线路上：
 * 只要启动时带了 WB_ROUND_LIMIT=6，联机对局的时长就永久变成 6 秒（正是线上观察到的问题）。
 * 现在拆成独立的一份 ROUND_LIMIT，测试值只作用于服务端本局，泄漏不出去。
 */
const ROUND_LIMIT = (function () {
  const raw = process.env.WB_ROUND_LIMIT;
  const v = parseFloat(raw);
  return (raw && isFinite(v) && v > 0) ? v : TankCore.ROUND_LIMIT;
})();

const MAX_PLAYERS = 4;
const MAX_ROUNDS = 999;
const DEFAULT_ROUNDS = 20;
const SNAPSHOT_HZ = 30;
const INTERMISSION = 3;        // 局间休息（默认每局一条命，结束得很快，间隔压到 3 秒）
const END_DELAY = 2;           // 决出胜负后再等 2 秒才结算：让爆炸动画播完，也让"同归于尽"能判成平局
const FREEZE = 1.6;            // 开局冻结倒计时
const DEFAULT_LIVES = 1;       // 每局生命数默认 1 条（房主可在 1~5 之间调整）
const MAX_LIVES = 5;

/**
 * 掉线宽限期（毫秒）。
 * WebSocket 因为刷新页面 / 切后台 / 网络抖一下而断开时，**不能**当场把人踢出房间 ——
 * 以前 onClose 直接走 leave，房主一刷新房间就没了，于是"刚发出去的房间号别人加不进来"
 * （房间已被销毁），重新建一个又好了。现在先标记掉线、留这么久的宽限期，
 * 带着同一把身份钥匙回来就原样还给他（见 Hub._reattach）。
 */
const DROP_GRACE_MS = (function () {
  // 自动化测试要能在几百毫秒内把宽限期走完（和 WB_ROUND_LIMIT 一个路子）
  const v = parseFloat(process.env.WB_DROP_GRACE_MS);
  return (isFinite(v) && v >= 200) ? v : 30000;
})();

const COLORS = TankCore.TANK_COLORS;
const STYLES = TankCore.TANK_STYLES;
const ALL_POWERUPS = TankCore.POWERUP_TYPES.slice();   // 房间里可勾选的道具（默认全选）

function newCode(rooms) {
  for (let i = 0; i < 5000; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(Date.now()).slice(-4);
}

class TankHub {
  constructor(ctx) {
    this.ctx = ctx;
    this.rooms = new Map();     // code -> room
    this.byKey = new Map();     // 身份钥匙 -> { code, clientId }（刷新/断线重连靠它回房）
    // 巡检间隔跟着宽限期走：宽限期是 30 秒时 5 秒一巡；测试把它压到几百毫秒也来得及收尾
    const every = Math.max(200, Math.min(5000, Math.round(DROP_GRACE_MS / 4)));
    const sweep = setInterval(() => this._sweepDropped(), every);
    if (sweep.unref) sweep.unref();
  }

  roomCount() { return this.rooms.size; }
  /** 给主机 /api/status 用的统计（每个游戏自己声明要暴露什么） */
  stats() { return { tankRooms: this.rooms.size }; }

  /* ---------- 房间管理 ---------- */
  /** 身份钥匙（平台层 WB.me 给每个标签页发的那把，刷新/重连后不变） */
  _key(msg) {
    const k = msg && msg.key;
    return (typeof k === 'string' && k) ? k.slice(0, 64) : '';
  }

  create(client, msg) {
    this.leave(client);
    const code = newCode(this.rooms);
    const room = {
      code,
      hostId: client.id,
      members: [],
      rounds: DEFAULT_ROUNDS,
      lives: DEFAULT_LIVES, // 每局每个坦克几条命（房主可设 1~5）
      addBots: false,       // 是否允许补充 AI 坦克（默认不加，房主可打开）
      // 场上会掉落哪些道具（房主可勾选，默认全选）
      powerups: ALL_POWERUPS.slice(),
      selfDamage: false,    // 自己的子弹会不会伤到自己（默认不会，房主可开）
      roundIndex: 0,
      state: 'lobby',       // lobby | playing | intermission | over
      world: null,
      scores: {},           // clientId -> {wins,kills,deaths,rounds}
      inputs: {},
      tankOf: {},
      snapshotAcc: 0,
      interTimer: 0,
      endTimer: 0,          // >0 表示胜负已定、正在等结算（留给爆炸动画与同归于尽）
      endReason: false,     // true = 本局是打到时限结束的
      roundTime: 0,
      lastRound: null,
      results: []           // 每局结果
    };
    this.rooms.set(code, room);
    this._add(room, client, this._key(msg));
    this.ctx.send(client, { t: 'tank.created', code });
    this._pushRoom(room);
    console.log('[tank] 房间', code, '由', client.name, '创建');
  }

  join(client, msg) {
    const code = String(msg && msg.code || '').trim();
    const key = this._key(msg);
    const room = this.rooms.get(code);
    if (!room) { this.ctx.send(client, { t: 'tank.error', msg: '房间号不存在，请检查后重试' }); return; }

    /*
     * ① 带着同一把钥匙回来（刷新页面 / 断线重连）：
     *    座位、准备状态、比分原样奉还，**对局进行中也照收** ——
     *    这正是"在房间里刷新一下要能回到房间里"。放在状态校验之前，否则
     *    "已开局"那一关会把人挡在外面。
     */
    if (this._reattach(client, key, code)) {
      this.ctx.send(client, { t: 'tank.joined', code, resumed: true });
      return;
    }

    if (room.state !== 'lobby') { this.ctx.send(client, { t: 'tank.error', msg: '该房间已开局，暂时无法加入' }); return; }
    if (room.members.length >= MAX_PLAYERS) { this.ctx.send(client, { t: 'tank.error', msg: '房间已满（最多 4 人）' }); return; }

    this.leave(client);
    this._add(room, client, key);
    this.ctx.send(client, { t: 'tank.joined', code });
    this._pushRoom(room);
  }

  /**
   * 按身份钥匙把成员挂回这条新连接。
   * 刷新 / 断线重连都走这里：把 clientId 换成新的，并把比分、输入、坦克 id
   * 一起改挂到新 id 上（坦克 id = 1000 + 连接 id，客户端就是这么认自己车的）。
   */
  _reattach(client, key, code) {
    if (!key) return false;
    const hit = this.byKey.get(key);
    if (!hit) return false;
    if (code && hit.code !== code) return false;
    const room = this.rooms.get(hit.code);
    if (!room) { this.byKey.delete(key); return false; }
    const m = this._member(room, hit.clientId);
    if (!m) { this.byKey.delete(key); return false; }

    const oldId = m.clientId;
    if (oldId !== client.id) {
      const oldClient = this.ctx.clients.get(oldId);
      if (oldClient && oldClient !== client) { oldClient.room = null; oldClient.tankMember = null; }
      m.clientId = client.id;
      if (room.scores[oldId]) { room.scores[client.id] = room.scores[oldId]; delete room.scores[oldId]; }
      if (room.inputs[oldId]) { room.inputs[client.id] = room.inputs[oldId]; delete room.inputs[oldId]; }
      if (room.tankOf[oldId] != null) {
        delete room.tankOf[oldId];
        const t = room.world ? TankCore.findTank(room.world, 1000 + oldId) : null;
        if (t) t.id = 1000 + client.id;            // 改名：客户端按 1000+连接 id 认自己的车
        room.tankOf[client.id] = 1000 + client.id;
      }
      if (room.hostId === oldId) room.hostId = client.id;
      if (Array.isArray(room.results)) {
        for (const r of room.results) for (const row of (r.rows || [])) if (row.id === oldId) row.id = client.id;
      }
    }
    if (!room.scores[client.id]) room.scores[client.id] = { wins: 0, kills: 0, deaths: 0 };
    if (room.state === 'playing') room.inputs[client.id] = { up: false, down: false, left: false, right: false, fire: false };
    m.dropped = false;
    m.dropAt = 0;
    client.room = room;
    client.tankMember = m;
    this.byKey.set(key, { code: room.code, clientId: client.id });

    this._pushRoom(room);
    // 对局进行中回来的：把这一局的场景重发一份，客户端直接重新进画面继续打
    if (room.state === 'playing' && room.world) this.ctx.send(client, this._roundPayload(room));
    return true;
  }

  _add(room, client, key) {
    const member = {
      clientId: client.id,
      name: client.name,
      color: COLORS[room.members.length % COLORS.length],
      style: STYLES[room.members.length % STYLES.length],
      ready: false,
      key: key || '',
      dropped: false,
      dropAt: 0
    };
    room.members.push(member);
    room.scores[client.id] = { wins: 0, kills: 0, deaths: 0 };
    client.room = room;
    client.tankMember = member;
    if (member.key) this.byKey.set(member.key, { code: room.code, clientId: client.id });
  }

  _member(room, clientId) {
    for (const m of room.members) if (m.clientId === clientId) return m;
    return null;
  }

  /** 房主视为永远就绪；其余玩家需要自己点「准备」 */
  _isReady(room, m) { return m.clientId === room.hostId ? true : !!m.ready; }

  _notReady(room) {
    return room.members.filter(m => !this._isReady(room, m));
  }

  /** 权威判定：这个玩家现在能不能开始游戏，顺带给出不能的原因 */
  _canStart(room, clientId) {
    if (clientId !== room.hostId) return { ok: false, reason: '等待房主开始游戏' };
    if (room.state === 'playing') return { ok: false, reason: '对局进行中' };
    if (room.state === 'intermission') return { ok: false, reason: '本局结算中…' };
    const waiting = this._notReady(room);
    if (waiting.length) {
      return { ok: false, reason: '还有 ' + waiting.length + ' 人未准备：' + waiting.map(m => m.name).join('、') };
    }
    if (room.members.length < 2 && !room.addBots) {
      return { ok: false, reason: '只有你 1 人：请打开「AI 坦克」开关，或等其他人加入' };
    }
    if (room.members.length < 2 && room.addBots) {
      return { ok: true, reason: '将补 1 辆 AI 坦克与你对战' };
    }
    return { ok: true, reason: '全员就绪，可以开始（共 ' + room.members.length + ' 人）' };
  }

  _pushRoom(room) {
    const base = {
      t: 'tank.room',
      code: room.code,
      hostId: room.hostId,
      rounds: room.rounds,
      lives: room.lives,
      addBots: room.addBots,
      powerups: room.powerups.slice(),
      allPowerups: ALL_POWERUPS,
      selfDamage: !!room.selfDamage,
      maxPlayers: MAX_PLAYERS,
      state: room.state,
      roundIndex: room.roundIndex,
      colors: COLORS,
      styles: STYLES,
      members: room.members.map(m => {
        const sc = room.scores[m.clientId] || { wins: 0, kills: 0, deaths: 0 };
        return {
          id: m.clientId, name: m.name, color: m.color, style: m.style,
          ready: this._isReady(room, m),
          isHost: m.clientId === room.hostId,
          dropped: !!m.dropped,          // 掉线中（还在宽限期里等他回来）
          wins: sc.wins,
          kills: sc.kills,
          deaths: sc.deaths
        };
      })
    };
    // canStart 是「因人而异」的，所以逐个下发
    for (const m of room.members) {
      const c = this.ctx.clients.get(m.clientId);
      if (!c) continue;
      const gate = this._canStart(room, m.clientId);
      this.ctx.send(c, Object.assign({}, base, {
        you: m.clientId,
        canStart: gate.ok,
        startHint: gate.reason
      }));
    }
  }

  _broadcast(room, msg) {
    for (const m of room.members) {
      const c = this.ctx.clients.get(m.clientId);
      if (c) this.ctx.send(c, msg);
    }
  }

  /**
   * 主动离开（用户点了「退出房间」/ 回主页）。
   * 这是**真实离开**，房间该收就立刻收：
   *   · 房主离开 → 整个房间当场解散，其余人收到通知
   *   · 最后一个人离开 → 房间删除
   *   · 对局进行中有人离开 → 本场结束（沿用原来的规则）
   * 注意：断线/刷新**不走这里**，走 _drop（有宽限期，回来还在）。
   */
  leave(client) {
    const room = client.room;
    if (!room) return;
    const m = this._member(room, client.id);
    const isHost = room.hostId === client.id;
    client.room = null;
    client.tankMember = null;

    if (isHost) {
      this._dissolve(room, client.name + '（房主）离开了，房间已解散');
      return;
    }
    if (room.state === 'playing' || room.state === 'intermission') {
      this._broadcast(room, {
        t: 'tank.abort', name: client.name,
        msg: client.name + ' 离开了对局，本场结束'
      });
      this._clearRoom(room);
      console.log('[tank] 房间', room.code, '因', client.name, '中途退出而结束');
      return;
    }
    this._removeMember(room, client.id, m);
    if (room.members.length === 0) { this._clearRoom(room); return; }
    if (room.state === 'lobby' || room.state === 'over') {
      this._pushRoom(room);
    } else {
      this._broadcast(room, { t: 'tank.playerLeft', id: client.id, name: client.name });
      this._pushRoom(room);
    }
  }

  /**
   * 连接断了（刷新网页 / 关标签页 / 断网 / 切后台）：
   * 先别踢人 —— 见 DROP_GRACE_MS 那段说明。这里只标记掉线并通知屋里其他人。
   */
  onClose(client) { this._drop(client); }

  _drop(client) {
    const room = client.room;
    if (!room) return;
    const m = this._member(room, client.id);
    client.room = null;
    client.tankMember = null;
    if (!m) return;
    m.dropped = true;
    m.dropAt = Date.now();
    // 别让他掉线前那一帧的输入继续开车（否则坦克会一直往前冲）
    if (room.inputs[client.id]) {
      room.inputs[client.id] = { up: false, down: false, left: false, right: false, fire: false };
    }
    this._broadcast(room, {
      t: 'tank.dropped',
      name: m.name,
      grace: Math.round(DROP_GRACE_MS / 1000),
      msg: m.name + ' 掉线了，' + Math.round(DROP_GRACE_MS / 1000) + ' 秒内回来座位还在'
    });
    this._pushRoom(room);
  }

  /** 宽限期到了还没回来 → 当作真的离开处理 */
  _sweepDropped() {
    const now = Date.now();
    for (const room of Array.from(this.rooms.values())) {
      const gone = room.members.filter(m => m.dropped && now - (m.dropAt || 0) >= DROP_GRACE_MS);
      if (!gone.length) continue;
      let dissolved = false;
      for (const m of gone) {
        if (room.hostId === m.clientId) { this._dissolve(room, '房主掉线太久，房间已解散'); dissolved = true; break; }
        this._removeMember(room, m.clientId, m);
        this._broadcast(room, { t: 'tank.playerLeft', id: m.clientId, name: m.name });
      }
      if (dissolved || !this.rooms.has(room.code)) continue;
      if (room.members.length === 0) { this._clearRoom(room); continue; }
      if (room.state === 'playing' || room.state === 'intermission') {
        this._broadcast(room, { t: 'tank.abort', msg: '有玩家掉线太久，本场结束' });
        this._clearRoom(room);
        continue;
      }
      this._pushRoom(room);
    }
  }

  _removeMember(room, clientId, m) {
    room.members = room.members.filter(x => x.clientId !== clientId);
    delete room.inputs[clientId];
    delete room.tankOf[clientId];
    delete room.scores[clientId];
    if (m && m.key) {
      const hit = this.byKey.get(m.key);
      if (hit && hit.code === room.code && hit.clientId === clientId) this.byKey.delete(m.key);
    }
  }

  /** 房间当场回收：通知还在屋里的人，然后删掉（房主离开 / 宽限期耗尽都走这里） */
  _dissolve(room, text) {
    if (!this.rooms.has(room.code)) return;
    this._broadcast(room, { t: 'tank.abort', msg: text || '房间已解散' });
    this._clearRoom(room);
    console.log('[tank] 房间', room.code, '已回收：' + (text || ''));
  }

  _clearRoom(room) {
    for (const m of room.members) {
      const c = this.ctx.clients.get(m.clientId);
      if (c) { c.room = null; c.tankMember = null; }
      if (m.key) {
        const hit = this.byKey.get(m.key);
        if (hit && hit.code === room.code) this.byKey.delete(m.key);
      }
    }
    this.rooms.delete(room.code);
  }

  /** 「回到我的房间」：客户端刷新后带着钥匙问一句，服务端把座位还给他 */
  resume(client, msg) {
    const key = this._key(msg);
    const hit = key ? this.byKey.get(key) : null;
    if (!hit || !this.rooms.get(hit.code) || !this._reattach(client, key, hit.code)) {
      if (key) this.byKey.delete(key);
      this.ctx.send(client, { t: 'tank.resumeFailed' });
      return;
    }
    this.ctx.send(client, { t: 'tank.joined', code: hit.code, resumed: true });
  }

  /**
   * 这个人现在是不是「在组队里」（大厅等待中或对局中都算）。
   * 好友列表据此显示「组队中」并禁掉邀请按钮 —— 正在跟别人玩的人，不该被拉走。
   * 单人模式压根没有房间，自然返回 null，正好符合"单人游戏不算组队"。
   */
  busy(client) {
    const room = client && client.room;
    if (!room) return null;
    return { label: '房间 ' + room.code, code: room.code };
  }

  /* ---------- 大厅配置 ---------- */
  config(client, msg) {
    const room = client.room;
    if (!room || room.state !== 'lobby') return;
    const m = this._member(room, client.id);
    if (!m) return;
    if (typeof msg.color === 'string' && COLORS.indexOf(msg.color) >= 0) m.color = msg.color;
    if (typeof msg.style === 'string' && STYLES.indexOf(msg.style) >= 0) m.style = msg.style;
    this._pushRoom(room);
  }

  setRounds(client, msg) {
    const room = client.room;
    if (!room || room.state === 'playing' || room.state === 'intermission') return;
    if (room.hostId !== client.id) {
      this.ctx.send(client, { t: 'tank.error', msg: '只有房主可以设置对局局数' });
      return;
    }
    let n = parseInt(msg.rounds, 10);
    if (!isFinite(n)) n = DEFAULT_ROUNDS;
    n = Math.max(1, Math.min(MAX_ROUNDS, n));
    room.rounds = n;
    this._pushRoom(room);
  }

  /** 每局每个坦克几条命（1~5，默认 1） */
  setLives(client, msg) {
    const room = client.room;
    if (!room || room.state === 'playing' || room.state === 'intermission') return;
    if (room.hostId !== client.id) {
      this.ctx.send(client, { t: 'tank.error', msg: '只有房主可以设置每局生命数' });
      return;
    }
    let n = parseInt(msg.lives, 10);
    if (!isFinite(n)) n = DEFAULT_LIVES;
    n = Math.max(1, Math.min(MAX_LIVES, n));
    room.lives = n;
    this._pushRoom(room);
  }

  /** 房主勾选「场上会掉落哪些道具」（至少留一种，否则没有道具可玩） */
  setPowerups(client, msg) {
    const room = client.room;
    if (!room) return;
    if (room.hostId !== client.id) {
      this.ctx.send(client, { t: 'tank.error', msg: '只有房主可以设置掉落道具' });
      return;
    }
    if (room.state === 'playing' || room.state === 'intermission') return;
    const raw = Array.isArray(msg && msg.list) ? msg.list : null;
    if (!raw) return;
    const picked = [];
    for (const t of ALL_POWERUPS) if (raw.indexOf(t) >= 0 && picked.indexOf(t) < 0) picked.push(t);
    if (!picked.length) {
      this.ctx.send(client, { t: 'tank.error', msg: '至少要保留一种道具' });
      return;
    }
    room.powerups = picked;
    this._pushRoom(room);
  }

  /** 房主切换「子弹会伤到自己」（默认关闭 = 自己的子弹打不到自己） */
  setSelfDamage(client, msg) {
    const room = client.room;
    if (!room) return;
    if (room.hostId !== client.id) {
      this.ctx.send(client, { t: 'tank.error', msg: '只有房主可以修改自伤设置' });
      return;
    }
    if (room.state === 'playing' || room.state === 'intermission') return;
    room.selfDamage = !!(msg && msg.enabled);
    if (room.world) room.world.selfDamage = room.selfDamage;
    this._pushRoom(room);
  }

  /** 玩家改了昵称（客户端重新发 hello）→ 房间列表 / 对局里的名字一起更新 */
  onRename(client) {
    const room = client.room;
    if (!room) return;
    const m = this._member(room, client.id);
    if (!m || m.name === client.name) return;
    m.name = client.name;
    if (room.world) {
      const t = this._tankOfClient(room, client.id);
      if (t) t.name = client.name;
    }
    this._pushRoom(room);
  }

  /** 玩家点「准备 / 取消准备」（房主无需准备） */
  setReady(client, msg) {
    const room = client.room;
    if (!room) return;
    const m = this._member(room, client.id);
    if (!m) return;
    if (m.clientId === room.hostId) return;            // 房主视为已就绪
    if (room.state !== 'lobby') return;
    m.ready = !!(msg && msg.ready);
    this._pushRoom(room);
  }

  /**
   * 房主把房主身份转让给房间里另一位成员。
   * 大厅 / 对局中都允许（房主权限主要在大厅生效，对局中转让不影响本局）。
   * 旧房主转为普通成员时把 ready 置为 true —— 他当房主时本来就视为就绪，
   * 别转完反而因为他"未准备"卡住开局；新房主无所谓（_isReady 对房主恒 true）。
   */
  giveHost(client, msg) {
    const room = client.room;
    if (!room) return;
    if (client.id !== room.hostId) {
      this.ctx.send(client, { t: 'tank.error', msg: '只有房主可以转让房主' });
      return;
    }
    const targetId = msg && msg.target;
    if (targetId === client.id) {
      this.ctx.send(client, { t: 'tank.error', msg: '不能把房主转让给自己' });
      return;
    }
    const target = this._member(room, targetId);
    if (!target) {
      this.ctx.send(client, { t: 'tank.error', msg: '对方已不在房间里' });
      return;
    }
    const old = this._member(room, client.id);
    if (old) old.ready = true;
    room.hostId = target.clientId;
    this._pushRoom(room);
    this._broadcast(room, { t: 'tank.host', name: target.name });
    console.log('[tank] 房间', room.code, '房主转让给', target.name);
  }

  /** 房主切换「补充 AI 坦克」开关 */
  setBots(client, msg) {
    const room = client.room;
    if (!room) return;
    if (room.hostId !== client.id) {
      this.ctx.send(client, { t: 'tank.error', msg: '只有房主可以修改 AI 设置' });
      return;
    }
    if (room.state === 'playing' || room.state === 'intermission') return;
    room.addBots = !!(msg && msg.enabled);
    this._pushRoom(room);
  }

  /** 原班人马再来一届：清空战绩并从第 1 局重新开始 */
  rematch(client) {
    const room = client.room;
    if (!room || room.state !== 'over') return;
    if (room.hostId !== client.id) {
      this.ctx.send(client, { t: 'tank.error', msg: '只有房主可以发起再来一局' });
      return;
    }
    for (const m of room.members) room.scores[m.clientId] = { wins: 0, kills: 0, deaths: 0 };
    room.results = [];
    room.roundIndex = 0;
    this._startRound(room);
  }

  /* ---------- 开局 ---------- */
  start(client) {
    const room = client.room;
    if (!room) return;
    if (room.state === 'playing' || room.state === 'intermission') return;
    const gate = this._canStart(room, client.id);
    if (!gate.ok) {
      this.ctx.send(client, { t: 'tank.error', msg: gate.reason });
      return;
    }
    // 在大厅里重新开一届：清空上一届的战绩
    if (room.state === 'over') {
      for (const m of room.members) room.scores[m.clientId] = { wins: 0, kills: 0, deaths: 0 };
      room.results = [];
      room.roundIndex = 0;
    }
    this._startRound(room);
  }

  _startRound(room) {
    room.roundIndex += 1;
    const slots = Math.max(2, room.members.length);
    const seed = (Math.random() * 0x7fffffff) | 0;
    // online:true —— 只有联机对局才会掉落隐身道具（单机/本地双人对战不掉）
    const world = TankCore.createWorld({
      cols: 25, rows: 19, seed, tankSlots: slots, freeze: FREEZE,
      online: true, powerups: room.powerups, selfDamage: room.selfDamage
    });

    room.world = world;
    room.tankOf = {};
    room.roundTime = 0;
    room.snapshotAcc = 0;
    room.endTimer = 0;
    room.endReason = false;
    room.state = 'playing';
    room.lastRoundStart = Date.now();
    // 开赛后清空准备状态，下一轮回到大厅需要重新准备
    for (const m of room.members) m.ready = false;

    const players = [];
    room.members.forEach((m, i) => {
      const t = TankCore.addTank(world, {
        id: 1000 + m.clientId,
        slot: i,
        name: m.name,
        color: m.color,
        style: m.style,
        lives: room.lives
      });
      room.tankOf[m.clientId] = t.id;
      players.push({ id: m.clientId, name: m.name, color: m.color, style: m.style, slot: i, bot: false });
      room.inputs[m.clientId] = { up: false, down: false, left: false, right: false, fire: false };
    });

    // 人数不足时按房主设置决定是否补 AI（默认开：补到 2 人，保证能开局）
    const bots = room.addBots ? Math.max(0, 2 - room.members.length) : 0;
    for (let b = 0; b < bots; b++) {
      const slot = room.members.length + b;
      const t = TankCore.addTank(world, {
        id: 9000 + b, slot: slot, name: 'AI-' + (b + 1) + '号',
        color: COLORS[(slot + 4) % COLORS.length],
        style: STYLES[slot % STYLES.length],
        lives: room.lives, bot: TankCore.makeBot(1)
      });
      players.push({ id: 9000 + b, name: t.name, color: t.color, style: t.style, slot, bot: true });
    }

    this._broadcast(room, this._roundPayload(room));
    this._pushRoom(room);
  }

  /**
   * 一局的场景下发内容。
   * 开局时广播给所有人；刷新/断线重连回来时也用它**单独补发一份**，
   * 客户端就能直接重新进画面继续打（不用等下一局）。
   */
  _roundPayload(room) {
    const world = room.world;
    const players = [];
    for (const t of world.tanks) {
      const m = room.members.filter(x => 1000 + x.clientId === t.id)[0];
      players.push({
        id: m ? m.clientId : t.id,
        name: t.name, color: t.color, style: t.style,
        slot: t.slot, bot: !!t.bot
      });
    }
    return {
      t: 'tank.round',
      index: room.roundIndex,
      total: room.rounds,
      seed: world.seed,
      cols: world.cols,
      rows: world.rows,
      tiles: Buffer.from(world.tiles).toString('base64'),
      spawns: world.spawnTiles,
      freeze: FREEZE,
      lives: room.lives,
      players
    };
  }

  _tankOfClient(room, clientId) {
    const id = room.tankOf[clientId];
    if (id == null || !room.world) return null;
    return TankCore.findTank(room.world, id);
  }

  /* ---------- 输入 ---------- */
  input(client, msg) {
    const room = client.room;
    if (!room || room.state !== 'playing') return;
    /*
     * msg.a = 客户端此刻渲染的炮管角度。服务端开火方向以它为准 ——
     * 否则服务端自己积出来的角度总比玩家看到的慢一拍（输入要走一个网络来回），
     * 子弹飞出去的方向和炮管对不上，就是玩家说的「弹道偏离」。
     * 局域网内信任客户端的角度；只挡 NaN / 无穷这种坏值。
     */
    const aim = Number(msg.a);
    room.inputs[client.id] = {
      up: !!msg.up, down: !!msg.down, left: !!msg.left, right: !!msg.right, fire: !!msg.fire,
      aim: (isFinite(aim) && Math.abs(aim) < 100) ? aim : null
    };
  }

  /**
   * 仅用于自动化测试：把坦克挪到指定坐标。
   * 必须显式设置环境变量 WB_TEST_HOOKS=1 才生效，正常开服时这个入口是死的。
   * （草丛隐身这类规则没法靠"操作输入"稳定复现，需要一个可靠的摆位手段。）
   */
  teleport(client, msg) {
    if (!process.env.WB_TEST_HOOKS) return;
    const room = client.room;
    if (!room || !room.world) return;
    const t = this._tankOfClient(room, client.id);
    if (!t) return;
    t.x = Number(msg.x) || t.x;
    t.y = Number(msg.y) || t.y;
    if (isFinite(msg.angle)) t.angle = Number(msg.angle);
  }

  /* ---------- 模拟 ---------- */
  step(dt) {
    this.rooms.forEach((room) => {
      if (room.state === 'playing' && room.world) {
        // 同步输入
        for (const m of room.members) {
          const t = this._tankOfClient(room, m.clientId);
          if (t) {
            const inp = room.inputs[m.clientId];
            if (inp) {
              t.input.up = inp.up; t.input.down = inp.down; t.input.left = inp.left; t.input.right = inp.right; t.input.fire = inp.fire;
              // 采用客户端渲染的炮管角度（见 input()）：开火方向与玩家看到的一致，
              // 坦克朝向也跟着对齐 —— 客户端预测本来就是按这个角度在走
              if (inp.aim !== null && inp.aim !== undefined) t.angle = inp.aim;
            }
          }
        }
        const before = room.world.time;
        TankCore.stepWorld(room.world, dt);
        if (room.world.time > before) room.roundTime += dt;

        if (room.endTimer > 0) {
          // 已经决出胜负了，但先等 END_DELAY 秒再结算：
          // 让最后一击的爆炸/碎片动画播完，同时给"同归于尽"留出机会
          // （这 2 秒里如果剩下的人也一起没了，最后判定就是平局）
          room.endTimer -= dt;
          if (room.endTimer <= 0) { room.endTimer = 0; this._endRound(room, room.endReason); }
          return;
        }
        this._checkRoundEnd(room);
      } else if (room.state === 'intermission') {
        room.interTimer -= dt;
        if (room.interTimer <= 0) {
          if (room.roundIndex >= room.rounds) this._finishMatch(room);
          else this._startRound(room);
        }
      }
    });
  }

  /* ---------- 广播快照 ---------- */
  broadcast(dt) {
    this.rooms.forEach((room) => {
      if (room.state !== 'playing' || !room.world) {
        // 非对局状态也周期推送，保证客户端时钟同步
        return;
      }
      room.snapshotAcc += dt;
      const interval = 1 / SNAPSHOT_HZ;
      if (room.snapshotAcc < interval) return;
      room.snapshotAcc = 0;

      const s = TankCore.serialize(room.world);
      const ev = TankCore.flushEvents(room.world);
      // 被摧毁的墙格必须发给客户端，否则客户端会一直画着已经不存在的墙（子弹和坦克能穿过"假墙"）
      // 注意：这里不能叫 dt —— 会和外层函数参数同名，导致上面的 snapshotAcc += dt 触发 TDZ 报错
      const tiles = TankCore.flushTiles(room.world);
      const payload = {
        t: 'tank.state',
        st: Date.now(),
        round: room.roundIndex,
        freeze: Math.max(0, Math.round(room.world.freeze * 10) / 10),
        time: Math.round(room.roundTime * 10) / 10,
        limit: ROUND_LIMIT,
        tks: s.t, bl: s.b, pu: s.p,
        d: tiles.length ? tiles : undefined,
        ev: ev.length ? ev : undefined
      };

      // 只有「隐身道具」会把坦克从别人的快照里摘掉。
      // 草丛是**正常的视觉遮挡**：坦克照常下发，客户端把草丛画在坦克上面盖住它，
      // 只是躲进草丛时不画头顶名字（名字浮在草上方会把位置暴露）。
      const hidden = [];
      for (const wt of room.world.tanks) {
        if (wt.alive && wt.power && wt.power.stealth > 0) hidden.push(wt.id);
      }
      if (!hidden.length) { this._broadcast(room, payload); return; }
      for (const m of room.members) {
        const c = this.ctx.clients.get(m.clientId);
        if (!c) continue;
        const myId = room.tankOf[m.clientId];
        const list = s.t.filter(tk => hidden.indexOf(tk[0]) < 0 || tk[0] === myId);
        this.ctx.send(c, Object.assign({}, payload, { tks: list }));
      }
    });
  }

  /* ---------- 局结束判定 ---------- */
  _checkRoundEnd(room) {
    const world = room.world;
    if (world.freeze > 0) return;
    const cont = TankCore.contenders(world);
    const timeout = room.roundTime >= ROUND_LIMIT;
    if (cont.length > 1 && !timeout) return;
    // 不立刻结算：先挂起 END_DELAY 秒（见 step() 里的说明）
    room.endTimer = END_DELAY;
    room.endReason = timeout;
  }

  _endRound(room, timeout) {
    const world = room.world;
    world.state = 'over';
    room.state = 'intermission';
    room.interTimer = INTERMISSION;

    const all = world.tanks.map(t => ({
      id: t.id, name: t.name, color: t.color, style: t.style, bot: !!t.bot,
      kills: t.kills, deaths: t.deaths, lives: t.lives, alive: t.alive
    }));

    // 排名：存活优先 → 击杀多 → 死亡少
    const ranked = all.slice().sort((a, b) => {
      const sa = (a.alive || a.lives > 0) ? 1 : 0, sb = (b.alive || b.lives > 0) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      if (a.lives !== b.lives) return b.lives - a.lives;
      if (a.kills !== b.kills) return b.kills - a.kills;
      return a.deaths - b.deaths;
    });

    // 第一名判定：并列则本局流局（不加胜场）
    let winner = null;
    if (ranked.length) {
      const a = ranked[0], b = ranked[1];
      const key = (x) => [(x.alive || x.lives > 0) ? 1 : 0, x.lives, x.kills, -x.deaths].join(',');
      if (!b || key(a) !== key(b)) winner = a;
    }

    // 累计总分
    for (const t of all) {
      const clientId = t.id >= 9000 ? null : t.id - 1000;
      if (clientId == null) continue;
      const s = room.scores[clientId];
      if (!s) continue;
      s.kills += t.kills;
      s.deaths += t.deaths;
      if (winner && winner.id === t.id) s.wins += 1;
    }

    const result = {
      index: room.roundIndex,
      timeout: !!timeout,
      winner: winner ? { id: winner.id, name: winner.name, bot: winner.bot } : null,
      ranked: ranked.map(r => ({ id: r.id, name: r.name, color: r.color, kills: r.kills, deaths: r.deaths, lives: r.lives }))
    };
    room.results.push(result);

    this._broadcast(room, { t: 'tank.roundEnd', result, scores: this._scores(room), next: room.roundIndex < room.rounds, intermission: INTERMISSION });
    this._pushRoom(room);
    console.log('[tank] 房间', room.code, '第', room.roundIndex, '/', room.rounds, '局结束，胜者:', winner ? winner.name : '流局');
  }

  _scores(room) {
    return room.members.map(m => ({
      id: m.clientId, name: m.name, color: m.color,
      wins: room.scores[m.clientId].wins,
      kills: room.scores[m.clientId].kills,
      deaths: room.scores[m.clientId].deaths
    })).sort((a, b) => (b.wins - a.wins) || (b.kills - a.kills) || (a.deaths - b.deaths));
  }

  _finishMatch(room) {
    room.state = 'over';
    room.world = null;
    const standings = this._scores(room);
    this._broadcast(room, {
      t: 'tank.matchEnd',
      rounds: room.rounds,
      standings,
      results: room.results
    });
    this._pushRoom(room);
    console.log('[tank] 房间', room.code, '全部', room.rounds, '局结束');
  }
}

/**
 * 这个游戏**自己声明**自己的消息路由：消息类型 → Hub 上的方法名。
 * 主机（platform/server/server.cjs）只负责装配，不需要知道 "tank.create" 这类细节，
 * 这样新增/改名游戏消息时只改这个文件，不会牵动主机。
 */
TankHub.title = '坦克大战';       // 游戏自己声明的显示名（主机/主页用它，不写死）
TankHub.entry = '/tank/';         // 访问入口
TankHub.order = 10;               // 主页卡片顺序（数字小的排前面），平台不写死任何游戏名

/**
 * 主页卡片上的内容也由游戏自己提供 —— 平台只负责渲染，不认识"坦克"这个词。
 * 只声明 Hub.title / Hub.entry 也能跑，卡片会用标题首字当占位图。
 */
TankHub.card = {
  desc: '坦克可以 360° 旋转，炮弹沿车头方向飞出。子弹撞墙会反弹、飞一会儿会消失、还会打中自己。地图是随机生成的迷宫，岔路很多。',
  tags: [
    '↑前进 ↓后退 ←左转 →右转',
    '子弹上限 5 发',
    '子弹反弹 · 会打中自己',
    '单人 / 本地双人 / 在线联机',
    '4 位房间号 · 准备制开局',
    '房主可设局数（最多 999）'
  ],
  art: 'card.svg'                 // 相对自己的入口，等于 /tank/card.svg
};

TankHub.routes = {
  'tank.create': 'create',
  'tank.join': 'join',
  'tank.resume': 'resume',       // 刷新/重连后"回到我的房间"
  'tank.leave': 'leave',
  'tank.config': 'config',
  'tank.ready': 'setReady',
  'tank.giveHost': 'giveHost',   // 房主把房主身份转给房间里另一位成员
  'tank.bots': 'setBots',
  'tank.rounds': 'setRounds',
  'tank.lives': 'setLives',
  'tank.selfDamage': 'setSelfDamage',
  'tank.powerups': 'setPowerups',
  'tank.start': 'start',
  'tank.input': 'input',
  'tank.teleport': 'teleport',   // 仅测试：WB_TEST_HOOKS=1 时才生效
  'tank.rematch': 'rematch'
};

module.exports = TankHub;
