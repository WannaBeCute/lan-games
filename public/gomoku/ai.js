/*!
 * 五子棋 AI —— 基于棋型窗口评分（攻守兼备），困难档加入一步前瞻
 * 用法： GomokuAI.think(board, size, me, level) → {x, y}
 */
(function (root) {
  'use strict';

  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  var WIN = 5;
  var S1 = 1, S2 = 14, S3 = 260, S4 = 6000, S5 = 2000000;
  var SCORE = [0, S1, S2, S3, S4, S5];

  function inb(n, x, y) { return x >= 0 && y >= 0 && x < n && y < n; }

  /**
   * 评估把 p 的子下在 (x,y) 的价值（窗口法）
   * 返回 { total, threats } threats = 形成活三/冲四的方向数
   */
  function evalPoint(board, size, x, y, p) {
    var total = 0, threats = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var dirSum = 0, dirBest = 0;
      for (var s = 0; s < WIN; s++) {
        var cx = x - s * dx, cy = y - s * dy;
        var ex = cx + (WIN - 1) * dx, ey = cy + (WIN - 1) * dy;
        if (!inb(size, cx, cy) || !inb(size, ex, ey)) continue;
        var mine = 1, ok = true;
        for (var k = 1; k < WIN; k++) {
          var v = board[(cy + k * dy) * size + (cx + k * dx)];
          if (v === p) mine++;
          else if (v !== 0) { ok = false; break; }
        }
        if (!ok) continue;
        dirSum += SCORE[mine];
        if (mine > dirBest) dirBest = mine;
      }
      total += dirSum;
      if (dirBest >= 3) threats++;
    }
    if (threats >= 2 && total < S4) total *= 3.2;   // 双威胁加成
    return { total: total, threats: threats };
  }

  function hasNeighbor(board, size, x, y, radius) {
    for (var dy = -radius; dy <= radius; dy++) {
      for (var dx = -radius; dx <= radius; dx++) {
        var nx = x + dx, ny = y + dy;
        if (!inb(size, nx, ny)) continue;
        if (board[ny * size + nx] !== 0) return true;
      }
    }
    return false;
  }

  function collect(board, size, radius) {
    var out = [], n = size * size;
    for (var i = 0; i < n; i++) {
      if (board[i] !== 0) continue;
      var x = i % size, y = (i - x) / size;
      if (hasNeighbor(board, size, x, y, radius)) out.push({ x: x, y: y });
    }
    return out;
  }

  /** 对某一方的最佳落点评分（只用于前瞻，不做完整排序） */
  function bestOf(board, size, p, limit) {
    var cands = collect(board, size, 2);
    var best = null, bv = -1;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var off = evalPoint(board, size, c.x, c.y, p).total;
      var def = evalPoint(board, size, c.x, c.y, p === 1 ? 2 : 1).total;
      var v = off * 1.1 + def;
      if (v > bv) { bv = v; best = { x: c.x, y: c.y, score: v }; }
    }
    return best;
  }

  function think(board, size, me, level) {
    var opp = me === 1 ? 2 : 1;
    var empty = true;
    for (var i = 0; i < board.length; i++) if (board[i] !== 0) { empty = false; break; }
    var mid = Math.floor(size / 2);
    if (empty) return { x: mid, y: mid };

    var radius = level === 0 ? 1 : 2;
    var cands = collect(board, size, radius);
    if (!cands.length) return { x: mid, y: mid };

    var scored = [];
    for (var k = 0; k < cands.length; k++) {
      var c = cands[k];
      var off = evalPoint(board, size, c.x, c.y, me);
      var def = evalPoint(board, size, c.x, c.y, opp);
      var score = off.total * 1.1 + def.total;
      scored.push({ x: c.x, y: c.y, score: score, off: off.total, def: def.total });
    }
    scored.sort(function (a, b) { return b.score - a.score; });

    // 直接取胜
    if (scored[0].off >= S5) return { x: scored[0].x, y: scored[0].y };
    // 拦截对手五连
    for (var m = 0; m < scored.length; m++) {
      if (scored[m].def >= S5) return { x: scored[m].x, y: scored[m].y };
    }

    if (level === 0) {
      // 简单：带噪声，从靠前的候选里随机
      var pool = scored.slice(0, Math.min(6, scored.length));
      for (var p2 = 0; p2 < pool.length; p2++) pool[p2].score *= 0.55 + Math.random() * 0.9;
      pool.sort(function (a, b) { return b.score - a.score; });
      return { x: pool[0].x, y: pool[0].y };
    }

    if (level === 1) {
      var top3 = scored.slice(0, Math.min(3, scored.length));
      if (top3.length > 1 && top3[0].score < S3) {
        var pick = top3[Math.floor(Math.random() * top3.length)];
        return { x: pick.x, y: pick.y };
      }
      return { x: scored[0].x, y: scored[0].y };
    }

    // 困难：对前 8 个候选做一步前瞻，避免只顾进攻被反杀
    var top = scored.slice(0, Math.min(8, scored.length));
    var best = top[0], bestV = -Infinity;
    for (var t = 0; t < top.length; t++) {
      var cand = top[t];
      board[cand.y * size + cand.x] = me;
      var reply = bestOf(board, size, opp, 6);
      board[cand.y * size + cand.x] = 0;
      var value = cand.score - (reply ? reply.score * 1.05 : 0);
      if (value > bestV) { bestV = value; best = cand; }
    }
    return { x: best.x, y: best.y };
  }

  root.GomokuAI = { think: think, evalPoint: evalPoint, SIZE: 15 };
})(window);
