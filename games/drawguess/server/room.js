'use strict';
/**
 * 你画我猜 —— 联机房间（服务端权威）
 *
 * 设计要点：
 *   · 答案、计时、提示、计分、换题、冷却、准备门槛全部由服务端判定，客户端只负责画和显示；
 *   · 每回合服务端只把答案发给画者本人，其余人只拿到"几个字"；
 *   · 提示只能在回合过去 30% 之后给，且「只有自己的画被猜中时才扣分」；
 *   · 轮换模式默认开启：开局后大家抢画者，抢到的洗牌排前面、没抢的排最后，
 *     顺序按人轮一圈才算完成一「局」；
 *   · 不轮换模式：每人先选"愿不愿意当画者"，都选完才能准备，都准备好房主才能开局；
 *   · 画板操作是一串 op（笔迹/形状/填充/图层…），服务端存全量 op，
 *     撤销/重做也在服务端做（把 op 数减一/加一），这样所有客户端重放结果一致。
 */

const WORDS = require('../shared/words.js');
const CATEGORIES = WORDS.CATEGORIES;

/* ---------------- 规则常量（想改手感就改这里） ---------------- */
const MAX_PLAYERS = 10;            // 含房主
const MIN_MINUTES = 1;             // 单回合作画时间下限
const MAX_MINUTES = 30;            // 上限
const DEFAULT_MINUTES = 5;
const MAX_ROUNDS = 100;            // 两种模式的局数上限
const DEFAULT_ROUNDS_FIXED = 10;   // 不轮换：默认 10 局
const DEFAULT_ROUNDS_ROTATE = 5;   // 轮换：默认 5 局（轮完一圈算一局）
const DEFAULT_ROTATE = true;       // 画者轮换默认开启
const HINT_UNLOCK_RATIO = 0.3;     // 回合过去 30% 才能给提示
const SWAP_LIMIT = 2;              // 画家在自己回合内最多换两次题
const GUESS_CD_MS = 10000;         // 猜错一次的冷却
const GRAB_MS = 15000;             // 抢画者窗口；全员选完会立刻提前开始
const TURN_GAP_MS = 10000;
const ROLE_SHOW_MS = 3000;
// ★ 掉线宽限期：断线（含刷新网页）先保留座位和分数，等人回来。
//   以前一断线就移除，2 人房会立刻「人数不足」回大厅 —— 刷新一下游戏就没了。
const DROP_GRACE_MS = 30000;          // 开局先弹 3 秒「谁画谁猜」再进对局         // 回合之间的间隔（和客户端弹窗 10 秒自动关对应）
const SETTLE_MS = 30000;           // 终局结算：30 秒不做选择就当作退出房间
const MAX_OPS = 6000;              // 单回合最多存这么多操作（客户端 OP_LIMIT 必须一致）
const MAX_LAYERS = 4;

/* 笔刷白名单（要和 paintpad.js 的 BRUSHES 对齐） */
const BRUSH_IDS = [
  'pencil', 'pen', 'marker', 'crayon', 'chalk', 'charcoal',
  'ink', 'spray', 'water', 'neon', 'hl', 'dots'
];
/* 三种模式：画笔 / 橡皮 / 涂抹 —— 都用当前笔刷 */
const MODES_OK = ['pen', 'erase', 'smudge'];

const HINTS = {
  type: { label: '类型', cost: 3 },
  len: { label: '几个字', cost: 5 },
  origin: { label: '来自哪里', cost: 8 }
};

function guessScore(ratio) { return 10 + Math.round(20 * Math.max(0, Math.min(1, ratio))); }
function painterScore(ratio) { return 15 + Math.round(15 * Math.max(0, Math.min(1, ratio))); }

const COLORS = ['#e5533d', '#2f7de1', '#28a06a', '#a462e8', '#e0a52c', '#d94f8a', '#12a3b8', '#7a6bd8', '#6f9b1f', '#c8552b'];

function newCode(rooms) {
  for (let i = 0; i < 5000; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(Date.now()).slice(-4);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
}

/* ---------------- 画板操作的白名单清洗 ---------------- */
function clampN(v, a, b, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return n < a ? a : (n > b ? b : n);
}
function u01(v) { return clampN(v, 0, 1, 0); }
function layerOf(v) { return Math.round(clampN(v, 0, MAX_LAYERS - 1, 0)); }
function colorOf(v) {
  const s = String(v == null ? '' : v);
  return /^#[0-9a-fA-F]{3,6}$/.test(s) ? s.slice(0, 7) : '#2b2620';
}
function brushOf(v) {
  const s = String(v == null ? '' : v);
  return BRUSH_IDS.indexOf(s) >= 0 ? s : 'pencil';
}
/* 模式：画笔 / 橡皮 / 涂抹（老客户端用 b 传，兼容一下） */
function modeOf(v, legacy) {
  const s = String(v == null ? '' : v);
  if (MODES_OK.indexOf(s) >= 0) return s;
  if (legacy === 'eraser') return 'erase';
  if (legacy === 'smudge') return 'smudge';
  return 'pen';
}
function shapeOf(v) {
  const s = String(v == null ? '' : v);
  return ['line', 'rect', 'ellipse', 'arrow'].indexOf(s) >= 0 ? s : 'line';
}
function sidOf(v) { return String(v == null ? '' : v).slice(0, 24); }

function sanitizeOp(msg) {
  const k = String((msg && msg.k) || '');
  switch (k) {
    case 'seg':
      return {
        k: 'seg', S: sidOf(msg.S), L: layerOf(msg.L),
        x: u01(msg.x), y: u01(msg.y), px: u01(msg.px), py: u01(msg.py),
        c: colorOf(msg.c), w: clampN(msg.w, 0.0008, 0.09, 0.012),
        a: clampN(msg.a, 0.03, 1, 1),
        m: modeOf(msg.m, msg.b), z: brushOf(msg.z || msg.b)
      };
    case 'sege':
      return { k: 'sege', S: sidOf(msg.S) };
    case 'shape':
      return {
        k: 'shape', L: layerOf(msg.L), s: shapeOf(msg.s),
        x0: u01(msg.x0), y0: u01(msg.y0), x1: u01(msg.x1), y1: u01(msg.y1),
        c: colorOf(msg.c), w: clampN(msg.w, 0.0008, 0.09, 0.012),
        a: clampN(msg.a, 0.03, 1, 1), f: msg.f ? 1 : 0,
        m: 'pen', z: brushOf(msg.z || msg.b)
      };
    case 'fill':
      return {
        k: 'fill', L: layerOf(msg.L), x: u01(msg.x), y: u01(msg.y),
        c: colorOf(msg.c), a: clampN(msg.a, 0.03, 1, 1),
        tol: Math.round(clampN(msg.tol, 0, 255, 45)),
        // 边缘扩张也要带上：不带的话画者调过、猜的人还是默认值，
        // 两边填出来的边缘就不一样
        e: Math.round(clampN(msg.e, 0, 6, 1))
      };
    case 'clr': return { k: 'clr', L: layerOf(msg.L) };
    case 'ladd': return { k: 'ladd' };
    case 'ldel': return { k: 'ldel', L: layerOf(msg.L) };
    case 'lvis': return { k: 'lvis', L: layerOf(msg.L), v: msg.v ? 1 : 0 };
    case 'lopa': return { k: 'lopa', L: layerOf(msg.L), v: clampN(msg.v, 0, 1, 1) };
    default: return null;
  }
}

class DrawGuessHub {
  constructor(ctx) {
    this.ctx = ctx;
    this.rooms = new Map();
  }

  stats() {
    let playing = 0;
    this.rooms.forEach((r) => { if (r.state === 'playing') playing++; });
    return { ydwgRooms: this.rooms.size, ydwgPlaying: playing };
  }

  /* ================= 房间 ================= */
  create(client, msg) {
    this.leave(client);
    const code = newCode(this.rooms);
    const room = {
      code: code,
      hostId: client.id,
      hostKey: (msg && msg.key) || (client.ip + '|' + client.name),   // 房主身份钥匙：重连后靠它把房主还回去
      members: [],
      settings: {
        categories: CATEGORIES.map((c) => c.name),
        minutes: DEFAULT_MINUTES,
        rotate: DEFAULT_ROTATE,
        rounds: DEFAULT_ROTATE ? DEFAULT_ROUNDS_ROTATE : DEFAULT_ROUNDS_FIXED
      },
      state: 'lobby',       // lobby | grabbing | playing | turnEnd | over
      turns: 0,
      cycle: 0,
      order: [],
      orderPos: 0,
      turn: null,
      scores: {},
      recent: [],
      turnLog: [],          // 每回合战报：谁画了什么、谁猜对了、用了多久
      nextAt: 0,
      painterId: null,
      painterPool: []
    };
    this.rooms.set(code, room);
    this._add(room, client, (msg && msg.key) || (client.ip + '|' + client.name));
    this.ctx.send(client, { t: 'ydwg.created', code: code });
    this._push(room);
    console.log('[ydwg] 房间', code, '由', client.name, '创建');
  }

  join(client, msg) {
    const code = String((msg && msg.code) || '').trim();
    const room = this.rooms.get(code);
    if (!room) { this._err(client, '房间号不存在，请检查后重试'); return; }
    const active0 = this._active(room);
    if (active0.length >= MAX_PLAYERS) { this._err(client, '房间已满（最多 ' + MAX_PLAYERS + ' 人）'); return; }
    // ★ 刷新 / 掉线后要能回到对局：以前这里一律拒绝（state==='playing'），
    //   结果玩家刷新一下就被踢出房间。现在只要这个身份之前在房间里，就让他回来，
    //   分数、身份、画者顺序全部保留。
    const backKey = (msg && msg.key) || (client.ip + '|' + client.name);
    const back = room.members.find((m) => m.key && m.key === backKey);
    if (!back && (room.state === 'playing' || room.state === 'roles' ||
                  room.state === 'grabbing' || room.state === 'turnEnd')) {
      this._err(client, '正在进行中，等这一局打完再加入吧');
      return;
    }
    if (back) {
      this.leave(client);                      // 清掉可能残留的同一条连接
      const oldId = back.clientId;
      back.clientId = client.id;               // 换成本次的连接 id
      back.left = false; back.leftReason = null; back.leftAt = 0;
      back.dropped = false; back.dropAt = 0;   // 掉线宽限期里回来了
      back.guessCdUntil = 0;
      if (room.scores[oldId] != null && oldId !== client.id) {
        room.scores[client.id] = room.scores[oldId];
        delete room.scores[oldId];
      }
      if (room.scores[client.id] == null) room.scores[client.id] = 0;
      if (room.hostId === oldId) room.hostId = client.id;
      if (room.painterId === oldId) room.painterId = client.id;
      if (room.order && room.order.length) {
        room.order = room.order.map((id) => (id === oldId ? client.id : id));
      }
      if (room.painterPool && room.painterPool.length) {
        room.painterPool = room.painterPool.map((id) => (id === oldId ? client.id : id));
      }
      if (room.turn && room.turn.painterId === oldId) {
        room.turn.painterId = client.id;
        room.turn.painterName = back.name;
      }
      if (!this._active(room).length) return;
      this.ctx.send(client, { t: 'ydwg.joined', code: code, back: true });
      this._push(room);
      // 把当前画布上已有的笔迹补发给他，否则他看到的是一张空画板
      this._sendCanvasSnapshot(room, client);
      return;
    }
    // 房主掉线 / 页面被 Chrome 回收后又回来：房间记着房主的身份钥匙
    // （浏览器持久 key，重连也不会变），回来的还是这个人、而现在的房主已经不是他，
    // 就把房主身份还给他。否则房主会因为「换了连接 id」而再也看不到「开始游戏」按钮。
    const joinerKey = (msg && msg.key) || (client.ip + '|' + client.name);
    this.leave(client);
    // 之前退出过的人回来：把那笔留档复活，而不是又冒出一个同名的新成员
    const old = room.members.filter((m) => m.left && (m.key === joinerKey || m.name === client.name))[0];
    if (old) {
      old.left = false;
      old.leftReason = null;
      old.clientId = client.id;
      old.name = client.name;
      old.ready = false;
      old.grabChoice = null;
      old.roleChosen = false;
      old.guessCdUntil = 0;
      if (!old.key) old.key = joinerKey;
    } else {
      this._add(room, client, joinerKey);
    }
    if (room.hostKey && joinerKey === room.hostKey && room.hostId !== client.id) {
      const curHostMember = this._memberOf(room, room.hostId);
      const curHostKey = curHostMember ? curHostMember.key : null;
      if (curHostKey !== joinerKey) {   // 现在的房主不是原房主（含已掉线），才归还
        room.hostId = client.id;
        this._broadcast(room, { t: 'ydwg.host', name: client.name });
      }
    }
    this.ctx.send(client, { t: 'ydwg.joined', code: code });
    this._push(room);
  }

  _add(room, client, key) {
    // 已退出的成员是留档用的，别让它无限堆积：位置不够时先清掉最早的留档
    while (room.members.length >= MAX_PLAYERS) {
      const i = room.members.findIndex((m) => m.left);
      if (i < 0) break;
      room.members.splice(i, 1);
    }
    const index = room.members.length;
    const usedColors = this._active(room).map((m) => m.color);
    let color = COLORS[index % COLORS.length];
    for (let i = 0; i < COLORS.length; i++) {
      const c = COLORS[(index + i) % COLORS.length];
      if (usedColors.indexOf(c) < 0) { color = c; break; }
    }
    const member = {
      clientId: client.id,
      name: client.name,
      key: key || (client.ip + '|' + client.name),   // 身份钥匙，重连后靠它认人
      color: color,
      ready: false,
      roleChosen: false,    // 是否已经选过"愿不愿意当画者"
      willDraw: true,       // 选择的结果：愿不愿意当画者
      grabChoice: null,     // 轮换模式抢画者：null 未选 / true 抢 / false 不抢
      guessedRight: 0,      // 猜对次数（结算展示用）
      guessCdUntil: 0,
      settleUntil: 0        // 终局结算里"不做选择"的截止时间
    };
    room.members.push(member);
    room.scores[client.id] = 0;
    this.ctx.send(client, { t: 'ydwg.you', index: index, color: member.color });
  }

  ready(client, msg) {
    const room = this._roomOf(client);
    if (!room) return;
    if (room.state !== 'lobby') { this._err(client, '对局已经开始了'); return; }
    const m = this._memberOf(room, client.id);
    if (!m) return;
    const want = !!(msg && msg.ready);
    // 只有「不轮换」模式才要求先选身份；轮换模式是开局后抢画者，不选身份
    if (want && !room.settings.rotate && !m.roleChosen) {
      this._err(client, '先选好自己的身份（愿不愿意当画者），再准备');
      return;
    }
    m.ready = want;
    this._push(room);
  }

  /** 房主改设置 */
  settings(client, msg) {
    const room = this._roomOf(client);
    if (!room) return;
    if (room.hostId !== client.id) { this._err(client, '只有房主能改设置'); return; }
    if (room.state !== 'lobby') { this._err(client, '对局进行中不能改设置'); return; }
    const s = room.settings;
    if (Array.isArray(msg && msg.categories)) {
      const valid = CATEGORIES.map((c) => c.name);
      const picked = msg.categories.filter((n) => valid.indexOf(n) >= 0);
      if (picked.length) s.categories = picked;
    }
    if (msg && msg.minutes != null) {
      const v = parseInt(msg.minutes, 10);
      const n = isFinite(v) ? v : DEFAULT_MINUTES;
      s.minutes = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, n));
    }
    if (msg && msg.rotate != null) {
      const rotate = !!msg.rotate;
      if (rotate !== s.rotate) {
        s.rotate = rotate;
        s.rounds = rotate ? DEFAULT_ROUNDS_ROTATE : DEFAULT_ROUNDS_FIXED;
        // 模式换了，大家的"准备"身份作废，要重新选
        this._active(room).forEach((m) => { m.ready = false; });
      }
    }
    if (msg && msg.rounds != null) {
      s.rounds = Math.max(1, Math.min(MAX_ROUNDS, parseInt(msg.rounds, 10) || (s.rotate ? DEFAULT_ROUNDS_ROTATE : DEFAULT_ROUNDS_FIXED)));
    }
    this._push(room);
  }

  /** 不轮换模式：自己选"愿不愿意当画者" */
  role(client, msg) {
    const room = this._roomOf(client);
    if (!room) return;
    if (room.state !== 'lobby') { this._err(client, '开始之后就不能改了'); return; }
    if (room.settings.rotate) { this._err(client, '轮换模式不用选，开局后抢画者就行'); return; }
    const m = this._memberOf(room, client.id);
    if (!m) return;
    m.willDraw = msg && msg.willDraw != null ? !!msg.willDraw : (String((msg && msg.role) || '') !== 'guess');
    m.roleChosen = true;
    m.ready = false;                 // 改了身份要重新准备
    this._push(room);
  }

  /** 轮换模式：抢画者 */
  grab(client, msg) {
    const room = this._roomOf(client);
    if (!room || !room.settings.rotate) return;
    if (room.state !== 'grabbing') { this._err(client, '现在不在抢画者的阶段'); return; }
    const m = this._memberOf(room, client.id);
    if (!m) return;
    m.grabChoice = !!(msg && msg.grab);
    this._push(room);
    // 所有人都选完了就不用干等了，直接开始
    if (this._active(room).every((x) => x.grabChoice !== null)) {
      this._broadcast(room, { t: 'ydwg.notice', text: '大家都选好了，直接开始' });
      this._beginRotateMatch(room);
    }
  }

  start(client) {
    const room = this._roomOf(client);
    if (!room) return;
    if (room.hostId !== client.id) { this._err(client, '只有房主能开始'); return; }
    if (room.state !== 'lobby') { this._err(client, '已经在进行中了'); return; }
    if (this._active(room).length < 2) { this._err(client, '至少要有 2 个人才能开局'); return; }
    if (!room.settings.categories.length) { this._err(client, '至少要选一个类别'); return; }

    // 准备门槛：所有人都得选过身份；除房主外所有人都得准备好
    const noRole = this._active(room).filter((m) => !m.roleChosen && !room.settings.rotate);
    if (noRole.length) {
      this._err(client, '还有人选身份：' + noRole.map((m) => m.name).join('、'));
      return;
    }
    const notReady = this._active(room).filter((m) => m.clientId !== room.hostId && !m.ready);
    if (notReady.length) {
      this._err(client, '还没准备好：' + notReady.map((m) => m.name).join('、'));
      return;
    }

    this._active(room).forEach((m) => { m.grabbed = false; m.grabChoice = null; m.guessedRight = 0; m.settleUntil = 0; });
    room.scores = {};
    this._active(room).forEach((m) => { room.scores[m.clientId] = 0; });
    room.turns = 0;
    room.cycle = 0;
    room.turnLog = [];
    room.order = [];
    room.orderPos = 0;
    room.painterId = null;

    if (room.settings.rotate) {
      room.state = 'grabbing';
      room.nextAt = Date.now() + GRAB_MS;
      this._broadcast(room, { t: 'ydwg.grabStart', until: room.nextAt });
      this._push(room);
    } else {
      this._beginFixedMatch(room);
    }
  }

  /** 房主在抢画阶段提前开始 */
  startNow(client) {
    const room = this._roomOf(client);
    if (!room || room.state !== 'grabbing') return;
    if (room.hostId !== client.id) { this._err(client, '只有房主能开始'); return; }
    this._beginRotateMatch(room);
  }

  /* ---------------- 不轮换模式 ---------------- */
  _beginFixedMatch(room) {
    const act = this._active(room);
    // ★ 修 bug：以前「没人愿意画」时把所有人都标成画者（导致全员轮换着画）。
    //   现在缺哪个身份就随机抽一个人补上，而不是把所有人改成画者。
    let painters = act.filter((m) => m.willDraw);
    if (!painters.length) {
      const lucky = act[Math.floor(Math.random() * act.length)];
      lucky.willDraw = true;
      lucky.lottery = true;
      painters = [lucky];
      this._broadcast(room, { t: 'ydwg.notice', text: '没有人愿意当画者，已抽签由「' + lucky.name + '」来画' });
    } else if (painters.length === act.length) {
      // 全员都要画 → 也得有人猜，随机抽一个改成猜者
      const lucky = painters[Math.floor(Math.random() * painters.length)];
      lucky.willDraw = false;
      lucky.lottery = true;
      painters = act.filter((m) => m.willDraw);
      this._broadcast(room, { t: 'ydwg.notice', text: '大家都想画，已抽签让「' + lucky.name + '」先负责猜' });
    }
    room.painterPool = painters.map((m) => m.clientId);
    room.state = 'playing';
    this._broadcast(room, { t: 'ydwg.matchStart', mode: 'fixed', rounds: room.settings.rounds });
    // 先弹 3 秒「谁画谁猜」，再进对局
    this._showRoles(room, 'fixed', room.painterPool[0], room.painterPool.map(
      (id) => { const m = this._memberOf(room, id); return m ? m.name : '?'; }));
  }

  /* ---------------- 轮换模式 ---------------- */
  _beginRotateMatch(room) {
    const act = this._active(room);
    const grabbers = act.filter((m) => m.grabChoice === true);
    const rest = act.filter((m) => m.grabChoice !== true);
    room.order = shuffle(grabbers).concat(shuffle(rest)).map((m) => m.clientId);
    room.orderPos = 0;
    room.cycle = 0;
    room.state = 'playing';
    this._broadcast(room, {
      t: 'ydwg.matchStart',
      mode: 'rotate',
      rounds: room.settings.rounds,
      order: this._orderInfo(room)
    });
    // 抢完画者先弹 3 秒「谁画谁猜」（第一个画的是排在前面的人）
    this._showRoles(room, 'rotate', room.order[0], this._orderInfo(room).map((o) => o.name));
  }

  /** 开局先亮 3 秒身份牌：谁画、谁猜，然后才开始第一回合 */
  _showRoles(room, mode, firstPainterId, orderNames) {
    const list = this._active(room).map((m) => ({
      id: m.clientId, name: m.name, color: m.color,
      role: m.clientId === firstPainterId ? 'draw' : 'guess'
    }));
    this._broadcast(room, {
      t: 'ydwg.roles',
      mode: mode,
      delay: ROLE_SHOW_MS,
      painterId: firstPainterId,
      order: orderNames || [],
      list: list
    });
    room.state = 'roles';
    room.nextAt = Date.now() + ROLE_SHOW_MS;
    this._push(room);
  }

  /* ---------------- 一个回合 ---------------- */
  _startTurn(room) {
    let painterId;
    if (room.settings.rotate) {
      // 轮到的这个人可能已经退出了，往后顺延到还在的人
      for (let guard = 0; guard < room.order.length; guard++) {
        const id = room.order[room.orderPos % room.order.length];
        const mm = this._memberOf(room, id);
        if (mm && !mm.left) { painterId = id; break; }
        room.orderPos = (room.orderPos + 1) % room.order.length;
      }
      if (!painterId) {
        const act2 = this._active(room);
        painterId = act2.length ? act2[0].clientId : null;
      }
    } else {
      const pool = room.painterPool.filter((id) => {
        const m = this._memberOf(room, id);
        return m && !m.left;
      });
      painterId = pool.length === 1 ? pool[0] : pool[Math.floor(Math.random() * pool.length)];
      if (pool.length > 1 && painterId === room.painterId) {
        const alt = pool.filter((id) => id !== painterId);
        painterId = alt[Math.floor(Math.random() * alt.length)];
      }
    }
    room.painterId = painterId;

    const word = this._pickWord(room);
    const m = this._memberOf(room, painterId);
    room.turn = {
      painterId: painterId,
      painterName: m ? m.name : '',
      word: word,
      total: room.settings.minutes * 60,
      elapsed: 0,
      hints: { type: false, len: false, origin: false },
      swaps: SWAP_LIMIT,
      solved: false,
      solverId: null,
      ops: [],
      redo: [],
      guessers: []
    };
    room.state = 'playing';
    room.nextAt = 0;

    this._broadcast(room, {
      t: 'ydwg.turn',
      painterId: painterId,
      painterName: room.turn.painterName,
      wordLen: word.text.length,
      total: room.turn.total,
      hintUnlock: Math.round(room.turn.total * HINT_UNLOCK_RATIO),
      swaps: room.turn.swaps,
      rounds: room.settings.rounds,
      done: this._progress(room),
      order: room.settings.rotate ? this._orderInfo(room) : null
    });
    this.ctx.send(this._clientOf(room, painterId), { t: 'ydwg.secret', word: word.text, origin: word.origin });
    this._push(room);
  }

  _pickWord(room) {
    const pool = [];
    for (const c of CATEGORIES) {
      if (room.settings.categories.indexOf(c.name) < 0) continue;
      for (const raw of c.words) {
        const i = raw.indexOf('|');
        pool.push({
          text: (i < 0 ? raw : raw.slice(0, i)).trim(),
          cat: c.name,
          origin: (i < 0 ? c.origin : raw.slice(i + 1).trim()) || c.origin
        });
      }
    }
    const fresh = pool.filter((w) => room.recent.indexOf(w.text) < 0);
    const list = fresh.length ? fresh : pool;
    const w = list[Math.floor(Math.random() * list.length)];
    room.recent.push(w.text);
    if (room.recent.length > 40) room.recent.shift();
    return w;
  }

  _progress(room) {
    return room.settings.rotate
      ? { cycle: room.cycle, pos: room.orderPos, total: room.order.length }
      : { turn: room.turns, total: room.settings.rounds };
  }

  _orderInfo(room) {
    return room.order.map((id) => {
      const m = this._memberOf(room, id);
      return { id: id, name: m ? m.name : '?' };
    });
  }

  /* ---------------- 画板操作 ---------------- */
  draw(client, msg) {
    const room = this._roomOf(client);
    if (!room || !room.turn || room.state !== 'playing') return;
    if (room.turn.painterId !== client.id) return;      // 只有画者能画
    const op = sanitizeOp(msg);
    if (!op) return;
    if (room.turn.ops.length >= MAX_OPS) {
      // 满了就丢掉最早的一笔（连同它之后的 sege），保证还能继续
      room.turn.ops.splice(0, 1);
    }
    room.turn.ops.push(op);
    room.turn.redo.length = 0;        // 有新操作就作废重做栈
    this._broadcast(room, { t: 'ydwg.op', op: op }, client.id);
  }

  /** 把这一回合已有的笔迹一次性补发给某人（刷新回来 / 中途加入） */
  _sendCanvasSnapshot(room, client) {
    if (!room.turn || !room.turn.ops.length) return;
    this.ctx.send(client, { t: 'ydwg.opBatch', ops: room.turn.ops.slice() });
  }

  /** 撤销 / 重做 / 清空（服务器拍板，所有客户端按同一个 op 数重放） */
  canvas(client, msg) {
    const room = this._roomOf(client);
    if (!room || !room.turn || room.state !== 'playing') return;
    if (room.turn.painterId !== client.id) return;
    const op = String((msg && msg.op) || '');

    if (op === 'sync') { this._sendCanvasSnapshot(room, client); return; }
    if (op === 'undo') {
      if (!room.turn.ops.length) { this._err(client, '没有可以撤销的了'); return; }
      // ★ 必须按「一整笔」为单位撤，不能只弹掉最后一条。
      //   一笔 = 若干 seg + 一个收尾的 sege；只弹掉 sege 的话，客户端重放时
      //   那些 seg 还会被笔画缓冲重新提交，画面上看起来就是「撤销没反应」。
      const last = room.turn.ops[room.turn.ops.length - 1];
      const group = [room.turn.ops.pop()];
      if (last.k === 'sege') {
        while (room.turn.ops.length) {
          const prev = room.turn.ops[room.turn.ops.length - 1];
          if (prev.k === 'seg' && prev.S === last.S) group.push(room.turn.ops.pop());
          else break;
        }
      }
      room.turn.redo.push(group);
      this._broadcast(room, { t: 'ydwg.opCount', n: room.turn.ops.length });
      return;
    }
    if (op === 'redo') {
      const group = room.turn.redo.pop();
      if (!group) { this._err(client, '没有可以重做的了'); return; }
      for (const one of group) room.turn.ops.push(one);
      this._broadcast(room, { t: 'ydwg.opCount', n: room.turn.ops.length });
      return;
    }
    if (op === 'clear') {
      if (!room.turn.ops.length) return;
      room.turn.redo.push(room.turn.ops.slice());   // 整组，才能「一次重做全回来」
      room.turn.ops = [];
      this._broadcast(room, { t: 'ydwg.opCount', n: 0 });
      return;
    }
  }

  /** 画家给提示 */
  hint(client, msg) {
    const room = this._roomOf(client);
    if (!room || !room.turn || room.state !== 'playing') return;
    if (room.turn.painterId !== client.id) return;
    const kind = String((msg && msg.kind) || '');
    if (!HINTS[kind]) return;
    if (room.turn.hints[kind]) return;
    if (room.turn.elapsed < room.turn.total * HINT_UNLOCK_RATIO) {
      this._err(client, '开局 ' + Math.round(HINT_UNLOCK_RATIO * 100) + '% 之后才能给提示');
      return;
    }
    room.turn.hints[kind] = true;
    let text;
    if (kind === 'type') text = room.turn.word.cat;
    else if (kind === 'len') text = room.turn.word.text.length + ' 个字';
    else text = room.turn.word.origin;
    room.turn.hintCost = (room.turn.hintCost || 0) + HINTS[kind].cost;
    this._broadcast(room, { t: 'ydwg.hint', kind: kind, label: HINTS[kind].label, text: text, cost: HINTS[kind].cost });
  }

  /** 换题 */
  swap(client) {
    const room = this._roomOf(client);
    if (!room || !room.turn || room.state !== 'playing') return;
    if (room.turn.painterId !== client.id) return;
    if (room.turn.swaps <= 0) { this._err(client, '这个回合已经换过 ' + SWAP_LIMIT + ' 次了'); return; }
    room.turn.swaps--;
    room.turn.word = this._pickWord(room);
    room.turn.swapsUsed = (room.turn.swapsUsed || 0) + 1;
    // ★ 换了题，之前用掉的提示要自动刷新（新题可以重新给），代价也重新算，
    //   否则换了题之后三档提示全都点不动，而且旧代价会一直滚到新题上。
    room.turn.hints = { type: false, len: false, origin: false };
    room.turn.hintCost = 0;
    this.ctx.send(client, { t: 'ydwg.secret', word: room.turn.word.text, origin: room.turn.word.origin });
    this._broadcast(room, {
      t: 'ydwg.swapped',
      left: room.turn.swaps,
      wordLen: room.turn.word.text.length,
      by: room.turn.painterName,
      hintsReset: true
    });
  }

  /* ---------------- 猜 ---------------- */
  guess(client, msg) {
    const room = this._roomOf(client);
    if (!room || !room.turn || room.state !== 'playing') return;
    if (room.turn.painterId === client.id) { this._err(client, '你是画者，不能猜自己的题'); return; }
    const text = String((msg && msg.text) || '').slice(0, 40).trim();
    if (!text) return;

    const now = Date.now();
    const me = this._memberOf(room, client.id);
    if (me && me.guessCdUntil && now < me.guessCdUntil) {
      // 冷却没到：告诉他还剩几秒（客户端会保留输入框内容不清空）
      this.ctx.send(client, {
        t: 'ydwg.error',
        msg: '猜错了，' + Math.ceil((me.guessCdUntil - now) / 1000) + ' 秒后才能再猜',
        cdLeft: Math.ceil((me.guessCdUntil - now) / 1000),
        keepInput: true
      });
      return;
    }
    if (me) me.guessCdUntil = 0;

    if (norm(text) === norm(room.turn.word.text)) { this._win(room, client); return; }

    if (me) me.guessCdUntil = now + GUESS_CD_MS;
    room.turn.guessers.push({ id: client.id, text: text });
    this._broadcast(room, {
      t: 'ydwg.guessMiss',
      id: client.id,
      name: client.name,
      text: text,
      cd: Math.round(GUESS_CD_MS / 1000)
    });
    this._push(room);
  }

  _win(room, client) {
    const turn = room.turn;
    turn.solved = true;
    turn.solverId = client.id;
    const ratio = Math.max(0, 1 - turn.elapsed / turn.total);

    const g = guessScore(ratio);
    const pBase = painterScore(ratio);
    const hintCost = turn.hintCost || 0;
    const swapCost = (turn.swapsUsed || 0) * 2;
    const rawP = pBase - hintCost - swapCost;
    const p = Math.max(0, rawP);          // 画者分数不为负
    // ★ 得分明细：结算弹窗里「详细」那一栏要用（基础分 / 提示 / 换题 各是多少）
    turn.gainDetail = {};
    turn.gainDetail[client.id] = {
      pts: g, items: [{ label: '基础分（按剩余时间计算）', pts: g }]
    };
    const pItems = [{ label: '基础分（按剩余时间计算）', pts: pBase }];
    if (hintCost) pItems.push({ label: '使用了提示', pts: -hintCost });
    if (swapCost) pItems.push({ label: '换题', pts: -swapCost });
    if (rawP < 0) pItems.push({ label: '扣到 0 分就不再扣了', pts: p - rawP });
    turn.gainDetail[turn.painterId] = { pts: p, items: pItems };
    room.scores[client.id] = (room.scores[client.id] || 0) + g;
    room.scores[turn.painterId] = (room.scores[turn.painterId] || 0) + p;
    const gm = this._memberOf(room, client.id);
    if (gm) gm.guessedRight++;

    this._broadcast(room, {
      t: 'ydwg.win',
      by: client.name,
      word: turn.word.text,
      gains: [
        { id: client.id, name: client.name, pts: g },
        { id: turn.painterId, name: turn.painterName, pts: p }
      ]
    });
    this._endTurn(room, 'guessed');
  }

  chat(client, msg) {
    const room = this._roomOf(client);
    if (!room) return;
    if (room.turn && room.turn.painterId === client.id && room.state === 'playing') {
      this._err(client, '作画时不能发言（但你能看见他们说什么）');
      return;
    }
    const text = String((msg && msg.text) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text) return;
    this._broadcast(room, { t: 'ydwg.chat', name: client.name, id: client.id, text: text });
  }

  /* ---------------- 回合推进 ---------------- */
  _endTurn(room, reason) {
    this._logTurn(room, reason);
    room.turns++;
    if (room.settings.rotate) {
      room.orderPos = (room.orderPos + 1) % room.order.length;
      if (room.orderPos === 0) room.cycle++;
    }
    const word = room.turn.word;
    const isLast = this._isLast(room);
    room.state = 'turnEnd';
    room.nextAt = Date.now() + TURN_GAP_MS;
    this._broadcast(room, {
      t: 'ydwg.turnEnd',
      reason: reason,
      detail: (room.turn && room.turn.gainDetail) ? room.turn.gainDetail : {},
      word: word.text,
      cat: word.cat,
      painterName: room.turn.painterName,
      gapMs: TURN_GAP_MS,
      done: this._progress(room),
      totalRounds: room.settings.rounds,
      isLast: isLast,
      ranking: this._ranking(room)
    });
    this._push(room);
  }

  /** 记一笔回合战报（客户端"本局信息"里的猜对记录） */
  _logTurn(room, reason) {
    const t = room.turn;
    if (!t) return;
    const who = t.solverId ? this._memberOf(room, t.solverId) : null;
    room.turnLog.push({
      n: room.turns + 1,
      cycle: room.settings.rotate ? room.cycle + 1 : null,
      painter: t.painterName,
      painterId: t.painterId,
      word: t.word.text,
      cat: t.word.cat,
      solver: who ? who.name : null,
      solverId: who ? who.clientId : null,
      secs: Math.round(t.elapsed),
      reason: reason
    });
    if (room.turnLog.length > 40) room.turnLog.shift();
  }

  _isLast(room) {
    return room.settings.rotate ? room.cycle >= room.settings.rounds : room.turns >= room.settings.rounds;
  }

  _nextTurn(room) {
    if (!this._active(room).length) return;
    if (this._isLast(room)) {
      room.state = 'over';
      const until = Date.now() + SETTLE_MS;
      this._active(room).forEach((m) => { m.settleUntil = until; });
      this._broadcast(room, {
        t: 'ydwg.over',
        tag: 'final',
        word: room.turn ? room.turn.word.text : '',
        ranking: this._ranking(room),
        settleMs: SETTLE_MS
      });
      this._push(room);
      return;
    }
    if (this._active(room).length < 2) {
      room.state = 'lobby';
      this._broadcast(room, { t: 'ydwg.toLobby', text: '人数不足 2 人，回到大厅' });
      this._push(room);
      return;
    }
    this._startTurn(room);
  }

  /** 房主：跳过回合间歇 */
  skip(client) {
    const room = this._roomOf(client);
    if (!room || room.state !== 'turnEnd') return;
    if (room.hostId !== client.id) { this._err(client, '只有房主能跳过'); return; }
    room.nextAt = 0;
  }

  /** 返回房间（终局结算里的按钮之一） */
  toLobby(client) {
    const room = this._roomOf(client);
    if (!room) return;
    const m = this._memberOf(room, client.id);
    if (m) m.settleUntil = 0;
    room.state = 'lobby';
    room.turn = null;
    room.painterId = null;
    room.order = [];
    room.orderPos = 0;
    room.turns = 0;
    room.cycle = 0;
    this._active(room).forEach((x) => { x.grabbed = false; x.grabChoice = null; x.ready = false; x.guessedRight = 0; });
    room.scores = {};
    this._active(room).forEach((x) => { room.scores[x.clientId] = 0; });
    this._broadcast(room, { t: 'ydwg.toLobby', text: '回到房间了，可以再来一局' });
    this._push(room);
  }

  /** 退出房间（终局结算里的按钮之一） */
  exitRoom(client) {
    this.leave(client);
    this.ctx.send(client, { t: 'ydwg.exited' });
  }

  /* ---------------- 主循环 ---------------- */
  step(dt) {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      // 终局结算：到点还没做选择的人，就当作退出房间
      if (room.state === 'over') {
        const expired = room.members.filter((m) => m.settleUntil && now >= m.settleUntil);
        for (const m of expired) this._settleTimeout(room, m);
        if (!this.rooms.has(room.code)) continue;
      }
      this._sweepDropped(room, now);
      if (!this.rooms.has(room.code)) continue;
      if (room.state === 'grabbing') {
        if (room.nextAt && now >= room.nextAt) this._beginRotateMatch(room);
        continue;
      }
      if (room.state === 'roles') {
        if (room.nextAt && now >= room.nextAt) {
          room.nextAt = 0;
          room.state = 'playing';
          this._startTurn(room);
        }
        continue;
      }
      if (room.state === 'turnEnd') {
        if (room.nextAt && now >= room.nextAt) room.nextAt = 0;
        if (!room.nextAt) this._nextTurn(room);
        continue;
      }
      if (room.state !== 'playing' || !room.turn) continue;
      room.turn.elapsed += dt;
      if (room.turn.elapsed >= room.turn.total) {
        room.turn.elapsed = room.turn.total;
        this._endTurn(room, 'timeout');
      }
    }
  }

  broadcast() {
    for (const room of this.rooms.values()) {
      if (room.state === 'playing' && room.turn) {
        const unlockAt = room.turn.total * HINT_UNLOCK_RATIO;
        const hintLeft = Math.max(0, Math.ceil(unlockAt - room.turn.elapsed));
        this._broadcast(room, {
          t: 'ydwg.tick',
          left: Math.max(0, Math.round(room.turn.total - room.turn.elapsed)),
          total: room.turn.total,
          canHint: hintLeft <= 0,
          hintLeft: hintLeft,
          opCount: room.turn.ops.length
        });
      } else if (room.state === 'grabbing' && room.nextAt) {
        this._broadcast(room, { t: 'ydwg.tick', grabLeft: Math.max(0, Math.round((room.nextAt - Date.now()) / 1000)) });
      } else if (room.state === 'over') {
        const deadlines = room.members.map((m) => m.settleUntil || 0).filter(Boolean);
        const left = deadlines.length
          ? Math.max(0, Math.round((Math.min.apply(null, deadlines) - Date.now()) / 1000))
          : 0;
        this._broadcast(room, { t: 'ydwg.tick', settleLeft: left });
      }
    }
  }

  _ranking(room) {
    return room.members
      .map((m) => ({
        id: m.clientId, name: m.name, score: room.scores[m.clientId] || 0,
        color: m.color, host: m.clientId === room.hostId, right: m.guessedRight || 0,
        left: !!m.left
      }))
      .sort((a, b) => b.score - a.score || b.right - a.right || (a.name < b.name ? -1 : 1));
  }

  /* ---------------- 离开 ---------------- */
  leave(client) {
    const room = this._roomOf(client);
    if (!room) return;
    this._remove(room, client.id, 'left');
  }

  _settleTimeout(room, m) {
    const c = this._clientOf(room, m.clientId);
    if (c) this.ctx.send(c, { t: 'ydwg.settleTimeout' });
    this._remove(room, m.clientId, 'timeout');
  }

  _remove(room, clientId, reason) {
    const idx = room.members.findIndex((m) => m.clientId === clientId);
    if (idx < 0) return;
    const inLobby = (room.state === 'lobby');
    // 大厅里走的人还没参与过任何一局，直接清掉；
    // 对局中 / 结算时走的人**留档**（只标记已退出），这样积分榜和名单里
    // 还留着他的成绩和信息，不会突然少一个人。
    const gone = inLobby ? room.members.splice(idx, 1)[0] : room.members[idx];
    if (!inLobby) {
      gone.left = true;
      gone.leftReason = reason;
      gone.leftAt = Date.now();
      gone.ready = false;
      gone.grabChoice = null;
      gone.guessCdUntil = 0;
      gone.settleUntil = 0;
    } else {
      delete room.scores[clientId];
    }

    const active = this._active(room);
    if (!active.length) { this._destroy(room.code); return; }

    if (room.hostId === clientId) {
      room.hostId = active[0].clientId;
      this._broadcast(room, { t: 'ydwg.host', name: active[0].name });
    }
    // 中途有人退出：全房提示 + 聊天区也要留痕
    this._broadcast(room, {
      t: 'ydwg.playerLeft',
      id: clientId,
      name: gone.name,
      reason: reason,
      text: gone.name + (reason === 'timeout' ? ' 在结算里没有做选择，已自动退出房间' : ' 退出了房间')
    });

    if (active.length < 2) {
      if (room.state !== 'lobby' && room.state !== 'over') {
        room.state = 'lobby';
        room.turn = null;
        this._broadcast(room, { t: 'ydwg.toLobby', text: '人数不足 2 人，已回到大厅' });
      }
    } else if (room.turn && room.turn.painterId === clientId) {
      this._broadcast(room, { t: 'ydwg.notice', text: gone.name + ' 走了，本回合作废' });
      this._endTurn(room, 'left');
    }
    this._push(room);
  }

  /** 还在房间里的人（已退出的只是留档，不参与任何玩法判定） */
  _active(room) { return room.members.filter((m) => !m.left); }

  /** 连接断了（刷新网页 / 关标签页 / 断网）：先别急着踢人，给一段宽限期 */
  onClose(client) { this._drop(client); }

  _drop(client) {
    const room = this._roomOf(client);
    if (!room) return;
    const m = this._memberOf(room, client.id);
    if (!m || m.left) return;
    // 大厅里还没开局，没什么好保留的，直接清掉
    if (room.state === 'lobby') { this._remove(room, client.id, 'left'); return; }
    m.dropped = true;
    m.dropAt = Date.now();
    this._broadcast(room, {
      t: 'ydwg.notice',
      text: m.name + ' 掉线了，' + Math.round(DROP_GRACE_MS / 1000) + ' 秒内回来座位和分数都还在'
    });
    this._push(room);
  }

  /** 宽限期到了还没回来 → 正式移除（留档） */
  _sweepDropped(room, now) {
    const expired = room.members.filter((m) => m.dropped && !m.left && now - (m.dropAt || 0) >= DROP_GRACE_MS);
    for (const m of expired) this._remove(room, m.clientId, 'left');
  }

  onRename(client) {
    const room = this._roomOf(client);
    if (!room) return;
    const m = this._memberOf(room, client.id);
    if (m) m.name = client.name;
    this._push(room);
  }

  /* ---------------- 工具 ---------------- */
  _err(client, msg) { this.ctx.send(client, { t: 'ydwg.error', msg: msg }); }

  _roomOf(client) {
    if (!client) return null;
    for (const room of this.rooms.values()) {
      for (const m of room.members) if (m.clientId === client.id) return room;
    }
    return null;
  }

  _memberOf(room, clientId) {
    for (const m of room.members) if (m.clientId === clientId) return m;
    return null;
  }

  _clientOf(room, clientId) { return this.ctx.clients.get(clientId) || null; }

  _broadcast(room, payload, exceptClientId) {
    for (const m of room.members) {
      if (exceptClientId && m.clientId === exceptClientId) continue;
      const c = this._clientOf(room, m.clientId);
      if (c) this.ctx.send(c, payload);
    }
  }

  _push(room) {
    const act = this._active(room);
    const notReady = act.filter((m) => m.clientId !== room.hostId && !m.ready).map((m) => m.name);
    const noRole = room.settings.rotate ? [] : act.filter((m) => !m.roleChosen).map((m) => m.name);
    const grabbers = act.filter((m) => m.grabChoice === true).length;
    const undecided = act.filter((m) => m.grabChoice === null).length;

    this._broadcast(room, {
      t: 'ydwg.room',
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      settings: room.settings,
      maxPlayers: MAX_PLAYERS,
      categories: CATEGORIES.map((c) => ({ name: c.name, count: c.words.length })),
      limits: {
        minMinutes: MIN_MINUTES, maxMinutes: MAX_MINUTES, maxRounds: MAX_ROUNDS,
        maxPlayers: MAX_PLAYERS, swapLimit: SWAP_LIMIT, hintRatio: HINT_UNLOCK_RATIO,
        maxLayers: MAX_LAYERS, grabMs: GRAB_MS, turnGapMs: TURN_GAP_MS, settleMs: SETTLE_MS
      },
      painterId: room.turn ? room.turn.painterId : (room.painterId || null),
      painterName: room.turn ? room.turn.painterName : '',
      // 本局战报（最近的在前）：谁画了什么、谁猜对了、用了多久
      log: room.turnLog.slice(-14).reverse(),
      turnElapsed: room.turn ? Math.round(room.turn.elapsed) : 0,
      turnTotal: room.turn ? room.turn.total : 0,
      hints: (room.turn && room.turn.hints)
        ? Object.keys(room.turn.hints).filter((k) => room.turn.hints[k]) : [],
      swapsLeft: (room.turn && room.turn.swaps != null) ? room.turn.swaps : 0,
      done: room.turn ? this._progress(room) : (room.settings.rotate
        ? { cycle: room.cycle, pos: room.orderPos, total: room.order.length }
        : { turn: room.turns, total: room.settings.rounds }),
      order: room.settings.rotate && room.order.length ? this._orderInfo(room) : null,
      grab: { until: room.nextAt || 0, grabbers: grabbers, undecided: undecided, total: act.length },
      activeCount: act.length,
      ready: { waiting: notReady, noRole: noRole, allReady: notReady.length === 0 && noRole.length === 0 },
      members: room.members.map((m) => ({
        id: m.clientId,
        name: m.name,
        color: m.color,
        ready: m.ready,
        host: m.clientId === room.hostId,
        roleChosen: m.roleChosen,
        willDraw: m.willDraw,
        grabChoice: m.grabChoice,
        lottery: !!m.lottery,
        cd: Math.max(0, Math.ceil(((m.guessCdUntil || 0) - Date.now()) / 1000)),
        right: m.guessedRight || 0,
        settleUntil: m.settleUntil || 0,
        left: !!m.left,
        dropped: !!m.dropped,
        score: room.scores[m.clientId] || 0
      }))
    });
  }

  _destroy(code) {
    this.rooms.delete(code);
    console.log('[ydwg] 房间', code, '已回收');
  }

  /** 在不在房间里（好友列表据此显示「组队中」并禁掉邀请按钮）；单人模式没有房间 → null */
  busy(client) {
    const room = this._roomOf(client);
    if (!room) return null;
    return { label: '房间 ' + room.code, code: room.code };
  }
}

DrawGuessHub.title = '你画我猜';
DrawGuessHub.entry = '/drawguess/';
DrawGuessHub.order = 20;
DrawGuessHub.card = {
  desc: '一个画、其余猜：画板限时作画，猜的人可以互相交流、抢答得分。画家能花代价给"类型/几个字/来自哪里"提示，画板不许写字。',
  tags: ['在线联机 · 最多 10 人', '画者轮换 / 也可只画只猜', '10 大类别 · 每类 55+ 词', '整页亮色 · 画板不许写字'],
  art: 'card.svg'
};

DrawGuessHub.routes = {
  'ydwg.create': 'create',
  'ydwg.join': 'join',
  'ydwg.leave': 'leave',
  'ydwg.ready': 'ready',
  'ydwg.settings': 'settings',
  'ydwg.role': 'role',
  'ydwg.grab': 'grab',
  'ydwg.start': 'start',
  'ydwg.startNow': 'startNow',
  'ydwg.draw': 'draw',
  'ydwg.canvas': 'canvas',
  'ydwg.hint': 'hint',
  'ydwg.swap': 'swap',
  'ydwg.guess': 'guess',
  'ydwg.chat': 'chat',
  'ydwg.skip': 'skip',
  'ydwg.toLobby': 'toLobby',
  'ydwg.exitRoom': 'exitRoom'
};

module.exports = DrawGuessHub;
module.exports.RULES = {
  MAX_PLAYERS, MIN_MINUTES, MAX_MINUTES, MAX_ROUNDS,
  DEFAULT_MINUTES, DEFAULT_ROUNDS_FIXED, DEFAULT_ROUNDS_ROTATE, DEFAULT_ROTATE,
  HINTS, HINT_UNLOCK_RATIO, SWAP_LIMIT, GUESS_CD_MS, GRAB_MS, TURN_GAP_MS, SETTLE_MS, MAX_LAYERS
};
