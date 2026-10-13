'use strict';
/**
 * 方块躲避 —— 联机房间（2~4 人同队，全员到达终点才算通关）
 *
 * 与坦克一样走「服务端权威模拟」：客户端只上报按键，服务端 60Hz 推进世界、
 * 20Hz 广播快照；谁被撞死、谁到了终点，一律以服务端判定为准（机房内 RTT 约 1ms，
 * 客户端再对自己那辆车做本地预测，手感就是"按下即动"）。
 *
 * 组队规则（与需求文档一致）：
 *   · 全员到达终点 → 本关通关，房主可以进下一关
 *   · 已到达的玩家按「接应」键 → 还在跑的队友直接被送到终点（冷却 3 秒）
 *   · 死亡 → 回到自己最近的复活点（没经过任何复活点就回出生点），各自独立复活
 *   · 关卡由房主选择，玩的是服务端内置关卡（自制关卡只能在单机/本地模式玩）
 */
const DodgeCore = require('../shared/dodgecore.js');
const PACK = require('../shared/levels.json');

const SNAPSHOT_HZ = 20;          // 20Hz 广播足够（本游戏不需要坦克那种 30Hz 手感）
const MAX_PLAYERS = 4;
const LEVELS = PACK.levels.map(function (raw) { return DodgeCore.normalizeLevel(raw); });

function newCode(rooms) {
  for (let i = 0; i < 5000; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(Date.now()).slice(-4);
}

function emptyInput() { return { up: false, down: false, left: false, right: false }; }

class DodgeHub {
  constructor(ctx) {
    this.ctx = ctx;
    this.rooms = new Map();       // code -> room
  }

  roomCount() { return this.rooms.size; }
  stats() {
    let playing = 0;
    this.rooms.forEach(function (r) { if (r.state === 'playing') playing++; });
    return { dodgeRooms: this.rooms.size, dodgePlaying: playing, dodgeLevels: LEVELS.length };
  }

  /* ---------- 房间管理 ---------- */
  create(client) {
    this.leave(client);
    const code = newCode(this.rooms);
    const room = {
      code: code,
      hostId: client.id,
      members: [],
      levelIndex: 0,
      state: 'lobby',           // lobby | playing | cleared
      world: null,
      players: [],              // 与 members 一一对应
      inputs: {},               // clientId -> {up,down,left,right}
      timer: 0,
      snapAcc: 0,
      startAt: 0,
      lastResult: null
    };
    this.rooms.set(code, room);
    this._add(room, client);
    this.ctx.send(client, { t: 'dodge.created', code: code });
    this._push(room);
    console.log('[dodge] 房间', code, '由', client.name, '创建');
  }

  join(client, msg) {
    const code = String((msg && msg.code) || '').trim();
    const room = this.rooms.get(code);
    if (!room) { this.ctx.send(client, { t: 'dodge.error', msg: '房间号不存在，请检查后重试' }); return; }
    if (room.members.length >= MAX_PLAYERS) { this.ctx.send(client, { t: 'dodge.error', msg: '房间已满（最多 4 人）' }); return; }
    if (room.state === 'playing') { this.ctx.send(client, { t: 'dodge.error', msg: '这一关正在进行，等队伍回到大厅再加入吧' }); return; }

    this.leave(client);
    this._add(room, client);
    this.ctx.send(client, { t: 'dodge.joined', code: code });
    this._push(room);
  }

  _add(room, client) {
    const index = room.members.length;
    const member = {
      clientId: client.id,
      name: client.name,
      color: DodgeCore.PLAYER_COLORS[index % DodgeCore.PLAYER_COLORS.length],
      ready: false
    };
    room.members.push(member);
    room.inputs[client.id] = emptyInput();
    this.ctx.send(client, { t: 'dodge.you', index: index, color: member.color });
    console.log('[dodge] ', client.name, '加入房间', room.code, '（第 ' + (index + 1) + ' 位）');
  }

  _memberOf(room, clientId) {
    for (let i = 0; i < room.members.length; i++) if (room.members[i].clientId === clientId) return room.members[i];
    return null;
  }

  ready(client, msg) {
    const room = this._roomOf(client);
    if (!room) return;
    const m = this._memberOf(room, client.id);
    if (!m) return;
    m.ready = !!(msg && msg.ready);
    this._push(room);
  }

  /** 房主选关 */
  level(client, msg) {
    const room = this._roomOf(client);
    if (!room) return;
    if (room.hostId !== client.id) { this.ctx.send(client, { t: 'dodge.error', msg: '只有房主可以选择关卡' }); return; }
    const idx = Math.max(0, Math.min(LEVELS.length - 1, parseInt(msg && msg.index, 10) || 0));
    room.levelIndex = idx;
    this._push(room);
  }

  /** 房主开始（必须全员已准备） */
  start(client) {
    const room = this._roomOf(client);
    if (!room) return;
    if (room.hostId !== client.id) { this.ctx.send(client, { t: 'dodge.error', msg: '只有房主可以开始游戏' }); return; }
    const notReady = room.members.filter(function (m) { return m.clientId !== room.hostId && !m.ready; });
    if (notReady.length) {
      this.ctx.send(client, { t: 'dodge.error', msg: '还有 ' + notReady.length + ' 人没准备：' + notReady.map(function (m) { return m.name; }).join('、') });
      return;
    }
    this._startLevel(room, room.levelIndex);
  }

  _startLevel(room, index) {
    room.levelIndex = index;
    room.state = 'playing';
    room.timer = 0;
    room.startAt = Date.now();
    room.world = DodgeCore.createWorld(LEVELS[index]);
    room.players = room.members.map(function (m, i) {
      const p = DodgeCore.createPlayer(room.world, i, m.name);
      p.clientId = m.clientId;
      return p;
    });
    room.members.forEach(function (m) { m.ready = false; });
    this._broadcast(room, {
      t: 'dodge.levelStart',
      index: index,
      level: DodgeCore.serializeLevel(LEVELS[index]),
      levelCount: LEVELS.length
    });
    this._push(room);
  }

  /** 重来本关（任何人都可以按，整队一起重来） */
  restart(client) {
    const room = this._roomOf(client);
    if (!room) return;
    this._restartRoom(room);
  }

  _restartRoom(room) {
    if (room.state !== 'playing' && room.state !== 'cleared') return;
    const wasCleared = room.state === 'cleared';
    room.state = 'playing';
    room.timer = 0;
    room.startAt = Date.now();
    DodgeCore.resetLevel(room.world, room.players);
    room.lastResult = null;
    this._broadcast(room, { t: 'dodge.restart', index: room.levelIndex, wasCleared: wasCleared });
    this._push(room);
  }

  /** 房主：进入下一关（通关后） */
  next(client) {
    const room = this._roomOf(client);
    if (!room) return;
    if (room.hostId !== client.id) { this.ctx.send(client, { t: 'dodge.error', msg: '只有房主可以切到下一关' }); return; }
    if (room.state !== 'cleared') { this.ctx.send(client, { t: 'dodge.error', msg: '本关还没通关' }); return; }
    const nextIdx = room.levelIndex + 1;
    if (nextIdx >= LEVELS.length) {
      room.state = 'lobby';
      room.world = null;
      this._broadcast(room, { t: 'dodge.allCleared' });
      this._push(room);
      return;
    }
    this._startLevel(room, nextIdx);
  }

  /** 回大厅（通关后 / 中途退出关卡） */
  toLobby(client) {
    const room = this._roomOf(client);
    if (!room) return;
    room.state = 'lobby';
    room.world = null;
    room.players = [];
    if (room.hostId !== client.id) { /* 任何人回大厅都行：整队回大厅更省事 */ }
    this._broadcast(room, { t: 'dodge.toLobby' });
    this._push(room);
  }

  /* ---------- 玩的过程 ---------- */
  input(client, msg) {
    const room = this._roomOf(client);
    if (!room || room.state !== 'playing') return;
    const inp = room.inputs[client.id];
    if (!inp) return;
    inp.up = !!(msg && msg.up);
    inp.down = !!(msg && msg.down);
    inp.left = !!(msg && msg.left);
    inp.right = !!(msg && msg.right);
  }

  /** 已到达的玩家按「接应」：把还在跑的队友直接送到终点 */
  rescue(client) {    const room = this._roomOf(client);
    if (!room || room.state !== 'playing') return;
    const me = this._playerOf(room, client.id);
    if (!me) return;
    if (me.state !== 'arrived') { this.ctx.send(client, { t: 'dodge.error', msg: '只有已经到达终点的队友才能接应' }); return; }
    if (me.rescueCd > 0) { this.ctx.send(client, { t: 'dodge.error', msg: '接应还在冷却（' + me.rescueCd.toFixed(1) + ' 秒）' }); return; }
    const moved = DodgeCore.rescue(room.world, room.players, me.index);
    if (!moved.length) { this.ctx.send(client, { t: 'dodge.error', msg: '队友都已经到终点了' }); return; }
    this._broadcast(room, {
      t: 'dodge.rescued', by: me.index, name: me.name,
      moved: moved, cooldown: DodgeCore.RESCUE_CD
    });
    this._push(room);
    this._checkCleared(room);
  }

  /**
   * 仅测试钩子（WB_TEST_HOOKS=1 才生效）：把自己瞬移到指定像素坐标。
   * 自检要用它精确制造"踩到障碍""走到终点"这类场景，不然只能靠慢慢按键走。
   * 与 tank.teleport 同一思路，正式服里这个入口是死的。
   */
  teleport(client, msg) {
    if (!process.env.WB_TEST_HOOKS) return;
    const room = this._roomOf(client);
    if (!room || room.state !== 'playing') return;
    const p = this._playerOf(room, client.id);
    if (!p) return;
    p.x = Number(msg && msg.x) || p.x;
    p.y = Number(msg && msg.y) || p.y;
  }

  leave(client) {    const room = this._roomOf(client);
    if (!room) return;
    const idx = room.members.findIndex(function (m) { return m.clientId === client.id; });
    if (idx < 0) return;
    const gone = room.members.splice(idx, 1)[0];
    delete room.inputs[client.id];
    room.players = (room.players || []).filter(function (p) { return p.clientId !== client.id; });
    // 玩家索引就是颜色/出生点下标，走了一个人要把后面的补位，否则颜色会跳号
    room.players.forEach(function (p, i) { p.index = i; p.color = room.members[i] ? room.members[i].color : p.color; });

    if (!room.members.length) { this._destroy(room.code); return; }
    if (room.hostId === client.id) {
      room.hostId = room.members[0].clientId;
      this._broadcast(room, { t: 'dodge.host', name: room.members[0].name });
    }
    this._broadcast(room, { t: 'dodge.playerLeft', name: gone.name });
    // 人少了，正在跑的这一关直接重来：不然剩下的人要在半路上干等
    if (room.state === 'playing') this._restartRoom(room);
    this._push(room);
  }

  onClose(client) {
    this.leave(client);
  }

  onRename(client) {
    const room = this._roomOf(client);
    if (!room) return;
    const m = this._memberOf(room, client.id);
    if (!m) return;
    m.name = client.name;
    const p = this._playerOf(room, client.id);
    if (p) p.name = client.name;
    this._push(room);
  }

  /* ---------- 主循环 ---------- */
  step(dt) {
    this.rooms.forEach((room) => {
      if (room.state !== 'playing' || !room.world) return;
      room.timer += dt;
      DodgeCore.stepObstacles(room.world, dt);
      for (const p of room.players) {
        const inp = room.inputs[p.clientId] || emptyInput();
        const ev = DodgeCore.stepPlayer(room.world, p, inp, dt);
        if (ev.died) {
          this.ctx.send(this._clientOf(room, p.clientId), { t: 'dodge.ownDeath', deaths: p.deaths });
          this._broadcast(room, { t: 'dodge.death', index: p.index, name: p.name, deaths: p.deaths }, p.clientId);
        }
        if (ev.arrived) {
          room.players.forEach(function (q) { if (q.state === 'arrived' && !q.arriveTime) q.arriveTime = room.timer; });
          this._broadcast(room, { t: 'dodge.arrived', index: p.index, name: p.name });
        }
        if (ev.respawned) this._broadcast(room, { t: 'dodge.respawn', index: p.index });
      }
      this._checkCleared(room);
    });
  }

  _checkCleared(room) {
    if (room.state !== 'playing') return;
    if (!DodgeCore.allArrived(room.players)) return;
    room.state = 'cleared';
    room.lastResult = {
      index: room.levelIndex,
      time: room.timer,
      deaths: room.players.map(function (p) { return { index: p.index, name: p.name, deaths: p.deaths }; }),
      rescued: room.players.filter(function (p) { return !!p.rescued; }).map(function (p) { return p.index; })
    };
    this._broadcast(room, { t: 'dodge.cleared', result: room.lastResult, hasNext: room.levelIndex + 1 < LEVELS.length });
    this._push(room);
  }

  broadcast(dt) {
    const interval = 1 / SNAPSHOT_HZ;
    this.rooms.forEach((room) => {
      if (room.state !== 'playing' || !room.world) return;
      room.snapAcc += dt;
      if (room.snapAcc < interval) return;
      room.snapAcc = 0;
      this._broadcast(room, this._snapshot(room));
    });
  }

  /** 体积很小：4 个人 + 6 个障碍，几十字节 */
  _snapshot(room) {
    return {
      t: 'dodge.snap',
      time: +room.timer.toFixed(2),
      players: room.players.map(function (p) {
        return [p.index, +p.x.toFixed(1), +p.y.toFixed(1), p.state, p.invuln > 0 ? 1 : 0, p.rescueCd > 0 ? 1 : 0];
      }),
      obstacles: room.world.obstacles.map(function (o) {
        return [+o.x.toFixed(1), +o.y.toFixed(1)];
      })
    };
  }

  /* ---------- 工具 ---------- */
  _roomOf(client) {
    if (!client) return null;
    for (const room of this.rooms.values()) {
      for (const m of room.members) if (m.clientId === client.id) return room;
    }
    return null;
  }

  _clientOf(room, clientId) { return this.ctx.clients.get(clientId) || null; }

  _playerOf(room, clientId) {
    for (let i = 0; i < room.players.length; i++) if (room.players[i].clientId === clientId) return room.players[i];
    return null;
  }

  _broadcast(room, payload, exceptClientId) {
    for (const m of room.members) {
      if (exceptClientId && m.clientId === exceptClientId) continue;
      const c = this._clientOf(room, m.clientId);
      if (c) this.ctx.send(c, payload);
    }
  }

  /** 大厅状态（人员、准备、选关） */
  _push(room) {
    this._broadcast(room, {
      t: 'dodge.room',
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      levelIndex: room.levelIndex,
      levelCount: LEVELS.length,
      levelName: LEVELS[room.levelIndex] ? LEVELS[room.levelIndex].name : '',
      levelNames: LEVELS.map(function (l) { return { name: l.name, difficulty: l.difficulty }; }),
      maxPlayers: MAX_PLAYERS,
      members: room.members.map(function (m) {
        return { id: m.clientId, name: m.name, color: m.color, ready: m.ready, host: m.clientId === room.hostId };
      })
    });
  }

  _destroy(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    this.rooms.delete(code);
    console.log('[dodge] 房间', code, '已回收');
  }
}

DodgeHub.title = '方块躲避';        // 游戏自己声明的显示名
DodgeHub.entry = '/dodge/';        // 访问入口
DodgeHub.order = 10;               // 主页卡片顺序（数字小的排前面）

/** 主页卡片内容由游戏自己提供，平台只负责渲染 */
DodgeHub.card = {
  desc: '经典「史上最难的游戏」玩法：方格玩家、圆形巡逻障碍，靠卡时机穿过缝隙；全员到达终点才算过关，还有关卡编辑器可以自己做关。',
  tags: [
    '单人 / 本地 4 人 / 在线联机',
    '方格 vs 圆形 · 缝隙判定',
    '全员到达才通关 · 接应传送',
    '10 个内置关卡 + 关卡编辑器'
  ],
  art: 'card.svg',
  /*
   * 这个游戏的"第二个页面"：关卡编辑器进不了游戏大厅的动线里（它是单机的），
   * 所以单独挂到主页卡片上，免得别人找不到入口。
   * 平台只收站内相对路径，最多 3 个（见 server.cjs 的 cardLinks）。
   */
  links: [
    { label: '关卡编辑器', href: '/dodge/editor.html', icon: '🛠' }
  ]
};

/** 这个游戏自己声明的消息路由（消息类型 → Hub 方法名），主机只做装配 */
DodgeHub.routes = {
  'dodge.create': 'create',
  'dodge.join': 'join',
  'dodge.leave': 'leave',
  'dodge.ready': 'ready',
  'dodge.level': 'level',
  'dodge.start': 'start',
  'dodge.restart': 'restart',
  'dodge.next': 'next',
  'dodge.toLobby': 'toLobby',
  'dodge.input': 'input',
  'dodge.rescue': 'rescue',
  'dodge.teleport': 'teleport'      // 仅测试：WB_TEST_HOOKS=1 时才生效
};

module.exports = DodgeHub;
