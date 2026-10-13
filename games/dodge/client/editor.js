/*!
 * 方块躲避 —— 关卡编辑器
 *
 * 工作流（与需求文档一致）：
 *   1) 先设定关卡空间（列 × 行），点「重建关卡」才能开始编辑
 *   2) 选工具 → 在网格上点：墙体 / 出生点 / 复活点 / 终点 / 圆形障碍
 *   3) 圆形障碍放下后自动进入「路径编辑」：依次点格子加路径点，点路径点可删，右键删整个障碍
 *   4) 属性面板调速度 / 往返循环 / 半径；顶部可预览路径
 *   5) 保存前校验：至少一个出生点 + 一个复活点，否则不让保存
 *   6) 保存到本机关卡库（游戏里会作为「自制关卡」出现），也能导出 / 导入 JSON
 *
 * 关卡数据格式与游戏完全一致（同一个 dodgecore.js 规格化 + 校验），
 * 所以导出的 JSON 可以直接替换 games/dodge/shared/levels.json 里的一项。
 */
(function () {
  'use strict';

  var DC = window.DodgeCore, WB = window.WB;
  var CELL = DC.GRID_SIZE;
  var CUSTOM_KEY = 'dodge.custom.levels.v1';
  var $ = function (id) { return document.getElementById(id); };

  var E = {
    level: null,            // 正在编辑的关卡（原始结构，编辑期间不做裁剪）
    tool: 'select',
    selected: null,         // 选中的障碍对象（引用 E.level.obstacles 里的元素）
    pathEdit: false,
    preview: false,
    previewWorld: null,
    hover: { col: -1, row: -1 },
    scale: 1,
    builtin: [],
    lastSolve: null
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

  /* ================= 编辑操作 ================= */
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

  function has(list, col, row) {
    for (var i = 0; i < list.length; i++) if (list[i].col === col && list[i].row === row) return i;
    return -1;
  }
  function toggleIn(list, col, row) {
    var i = has(list, col, row);
    if (i >= 0) { list.splice(i, 1); return false; }
    list.push({ col: col, row: row });
    return true;
  }
  function removeFromOthers(kinds, col, row) {
    kinds.forEach(function (k) {
      var i = has(E.level[k], col, row);
      if (i >= 0) E.level[k].splice(i, 1);
    });
  }
  function obstacleAt(col, row) {
    for (var i = 0; i < E.level.obstacles.length; i++) {
      var o = E.level.obstacles[i];
      if (o.path[0] && o.path[0].col === col && o.path[0].row === row) return o;
      for (var k = 1; k < o.path.length; k++) if (o.path[k].col === col && o.path[k].row === row) return o;
    }
    return null;
  }
  function newObstacle(col, row) {
    return {
      id: 'obstacle_' + (E.level.obstacles.length + 1),
      path: [{ col: col, row: row }],
      speed: 100,
      loopMode: 'pingpong',
      radius: 18
    };
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
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw() {
    var cv = $('edCv');
    if (!E.level) return;
    var ctx = cv.getContext('2d');
    var lv = E.level, W = lv.cols * CELL, H = lv.rows * CELL;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b0f16';
    ctx.fillRect(0, 0, W, H);

    // 网格
    ctx.strokeStyle = 'rgba(120, 150, 200, .12)';
    ctx.lineWidth = 1;
    for (var c = 1; c < lv.cols; c++) { ctx.beginPath(); ctx.moveTo(c * CELL + .5, 0); ctx.lineTo(c * CELL + .5, H); ctx.stroke(); }
    for (var r = 1; r < lv.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL + .5); ctx.lineTo(W, r * CELL + .5); ctx.stroke(); }

    // 墙
    lv.walls.forEach(function (w) {
      var cen = DC.gridCenter(w.col, w.row);
      ctx.fillStyle = '#2b3648';
      roundRect(ctx, cen.x - CELL / 2 + 1, cen.y - CELL / 2 + 1, CELL - 2, CELL - 2, 4);
      ctx.fill();
    });

    // 出生点 / 复活点 / 终点
    lv.spawns.forEach(function (s) { marker(ctx, s, 'rgba(76,141,255,.85)', '◉', '出生'); });
    lv.checkpoints.forEach(function (s) { marker(ctx, s, 'rgba(245,165,36,.9)', '◇', '复活'); });
    lv.goals.forEach(function (s) { marker(ctx, s, 'rgba(47,211,155,.95)', '★', '终点'); });

    // 障碍与路径
    lv.obstacles.forEach(function (o) {
      var isSel = (o === E.selected);
      // 路径虚线
      if (o.path.length > 1) {
        ctx.save();
        ctx.strokeStyle = isSel ? 'rgba(76,141,255,.9)' : 'rgba(200,93,255,.55)';
        ctx.lineWidth = isSel ? 3 : 2;
        ctx.setLineDash([9, 7]);
        ctx.beginPath();
        o.path.forEach(function (p, i) {
          var cen = DC.gridCenter(p.col, p.row);
          if (i === 0) ctx.moveTo(cen.x, cen.y); else ctx.lineTo(cen.x, cen.y);
        });
        ctx.stroke();
        ctx.restore();
        // 方向箭头
        for (var i = 0; i < o.path.length - 1; i++) {
          var a = DC.gridCenter(o.path[i].col, o.path[i].row);
          var b = DC.gridCenter(o.path[i + 1].col, o.path[i + 1].row);
          arrow(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x),
            isSel ? 'rgba(140,180,255,.95)' : 'rgba(200,93,255,.7)');
        }
        // 返程提示
        if (o.loopMode === 'loop') {
          var last = DC.gridCenter(o.path[o.path.length - 1].col, o.path[o.path.length - 1].row);
          var first = DC.gridCenter(o.path[0].col, o.path[0].row);
          ctx.save();
          ctx.strokeStyle = 'rgba(120,150,200,.35)';
          ctx.setLineDash([4, 6]);
          ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(first.x, first.y); ctx.stroke();
          ctx.restore();
        }
      }
      // 路径点
      o.path.forEach(function (p, i) {
        var cen = DC.gridCenter(p.col, p.row);
        ctx.fillStyle = i === 0 ? 'rgba(255,140,120,.95)' : 'rgba(255,255,255,.55)';
        ctx.beginPath(); ctx.arc(cen.x, cen.y, i === 0 ? 6 : 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.font = 'bold 10px Consolas, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), cen.x, cen.y + .5);
      });
      // 圆
      var pos = obstacleRenderPos(o);
      ctx.save();
      if (isSel) { ctx.shadowColor = 'rgba(76,141,255,.9)'; ctx.shadowBlur = 18; }
      else { ctx.shadowColor = 'rgba(231,76,60,.8)'; ctx.shadowBlur = 10; }
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath(); ctx.arc(pos.x, pos.y, o.radius, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = isSel ? '#7db0ff' : '#8e2b21';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, o.radius - 1, 0, Math.PI * 2); ctx.stroke();
      if (isSel) {
        ctx.strokeStyle = 'rgba(76,141,255,.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(pos.x, pos.y, o.radius + 7, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // 悬停高亮
    if (E.hover.col >= 0 && E.hover.col < lv.cols && E.hover.row >= 0 && E.hover.row < lv.rows) {
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.lineWidth = 2;
      ctx.strokeRect(E.hover.col * CELL + 1, E.hover.row * CELL + 1, CELL - 2, CELL - 2);
    }
  }

  function obstacleRenderPos(o) {
    if (E.preview && E.previewWorld) {
      for (var i = 0; i < E.previewWorld.obstacles.length; i++) {
        var po = E.previewWorld.obstacles[i];
        if (po.id === o.id) return { x: po.x, y: po.y };
      }
    }
    var p = o.path[0];
    return DC.gridCenter(p.col, p.row);
  }

  function marker(ctx, cell, color, glyph, label) {
    var cen = DC.gridCenter(cell.col, cell.row);
    ctx.save();
    ctx.fillStyle = color.replace(/[\d.]+\)$/, '0.16)');
    ctx.fillRect(cen.x - CELL / 2 + 2, cen.y - CELL / 2 + 2, CELL - 4, CELL - 4);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(cen.x - CELL / 2 + 2, cen.y - CELL / 2 + 2, CELL - 4, CELL - 4);
    ctx.fillStyle = color;
    ctx.font = 'bold 15px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, cen.x, cen.y - 2);
    ctx.font = '9px "Microsoft YaHei", sans-serif';
    ctx.fillText(label, cen.x, cen.y + 12);
    ctx.restore();
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
  function canvasCell(ev) {
    var cv = $('edCv');
    var rect = cv.getBoundingClientRect();
    var x = (ev.clientX - rect.left) / E.scale;
    var y = (ev.clientY - rect.top) / E.scale;
    return DC.pixelToGrid(x, y);
  }

  function onCanvasClick(ev) {
    if (!E.level) return;
    var p = canvasCell(ev);
    if (p.col < 0 || p.row < 0 || p.col >= E.level.cols || p.row >= E.level.rows) return;
    var lv = E.level;

    if (E.tool === 'select') {
      var ob = obstacleAt(p.col, p.row);
      E.selected = ob;
      E.pathEdit = false;
      if (E.selected) WB.audio.play('click');
      afterEdit();
      return;
    }

    if (E.tool === 'wall') {
      removeFromOthers(['spawns', 'checkpoints', 'goals'], p.col, p.row);
      toggleIn(lv.walls, p.col, p.row);
      WB.audio.play('place');
      afterEdit();
      return;
    }

    if (E.tool === 'spawn' || E.tool === 'checkpoint' || E.tool === 'goal') {
      var key = E.tool === 'spawn' ? 'spawns' : (E.tool === 'checkpoint' ? 'checkpoints' : 'goals');
      // 一个格子只能是一种标记：先清掉这个格子上的其它标记和墙
      removeFromOthers(['spawns', 'checkpoints', 'goals'],
        p.col, p.row);
      var wi = has(lv.walls, p.col, p.row);
      if (wi >= 0) lv.walls.splice(wi, 1);
      toggleIn(lv[key], p.col, p.row);
      WB.audio.play('place');
      afterEdit();
      return;
    }

    if (E.tool === 'obstacle') {
      var exist = obstacleAt(p.col, p.row);
      if (exist) {                     // 点到已有障碍 → 选中并进入路径编辑
        E.selected = exist;
        E.pathEdit = true;
        WB.audio.play('click');
        afterEdit();
        return;
      }
      if (E.pathEdit && E.selected) {  // 路径编辑中 → 追加路径点
        var last = E.selected.path[E.selected.path.length - 1];
        if (last && last.col === p.col && last.row === p.row) return;   // 别连着放同一个点
        E.selected.path.push({ col: p.col, row: p.row });
        WB.audio.play('click');
        afterEdit();
        return;
      }
      // 新建障碍
      var o = newObstacle(p.col, p.row);
      lv.obstacles.push(o);
      E.selected = o;
      E.pathEdit = true;
      WB.audio.play('place');
      afterEdit();
    }
  }

  function onCanvasContext(ev) {
    ev.preventDefault();
    if (!E.level) return;
    var p = canvasCell(ev);
    var ob = obstacleAt(p.col, p.row);
    if (ob) {
      var i = E.level.obstacles.indexOf(ob);
      if (i >= 0) E.level.obstacles.splice(i, 1);
      if (E.selected === ob) { E.selected = null; E.pathEdit = false; }
      WB.audio.play('error');
      WB.ui.toast('已删除该障碍');
      afterEdit();
      return;
    }
    if (E.level.goals.length || E.level.spawns.length) {
      // 空白处右键：什么也不做，避免误删
    }
  }

  function onCanvasMove(ev) {
    if (!E.level) return;
    var p = canvasCell(ev);
    if (p.col === E.hover.col && p.row === E.hover.row) return;
    E.hover = p;
    draw();
  }

  /* ================= 面板刷新 ================= */
  function afterEdit() {
    renderStats();
    renderProps();
    renderIssues();
    renderPathBar();
    if (!E.preview) { draw(); }
  }

  function renderPathBar() {
    var bar = $('pathBar');
    bar.classList.toggle('hidden', !(E.pathEdit && E.selected));
    if (E.pathEdit && E.selected) {
      $('pathInfo').textContent = '路径编辑中：『' + E.selected.id + '』已有 ' + E.selected.path.length +
        ' 个路径点 —— 继续点格子加点，点路径上的小圆点可以删点';
    }
  }

  function renderStats() {
    var lv = E.level;
    if (!lv) { $('stats').textContent = '—'; return; }
    var pts = lv.obstacles.reduce(function (n, o) { return n + o.path.length; }, 0);
    $('stats').innerHTML =
      '尺寸 <b>' + lv.cols + '×' + lv.rows + '</b><br>' +
      '墙体 <b>' + lv.walls.length + '</b><br>' +
      '出生点 <b>' + lv.spawns.length + '</b> · 复活点 <b>' + lv.checkpoints.length + '</b><br>' +
      '终点 <b>' + lv.goals.length + '</b><br>' +
      '圆形障碍 <b>' + lv.obstacles.length + '</b>（路径点共 ' + pts + '）';
  }

  function renderProps() {
    var box = $('propBody');
    box.textContent = '';
    if (!E.selected) {
      var p = document.createElement('p');
      p.className = 'dim small';
      p.textContent = '选中一个圆形障碍后，这里可以调速度、往返/循环、半径，并编辑巡逻路径。';
      box.appendChild(p);
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

    var speed = document.createElement('input');
    speed.type = 'range'; speed.min = '20'; speed.max = '300'; speed.step = '5'; speed.value = String(o.speed);
    var speedVal = document.createElement('span');
    var speedRow = row('速度', speed);
    speedVal.className = 'val';
    speedVal.textContent = o.speed + ' px/s';
    speedRow.appendChild(speedVal);
    speed.oninput = function () {
      o.speed = parseInt(speed.value, 10);
      speedVal.textContent = o.speed + ' px/s';
      draw();
    };

    var loop = document.createElement('select');
    [['pingpong', '往返（到头原路返回）'], ['loop', '循环（到头回到起点）']].forEach(function (opt) {
      var op = document.createElement('option');
      op.value = opt[0]; op.textContent = opt[1];
      if (o.loopMode === opt[0]) op.selected = true;
      loop.appendChild(op);
    });
    row('巡逻', loop);
    loop.onchange = function () { o.loopMode = loop.value; draw(); };

    var radius = document.createElement('input');
    radius.type = 'range'; radius.min = '6'; radius.max = '18'; radius.step = '1'; radius.value = String(o.radius);
    var radiusVal = document.createElement('span');
    var radiusRow = row('半径', radius);
    radiusVal.className = 'val';
    radiusVal.textContent = o.radius + ' px';
    radiusRow.appendChild(radiusVal);
    radius.oninput = function () {
      o.radius = parseInt(radius.value, 10);
      radiusVal.textContent = o.radius + ' px';
      draw();
    };

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
      line.style.display = 'flex';
      line.style.alignItems = 'center';
      line.style.gap = '8px';
      var t = document.createElement('span');
      t.textContent = '点 ' + (i + 1) + '：(' + pt.col + ', ' + pt.row + ')';
      line.appendChild(t);
      var del = document.createElement('button');
      del.className = 'btn tiny ghost';
      del.textContent = '删';
      del.onclick = function () {
        if (o.path.length <= 1) { WB.ui.toast('至少要留 1 个路径点', 'err'); return; }
        o.path.splice(i, 1);
        WB.audio.play('click');
        afterEdit();
      };
      line.appendChild(del);
      list.appendChild(line);
    });
    box.appendChild(list);

    var acts = document.createElement('div');
    acts.className = 'prop-actions';
    var addBtn = document.createElement('button');
    addBtn.className = 'btn tiny ' + (E.pathEdit ? 'primary' : 'ghost');
    addBtn.textContent = (E.pathEdit ? '✔ 正在加路径点' : '继续加路径点');
    addBtn.onclick = function () {
      E.pathEdit = true;
      E.tool = 'obstacle';
      syncToolButtons();
      afterEdit();
    };
    acts.appendChild(addBtn);

    var delBtn = document.createElement('button');
    delBtn.className = 'btn tiny danger';
    delBtn.textContent = '删除这个障碍';
    delBtn.onclick = function () {
      var i = E.level.obstacles.indexOf(o);
      if (i >= 0) E.level.obstacles.splice(i, 1);
      E.selected = null;
      E.pathEdit = false;
      WB.audio.play('error');
      afterEdit();
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

  function setStatus(text, kind) {
    var el = $('statusLine');
    el.textContent = text || '—';
    el.style.color = kind === 'ok' ? '#8ff0cd' : (kind === 'err' ? '#ff9ba4' : '');
  }

  /* ================= 保存 / 导入 / 导出 ================= */
  function exportLevel() {
    var lv = E.level;
    lv.name = $('inName').value.trim() || '我的关卡';
    lv.difficulty = parseInt($('inDiff').value, 10) || 1;
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
        return {
          id: o.id || ('obstacle_' + (i + 1)),
          path: o.path.map(function (p) { return { col: p.col, row: p.row }; }),
          speed: o.speed,
          loopMode: o.loopMode,
          radius: o.radius
        };
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
    return true;
  }

  function loadIntoEditor(raw) {
    stopPreview();
    var lv = DC.normalizeLevel(raw);
    lv.id = raw.id || Date.now();
    lv.name = raw.name || lv.name;
    lv.hint = raw.hint || '';
    E.level = {
      version: 1, id: lv.id, name: lv.name, hint: lv.hint, difficulty: lv.difficulty,
      cols: lv.cols, rows: lv.rows,
      spawns: lv.spawns.slice(), checkpoints: lv.checkpoints.slice(), goals: lv.goals.slice(),
      walls: lv.walls.slice(),
      obstacles: lv.obstacles.map(function (o) {
        return { id: o.id, path: o.path.slice(), speed: o.speed, loopMode: o.loopMode, radius: o.radius };
      })
    };
    E.selected = null;
    E.pathEdit = false;
    E.hover = { col: -1, row: -1 };
    $('inCols').value = E.level.cols;
    $('inRows').value = E.level.rows;
    $('inName').value = E.level.name;
    $('inDiff').value = String(E.level.difficulty);
    $('edEmpty').classList.add('hidden');
    fitEditor();
    afterEdit();
    WB.ui.toast('已载入关卡：' + E.level.name, 'ok');
  }

  /* ================= 预览 ================= */
  var previewRaf = 0;
  function startPreview() {
    if (!E.level) { WB.ui.toast('先创建关卡', 'err'); return; }
    E.preview = true;
    E.previewWorld = DC.createWorld(DC.normalizeLevel(exportLevel()));
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
    setStatus('预览中：障碍正按你画的路径巡逻');
  }
  function stopPreview() {
    if (!E.preview) return;
    E.preview = false;
    E.previewWorld = null;
    if (previewRaf) cancelAnimationFrame(previewRaf);
    previewRaf = 0;
    $('btnPreview').textContent = '▶ 预览路径';
    draw();
    setStatus('');
  }

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
      btn.onclick = function () { loadIntoEditor(raw); closeLibrary(); };
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
      btn.onclick = function () { loadIntoEditor(raw); closeLibrary(); };
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
    $('btnResize').onclick = function () {
      var cols = parseInt($('inCols').value, 10), rows = parseInt($('inRows').value, 10);
      cols = Math.max(DC.MIN_COLS, Math.min(DC.MAX_COLS, cols || 20));
      rows = Math.max(DC.MIN_ROWS, Math.min(DC.MAX_ROWS, rows || 15));
      $('inCols').value = cols; $('inRows').value = rows;
      if (E.level && !window.confirm('重建会清空当前关卡内容，确定吗？')) return;
      E.level = blankLevel(cols, rows);
      E.selected = null;
      E.pathEdit = false;
      stopPreview();
      $('edEmpty').classList.add('hidden');
      fitEditor();
      afterEdit();
      WB.ui.toast('已创建 ' + cols + '×' + rows + ' 的空白关卡（四周自带外墙）', 'ok');
    };

    $('toolList').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.tool') : null;
      if (!b) return;
      E.tool = b.dataset.tool;
      if (E.tool !== 'obstacle') E.pathEdit = false;
      if (E.tool !== 'obstacle' && E.tool !== 'select') E.selected = null;
      syncToolButtons();
      afterEdit();
      WB.audio.play('click');
    });

    var cv = $('edCv');
    cv.addEventListener('click', onCanvasClick);
    cv.addEventListener('mousemove', onCanvasMove);
    cv.addEventListener('contextmenu', onCanvasContext);

    $('btnEndPath').onclick = function () {
      E.pathEdit = false;
      afterEdit();
      WB.ui.toast('已结束路径编辑');
    };
    $('btnPreview').onclick = function () { if (E.preview) stopPreview(); else startPreview(); };
    $('btnSave').onclick = doSave;

    $('btnCheck').onclick = function () {
      if (!E.level) { WB.ui.toast('先创建关卡', 'err'); return; }
      renderIssues();      // 顺手把校验结果也刷一遍，省得面板停在旧状态
      var v = DC.validateLevel(E.level);
      if (!v.ok) { setStatus('先修好校验问题再检查通关：' + v.errors[0], 'err'); return; }
      setStatus('正在推算…（时间展开搜索）');
      setTimeout(function () {
        var r = DC.solveReachable(DC.normalizeLevel(exportLevel()), 60);
        if (r.ok) setStatus('✔ 这一关能通关：理论最快约 ' + r.time.toFixed(1) + ' 秒（不考虑玩家失误）', 'ok');
        else setStatus('✖ 这一关过不去：' + (r.reason || '找不到安全路线'), 'err');
      }, 30);
    };

    $('btnTest').onclick = function () {
      if (!doSave()) return;
      WB.audio.play('click');
      location.href = '/dodge/';
    };

    $('btnLibrary').onclick = function () { WB.audio.play('click'); openLibrary(); };
    $('libClose').onclick = closeLibrary;
    $('libMask').addEventListener('click', function (e) { if (e.target === $('libMask')) closeLibrary(); });

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
        loadIntoEditor(raw);
        closeLibrary();
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
          loadIntoEditor(JSON.parse(reader.result));
          closeLibrary();
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

    $('btnClearObstacles').onclick = function () {
      if (!E.level) return;
      E.level.obstacles = [];
      E.selected = null; E.pathEdit = false;
      afterEdit();
      WB.ui.toast('已清空所有障碍');
    };
    $('btnClearAll').onclick = function () {
      if (!E.level) return;
      if (!window.confirm('清空墙、出生点、复活点、终点、障碍（尺寸保留）？')) return;
      E.level.walls = DC.createLevel(E.level.cols, E.level.rows).walls;   // 只留外墙
      E.level.spawns = []; E.level.checkpoints = []; E.level.goals = []; E.level.obstacles = [];
      E.selected = null; E.pathEdit = false;
      afterEdit();
      WB.ui.toast('已清空关卡内容');
    };

    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeLibrary();
        $('helpMask').classList.add('hidden');
        if (E.pathEdit) { E.pathEdit = false; afterEdit(); }
      }
      if (e.key === 'Delete' && E.selected) {
        var i = E.level.obstacles.indexOf(E.selected);
        if (i >= 0) { E.level.obstacles.splice(i, 1); E.selected = null; E.pathEdit = false; afterEdit(); }
      }
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { /* 预留：暂不做撤销 */ }
    });
  }

  /* ================= 启动 ================= */
  function boot() {
    bind();
    syncToolButtons();
    // 默认给一个空场示例，省得用户先点"重建"才能看到东西
    E.level = blankLevel(20, 15);
    // 摆一个最简单的示例：出生点 → 复活点 → 终点 + 一个上下巡逻的障碍
    E.level.spawns.push({ col: 1, row: 7 });
    E.level.checkpoints.push({ col: 2, row: 7 });
    E.level.goals.push({ col: 18, row: 7 });
    E.level.obstacles.push(newObstacle(10, 3));
    E.level.obstacles[0].path = [{ col: 10, row: 3 }, { col: 10, row: 11 }];
    $('edEmpty').classList.add('hidden');
    fitEditor();
    afterEdit();
    setStatus('已给你摆好一个最小示例（出生点 / 复活点 / 终点 / 一个巡逻障碍），可以直接改，也可以点顶部「重建关卡」从空白开始。');
  }

  boot();
  window.__EDITOR_DEBUG = { E: E, exportLevel: exportLevel, loadIntoEditor: loadIntoEditor };
})();
