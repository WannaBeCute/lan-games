/*!
 * 方块躲避 —— 关卡编辑器
 *
 * 工作流：
 *   1) 先设定关卡空间（列 × 行），点「重建关卡」才能开始编辑
 *   2) 选工具 → 在网格上画：墙体 / 出生点 / 复活点 / 终点 / 圆形障碍
 *   3) 出生点 / 复活点 / 终点都是「区域」：选好工具后按住左键拖出一个矩形，松手落成一片；
 *      紧挨着的同名区域会自动吸附成一整块（底层就是一组格子 + 连通性判定，见 dodgecore.groupCells）。
 *      出生点、终点全局各只保留一处，复活点可以有任意多块。
 *   4) 圆形障碍两种动法：路径巡逻（连着点格子加点）或圆周旋转（绕放下那一格画圆，半径自定）
 *   5) 「选择 / 查看」：左键点选、按住左键框选，选中显示半透明，右键批量删除
 *   6) 每一步改动都能撤回（Ctrl+Z）/ 恢复（Ctrl+Y）；有未保存改动时切页面 / 关网页会拦一下
 *   7) 保存前校验：只要有出生点 + 终点就能存（复活点可选）
 *
 * 关卡数据格式与游戏完全一致（同一个 dodgecore.js 规格化 + 校验），
 * 所以导出的 JSON 可以直接替换 games/dodge/shared/levels.json 里的一项。
 */
(function () {
  'use strict';

  var DC = window.DodgeCore, WB = window.WB;
  var CELL = DC.GRID_SIZE;
  var CUSTOM_KEY = 'dodge.custom.levels.v1';
  var MAX_HISTORY = 120;
  var $ = function (id) { return document.getElementById(id); };

  /* 三类设施的配色：出生点 / 终点是绿色，复活点是黄色（与游戏内保持一致） */
  var FAC = {
    spawn: { key: 'spawns', color: '#15803d', soft: 'rgba(21,128,61,.18)', glyph: '◉', label: '出生', one: true },
    checkpoint: { key: 'checkpoints', color: '#d9a205', soft: 'rgba(234,179,8,.22)', glyph: '◇', label: '复活', one: false },
    goal: { key: 'goals', color: '#22c55e', soft: 'rgba(34,197,94,.22)', glyph: '★', label: '终点', one: true }
  };

  var E = {
    level: null,            // 正在编辑的关卡（原始结构，编辑期间不做裁剪）
    tool: 'select',
    sel: [],                // 选中项：[{kind:'wall'|'spawn'|'checkpoint'|'goal', col, row} | {kind:'obstacle', id}]
    selected: null,         // 属性面板当前编辑的障碍（引用 E.level.obstacles 里的元素）
    pathEdit: false,
    pathStay: false,        // true = 「添加路径点」按钮点开的持续加点模式；false = 放新障碍时的「点第二个点自动保存」
    preview: false,
    previewWorld: null,
    hover: { col: -1, row: -1 },
    scale: 1,
    builtin: [],
    lastSolve: null,
    dirty: false,           // 有未保存的改动？
    undo: [], redo: [],     // 历史（存 JSON 快照）
    drag: null,             // 正在进行的拖拽
    band: null              // 框选矩形（像素坐标）
  };

  /* ================= 关卡库存储 ================= */
  function loadLibrary() {
    try {
      var list = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveLibrary(list) {
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch (e) { /* noop */ }
  }

  /* ================= 格子小工具 ================= */
  function cellIndex(list, col, row) {
    for (var i = 0; i < list.length; i++) if (list[i].col === col && list[i].row === row) return i;
    return -1;
  }
  function addCells(list, cells) {
    cells.forEach(function (c) { if (cellIndex(list, c.col, c.row) < 0) list.push({ col: c.col, row: c.row }); });
  }
  function removeCells(list, cells) {
    cells.forEach(function (c) { var i = cellIndex(list, c.col, c.row); if (i >= 0) list.splice(i, 1); });
  }
  function rectCells(cols, rows) {
    var out = [];
    for (var r = rows[0]; r <= rows[1]; r++) for (var c = cols[0]; c <= cols[1]; c++) out.push({ col: c, row: r });
    return out;
  }
  /** 一组格子是不是和现有设施挨着（含重叠）——「相邻的同属性自动吸附成一个整体」靠它 */
  function touches(cells, list) {
    var set = {};
    list.forEach(function (c) { set[c.col + ',' + c.row] = 1; });
    return cells.some(function (c) {
      return set[(c.col) + ',' + c.row] || set[(c.col + 1) + ',' + c.row] || set[(c.col - 1) + ',' + c.row] ||
        set[c.col + ',' + (c.row + 1)] || set[c.col + ',' + (c.row - 1)];
    });
  }
  /** 清掉这些格子上的「其它身份」：墙、别的设施 —— 一格只能是一种东西 */
  function clearOthers(cells, keepKey) {
    cells.forEach(function (c) {
      var wi = cellIndex(E.level.walls, c.col, c.row);
      if (wi >= 0) E.level.walls.splice(wi, 1);
      ['spawns', 'checkpoints', 'goals'].forEach(function (k) {
        if (k === keepKey) return;
        var i = cellIndex(E.level[k], c.col, c.row);
        if (i >= 0) E.level[k].splice(i, 1);
      });
    });
  }
  /** 障碍的「起始点」：path[0] 那一格。选中 / 拖拽障碍都只认它 —— 路径可以随便相交，不参与点击 */
  function obstacleStartAt(col, row) {
    for (var i = 0; i < E.level.obstacles.length; i++) {
      var s = E.level.obstacles[i].path[0];
      if (s && s.col === col && s.row === row) return E.level.obstacles[i];
    }
    return null;
  }
  function obstacleAtPixel(x, y) {
    for (var i = 0; i < E.level.obstacles.length; i++) {
      var o = E.level.obstacles[i];
      var pos = obstacleRenderPos(o);
      var dx = x - pos.x, dy = y - pos.y;
      var rr = DC.OBSTACLE_RADIUS + 4;          // 半径是内核固定值，不从障碍数据里读
      if (dx * dx + dy * dy <= rr * rr) return o;
    }
    return null;
  }
  /**
   * 生成一个不撞车的障碍 id。
   * 以前用 obstacles.length+1 命名，删掉中间的障碍再放新的就会和后面的撞上——
   * 撞车的两个障碍在预览里会画到同一个位置上（按 id 找运动位置），障碍一多必现。
   */
  function uniqueObstacleId() {
    var used = {};
    E.level.obstacles.forEach(function (o) { used[o.id] = 1; });
    var n = E.level.obstacles.length + 1;
    while (used['obstacle_' + n]) n++;
    return 'obstacle_' + n;
  }
  function newObstacle(col, row) {
    return {
      id: uniqueObstacleId(),
      path: [{ col: col, row: row }],
      speed: 100,
      loopMode: 'pingpong'
      // 不存 radius：半径是内核里的固定值（DC.OBSTACLE_RADIUS），存进关卡只会变成第二份真相
    };
  }

  /* ================= 历史（撤回 / 恢复） ================= */
  function pushHistory() {
    try { E.undo.push(JSON.stringify(E.level)); } catch (e) { /* noop */ }
    if (E.undo.length > MAX_HISTORY) E.undo.shift();
    E.redo.length = 0;
    setDirty(true);
    renderHistoryButtons();
  }
  function restoreFrom(json) {
    var keepId = E.selected ? E.selected.id : null;
    stopSolve(true);                 // 关卡都换了，别让上一关的机器人接着跑
    E.level = JSON.parse(json);
    E.selected = null;
    if (keepId) {
      for (var i = 0; i < E.level.obstacles.length; i++) {
        if (E.level.obstacles[i].id === keepId) { E.selected = E.level.obstacles[i]; break; }
      }
    }
    if (!E.selected) E.pathEdit = false;
    if (E.selected && E.selected.orbit) E.pathEdit = false;
    E.pathStay = false;
    E.drag = null; E.band = null; E.sel = [];
    syncSizeInputs();
    fitEditor();
    refresh();
  }
  function undo() {
    if (!E.undo.length) { WB.ui.toast('已经是第一步了，没得撤了', 'err'); return; }
    E.redo.push(JSON.stringify(E.level));
    restoreFrom(E.undo.pop());
    setStatus('已撤回一步（Ctrl+Z 可以一直退回去，Ctrl+Y 恢复）');
    WB.audio.play('click');
  }
  function redo() {
    if (!E.redo.length) { WB.ui.toast('没有可以恢复的步骤', 'err'); return; }
    E.undo.push(JSON.stringify(E.level));
    restoreFrom(E.redo.pop());
    setStatus('已恢复一步');
    WB.audio.play('click');
  }
  function renderHistoryButtons() {
    var u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = !E.undo.length;
    if (r) r.disabled = !E.redo.length;
  }
  function setDirty(v) {
    E.dirty = !!v;
    var f = $('dirtyFlag');
    if (f) f.classList.toggle('hidden', !E.dirty);
  }

  /* ================= 画布 ================= */
  function fitEditor() {
    var cv = $('edCv');
    var wrap = cv.parentNode;
    if (!E.level) return;
    var w = E.level.cols * CELL, h = E.level.rows * CELL;
    var availW = Math.max(320, wrap.clientWidth - 26);
    var availH = Math.max(320, window.innerHeight - 300);
    var scale = Math.min(availW / w, availH / h, 1.5);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cssW = Math.round(w * scale), cssH = Math.round(h * scale);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(cssW * dpr / w, 0, 0, cssH * dpr / h, 0, 0);
    E.scale = cssW / w;
  }
  window.addEventListener('resize', fitEditor);

  function roundRect(ctx, x, y, w, h, r) {
    if (!r) { ctx.beginPath(); ctx.rect(x, y, w, h); return; }   // 半径 0 = 直角
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  /** 永远是直角的方块（玩家）：标准正方形，不带圆角 */
  function squareRect(ctx, x, y, w, h) { ctx.beginPath(); ctx.rect(x, y, w, h); }

  function obstacleRenderPos(o) {
    // 测试游玩 / 预览运动 / 最优解回放：运动中的障碍位置都按「同一顺序、下标对应」取（id 可能撞车，不能拿它对号）
    // 回放**放完之后**就别再拿它那套障碍位置了：机器人和路线留着当结果，
    // 障碍回到各自的静止位置（否则编辑时会看到一堆"停在终点"的圆，很误导）
    var live = (E.test && E.test.world) ? E.test.world
      : (E.solve && !E.solve.done && E.solve.world) ? E.solve.world
        : (E.preview && E.previewWorld) ? E.previewWorld : null;
    if (live) {
      var ti = E.level.obstacles.indexOf(o);
      var to = live.obstacles[ti >= 0 ? ti : 0];
      if (to) return { x: to.x, y: to.y };
    }
    if (o.orbit) {
      var cen = DC.gridCenter(o.path[0].col, o.path[0].row);
      var a = (o.orbit.angle || 0);
      return { x: cen.x + o.orbit.radius * Math.cos(a), y: cen.y + o.orbit.radius * Math.sin(a) };
    }
    var p = o.path[0];
    return DC.gridCenter(p.col, p.row);
  }

  function draw() {
    var cv = $('edCv');
    if (!E.level) return;
    var ctx = cv.getContext('2d');
    var lv = E.level, W = lv.cols * CELL, H = lv.rows * CELL;
    ctx.clearRect(0, 0, W, H);
    // 白底（和游戏页一致）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // 网格
    ctx.strokeStyle = 'rgba(15, 23, 42, .08)';
    ctx.lineWidth = 1;
    for (var c = 1; c < lv.cols; c++) { ctx.beginPath(); ctx.moveTo(c * CELL + .5, 0); ctx.lineTo(c * CELL + .5, H); ctx.stroke(); }
    for (var r = 1; r < lv.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL + .5); ctx.lineTo(W, r * CELL + .5); ctx.stroke(); }

    // 设施（出生点 / 复活点 / 终点）—— 一块区域画成一个整体
    drawFacility(ctx, 'spawn', lv.spawns);
    drawFacility(ctx, 'checkpoint', lv.checkpoints);
    drawFacility(ctx, 'goal', lv.goals);

    // 墙
    lv.walls.forEach(function (w) {
      var cen = DC.gridCenter(w.col, w.row);
      ctx.fillStyle = '#94a3b8';
      roundRect(ctx, cen.x - CELL / 2 + 1, cen.y - CELL / 2 + 1, CELL - 2, CELL - 2, 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(15, 23, 42, .22)';
      ctx.lineWidth = 1;
      roundRect(ctx, cen.x - CELL / 2 + 1, cen.y - CELL / 2 + 1, CELL - 2, CELL - 2, 4);
      ctx.stroke();
    });

    // 障碍与路径 / 轨道
    lv.obstacles.forEach(function (o) {
      var isSel = (o === E.selected);
      if (o.orbit) {
        var cen = DC.orbitCenter(o);
        ctx.save();
        ctx.strokeStyle = isSel ? 'rgba(37,99,235,.85)' : 'rgba(168,85,247,.65)';
        ctx.lineWidth = isSel ? 3 : 2;
        ctx.setLineDash([7, 6]);
        ctx.beginPath(); ctx.arc(cen.x, cen.y, o.orbit.radius, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        // 圆心 + 半径线（圆心只是轨迹锚点，不占格子；初始位置固定在圆心正右方）
        ctx.fillStyle = 'rgba(100,116,139,.95)';
        ctx.beginPath(); ctx.arc(cen.x, cen.y, 3.5, 0, Math.PI * 2); ctx.fill();
        var cur = obstacleRenderPos(o);
        ctx.save();
        ctx.strokeStyle = 'rgba(100,116,139,.7)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(cen.x, cen.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
        ctx.restore();
        // 初始位置标记（angle=0 的落点，就在圆心正右方）
        ctx.strokeStyle = 'rgba(239,68,68,.8)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(cen.x + o.orbit.radius, cen.y, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        // 转向箭头（顺时针 / 逆时针）
        arrow(ctx, cur.x, cur.y, Math.atan2(cur.y - cen.y, cur.x - cen.x) + (o.orbit.cw ? Math.PI / 2 : -Math.PI / 2),
          'rgba(100,116,139,.9)');
        ctx.fillStyle = 'rgba(100,116,139,.95)';
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('半径 ' + o.orbit.radius + 'px · ' + (o.orbit.cw ? '顺时针' : '逆时针') +
          (o.centerSnap === 'cross' ? ' · 圆心在网格交点' : ''), cen.x, cen.y - o.orbit.radius - 8);
      } else {
        if (o.path.length > 1) {
          ctx.save();
          ctx.strokeStyle = isSel ? 'rgba(37,99,235,.9)' : 'rgba(168,85,247,.6)';
          ctx.lineWidth = isSel ? 3 : 2;
          ctx.setLineDash([9, 7]);
          ctx.beginPath();
          o.path.forEach(function (p, i) {
            var cen2 = DC.gridCenter(p.col, p.row);
            if (i === 0) ctx.moveTo(cen2.x, cen2.y); else ctx.lineTo(cen2.x, cen2.y);
          });
          ctx.stroke();
          ctx.restore();
          for (var i = 0; i < o.path.length - 1; i++) {
            var a = DC.gridCenter(o.path[i].col, o.path[i].row);
            var b = DC.gridCenter(o.path[i + 1].col, o.path[i + 1].row);
            arrow(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x),
              isSel ? 'rgba(37,99,235,.95)' : 'rgba(168,85,247,.75)');
          }
          if (o.loopMode === 'loop') {
            var last = DC.gridCenter(o.path[o.path.length - 1].col, o.path[o.path.length - 1].row);
            var first = DC.gridCenter(o.path[0].col, o.path[0].row);
            ctx.save();
            ctx.strokeStyle = 'rgba(100,116,139,.45)';
            ctx.setLineDash([4, 6]);
            ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(first.x, first.y); ctx.stroke();
            ctx.restore();
          }
        }
        o.path.forEach(function (p, i) {
          var cen2 = DC.gridCenter(p.col, p.row);
          ctx.fillStyle = i === 0 ? 'rgba(239,68,68,.95)' : 'rgba(71,85,105,.6)';
          ctx.beginPath(); ctx.arc(cen2.x, cen2.y, i === 0 ? 6 : 5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 10px Consolas, monospace';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(i + 1), cen2.x, cen2.y + .5);
        });
      }
      // 圆本身
      var pos = obstacleRenderPos(o);
      // 不发光、不反光：编辑器里看到的圆 = 游戏里看到的圆 = 判定用的圆（半径都是内核固定值）
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath(); ctx.arc(pos.x, pos.y, DC.OBSTACLE_RADIUS, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isSel ? '#2563eb' : '#b03a2e';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, DC.OBSTACLE_RADIUS - 1, 0, Math.PI * 2); ctx.stroke();
      if (isSel) {
        ctx.strokeStyle = 'rgba(37,99,235,.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(pos.x, pos.y, DC.OBSTACLE_RADIUS + 7, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // 测试游玩：把控制的小方块画上去（死了半透明、无敌期闪烁、到了画对勾）
    if (E.test && E.test.player) {
      var tp = E.test.player;
      var half = DC.PLAYER_SIZE / 2;
      ctx.save();
      if (tp.state === 'dead') ctx.globalAlpha = 0.4;
      else if (tp.invuln > 0 && Math.floor(tp.invuln * 14) % 2 === 0) ctx.globalAlpha = 0.35;
      ctx.fillStyle = tp.color;
      squareRect(ctx, tp.x - half, tp.y - half, DC.PLAYER_SIZE, DC.PLAYER_SIZE);
      ctx.fill();
      ctx.strokeStyle = 'rgba(15, 23, 42, .38)';
      ctx.lineWidth = 1.6;
      squareRect(ctx, tp.x - half + 0.8, tp.y - half + 0.8, DC.PLAYER_SIZE - 1.6, DC.PLAYER_SIZE - 1.6);
      ctx.stroke();
      if (tp.state === 'arrived') {
        ctx.strokeStyle = 'rgba(255, 255, 255, .95)';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(tp.x - 7, tp.y); ctx.lineTo(tp.x - 2, tp.y + 6); ctx.lineTo(tp.x + 8, tp.y - 6);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 最优解回放：机器人沿求解器给的落脚点走，画出走过的路线 + 当前所在位置
    if (E.solve) drawSolveBot(ctx);

    // 选中的障碍（可能框选了好几个）都套一圈高亮
    E.sel.forEach(function (u) {
      if (u.kind !== 'obstacle') return;
      lv.obstacles.forEach(function (o) {
        if (o.id !== u.id) return;
        var pos = obstacleRenderPos(o);
        ctx.save();
        ctx.strokeStyle = 'rgba(37, 99, 235, .9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.arc(pos.x, pos.y, DC.OBSTACLE_RADIUS + 6, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      });
    });

    // 选中的格子（半透明选择状态）
    var seen = {};
    E.sel.forEach(function (u) {
      if (u.kind === 'obstacle') return;
      var k = u.kind + ':' + u.col + ',' + u.row;
      if (seen[k]) return;
      seen[k] = 1;
      ctx.fillStyle = 'rgba(37, 99, 235, .30)';
      ctx.fillRect(u.col * CELL, u.row * CELL, CELL, CELL);
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.strokeRect(u.col * CELL + 1, u.row * CELL + 1, CELL - 2, CELL - 2);
    });

    // 正在拖出来的矩形（新区域）
    if (E.drag && E.drag.mode === 'rect') {
      var d = E.drag, f = FAC[d.kind];
      var c0 = Math.min(d.x0, d.x1), c1 = Math.max(d.x0, d.x1);
      var r0 = Math.min(d.y0, d.y1), r1 = Math.max(d.y0, d.y1);
      ctx.save();
      ctx.fillStyle = f.soft;
      ctx.fillRect(c0 * CELL, r0 * CELL, (c1 - c0 + 1) * CELL, (r1 - r0 + 1) * CELL);
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(c0 * CELL + 1, r0 * CELL + 1, (c1 - c0 + 1) * CELL - 2, (r1 - r0 + 1) * CELL - 2);
      ctx.restore();
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText((c1 - c0 + 1) + ' × ' + (r1 - r0 + 1) + ' 格', c0 * CELL + 2, Math.max(14, r0 * CELL - 5));
    }

    // 框选矩形
    if (E.band) {
      var bx = Math.min(E.band.x0, E.band.x1), by = Math.min(E.band.y0, E.band.y1);
      var bw = Math.abs(E.band.x1 - E.band.x0), bh = Math.abs(E.band.y1 - E.band.y0);
      ctx.save();
      ctx.fillStyle = 'rgba(37, 99, 235, .12)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.restore();
    }

    // 悬停格
    if (E.hover.col >= 0 && E.hover.col < lv.cols && E.hover.row >= 0 && E.hover.row < lv.rows && !E.preview) {
      ctx.strokeStyle = 'rgba(15, 23, 42, .45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(E.hover.col * CELL + 1, E.hover.row * CELL + 1, CELL - 2, CELL - 2);
    }
  }

  /** 画一类设施：格子填色 + 区域外轮廓（内部的边不画，看起来就是完整的一块）+ 中心图标 */
  function drawFacility(ctx, kind, cells) {
    if (!cells || !cells.length) return;
    var f = FAC[kind];
    cells.forEach(function (c) {
      ctx.fillStyle = f.soft;
      ctx.fillRect(c.col * CELL + 1, c.row * CELL + 1, CELL - 2, CELL - 2);
    });
    ctx.save();
    ctx.strokeStyle = f.color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(kind === 'spawn' ? [7, 5] : []);
    ctx.beginPath();
    DC.regionOutline(cells).forEach(function (s) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); });
    ctx.stroke();
    ctx.restore();
    DC.regions(cells).forEach(function (r) {
      ctx.fillStyle = f.color;
      ctx.font = 'bold 15px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(f.glyph, r.x, r.y - 4);
      ctx.font = '10px "Microsoft YaHei", sans-serif';
      ctx.fillText(f.label + (r.size > 1 ? ' ×' + r.size : ''), r.x, r.y + 10);
    });
  }

  function arrow(ctx, x, y, angle, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(7, 0); ctx.lineTo(-5, 5); ctx.lineTo(-5, -5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ================= 交互 ================= */
  function pointerCells(ev) {
    var cv = $('edCv');
    var rect = cv.getBoundingClientRect();
    var x = (ev.clientX - rect.left) / E.scale;
    var y = (ev.clientY - rect.top) / E.scale;
    return { x: x, y: y, col: Math.floor(x / CELL), row: Math.floor(y / CELL) };
  }
  function inBounds(p) {
    return E.level && p.col >= 0 && p.row >= 0 && p.col < E.level.cols && p.row < E.level.rows;
  }
  function clampInto(p) {
    return {
      x: p.x, y: p.y,
      col: Math.max(0, Math.min(E.level.cols - 1, p.col)),
      row: Math.max(0, Math.min(E.level.rows - 1, p.row))
    };
  }

  /* ---------- 选中项 ---------- */
  function sameUnit(a, b) { return a.kind === b.kind && a.col === b.col && a.row === b.row && a.id === b.id; }
  function isSel(unit) { return E.sel.some(function (u) { return sameUnit(u, unit); }); }
  function unitsOfRegion(kind, cells) { return cells.map(function (c) { return { kind: kind, col: c.col, row: c.row }; }); }
  /** 这个格子属于哪一类设施？返回 {kind, cells}（整个区域一起选中） */
  function facilityAt(col, row) {
    var kinds = ['spawn', 'checkpoint', 'goal'];
    for (var i = 0; i < kinds.length; i++) {
      var list = E.level[FAC[kinds[i]].key];
      if (cellIndex(list, col, row) < 0) continue;
      var regions = DC.regions(list);
      for (var r = 0; r < regions.length; r++) {
        for (var k = 0; k < regions[r].cells.length; k++) {
          var c = regions[r].cells[k];
          if (c.col === col && c.row === row) return { kind: kinds[i], cells: regions[r].cells };
        }
      }
      return { kind: kinds[i], cells: [{ col: col, row: row }] };
    }
    return null;
  }
  function unitsAtPoint(p) {
    var obstacle = obstacleStartAt(p.col, p.row) || obstacleAtPixel(p.x, p.y);
    if (obstacle) return { units: [{ kind: 'obstacle', id: obstacle.id }], obstacle: obstacle };
    var fac = facilityAt(p.col, p.row);
    if (fac) return { units: unitsOfRegion(fac.kind, fac.cells) };
    if (cellIndex(E.level.walls, p.col, p.row) >= 0) return { units: [{ kind: 'wall', col: p.col, row: p.row }] };
    return { units: [] };
  }
  function unitsInBand(band) {
    var x0 = Math.min(band.x0, band.x1), x1 = Math.max(band.x0, band.x1);
    var y0 = Math.min(band.y0, band.y1), y1 = Math.max(band.y0, band.y1);
    var c0 = Math.max(0, Math.floor(x0 / CELL)), c1 = Math.min(E.level.cols - 1, Math.floor(x1 / CELL));
    var r0 = Math.max(0, Math.floor(y0 / CELL)), r1 = Math.min(E.level.rows - 1, Math.floor(y1 / CELL));
    var out = [], seen = {};
    function push(u) {
      var k = u.kind + ':' + u.col + ',' + u.row + (u.id || '');
      if (seen[k]) return;
      seen[k] = 1; out.push(u);
    }
    E.level.walls.forEach(function (w) {
      if (w.col >= c0 && w.col <= c1 && w.row >= r0 && w.row <= r1) push({ kind: 'wall', col: w.col, row: w.row });
    });
    ['spawn', 'checkpoint', 'goal'].forEach(function (kind) {
      DC.regions(E.level[FAC[kind].key]).forEach(function (reg) {
        var hit = reg.cells.some(function (c) { return c.col >= c0 && c.col <= c1 && c.row >= r0 && c.row <= r1; });
        if (hit) unitsOfRegion(kind, reg.cells).forEach(push);      // 整块区域一起选中
      });
    });
    E.level.obstacles.forEach(function (o) {
      // 框选障碍也只认「起始点」和圆本体 —— 路径格子不算（路径可以相交，混在框里会误伤）
      var onStart = false;
      if (!o.orbit) {
        var s = o.path[0];
        onStart = s && s.col >= c0 && s.col <= c1 && s.row >= r0 && s.row <= r1;
      }
      var pos = obstacleRenderPos(o);
      var onTrack = (pos.x >= x0 && pos.x <= x1 && pos.y >= y0 && pos.y <= y1);
      if (onStart || onTrack) push({ kind: 'obstacle', id: o.id });
    });
    return out;
  }
  function syncSelectedObstacle() {
    var id = null;
    E.sel.forEach(function (u) { if (u.kind === 'obstacle') id = u.id; });
    E.selected = null;
    if (!id) return;
    for (var i = 0; i < E.level.obstacles.length; i++) {
      if (E.level.obstacles[i].id === id) { E.selected = E.level.obstacles[i]; break; }
    }
  }
  function deleteUnits(units) {
    var removed = 0, obstacleIds = {};
    units.forEach(function (u) {
      if (u.kind === 'obstacle') { obstacleIds[u.id] = 1; return; }
      var list = u.kind === 'wall' ? E.level.walls : E.level[FAC[u.kind].key];
      var i = cellIndex(list, u.col, u.row);
      if (i >= 0) { list.splice(i, 1); removed++; }
    });
    Object.keys(obstacleIds).forEach(function (id) {
      for (var i = E.level.obstacles.length - 1; i >= 0; i--) {
        if (E.level.obstacles[i].id === id) { E.level.obstacles.splice(i, 1); removed++; }
      }
    });
    E.sel = [];
    syncSelectedObstacle();
    if (!E.selected) E.pathEdit = false;
    return removed;
  }
  function deleteSelection() {
    if (!E.sel.length) return 0;
    var n = deleteUnits(E.sel.slice());
    WB.audio.play('error');
    setStatus('删掉了 ' + n + ' 项（Ctrl+Z 可以撤回）');
    refresh();
    return n;
  }

  /* ---------- 鼠标 ---------- */
  function onDown(ev) {
    if (!E.level || ev.button !== 0) return;
    if (E.test) { WB.ui.toast('测试游玩中不能编辑，先「停止测试」', 'err'); return; }
    if (E.preview) { WB.ui.toast('预览中不能编辑，先点一下「停止预览」', 'err'); return; }
    var p = pointerCells(ev);
    if (!inBounds(p)) return;

    if (E.tool === 'select') {
      E.drag = { mode: 'band', startX: p.x, startY: p.y, moved: false };
      return;
    }
    if (E.tool === 'wall') {
      var mode = cellIndex(E.level.walls, p.col, p.row) >= 0 ? 'erase' : 'create';
      pushHistory();
      E.drag = { mode: 'paint', paint: mode, done: {} };
      paintWall(p, mode);
      WB.audio.play(mode === 'create' ? 'place' : 'click');
      return;
    }
    if (E.tool === 'spawn' || E.tool === 'checkpoint' || E.tool === 'goal') {
      E.drag = { mode: 'rect', kind: E.tool, x0: p.col, y0: p.row, x1: p.col, y1: p.row, moved: false };
      draw();
      return;
    }
    if (E.tool === 'obstacle') { onObstacleDown(p, ev); return; }
  }

  function paintWall(p, mode) {
    p = clampInto(p);
    var k = p.col + ',' + p.row;
    if (E.drag.done[k]) return;
    E.drag.done[k] = 1;
    if (mode === 'create') {
      if (cellIndex(E.level.walls, p.col, p.row) < 0) {
        clearOthers([p], 'walls');
        E.level.walls.push({ col: p.col, row: p.row });
      }
    } else {
      removeCells(E.level.walls, [p]);
    }
    draw();
    renderStats();
    renderIssues();
  }

  function onObstacleDown(p, ev) {
    // 加点模式：点哪里都算加路径点 —— 路径可以相交，路径格不再可点击（删点走属性面板的 ×）
    if (E.pathEdit && E.selected && !E.selected.orbit) {
      var last = E.selected.path[E.selected.path.length - 1];
      if (!(last && last.col === p.col && last.row === p.row)) {
        pushHistory();
        E.selected.path.push({ col: p.col, row: p.row });
        WB.audio.play('click');
        if (!E.pathStay) {
          // 放新障碍的流程：初始位置 + 这个点 = 自动保存好，不进持续加点模式
          E.pathEdit = false;
          WB.ui.toast('障碍已放好（想加更多路径点：选中它 → 右侧「添加路径点」）', 'ok');
        }
        refresh();
      }
      return;
    }

    // 点起始点（或圆本体）= 选中障碍；按住不动再拖 = 整体搬家
    var exist = obstacleStartAt(p.col, p.row) || obstacleAtPixel(p.x, p.y);
    if (exist) {
      E.selected = exist;
      E.pathEdit = false;
      E.pathStay = false;
      E.sel = [{ kind: 'obstacle', id: exist.id }];
      E.drag = {
        mode: 'obMove', obstacle: exist,
        startCol: p.col, startRow: p.row, moved: false,
        origin: exist.path.map(function (pt) { return { col: pt.col, row: pt.row }; })
      };
      WB.audio.play('click');
      refresh();
      return;
    }

    // 空白处放新障碍：这一下是初始位置，等第二个点自动完成
    // 起始点必须放在空格子上 —— 点在墙 / 出生点 / 复活点 / 终点上 = 选中那个设施，不会创建障碍顶掉它
    var blocked = cellIndex(E.level.walls, p.col, p.row) >= 0 || !!facilityAt(p.col, p.row);
    if (blocked) {
      WB.audio.play('click');
      var what = facilityAt(p.col, p.row);
      if (what) {
        E.sel = unitsOfRegion(what.kind, what.cells);      // 整块区域一起选中
        E.selected = null; E.pathEdit = false; E.pathStay = false;
        setStatus('选中了「' + ({ spawn: '出生点', checkpoint: '复活点', goal: '终点' }[what.kind]) +
          '」区域 —— 障碍起始点要放在空格子上（路径点倒是可以经过任何地方）');
      } else {
        setStatus('这里是墙体：障碍起始点要放在空格子上（路径点倒是可以经过任何地方）');
      }
      refresh();
      return;
    }
    pushHistory();
    var o = newObstacle(p.col, p.row);
    E.level.obstacles.push(o);
    E.selected = o;
    E.pathEdit = true;
    E.pathStay = false;
    E.sel = [{ kind: 'obstacle', id: o.id }];
    WB.audio.play('place');
    setStatus('障碍放在 (' + p.col + ', ' + p.row + ')：再点一个格子当巡逻点就自动保存好；想让它原地不动，点属性面板「保存当前路径点」');
    refresh();
  }

  /** 按住起始点拖动：整个障碍（含路径）跟着平移；起始点被占或越界就停在原地 */
  function moveObstacleDrag(p) {
    var d = E.drag, o = d.obstacle;
    var q = clampInto(p);
    var dc = q.col - d.startCol, dr = q.row - d.startRow;
    if (!dc && !dr) return;
    var ok = d.origin.every(function (pt) {
      return pt.col + dc >= 0 && pt.col + dc < E.level.cols && pt.row + dr >= 0 && pt.row + dr < E.level.rows;
    });
    if (ok) {
      var other = obstacleStartAt(d.origin[0].col + dc, d.origin[0].row + dr);
      if (other && other !== o) ok = false;      // 起始点不能和别的障碍重叠
    }
    if (!ok) return;
    if (!d.moved) { pushHistory(); d.moved = true; }
    d.origin.forEach(function (pt, i) { o.path[i] = { col: pt.col + dc, row: pt.row + dr }; });
    draw();
  }

  function onMove(ev) {
    if (!E.level) return;
    var p = pointerCells(ev);
    if (E.drag) {
      if (E.drag.mode === 'band') {
        if (Math.abs(p.x - E.drag.startX) > 3 || Math.abs(p.y - E.drag.startY) > 3) E.drag.moved = true;
        E.band = { x0: E.drag.startX, y0: E.drag.startY, x1: p.x, y1: p.y };
        draw();
        return;
      }
      if (E.drag.mode === 'paint') { paintWall(p, E.drag.paint); return; }
      if (E.drag.mode === 'obMove') { moveObstacleDrag(p); return; }
      if (E.drag.mode === 'rect') {
        var q = clampInto(p);
        if (q.col !== E.drag.x0 || q.row !== E.drag.y0) E.drag.moved = true;
        E.drag.x1 = q.col; E.drag.y1 = q.row;
        E.hover = q;
        draw();
        return;
      }
    }
    if (p.col === E.hover.col && p.row === E.hover.row) return;
    E.hover = p;
    draw();
  }

  function onUp(ev) {
    if (!E.level || !E.drag) return;
    var d = E.drag;
    if (d.mode === 'band') {
      var band = E.band;
      E.drag = null; E.band = null;
      if (d.moved && band) {
        var list = unitsInBand(band);
        if (ev && ev.shiftKey) list.forEach(function (u) { if (!isSel(u)) E.sel.push(u); });
        else E.sel = list;
        syncSelectedObstacle();
        E.pathEdit = false;
        if (list.length) {
          WB.audio.play('click');
          setStatus('选中了 ' + list.length + ' 项 —— 右键删除，Ctrl+Z 撤回删除');
        } else setStatus('框里没东西（试试把框拉大一点）');
      } else {
        var p = pointerCells(ev);
        if (inBounds(p)) {
          var hit = unitsAtPoint(p);
          E.sel = hit.units;
          syncSelectedObstacle();
          E.pathEdit = false;
          setStatus(hit.units.length ? '选中了 1 项（右键删除；Ctrl+Z 撤回）' : '（这里没东西）');
        }
      }
      refresh();
      return;
    }
    E.drag = null;
    if (d.mode === 'paint') { refresh(); return; }
    if (d.mode === 'obMove') {
      var o = d.obstacle, moved = d.moved;
      if (moved) {
        refresh();
        setStatus('已把「' + o.id + '」整体搬到 (' + o.path[0].col + ', ' + o.path[0].row + ')，路径跟着一起平移（Ctrl+Z 可撤回）');
      }
      return;
    }
    if (d.mode === 'rect') { finishRect(d); return; }
  }

  function finishRect(d) {
    var f = FAC[d.kind];
    var c0 = Math.min(d.x0, d.x1), c1 = Math.max(d.x0, d.x1);
    var r0 = Math.min(d.y0, d.y1), r1 = Math.max(d.y0, d.y1);
    var cells = rectCells([c0, c1], [r0, r1]);
    var list = E.level[f.key];

    if (!d.moved) {
      // 单击：点在已有设施上 = 取消这一格；点空白 = 放一格
      var i = cellIndex(list, c0, r0);
      if (i >= 0) {
        pushHistory();
        list.splice(i, 1);
        WB.audio.play('error');
        setStatus('取消了一格「' + f.label + '」');
        refresh();
        return;
      }
    }
    pushHistory();
    // 相邻 / 重叠 → 并进去（自动吸附成整体）；离得远 → 出生点/终点只能有一处，整体替换
    if (f.one && list.length && !touches(cells, list)) list.length = 0;
    clearOthers(cells, f.key);
    addCells(list, cells);
    WB.audio.play('place');
    setStatus('放好了「' + f.label + '」区域：' + (c1 - c0 + 1) + ' × ' + (r1 - r0 + 1) + ' 格');
    E.sel = unitsOfRegion(d.kind, cells);
    refresh();
  }

  function onContext(ev) {
    ev.preventDefault();
    if (!E.level || E.preview) return;
    if (E.tool === 'wall') { setStatus('墙体工具里右键不删东西 —— 左键点一下墙就是拆掉它'); return; }
    if (E.sel.length) { pushHistory(); deleteSelection(); return; }
    var p = pointerCells(ev);
    if (!inBounds(p)) return;
    var hit = unitsAtPoint(p);
    if (!hit.units.length) return;
    pushHistory();
    deleteUnits(hit.units);
    WB.audio.play('error');
    setStatus('删掉了这里的东西（Ctrl+Z 可以撤回）');
    refresh();
  }

  /* ================= 面板刷新 ================= */
  function refresh() {
    renderStats();
    renderProps();
    renderIssues();
    renderPathBar();
    renderHistoryButtons();
    if (!E.preview) draw();
  }
  function afterEdit() { refresh(); }

  function renderPathBar() {
    var bar = $('pathBar');
    var show = !!(E.pathEdit && E.selected && !E.selected.orbit);
    bar.classList.toggle('hidden', !show);
    if (show) {
      $('pathInfo').textContent = '路径编辑中：『' + E.selected.id + '』已有 ' + E.selected.path.length +
        ' 个路径点 —— 继续点格子加点，再点一次已有的点可以删点';
    }
  }

  function facilityUnitStats() {
    var counts = { wall: 0, spawn: 0, checkpoint: 0, goal: 0, obstacle: 0 };
    E.sel.forEach(function (u) { counts[u.kind] = (counts[u.kind] || 0) + 1; });
    return counts;
  }

  function renderStats() {
    var lv = E.level;
    if (!lv) { $('stats').textContent = '—'; return; }
    var pts = lv.obstacles.reduce(function (n, o) { return n + o.path.length; }, 0);
    var orbits = lv.obstacles.filter(function (o) { return !!o.orbit; }).length;
    function fac(kind) {
      var cells = lv[FAC[kind].key];
      return cells.length + ' 格 / ' + DC.regions(cells).length + ' 处';
    }
    $('stats').innerHTML =
      '尺寸 <b>' + lv.cols + '×' + lv.rows + '</b><br>' +
      '墙体 <b>' + lv.walls.length + '</b><br>' +
      '出生点 <b>' + fac('spawn') + '</b><br>' +
      '复活点 <b>' + fac('checkpoint') + '</b><br>' +
      '终点 <b>' + fac('goal') + '</b><br>' +
      '圆形障碍 <b>' + lv.obstacles.length + '</b>（路径点 ' + pts + '，圆周 ' + orbits + '）';
  }

  /** 把属性面板右侧的数值（如 300 px/s）变成「可点击编辑」：点一下原位变输入框，
   *  Enter / 失焦确认（自动夹回合法范围并记一步撤销），Esc 取消 */
  function editableVal(span, opts) {
    span.classList.add('editable');
    span.title = '点击输入精确数值（Enter 确认 · Esc 取消）';
    span.onclick = function () {
      if (span._editing) return;
      span._editing = true;
      var input = document.createElement('input');
      input.type = 'number';
      input.className = 'val-input';
      input.min = opts.min; input.max = opts.max; input.step = opts.step || 1;
      input.value = opts.get();
      span.textContent = '';
      span.appendChild(input);
      input.focus(); input.select();
      var closed = false;
      function done(apply) {
        if (closed) return;
        closed = true;
        span._editing = false;
        var v = parseFloat(input.value);
        if (apply && isFinite(v)) {
          v = Math.max(opts.min, Math.min(opts.max, v));
          if (v !== opts.get()) { pushHistory(); opts.set(v); }
        }
        refresh();      // 重画面板，显示回格式化文本
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        else if (e.key === 'Escape') { e.preventDefault(); done(false); }
      });
      input.addEventListener('blur', function () { done(true); });
    };
  }

  function renderProps() {
    var box = $('propBody');
    box.textContent = '';

    if (!E.selected) {
      var counts = facilityUnitStats();
      var total = E.sel.length;
      if (total) {
        var p = document.createElement('p');
        p.className = 'dim small';
        var parts = [];
        if (counts.wall) parts.push('墙体 ' + counts.wall + ' 格');
        if (counts.spawn) parts.push('出生点 ' + counts.spawn + ' 格');
        if (counts.checkpoint) parts.push('复活点 ' + counts.checkpoint + ' 格');
        if (counts.goal) parts.push('终点 ' + counts.goal + ' 格');
        if (counts.obstacle) parts.push('圆形障碍 ' + counts.obstacle + ' 个');
        p.innerHTML = '已选中：<b>' + parts.join(' · ') + '</b><br>右键 = 批量删除；Ctrl+Z = 撤回。';
        box.appendChild(p);

        var acts = document.createElement('div');
        acts.className = 'prop-actions';
        var del = document.createElement('button');
        del.className = 'btn tiny danger';
        del.textContent = '删除选中的 ' + total + ' 项';
        del.onclick = function () { pushHistory(); deleteSelection(); };
        acts.appendChild(del);

        var clr = document.createElement('button');
        clr.className = 'btn tiny ghost';
        clr.textContent = '取消选择';
        clr.onclick = function () { E.sel = []; refresh(); };
        acts.appendChild(clr);
        box.appendChild(acts);

        var hint2 = document.createElement('p');
        hint2.className = 'dim small';
        hint2.style.marginTop = '10px';
        hint2.textContent = '提示：按住左键在画布上拖拽可以框选一片；选中整块设施时会把它的每一格都选上。';
        box.appendChild(hint2);
        return;
      }
      var p0 = document.createElement('p');
      p0.className = 'dim small';
      p0.textContent = '选中一个圆形障碍，这里可以调移动方式（路径巡逻 / 圆周旋转）、速度与路径点（半径固定，不给调）；选中墙或设施区域时这里会显示它的信息。';
      box.appendChild(p0);
      return;
    }

    var o = E.selected;

    function row(labelText, node, valText) {
      var r = document.createElement('div');
      r.className = 'prop-row';
      var l = document.createElement('label');
      l.textContent = labelText;
      r.appendChild(l);
      r.appendChild(node);
      if (valText !== undefined) {
        var v = document.createElement('span');
        v.className = 'val';
        v.textContent = valText;
        r.appendChild(v);
      }
      box.appendChild(r);
      return r;
    }

    var nameP = document.createElement('div');
    nameP.className = 'prop-row';
    nameP.innerHTML = '<label>障碍</label><b>' + o.id + '</b>';
    box.appendChild(nameP);

    // 移动方式：路径巡逻 / 圆周旋转
    var motion = document.createElement('select');
    [['path', '路径巡逻（沿着点走）'], ['orbit', '圆周旋转（绕圈）']].forEach(function (opt) {
      var op = document.createElement('option');
      op.value = opt[0]; op.textContent = opt[1];
      if ((o.orbit ? 'orbit' : 'path') === opt[0]) op.selected = true;
      motion.appendChild(op);
    });
    row('移动方式', motion);
    motion.onchange = function () {
      pushHistory();
      if (motion.value === 'orbit') {
        o.orbit = o.orbit || { radius: 80, cw: true, angle: 0 };
        o.centerSnap = o.centerSnap || 'cell';
        E.pathEdit = false;
        E.pathStay = false;
        WB.ui.toast('已改成圆周旋转：初始位置固定在圆心正右方，点圆本体可选中、按住可拖动', 'ok');
      } else {
        delete o.orbit;
      }
      refresh();
      WB.audio.play('click');
    };

    var speed = document.createElement('input');
    speed.type = 'range';
    speed.min = String(DC.SPEED_MIN); speed.max = String(DC.SPEED_MAX); speed.step = '5'; speed.value = String(o.speed);
    var speedRow = row('速度', speed);
    var speedVal = document.createElement('span');
    speedVal.className = 'val';
    speedVal.textContent = o.speed + ' px/s';
    speedRow.appendChild(speedVal);
    editableVal(speedVal, {
      min: DC.SPEED_MIN, max: DC.SPEED_MAX, step: 5,
      get: function () { return o.speed; },
      set: function (v) { o.speed = v; }
    });
    var speedPushed = false;
    speed.oninput = function () {
      if (!speedPushed) { pushHistory(); speedPushed = true; }
      o.speed = parseInt(speed.value, 10);
      speedVal.textContent = o.speed + ' px/s';
      draw();
    };

    if (o.orbit) {
      var orbR = document.createElement('input');
      orbR.type = 'range';
      orbR.min = String(DC.ORBIT_MIN); orbR.max = String(DC.ORBIT_MAX); orbR.step = '5';
      orbR.value = String(o.orbit.radius);
      var orbRow = row('旋转半径', orbR);
      var orbVal = document.createElement('span');
      orbVal.className = 'val';
      orbVal.textContent = o.orbit.radius + ' px';
      orbRow.appendChild(orbVal);
      editableVal(orbVal, {
        min: DC.ORBIT_MIN, max: DC.ORBIT_MAX, step: 5,
        get: function () { return o.orbit.radius; },
        set: function (v) { o.orbit.radius = v; }
      });
      var orbPushed = false;
      orbR.oninput = function () {
        if (!orbPushed) { pushHistory(); orbPushed = true; }
        o.orbit.radius = parseInt(orbR.value, 10);
        orbVal.textContent = o.orbit.radius + ' px';
        draw();
      };

      // 圆心对齐：格心 / 网格十字交点 —— 圆心只是轨迹锚点，不占空间，也可以落在设施上
      var snap = document.createElement('select');
      [['cell', '圆心 = 格子中心'], ['cross', '圆心 = 网格交点（十字）']].forEach(function (opt) {
        var op = document.createElement('option');
        op.value = opt[0]; op.textContent = opt[1];
        if ((o.centerSnap === 'cross' ? 'cross' : 'cell') === opt[0]) op.selected = true;
        snap.appendChild(op);
      });
      row('圆心对齐', snap);
      snap.onchange = function () { pushHistory(); o.centerSnap = snap.value; draw(); };

      var dir = document.createElement('select');
      [['cw', '顺时针 ↻'], ['ccw', '逆时针 ↺']].forEach(function (opt) {
        var op = document.createElement('option');
        op.value = opt[0]; op.textContent = opt[1];
        if ((o.orbit.cw ? 'cw' : 'ccw') === opt[0]) op.selected = true;
        dir.appendChild(op);
      });
      row('旋转方向', dir);
      dir.onchange = function () { pushHistory(); o.orbit.cw = dir.value === 'cw'; draw(); };

      // 圆的半径是内核固定值（DC.OBSTACLE_RADIUS），这里刻意不给滑块：
      // 半径一变，缝隙、判定、可通关性全都跟着变，编辑器里调它只会存出"看着能过、其实过不去"的关卡。
      var hintO = document.createElement('p');
      hintO.className = 'dim small';
      hintO.textContent = '圆心只是轨迹锚点，不占格子：可以放在出生点 / 复活点 / 终点或任何地方（选中后按住圆本体拖动即可搬家）。' +
        '初始位置固定在圆心正右方，点它就能选中。速度是「圈上的线速度」：半径越小转得越快，转一整圈用时 = 2π×半径 ÷ 速度。';
      box.appendChild(hintO);
    } else {
      var loop = document.createElement('select');
      [['pingpong', '往返（到头原路返回）'], ['loop', '循环（到头回到起点）']].forEach(function (opt) {
        var op = document.createElement('option');
        op.value = opt[0]; op.textContent = opt[1];
        if (o.loopMode === opt[0]) op.selected = true;
        loop.appendChild(op);
      });
      row('巡逻', loop);
      loop.onchange = function () { pushHistory(); o.loopMode = loop.value; draw(); };

      // 半径固定，没有可调项（原因同圆周障碍那段）
      var hint = document.createElement('p');
      hint.className = 'dim small';
      hint.textContent = o.path.length === 1
        ? '只有一个路径点 → 这是个不动的障碍。'
        : '共 ' + o.path.length + ' 个路径点，障碍按 1→2→…→' + o.path.length + ' 的顺序巡逻。';
      box.appendChild(hint);

      var list = document.createElement('div');
      list.className = 'path-list';
      o.path.forEach(function (pt, i) {
        var line = document.createElement('div');
        line.className = 'path-line';
        var t = document.createElement('span');
        t.textContent = '点 ' + (i + 1) + '：(' + pt.col + ', ' + pt.row + ')';
        line.appendChild(t);
        // 删除就是一个小 ×，没有按钮壳子
        var del = document.createElement('span');
        del.className = 'pt-del';
        del.textContent = '×';
        del.title = '删掉这个路径点';
        del.onclick = function () {
          if (o.path.length <= 1) { WB.ui.toast('至少要留 1 个路径点', 'err'); return; }
          pushHistory();
          o.path.splice(i, 1);
          WB.audio.play('click');
          refresh();
        };
        line.appendChild(del);
        list.appendChild(line);
      });
      box.appendChild(list);
    }

    var acts = document.createElement('div');
    acts.className = 'prop-actions';
    if (!o.orbit) {
      var addBtn = document.createElement('button');
      addBtn.className = 'btn tiny ' + (E.pathEdit ? 'primary' : 'ghost');
      addBtn.textContent = E.pathEdit ? '💾 保存当前路径点' : '添加路径点';
      addBtn.onclick = function () {
        if (E.pathEdit) {
          E.pathEdit = false;
          E.pathStay = false;
          WB.ui.toast('当前路径点已保存（' + o.path.length + ' 个点）', 'ok');
        } else {
          E.pathEdit = true;      // 持续加点模式：一直加到点「保存」为止
          E.pathStay = true;
          E.tool = 'obstacle';
          E.sel = [{ kind: 'obstacle', id: o.id }];
          syncToolButtons();
          setStatus('加点模式：点格子往『' + o.id + '』的路径上加路径点，加完点「保存当前路径点」');
        }
        refresh();
      };
      acts.appendChild(addBtn);
    }

    var delBtn = document.createElement('button');
    delBtn.className = 'btn tiny danger';
    delBtn.textContent = '删除这个障碍';
    delBtn.onclick = function () {
      pushHistory();
      var i = E.level.obstacles.indexOf(o);
      if (i >= 0) E.level.obstacles.splice(i, 1);
      E.selected = null;
      E.pathEdit = false;
      E.sel = [];
      WB.audio.play('error');
      refresh();
    };
    acts.appendChild(delBtn);
    box.appendChild(acts);
  }

  function renderIssues() {
    var box = $('issues');
    box.textContent = '';
    if (!E.level) return;
    var v = DC.validateLevel(E.level);
    var frag = [];
    v.errors.forEach(function (t) { frag.push('<div class="err">✖ ' + t + '</div>'); });
    v.warnings.forEach(function (t) { frag.push('<div class="warn">⚠ ' + t + '</div>'); });
    if (!v.errors.length && !v.warnings.length) frag.push('<div class="ok">✔ 校验通过，可以保存</div>');
    box.innerHTML = frag.join('');
    $('btnSave').disabled = !v.ok;
    return v;
  }

  function syncToolButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('#toolList .tool'), function (b) {
      b.classList.toggle('on', b.dataset.tool === E.tool);
    });
  }

  function syncSizeInputs() {
    if (!E.level) return;
    $('inCols').value = E.level.cols;
    $('inRows').value = E.level.rows;
    $('inName').value = E.level.name || '我的关卡';
    $('inDiff').value = String(E.level.difficulty || 1);
  }

  function setStatus(text, kind) {
    var el = $('statusLine');
    el.textContent = text || '—';
    el.style.color = kind === 'ok' ? '#15803d' : (kind === 'err' ? '#b91c1c' : '');
  }

  /* ================= 保存 / 导入 / 导出 ================= */
  function exportLevel() {
    var lv = E.level;
    lv.name = $('inName').value.trim() || '我的关卡';
    lv.difficulty = parseInt($('inDiff').value, 10) || 1;
    var usedIds = {};
    return {
      version: 1,
      id: lv.id || Date.now(),
      name: lv.name,
      difficulty: lv.difficulty,
      hint: lv.hint || '',
      cols: lv.cols,
      rows: lv.rows,
      spawns: lv.spawns.slice(),
      checkpoints: lv.checkpoints.slice(),
      goals: lv.goals.slice(),
      walls: lv.walls.slice(),
      obstacles: lv.obstacles.map(function (o, i) {
        var oid = o.id || ('obstacle_' + (i + 1));
        // 导出前兜底：万一数据里还有撞车的 id，存档前把它们排_unique_，省得读回来又叠在一起
        if (usedIds[oid]) { oid = oid + '_x' + (i + 1); }
        usedIds[oid] = 1;
        var out = {
          id: oid,
          path: o.path.map(function (p) { return { col: p.col, row: p.row }; }),
          speed: o.speed,
          loopMode: o.loopMode
          // 不导出 radius：半径是内核固定值，导出去只会变成第二份真相（读回来也会被忽略）
        };
        if (o.orbit) out.orbit = { radius: o.orbit.radius, cw: o.orbit.cw !== false, angle: o.orbit.angle || 0 };
        return out;
      })
    };
  }

  function doSave() {
    var v = DC.validateLevel(E.level);
    if (!v.ok) {
      WB.audio.play('error');
      WB.ui.toast(v.errors[0], 'err');
      setStatus('还不能保存：' + v.errors[0], 'err');
      return false;
    }
    var lv = exportLevel();
    var lib = loadLibrary();
    var i = lib.findIndex(function (x) { return String(x.id) === String(lv.id); });
    if (i >= 0) lib[i] = lv; else lib.push(lv);
    saveLibrary(lib);
    WB.audio.play('pickup');
    WB.ui.toast('已保存到关卡库：游戏 → 关卡选择里会以「自制关卡」出现', 'ok');
    setStatus('已保存（关卡 id：' + lv.id + '，名字：' + lv.name + '）', 'ok');
    setDirty(false);
    return true;
  }

  function loadIntoEditor(raw) {
    stopPreview();
    var lv = DC.normalizeLevel(raw);
    lv.id = raw.id || Date.now();
    lv.name = raw.name || lv.name;
    lv.hint = raw.hint || '';
    stopSolve(true);
    E.level = {
      version: 1, id: lv.id, name: lv.name, hint: lv.hint, difficulty: lv.difficulty,
      cols: lv.cols, rows: lv.rows,
      spawns: lv.spawns.slice(), checkpoints: lv.checkpoints.slice(), goals: lv.goals.slice(),
      walls: lv.walls.slice(),
      obstacles: lv.obstacles.map(function (o) {
        var item = { id: o.id, path: o.path.slice(), speed: o.speed, loopMode: o.loopMode };
        if (o.orbit) {
          item.orbit = { radius: o.orbit.radius, cw: o.orbit.cw !== false, angle: o.orbit.angle || 0 };
          item.centerSnap = o.centerSnap === 'cross' ? 'cross' : 'cell';
        }
        return item;
      })
    };
    E.selected = null;
    E.sel = [];
    E.pathEdit = false;
    E.hover = { col: -1, row: -1 };
    E.undo = []; E.redo = [];
    syncSizeInputs();
    $('edEmpty').classList.add('hidden');
    fitEditor();
    setDirty(false);
    refresh();
    WB.ui.toast('已载入关卡：' + E.level.name, 'ok');
  }

  /* ================= 最优解回放（检查能否通关 → 机器人走一遍） ================= */
  /**
   * 时间必须和求解器算出来的一致，所以这里**不用挂钟**计时，而是数时间片：
   * 每过一个 SOLVE_STEP（62.5ms）就把障碍推进一格时间片 —— 和内核里
   * obstacleTimeline() 的推进方式一模一样，机器人脚下的位置也就和求解时看到的一致。
   * 播完的总时间 = ticks × SOLVE_STEP = solveReachable().time。
   */
  function startSolve(res) {
    if (!res || !res.ok || !res.path || !res.path.length) return;
    stopSolve(true);
    if (E.preview) stopPreview();
    if (E.test) stopTest();
    E.solve = {
      world: DC.createWorld(DC.normalizeLevel(exportLevel())),
      path: res.path,
      ticks: res.ticks,
      time: res.time,
      tick: 0,
      acc: 0,
      raf: 0,
      last: 0,
      done: false
    };
    $('btnCheck').textContent = '⏹ 停止回放';
    var stepMs = DC.SOLVE_STEP * 1000;
    function tickFn(ts) {
      if (!E.solve) return;
      if (!E.solve.last) E.solve.last = ts;
      E.solve.acc += Math.min(250, ts - E.solve.last);   // 切标签页回来别一下跳几百片
      E.solve.last = ts;
      while (E.solve.acc >= stepMs && E.solve.tick < E.solve.ticks) {
        E.solve.acc -= stepMs;
        E.solve.tick++;
        DC.stepObstacles(E.solve.world, DC.SOLVE_STEP);
      }
      if (E.solve.tick >= E.solve.ticks) {
        E.solve.tick = E.solve.ticks;
        E.solve.done = true;
        draw();
        setStatus('✔ 机器人按最优解走完了：用时 ' + (E.solve.tick * DC.SOLVE_STEP).toFixed(2) +
          ' 秒（与计算结果一致）', 'ok');
        $('btnCheck').textContent = '🔍 检查能否通关';
        E.solve.raf = 0;
        return;
      }
      draw();
      setStatus('回放中… ' + (E.solve.tick * DC.SOLVE_STEP).toFixed(2) + ' / ' +
        E.solve.time.toFixed(2) + ' 秒（第 ' + (E.solve.tick + 1) + ' / ' + (E.solve.ticks + 1) + ' 片）');
      E.solve.raf = requestAnimationFrame(tickFn);
    }
    E.solve.raf = requestAnimationFrame(tickFn);
    draw();
  }

  function stopSolve(silent) {
    if (E.solve && E.solve.raf) cancelAnimationFrame(E.solve.raf);
    var had = !!E.solve;
    E.solve = null;
    if (had && !silent) {
      $('btnCheck').textContent = '🔍 检查能否通关';
      draw();
    }
  }

  function drawSolveBot(ctx) {
    var sp = E.solve;
    if (!sp || !sp.path.length) return;
    var f = sp.tick + Math.min(1, sp.acc / (DC.SOLVE_STEP * 1000));
    // 走过的路线
    ctx.save();
    ctx.strokeStyle = 'rgba(76,141,255,.45)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    sp.path.forEach(function (pt, i) {
      var c = DC.gridCenter(pt.col, pt.row);
      if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
    });
    ctx.stroke();
    ctx.restore();
    // 机器人本体（和游戏里一样的直角方块，不发光）
    var pos = DC.solveBotPos(sp.path, f);   // 和自检共用内核里那一份插值
    var half = DC.PLAYER_SIZE / 2;
    ctx.save();
    ctx.fillStyle = '#4c8dff';
    squareRect(ctx, pos.x - half, pos.y - half, DC.PLAYER_SIZE, DC.PLAYER_SIZE);
    ctx.fill();
    ctx.strokeStyle = 'rgba(15,23,42,.45)';
    ctx.lineWidth = 1.6;
    squareRect(ctx, pos.x - half + 0.8, pos.y - half + 0.8, DC.PLAYER_SIZE - 1.6, DC.PLAYER_SIZE - 1.6);
    ctx.stroke();
    // 头上标着当前时间片
    ctx.fillStyle = '#1d4ed8';
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText((f * DC.SOLVE_STEP).toFixed(2) + 's', pos.x, pos.y - half - 6);
    ctx.restore();
  }

  /* ================= 预览 ================= */
  var previewRaf = 0;
  function startPreview() {
    if (!E.level) { WB.ui.toast('先创建关卡', 'err'); return; }
    stopSolve(true);
    E.preview = true;
    E.previewWorld = DC.createWorld(DC.normalizeLevel(exportLevel()));
    E.sel = [];
    E.selected = null;
    E.pathEdit = false;
    $('btnPreview').textContent = '⏸ 停止预览';
    renderProps(); renderPathBar();
    var last = 0;
    function tick(ts) {
      if (!E.preview) return;
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 1 / 60;
      last = ts;
      DC.stepObstacles(E.previewWorld, dt);
      draw();
      previewRaf = requestAnimationFrame(tick);
    }
    previewRaf = requestAnimationFrame(tick);
    setStatus('预览中：障碍正按你设的路径 / 圆周动起来');
  }
  function stopPreview() {
    if (E.test) stopTest();
    if (E.solve) stopSolve(true);
    if (!E.preview) return;
    E.preview = false;
    E.previewWorld = null;
    if (previewRaf) cancelAnimationFrame(previewRaf);
    previewRaf = 0;
    $('btnPreview').textContent = '▶ 预览运动';
    draw();
    setStatus('');
  }

  /* ================= 测试游玩：就在编辑器画布上玩一把 ================= */
  var testRaf = 0, testLast = 0;
  var testKeys = {};
  function startTest() {
    if (!E.level) { WB.ui.toast('先创建关卡', 'err'); return; }
    stopSolve(true);
    var v = DC.validateLevel(E.level);
    if (!v.ok) { WB.ui.toast('先修好校验问题再测试：' + v.errors[0], 'err'); WB.audio.play('error'); return; }
    stopPreview();
    E.sel = []; E.selected = null; E.pathEdit = false; E.pathStay = false;
    var world = DC.createWorld(DC.normalizeLevel(exportLevel()));
    E.test = { world: world, player: DC.createPlayer(world, 0, '测试'), deaths: 0, arrived: false };
    testLast = 0; testKeys = {};
    $('btnTest').textContent = '⏹ 停止测试';
    WB.audio.play('spawn');
    setStatus('测试游玩中：WASD / 方向键移动，走到终点区域算到达；Esc 或「停止测试」回编辑');
    function tick(ts) {
      if (!E.test) return;
      var dt = testLast ? Math.min(0.05, (ts - testLast) / 1000) : 1 / 60;
      testLast = ts;
      var T = E.test;
      DC.stepObstacles(T.world, dt);
      var ev = DC.stepPlayer(T.world, T.player, {
        up: !!(testKeys.ArrowUp || testKeys.KeyW),
        down: !!(testKeys.ArrowDown || testKeys.KeyS),
        left: !!(testKeys.ArrowLeft || testKeys.KeyA),
        right: !!(testKeys.ArrowRight || testKeys.KeyD)
      }, dt);
      if (ev.died) { T.deaths++; WB.audio.play('kill'); }
      if (ev.checkpoint) WB.audio.play('pickup');
      if (ev.respawned) WB.audio.play('spawn');
      if (ev.arrived && !T.arrived) {
        T.arrived = true;
        WB.audio.play('win');
        setStatus('✔ 到达终点！用时 ' + T.world.time.toFixed(1) + ' 秒 · 死亡 ' + T.deaths +
          ' 次 —— Esc / 「停止测试」回编辑，改完可以再测');
      }
      draw();
      testRaf = requestAnimationFrame(tick);
    }
    testRaf = requestAnimationFrame(tick);
  }
  function stopTest() {
    if (!E.test) return;
    if (testRaf) cancelAnimationFrame(testRaf);
    testRaf = 0; testKeys = {};
    E.test = null;
    $('btnTest').textContent = '▶ 测试游玩';
    draw();
    setStatus('已退出测试游玩');
  }

  /* ================= 未保存改动提醒 ================= */
  var pendingGo = null;
  function guardUnsaved(go, what) {
    if (!E.dirty) { go(); return; }
    pendingGo = go;
    $('leaveText').innerHTML = '当前关卡「<b>' + ($('inName').value.trim() || '未命名') + '</b>」还有没保存的改动。<br>' +
      (what || '离开前') + '要先把它保存起来吗？';
    $('leaveMask').classList.remove('hidden');
  }
  function closeLeave() { $('leaveMask').classList.add('hidden'); pendingGo = null; }

  /* ================= 关卡库界面 ================= */
  function openLibrary() {
    $('libMask').classList.remove('hidden');
    renderLibrary();
    if (!E.builtin.length) {
      fetch('/dodge/shared/levels.json').then(function (r) { return r.json(); }).then(function (pack) {
        E.builtin = pack.levels || [];
        renderLibrary();
      }).catch(function () { /* 离线也能用编辑器 */ });
    }
  }
  function renderLibrary() {
    var b = $('libBuiltin');
    b.textContent = '';
    E.builtin.forEach(function (raw, i) {
      var btn = document.createElement('button');
      btn.textContent = (i + 1) + '. ' + raw.name;
      btn.onclick = function () {
        closeLibrary();
        guardUnsaved(function () { loadIntoEditor(raw); }, '载入别的关卡前');
      };
      b.appendChild(btn);
    });
    if (!E.builtin.length) b.innerHTML = '<span class="dim small">加载中…</span>';

    var mine = $('libMine');
    mine.textContent = '';
    var lib = loadLibrary();
    if (!lib.length) mine.innerHTML = '<span class="dim small">还没有保存过自制关卡</span>';
    lib.forEach(function (raw) {
      var btn = document.createElement('button');
      btn.textContent = raw.name + '（' + raw.cols + '×' + raw.rows + '）';
      btn.onclick = function () {
        closeLibrary();
        guardUnsaved(function () { loadIntoEditor(raw); }, '载入别的关卡前');
      };
      mine.appendChild(btn);

      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '删除';
      del.onclick = function () {
        var list = loadLibrary().filter(function (x) { return String(x.id) !== String(raw.id); });
        saveLibrary(list);
        renderLibrary();
        WB.ui.toast('已删除自制关卡「' + raw.name + '」');
      };
      mine.appendChild(del);
    });
  }
  function closeLibrary() { $('libMask').classList.add('hidden'); }

  /* ================= 绑定 ================= */
  function bind() {
    var cols0 = function () {
      var c = parseInt($('inCols').value, 10), r = parseInt($('inRows').value, 10);
      return [
        Math.max(DC.MIN_COLS, Math.min(DC.MAX_COLS, c || 20)),
        Math.max(DC.MIN_ROWS, Math.min(DC.MAX_ROWS, r || 15))
      ];
    };
    function doRebuild() {
      var size = cols0();
      $('inCols').value = size[0]; $('inRows').value = size[1];
      E.level = blankLevel(size[0], size[1]);
      E.selected = null;
      E.sel = [];
      E.pathEdit = false;
      E.undo = []; E.redo = [];
      stopPreview();
      $('edEmpty').classList.add('hidden');
      fitEditor();
      setDirty(false);
      refresh();
      WB.ui.toast('已创建 ' + size[0] + '×' + size[1] + ' 的空白关卡（四周自带外墙）', 'ok');
    }
    $('btnResize').onclick = function () {
      var hasContent = E.level && (E.level.spawns.length || E.level.checkpoints.length || E.level.goals.length || E.level.obstacles.length);
      if (!hasContent) { doRebuild(); return; }
      guardUnsaved(function () {
        if (!window.confirm('重建会清空当前关卡的内容，确定吗？')) return;
        doRebuild();
      }, '重建前');
    };

    $('toolList').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.tool') : null;
      if (!b) return;
      E.tool = b.dataset.tool;
      E.sel = [];
      if (E.tool !== 'obstacle') { E.pathEdit = false; E.pathStay = false; E.selected = null; }
      syncToolButtons();
      refresh();
      WB.audio.play('click');
      setStatus(toolTipText(E.tool));
    });

    var cv = $('edCv');
    cv.addEventListener('mousedown', onDown);
    cv.addEventListener('mousemove', onMove);
    cv.addEventListener('contextmenu', onContext);
    cv.addEventListener('mouseleave', function () {
      if (!E.drag) return;
      E.hover = { col: -1, row: -1 };
      draw();
    });
    // 拖拽途中鼠标划出画布也不断（砌墙 / 画区域 / 框选都要接着走）
    window.addEventListener('mousemove', function (e) {
      if (E.drag && (E.drag.mode === 'paint' || E.drag.mode === 'rect' || E.drag.mode === 'band' || E.drag.mode === 'obMove')) onMove(e);
    });
    window.addEventListener('mouseup', onUp);

    $('btnUndo').onclick = undo;
    $('btnRedo').onclick = redo;

    $('btnEndPath').onclick = function () {
      E.pathEdit = false;
      refresh();
      WB.ui.toast('已结束路径编辑');
    };
    $('btnPreview').onclick = function () { if (E.preview) stopPreview(); else startPreview(); };
    $('btnTest').onclick = function () { WB.audio.play('click'); if (E.test) stopTest(); else startTest(); };
    $('btnSave').onclick = doSave;

    $('btnCheck').onclick = function () {
      // 只有"正在放"时再点才是停止；放完了再点是重新算一遍 + 重播
      if (E.solve && !E.solve.done) { stopSolve(); setStatus('已停止回放'); return; }
      if (!E.level) { WB.ui.toast('先创建关卡', 'err'); return; }
      renderIssues();
      var v = DC.validateLevel(E.level);
      if (!v.ok) { setStatus('先修好校验问题再检查通关：' + v.errors[0], 'err'); return; }
      setStatus('正在推算…（时间展开搜索）');
      setTimeout(function () {
        var r = DC.solveReachable(DC.normalizeLevel(exportLevel()), 60);
        if (r.ok) {
          startSolve(r);      // 画布上直接走一遍给你看，走完的用时必须等于 r.time
          setStatus('✔ 这一关能通关：理论最快约 ' + r.time.toFixed(2) + ' 秒 —— 正在按最优解回放', 'ok');
        } else {
          stopSolve(true);
          setStatus('✖ 这一关过不去：' + (r.reason || '找不到安全路线'), 'err');
        }
      }, 30);
    };

    $('btnLibrary').onclick = function () { WB.audio.play('click'); openLibrary(); };
    $('libClose').onclick = closeLibrary;
    $('libMask').addEventListener('click', function (e) { if (e.target === $('libMask')) closeLibrary(); });

    // 关卡库里的「导出 / 复制 / 导入」也都要走未保存提醒
    $('btnExport').onclick = function () {
      var lv = exportLevel();
      var blob = new Blob([JSON.stringify(lv, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'dodge-level-' + (lv.name || 'level') + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      WB.ui.toast('已导出 .json 文件');
    };
    $('btnCopyJson').onclick = function () {
      var text = JSON.stringify(exportLevel(), null, 2);
      var done = function () { WB.ui.toast('关卡 JSON 已复制', 'ok'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else { $('inJson').value = text; WB.ui.toast('已填到下面的文本框里，手动复制吧'); }
    };
    $('btnImportText').onclick = function () {
      try {
        var raw = JSON.parse($('inJson').value);
        var lv = DC.normalizeLevel(raw);
        var v = DC.validateLevel(lv);
        if (!v.ok) { WB.ui.toast('这份关卡有问题：' + v.errors[0], 'err'); return; }
        closeLibrary();
        guardUnsaved(function () { loadIntoEditor(raw); }, '载入别的关卡前');
      } catch (e) {
        WB.ui.toast('JSON 解析失败：' + e.message, 'err');
      }
    };
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var raw = JSON.parse(reader.result);
          closeLibrary();
          guardUnsaved(function () { loadIntoEditor(raw); }, '载入别的关卡前');
        } catch (err) { WB.ui.toast('文件解析失败：' + err.message, 'err'); }
      };
      reader.readAsText(f);
    });

    $('btnImport').onclick = function () {
      $('libMask').classList.remove('hidden');
      renderLibrary();
      $('inJson').focus();
    };
    $('btnHelp').onclick = function () { $('helpMask').classList.remove('hidden'); };
    $('helpClose').onclick = function () { $('helpMask').classList.add('hidden'); };
    $('helpMask').addEventListener('click', function (e) { if (e.target === $('helpMask')) $('helpMask').classList.add('hidden'); });

    // 未保存改动：离开前的三选一
    $('leaveClose').onclick = closeLeave;
    $('leaveCancel').onclick = closeLeave;
    $('leaveMask').addEventListener('click', function (e) { if (e.target === $('leaveMask')) closeLeave(); });
    $('leaveSave').onclick = function () {
      var go = pendingGo;
      if (!doSave()) return;          // 校验没过就不放人走
      closeLeave();
      if (go) go();
    };
    $('leaveDiscard').onclick = function () {
      var go = pendingGo;
      closeLeave();
      if (go) go();
    };

    // 「返回主页 / 去玩游戏」：有未保存改动先问一句
    [$('btnHome'), $('btnGoPlay')].forEach(function (btn) {
      if (!btn) return;
      btn.onclick = function (e) {
        e.preventDefault();
        var url = btn.id === 'btnGoPlay' ? '/dodge/' : '/';
        WB.audio.play('click');
        guardUnsaved(function () { location.href = url; }, btn.dataset.leave + '前');
      };
    });

    $('btnClearObstacles').onclick = function () {
      if (!E.level) return;
      pushHistory();
      E.level.obstacles = [];
      E.selected = null; E.sel = []; E.pathEdit = false;
      refresh();
      WB.ui.toast('已清空所有障碍（Ctrl+Z 可以撤回）');
    };
    $('btnClearAll').onclick = function () {
      if (!E.level) return;
      if (!window.confirm('清空墙、出生点、复活点、终点、障碍（尺寸保留）？')) return;
      pushHistory();
      E.level.walls = DC.createLevel(E.level.cols, E.level.rows).walls;   // 只留外墙
      E.level.spawns = []; E.level.checkpoints = []; E.level.goals = []; E.level.obstacles = [];
      E.selected = null; E.sel = []; E.pathEdit = false;
      refresh();
      WB.ui.toast('已清空关卡内容（Ctrl+Z 可以撤回）');
    };

    window.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      var mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
      if (typing) return;
      // 空格 = 切换「预览运动 / 停止预览」
      if (e.code === 'Space') {
        e.preventDefault();
        if (E.preview) stopPreview(); else startPreview();
        return;
      }
      if (e.key === 'Escape') {
        closeLibrary();
        closeLeave();
        $('helpMask').classList.add('hidden');
        if (E.test) { stopTest(); }
        else {
          if (E.pathEdit) { E.pathEdit = false; E.pathStay = false; refresh(); }
          if (E.sel.length) { E.sel = []; refresh(); }
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && E.level) {
        if (E.sel.length) { pushHistory(); deleteSelection(); }
        else if (E.selected) {
          pushHistory();
          var i = E.level.obstacles.indexOf(E.selected);
          if (i >= 0) E.level.obstacles.splice(i, 1);
          E.selected = null; E.pathEdit = false;
          refresh();
        }
      }
    });

    // 测试游玩的键盘输入（WASD / 方向键）
    window.addEventListener('keydown', function (e) {
      if (!E.test) return;
      testKeys[e.code] = true;
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { if (E.test) testKeys[e.code] = false; });
    window.addEventListener('blur', function () { testKeys = {}; });

    // 关网页时也提醒一下
    window.addEventListener('beforeunload', function (e) {
      if (!E.dirty) return undefined;
      e.preventDefault();
      e.returnValue = '当前关卡还有没保存的改动';
      return e.returnValue;
    });
  }

  function toolTipText(tool) {
    if (tool === 'wall') return '墙体：点空白处砌墙、点已有墙拆掉，按住左键拖可以连着砌 / 连着拆';
    if (tool === 'spawn') return '出生点（绿）：按住左键拖出一个矩形区域；全局只保留一处';
    if (tool === 'checkpoint') return '复活点（黄）：按住左键拖出一个矩形区域；可以放很多处，相邻的会自动连成一块';
    if (tool === 'goal') return '终点（绿）：按住左键拖出一个矩形区域；走进区域里任意一格都算到达，全局只保留一处';
    if (tool === 'obstacle') return '圆形障碍：点空格放初始位置，再点一下定巡逻点自动保存好；点起始点（红点）选中，按住拖动整体搬家；路径可以相交，起始点不能重复';
    return '选择 / 查看：左键点选、按住左键框选，右键删除；点障碍可进入它的属性';
  }

  /* ================= 启动 ================= */
  function blankLevel(cols, rows) {
    var lv = DC.createLevel(cols, rows);      // 自带一圈外墙
    lv.spawns = [];
    lv.checkpoints = [];
    lv.goals = [];
    lv.obstacles = [];
    lv.name = $('inName').value.trim() || '我的关卡';
    lv.difficulty = parseInt($('inDiff').value, 10) || 1;
    lv.id = Date.now();
    return lv;
  }

  /** 平台通用：好友 + 左下角聊天控件（编辑器页面也常驻，方便边做关边聊） */
  function bootPlatformChat() {
    if (!WB.Net || !WB.Chat) return;
    try {
      var net = new WB.Net();
      if (WB.Friends) WB.Friends.boot(net);
      WB.Chat.boot(net);
      net.connect();
    } catch (e) { /* 编辑器本身不依赖网络，连不上也不影响做关卡 */ }
  }

  function boot() {
    bind();
    bootPlatformChat();
    syncToolButtons();
    // 默认给一个示例关卡，省得用户先点"重建"才能看到东西
    E.level = blankLevel(20, 15);
    // 出生点故意画成 2×2 的区域，顺便演示"区域"这个概念
    E.level.spawns = [{ col: 1, row: 6 }, { col: 2, row: 6 }, { col: 1, row: 7 }, { col: 2, row: 7 }];
    E.level.checkpoints = [{ col: 5, row: 7 }, { col: 6, row: 7 }];
    E.level.goals = [{ col: 18, row: 7 }];
    var o = newObstacle(10, 3);
    o.path = [{ col: 10, row: 3 }, { col: 10, row: 11 }];
    E.level.obstacles = [o];
    $('edEmpty').classList.add('hidden');
    syncSizeInputs();
    fitEditor();
    setDirty(false);
    refresh();
    setStatus('示例关卡已就绪：绿色是出生点 / 终点，黄色是复活点，红色是圆形障碍。' +
      '「选择 / 查看」里左键框选、右键删除，改错了按 Ctrl+Z 撤回。');
  }

  boot();
  window.__EDITOR_DEBUG = {
    E: E, exportLevel: exportLevel, loadIntoEditor: loadIntoEditor,
    undo: undo, redo: redo, pushHistory: pushHistory, refresh: refresh,
    regions: DC.regions, unitsInBand: unitsInBand
  };
})();
