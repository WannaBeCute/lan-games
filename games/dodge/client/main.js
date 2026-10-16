/*!
 * 方块躲避 —— 客户端主逻辑
 * 模式：单人闯关 / 本地多人（同一键盘 2~4 人）/ 在线联机（4 位房间号，全员到达才通关）
 *
 * 规则要点（与内核 dodgecore.js 一致）：
 *   · 玩家是有体积的方格，圆形障碍沿网格路径巡逻，碰到即死
 *   · 死亡回到自己最近的复活点（没经过任何复活点就回出生点）
 *   · 组队时「全员到达终点」才算通关；已到达的队友可以「接应」把队友直接送到终点
 */
(function () {
  'use strict';

  var DC = window.DodgeCore, WB = window.WB;
  var CELL = DC.GRID_SIZE;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return WB.util.esc(s); };

  var PROGRESS_KEY = 'dodge.progress.v1';       // 单人进度与最好成绩
  var CUSTOM_KEY = 'dodge.custom.levels.v1';    // 编辑器做的自制关卡（自制关卡池）
  var COLL_KEY = 'dodge.collections.v1';        // 用户自建的关卡合集（只存本机，不上服务器）

  /* 本地多人的键位（玩家 1 = 方向键 + 空格接应）—— 同时也是「设置 → 键位设置 → 方块躲避」里的默认值 */
  var LOCAL_KEYS = [
    { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', rescue: 'Space' },
    { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', rescue: 'KeyF' },
    { up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL', rescue: 'KeyU' },
    { up: 'Numpad8', down: 'Numpad5', left: 'Numpad4', right: 'Numpad6', rescue: 'Numpad0' }
  ];
  var LOCAL_KEY_NAMES = ['↑ ↓ ← → + 空格接应', 'W A S D + F 接应', 'I J K L + U 接应', '小键盘 8 4 5 6 + 0 接应'];

  /** 第 i 个玩家实际用的键位：优先「设置」里方块躲避的自定义键位，没有就用默认 */
  function keysForPlayer(i) {
    try {
      var k = WB.settings.keysFor('dodge', i);
      if (k) return k;
    } catch (e) { /* 设置层还没就绪就用默认 */ }
    return LOCAL_KEYS[i] || LOCAL_KEYS[0];
  }

  var S = {
    mode: null,              // single | local | online
    screen: 'scr-menu',
    levels: [],              // 内置关卡
    custom: [],              // 自制关卡
    world: null,
    players: [],
    levelIndex: 0,
    keyState: {},
    flash: 0,                // 死亡红闪
    elapsed: 0,
    cleared: false,
    totalDeaths: 0,
    online: null,
    net: null,
    last: 0,
    raf: 0,
    paused: false,
    rescueFlash: 0
  };

  /* ================= 存档 ================= */
  function loadProgress() {
    try {
      var raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
      return { unlocked: Math.max(1, raw.unlocked || 1), best: raw.best || {} };
    } catch (e) { return { unlocked: 1, best: {} }; }
  }
  function saveProgress(p) {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (e) { /* noop */ }
  }
  function loadCustomLevels() {
    try {
      var list = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
      return Array.isArray(list) ? list.map(function (raw) { return DC.normalizeLevel(raw); }) : [];
    } catch (e) { return []; }
  }
  /** 用户自建合集（本机存储）：[{id, name, levelIds:[自制关卡 id...]}]，自由开放、随便改 */
  function loadColls() {
    try {
      var list = JSON.parse(localStorage.getItem(COLL_KEY) || '[]');
      return Array.isArray(list) ? list.filter(function (c) { return c && c.id && c.name; }) : [];
    } catch (e) { return []; }
  }
  function saveColls(list) {
    try { localStorage.setItem(COLL_KEY, JSON.stringify(list)); } catch (e) { /* noop */ }
  }
  function bestOf(key) { return loadProgress().best[key] || null; }
  function recordClear(key, time, deaths) {
    var p = loadProgress();
    var b = p.best[key];
    if (!b || deaths < b.deaths || (deaths === b.deaths && time < b.time)) p.best[key] = { time: time, deaths: deaths };
    saveProgress(p);
    return p;
  }

  /* ================= 关卡合集 =================
   * 合集规则（与需求一致）：
   *   · 「基础关卡」「自制关卡」是两个固定合集：不得删除、不得改名
   *   · 基础关卡 = 服务器内置的 10 关，关卡制（一关一关打通解锁）
   *   · 编辑器保存的自制关卡都进「自制关卡」合集
   *   · 用户可以再建合集（默认自由开放）：改名、删除、把关卡在合集间移动都可以，只存本机
   *   · 「关卡制」只能由开发者在后台 levels.json 里标 progressive:true ——
   *     网页上没有这个开关；关卡制合集里的关卡用户不能改 / 删 / 移动
   */
  function buildCollections(pack) {
    var byId = {};
    S.levels.forEach(function (lv) { byId[String(lv.id)] = lv; });
    var colls = [];
    // 服务器合集（basic 固定；其余若标了 progressive 就是关卡制，网页不给任何操作入口）
    var srvColls = (pack && Array.isArray(pack.collections) && pack.collections.length)
      ? pack.collections
      : [{ id: 'basic', name: '基础关卡', fixed: true, progressive: true, levels: S.levels.map(function (l) { return l.id; }) }];
    srvColls.forEach(function (raw) {
      if (!raw || !raw.id) return;
      var coll = {
        id: String(raw.id),
        name: String(raw.name || raw.id),
        fixed: !!raw.fixed,
        progressive: !!raw.progressive,
        server: true,
        levels: []
      };
      var ids = Array.isArray(raw.levels) && raw.levels.length ? raw.levels : (coll.id === 'basic' ? S.levels.map(function (l) { return l.id; }) : []);
      ids.forEach(function (id) {
        var lv = byId[String(id)];
        if (lv && coll.levels.indexOf(lv) < 0) { lv._coll = coll; coll.levels.push(lv); }
      });
      if (coll.levels.length) colls.push(coll);
    });
    // 服务器合集没认领的内置关卡（数据写漏了也别丢）→ 并进 basic
    var basic = colls.filter(function (c) { return c.id === 'basic'; })[0];
    S.levels.forEach(function (lv) {
      if (!lv._coll && basic) { lv._coll = basic; basic.levels.push(lv); }
    });

    // 「自制关卡」合集（固定）：自制池里没被用户合集收编的关卡
    var claimed = {};
    loadColls().forEach(function (c) { (c.levelIds || []).forEach(function (id) { claimed[String(id)] = 1; }); });
    var customColl = { id: 'custom', name: '自制关卡', fixed: true, progressive: false, server: false, levels: [] };
    S.custom.forEach(function (lv) {
      if (!claimed[String(lv.id)]) { lv._coll = customColl; customColl.levels.push(lv); }
    });
    colls.push(customColl);

    // 用户自建合集（自由开放）
    loadColls().forEach(function (raw) {
      var coll = { id: String(raw.id), name: String(raw.name), fixed: false, progressive: false, server: false, levels: [] };
      (raw.levelIds || []).forEach(function (id) {
        var lv = null;
        for (var i = 0; i < S.custom.length; i++) if (String(S.custom[i].id) === String(id)) { lv = S.custom[i]; break; }
        if (lv) { lv._coll = coll; coll.levels.push(lv); }
      });
      colls.push(coll);
    });
    S.collections = colls;
  }

  /** 合集当前的解锁数（仅关卡制合集有意义；自由合集返回 Infinity） */
  function collUnlocked(coll, prog) {
    if (!coll || !coll.progressive) return Infinity;
    if (coll.id === 'basic') return prog.unlocked;
    var c = (prog.coll || {})[coll.id];
    return Math.max(1, (c && c.unlocked) || 1);
  }
  /** 关卡在合集里的序号（0 起）是否被锁住 */
  function levelLocked(lv, prog) {
    var coll = lv._coll;
    if (!coll || !coll.progressive) return false;
    var idx = coll.levels.indexOf(lv);
    return (idx + 1) > collUnlocked(coll, prog);
  }
  /** 通关后记解锁：关卡制合集里过了第 k 关（0 起）就开到 k+2 */
  function markCleared(lv, p) {
    var coll = lv._coll;
    if (!coll || !coll.progressive) return;
    var idx = coll.levels.indexOf(lv);
    if (idx < 0) return;
    if (coll.id === 'basic') { p.unlocked = Math.max(p.unlocked, idx + 2); return; }
    p.coll = p.coll || {};
    var c = p.coll[coll.id] = p.coll[coll.id] || { unlocked: 1 };
    c.unlocked = Math.max(c.unlocked || 1, idx + 2);
  }

  /* ================= 关卡列表 ================= */
  function allLevels() {
    var out = [];
    (S.collections || []).forEach(function (coll) { coll.levels.forEach(function (lv) { out.push(lv); }); });
    return out;
  }
  function levelKey(lv) {
    if (lv.custom) return 'custom:' + lv.id;
    return (lv._coll && lv._coll.id !== 'basic') ? ('srv:' + lv._coll.id + ':' + lv.id) : ('builtin:' + lv.id);
  }
  function difficultyStars(n) { var s = ''; for (var i = 0; i < 5; i++) s += i < n ? '★' : '☆'; return s; }

  function fetchLevels() {
    return fetch('/dodge/shared/levels.json').then(function (r) { return r.json(); }).then(function (pack) {
      S.pack = pack;
      S.levels = (pack.levels || []).map(function (raw) { return DC.normalizeLevel(raw); });
      S.custom = loadCustomLevels();
      S.custom.forEach(function (lv) { lv.custom = true; });
      if (!S.levels.length) throw new Error('关卡包是空的');
      buildCollections(pack);
      return allLevels();
    });
  }

  /* ================= 画面切换 ================= */
  var SCREENS = ['scr-menu', 'scr-levels', 'scr-local', 'scr-online', 'scr-lobby', 'scr-game'];
  function show(id) {
    SCREENS.forEach(function (s) { $(s).classList.toggle('hidden', s !== id); });
    S.screen = id;
    if (id === 'scr-game') { fitCanvas(); requestAnimationFrame(fitCanvas); }
  }
  function showOverlay(html) { $('overlayInner').innerHTML = html; $('overlay').classList.remove('hidden'); }
  function hideOverlay() { $('overlay').classList.add('hidden'); }

  /* ================= 画布自适应 ================= */
  function levelPixels() {
    var lv = S.world ? S.world.level : { cols: 20, rows: 15 };
    return { w: lv.cols * CELL, h: lv.rows * CELL, cols: lv.cols, rows: lv.rows };
  }
  function fitCanvas() {
    var cv = $('cv');
    if (!cv || !S.world) return;
    var wrap = $('cvWrap');
    var size = levelPixels();
    var availW = Math.max(320, (wrap ? wrap.clientWidth : 900) - 26);
    var availH = Math.max(260, window.innerHeight - 250);
    var scale = Math.min(availW / size.w, availH / size.h, 1.35);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cssW = Math.round(size.w * scale), cssH = Math.round(size.h * scale);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(cssW * dpr / size.w, 0, 0, cssH * dpr / size.h, 0, 0);
    S.scale = scale;
  }
  window.addEventListener('resize', function () { if (S.world) fitCanvas(); });

  /* ================= 绘制 ================= */
  function roundRect(ctx, x, y, w, h, r) {
    if (!r) { ctx.rect(x, y, w, h); return; }   // 半径 0 = 标准直角矩形（玩家方块走这条）
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

  /** 设施区域：normalizeLevel 已经算好就复用，没有就现算（纯渲染用，不需要落脚点） */
  function facRegions(lv, field) {
    var key = field + 'Regions';
    if (lv[key] && lv[key].length) return lv[key];
    return DC.regions(lv[field] || []);
  }

  function drawWorld(ctx, world, players, opts) {
    opts = opts || {};
    var lv = world.level;
    var W = lv.cols * CELL, H = lv.rows * CELL;
    ctx.clearRect(0, 0, W, H);

    // 背景（白底）+ 网格
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(15, 23, 42, .07)';
    ctx.lineWidth = 1;
    for (var c = 1; c < lv.cols; c++) { ctx.beginPath(); ctx.moveTo(c * CELL + .5, 0); ctx.lineTo(c * CELL + .5, H); ctx.stroke(); }
    for (var r = 1; r < lv.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL + .5); ctx.lineTo(W, r * CELL + .5); ctx.stroke(); }

    /** 设施区域只铺一层柔和的填色，不再描边画框 —— 运行时画面更干净（编辑器里才画轮廓） */
    function paintRegion(cells, fill) {
      if (!cells || !cells.length) return;
      cells.forEach(function (cell) {
        ctx.fillStyle = fill;
        ctx.fillRect(cell.col * CELL + 2, cell.row * CELL + 2, CELL - 4, CELL - 4);
      });
    }

    // 复活点：黄色；已经踩过的变绿（表示"现在死了会回到这里"）
    var activeCells = {};
    players.forEach(function (p) { if (p.cp) activeCells[DC.cellKey(p.cp.col, p.cp.row)] = 1; });
    facRegions(lv, 'checkpoint').forEach(function (reg) {
      var on = reg.cells.some(function (cell) { return activeCells[DC.cellKey(cell.col, cell.row)]; });
      paintRegion(reg.cells, on ? 'rgba(22, 163, 74, .18)' : 'rgba(234, 179, 8, .20)');
    });

    // 出生点：绿色
    facRegions(lv, 'spawn').forEach(function (reg) {
      paintRegion(reg.cells, 'rgba(21, 128, 61, .14)');
    });

    // 终点：绿色（整块区域会呼吸）
    var pulse = 0.5 + 0.5 * Math.sin((world.time || 0) * 4);
    facRegions(lv, 'goal').forEach(function (reg) {
      paintRegion(reg.cells, 'rgba(34, 197, 94, ' + (0.16 + pulse * 0.20).toFixed(3) + ')');
      ctx.fillStyle = 'rgba(22, 163, 74, ' + (0.55 + pulse * 0.35).toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(reg.x, reg.y, 5.5, 0, Math.PI * 2); ctx.fill();
    });

    // 墙
    lv.walls.forEach(function (w) {
      var c = DC.gridCenter(w.col, w.row);
      ctx.fillStyle = '#94a3b8';
      roundRect(ctx, c.x - CELL / 2 + 1, c.y - CELL / 2 + 1, CELL - 2, CELL - 2, 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(15, 23, 42, .18)';
      ctx.lineWidth = 1;
      roundRect(ctx, c.x - CELL / 2 + 1, c.y - CELL / 2 + 1, CELL - 2, CELL - 2, 4);
      ctx.stroke();
    });

    // 圆形障碍：实心平色，**不发光、不反光**（2026-10-15 定：看到的圆就是判定用的圆）
    // 描边画在半径内侧（r - 线宽/2），保证"最外圈的像素"正好落在 radius 上，
    // 视觉边界与 rectCircleCollide 的判定边界严格一致。
    world.obstacles.forEach(function (o) {
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#a93226';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(o.x, o.y, o.radius - 1, 0, Math.PI * 2); ctx.stroke();
    });

    // 玩家
    var half = DC.PLAYER_SIZE / 2;
    players.forEach(function (p) {
      var px = p.x, py = p.y, alpha = 1;
      // 接应传送：0.5 秒从原地飞向终点
      if (p.fx && p.fx.t < DC.RESCUE_FLIGHT) {
        var k = p.fx.t / DC.RESCUE_FLIGHT;
        var ease = 1 - Math.pow(1 - k, 3);
        px = p.fx.fromX + (p.x - p.fx.fromX) * ease;
        py = p.fx.fromY + (p.y - p.fx.fromY) * ease;
        alpha = 1 - 0.35 * k;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      if (p.state === 'dead') {
        ctx.globalAlpha = alpha * 0.45;
        ctx.fillStyle = '#ff5d6c';
      } else if (p.state === 'arrived') {
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = p.color;
      } else {
        // 无敌期闪烁
        if (p.invuln > 0 && Math.floor(p.invuln * 14) % 2 === 0) ctx.globalAlpha = alpha * 0.35;
        ctx.fillStyle = p.color;
      }
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 0;              // 不发光：看到多大就多大
      // 标准正方形，没有圆角（round = 0 → 直接走 fillRect/strokeRect 那条分支）
      squareRect(ctx, px - half, py - half, DC.PLAYER_SIZE, DC.PLAYER_SIZE);
      ctx.fill();
      ctx.strokeStyle = 'rgba(15, 23, 42, .38)';
      ctx.lineWidth = 1.6;
      // 描边内收半个线宽：最外圈像素正好落在 PLAYER_SIZE 上 = 碰撞盒边界
      squareRect(ctx, px - half + 0.8, py - half + 0.8, DC.PLAYER_SIZE - 1.6, DC.PLAYER_SIZE - 1.6);
      ctx.stroke();
      // 已到达：画个对勾
      if (p.state === 'arrived') {
        ctx.strokeStyle = 'rgba(255, 255, 255, .95)';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(px - 7, py);
        ctx.lineTo(px - 2, py + 6);
        ctx.lineTo(px + 8, py - 6);
        ctx.stroke();
      }
      // 本地多人的小标记：谁是几号玩家
      if (opts.showIndex) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(0, 0, 0, .55)';
        ctx.font = 'bold 13px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(p.index + 1), px, py + 1);
      }
      if (p.name && opts.showNames) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(15, 23, 42, .8)';
        ctx.font = '11px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(p.name, px, py - half - 5);
      }
      ctx.restore();
    });

    // 死亡红闪
    if (S.flash > 0) {
      ctx.fillStyle = 'rgba(231, 76, 60, ' + (S.flash * 0.3).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ================= 一局的运行（单人 / 本地多人） ================= */
  function startLocalGame(levelIndex, playerCount) {
    var list = allLevels();
    var lv = list[levelIndex];
    if (!lv) return;
    S.mode = playerCount > 1 ? 'local' : 'single';
    S.levelIndex = levelIndex;
    S.world = DC.createWorld(lv);
    S.players = [];
    for (var i = 0; i < playerCount; i++) {
      var p = DC.createPlayer(S.world, i, playerCount > 1 ? ('P' + (i + 1) + ' ' + WB.playerName()) : WB.playerName());
      p.rescueCd = 0;
      S.players.push(p);
    }
    S.elapsed = 0;
    S.totalDeaths = 0;
    S.cleared = false;
    S.flash = 0;
    S.paused = false;
    hideOverlay();
    show('scr-game');
    renderTeam();
    renderLevelHint(lv);
    WB.audio.play('spawn');
    $('hMode').textContent = playerCount > 1 ? ('本地 ' + playerCount + ' 人 · 全员到达才通关') : '单人闯关';
    $('btnRescue').classList.toggle('hidden', playerCount < 2);
    $('btnNext').classList.add('hidden');
    fitCanvas();
  }

  function renderLevelHint(lv) {
    var el = $('levelHint');
    el.innerHTML = '';
    $('hLevel').textContent = levelLabel(lv);
    $('levelHint').textContent = (lv && lv.hint) ? lv.hint : '把每个人都送进绿色终点区域（进去任意一格都算到达）。';
  }

  /** 关卡的全称标注：「合集名 · 第 N 关」（N 是合集内序号） */
  function levelLabel(lv) {
    var coll = lv && lv._coll;
    if (!coll) return '第 ? 关';
    var idx = coll.levels.indexOf(lv);
    return coll.name + ' · 第 ' + (idx + 1) + ' 关';
  }

  function renderTeam() {
    var ul = $('teamList');
    ul.textContent = '';
    if (!S.players.length) return;
    S.players.forEach(function (p) {
      var li = document.createElement('li');
      var sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = p.color;
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name;
      var st = document.createElement('span');
      st.className = 'st ' + p.state;
      st.textContent = p.state === 'arrived' ? '✔ 已到达' : (p.state === 'dead' ? '✖ 被撞' : '· 进行中');
      li.appendChild(sw); li.appendChild(nm); li.appendChild(st);
      ul.appendChild(li);
    });
  }

  function readLocalInput(i) {
    var k = LOCAL_KEYS[i] || LOCAL_KEYS[0];
    return {
      up: !!S.keyState[k.up], down: !!S.keyState[k.down],
      left: !!S.keyState[k.left], right: !!S.keyState[k.right]
    };
  }

  function stepLocal(dt) {
    var world = S.world;
    if (!world) return;
    DC.stepObstacles(world, dt);
    S.elapsed += dt;
    S.players.forEach(function (p, i) {
      var ev = DC.stepPlayer(world, p, readLocalInput(i), dt);
      if (ev.died) { S.flash = 1; S.totalDeaths++; WB.audio.play('kill'); }
      if (ev.checkpoint) WB.audio.play('pickup');
      if (ev.arrived) { WB.audio.play('go'); WB.ui.toast(p.name + ' 到达终点！'); }
      if (ev.respawned) WB.audio.play('spawn');
    });
    // 接应按键
    S.players.forEach(function (p, i) {
      var k = keysForPlayer(i);
      if (p.state === 'arrived' && p.rescueCd <= 0 && S.keyState[k.rescue]) {
        var moved = DC.rescue(world, S.players, i);
        if (moved.length) {
          WB.audio.play('win');
          S.rescueFlash = 1;
          WB.ui.toast(p.name + ' 接应了 ' + moved.length + ' 名队友！', 'ok');
        }
      }
    });
    // 全员到达 → 通关
    if (!S.cleared && DC.allArrived(S.players)) {
      S.cleared = true;
      WB.audio.play('win');
      showClearOverlay();
    }
  }

  function showClearOverlay() {
    var lv = S.world.level;
    var p = recordClear(levelKey(lv), S.elapsed, S.totalDeaths);
    markCleared(lv, p);
    saveProgress(p);
    var best = p.best[levelKey(lv)];
    // 「下一关」= 同一个合集里的下一关（跨合集不接力）；关卡制合集里刚通关就会解锁它
    var list = allLevels();
    var nxt = list[S.levelIndex + 1];
    var hasNext = !!(nxt && nxt._coll && lv._coll && nxt._coll.id === lv._coll.id && !levelLocked(nxt, loadProgress()));
    var idxInColl = lv._coll ? lv._coll.levels.indexOf(lv) : S.levelIndex;

    var rows = S.players.map(function (q) {
      return '<div class="r"><span class="swatch" style="background:' + q.color + '"></span>' +
        esc(q.name) + ' · 死亡 <b>' + q.deaths + '</b> 次' + (q.rescued ? ' · 被接应' : '') + '</div>';
    }).join('');

    showOverlay(
      '<h2>🎉 第 ' + (idxInColl + 1) + ' 关通关</h2>' +
      '<p class="osub">' + esc(lv._coll ? lv._coll.name + ' · ' : '') + esc(lv.name) + ' · 用时 ' + S.elapsed.toFixed(1) + ' 秒 · 全队共死亡 ' + S.totalDeaths + ' 次' +
      '<br>本关最好成绩：' + best.deaths + ' 次死亡 / ' + best.time.toFixed(1) + ' 秒</p>' +
      '<div class="result-rows">' + rows + '</div>' +
      '<div class="obtns">' +
        (hasNext ? '<button class="btn primary" id="ovNext">下一关</button>' : '') +
        '<button class="btn ghost" id="ovAgain">再玩一次</button>' +
        '<button class="btn ghost" id="ovLevels">关卡选择</button>' +
        '<button class="btn ghost" id="ovMenu">回到主菜单</button>' +
      '</div>'
    );
    var n = $('ovNext');
    if (n) n.onclick = function () { WB.audio.play('click'); startLocalGame(S.levelIndex + 1, S.players.length); };
    $('ovAgain').onclick = function () { WB.audio.play('click'); startLocalGame(S.levelIndex, S.players.length); };
    $('ovLevels').onclick = function () { WB.audio.play('click'); hideOverlay(); renderLevelGrid(); show('scr-levels'); };
    $('ovMenu').onclick = function () {
      WB.audio.play('click');
      hideOverlay();
      S.world = null;
      renderBestLine();
      show('scr-menu');
    };
  }

  /* ================= 主循环 ================= */
  function frame(ts) {
    var dt = S.last ? Math.min(0.05, (ts - S.last) / 1000) : 1 / 60;
    S.last = ts;
    if (S.screen === 'scr-game' && S.world) {
      if (S.mode === 'online') stepOnline(dt);
      else if (!S.paused && !S.cleared) stepLocal(dt);
      else if (S.paused) { /* 暂停时连障碍一起停 */ }
      else stepObstaclesOnly(dt);
      if (S.flash > 0) S.flash = Math.max(0, S.flash - dt * 2.2);
      if (S.rescueFlash > 0) S.rescueFlash = Math.max(0, S.rescueFlash - dt * 2);
      // 接应飞行动画推进
      S.players.forEach(function (p) { if (p.fx && p.fx.t < DC.RESCUE_FLIGHT) p.fx.t += dt; });
      drawWorld($('cv').getContext('2d'), S.world, S.players, {
        showIndex: S.mode === 'local' || S.mode === 'single',
        showNames: S.mode === 'online'
      });
      updateHud();
    }
    S.raf = requestAnimationFrame(frame);
  }

  function stepObstaclesOnly(dt) {
    if (!S.world) return;
    DC.stepObstacles(S.world, dt);
  }

  function updateHud() {
    $('hTimer').textContent = '⏱ ' + (S.mode === 'online' ? S.elapsed : S.elapsed).toFixed(1) + 's';
    $('hDeaths').textContent = '💀 ' + S.totalDeaths;
    if (S.mode !== 'online') $('hLevel').textContent = levelLabel(S.world && S.world.level);
    // 接应按钮：自己已到达且冷却结束才亮
    var me = S.mode === 'online' ? S.onlineMyPlayer() : null;
    if (S.mode === 'online' && me) {
      var canRescue = me.state === 'arrived' && me.rescueCd <= 0;
      $('btnRescue').classList.toggle('hidden', !canRescue);
    }
    if (S.players.length > 1 || S.mode === 'online') renderTeam();
  }

  /* ================= 联机 ================= */
  function onlineMyPlayer() {
    if (!S.online) return null;
    return S.players[S.online.myIndex] || null;
  }

  /**
   * 本标签页的稳定身份钥匙（平台层 WB.me 提供）。
   * 平台每次连接都换新 id，于是"刷新一下"在服务端看来就是新玩家：房间被当成掉线销毁，
   * 刚发出去的房间号随之失效。带上这把钥匙，刷新/断线重连才能把座位要回来。
   */
  var ME_KEY = WB.me.key();

  function initNet() {
    S.net = new WB.Net();
    WB.bindNetBadge($('netBadge'), S.net);

    /* 连上就试着「回到我的房间」：刷新/断线重连后自动接回座位（对局中也照收） */
    S.net.on('hello', function () {
      if (!WB.me.recallRoom('dodge')) return;
      S.net.send({ t: 'dodge.resume', key: ME_KEY });
    });
    S.net.on('dodge.resumeFailed', function () { WB.me.forgetRoom('dodge'); });
    S.net.on('dodge.dropped', function (m) {
      WB.ui.toast((m && m.msg) || '有队友掉线了', 'err');
      WB.audio.play('error');
    });
    S.net.on('dodge.closed', function (m) {
      WB.ui.toast((m && m.msg) || '房间已解散', 'err');
      WB.audio.play('error');
      WB.me.forgetRoom('dodge');
      WB.Chat.leaveRoom();
      S.world = null;
      S.online = null;
      WB.Friends.refreshGame();
      show('scr-menu');
    });

    /* ---------- 好友系统（平台层，所有游戏通用） ---------- */
    WB.Friends.boot(S.net);
    /* ---------- 聊天控件（左下角，平台层通用）：房间聊天走频道 ---------- */
    WB.Chat.boot(S.net);
    WB.Friends.registerGame({
      name: 'dodge',
      label: '方块躲避',
      entry: '/dodge/',
      param: 'join',
      canInvite: function () {
        var room = S.online && S.online.room;
        if (room && (room.state === 'lobby' || !room.state)) {
          return { data: { room: room.code }, text: '房间 ' + room.code };
        }
        return null;
      },
      accept: function (data) {
        var code = String((data && data.room) || '').trim();
        if (!/^\d{4}$/.test(code)) { WB.ui.toast('邀请信息不完整', 'err'); WB.audio.play('error'); return; }
        if (S.net.status !== 'open') { WB.ui.toast('正在连接服务器…', 'err'); return; }
        WB.ui.toast('正在加入好友的房间 ' + code + '…', 'ok');
        S.net.send({ t: 'dodge.join', code: code, key: ME_KEY });
      }
    });

    S.net.on('dodge.created', function (m) {
      WB.audio.play('click');
      WB.ui.toast('房间已创建：' + m.code, 'ok');
      WB.me.rememberRoom('dodge', m.code);        // 刷新后能自己回来
      WB.Chat.enterRoom({ game: 'dodge', code: m.code, title: '方块躲避 · 房间 ' + m.code });
      show('scr-lobby');
    });
    S.net.on('dodge.joined', function (m) {
      WB.ui.toast(m.resumed ? ('已回到房间：' + m.code) : ('已加入房间：' + m.code), 'ok');
      WB.me.rememberRoom('dodge', m.code);
      WB.Chat.enterRoom({ game: 'dodge', code: m.code, title: '方块躲避 · 房间 ' + m.code });
      // 正在跑的这一关：服务端随后会补发关卡场景直接进画面，别把人按回大厅
      if (S.screen !== 'scr-game') show('scr-lobby');
    });
    S.net.on('dodge.you', function (m) {
      if (!S.online) S.online = { code: '', myIndex: 0, room: null, members: [] };
      S.online.myIndex = m.index;
    });
    S.net.on('dodge.room', function (m) {
      if (!S.online) S.online = { myIndex: 0 };
      S.online.room = m;
      S.online.code = m.code;
      S.online.members = m.members;
      // 刷新页面后回到同一房间：把聊天频道也接回来（房间在，聊天区就在）
      if (m.code) WB.Chat.enterRoom({ game: 'dodge', code: m.code, title: '方块躲避 · 房间 ' + m.code });
      WB.Friends.refreshGame();   // 房间状态变了 → 好友面板里的「邀请组队」跟着出现/消失
      if (S.screen === 'scr-lobby' || m.state === 'lobby') renderLobby(m);
      else if (S.screen === 'scr-game') { /* 对局中收到大厅状态，忽略 */ }
      else renderLobby(m);
    });
    S.net.on('dodge.host', function (m) { WB.ui.toast('房主已转让给 ' + m.name); });
    S.net.on('dodge.playerLeft', function (m) { WB.ui.toast(m.name + ' 离开了队伍'); });
    S.net.on('dodge.error', function (m) { WB.ui.toast(m.msg || '操作失败', 'err'); WB.audio.play('error'); });

    S.net.on('dodge.levelStart', function (m) {
      onlineStartLevel(m);
    });
    S.net.on('dodge.snap', function (m) {
      if (!S.online || S.mode !== 'online') return;
      S.online.snap = m;
      S.elapsed = m.time;
      // 其他玩家：记下目标位置，渲染时插值过去
      m.players.forEach(function (a) {
        var idx = a[0];
        var p = S.players[idx];
        if (!p || idx === S.online.myIndex) return;
        p.netX = a[1]; p.netY = a[2];
        p.netState = a[3];
        p.invuln = a[4] ? 0.3 : 0;
      });
      // 障碍：服务器位置作为"真值"，本地慢慢对齐（两边跑的是同一份代码，偏差很小）
      if (m.obstacles) {
        for (var i = 0; i < m.obstacles.length && i < S.world.obstacles.length; i++) {
          S.world.obstacles[i].netX = m.obstacles[i][0];
          S.world.obstacles[i].netY = m.obstacles[i][1];
        }
      }
      // 自己：用服务器位置纠正预测
      var me = m.players.filter(function (a) { return a[0] === S.online.myIndex; })[0];
      if (me) {
        var mine = S.players[S.online.myIndex];
        if (mine) {
          if (me[3] !== mine.state) mine.state = me[3];
          var dx = me[1] - mine.x, dy = me[2] - mine.y;
          if (Math.abs(dx) > 60 || Math.abs(dy) > 60) { mine.x = me[1]; mine.y = me[2]; }   // 差太多直接拉过去
          else { mine.x += dx * 0.25; mine.y += dy * 0.25; }
          mine.rescueCd = me[5] ? 1 : 0;
        }
      }
    });
    S.net.on('dodge.ownDeath', function (m) {
      S.flash = 1;
      S.totalDeaths = m.deaths;
      WB.audio.play('kill');
      renderTeam();
    });
    S.net.on('dodge.death', function (m) {
      if (m.index === (S.online ? S.online.myIndex : -1)) { S.flash = 1; S.totalDeaths = m.deaths; WB.audio.play('kill'); }
      else WB.audio.play('spark');
      var p = S.players[m.index];
      if (p) { p.deaths = m.deaths; p.state = 'dead'; }
      renderTeam();
    });
    S.net.on('dodge.arrived', function (m) {
      var p = S.players[m.index];
      if (p) { p.state = 'arrived'; p.fx = null; }
      WB.audio.play('go');
      WB.ui.toast(m.name + ' 到达终点！', 'ok');
      renderTeam();
    });
    S.net.on('dodge.respawn', function (m) {
      var p = S.players[m.index];
      if (p) p.state = 'playing';
      renderTeam();
    });
    S.net.on('dodge.rescued', function (m) {
      WB.audio.play('win');
      WB.ui.toast(m.name + ' 正在接应队友！', 'ok');
      (m.moved || []).forEach(function (mv) {
        var p = S.players[mv.index];
        if (!p) return;
        p.fx = { fromX: mv.fromX, fromY: mv.fromY, t: 0 };
        p.state = 'arrived';
        p.rescued = true;
      });
      renderTeam();
    });
    S.net.on('dodge.restart', function (m) {
      WB.ui.toast('队伍重来本关');
      onlineRebuildPlayers();
      S.elapsed = 0;
      hideOverlay();
      $('btnNext').classList.add('hidden');
      WB.audio.play('spawn');
    });
    S.net.on('dodge.cleared', function (m) {
      WB.audio.play('win');
      S.cleared = true;
      var isHost = S.online && S.online.room && S.online.room.hostId === S.net.id;
      var rows = (m.result.deaths || []).map(function (d) {
        var p = S.players[d.index];
        return '<div class="r"><span class="swatch" style="background:' + ((p && p.color) || '#888') + '"></span>' +
          esc(d.name) + ' · 死亡 <b>' + d.deaths + '</b> 次</div>';
      }).join('');
      showOverlay(
        '<h2>🎉 全队通关</h2>' +
        '<p class="osub">用时 ' + m.result.time.toFixed(1) + ' 秒 · ' + (m.result.rescued.length ? (m.result.rescued.length + ' 人被接应传送') : '没有人需要接应') + '</p>' +
        '<div class="result-rows">' + rows + '</div>' +
        '<div class="obtns">' +
          (isHost && m.hasNext ? '<button class="btn primary" id="ovOnlineNext">下一关</button>' : '') +
          '<button class="btn ghost" id="ovOnlineAgain">重来本关</button>' +
          '<button class="btn ghost" id="ovOnlineLobby">回大厅</button>' +
        '</div>'
      );
      var n = $('ovOnlineNext');
      if (n) n.onclick = function () { WB.audio.play('click'); S.net.send({ t: 'dodge.next' }); hideOverlay(); };
      $('ovOnlineAgain').onclick = function () { WB.audio.play('click'); S.net.send({ t: 'dodge.restart' }); hideOverlay(); };
      $('ovOnlineLobby').onclick = function () { WB.audio.play('click'); S.net.send({ t: 'dodge.toLobby' }); hideOverlay(); };
    });
    S.net.on('dodge.allCleared', function () {
      WB.ui.toast('全部关卡都通关了，厉害！', 'ok');
      S.world = null;
      show('scr-lobby');
    });
    S.net.on('dodge.toLobby', function () {
      S.world = null;
      S.cleared = false;
      hideOverlay();
      show('scr-lobby');
    });

    window.addEventListener('wb:settings', function () {
      if (S.net) S.net.send({ t: 'hello', name: WB.playerName() });
    });
    S.net.connect();
  }

  function onlineStartLevel(m) {
    if (!S.online) S.online = { myIndex: 0, members: [] };
    S.mode = 'online';
    var lv = DC.normalizeLevel(m.level);
    S.levelIndex = m.index;
    S.world = DC.createWorld(lv);
    S.elapsed = 0;
    S.totalDeaths = 0;
    S.cleared = false;
    S.flash = 0;
    S.online.snap = null;
    onlineRebuildPlayers();
    hideOverlay();
    show('scr-game');
    renderLevelHint(lv);
    $('hMode').textContent = '在线联机 · 全员到达才通关';
    $('hLevel').textContent = '第 ' + (m.index + 1) + ' / ' + m.levelCount + ' 关';
    $('btnRescue').classList.add('hidden');
    $('btnNext').classList.add('hidden');
    WB.audio.play('spawn');
    fitCanvas();
  }

  /** 依据大厅成员重建本地玩家对象（颜色、名字、出生点都跟服务端一致） */
  function onlineRebuildPlayers() {
    var members = (S.online && S.online.members) || [];
    S.players = members.map(function (mem, i) {
      var p = DC.createPlayer(S.world, i, mem.name);
      p.color = mem.color || p.color;
      p.clientId = mem.id;
      p.state = 'playing';
      p.cp = null;
      return p;
    });
    if (!S.players.length) S.players = [DC.createPlayer(S.world, 0, WB.playerName())];
    renderTeam();
  }

  var inputAcc = 0;
  function stepOnline(dt) {
    var world = S.world;
    if (!world) return;
    DC.stepObstacles(world, dt);
    S.elapsed += dt;
    // 本地预测：自己的方块按按键立刻动
    var me = onlineMyPlayer();
    if (me && me.state === 'playing') {
      var ev = DC.stepPlayer(world, me, readMyKeys(), dt);
      if (ev.died) S.flash = 1;
    }
    // 其他玩家往服务器位置插值
    S.players.forEach(function (p, i) {
      if (i === S.online.myIndex) return;
      if (p.netX === undefined) return;
      p.x += (p.netX - p.x) * Math.min(1, dt * 12);
      p.y += (p.netY - p.y) * Math.min(1, dt * 12);
      if (p.netState) p.state = p.netState;
      if (p.fx && p.fx.t < DC.RESCUE_FLIGHT) p.fx.t += dt;
    });
    // 障碍对齐服务器
    world.obstacles.forEach(function (o) {
      if (o.netX === undefined) return;
      o.x += (o.netX - o.x) * Math.min(1, dt * 3);
      o.y += (o.netY - o.y) * Math.min(1, dt * 3);
    });
    // 上报按键（30Hz）
    inputAcc += dt;
    if (inputAcc > 1 / 30) {
      inputAcc = 0;
      var k = readMyKeys();
      S.net.send({ t: 'dodge.input', up: k.up, down: k.down, left: k.left, right: k.right });
    }
  }

  /** 联机时自己用哪套键：设置里的方块躲避玩家 1 键位，WASD 和方向键也都认 */
  function readMyKeys() {
    var k = keysForPlayer(0);
    return {
      up: !!(S.keyState[k.up] || S.keyState.KeyW || S.keyState.ArrowUp),
      down: !!(S.keyState[k.down] || S.keyState.KeyS || S.keyState.ArrowDown),
      left: !!(S.keyState[k.left] || S.keyState.KeyA || S.keyState.ArrowLeft),
      right: !!(S.keyState[k.right] || S.keyState.KeyD || S.keyState.ArrowRight)
    };
  }

  /* ---------- 大厅 / 关卡选择 / 菜单渲染 ---------- */
  function renderLobby(room) {
    $('roomCode').textContent = room.code;
    $('roomCount').textContent = room.members.length + '/' + room.maxPlayers;
    var ul = $('playerList');
    ul.textContent = '';
    var isHost = S.net && room.hostId === S.net.id;
    room.members.forEach(function (mem) {
      var li = document.createElement('li');
      if (S.net && mem.id === S.net.id) li.className = 'me';
      var sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = mem.color;
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = mem.name + (S.net && mem.id === S.net.id ? '（我）' : '');
      var tag = document.createElement('span');
      tag.className = 'tag' + (mem.host ? ' host' : (mem.ready ? ' ok' : ''));
      tag.textContent = mem.host ? '房主' : (mem.ready ? '✔ 已准备' : '未准备');
      li.appendChild(sw); li.appendChild(nm); li.appendChild(tag);
      // 我是房主时，其他成员行内给一个「转让房主」小按钮
      if (isHost && mem.id !== S.net.id) {
        var gv = document.createElement('button');
        gv.className = 'btn tiny ghost';
        gv.textContent = '转让房主';
        gv.onclick = function () {
          WB.audio.play('click');
          S.net.send({ t: 'dodge.giveHost', target: mem.id });
        };
        li.appendChild(gv);
      }
      ul.appendChild(li);
    });

    var me = room.members.filter(function (m) { return S.net && m.id === S.net.id; })[0];
    $('btnReady').classList.toggle('hidden', !!isHost);
    $('btnReady').textContent = (me && me.ready) ? '取消准备' : '我已准备好';

    // 关卡选择
    var picks = $('roomLevels');
    picks.textContent = '';
    (room.levelNames || []).forEach(function (info, i) {
      var b = document.createElement('button');
      b.className = 'lv-pick' + (i === room.levelIndex ? ' on' : '');
      b.disabled = !isHost;
      b.innerHTML = '第 ' + (i + 1) + ' 关<br>' + esc(info.name) + ' <span class="d">' + difficultyStars(info.difficulty) + '</span>';
      b.onclick = function () {
        WB.audio.play('click');
        S.net.send({ t: 'dodge.level', index: i });
      };
      picks.appendChild(b);
    });
    $('roomLevelName').textContent = '第 ' + (room.levelIndex + 1) + ' 关 · ' + (room.levelName || '');

    // 开始条件
    var others = room.members.filter(function (m) { return m.id !== room.hostId; });
    var notReady = others.filter(function (m) { return !m.ready; });
    var canStart = isHost && room.members.length >= 1 && notReady.length === 0 && room.members.length >= 2;
    $('btnStartGame').disabled = !canStart;
    if (!isHost) {
      $('lobbyTip').textContent = '等房主选好关卡并开始游戏。';
      $('btnStartGame').textContent = '等待房主开始';
    } else if (room.members.length < 2) {
      $('lobbyTip').textContent = '只有你 1 人：把房间号发给同学，或用「邀请好友」直接拉人。';
      $('btnStartGame').textContent = '暂不可开始';
    } else if (notReady.length) {
      $('lobbyTip').textContent = '还有 ' + notReady.length + ' 人未准备：' + notReady.map(function (m) { return m.name; }).join('、');
      $('btnStartGame').textContent = '暂不可开始';
    } else {
      $('lobbyTip').textContent = '全员就绪，可以开始（共 ' + room.members.length + ' 人）';
      $('btnStartGame').textContent = '开始游戏';
    }
    $('lobbyFootTip').textContent = '玩法：全员到达终点才算通关；已到达的队友可按接应键拉队友一把。';
  }

  /* ---------- 合集管理（用户自建合集，只存本机浏览器） ---------- */
  function persistUserColls() {
    var list = (S.collections || []).filter(function (c) { return !c.fixed && !c.server; }).map(function (c) {
      return { id: c.id, name: c.name, levelIds: c.levels.map(function (lv) { return lv.id; }) };
    });
    saveColls(list);
  }
  function collNameTaken(name) {
    return (S.collections || []).some(function (c) { return c.name === name; });
  }
  function addCollection() {
    var name = (window.prompt('新合集的名字：', '我的合集') || '').trim();
    if (!name) return;
    if (name === '基础关卡' || name === '自制关卡') { WB.ui.toast('这个名字是固定合集专用的，换一个吧', 'err'); return; }
    if (collNameTaken(name)) { WB.ui.toast('已经有同名的合集了', 'err'); return; }
    var list = loadColls();
    list.push({ id: 'u' + Date.now(), name: name, levelIds: [] });
    saveColls(list);
    buildCollections(S.pack);
    renderLevelGrid();
    WB.ui.toast('合集「' + name + '」建好了：去「自制关卡」里把关卡收进来', 'ok');
  }
  function renameCollection(coll) {
    var name = (window.prompt('合集改名：', coll.name) || '').trim();
    if (!name || name === coll.name) return;
    if (name === '基础关卡' || name === '自制关卡') { WB.ui.toast('这个名字是固定合集专用的，换一个吧', 'err'); return; }
    if (collNameTaken(name)) { WB.ui.toast('已经有同名的合集了', 'err'); return; }
    coll.name = name;
    persistUserColls();
    renderLevelGrid();
  }
  function deleteCollection(coll) {
    if (!window.confirm('删除合集「' + coll.name + '」？里面的 ' + coll.levels.length + ' 个关卡会回到「自制关卡」合集（关卡本身不会被删）。')) return;
    var list = loadColls().filter(function (c) { return String(c.id) !== String(coll.id); });
    saveColls(list);
    buildCollections(S.pack);
    renderLevelGrid();
    WB.ui.toast('合集已删除，关卡回到了「自制关卡」');
  }
  /** 把关卡收进用户自建合集（从「自制关卡」合集出发） */
  function moveLevelToColl(lv) {
    var targets = (S.collections || []).filter(function (c) { return !c.fixed && !c.server; });
    if (!targets.length) { WB.ui.toast('还没有自建合集：先点本页底部的「新建合集」', 'err'); return; }
    var target = targets[0];
    if (targets.length > 1) {
      var menu = targets.map(function (c, i) { return (i + 1) + '. ' + c.name; }).join('\n');
      var pick = parseInt(window.prompt('把「' + lv.name + '」收进哪个合集？输入序号：\n' + menu, '1'), 10);
      if (!(pick >= 1 && pick <= targets.length)) return;
      target = targets[pick - 1];
    }
    var list = loadColls();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(target.id)) {
        list[i].levelIds = list[i].levelIds || [];
        if (list[i].levelIds.map(String).indexOf(String(lv.id)) < 0) list[i].levelIds.push(lv.id);
      }
    }
    saveColls(list);
    buildCollections(S.pack);
    renderLevelGrid();
    WB.ui.toast('已把「' + lv.name + '」收进合集「' + target.name + '」', 'ok');
  }
  /** 把关卡从自建合集移回「自制关卡」合集 */
  function removeLevelFromColl(lv) {
    var list = loadColls();
    list.forEach(function (c) { c.levelIds = (c.levelIds || []).filter(function (id) { return String(id) !== String(lv.id); }); });
    saveColls(list);
    buildCollections(S.pack);
    renderLevelGrid();
    WB.ui.toast('已把「' + lv.name + '」移回「自制关卡」合集');
  }

  function renderLevelGrid() {
    var grid = $('levelGrid');
    grid.textContent = '';
    var prog = loadProgress();
    var flat = allLevels();

    (S.collections || []).forEach(function (coll) {
      var sec = document.createElement('div');
      sec.className = 'coll-sec';

      // 标题行：合集名 + 类型标签 + 操作（固定合集不给删/改；关卡制合集的关卡没有任何操作）
      var head = document.createElement('div');
      head.className = 'coll-head';
      var title = document.createElement('span');
      title.className = 'coll-name';
      title.textContent = coll.name;
      head.appendChild(title);
      var tag = document.createElement('span');
      tag.className = 'coll-tag';
      if (coll.progressive) {
        var done = coll.levels.filter(function (lv) { return prog.best[levelKey(lv)]; }).length;
        tag.textContent = '关卡制 · 逐关解锁（已通 ' + done + ' / ' + coll.levels.length + '）';
      } else if (coll.fixed) {
        tag.textContent = '固定合集 · 自由玩';
      } else {
        tag.textContent = '自建合集 · 只存在这台电脑';
      }
      head.appendChild(tag);
      if (coll.fixed) {
        var lockTag = document.createElement('span');
        lockTag.className = 'coll-tag dim';
        lockTag.textContent = '不可删除 / 改名';
        head.appendChild(lockTag);
      } else if (!coll.server) {
        var rn = document.createElement('button');
        rn.className = 'btn tiny ghost';
        rn.textContent = '改名';
        rn.onclick = function () { renameCollection(coll); };
        head.appendChild(rn);
        var del = document.createElement('button');
        del.className = 'btn tiny danger';
        del.textContent = '删除合集';
        del.onclick = function () { deleteCollection(coll); };
        head.appendChild(del);
      }
      sec.appendChild(head);

      // 关卡网格
      var body = document.createElement('div');
      body.className = 'level-grid';
      coll.levels.forEach(function (lv, k) {
        var key = levelKey(lv);
        var locked = levelLocked(lv, prog);
        var card = document.createElement('button');
        card.className = 'level-card' + (locked ? ' locked' : '') + (lv.custom ? ' custom' : '');
        var best = prog.best[key];
        card.innerHTML =
          '<div class="no">' + (lv.custom ? '自制' : ('第 ' + (k + 1) + ' 关')) + (locked ? ' · 🔒 未解锁' : '') + '</div>' +
          '<div class="nm">' + esc(lv.name) + '</div>' +
          '<div class="stars">' + difficultyStars(lv.difficulty) + '</div>' +
          '<div class="best">' + (best ? ('最好：' + best.deaths + ' 次死亡 / ' + best.time.toFixed(1) + 's') : '还没通关') + '</div>';
        if (!locked) {
          card.onclick = function () {
            WB.audio.play('click');
            startLocalGame(flat.indexOf(lv), 1);
          };
        }
        // 自由合集里的自制关卡可以移动；关卡制合集不给任何操作（改删移都没有）
        if (lv.custom && !coll.progressive) {
          var mv = document.createElement('span');
          mv.className = 'lv-op';
          if (coll.id === 'custom') {
            mv.textContent = '📥 收进合集';
            mv.title = '把这个关卡收进某个自建合集';
            mv.onclick = function (e) { e.stopPropagation(); moveLevelToColl(lv); };
          } else {
            mv.textContent = '📤 移出合集';
            mv.title = '移回「自制关卡」合集';
            mv.onclick = function (e) { e.stopPropagation(); removeLevelFromColl(lv); };
          }
          card.appendChild(mv);
        }
        body.appendChild(card);
      });
      if (!coll.levels.length) {
        var empty = document.createElement('div');
        empty.className = 'coll-empty dim small';
        empty.textContent = coll.id === 'custom'
          ? '还没有自制关卡：去「关卡编辑器」做一个，保存后会出现在这里'
          : '合集还是空的：去「自制关卡」合集里点关卡上的「收进合集」';
        body.appendChild(empty);
      }
      sec.appendChild(body);
      grid.appendChild(sec);
    });

    // 末尾：新建合集入口（默认自由开放，用户可随意改）
    var add = document.createElement('button');
    add.className = 'btn ghost block coll-add';
    add.textContent = '＋ 新建合集（自由开放，只存在这台电脑）';
    add.onclick = addCollection;
    grid.appendChild(add);
  }

  function renderLocalSetup() {
    var box = $('localLevels');
    box.textContent = '';
    var prog = loadProgress();
    allLevels().forEach(function (lv, i) {
      var b = document.createElement('button');
      var locked = levelLocked(lv, prog);
      var coll = lv._coll;
      var idx = coll ? coll.levels.indexOf(lv) : i;
      b.className = 'lv-pick' + (i === (S.localPick || 0) ? ' on' : '') + (locked ? ' locked' : '');
      b.textContent = (locked ? '🔒 ' : '') + (coll ? coll.name + ' ' : '') + (idx + 1) + '. ' + lv.name;
      if (!locked) {
        b.onclick = function () {
          WB.audio.play('click');
          S.localPick = i;
          renderLocalSetup();
        };
      }
      box.appendChild(b);
    });
    var keys = $('localKeys');
    keys.innerHTML = LOCAL_KEY_NAMES.slice(0, S.localCount || 3).map(function (t, i) {
      return '<div class="kp"><h5>P' + (i + 1) + '</h5><div>' + t + '</div></div>';
    }).join('');
  }

  function renderBestLine() {
    var prog = loadProgress();
    var basic = (S.collections || []).filter(function (c) { return c.id === 'basic'; })[0];
    var list = basic ? basic.levels : S.levels;
    var cleared = list.filter(function (lv) { return prog.best['builtin:' + lv.id]; }).length;
    $('bestLine').textContent = cleared
      ? ('已通关 ' + cleared + ' / ' + list.length + ' 关 · 下次从第 ' + Math.min(prog.unlocked, list.length) + ' 关继续')
      : '还没通关记录，从第 1 关开始吧';
  }

  /* ---------- 菜单上的小演示 ---------- */
  function preview() {
    var cv = $('previewArt');
    if (!cv || typeof cv.getContext !== 'function') return;
    var ctx = cv.getContext('2d');
    var w = 700, h = 96, t = 0;
    var squares = [
      { x: 60, y: 48, c: DC.PLAYER_COLORS[0] },
      { x: 190, y: 48, c: DC.PLAYER_COLORS[1] },
      { x: 320, y: 48, c: DC.PLAYER_COLORS[2] },
      { x: 450, y: 48, c: DC.PLAYER_COLORS[3] }
    ];
    function frame2() {
      t += 1 / 60;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(15, 23, 42, .07)';
      for (var i = 0; i < w; i += 40) { ctx.beginPath(); ctx.moveTo(i + .5, 0); ctx.lineTo(i + .5, h); ctx.stroke(); }
      for (var j = 0; j < h; j += 40) { ctx.beginPath(); ctx.moveTo(0, j + .5); ctx.lineTo(w, j + .5); ctx.stroke(); }
      // 巡逻的圆（和游戏里一样：实心平色，不发光不反光，半径用内核固定值）
      for (var k = 0; k < 3; k++) {
        var cx = 560 + k * 50;
        var cy = 48 + Math.sin(t * 1.6 + k * 1.1) * 26;
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath(); ctx.arc(cx, cy, DC.OBSTACLE_RADIUS + 4, 0, Math.PI * 2); ctx.fill();
      }
      squares.forEach(function (s, i) {
        var x = s.x + Math.sin(t * 0.9 + i * 0.7) * 26;
        ctx.fillStyle = s.c;
        squareRect(ctx, x - DC.PLAYER_SIZE / 2, s.y - DC.PLAYER_SIZE / 2, DC.PLAYER_SIZE, DC.PLAYER_SIZE);
        ctx.fill();
      });
      requestAnimationFrame(frame2);
    }
    frame2();
  }

  /* ================= 输入 ================= */
  var BLOCK = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1, Tab: 1 };
  window.addEventListener('keydown', function (e) {
    S.keyState[e.code] = true;
    if (S.screen === 'scr-game' && BLOCK[e.code]) e.preventDefault();
    if (S.screen !== 'scr-game') return;
    if (e.code === 'KeyR' && S.mode !== 'online') startLocalGame(S.levelIndex, S.players.length);
    if (e.code === 'Escape' && S.mode !== 'online') {
      S.paused = !S.paused;
      if (S.paused) {
        showOverlay('<h2>已暂停</h2><p class="osub">按 Esc 继续</p><div class="obtns"><button class="btn primary" id="ovResume">继续</button><button class="btn ghost" id="ovMenu2">回到主菜单</button></div>');
        $('ovResume').onclick = function () { S.paused = false; hideOverlay(); };
        $('ovMenu2').onclick = function () { S.paused = false; hideOverlay(); S.world = null; show('scr-menu'); };
      } else hideOverlay();
    }
  });
  window.addEventListener('keyup', function (e) { S.keyState[e.code] = false; });
  window.addEventListener('blur', function () { S.keyState = {}; });

  /* ================= 界面绑定 ================= */
  function bindUi() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-mode]'), function (b) {
      b.onclick = function () {
        WB.audio.play('click');
        var m = b.dataset.mode;
        if (m === 'single') { renderLevelGrid(); show('scr-levels'); }
        else if (m === 'local') {
          if (!S.localCount) S.localCount = 3;
          renderLocalSetup();
          show('scr-local');
        } else { show('scr-online'); }
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (b) {
      b.onclick = function () { WB.audio.play('click'); show('scr-menu'); };
    });
    $('btnSettings').onclick = WB.ui.openSettings;
    $('btnLevels').onclick = function () { WB.audio.play('click'); renderLevelGrid(); show('scr-levels'); };
    $('btnResetProgress').onclick = function () {
      saveProgress({ unlocked: 1, best: {} });
      WB.ui.toast('进度已清空');
      renderLevelGrid();
    };

    // 本地多人
    Array.prototype.forEach.call(document.querySelectorAll('#localCount .style-btn'), function (b) {
      b.onclick = function () {
        WB.audio.play('click');
        S.localCount = parseInt(b.dataset.count, 10);
        Array.prototype.forEach.call(document.querySelectorAll('#localCount .style-btn'), function (x) {
          x.classList.toggle('on', x === b);
        });
        renderLocalSetup();
      };
    });
    $('btnLocalStart').onclick = function () {
      WB.audio.play('click');
      startLocalGame(S.localPick || 0, S.localCount || 3);
    };

    // 联机
    $('btnCreateRoom').onclick = function () {
      WB.audio.play('click');
      if (S.net.status !== 'open') { WB.ui.toast('正在连接服务器…', 'err'); return; }
      S.net.send({ t: 'dodge.create', key: ME_KEY });
    };
    function doJoin() {
      var code = ($('joinCode').value || '').trim();
      if (!/^\d{4}$/.test(code)) { WB.ui.toast('请输入 4 位数字房间号', 'err'); WB.audio.play('error'); return; }
      if (S.net.status !== 'open') { WB.ui.toast('正在连接服务器…', 'err'); return; }
      WB.audio.play('click');
      S.net.send({ t: 'dodge.join', code: code, key: ME_KEY });
    }
    $('btnJoinRoom').onclick = doJoin;
    $('joinCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
    $('btnInviteFriend').onclick = function () { WB.audio.play('click'); if (WB.friends) WB.friends.openPanel(); };
    $('btnInviteFriend2').onclick = function () { WB.audio.play('click'); if (WB.friends) WB.friends.openPanel(); };
    $('btnCopyCode').onclick = function () {
      var code = $('roomCode').textContent;
      var done = function () { WB.ui.toast('房间号 ' + code + ' 已复制', 'ok'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done);
      else WB.ui.toast('房间号：' + code, 'ok');
      WB.audio.play('click');
    };
    $('btnLeaveRoom').onclick = function () {
      WB.audio.play('click');
      S.net.send({ t: 'dodge.leave' });
      WB.me.forgetRoom('dodge');    // 明确离开了，别再自动回房
      WB.Chat.leaveRoom();          // 退出房间 → 关掉本局聊天频道
      S.world = null;
      S.online = null;
      WB.Friends.refreshGame();     // 没有房间了 → 「邀请组队」收起来
      show('scr-menu');
    };
    $('btnReady').onclick = function () {
      var me = null;
      var room = S.online && S.online.room;
      if (room) me = room.members.filter(function (m) { return m.id === S.net.id; })[0];
      var next = !(me && me.ready);
      S.net.send({ t: 'dodge.ready', ready: next });
      WB.audio.play('click');
    };
    $('btnStartGame').onclick = function () { WB.audio.play('click'); S.net.send({ t: 'dodge.start' }); };

    // 对局中
    $('btnRestart').onclick = function () {
      WB.audio.play('click');
      if (S.mode === 'online') S.net.send({ t: 'dodge.restart' });
      else startLocalGame(S.levelIndex, S.players.length);
    };
    $('btnRescue').onclick = function () {
      if (S.mode === 'online') S.net.send({ t: 'dodge.rescue' });
    };
    $('btnNext').onclick = function () {
      if (S.mode === 'online') S.net.send({ t: 'dodge.next' });
    };
    $('btnQuit').onclick = function () {
      WB.audio.play('click');
      S.world = null;
      S.cleared = false;
      hideOverlay();
      if (S.mode === 'online') { S.net.send({ t: 'dodge.toLobby' }); show('scr-lobby'); }
      else { renderBestLine(); show('scr-menu'); }
    };
  }

  /* ================= 启动 ================= */
  function boot() {
    bindUi();
    initNet();
    preview();
    renderBestLine();
    fetchLevels().then(function () {
      renderLevelGrid();
      renderBestLine();
      // 通过好友邀请进入：/dodge/?join={"room":"1234"}
      var raw = '';
      try { raw = new URLSearchParams(location.search).get('join') || ''; } catch (e) { raw = ''; }
      if (raw) {
        var data = null;
        try { data = JSON.parse(raw); } catch (e) { data = { room: raw }; }
        var code = String((data && data.room) || '').trim();
        if (/^\d{4}$/.test(code)) {
          WB.ui.toast('正在通过好友邀请加入房间 ' + code + '…', 'ok');
          S.net.send({ t: 'dodge.join', code: code, key: ME_KEY });
        }
      }
    }).catch(function (e) {
      WB.ui.toast('关卡数据加载失败：' + e.message, 'err');
    });
    requestAnimationFrame(frame);
  }

  boot();
  window.__DODGE_DEBUG = { S: S, DC: DC, startLocalGame: startLocalGame, allLevels: allLevels };
})();
