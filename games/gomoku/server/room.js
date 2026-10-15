'use strict';
/**
 * 五子棋 —— 邀请制联机对局
 * 每个 IP 拥有一个专属邀请码；输入对方邀请码即可邀请对方进入对局。
 * 规则：传统五子棋（连成五子或以上即胜），每人各有一次悔棋机会。
 *
 * 悔棋规则（不需要对方同意）：
 *   只要「自己最近落下的那一手之后对方还没有落子」，就能直接撤回那一手，机会随即用掉。
 *   若对方已经应手，则这一手不能再悔 —— 机会保留，等自己下一次落子后（对方未应手时）再用。
 *   悔棋只撤回最后落下的那一手。
 */

const SIZE = 15;
const INVITE_TIMEOUT = 30000;

function emptyBoard() {
  return new Array(SIZE * SIZE).fill(0);
}

class GomokuHub {
  constructor(ctx) {
    this.ctx = ctx;
    this.matches = new Map();   // matchId -> match
    this.byClient = new Map();  // clientId -> matchId
    this.nextId = 1;
    this.pending = new Map();   // matchId -> timer
    // 「两人之间上一局谁执黑」的记忆（key = 双方邀请码排序后拼接），用来实现黑白轮换
    this.colorMemory = new Map();
  }

  matchCount() { return this.matches.size; }
  /** 给主机 /api/status 用的统计（每个游戏自己声明要暴露什么） */
  stats() { return { gomokuMatches: this.matches.size }; }

  /* ---------- 注册 ---------- */
  register(client) {
    this.ctx.send(client, {
      t: 'gomoku.code',
      code: client.inviteCode,
      ip: client.ip,
      name: client.name,
      online: this.ctx.clients.size
    });
  }

  /* ---------- 邀请 ---------- */
  invite(client, msg) {
    const code = String((msg && msg.code) || '').toUpperCase().replace(/\s/g, '');
    if (!code) { this.ctx.send(client, { t: 'gomoku.error', msg: '请输入邀请码' }); return; }
    if (code === client.inviteCode) { this.ctx.send(client, { t: 'gomoku.error', msg: '不能邀请自己' }); return; }
    if (this.byClient.has(client.id)) { this.ctx.send(client, { t: 'gomoku.error', msg: '你已在对局中' }); return; }

    const target = this.ctx.findByInviteCode(code);
    if (!target) { this.ctx.send(client, { t: 'gomoku.error', msg: '邀请码不存在或对方已离线' }); return; }
    if (this.byClient.has(target.id)) { this.ctx.send(client, { t: 'gomoku.error', msg: '对方正在对局中' }); return; }

    // 清理旧邀请
    for (const [mid, m] of this.matches) {
      if (m.state === 'pending' && (m.black.id === client.id || m.white.id === client.id)) this._destroy(mid);
    }

    const id = 'm' + (this.nextId++);
    // 同一对玩家再开一局时，黑白互换（上一局执黑的这局执白），避免永远固定一方先手
    let flip = false;
    const pairKey = [client.inviteCode, target.inviteCode].sort().join('|');
    if (this.colorMemory && this.colorMemory.get(pairKey) === client.inviteCode) flip = true;
    const blackSide = flip ? target : client;
    const whiteSide = flip ? client : target;
    const match = {
      id,
      pairKey,
      black: { id: blackSide.id, name: blackSide.name, code: blackSide.inviteCode },
      white: { id: whiteSide.id, name: whiteSide.name, code: whiteSide.inviteCode },
      inviteeId: target.id,     // 被邀请的人（与黑白无关，只用于接受/拒绝邀请）
      inviterId: client.id,     // 发起邀请的人（拒绝/超时的提示要发给他，而不是发给执黑方）
      board: emptyBoard(),
      moves: [],
      turn: 1,           // 1 = 黑, 2 = 白
      undoLeft: { 1: 1, 2: 1 },
      state: 'pending',
      win: null,
      undoFrom: 0
    };
    this.matches.set(id, match);
    this.byClient.set(client.id, id);
    this.byClient.set(target.id, id);

    this.ctx.send(client, { t: 'gomoku.waiting', matchId: id, to: { name: target.name, code: target.inviteCode } });
    this.ctx.send(target, {
      t: 'gomoku.invited',
      matchId: id,
      from: { name: client.name, code: client.inviteCode }
    });

    const timer = setTimeout(() => {
      if (this.matches.has(id) && match.state === 'pending') {
        this.ctx.send(client, { t: 'gomoku.error', msg: '对方未响应，邀请已过期' });
        this._destroy(id);
      }
    }, INVITE_TIMEOUT);
    this.pending.set(id, timer);
  }

  replyInvite(client, msg) {
    const id = msg && msg.matchId;
    const match = this.matches.get(id);
    if (!match || match.state !== 'pending') return;
    if (match.inviteeId !== client.id) return;   // 只有被邀请的人能应答（与执黑执白无关）

    if (!msg.accept) {
      // 注意：黑白会轮换，执黑方不一定就是邀请方，提示必须发给真正发起邀请的人
      this.ctx.send(this._c(match.inviterId), { t: 'gomoku.error', msg: '对方拒绝了你的邀请' });
      this._destroy(id);
      return;
    }
    match.state = 'playing';
    this._clearTimer(id);
    this._sendStart(match);
  }

  _sendStart(match) {
    // 对局真正开始（对方接受）后才记下"这一局谁执黑"，
    // 被拒绝/过期的邀请不参与轮换，否则白白翻一次
    if (match.pairKey) this.colorMemory.set(match.pairKey, match.black.code);
    // 每位玩家的 you 由 _statePayload 按身份生成，不能写死在 extra 里
    this._sendState(match, { t: 'gomoku.start' });
  }

  _c(id) { return this.ctx.clients.get(id); }

  _statePayload(match, you) {
    return {
      matchId: match.id,
      size: SIZE,
      you,
      board: match.board,
      turn: match.turn,
      moves: match.moves.length,
      undoLeft: { 1: match.undoLeft[1], 2: match.undoLeft[2] },
      players: {
        1: { name: match.black.name, code: match.black.code, online: !!this._c(match.black.id) },
        2: { name: match.white.name, code: match.white.code, online: !!this._c(match.white.id) }
      },
      last: match.moves.length ? match.moves[match.moves.length - 1] : null,
      win: match.win,
      state: match.state,
      // 谁能悔棋：轮到自己落子时刚好是「对方已应手」，此时不能悔；
      // 自己刚落完、对方还没应手时 canUndo 才为 true
      canUndo: { 1: this._canUndo(match, 1), 2: this._canUndo(match, 2) }
    };
  }

  /**
   * 广播状态。extra 只用于「合并进状态里」的附加字段，
   * 不要把 t 放进去 —— 那会把消息类型改掉，客户端就不会当成状态处理了。
   */
  _sendState(match, extra) {
    for (const p of [match.black, match.white]) {
      const c = this._c(p.id);
      if (!c) continue;
      const y = p.id === match.black.id ? 1 : 2;
      this.ctx.send(c, Object.assign({}, this._statePayload(match, y), { t: 'gomoku.state' }, extra || {}));
    }
  }

  /** 玩家改了昵称 → 棋盘两侧的名字一起更新 */
  onRename(client) {
    const match = this.matches.get(this.byClient.get(client.id));
    if (!match) return;
    let hit = false;
    if (match.black.id === client.id && match.black.name !== client.name) { match.black.name = client.name; hit = true; }
    if (match.white.id === client.id && match.white.name !== client.name) { match.white.name = client.name; hit = true; }
    if (hit && match.state !== 'pending') this._sendState(match);
  }

  /** 只发一条通知（不改状态），例如「谁悔棋了」 */
  _notify(match, payload) {
    for (const p of [match.black, match.white]) {
      const c = this._c(p.id);
      if (c) this.ctx.send(c, payload);
    }
  }

  /* ---------- 落子 ---------- */
  move(client, msg) {
    const match = this.matches.get(this.byClient.get(client.id));
    if (!match || match.state !== 'playing') return;
    const me = match.black.id === client.id ? 1 : (match.white.id === client.id ? 2 : 0);
    if (!me) return;
    if (match.turn !== me) { this.ctx.send(client, { t: 'gomoku.error', msg: '还没轮到你' }); return; }

    const x = parseInt(msg.x, 10), y = parseInt(msg.y, 10);
    if (!(x >= 0 && x < SIZE && y >= 0 && y < SIZE)) return;
    if (match.board[y * SIZE + x] !== 0) { this.ctx.send(client, { t: 'gomoku.error', msg: '该位置已有棋子' }); return; }

    match.board[y * SIZE + x] = me;
    match.moves.push({ x, y, p: me });
    const line = this._findLine(match.board, x, y, me);
    if (line) {
      match.win = { p: me, line, id: client.id };
      match.state = 'over';
    } else if (match.moves.length >= SIZE * SIZE) {
      match.win = { p: 0, line: [], id: 0 };
      match.state = 'over';
    } else {
      match.turn = me === 1 ? 2 : 1;
    }
    this._sendState(match);
    if (match.state === 'over') this._finish(match);
  }

  /**
   * 落子预览转发：只有「轮到落子的一方」的预览才会转给对方，
   * 这样对面看到的预览颜色永远等于当前该谁下（黑方预览是黑子、白方预览是白子）。
   */
  hover(client, msg) {
    const match = this.matches.get(this.byClient.get(client.id));
    if (!match || match.state !== 'playing') return;
    const me = match.black.id === client.id ? 1 : (match.white.id === client.id ? 2 : 0);
    if (!me) return;
    if (match.turn !== me) return;                 // 不是自己回合，预览不对外可见

    const x = parseInt(msg && msg.x, 10), y = parseInt(msg && msg.y, 10);
    const valid = x >= 0 && x < SIZE && y >= 0 && y < SIZE && match.board[y * SIZE + x] === 0;

    const opp = me === 1 ? match.white : match.black;
    const c = this._c(opp.id);
    if (!c) return;
    this.ctx.send(c, valid
      ? { t: 'gomoku.hover', p: me, x, y }
      : { t: 'gomoku.hover', p: me, x: -1, y: -1 });
  }

  /** 对局结束：解除索引绑定，并安排一段时间后回收，避免 matches 无限增长 */
  _finish(match) {
    this.byClient.delete(match.black.id);
    this.byClient.delete(match.white.id);
    const timer = setTimeout(() => this._destroy(match.id), 10 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  /* ---------- 悔棋（不需要对方同意） ---------- */

  /**
   * 当前能否悔棋：必须是「棋盘上最后一手是自己下的」，
   * 也就是自己刚落完、对方还没来得及应手。对方一旦应手，就只能等自己下一次落子。
   */
  _canUndo(match, p) {
    if (match.state !== 'playing') return false;
    if (match.undoLeft[p] <= 0) return false;
    const last = match.moves[match.moves.length - 1];
    return !!last && last.p === p;
  }

  undo(client) {
    const match = this.matches.get(this.byClient.get(client.id));
    if (!match || match.state !== 'playing') return;
    const me = match.black.id === client.id ? 1 : (match.white.id === client.id ? 2 : 0);
    if (!me) return;

    if (match.undoLeft[me] <= 0) {
      this.ctx.send(client, { t: 'gomoku.error', msg: '你的悔棋机会已用完' });
      return;
    }
    if (!match.moves.length) {
      this.ctx.send(client, { t: 'gomoku.error', msg: '还没有可以撤回的棋' });
      return;
    }
    const last = match.moves[match.moves.length - 1];
    if (last.p !== me) {
      // 对方已经应手：这一次悔不了，但机会不消耗
      this.ctx.send(client, { t: 'gomoku.error', msg: '对方已经落子，这一手不能悔了（等自己下一手再悔）' });
      return;
    }

    const mv = match.moves.pop();
    match.board[mv.y * SIZE + mv.x] = 0;
    match.undoLeft[me] -= 1;
    match.turn = me;          // 撤回后重新轮到自己
    match.win = null;

    // 先广播新的棋盘状态（客户端据此刷新），再发一条「谁悔棋了」的通知用于提示音与提示语
    this._sendState(match);
    this._notify(match, { t: 'gomoku.undone', by: me, name: client.name, removed: 1, x: mv.x, y: mv.y });
  }

  /* ---------- 认输 / 退出 ---------- */
  resign(client) {
    const match = this.matches.get(this.byClient.get(client.id));
    if (!match || match.state !== 'playing') return;
    const me = match.black.id === client.id ? 1 : (match.white.id === client.id ? 2 : 0);
    if (!me) return;
    match.state = 'over';
    match.win = { p: me === 1 ? 2 : 1, line: [], id: client.id, resign: true };
    this._sendState(match);
    this._finish(match);
  }

  leave(client) {
    const id = this.byClient.get(client.id);
    if (!id) { this._sweep(client); return; }
    const match = this.matches.get(id);
    if (!match) { this.byClient.delete(client.id); this._sweep(client); return; }
    if (match.state === 'playing') {
      const me = match.black.id === client.id ? 1 : 2;
      const opp = me === 1 ? match.white : match.black;
      this.ctx.send(this._c(opp.id), { t: 'gomoku.error', msg: '对方已离开，你获胜' });
      this.ctx.send(this._c(opp.id), { t: 'gomoku.oppLeft', msg: '对方已离开对局，对局结束' });
      match.state = 'over';
    }
    for (const p of [match.black, match.white]) this.byClient.delete(p.id);
    this._destroy(id);
    this._sweep(client);
  }

  /** 清理该客户端残留的所有对局（含已结束的） */
  _sweep(client) {
    for (const [mid, m] of Array.from(this.matches)) {
      if (m.black.id === client.id || m.white.id === client.id) this._destroy(mid);
    }
  }

  onClose(client) {
    const id = this.byClient.get(client.id);
    const match = id ? this.matches.get(id) : null;
    if (match && match.state === 'playing') {
      const me = match.black.id === client.id ? 1 : 2;
      const opp = me === 1 ? match.white : match.black;
      const c = this._c(opp.id);
      if (c) {
        this.ctx.send(c, { t: 'gomoku.error', msg: '对方已掉线' });
        this.ctx.send(c, { t: 'gomoku.oppLeft', msg: '对方已掉线，对局结束' });
      }
      match.state = 'over';
    } else if (!match) {
      // 没有进行中的对局：可能有已结束但仍在回收队列里的对局
      this._sweep(client);
      return;
    }
    for (const p of [match.black, match.white]) this.byClient.delete(p.id);
    this._destroy(match.id);
  }

  _destroy(id) {
    this._clearTimer(id);
    const m = this.matches.get(id);
    if (m) {
      this.byClient.delete(m.black.id);
      this.byClient.delete(m.white.id);
    }
    this.matches.delete(id);
  }

  _clearTimer(id) {
    const t = this.pending.get(id);
    if (t) { clearTimeout(t); this.pending.delete(id); }
  }

  /**
   * 是不是正跟人下着棋（好友列表据此显示「组队中」并禁掉邀请按钮）。
   * 只算真正开局的：还在等对方接受邀请的 pending 不算"在玩"，
   * 否则刚发完邀请那几秒就没法回别人的邀请了，太硌人。
   */
  busy(client) {
    const id = client ? this.byClient.get(client.id) : null;
    const m = id ? this.matches.get(id) : null;
    if (!m || m.state !== 'playing') return null;
    return { label: '对局中', code: '' };
  }

  /* ---------- 胜负判定 ---------- */
  _findLine(board, x, y, p) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const d of dirs) {
      const line = [[x, y]];
      for (const s of [1, -1]) {
        let cx = x + d[0] * s, cy = y + d[1] * s;
        while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[cy * SIZE + cx] === p) {
          line.push([cx, cy]);
          cx += d[0] * s; cy += d[1] * s;
        }
      }
      if (line.length >= 5) {
        line.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return line;
      }
    }
    return null;
  }
}

GomokuHub.title = '五子棋';        // 游戏自己声明的显示名
GomokuHub.entry = '/gomoku/';     // 访问入口
GomokuHub.order = 20;             // 主页卡片顺序（数字小的排前面）

/** 主页卡片内容由游戏自己提供，平台只负责渲染，不认识"五子棋"这个词 */
GomokuHub.card = {
  desc: '传统五子棋规则，五子连珠即胜。支持与电脑对战，也支持邀请制联机对局。',
  tags: [
    '单人 / 联机邀请',
    '每人 1 次悔棋 · 无需对方同意',
    'IP 专属邀请码',
    '三档 AI 难度'
  ],
  art: 'card.svg'
};

/** 这个游戏自己声明的消息路由（消息类型 → Hub 方法名），主机只做装配 */
GomokuHub.routes = {
  'gomoku.register': 'register',
  'gomoku.invite': 'invite',
  'gomoku.reply': 'replyInvite',
  'gomoku.move': 'move',
  'gomoku.undo': 'undo',
  'gomoku.hover': 'hover',
  'gomoku.resign': 'resign',
  'gomoku.leave': 'leave'
};

module.exports = GomokuHub;
