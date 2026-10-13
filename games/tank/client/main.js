/*!
 * 坦克大战 —— 客户端主逻辑
 * 模式：单人（生存） / 本地双人（局数制） / 在线联机（4 位房间号，局数制）
 */
(function () {
  'use strict';

  var TC = window.TankCore, R = window.TankRender, WB = window.WB;
  var TILE = TC.TILE, ACC = 1 / 60;
  var END_DELAY = 2;            // 决出胜负后再等 2 秒才结算（让爆炸动画播完，也能判平局）

  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d');

  var S = {
    mode: null,            // single | local | online
    screen: 'menu',
    world: null,
    me: null,
    keyState: {},
    fx: [],
    shake: 0,
    now: 0,
    paused: false,
    single: null,
    local: null,
    room: null,
    online: null,
    net: null,
    lacc: 0,
    lastTs: 0,
    sfxBudget: 6,
    hudAcc: 0
  };

  function K(which) { return WB.settings.get().keys[which]; }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { return WB.util.el(tag, cls, html); }
  function esc(s) { return WB.util.esc(s); }

  /* ================= 画面切换 ================= */
  var SCREENS = ['scr-menu', 'scr-single', 'scr-local', 'scr-online', 'scr-lobby', 'scr-game'];
  function show(id) {
    SCREENS.forEach(function (s) { $(s).classList.toggle('hidden', s !== id); });
    S.screen = id;
    if (id === 'scr-game') { fitCanvas(); requestAnimationFrame(fitCanvas); }
  }
  function hideOverlay() { $('overlay').classList.add('hidden'); }
  function showOverlay(html) { $('overlayInner').innerHTML = html; $('overlay').classList.remove('hidden'); }

  /* ================= 画布自适应 ================= */
  var viewCols = 25, viewRows = 19;
  function fitCanvas() {
    var wrap = $('cvWrap');
    if (!wrap) return;
    var availW = Math.max(320, wrap.clientWidth || wrap.offsetWidth || 800);
    var availH = Math.max(260, window.innerHeight - 210);
    var scale = Math.min(availW / (viewCols * TILE), availH / (viewRows * TILE));
    scale = Math.min(scale, 2.2);
    var w = Math.round(viewCols * TILE * scale);
    var h = Math.round(viewRows * TILE * scale);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(w * dpr / (viewCols * TILE), 0, 0, h * dpr / (viewRows * TILE), 0, 0);
  }
  window.addEventListener('resize', fitCanvas);

  /* ================= 键盘 ================= */
  var BLOCK = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1, Tab: 1 };
  window.addEventListener('keydown', function (e) {
    S.keyState[e.code] = true;
    if (BLOCK[e.code]) e.preventDefault();
    if (e.code === 'Escape' && S.screen === 'scr-game') {
      if (S.mode === 'online') return;
      S.paused = !S.paused;
      if (S.paused) showOverlay(
        '<h2>已暂停</h2><p class="osub">按 Esc 或点击下方按钮继续</p>' +
        '<div class="obtns"><button class="btn primary" id="ovResume">继续游戏</button>' +
        '<button class="btn ghost" id="ovQuit">退出对局</button></div>'
      );
      else hideOverlay();
      bindOverlayBtns();
    }
  });
  window.addEventListener('keyup', function (e) { S.keyState[e.code] = false; });
  window.addEventListener('blur', function () { S.keyState = {}; });

  function readInput(which) {
    var k = K(which);
    return {
      up: !!S.keyState[k.up], down: !!S.keyState[k.down],
      left: !!S.keyState[k.left], right: !!S.keyState[k.right],
      fire: !!S.keyState[k.fire]
    };
  }
  function anyInput(inp) { return inp.up || inp.down || inp.left || inp.right || inp.fire; }

  /* ================= 音效 & 特效 ================= */
  function sfx(name) {
    if (S.sfxBudget <= 0) return;
    S.sfxBudget--;
    WB.audio.play(name);
  }
  function addFx(o) { o.t = 0; S.fx.push(o); if (S.fx.length > 160) S.fx.shift(); }

  function handleEvents(evs) {
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      switch (e.k) {
        case 'shoot':
          addFx({ kind: 'spark', x: e.x + TC.dirX(e.a || 0) * 17, y: e.y + TC.dirY(e.a || 0) * 17, life: 0.12 });
          sfx('shoot'); break;
        case 'brick':
          for (var d = 0; d < 4; d++) {
            addFx({
              kind: 'debris', x: e.x, y: e.y, life: 0.45,
              vx: (Math.random() - 0.5) * 130, vy: (Math.random() - 0.5) * 130,
              color: e.bush ? '#3ea864' : '#b5644a'      // 草丛被激光烧掉 → 草绿色的碎屑
            });
          }
          sfx('brick'); break;
        case 'ricochet':
          addFx({ kind: 'ricochet', x: e.x, y: e.y, life: 0.22 });
          sfx('ricochet'); break;
        case 'fade':
          addFx({ kind: 'spark', x: e.x, y: e.y, life: 0.18 });
          break;
        case 'spark': addFx({ kind: 'spark', x: e.x, y: e.y, life: 0.16 }); sfx('spark'); break;
        case 'kill':
          addFx({ kind: 'kill', x: e.x, y: e.y, life: 0.55 });
          if (e.suicide) addFx({ kind: 'text', x: e.x, y: e.y - 18, life: 1.1, text: '被自己打中！', color: '#ff8f4c' });
          S.shake = Math.max(S.shake, 6);
          sfx('kill'); break;
        case 'pickup':
          // 加命要写清楚"现在是几条"，否则玩家分不清是加了一条命还是变成了打不死
          var ptxt = (TC.PU_LABEL[e.p] || '') + (e.p === 'life'
            ? (e.full ? ' 命数已满' : ' 命数 +1（共 ' + (e.lv || 1) + ' 条）')
            : (' ' + (TC.PU_NAME[e.p] || '')));
          addFx({ kind: 'text', x: e.x, y: e.y - 16, life: e.p === 'life' ? 1.4 : 1.0, text: ptxt, color: TC.PU_COLOR[e.p] });
          addFx({ kind: 'spark', x: e.x, y: e.y, life: 0.4, color: TC.PU_COLOR[e.p] });
          sfx('pickup'); break;
        // 激光束：把整条路径画出来并淡出
        case 'laser':
          addFx({ kind: 'laser', x: e.x, y: e.y, a: e.a, len: e.len || 0, life: 0.36, color: TC.PU_COLOR.laser });
          S.shake = Math.max(S.shake, 4);
          sfx('ricochet'); break;
        // 草丛被子弹打薄 / 被激光烧掉
        case 'bushcut':
          for (var q = 0; q < (e.hard ? 6 : 3); q++) {
            addFx({
              kind: 'debris', x: e.x, y: e.y, life: 0.4,
              vx: (Math.random() - 0.5) * 110, vy: (Math.random() - 0.5) * 110,
              color: e.hard ? '#57b878' : '#3e8f5e'
            });
          }
          sfx('brick'); break;
        // 隐身被打断（开火或捡到别的道具）
        case 'reveal':
          addFx({ kind: 'text', x: e.x, y: e.y - 18, life: 0.8, text: '👻 现形', color: TC.PU_COLOR.stealth });
          sfx('spawn'); break;
        // 护盾挡下一颗子弹（护盾随即消失）
        case 'shield':
          addFx({ kind: 'shield', x: e.x, y: e.y, life: 0.4, id: e.id });
          addFx({ kind: 'text', x: e.x, y: e.y - 18, life: 0.85, text: '🛡 护盾挡下', color: TC.PU_COLOR.shield });
          sfx('spark'); break;
        case 'spawn-pu': sfx('invite'); break;
        case 'spawn': sfx('spawn'); break;
      }
    }
  }
  function updateFx(dt) {
    for (var i = S.fx.length - 1; i >= 0; i--) {
      S.fx[i].t += dt;
      if (S.fx[i].t >= S.fx[i].life) S.fx.splice(i, 1);
    }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt * 26);
  }

  /* ================= 通用渲染 ================= */
  function tankView(t, isMe) {
    var stealth = (t.power && t.power.stealth > 0) ? 1 : 0;
    var bush = TC.inBush(S.world, t);
    return {
      id: t.id, x: t.x, y: t.y, angle: t.angle, alive: t.alive,
      color: t.color, style: t.style, name: t.name,
      invuln: t.invuln, shield: t.power ? t.power.shield : (t.shield || 0),
      laser: t.power ? (t.power.laser || 0) : 0,
      stealth: stealth,
      // 隐身：自己画成半透明的"幽灵"，别人（同屏）画得更淡
      alpha: stealth ? (isMe ? 0.32 : 0.16) : 1,
      // 草丛里：自己会被半透明补画在草丛之上（不然被草全盖住，看不见自己）
      inBush: bush,
      // 草丛里一律不画头顶名字 —— 名字浮在草上方会把位置暴露出去
      isMe: !!isMe, showName: !bush
    };
  }

  function drawFrame() {
    var view = S.mode === 'online' ? buildOnlineView() : buildLocalView();
    if (!view) return;
    ctx.save();
    if (S.shake > 0.4) ctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);
    R.draw(ctx, view);
    ctx.restore();
  }

  function buildLocalView() {
    var w = S.world;
    if (!w) return null;
    var tanks = [];
    for (var i = 0; i < w.tanks.length; i++) {
      var t = w.tanks[i];
      tanks.push(tankView(t, S.mode === 'single' ? t === S.me : true));
    }
    return {
      cols: w.cols, rows: w.rows, tiles: w.tiles,
      tanks: tanks,
      bullets: w.bullets,
      powerups: w.powerups,
      fx: S.fx, now: S.now, freeze: w.freeze,
      roundIndex: S.mode === 'local' ? S.local.index : 1,
      roundTotal: S.mode === 'local' ? S.local.rounds : 1
    };
  }

  /* ================= 单人：生存模式 ================= */
  var BEST_KEY = 'wb.tank.best.';

  /** 读「每局生命数」输入框（1~5，默认 1） */
  function readLives(id) {
    var el = $(id);
    var n = parseInt(el && el.value, 10);
    if (!isFinite(n)) n = TC.LIVES_DEFAULT || 1;
    return Math.max(1, Math.min(TC.MAX_LIVES || 5, n));
  }

  function startSingle(level) {
    S.mode = 'single';
    S.paused = false;            // 别把上一局的暂停状态带进新对局
    // 难度决定「同屏 AI 上限」：简单 4 / 普通 5 / 困难 6。
    // 以前是 3/4/5，而且出生点只够 3 个 AI，所以经常"到 4 个就不动了"。
    var cap = [4, 5, 6][level];
    S.single = { level: level, cap: cap, waveTimer: 0.4, nextId: 100, colorIdx: 0, score: 0, over: false, overTimer: 0 };
    viewCols = 25; viewRows = 19;
    // 出生点要够用：1 个给玩家 + cap 个给 AI（内核最多支持 8 个出生点）
    var w = TC.createWorld({ cols: 25, rows: 19, seed: (Math.random() * 1e9) | 0, tankSlots: cap + 1, freeze: 1.6 });
    S.world = w;
    // 玩家固定占最后一个出生点，其余出生点全留给 AI
    S.me = TC.addTank(w, {
      id: 1, slot: w.spawns.length - 1, name: WB.playerName(), color: '#4c8dff', style: 'classic', lives: readLives('singleLives')
    });
    S.me.invuln = 2.5;
    S.local = null;
    singleSpawnBot();            // 开局立刻放一个 AI 进来，别让玩家干等
    hideOverlay();
    show('scr-game');
    $('hMode').textContent = '单人 · ' + ['简单', '普通', '困难'][level];
    fitCanvas();
  }

  /**
   * 在某个空闲出生点放一个 AI，返回是否放成功。
   * 玩家固定占最后一个出生点，AI 只能用 0 ~ 倒数第二个 —— 所以同屏 AI 数量上限
   * 就等于「出生点数量 - 1」，跟 cap 对齐（不能再写死 3 个，否则到 3~4 个就生不出来了）。
   */
  function singleSpawnBot() {
    var w = S.world, s = S.single;
    var playerSlot = w.spawns.length - 1;
    var used = {};
    for (var i = 0; i < w.tanks.length; i++) {
      var tk = w.tanks[i];
      if (tk.slot === playerSlot) continue;          // 玩家那个出生点不参与 AI 分配
      if (tk.alive || tk.lives > 0) used[tk.slot] = 1;
    }
    var free = [];
    for (var k = 0; k < playerSlot; k++) if (!used[k]) free.push(k);
    if (!free.length) return false;
    var slot = free[Math.floor(Math.random() * free.length)];
    var id = s.nextId++;
    var t = TC.addTank(w, {
      id: id, slot: slot, name: 'AI-' + (id - 99),
      color: TC.TANK_COLORS[(s.colorIdx + 1) % TC.TANK_COLORS.length],
      style: TC.TANK_STYLES[s.colorIdx % TC.TANK_STYLES.length],
      lives: 1, bot: TC.makeBot(s.level)
    });
    s.colorIdx++;
    t.invuln = 1.2;
    return true;
  }

  function stepSingle(dt) {
    var w = S.world, s = S.single, i;
    S.lacc += dt;
    var guard = 0;
    while (S.lacc >= ACC && guard++ < 6) {
      if (!s.over) {
        if (S.me && S.me.lives > 0) {
          var inp = readInput('p1');
          S.me.input.up = inp.up; S.me.input.down = inp.down;
          S.me.input.left = inp.left; S.me.input.right = inp.right;
          S.me.input.fire = inp.fire;
        }
        TC.stepWorld(w, ACC);
        handleEvents(TC.flushEvents(w));
      }
      S.lacc -= ACC;

      // 清理阵亡的 AI（立刻移除，别让尸体占着出生点拖慢补充），补充新 AI
      if (!s.over) {
        for (i = w.tanks.length - 1; i >= 0; i--) {
          var t = w.tanks[i];
          if (t.bot && !t.alive && t.lives <= 0) {
            w.tanks.splice(i, 1);
            s.waveTimer = 0.5 + Math.random() * 0.5;   // 死了很快补一个，不留空窗
          }
        }
        var alive = 0;
        for (i = 0; i < w.tanks.length; i++) if (w.tanks[i].bot) alive++;
        // 同屏 AI 目标数：每 10 秒 +1（以前 22 秒太慢），涨到该难度的上限为止
        var want = Math.min(s.cap, 1 + Math.floor(w.time / 10));
        s.waveTimer -= ACC;
        if (alive < want && s.waveTimer <= 0) { singleSpawnBot(); s.waveTimer = 0.7 + Math.random() * 0.7; }

        if (S.me && S.me.lives <= 0 && !S.me.alive) {
          s.over = true; s.overTimer = 1.4;
        }
      } else {
        s.overTimer -= ACC;
        if (s.overTimer <= 0 && s.overTimer > -99) {
          s.overTimer = -100;
          var best = parseInt(localStorage.getItem(BEST_KEY + s.level) || '0', 10);
          var record = S.me.kills > best;
          if (record) { try { localStorage.setItem(BEST_KEY + s.level, String(S.me.kills)); } catch (e) { /* noop */ } }
          showOverlay(
            '<h2>' + (record ? '新纪录！' : '对局结束') + '</h2>' +
            '<p class="osub">你击毁了 <b>' + S.me.kills + '</b> 辆坦克' + (record ? '，打破了自己的最高纪录' : '，历史最高 ' + best) + '</p>' +
            '<div class="big-count">' + S.me.kills + '</div>' +
            '<div class="obtns">' +
              '<button class="btn primary" id="ovAgain">再来一局</button>' +
              '<button class="btn ghost" id="ovBack">返回主菜单</button>' +
            '</div>'
          );
          bindOverlayBtns();
          WB.audio.play(record ? 'win' : 'lose');
        }
      }
    }
    updateHudSingle();
  }

  /* ================= 本地双人（局数制） ================= */
  function localRank(tanks) {
    var arr = tanks.map(function (t) {
      return { id: t.id, name: t.name, color: t.color, kills: t.kills, deaths: t.deaths, lives: t.lives, alive: t.alive };
    });
    arr.sort(function (a, b) {
      var sa = (a.alive || a.lives > 0) ? 1 : 0, sb = (b.alive || b.lives > 0) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      if (a.lives !== b.lives) return b.lives - a.lives;
      if (a.kills !== b.kills) return b.kills - a.kills;
      return a.deaths - b.deaths;
    });
    return arr;
  }

  function startLocal(rounds) {
    S.mode = 'local';
    S.paused = false;            // 同上
    viewCols = 25; viewRows = 19;
    S.local = {
      rounds: rounds, lives: readLives('localLives'), index: 0, state: 'play', inter: 0, time: 0, endTimer: 0,
      scores: [{ wins: 0, kills: 0, deaths: 0 }, { wins: 0, kills: 0, deaths: 0 }]
    };
    $('hMode').textContent = '本地双人';
    show('scr-game');
    hideOverlay();
    localStartRound();
  }

  function localStartRound() {
    var L = S.local;
    L.index++;
    L.state = 'play';
    L.time = 0;
    L.endTimer = 0;
    var w = TC.createWorld({ cols: 25, rows: 19, seed: (Math.random() * 1e9) | 0, tankSlots: 2, freeze: 1.6 });
    S.world = w;
    // 每局生命数由开局设置决定（默认 1 条）
    TC.addTank(w, { id: 1, slot: 0, name: 'P1', color: '#4c8dff', style: 'classic', lives: L.lives || 1 });
    TC.addTank(w, { id: 2, slot: 1, name: 'P2', color: '#ff5d6c', style: 'stripe', lives: L.lives || 1 });
    hideOverlay();
    fitCanvas();
  }

  function localEndRound() {
    var L = S.local, w = S.world;
    w.state = 'over';
    L.state = 'inter';
    L.inter = 3;                 // 局间 3 秒

    var ranked = localRank(w.tanks);
    var winner = null;
    if (ranked.length) {
      var key = function (x) { return [(x.alive || x.lives > 0) ? 1 : 0, x.lives, x.kills, -x.deaths].join(','); };
      if (!ranked[1] || key(ranked[0]) !== key(ranked[1])) winner = ranked[0];
    }
    for (var i = 0; i < ranked.length; i++) {
      var sc = L.scores[ranked[i].id - 1];
      sc.kills += ranked[i].kills;
      sc.deaths += ranked[i].deaths;
      if (winner && winner.id === ranked[i].id) sc.wins += 1;
    }
    S.lastRanked = ranked;
    // 记下胜者（横幅要画出这辆车），并列时置空表示流局
    var wt = winner ? findLocalTank(winner.id) : null;
    L.lastWinner = winner ? {
      id: winner.id, name: winner.name,
      color: (wt && wt.color) || winner.color, style: (wt && wt.style) || 'classic'
    } : null;
    WB.audio.play(winner ? 'win' : 'error');
  }

  function localInterTick(dt) {
    var L = S.local;
    L.inter -= dt;
    var next = L.index < L.rounds;
    if (L.inter > 0) {
      showOverlay(
        '<h2>第 ' + L.index + ' / ' + L.rounds + ' 局结束</h2>' +
        winnerBannerHtml(L.lastWinner, '', null, '本局胜者') +
        awardHtml(S.lastRanked) +
        roundRankHtml(S.lastRanked, null) +
        '<p class="osub">' + (next ? '下一局将在 ' : '结算中 ') + '<b>' + Math.ceil(L.inter) + '</b> 秒后开始</p>'
      );
      paintBannerTank(L.lastWinner);
      return;
    }
    if (!next) { localFinish(); return; }
    localStartRound();
  }

  function findLocalTank(id) {
    var w = S.world;
    if (!w) return null;
    for (var i = 0; i < w.tanks.length; i++) if (w.tanks[i].id === id) return w.tanks[i];
    return null;
  }

  function localFinish() {
    var L = S.local;
    var order = [0, 1].map(function (i) {
      return {
        id: i + 1, name: i === 0 ? 'P1' : 'P2',
        color: i === 0 ? '#4c8dff' : '#ff5d6c',
        wins: L.scores[i].wins, kills: L.scores[i].kills, deaths: L.scores[i].deaths
      };
    }).sort(function (a, b) { return (b.wins - a.wins) || (b.kills - a.kills) || (a.deaths - b.deaths); });
    L.state = 'over';
    WB.audio.play('win');
    var champ = order[0] ? findLocalTank(order[0].id) : null;
    var champArt = order[0] ? {
      id: order[0].id, name: order[0].name,
      color: (champ && champ.color) || order[0].color, style: (champ && champ.style) || 'classic'
    } : null;
    showOverlay(
      '<h2>全部 ' + L.rounds + ' 局已结束</h2>' +
      winnerBannerHtml(champArt, order[0] ? (order[0].wins + ' 胜 · ' + order[0].kills + ' 杀') : '', null, '总冠军') +
      awardHtml(order) +
      '<p class="osub">最终排名（先比胜场，再比击杀，死亡少者靠前）</p>' +
      standingsHtml(order, null) +
      '<div class="obtns">' +
        '<button class="btn primary" id="ovAgain">再战 ' + L.rounds + ' 局</button>' +
        '<button class="btn ghost" id="ovBack">返回主菜单</button>' +
      '</div>'
    );
    paintBannerTank(champArt);
    bindOverlayBtns();
  }

  function stepLocalMatch(dt) {
    var L = S.local, w = S.world;
    // 全部局数打完后就别再 tick 了：以前这里会每一帧都重画一次结算浮层，
    // 按钮被反复重建，点"再战"有时会点空，看起来就像"重新进游戏没反应/画面没了"
    if (L.state === 'over') return;
    if (L.state === 'inter') { localInterTick(dt); return; }
    S.lacc += dt;
    var guard = 0;
    while (S.lacc >= ACC && guard++ < 6) {
      var p1 = w.tanks[0], p2 = w.tanks[1];
      if (p1) { var i1 = readInput('p1'); p1.input.up = i1.up; p1.input.down = i1.down; p1.input.left = i1.left; p1.input.right = i1.right; p1.input.fire = i1.fire; }
      if (p2) { var i2 = readInput('p2'); p2.input.up = i2.up; p2.input.down = i2.down; p2.input.left = i2.left; p2.input.right = i2.right; p2.input.fire = i2.fire; }
      TC.stepWorld(w, ACC);
      handleEvents(TC.flushEvents(w));
      S.lacc -= ACC;
      L.time += ACC;
      // 决出胜负后也等 2 秒再结算：让爆炸动画播完，也给"同归于尽"留出判平局的机会
      if (L.endTimer > 0) {
        L.endTimer -= ACC;
        if (L.endTimer <= 0) { L.endTimer = 0; localEndRound(); break; }
        continue;
      }
      if (TC.contenders(w).length <= 1 || L.time >= TC.ROUND_LIMIT) L.endTimer = END_DELAY;
    }
  }

  /* ================= 在线联机 ================= */
  function decodeTiles(b64, n) {
    var bin = atob(b64);
    var arr = new Uint8Array(n);
    for (var i = 0; i < n; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function startOnlineSession() {
    S.mode = 'online';
    S.online = {
      tiles: null, cols: 25, rows: 19, players: [], myTankId: 0, myId: 0,
      buf: [], me: null, freeze: 0, time: 0, limit: TC.ROUND_LIMIT,
      roundIndex: 1, roundTotal: 20, running: false,
      lastSig: '', lastSent: -1, input: { up: 0, down: 0, left: 0, right: 0, fire: 0 }
    };
  }

  function onNetRound(msg) {
    if (!S.online) startOnlineSession();      // 兜底：确保会话对象一定存在
    S.paused = false;
    var o = S.online;
    o.cols = msg.cols; o.rows = msg.rows;
    o.tiles = decodeTiles(msg.tiles, msg.cols * msg.rows);
    o.players = msg.players;
    o.roundIndex = msg.index; o.roundTotal = msg.total;
    o.lives = msg.lives || 1;
    o.freeze = msg.freeze;
    o.buf = [];
    o.me = null;
    o.running = true;
    o.myTankId = 1000 + S.net.id;
    viewCols = msg.cols; viewRows = msg.rows;
    hideOverlay();
    show('scr-game');
    fitCanvas();
    WB.audio.play('go');
  }

  function tankById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === id) return list[i];
    return null;
  }

  function onNetState(msg) {
    if (!S.online) return;                     // 还没进入联机会话，忽略
    var o = S.online;
    if (!o.running) return;
    o.buf.push({ rt: S.now, tks: msg.tks, bl: msg.bl, pu: msg.pu });
    if (o.buf.length > 14) o.buf.shift();
    o.freeze = msg.freeze; o.time = msg.time; o.limit = msg.limit;
    // 服务端打掉的墙要跟着消失，否则那些砖块会变成"看得见、穿得过的假墙"
    if (msg.d && msg.d.length && o.tiles) {
      // 现在是 [索引, 新值, 索引, 新值...] 成对下发：
      // 砖墙/钢墙被毁是 0，而草丛被打薄是 5（稀疏草丛），所以要按值写入
      for (var di = 0; di + 1 < msg.d.length; di += 2) o.tiles[msg.d[di]] = msg.d[di + 1];
    }
    if (msg.ev && msg.ev.length) handleEvents(msg.ev);

    var info = tankById(msg.tks, o.myTankId);
    if (!info) return;
    if (!o.me) o.me = { id: o.myTankId, x: info[1], y: info[2], angle: info[3], alive: info[4] === 1, power: {} };
    var alive = info[4] === 1;
    if (alive && !o.me.alive) { o.me.x = info[1]; o.me.y = info[2]; o.me.angle = info[3]; }
    if (!alive) { o.me.x = info[1]; o.me.y = info[2]; }
    o.me.alive = alive;
    o.me.lives = info[5];
    o.me.invuln = info[6];
    o.me.kills = info[7];
    o.me.deaths = info[8];
    o.me.power = {
      speed: info[9], rapid: info[10], triple: info[11], power: info[12], shield: info[13],
      laser: info[14] || 0, stealth: info[15] || 0
    };
    if (alive) {
      var dx = info[1] - o.me.x, dy = info[2] - o.me.y;
      var err = Math.sqrt(dx * dx + dy * dy);
      if (err > 24) { o.me.x = info[1]; o.me.y = info[2]; o.me.angle = info[3]; }
      else if (err > 0.5) { o.me.x += dx * 0.35; o.me.y += dy * 0.35; }
    }
  }

  function proxyWorld(o, snap) {
    var tanks = [];
    if (snap) {
      for (var i = 0; i < snap.tks.length; i++) {
        tanks.push({ id: snap.tks[i][0], x: snap.tks[i][1], y: snap.tks[i][2], alive: snap.tks[i][4] === 1 });
      }
    }
    return { cols: o.cols, rows: o.rows, tiles: o.tiles, tanks: tanks };
  }

  function stepOnline(dt) {
    var o = S.online;
    if (!o || !o.running) return;
    var inp = readInput('p1');
    // 上报输入（变化即发，另每 300ms 兜底重发）
    var sig = (inp.up ? 1 : 0) + '' + (inp.down ? 1 : 0) + (inp.left ? 1 : 0) + (inp.right ? 1 : 0) + (inp.fire ? 1 : 0);
    if (sig !== o.lastSig || S.now - o.lastSent > 0.3) {
      o.lastSig = sig; o.lastSent = S.now;
      S.net.send({ t: 'tank.input', up: inp.up, down: inp.down, left: inp.left, right: inp.right, fire: inp.fire });
    }

    // 本地预测自己的坦克（服务端权威 + 客户端即时响应）
    if (o.me) {
      if (o.me.alive && o.freeze <= 0) {
        var snap = o.buf[o.buf.length - 1];
        var mt = {
          id: o.myTankId, x: o.me.x, y: o.me.y, angle: o.me.angle,
          power: o.me.power || {}, input: inp
        };
        TC.moveTank(proxyWorld(o, snap), mt, dt);
        o.me.x = mt.x; o.me.y = mt.y; o.me.angle = mt.angle;
      }
    }
  }

  function buildOnlineView() {
    var o = S.online;
    if (!o || !o.tiles) return null;
    var buf = o.buf;
    var DELAY = 0.055;
    var rt = S.now - DELAY;
    var a = null, b = null, i;

    for (i = buf.length - 1; i >= 0; i--) {
      if (buf[i].rt <= rt) { a = buf[i]; b = buf[i + 1] || null; break; }
    }
    if (!a) { a = buf[0] || null; b = buf[1] || null; }
    if (!a) return null;

    var alpha = 0, extrap = 0;
    if (b) alpha = Math.max(0, Math.min(1, (rt - a.rt) / Math.max(0.001, b.rt - a.rt)));
    else extrap = Math.max(0, Math.min(0.1, rt - a.rt));

    var ref = b || a;
    var prev = b ? a : null;
    var tanks = [];
    for (i = 0; i < ref.tks.length; i++) {
      var tk = ref.tks[i];
      var id = tk[0];
      var x = tk[1], y = tk[2], ang = tk[3];
      var p = prev ? tankById(prev.tks, id) : null;
      if (p && p[4] === 1 && tk[4] === 1) {
        x = p[1] + (tk[1] - p[1]) * alpha;
        y = p[2] + (tk[2] - p[2]) * alpha;
        ang = tk[3];
      } else if (!p && extrap) {
        x += TC.dirX(tk[3]) * TC.TANK_SPEED * extrap;
        y += TC.dirY(tk[3]) * TC.TANK_SPEED * extrap;
      }
      var meta = null;
      for (var m = 0; m < o.players.length; m++) if (o.players[m].id === id - 1000 || o.players[m].id === id) { meta = o.players[m]; break; }
      var isMe = id === o.myTankId;
      if (isMe && o.me) { x = o.me.x; y = o.me.y; ang = o.me.angle; }
      tanks.push({
        id: id, x: x, y: y, angle: ang,
        alive: isMe && o.me ? o.me.alive : tk[4] === 1,
        color: meta ? meta.color : '#8a94a8',
        style: meta ? meta.style : 'classic',
        name: (meta ? meta.name : '?') + (isMe ? '（我）' : ''),
        invuln: isMe && o.me ? o.me.invuln : tk[6],
        shield: isMe && o.me ? (o.me.power.shield || 0) : tk[13],
        laser: isMe && o.me ? (o.me.power.laser || 0) : (tk[14] || 0),
        stealth: isMe && o.me ? (o.me.power.stealth || 0) : (tk[15] || 0),
        alpha: (isMe && o.me && o.me.power.stealth > 0) ? 0.32 : 1,
        // 草丛是正常遮挡：草画在坦克上面。自己额外半透明补画一层（不然看不到自己）
        inBush: o.tiles[Math.floor(y / TILE) * o.cols + Math.floor(x / TILE)] === TC.BUSH,
        // 在草丛里就藏起头顶名字（名字会浮在草上方）
        isMe: isMe, showName: o.tiles[Math.floor(y / TILE) * o.cols + Math.floor(x / TILE)] !== TC.BUSH
      });
    }

    // 子弹插值
    var bullets = [];
    for (i = 0; i < ref.bl.length; i++) {
      var bl = ref.bl[i];
      var bx = bl[0], by = bl[1];
      if (prev) {
        var best = null, bd = 44;
        for (var j = 0; j < prev.bl.length; j++) {
          var pb = prev.bl[j];
          if (pb[3] !== bl[3]) continue;
          var dd = Math.sqrt((pb[0] - bl[0]) * (pb[0] - bl[0]) + (pb[1] - bl[1]) * (pb[1] - bl[1]));
          if (dd < bd) { bd = dd; best = pb; }
        }
        if (best) { bx = best[0] + (bl[0] - best[0]) * alpha; by = best[1] + (bl[1] - best[1]) * alpha; }
      } else if (extrap) {
        bx += TC.dirX(bl[2]) * TC.BULLET_SPEED * extrap;
        by += TC.dirY(bl[2]) * TC.BULLET_SPEED * extrap;
      }
      bullets.push({ x: bx, y: by, power: bl[4] === 1 });
    }

    var pus = [];
    for (i = 0; i < ref.pu.length; i++) {
      pus.push({ x: ref.pu[i][0], y: ref.pu[i][1], type: ref.pu[i][2] });
    }

    return {
      cols: o.cols, rows: o.rows, tiles: o.tiles,
      tanks: tanks, bullets: bullets, powerups: pus,
      fx: S.fx, now: S.now, freeze: o.freeze,
      roundIndex: o.roundIndex, roundTotal: o.roundTotal
    };
  }

  /* ================= HUD ================= */
  function fmtTime(s) {
    s = Math.max(0, Math.ceil(s));
    var m = Math.floor(s / 60);
    return m + ':' + ('0' + (s % 60)).slice(-2);
  }

  /** 生效中的技能签名（用于让 HUD 在捡到道具的那一刻就刷新，而不是等下一秒） */
  function powerSig(p) {
    if (!p) return '';
    var s = '';
    for (var k in p) if (p[k] > 0) s += k + Math.ceil(p[k]);
    return s;
  }
  var lastHudKey = '';
  function updateHud() {
    var key;
    if (S.mode === 'single') key = 's' + S.me.kills + S.me.lives + Math.ceil(S.world.time) + powerSig(S.me.power);
    else if (S.mode === 'local') key = 'l' + S.local.index + Math.ceil(S.local.time) + JSON.stringify(S.local.scores) +
      powerSig(S.world.tanks[0] && S.world.tanks[0].power);
    else key = 'o' + (S.online ? S.online.roundIndex + Math.ceil(S.online.time) +
      (S.online.me ? S.online.me.kills + S.online.me.lives + powerSig(S.online.me.power) : '') : '');
    if (key === lastHudKey) return;
    lastHudKey = key;

    if (S.mode === 'single') {
      $('hRound').textContent = '生存模式';
      $('hTimer').textContent = '⏱ ' + fmtTime(S.world.time);
      $('hLives').textContent = hearts(S.me.lives);
      $('hKills').textContent = '击杀 ' + S.me.kills;
      $('scoreList').innerHTML = '<li><span class="rk g">1</span><span class="dot" style="background:#4c8dff"></span>' +
        '<span class="nm me">' + esc(WB.playerName()) + '</span><span class="sc">击杀 <b>' + S.me.kills + '</b> · 死亡 <b>' + S.me.deaths + '</b></span></li>';
      updatePowerList(S.me.power);
    } else if (S.mode === 'local') {
      var L = S.local;
      $('hRound').textContent = '第 ' + L.index + ' / ' + L.rounds + ' 局';
      $('hTimer').textContent = '⏱ ' + fmtTime(TC.ROUND_LIMIT - L.time);
      var p1 = S.world.tanks[0], p2 = S.world.tanks[1];
      $('hLives').textContent = 'P1 ' + hearts(p1 ? p1.lives : 0) + '  P2 ' + hearts(p2 ? p2.lives : 0);
      $('hKills').textContent = (p1 ? p1.kills : 0) + ' : ' + (p2 ? p2.kills : 0);
      $('scoreList').innerHTML = L.scores.map(function (s, i) {
        return '<li><span class="rk' + (i === 0 ? ' g' : '') + '">' + (i + 1) + '</span>' +
          '<span class="dot" style="background:' + (i === 0 ? '#4c8dff' : '#ff5d6c') + '"></span>' +
          '<span class="nm">P' + (i + 1) + '</span>' +
          '<span class="sc">胜 <b>' + s.wins + '</b> · 杀 <b>' + s.kills + '</b> · 死 <b>' + s.deaths + '</b></span></li>';
      }).join('');
      updatePowerList(p1 && p1.power);
    } else if (S.mode === 'online' && S.online) {
      var o = S.online;
      $('hRound').textContent = '第 ' + o.roundIndex + ' / ' + o.roundTotal + ' 局' +
        ((o.lives || 1) > 1 ? ' · 每局 ' + o.lives + ' 命' : '');
      $('hTimer').textContent = '⏱ ' + fmtTime(o.limit - o.time);
      $('hLives').textContent = o.me ? hearts(o.me.lives) : '—';
      $('hKills').textContent = '击杀 ' + (o.me ? o.me.kills : 0) + ' · 死亡 ' + (o.me ? o.me.deaths : 0);
      updatePowerList(o.me && o.me.power);
      if (S.room) renderScoreboard(S.room);
    }
  }
  function hearts(n) {
    n = Math.max(0, n | 0);
    if (n > 6) return '❤×' + n;
    return new Array(n + 1).join('❤') || '—';
  }

  function updatePowerList(p) {
    var box = $('powerList');
    if (!p) { box.innerHTML = '<li class="dim">暂无</li>'; return; }
    var items = [];
    (TC.powerupTypes ? TC.powerupTypes(S.world) : TC.POWERUP_TYPES).forEach(function (t) {
      if (t === 'life') return;                 // 加命是即时生效的，没有持续时间，不进列表
      var v = p[t] || 0;
      if (v <= 0) return;
      var max = TC.DURATION[t] || 18;
      // 激光是一次性的，写"×1（射完失效）"比倒计时更能说明问题
      var right = t === 'shield' ? ('挡 1 发 · ' + Math.ceil(v) + 's')
        : (t === 'laser' ? ('×1 · ' + Math.ceil(v) + 's 内有效') : (Math.ceil(v) + 's'));
      // 图标 + 名称 + 一句话作用 + 剩余时间（不用悬停也能看懂）
      items.push('<li>' +
        '<span class="pu-main">' +
          '<span class="pn icon" style="color:' + TC.PU_COLOR[t] + '">' + TC.PU_LABEL[t] + '</span>' +
          '<span class="pu-name" style="color:' + TC.PU_COLOR[t] + '">' + esc(TC.PU_NAME[t]) + '</span>' +
          '<span class="bar"><i style="width:' + Math.round(Math.min(1, v / max) * 100) + '%;background:' + TC.PU_COLOR[t] + '"></i></span>' +
          '<span class="mono">' + right + '</span>' +
        '</span>' +
        '<span class="pu-desc">' + esc((TC.PU_DESC && TC.PU_DESC[t]) || '') + '</span>' +
        '</li>');
    });
    box.innerHTML = items.length ? items.join('') : '<li class="dim">暂无（对局一段时间后随机掉落）</li>';
  }

  function updateHudSingle() { updateHud(); }

  function rankHtml(list, meKey) {
    return '<ul class="rank-list">' + list.map(function (r, i) {
      var pos = ['🥇', '🥈', '🥉', '4'][i] || (i + 1);
      return '<li class="' + (i === 0 ? 'top ' : '') + (meKey != null && r.id === meKey ? 'me' : '') + '">' +
        '<span class="pos">' + pos + '</span>' +
        '<span class="dot" style="background:' + esc(r.color || '#888') + '"></span>' +
        '<span class="nm">' + esc(r.name) + '</span>' +
        '<span class="detail">击杀 ' + r.kills + ' · 死亡 ' + r.deaths + '</span></li>';
    }).join('') + '</ul>';
  }
  function roundRankHtml(list, meKey) { return rankHtml(list || [], meKey); }

  /** 中间的「胜者」横幅：画出获胜的那辆坦克 + 玩家名 */
  function winnerBannerHtml(winner, subtitle, meKey, tagText) {
    if (!winner) {
      return '<div class="winner-banner draw">' +
        '<div class="wb-vs">平局</div>' +
        '<h3>本局流局（并列）</h3>' +
        (subtitle ? '<p class="osub">' + esc(subtitle) + '</p>' : '') + '</div>';
    }
    var mine = meKey != null && winner.id === meKey;
    return '<div class="winner-banner' + (mine ? ' me' : '') + '">' +
      '<canvas class="wb-tank" id="wbTankArt" width="132" height="132"></canvas>' +
      '<h3>' + esc(winner.name) + (mine ? '（你）' : '') + '</h3>' +
      '<div class="wb-tag">' + esc(tagText || '本局胜者') + '</div>' +
      (subtitle ? '<p class="osub">' + esc(subtitle) + '</p>' : '') +
      '</div>';
  }

  /** 把获胜坦克画到横幅里的画布上（必须在 showOverlay 之后调用） */
  function paintBannerTank(winner) {
    var cv = $('wbTankArt');
    if (!cv || !winner || !cv.getContext) return;
    var c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    c.save();
    c.translate(cv.width / 2, cv.height / 2 + 6);
    c.scale(3.2, 3.2);
    R.drawTank(c, {
      x: 0, y: 0, angle: 0, alive: true,
      color: winner.color || '#4c8dff', style: winner.style || 'classic',
      invuln: 0, shield: 0, showName: false
    }, performance.now() / 1000);
    c.restore();
  }

  /** 击杀榜第一（并列取死亡少的） */
  function killLeader(list) {
    var best = null;
    (list || []).forEach(function (r) {
      if (!best) { best = r; return; }
      if ((r.kills || 0) > (best.kills || 0)) best = r;
      else if ((r.kills || 0) === (best.kills || 0) && (r.deaths || 0) < (best.deaths || 0)) best = r;
    });
    return best;
  }

  function awardHtml(list) {
    var k = killLeader(list);
    if (!k || !(k.kills > 0)) return '';
    return '<div class="wb-award"><span class="ic">🎯</span>击杀榜第一<b>' + esc(k.name) + '</b>' +
      '<span class="dim">' + k.kills + ' 杀 · 死亡 ' + (k.deaths || 0) + '</span></div>';
  }

  function standingsHtml(list, meKey) {
    return '<ul class="rank-list">' + list.map(function (r, i) {
      var pos = ['🥇', '🥈', '🥉', '4'][i] || (i + 1);
      return '<li class="' + (i === 0 ? 'top ' : '') + (meKey != null && r.id === meKey ? 'me' : '') + '">' +
        '<span class="pos">' + pos + '</span>' +
        '<span class="dot" style="background:' + esc(r.color || '#888') + '"></span>' +
        '<span class="nm">' + esc(r.name) + '</span>' +
        '<span class="detail">胜场 <b>' + r.wins + '</b> · 击杀 ' + r.kills + ' · 死亡 ' + r.deaths + '</span></li>';
    }).join('') + '</ul>';
  }

  function renderScoreboard(room) {
    var meKey = null;
    $('scoreList').innerHTML = room.members.map(function (m, i) {
      var me = m.id === S.net.id;
      return '<li><span class="rk' + (i === 0 ? ' g' : '') + '">' + (i + 1) + '</span>' +
        '<span class="dot" style="background:' + esc(m.color) + '"></span>' +
        '<span class="nm' + (me ? ' me' : '') + '">' + esc(m.name) + (me ? '（我）' : '') + '</span>' +
        '<span class="sc">胜 <b>' + m.wins + '</b> · 杀 <b>' + m.kills + '</b></span></li>';
    }).join('');
  }

  /* ================= 主循环 ================= */
  function frame(ts) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.06, (ts - (S.lastTs || ts)) / 1000);
    S.lastTs = ts;
    S.now = ts / 1000;
    S.sfxBudget = 6;

    if (S.screen !== 'scr-game' || !S.mode) return;
    // 暂停时也照样把当前画面画出来：以前暂停=完全不画，
    // 一旦中途 fitCanvas 把画布尺寸改了（重新开局就会改），画面就成了纯黑/一片空白
    if (S.paused) { drawFrame(); return; }

    if (S.mode === 'single') stepSingle(dt);
    else if (S.mode === 'local') stepLocalMatch(dt);
    else if (S.mode === 'online') stepOnline(dt);
    updateFx(dt);
    drawFrame();
    S.hudAcc += dt;
    if (S.hudAcc > 0.08) { S.hudAcc = 0; updateHud(); }
  }

  /* ================= 覆盖层按钮 ================= */
  function bindOverlayBtns() {
    var r = $('ovResume'); if (r) r.onclick = function () { S.paused = false; hideOverlay(); };
    var a = $('ovAgain'); if (a) a.onclick = function () {
      if (S.mode === 'single') { startSingle(S.single.level); }
      else { startLocal(S.local.rounds); }
    };
    var b = $('ovBack'); if (b) b.onclick = function () { quitToMenu(); };
    var q = $('ovQuit'); if (q) q.onclick = function () { quitToMenu(); };
    var h = $('ovHost'); if (h) h.onclick = function () { S.net.send({ t: 'tank.rematch' }); hideOverlay(); };
    var l = $('ovLobby'); if (l) l.onclick = function () { hideOverlay(); leaveGameToLobby(); };
  }

  function quitToMenu() {
    if (S.mode === 'online') S.net.send({ t: 'tank.leave' });
    S.mode = null; S.world = null; S.me = null; S.paused = false;
    S.local = null; S.single = null; S.fx = [];
    S.online = null;          // 下次进联机会重新建会话
    S.room = null;
    hideOverlay();
    show('scr-menu');
    refreshBest();
  }
  function leaveGameToLobby() {
    S.mode = null; S.world = null; S.fx = [];
    if (S.online) S.online.running = false;
    show('scr-lobby');
  }

  /* ================= 大厅 UI ================= */
  var lobbyColor = '#4c8dff', lobbyStyle = 'classic';

  function renderLobbyKeys() {
    var box = $('lobbyKeys');
    box.innerHTML = WB.settings.ACTIONS.map(function (a) {
      return '<button data-action="' + a.k + '"><span>' + a.label + '</span>' +
        '<b>' + esc(WB.keys.name(K('p1')[a.k])) + '</b></button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (btn) {
      btn.onclick = function () {
        if (btn.classList.contains('capturing')) return;
        btn.classList.add('capturing');
        var old = btn.querySelector('b').textContent;
        btn.querySelector('b').textContent = '按下新键…';
        WB.keys.capture(function (code) {
          btn.classList.remove('capturing');
          if (!code) { btn.querySelector('b').textContent = old; return; }
          var conflict = WB.settings.conflict('p1', btn.dataset.action, code);
          if (conflict) {
            WB.ui.toast('该键已被其它动作占用', 'err');
            btn.querySelector('b').textContent = old;
            return;
          }
          K('p1')[btn.dataset.action] = code;
          WB.settings.save();
          renderLobbyKeys();
          WB.audio.play('click');
        });
      };
    });
  }

  function renderLobbyConfig() {
    var o = S.online || {};
    $('colorPick').innerHTML = TC.TANK_COLORS.map(function (c, i) {
      return '<div class="swatch' + (c === lobbyColor ? ' on' : '') + '" data-color="' + c + '" style="background:' + c + '" title="' + TC.TANK_COLOR_NAMES[i] + '"></div>';
    }).join('');
    Array.prototype.forEach.call($('colorPick').children, function (sw) {
      sw.onclick = function () {
        lobbyColor = sw.dataset.color;
        renderLobbyConfig();
        S.net.send({ t: 'tank.config', color: lobbyColor, style: lobbyStyle });
        WB.audio.play('click');
      };
    });
    $('stylePick').innerHTML = TC.TANK_STYLES.map(function (s, i) {
      return '<button class="style-btn' + (s === lobbyStyle ? ' on' : '') + '" data-style="' + s + '">' + TC.TANK_STYLE_NAMES[i] + '</button>';
    }).join('');
    Array.prototype.forEach.call($('stylePick').children, function (b) {
      b.onclick = function () {
        lobbyStyle = b.dataset.style;
        renderLobbyConfig();
        S.net.send({ t: 'tank.config', color: lobbyColor, style: lobbyStyle });
        WB.audio.play('click');
      };
    });
    drawPreview();
  }

  function drawPreview() {
    var pc = $('cfgPreview');
    if (!pc) return;
    var pctx = pc.getContext('2d');
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, pc.width, pc.height);
    pctx.fillStyle = '#0a0d13';
    pctx.fillRect(0, 0, pc.width, pc.height);
    pctx.save();
    pctx.translate(pc.width / 2, pc.height / 2);
    pctx.scale(2.6, 2.6);
    R.drawTank(pctx, { x: 0, y: 0, angle: 0, alive: true, color: lobbyColor, style: lobbyStyle, invuln: 0, shield: 0, showName: false }, performance.now() / 1000);
    pctx.restore();
  }

  function renderLobby(room) {
    S.room = room;
    $('roomCode').textContent = room.code;
    $('roomCount').textContent = room.members.length + '/' + (room.maxPlayers || 4);
    var isHost = room.hostId === S.net.id;

    var me = null;
    for (var i = 0; i < room.members.length; i++) if (room.members[i].id === S.net.id) me = room.members[i];

    // 玩家列表（含准备状态）
    $('playerList').innerHTML = room.members.map(function (m) {
      var isMe = m.id === S.net.id;
      var rd = m.isHost
        ? '<span class="rd host">房主 · 已就绪</span>'
        : (m.ready ? '<span class="rd ok">✔ 已准备</span>' : '<span class="rd no">未准备</span>');
      return '<li class="' + (isMe ? 'me' : '') + '">' +
        '<span class="dot" style="background:' + esc(m.color) + '"></span>' +
        '<span class="nm">' + esc(m.name) + (isMe ? '（我）' : '') + '</span>' +
        rd +
        '<span class="st">胜 ' + m.wins + ' · 杀 ' + m.kills + '</span></li>';
    }).join('');

    if (me) { lobbyColor = me.color; lobbyStyle = me.style; renderLobbyConfig(); }

    // 准备按钮（仅非房主）
    var rb = $('btnReady');
    rb.classList.toggle('hidden', isHost);
    if (!isHost && me) {
      rb.textContent = me.ready ? '取消准备' : '我已准备好';
      rb.classList.toggle('ok', !!me.ready);
      rb.disabled = room.state !== 'lobby';
    }

    var ri = $('roomRounds');
    ri.value = room.rounds;
    ri.disabled = !isHost;
    $('roundsHint').textContent = isHost ? '默认 20 局 · 最多 999 局（仅房主可改）' : '仅房主可设置局数';

    var li = $('roomLives');
    li.value = room.lives || 1;
    li.disabled = !isHost;
    $('livesHint').textContent = (isHost ? '默认 1 条 · 最多 5 条（仅房主可改）' : '每局 ' + (room.lives || 1) + ' 条命')
      + ' · 每局结束后重新随机地图';

    // AI 补充开关（仅房主可改）
    var cb = $('chkBots');
    cb.checked = !!room.addBots;
    cb.disabled = !isHost;
    $('botHint').textContent = isHost
      ? (room.addBots
        ? '已开启：真人不足 2 人时补 1 辆 AI 坦克'
        : '默认关闭：只有你 1 人时打开它才能开局；2 人以上不影响')
      : (room.addBots ? '房主已打开：人数不足时会补 AI' : '房主未开启 AI 补充');

    renderPowerupPicks(room, isHost);

    // 子弹是否伤到自己（仅房主可改，默认关）
    var sd = $('chkSelfDamage');
    sd.checked = !!room.selfDamage;
    sd.disabled = !isHost;
    $('selfDamageHint').textContent = room.selfDamage
      ? '已开启：反弹回来的子弹会打伤自己（含被自己打死的可能）'
      : (isHost ? '关闭中：自己的子弹打不到自己（房主可开）' : '由房主设置：自己的子弹是否会打伤自己');

    // 开始游戏（能不能开始由服务端权威判定，原因直接显示出来）
    var sb = $('btnStartGame');
    sb.disabled = !room.canStart;
    sb.textContent = isHost ? (room.canStart ? '开始游戏' : '暂不可开始') : '等待房主开始';
    var tip = $('lobbyTip');
    tip.textContent = room.startHint || (isHost ? '' : '等待房主开始游戏…');
    tip.className = room.canStart ? 'tip-ok' : 'dim';
  }

  /** 房间里勾选「场上会掉落哪些道具」（仅房主可改，默认全选） */
  function renderPowerupPicks(room, isHost) {
    var box = $('puPicks');
    if (!box) return;
    var all = (room && room.allPowerups && room.allPowerups.length) ? room.allPowerups : TC.POWERUP_TYPES;
    var on = (room && room.powerups) ? room.powerups : all;
    box.innerHTML = all.map(function (t) {
      var checked = on.indexOf(t) >= 0;
      return '<label class="pu-pick ' + (checked ? 'on' : 'off') + (isHost ? '' : ' disabled') + '"' +
        ' data-pu="' + esc(t) + '" title="' + esc(TC.PU_NAME[t] + '：' + ((TC.PU_DESC && TC.PU_DESC[t]) || '')) + '">' +
        '<input type="checkbox" ' + (checked ? 'checked' : '') + (isHost ? '' : ' disabled') + '>' +
        '<span class="pk-icon" style="color:' + TC.PU_COLOR[t] + '">' + TC.PU_LABEL[t] + '</span>' +
        '<span>' + esc(TC.PU_NAME[t]) + '</span></label>';
    }).join('');
    $('puHint').textContent = isHost
      ? '默认全选；取消勾选后场上不再掉落该道具（至少保留一种）'
      : '由房主设置场上会掉落哪些道具';
  }

  /* ================= 网络 ================= */
  function initNet() {
    S.net = new WB.Net();
    WB.bindNetBadge($('netBadge'), S.net);

    /* ---------- 好友系统（平台层，所有游戏通用） ---------- */
    WB.Friends.boot(S.net);
    /* ---------- 聊天控件（左下角，平台层通用）：房间聊天走频道 ---------- */
    WB.Chat.boot(S.net);
    // 向好友系统登记「组队邀请」能力：好友点接受后直达房间，不用报 4 位房间号
    WB.Friends.registerGame({
      name: 'tank',
      label: '坦克大战',
      entry: '/tank/',
      param: 'join',
      // 只有在房间大厅里才能邀请（对局中/已开局的房间进不去）
      canInvite: function () {
        var room = S.room;
        if (room && room.code && (room.state === 'lobby' || room.state === 'over')) {
          return { data: { room: room.code }, text: '房间 ' + room.code };
        }
        return null;
      },
      // 受邀方就在本页面：直接发送加入请求（服务端会自动先退出旧房间）
      accept: function (data) {
        var code = String((data && data.room) || '').trim();
        if (!/^\d{4}$/.test(code)) { WB.ui.toast('邀请信息不完整', 'err'); WB.audio.play('error'); return; }
        if (S.net.status !== 'open') { WB.ui.toast('正在连接服务器…', 'err'); return; }
        WB.ui.toast('正在加入好友的房间 ' + code + '…', 'ok');
        S.net.send({ t: 'tank.join', code: code });
      }
    });

    S.net.on('tank.created', function (m) {
      WB.audio.play('click');
      WB.ui.toast('房间已创建：' + m.code, 'ok');
      WB.Chat.enterRoom({ game: 'tank', code: m.code, title: '坦克大战 · 房间 ' + m.code });
      show('scr-lobby');
      renderLobbyKeys();
      renderLobbyConfig();
    });
    S.net.on('tank.joined', function (m) {
      WB.ui.toast((S.autoJoinNote === m.code ? '已通过好友邀请加入房间：' : '已加入房间：') + m.code, 'ok');
      S.autoJoinNote = null;
      WB.Chat.enterRoom({ game: 'tank', code: m.code, title: '坦克大战 · 房间 ' + m.code });
      show('scr-lobby');
      renderLobbyKeys();
      renderLobbyConfig();
    });
    S.net.on('tank.room', function (m) {
      // 刷新页面后回到同一房间：把聊天频道也接回来
      if (m.code) WB.Chat.enterRoom({ game: 'tank', code: m.code, title: '坦克大战 · 房间 ' + m.code });
      if (m.state === 'lobby' || m.state === 'over') renderLobby(m);
      else S.room = m;
    });
    S.net.on('tank.error', function (m) { WB.ui.toast(m.msg || '操作失败', 'err'); WB.audio.play('error'); });
    S.net.on('tank.playerLeft', function (m) { WB.ui.toast((m.name || '玩家') + ' 离开了房间'); });
    // 对局中有人退出：整场结束，直接回主页（服务器已回收房间）
    S.net.on('tank.abort', function (m) {
      WB.ui.toast(m.msg || ((m.name || '对方') + ' 离开了对局'), 'err');
      WB.audio.play('error');
      S.room = null;
      WB.Chat.leaveRoom();          // 房间被回收 → 聊天频道一起关掉
      quitToMenu();
    });
    S.net.on('tank.round', onNetRound);
    S.net.on('tank.state', onNetState);
    S.net.on('tank.roundEnd', function (m) {
      var meKey = 1000 + S.net.id;
      var ranked = m.result.ranked.map(function (r) { return { id: r.id, name: r.name, color: r.color, kills: r.kills, deaths: r.deaths }; });
      // 胜利横幅要画出那辆坦克，颜色/涂装从房间成员里取
      var win = m.result.winner;
      if (win) {
        var pi = null;
        for (var k = 0; k < (S.online.players || []).length; k++) {
          if (S.online.players[k].id === win.id - 1000) { pi = S.online.players[k]; break; }
        }
        win.color = (pi && pi.color) || '#4c8dff';
        win.style = (pi && pi.style) || 'classic';
      }
      var html = '<h2>第 ' + m.result.index + ' / ' + S.online.roundTotal + ' 局结束</h2>';
      html += winnerBannerHtml(win, m.result.timeout ? '时间到 · 按击杀排名' : '', meKey, '本局胜者');
      html += awardHtml(ranked);
      html += roundRankHtml(ranked, meKey);
      html += '<p class="osub">' + (m.next ? '下一局将在 ' + Math.ceil(m.intermission || 3) + ' 秒后开始' : '即将结算最终排名') + '</p>';
      showOverlay(html);
      paintBannerTank(win);
      WB.audio.play(win && win.id === meKey ? 'win' : 'count');
    });
    S.net.on('tank.matchEnd', function (m) {
      var meKey = 1000 + S.net.id;
      var isHost = S.room && S.room.hostId === S.net.id;
      var champ = m.standings[0] || null;
      var win = champ && champ.id === meKey;
      // 冠军坦克的颜色/涂装从房间成员里取（用于横幅上画出来的那辆车）
      var champArt = null;
      if (champ) {
        var pi = null;
        for (var k = 0; k < ((S.room && S.room.members) || []).length; k++) {
          if (S.room.members[k].id === champ.id) { pi = S.room.members[k]; break; }
        }
        champArt = { id: champ.id, name: champ.name, color: (pi && pi.color) || '#4c8dff', style: (pi && pi.style) || 'classic' };
      }
      showOverlay(
        '<h2>全部 ' + m.rounds + ' 局已结束</h2>' +
        winnerBannerHtml(champArt, champ ? ((champ.wins || 0) + ' 胜 · ' + (champ.kills || 0) + ' 杀') : '', meKey, '总冠军') +
        awardHtml(m.standings) +
        '<p class="osub">最终排名（先比胜场，再比击杀，死亡少者靠前）</p>' +
        standingsHtml(m.standings, meKey) +
        '<div class="obtns">' +
          (isHost ? '<button class="btn primary" id="ovHost">原班人马再来一届</button>' : '') +
          '<button class="btn ghost" id="ovLobby">返回大厅</button>' +
          '<button class="btn ghost" id="ovBack">离开房间</button>' +
        '</div>'
      );
      paintBannerTank(champArt);
      bindOverlayBtns();
      WB.audio.play(win ? 'win' : 'lose');
    });

    // 设置里改了昵称：立刻把新名字同步给服务器（否则联机里还是旧名字）
    window.addEventListener('wb:settings', function () {
      renderLobbyKeys();
      if (S.net) S.net.send({ t: 'hello', name: WB.playerName() });
    });
    S.net.connect();
  }

  /* ================= 入口绑定 ================= */
  function refreshBest() {
    var b = [0, 1, 2].map(function (l) { return parseInt(localStorage.getItem(BEST_KEY + l) || '0', 10); });
    $('bestScore').textContent = b[0] || b[1] || b[2] ? ('最高纪录：简单 ' + b[0] + ' · 普通 ' + b[1] + ' · 困难 ' + b[2] + ' 辆') : '';
  }

  function bindUi() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-mode]'), function (b) {
      b.onclick = function () {
        WB.audio.play('click');
        var m = b.dataset.mode;
        if (m === 'single') show('scr-single');
        else if (m === 'local') show('scr-local');
        else {
          if (!S.online) startOnlineSession();   // 关键：进入联机前必须先把会话对象建好
          show('scr-online');
        }
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-level]'), function (b) {
      b.onclick = function () { WB.audio.play('click'); startSingle(parseInt(b.dataset.level, 10)); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (b) {
      b.onclick = function () { WB.audio.play('click'); show('scr-menu'); refreshBest(); };
    });
    $('btnSettings').onclick = WB.ui.openSettings;
    $('btnSettings2').onclick = WB.ui.openSettings;

    var lr = $('localRounds');
    lr.value = WB.settings.get().rounds || 20;
    lr.onchange = function () {
      var n = Math.max(1, Math.min(999, parseInt(lr.value, 10) || 20));
      lr.value = n;
      WB.settings.get().rounds = n;
      WB.settings.save();
    };
    renderLocalKeys();
    $('btnLocalStart').onclick = function () {
      WB.audio.play('click');
      startLocal(Math.max(1, Math.min(999, parseInt(lr.value, 10) || 20)));
    };

    $('btnCreateRoom').onclick = function () {
      WB.audio.play('click');
      if (S.net.status !== 'open') { WB.ui.toast('正在连接服务器…', 'err'); return; }
      S.net.send({ t: 'tank.create' });
    };
    $('btnJoinRoom').onclick = doJoinRoom;
    $('joinCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoinRoom(); });
    $('btnLeaveRoom').onclick = function () {
      S.net.send({ t: 'tank.leave' });
      S.room = null;
      S.online = null;
      WB.Chat.leaveRoom();          // 退出房间 → 关掉本局聊天频道
      show('scr-menu');
    };
    $('btnCopyCode').onclick = function () {
      var code = $('roomCode').textContent;
      var done = function () { WB.ui.toast('房间号 ' + code + ' 已复制', 'ok'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done);
      else { WB.ui.toast('房间号：' + code, 'ok'); }
      WB.audio.play('click');
    };
    // 邀请好友：打开好友面板，对好友点「邀请组队」即可直达本房间（不用报房间号）
    $('btnInviteFriend').onclick = function () {
      WB.audio.play('click');
      if (WB.friends) WB.friends.openPanel();
    };
    $('btnStartGame').onclick = function () { WB.audio.play('click'); S.net.send({ t: 'tank.start' }); };

    $('btnReady').onclick = function () {
      var room = S.room;
      var me = null;
      if (room) for (var i = 0; i < room.members.length; i++) if (room.members[i].id === S.net.id) me = room.members[i];
      var next = !(me && me.ready);
      S.net.send({ t: 'tank.ready', ready: next });
      WB.audio.play('click');
      WB.ui.toast(next ? '已准备，等待房主开始' : '已取消准备', next ? 'ok' : '');
    };

    // 道具勾选：点一下就切换，并把最新的清单发给服务端
    $('puPicks').addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.pu-pick') : null;
      if (!el || !S.net) return;
      var room = S.room;
      if (!room || room.hostId !== S.net.id) { WB.ui.toast('只有房主可以设置掉落道具'); return; }
      var type = el.getAttribute('data-pu');
      var next = (room.powerups || []).slice();
      var at = next.indexOf(type);
      if (at >= 0) {
        if (next.length <= 1) { WB.ui.toast('至少要保留一种道具'); return; }
        next.splice(at, 1);
      } else next.push(type);
      S.net.send({ t: 'tank.powerups', list: next });
      WB.audio.play('click');
    });

    $('chkBots').onchange = function () {
      S.net.send({ t: 'tank.bots', enabled: this.checked });
      WB.audio.play('click');
      WB.ui.toast(this.checked ? '已开启 AI 补充（人数不足时自动补 1 辆 AI）' : '已关闭 AI 补充（完全不加 AI）');
    };
    $('chkSelfDamage').onchange = function () {
      S.net.send({ t: 'tank.selfDamage', enabled: this.checked });
      WB.audio.play('click');
      WB.ui.toast(this.checked ? '已开启自伤：小心反弹的子弹' : '已关闭自伤：自己的子弹打不到自己');
    };
    var rr = $('roomRounds');
    rr.onchange = function () {
      var n = Math.max(1, Math.min(999, parseInt(rr.value, 10) || 20));
      rr.value = n;
      S.net.send({ t: 'tank.rounds', rounds: n });
    };
    var rl = $('roomLives');
    rl.onchange = function () {
      var n = Math.max(1, Math.min(5, parseInt(rl.value, 10) || 1));
      rl.value = n;
      S.net.send({ t: 'tank.lives', lives: n });
    };

    $('btnPause').onclick = function () {
      if (S.mode === 'online') { WB.ui.toast('联机对局无法暂停'); return; }
      // 结算浮层还开着的时候按暂停没有意义，而且会把 paused 带到下一局（新对局就不出画面了）
      if (!$('overlay').classList.contains('hidden')) { S.paused = false; return; }
      S.paused = !S.paused;
      if (S.paused) {
        showOverlay('<h2>已暂停</h2><p class="osub">按 Esc 或点击下方按钮继续</p>' +
          '<div class="obtns"><button class="btn primary" id="ovResume">继续游戏</button>' +
          '<button class="btn ghost" id="ovQuit">退出对局</button></div>');
        bindOverlayBtns();
      } else hideOverlay();
    };
    $('btnQuit').onclick = function () { quitToMenu(); };
  }

  function renderLocalKeys() {
    var box = $('localKeysPreview');
    var cols = [['p1', 'P1（方向键）'], ['p2', 'P2']];
    box.innerHTML = cols.map(function (c) {
      var k = K(c[0]);
      return '<div class="kp"><h5>' + c[1] + '</h5>' +
        '<div>前进 <var>' + esc(WB.keys.name(k.up)) + '</var> · 后退 <var>' + esc(WB.keys.name(k.down)) + '</var></div>' +
        '<div>左转 <var>' + esc(WB.keys.name(k.left)) + '</var> · 右转 <var>' + esc(WB.keys.name(k.right)) + '</var></div>' +
        '<div>开火 <var>' + esc(WB.keys.name(k.fire)) + '</var></div></div>';
    }).join('');
  }

  function doJoinRoom() {
    var code = ($('joinCode').value || '').trim();
    if (!/^\d{4}$/.test(code)) { WB.ui.toast('请输入 4 位数字房间号', 'err'); WB.audio.play('error'); return; }
    if (S.net.status !== 'open') { WB.ui.toast('正在连接服务器…', 'err'); return; }
    WB.audio.play('click');
    S.net.send({ t: 'tank.join', code: code });
  }

  /* ================= 启动 ================= */
  initNet();

  /* 好友组队邀请直达：URL 带 ?join={"room":"1234"} 时自动加入（免输房间号）。
   * net.send 在未连上时会自动排队，连上后按顺序发出。 */
  (function autoJoinFromFriendInvite() {
    var raw = '';
    try { raw = new URLSearchParams(location.search).get('join') || ''; } catch (e) { return; }
    if (!raw) return;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { data = { room: raw }; }
    var code = String((data && data.room) || '').trim();
    if (!/^\d{4}$/.test(code)) return;
    S.autoJoinNote = code;
    S.net.send({ t: 'tank.join', code: code });
    WB.ui.toast('正在通过好友邀请加入房间 ' + code + '…', 'ok');
  })();

  bindUi();
  refreshBest();
  fitCanvas();

  requestAnimationFrame(frame);
  window.__TANK_DEBUG = {
    S: S, TC: TC, R: R,
    onNetRound: onNetRound, onNetState: onNetState, handleEvents: handleEvents, frame: frame,
    buildLocalView: buildLocalView, buildOnlineView: buildOnlineView
  };

  // 菜单顶部小演示（独立 try，避免个别绘制问题影响整个页面）
  try { preview(); } catch (e) { console.warn('[preview]', e); }

  function preview() {
    var c = $('previewArt');
    if (!c || typeof c.getContext !== 'function') return;
    var w = 700, h = 90;
    c.width = w; c.height = h;
    c.style.width = '100%'; c.style.maxWidth = w + 'px';
    var pctx = c.getContext('2d');
    var demo = [
      { x: 90, y: 46, a: 0, color: '#4c8dff', style: 'classic' },
      { x: 230, y: 46, a: Math.PI / 4, color: '#2fd39b', style: 'stripe' },
      { x: 370, y: 46, a: Math.PI / 2, color: '#f5a524', style: 'camo' },
      { x: 510, y: 46, a: -Math.PI / 3, color: '#c85dff', style: 'neon' },
      { x: 630, y: 46, a: Math.PI, color: '#ff5d6c', style: 'classic' }
    ];
    pctx.fillStyle = '#0a0d13'; pctx.fillRect(0, 0, w, h);
    pctx.fillStyle = 'rgba(255,255,255,.03)';
    for (var i = 0; i < w; i += 32) pctx.fillRect(i, 0, 30, h);
    for (var j = 0; j < demo.length; j++) {
      pctx.save();
      pctx.translate(demo[j].x, demo[j].y);
      pctx.scale(1.35, 1.35);
      R.drawTank(pctx, { x: 0, y: 0, angle: demo[j].a, alive: true, color: demo[j].color, style: demo[j].style, invuln: 0, shield: 0, showName: false }, j);
      pctx.restore();
    }
  }
})();
