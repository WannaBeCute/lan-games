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
  var CUSTOM_KEY = 'dodge.custom.levels.v1';    // 编辑器做的自制关卡

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
  function bestOf(key) { return loadProgress().best[key] || null; }
  function recordClear(key, time, deaths) {
    var p = loadProgress();
    var b = p.best[key];
    if (!b || deaths < b.deaths || (deaths === b.deaths && time < b.time)) p.best[key] = { time: time, deaths: deaths };
    saveProgress(p);
    return p;
  }

  /* ================= 关卡列表 ================= */
  function allLevels() { return S.levels.concat(S.custom); }
  function levelKey(lv) { return lv.custom ? ('custom:' + lv.id) : ('builtin:' + lv.id); }
  function difficultyStars(n) { var s = ''; for (var i = 0; i < 5; i++) s += i < n ? '★' : '☆'; return s; }

  function fetchLevels() {
    return fetch('/dodge/shared/levels.json').then(function (r) { return r.json(); }).then(function (pack) {
      S.levels = (pack.levels || []).map(function (raw) { return DC.normalizeLevel(raw); });
      S.custom = loadCustomLevels();
      S.custom.forEach(function (lv) { lv.custom = true; });
      if (!S.levels.length) throw new Error('关卡包是空的');
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
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

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

    // 圆形障碍（带发光）
    world.obstacles.forEach(function (o) {
      ctx.save();
      ctx.shadowColor = 'rgba(231, 76, 60, .5)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = '#a93226';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(o.x, o.y, o.radius - 1, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255, 255, 255, .45)';
      ctx.beginPath(); ctx.arc(o.x - o.radius * 0.3, o.y - o.radius * 0.35, o.radius * 0.28, 0, Math.PI * 2); ctx.fill();
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
      ctx.shadowBlur = p.state === 'playing' ? 14 : 0;
      roundRect(ctx, px - half, py - half, DC.PLAYER_SIZE, DC.PLAYER_SIZE, 7);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(15, 23, 42, .38)';
      ctx.lineWidth = 1.6;
      roundRect(ctx, px - half, py - half, DC.PLAYER_SIZE, DC.PLAYER_SIZE, 7);
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
    var b = document.createElement('div');
    b.style.marginBottom = '8px';
    b.textContent = '第 ' + S.levelIndex + ' 关还没开始';
    el.textContent = '';
    $('hLevel').textContent = '第 ' + (S.levelIndex + 1) + ' 关';
    $('levelHint').textContent = (lv && lv.hint) ? lv.hint : '把每个人都送进绿色终点区域（进去任意一格都算到达）。';
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
    var isFirst = S.players[0].index === 0;
    var p = recordClear(levelKey(lv), S.elapsed, S.totalDeaths);
    var best = p.best[levelKey(lv)];
    var hasNext = S.levelIndex + 1 < allLevels().length;
    if (hasNext) { p.unlocked = Math.max(p.unlocked, S.levelIndex + 2); saveProgress(p); }

    var rows = S.players.map(function (q) {
      return '<div class="r"><span class="swatch" style="background:' + q.color + '"></span>' +
        esc(q.name) + ' · 死亡 <b>' + q.deaths + '</b> 次' + (q.rescued ? ' · 被接应' : '') + '</div>';
    }).join('');

    showOverlay(
      '<h2>🎉 第 ' + (S.levelIndex + 1) + ' 关通关</h2>' +
      '<p class="osub">' + esc(lv.name) + ' · 用时 ' + S.elapsed.toFixed(1) + ' 秒 · 全队共死亡 ' + S.totalDeaths + ' 次' +
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
    if (S.mode !== 'online') $('hLevel').textContent = '第 ' + (S.levelIndex + 1) + ' 关';
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

  function initNet() {
    S.net = new WB.Net();
    WB.bindNetBadge($('netBadge'), S.net);

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
        S.net.send({ t: 'dodge.join', code: code });
      }
    });

    S.net.on('dodge.created', function (m) {
      WB.audio.play('click');
      WB.ui.toast('房间已创建：' + m.code, 'ok');
      WB.Chat.enterRoom({ game: 'dodge', code: m.code, title: '方块躲避 · 房间 ' + m.code });
      show('scr-lobby');
    });
    S.net.on('dodge.joined', function (m) {
      WB.ui.toast('已加入房间：' + m.code, 'ok');
      WB.Chat.enterRoom({ game: 'dodge', code: m.code, title: '方块躲避 · 房间 ' + m.code });
      show('scr-lobby');
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
      if (S.screen === 'scr-lobby' || m.state === 'lobby') renderLobby(m);
      else if (S.screen === 'scr-game') { /* 对局中收到大厅状态，忽略 */ }
      else renderLobby(m);
    });
    S.net.on('dodge.host', function (m) { WB.ui.toast(m.name + ' 成为新房主'); });
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
      ul.appendChild(li);
    });

    var isHost = S.net && room.hostId === S.net.id;
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

  function renderLevelGrid() {
    var grid = $('levelGrid');
    grid.textContent = '';
    var prog = loadProgress();
    allLevels().forEach(function (lv, i) {
      var key = levelKey(lv);
      var locked = !lv.custom && (i + 1) > prog.unlocked;
      var card = document.createElement('button');
      card.className = 'level-card' + (locked ? ' locked' : '') + (lv.custom ? ' custom' : '');
      var best = prog.best[key];
      card.innerHTML =
        '<div class="no">' + (lv.custom ? '自制' : ('第 ' + (i + 1) + ' 关')) + (locked ? ' · 未解锁' : '') + '</div>' +
        '<div class="nm">' + esc(lv.name) + '</div>' +
        '<div class="stars">' + difficultyStars(lv.difficulty) + '</div>' +
        '<div class="best">' + (best ? ('最好：' + best.deaths + ' 次死亡 / ' + best.time.toFixed(1) + 's') : '还没通关') + '</div>';
      if (!locked) {
        card.onclick = function () {
          WB.audio.play('click');
          startLocalGame(i, 1);
        };
      }
      grid.appendChild(card);
    });
  }

  function renderLocalSetup() {
    var box = $('localLevels');
    box.textContent = '';
    var prog = loadProgress();
    allLevels().forEach(function (lv, i) {
      var b = document.createElement('button');
      var locked = !lv.custom && (i + 1) > prog.unlocked;
      b.className = 'lv-pick' + (i === (S.localPick || 0) ? ' on' : '') + (locked ? ' locked' : '');
      b.textContent = (locked ? '🔒 ' : '') + (lv.custom ? '自制 ' : '') + (i + 1) + '. ' + lv.name;
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
    var cleared = S.levels.filter(function (lv, i) { return prog.best['builtin:' + lv.id]; }).length;
    $('bestLine').textContent = cleared
      ? ('已通关 ' + cleared + ' / ' + S.levels.length + ' 关 · 下次从第 ' + Math.min(prog.unlocked, S.levels.length) + ' 关继续')
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
      // 巡逻的圆
      for (var k = 0; k < 3; k++) {
        var cx = 560 + k * 50;
        var cy = 48 + Math.sin(t * 1.6 + k * 1.1) * 26;
        ctx.save();
        ctx.shadowColor = 'rgba(231, 76, 60, .8)';
        ctx.shadowBlur = 12;
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      squares.forEach(function (s, i) {
        var x = s.x + Math.sin(t * 0.9 + i * 0.7) * 26;
        ctx.save();
        ctx.shadowColor = s.c;
        ctx.shadowBlur = 12;
        ctx.fillStyle = s.c;
        roundRect(ctx, x - 16, s.y - 16, 32, 32, 6);
        ctx.fill();
        ctx.restore();
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
      S.net.send({ t: 'dodge.create' });
    };
    function doJoin() {
      var code = ($('joinCode').value || '').trim();
      if (!/^\d{4}$/.test(code)) { WB.ui.toast('请输入 4 位数字房间号', 'err'); WB.audio.play('error'); return; }
      if (S.net.status !== 'open') { WB.ui.toast('正在连接服务器…', 'err'); return; }
      WB.audio.play('click');
      S.net.send({ t: 'dodge.join', code: code });
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
      WB.Chat.leaveRoom();          // 退出房间 → 关掉本局聊天频道
      S.world = null;
      S.online = null;
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
          S.net.send({ t: 'dodge.join', code: code });
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
