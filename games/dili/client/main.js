/* ============================================================================
 * 底力练习器 — 客户端
 * 玩法照搬 EatKano（MIT）：音符下落、判定线点击、点错即死、越快越快。
 * 本文件负责：菜单/模式选择、游戏引擎（双层 DOM 滚动）、布局调整、
 *             皮肤工坊与皮肤广场、排行榜、结算上传。
 * ==========================================================================*/
(function () {
'use strict';

var TC = window.DiliCore;
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

/* ================= 无尽模式参数（钢琴块式下落） ================= */
var ENDLESS_START_SPEED = 3.0;    // 起始速度（键/秒）
var ENDLESS_MAX_SPEED = 26;       // 速度上限（键/秒）
var ENDLESS_GROW = 1.015;         // 每过一行速度乘这个系数
var ENDLESS_GROW_ADD = 0.02;      // 再额外加一点，起步不至于太肉

/* ================= 全局状态 ================= */
var S = {
  net: null,
  keys: 4, mode: 'timed', seconds: 20,
  layout: null,                    // { width, block, judge, showKeys }
  skin: null,                      // 当前皮肤（null = 默认皮肤）
  draft: null,                     // 皮肤编辑器草稿
  capturing: false                 // 主页正在「按新键…」抓键，防重复触发
};

/* ================= 存档 ================= */
function loadJson(key, fallback) {
  try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function saveJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { return false; }
}
/* 默认游戏区宽度 24%：旧版是 60%，实测铺满整个屏幕、音符大得离谱，缩到约 40%（60 × 0.4） */
var DEFAULT_LAYOUT = { width: 24, block: 100, judge: 0, showKeys: true };
function loadLayout() {
  var l = loadJson('dili.layout', null) || {};
  return {
    width: l.width != null ? l.width : DEFAULT_LAYOUT.width,
    block: l.block != null ? l.block : DEFAULT_LAYOUT.block,
    judge: l.judge != null ? l.judge : DEFAULT_LAYOUT.judge,
    showKeys: l.showKeys !== false
  };
}
/* 平台键位表：4K/5K/6K 各一套（右上角 ⚙ 设置里可改） */
var KEY_PLAYER = { 4: 0, 5: 1, 6: 2 };
function trackCodes(k) {
  var game = WB.settings.gameById('dili');
  var map = WB.settings.keysFor('dili', KEY_PLAYER[k] || 0);
  var out = [];
  for (var i = 0; i < k; i++) out.push(map['t' + (i + 1)]);
  void game;
  return out;                       // ['KeyD', 'Space', ...]
}
function codeLabel(code) {
  if (!code) return '?';
  if (code === 'Space') return '空格';
  var m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  var m2 = /^Digit(\d)$/.exec(code);
  if (m2) return m2[1];
  if (code === 'Semicolon') return ';';
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  return code;
}
function trackLabels(k) {
  return trackCodes(k).map(codeLabel);
}

/* ================= 屏幕切换 ================= */
function show(id) {
  var screens = ['scr-menu', 'scr-game'];
  for (var i = 0; i < screens.length; i++) $(screens[i]).style.display = screens[i] === id ? '' : 'none';
}
function mask(id, on) { $(id).style.display = on ? 'flex' : 'none'; }

/* ================= 音频 ================= */
/* 默认音效：WebAudio 现场合成（击中=短促滴声，失误=低鸣）；皮肤带了自己的音效就用它。 */
var AC = null;
function ac() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } return AC; }
function synthHit() {
  var c = ac(); if (!c) return;
  var o = c.createOscillator(), g = c.createGain();
  o.type = 'square'; o.frequency.value = 880;
  g.gain.setValueAtTime(.18, c.currentTime);
  g.gain.exponentialRampToValueAtTime(.001, c.currentTime + .07);
  o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + .08);
}
function synthErr() {
  var c = ac(); if (!c) return;
  var o = c.createOscillator(), g = c.createGain();
  o.type = 'sawtooth'; o.frequency.value = 150;
  g.gain.setValueAtTime(.22, c.currentTime);
  g.gain.exponentialRampToValueAtTime(.001, c.currentTime + .28);
  o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + .3);
}
var audioPool = { hit: [], err: [] };
function playSkinSound(kind, dataUri) {
  if (!dataUri) { kind === 'hit' ? synthHit() : synthErr(); return; }
  var pool = audioPool[kind];
  var a = pool.length ? pool.pop() : new Audio();
  a.src = dataUri;
  a.onended = function () { if (pool.length < 4) pool.push(a); };
  a.currentTime = 0;
  a.play().catch(function () { /* 自动播放策略：忽略 */ });
}
function playHit() { playSkinSound('hit', S.skin && S.skin.hitSound); }
function playErr() { playSkinSound('err', S.skin && S.skin.errSound); }

/* ================= 游戏引擎 ================= */
var G = null;

function gameCfg() {
  return {
    keyCount: S.keys,
    mode: S.mode,
    timeLimit: S.mode === 'timed' ? S.seconds : 0
  };
}

/** 视口 / 行高 / 可见行数：改布局、改窗口大小时重算（所有尺寸的唯一来源） */
function metrics() {
  var vp = $('gameViewport');
  var pad = Math.max(0, Math.round(vp.clientHeight * (S.layout.judge || 0) / 100));
  var w = Math.max(96, Math.round(vp.clientWidth * (S.layout.width || DEFAULT_LAYOUT.width) / 100));
  var blockSize = w / S.keys;
  var blockH = Math.max(20, Math.round(blockSize * (S.layout.block || 100) / 100));
  var h = Math.max(120, vp.clientHeight - pad);          // 判定线以上的高度
  return {
    pad: pad, w: w, h: h, blockSize: blockSize, blockH: blockH,
    rowsOnScreen: Math.ceil(h / blockH) + 1               // 一屏能看到的行数（含底部判定行）
  };
}

function startGame() {
  var cfg = gameCfg();
  show('scr-game');
  // 先立起新的 G（applyLayout 会往里写 metrics 并铺第一批音符，顺序不能反）
  G = {
    cfg: cfg,
    running: true, started: false, paused: false, over: false,
    score: 0, keyHits: 0, rowHits: 0, errors: 0,
    startTs: 0, lastTap: 0, pausedMs: 0, pauseStart: null,
    elapsed: 0,                 // 已进行时间（毫秒）：每帧按 delta-time 累加，暂停不计
    cps: [],
    // 连续的「滚动位置」（单位 = 行）：行号 R 的音符距判定线 = (R - rowFloat) × 行高。
    // 画面和判定读的是同一个 rowFloat，所以不会再出现「看到的和判的不一样」。
    rowFloat: 0,
    index: 0,                   // 下一颗要打的行号（整数）
    spawnRow: 0,                // 下一颗要生成的行号
    notes: [],                  // 屏幕上的音符，按行号升序
    anim: null, animT: 0,       // 限时模式：打对一行后往 index 滑一格的补间
    speed: ENDLESS_START_SPEED, // 无尽模式速度（行/秒）
    raf: 0, lastTs: 0, hudTs: 0, metrics: null
  };
  $('noteLayer').innerHTML = '';
  window.__G = G;               // 调试/自检钩子：探针能读到对局状态
  applyLayout();                // 算尺寸 + 铺轨道/键位字母 + 生成初始音符
  $('hudMode').textContent = (cfg.mode === 'timed' ? '限时 · ' : '无尽 · ') + cfg.keyCount + 'K' +
    (cfg.mode === 'timed' ? ' · ' + cfg.timeLimit + 's' : '');
  $('pauseOverlay').style.display = 'none';
  $('readyOverlay').style.display = 'flex';
  $('readyTitle').textContent = cfg.mode === 'timed' ? '限时 ' + cfg.timeLimit + ' 秒' : '无尽模式 · 会越来越快';
  $('readyKeys').innerHTML = trackLabels(cfg.keyCount).map(function (t) {
    return '<span class="rk">' + esc(t) + '</span>';
  }).join('');
  updateHud();
  G.lastTs = 0;
  G.raf = requestAnimationFrame(frame);
}

/** 布局：算尺寸、铺轨道底图与键位字母、重排已有音符 */
function applyLayout() {
  G.metrics = metrics();
  var m = G.metrics;
  var inner = $('gameInner');
  inner.style.top = '0';
  inner.style.width = m.w + 'px';
  inner.style.height = m.h + 'px';        // 底边 = 判定线（判定线以上才是可落区域）

  $('gameBg').style.backgroundImage = (S.skin && S.skin.bg) ? 'url(' + S.skin.bg + ')' : 'none';

  var lanes = $('gameLanes');
  lanes.innerHTML = '';
  for (var i = 0; i < S.keys; i++) {
    var lane = document.createElement('div');
    lane.className = 'game-lane';
    lane.style.left = (i * m.blockSize) + 'px';
    lane.style.width = m.blockSize + 'px';
    if (S.skin && S.skin.keyBg) lane.style.backgroundImage = 'url(' + S.skin.keyBg + ')';
    lanes.appendChild(lane);
  }
  var kl = $('gameKeys');
  kl.innerHTML = '';
  if (S.layout.showKeys) {
    var labels = trackLabels(S.keys);
    for (var j = 0; j < S.keys; j++) {
      var d = document.createElement('div');
      d.className = 'game-key';
      d.style.left = (j * m.blockSize) + 'px';
      d.style.width = m.blockSize + 'px';
      d.textContent = labels[j] || '';
      kl.appendChild(d);
    }
  }
  if (G.notes) {              // 对局中途改布局（暂停里）→ 已有音符按新尺寸重排
    for (var n = 0; n < G.notes.length; n++) layoutNote(G.notes[n]);
    fillNotes();
    renderNotes();
  }
}

/** 把音符块摆到它所属轨道（左/宽/高）；纵向位置每帧由 renderNotes 刷 */
function layoutNote(note) {
  var m = G.metrics;
  note.el.style.left = (note.track * m.blockSize) + 'px';
  note.el.style.width = m.blockSize + 'px';
  note.el.style.height = m.blockH + 'px';
}

/** 生成一行：行号递增，每行在 keyCount 条轨道里随机一条放一个音符 */
function spawnNote() {
  var row = G.spawnRow++;
  var track = TC.nextTrack(null, G.cfg.keyCount);
  var el = document.createElement('div');
  el.className = 'dili-cell';
  if (S.skin && S.skin.note) el.style.backgroundImage = 'url(' + S.skin.note + ')';
  else el.classList.add('note-default');
  var note = { row: row, track: track, el: el, hit: false };
  layoutNote(note);
  G.notes.push(note);
  $('noteLayer').appendChild(el);
  return note;
}

/** 按需补行 + 回收已经沉到判定线下两行以外的音符（列表不会无限增长，也就不会再出现空白行） */
function fillNotes() {
  // 以「滚动位置」和「待打行号」的较大者为基准补行：限时模式里打得太快也不会出现空档
  var limit = Math.floor(Math.max(G.rowFloat, G.index)) + G.metrics.rowsOnScreen + 1;
  while (G.spawnRow <= limit) spawnNote();
  while (G.notes.length && G.notes[0].row < G.rowFloat - 2) {
    $('noteLayer').removeChild(G.notes[0].el);
    G.notes.shift();
  }
}

/** 每帧刷纵向位置：距判定线偏移 = (行号 - rowFloat) × 行高（大于 0 表示还在线上方） */
function renderNotes() {
  var m = G.metrics, rf = G.rowFloat;
  for (var i = 0; i < G.notes.length; i++) {
    var n = G.notes[i];
    n.el.style.transform = 'translate3d(0,' + ((rf - n.row) * m.blockH).toFixed(2) + 'px,0)';
  }
}

/** 当前要打的那一行（行号 === index） */
function currentNote() {
  for (var i = 0; i < G.notes.length; i++) if (G.notes[i].row === G.index) return G.notes[i];
  return null;
}

/**
 * 主循环：整个游戏只有这一个推进源（requestAnimationFrame + delta-time）。
 * 限时模式 rowFloat 只在打对时补间；无尽模式 rowFloat 以 speed 连续推进。
 * 画面与判定读同一个 rowFloat，所以不会再有「看着没到、判的却过了」的错位。
 */
function frame(ts) {
  if (!G || G.over) return;
  G.raf = requestAnimationFrame(frame);
  if (!G.lastTs) G.lastTs = ts;
  var dtMs = Math.min(64, ts - G.lastTs);    // 切后台/掉帧时封顶，避免一帧冲过好几行
  G.lastTs = ts;
  if (G.paused) return;
  if (G.started) {
    G.elapsed += dtMs;
    if (G.cfg.mode === 'endless') {
      G.rowFloat += G.speed * dtMs / 1000;
      if (G.rowFloat >= G.index + 1) { missCurrentRow(); return; }   // 这一行被推过一整行还没打
    } else if (G.anim) {
      G.animT += dtMs;
      var p = G.anim.dur > 0 ? Math.min(1, G.animT / G.anim.dur) : 1;
      G.rowFloat = G.anim.from + (G.anim.to - G.anim.from) * p;
      if (p >= 1) { G.anim = null; G.rowFloat = G.index; }
    }
    if (G.cfg.mode === 'timed' && timeLeftMs() <= 0) { endGame(null); return; }
  }
  fillNotes();
  renderNotes();
  if (ts - G.hudTs >= 40) { G.hudTs = ts; updateHud(); }
}

function handleHit(track) {
  if (!G || G.over || !G.running || G.paused) return;
  var cur = currentNote();
  if (!cur) return;
  if (track !== cur.track) {                     // 点错：红闪「按错的那颗键」并结束
    if (G.started) { G.errors++; playErr(); endGame(track, 'wrong'); }
    return;                                      // 未开始前的误按不算数（预备界面里可以慢慢找键）
  }
  if (cur.hit) return;                           // 同一颗不会被判两次
  if (!G.started) startClock();
  G.score++; G.keyHits++; G.rowHits++;
  markHitNote(cur);
  playHit(); recordHit();
  G.index++;                                     // 下一颗待打
  if (G.cfg.mode === 'endless') {
    G.speed = Math.min(ENDLESS_MAX_SPEED, G.speed * ENDLESS_GROW + ENDLESS_GROW_ADD);
  } else {
    // 限时模式：打对一行就往下一格滑一行（连续补间，与判定共用同一个 rowFloat）
    if (G.rowFloat < G.index - 1) G.rowFloat = G.index - 1;   // 手速极快时不让画面落后太多
    G.anim = { from: G.rowFloat, to: G.index, dur: Math.max(60, Math.min(1200, 1000 / G.speed)) };
    G.animT = 0;
  }
  updateHud();
}

/** 把音符换成「击中后」的外观（皮肤可自定义，默认黑色方块半透明） */
function markHitNote(note) {
  note.hit = true;
  var el = note.el;
  el.style.backgroundImage = (S.skin && S.skin.hit) ? 'url(' + S.skin.hit + ')' : 'none';
  if (!(S.skin && S.skin.hit)) el.classList.add('note-default');
  el.style.opacity = (S.skin && typeof S.skin.hitOpacity === 'number') ? S.skin.hitOpacity : 0.5;
}

/** 无尽模式：这一行被推过一整行还没打 → 漏了，对局结束 */
function missCurrentRow() {
  var cur = currentNote();
  G.errors++; playErr();
  endGame(cur ? cur.track : null, 'miss');
}

/** 结束时的轨道闪烁：红=按错，橙=漏掉（轨道整列与底部键位字母同时闪） */
function flashLane(track, kind) {
  if (track == null) return;
  var cls = kind === 'miss' ? 'miss-flash' : 'bad-flash';
  var lanes = $('gameLanes').children;
  if (lanes[track]) lanes[track].classList.add(cls);
  var keys = $('gameKeys').children;
  if (keys[track]) keys[track].classList.add(cls);
}

function recordHit() {
  var now = Date.now();
  G.lastTap = now;
  G.cps.push(now);
  while (G.cps.length && G.cps[0] < now - 1000) G.cps.shift();
}

/** 第一颗正确的键按下 → 开始（帧循环一直在跑，这里只是把 started 打开） */
function startClock() {
  G.started = true;
  G.startTs = Date.now();
  G.lastTap = G.startTs;
  $('readyOverlay').style.display = 'none';
}

function timeLeftMs() {
  return G.cfg.mode === 'timed' ? Math.max(0, G.cfg.timeLimit * 1000 - G.elapsed) : 0;
}

function updateHud() {
  if (!G) return;
  if (G.cfg.mode === 'endless') {
    $('hudScore').textContent = G.score;
    $('hudCps').textContent = '速度 ' + (G.speed || 0).toFixed(2) + ' 键/秒';
    $('hudTimer').classList.add('is-speed');
    $('hudTimer').classList.remove('timer-flash');
    $('hudTimer').textContent = (G.speed || 0).toFixed(2);
    return;
  }
  var left = timeLeftMs() / 1000;
  $('hudTimer').classList.remove('is-speed');
  $('hudTimer').textContent = left.toFixed(2);
  $('hudTimer').classList.toggle('timer-flash', G.started && left <= 5.99 && !G.over);
  $('hudScore').textContent = G.score;
  $('hudCps').textContent = cpsNow().toFixed(2) + ' CPS';
}
function cpsNow() {
  if (!G || !G.cps.length) return 0;
  var now = Date.now();
  var recent = 0;
  for (var i = G.cps.length - 1; i >= 0; i--) { if (G.cps[i] >= now - 1000) recent++; else break; }
  return Math.max(0, recent - 1);
}

function togglePause(forcePause) {
  if (!G || G.over || !G.running) return;
  var toPause = forcePause != null ? forcePause : !G.paused;
  if (toPause === G.paused) return;
  G.paused = toPause;
  if (G.paused) G.pauseStart = Date.now();
  else if (G.pauseStart != null) { G.pausedMs += Date.now() - G.pauseStart; G.pauseStart = null; }
  $('pauseOverlay').style.display = G.paused ? 'flex' : 'none';
}

function endGame(errTrack, kind) {
  if (G.over) return;
  G.over = true; G.running = false;
  if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
  if (G.pauseStart != null) { G.pausedMs += Date.now() - G.pauseStart; G.pauseStart = null; }
  flashLane(errTrack, kind);        // 红=按错 / 橙=漏掉
  setTimeout(showResult, 900);
}

/** 结算 + 上传排行榜 */
function showResult() {
  var endless = G.cfg.mode === 'endless';
  var survived = G.elapsed;                        // 已进行时间（连续累加，暂停不计）
  var cps = survived > 0 ? (G.score * 1000 / survived) : 0;
  var finalSpeed = endless ? (G.speed || 0) : 0;
  $('resTitle').textContent = endless ? '跟不上了！' : (G.errors > 0 ? '点错了，对局结束' : '时间到！');
  $('resQuote').textContent = endless
    ? ('最终速度 ' + finalSpeed.toFixed(2) + ' 键/秒 —— 这就是你尾判的底力')
    : TC.shareText(G.score, G.cfg.timeLimit);
  $('resTime').textContent = (survived / 1000).toFixed(2) + 's';
  $('resScore').textContent = endless ? finalSpeed.toFixed(2) + ' 键/秒' : G.score;
  $('resRows').textContent = G.rowHits;
  $('resCps').textContent = endless ? finalSpeed.toFixed(2) : cps.toFixed(2);
  $('resErr').textContent = G.errors;
  $('resBpm').textContent = survived > 0 ? (G.rowHits * 15000 / survived).toFixed(2) : '--';
  $('resRank').textContent = '…';
  mask('resultMask', true);

  // 上传：限时只有 20/60/180s 三个预选档上榜；无尽按键数分榜
  if (TC.uploadable(G.cfg.mode, G.cfg.timeLimit)) {
    S.net.send({
      t: 'dili.board.submit',
      mode: G.cfg.mode, keys: G.cfg.keyCount, seconds: G.cfg.timeLimit,
      // 无尽模式的名次看最终速度（键/秒）：这里把它作为 cps 提交，服务端据此算名次
      score: endless ? Math.round(finalSpeed * 100) : G.score,
      timeMs: Math.round(survived),
      cps: Number((endless ? finalSpeed : cps).toFixed(2)),
      errors: G.errors
    });
    S.pendingBoard = G.cfg.mode + '_' + G.cfg.keyCount + '_' + (G.cfg.mode === 'timed' ? G.cfg.timeLimit : 0);
  } else {
    $('resRank').textContent = '自定义时长不计入排行榜';
  }
}

/* ================= 网络回包 ================= */
function initNet() {
  S.net = new WB.Net();
  WB.bindNetBadge($('netBadge'), S.net);
  WB.Friends.boot(S.net);
  WB.Chat.boot(S.net);
  // 平台约定：hello 后向本游戏报到（单人不进房，服务端只回个"就绪"）
  S.net.on('hello', function () { S.net.send({ t: 'dili.register' }); });

  S.net.on('dili.board', function (m) { renderBoard(m.list, m.mode); });
  S.net.on('dili.board.result', function (m) {
    if (!G || G.over !== true) return;
    var lines = [];
    if (m.rank) lines.push('🎉 当前第 <b>' + m.rank + '</b> 名');
    else lines.push('这次没进前 50，继续练！');
    if (m.improved === false && m.ownBest) lines.push('没超过你的最佳（' + m.ownBest.score + ' 分）');
    else if (m.improved) lines.push('个人新纪录！');
    if (m.best) lines.push('榜首：' + esc(m.best.name) + ' ' + m.best.score + ' 分');
    $('resRank').innerHTML = lines.join(' · ');
    refreshBoard();          // 侧栏实时刷新
  });
  S.net.on('dili.like.ok', function (m) {
    WB.ui.toast(m.already ? '已经赞过啦' : '点赞成功', 'ok');
    refreshBoard();
  });
  S.net.on('dili.like.fail', function (m) { WB.ui.toast(m.msg || '点赞失败', 'warn'); });
    S.net.on('dili.skin.one', function (m) {
    if (!m.skin) return;
    applySkin(m.skin, true);
    mask('plazaMask', false);
    WB.ui.toast('已换上皮肤「' + m.skin.name + '」（作者：' + m.skin.author + '）', 'ok');
  });
  S.net.on('dili.skin.get.fail', function (m) { WB.ui.toast(m.msg || '皮肤获取失败', 'warn'); });
  S.net.on('dili.skin.upload.ok', function (m) {
    WB.ui.toast('皮肤「' + m.name + '」已上架皮肤广场', 'ok');
  });
  S.net.on('dili.skin.upload.fail', function (m) { WB.ui.toast(m.msg || '上传失败', 'warn'); });
}

/* ================= 皮肤 ================= */
var SKIN_FIELDS = ['bg', 'keyBg', 'note', 'hit', 'hitSound', 'errSound'];
function defaultSkin() { return { name: '默认皮肤', hitOpacity: 0.5 }; }
function applySkin(skin, persist) {
  S.skin = skin || null;
  if (persist) saveJson('dili.skin.current', S.skin);
  // 清掉内存里的旧音频池
  audioPool.hit = []; audioPool.err = [];
  refreshSkinNowLine();
  if (G && G.metrics) applyLayout();      // 对局中换肤（暂停时）立即生效
  if ($('skinMask').style.display !== 'none') renderPreview();
}
function refreshSkinNowLine() {
  $('skinNow').textContent = '当前皮肤：' + (S.skin ? (S.skin.name || '未命名') : '默认（黑色方块 · 击中半透明）');
}

/* ---- 皮肤编辑器 ---- */
function openSkinEditor() {
  S.draft = {};
  var cur = S.skin || defaultSkin();
  $('skinName').value = cur.name && cur.name !== '默认皮肤' ? cur.name : '';
  $('skinOpacity').value = Math.round((typeof cur.hitOpacity === 'number' ? cur.hitOpacity : 0.5) * 100);
  $('valOpacity').textContent = $('skinOpacity').value + '%';
  for (var i = 0; i < SKIN_FIELDS.length; i++) {
    var f = SKIN_FIELDS[i];
    S.draft[f] = cur[f] || null;
    var inp = $({ bg: 'fileBg', keyBg: 'fileKeyBg', note: 'fileNote', hit: 'fileHit', hitSound: 'fileHitSnd', errSound: 'fileErrSnd' }[f]);
    if (inp) inp.value = '';
  }
  updateThumbs(); updateSizeTip();
  mask('skinMask', true);
  renderPreview();
}
function updateThumbs() {
  var map = { bg: 'thumbBg', keyBg: 'thumbKeyBg', note: 'thumbNote', hit: 'thumbHit' };
  for (var f in map) {
    var img = $(map[f]);
    if (S.draft[f]) { img.src = S.draft[f]; img.style.display = ''; }
    else img.style.display = 'none';
  }
}
function draftSize() {
  var n = 0;
  for (var i = 0; i < SKIN_FIELDS.length; i++) n += S.draft[SKIN_FIELDS[i]] ? S.draft[SKIN_FIELDS[i]].length : 0;
  return n;
}
function updateSizeTip() {
  var kb = Math.round(draftSize() * 3 / 4 / 1024);
  $('skinSizeTip').textContent = kb ? '素材合计约 ' + kb + ' KB' +
    (kb > 3072 ? '（超过 3MB，无法上传广场）' : '') : '';
}
function readFile(input, cb) {
  var f = input.files && input.files[0];
  if (!f) return;
  if (f.size > 900 * 1024) { WB.ui.toast('文件太大（限 900KB），请压缩后再选', 'warn'); input.value = ''; return; }
  var r = new FileReader();
  r.onload = function () { cb(String(r.result)); };
  r.readAsDataURL(f);
}
function collectDraft() {
  var d = S.draft;
  return {
    name: ($('skinName').value || '').trim() || '未命名皮肤',
    bg: d.bg || null, keyBg: d.keyBg || null, note: d.note || null, hit: d.hit || null,
    hitSound: d.hitSound || null, errSound: d.errSound || null,
    hitOpacity: Number($('skinOpacity').value) / 100
  };
}

/* 预览：小 4K 条，展示 bg / 键背景 / 音符 / 击中后 */
function renderPreview() {
  var d = S.draft || {};
  var box = $('previewBox');
  var w = box.clientWidth || 220;
  $('pvBg').style.backgroundImage = d.bg ? 'url(' + d.bg + ')' : 'none';
  var lanes = $('pvLanes');
  lanes.innerHTML = '';
  for (var i = 0; i < 4; i++) {
    var lane = document.createElement('div');
    lane.className = 'pv-lane';
    lane.style.left = (i * 25) + '%'; lane.style.width = '25%';
    if (d.keyBg) lane.style.backgroundImage = 'url(' + d.keyBg + ')';
    lanes.appendChild(lane);
  }
  var note = $('pvNote'), hit = $('pvHit');
  note.style.backgroundImage = d.note ? 'url(' + d.note + ')' : 'none';
  note.classList.toggle('note-default', !d.note);
  note.style.backgroundSize = d.note ? 'cover' : 'auto';
  hit.style.backgroundImage = d.hit ? 'url(' + d.hit + ')' : 'none';
  hit.classList.toggle('note-default', !d.hit);
  hit.style.backgroundSize = d.hit ? 'cover' : 'auto';
  hit.style.opacity = Number($('skinOpacity').value) / 100;
  document.body.style.setProperty('--pv-note-h', Math.max(48, Math.round(w / 4)) + 'px');
}

/* ---- 皮肤广场：主页展示条（点击即用）+ 工坊里的完整弹窗 ---- */
function openPlaza() { S.net.send({ t: 'dili.skin.list' }); mask('plazaMask', true); }
function renderPlaza(list) {
  var strip = $('menuPlaza');
  if (!list.length) strip.innerHTML = '<p class="dim small">广场还是空的——做一款皮肤传上来吧！</p>';
  else {
    var html = '';
    for (var i = 0; i < Math.min(list.length, 8); i++) {
      var sk = list[i];
      html += '<button class="plaza-card" data-use="' + esc(sk.id) + '">' +
        '<span class="p-dot"></span><span class="p-name">' + esc(sk.name) + '</span>' +
        '<span class="p-meta">' + esc(sk.author) + '</span></button>';
    }
    strip.innerHTML = html;
    var cards = strip.querySelectorAll('[data-use]');
    for (var c = 0; c < cards.length; c++) {
      cards[c].onclick = function () { S.net.send({ t: 'dili.skin.get', id: this.getAttribute('data-use') }); };
    }
  }
  var box = $('plazaList');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<p class="dim">广场还是空的——做一款皮肤传上来吧！</p>'; return; }
  var html2 = '';
  for (var k = 0; k < list.length; k++) {
    var sk2 = list[k];
    html2 += '<div class="plaza-row"><span class="p-name">' + esc(sk2.name) + '</span>' +
      '<span class="p-meta">' + esc(sk2.author) + ' · ' + new Date(sk2.time).toLocaleString() +
      (sk2.size ? ' · 约 ' + Math.round(sk2.size * 3 / 4 / 1024) + ' KB' : '') + '</span>' +
      '<button class="btn tiny primary" data-use2="' + esc(sk2.id) + '">使用</button></div>';
  }
  box.innerHTML = html2;
  var btns = box.querySelectorAll('[data-use2]');
  for (var j = 0; j < btns.length; j++) {
    btns[j].onclick = function () { S.net.send({ t: 'dili.skin.get', id: this.getAttribute('data-use2') }); };
  }
}

/* ================= 布局面板 ================= */
function openLayout() {
  var l = S.layout;
  $('layWidth').value = l.width; $('valWidth').textContent = l.width + '%';
  $('layBlock').value = l.block; $('valBlock').textContent = l.block + '%';
  $('layJudge').value = l.judge; $('valJudge').textContent = l.judge + '%';
  $('valKeyN').textContent = S.keys + 'K';
  $('layKeyShow').textContent = '当前键位：' + trackLabels(S.keys).join(' / ');
  $('layShowKeys').checked = l.showKeys;
  mask('layoutMask', true);
}
/* ================= 排行榜（菜单侧栏，实时） ================= */
var boardSel = { mode: 'timed', keys: 4, seconds: 20 };
function refreshBoard() {
  S.net.send({ t: 'dili.board.get', mode: boardSel.mode, keys: boardSel.keys, seconds: boardSel.seconds });
}
function bindBoardChips() {
  function chips(rowId, attr, key) {
    var row = $(rowId);
    var btns = row.querySelectorAll('.chip');
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () {
        var all = row.querySelectorAll('.chip');
        for (var j = 0; j < all.length; j++) all[j].classList.remove('on');
        this.classList.add('on');
        boardSel[key] = Number(this.getAttribute(attr));
        refreshBoard();
      };
    }
  }
  chips('boardKeys', 'data-bkeys', 'keys');
  chips('boardMode', 'data-bmode', 'mode');
  chips('boardSecs', 'data-bsec', 'seconds');
  var secsRow = $('boardSecs');
  secsRow.style.display = boardSel.mode === 'timed' ? '' : 'none';
  var modeBtns = $('boardMode').querySelectorAll('.chip');
  for (var m = 0; m < modeBtns.length; m++) {
    modeBtns[m].addEventListener('click', function () {
      boardSel.mode = this.getAttribute('data-bmode');
      secsRow.style.display = boardSel.mode === 'timed' ? '' : 'none';
      refreshBoard();
    });
  }
}
function renderBoard(list, mode) {
  var box = $('menuBoard');
  var endless = mode === 'endless' || (mode == null && boardSel.mode === 'endless');
  if (!list || !list.length) {
    box.innerHTML = '<p class="dim small">这个赛道貌似还没人挑战欸，快去挑战！</p>';
    return;
  }
  var html = '<table><tr><th>#</th><th>玩家</th><th>' + (endless ? '最终速度' : '分数') + '</th><th>赞</th><th>创造时间</th></tr>';
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var arrow = e.trend === 'up' ? ' <span class="trend-up">▲</span>' : (e.trend === 'down' ? ' <span class="trend-down">▼</span>' : '');
    var when = new Date(e.date);
    var whenStr = (when.getMonth() + 1) + '/' + when.getDate() + ' ' +
      ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2);
    html += '<tr' + (i === 0 ? ' class="top1"' : '') + '><td class="num">' + (i + 1) + arrow + '</td>' +
      '<td>' + esc(e.name) + '</td>' +
      '<td class="num"><b>' + (endless ? (e.score / 100).toFixed(2) + ' 键/秒' : e.score) + '</b></td>' +
      '<td class="num"><button class="like-btn" data-like="' + esc(e.ip) + '" title="给 TA 点赞">👍 ' + (e.likes || 0) + '</button></td>' +
      '<td class="num">' + whenStr + '</td></tr>';
  }
  html += '</table>';
  box.innerHTML = html;
  var btns = box.querySelectorAll('[data-like]');
  for (var j = 0; j < btns.length; j++) {
    btns[j].onclick = function () { S.net.send({ t: 'dili.like', mode: boardSel.mode, keys: boardSel.keys, seconds: boardSel.seconds, target: this.getAttribute('data-like') }); };
  }
}

/* ================= 事件绑定 ================= */
function bindMenu() {
  function chips(rowId, attr, cb) {
    var row = $(rowId);
    var btns = row.querySelectorAll('.chip');
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () {
        var all = row.querySelectorAll('.chip');
        for (var j = 0; j < all.length; j++) all[j].classList.remove('on');
        this.classList.add('on');
        cb(this.getAttribute(attr));
      };
    }
  }
  chips('rowKeys', 'data-keys', function (v) {
    S.keys = Number(v);
    $('valKeyN').textContent = S.keys + 'K';
    renderKeyHint();
  });
  chips('rowMode', 'data-mode', function (v) {
    S.mode = v;
    $('rowTimed').style.display = v === 'timed' ? '' : 'none';
    $('rowEndless').style.display = v === 'endless' ? '' : 'none';
  });
  chips('rowSeconds', 'data-sec', function (v) {
    var n = Number(v);
    S.seconds = n === 0 ? Math.max(5, Number($('inpSeconds').value) || 30) : n;
    $('inpSeconds').style.display = n === 0 ? '' : 'none';
    $('secUnit').style.display = n === 0 ? '' : 'none';
  });
  $('inpSeconds').onchange = function () { S.seconds = Math.max(5, Math.min(600, Number(this.value) || 30)); };

  $('btnStart').onclick = function () { WB.audio.play('click'); startGame(); };
  $('btnLayout').onclick = openLayout;
  $('btnSkin').onclick = openSkinEditor;

  $('btnRetry').onclick = function () { mask('resultMask', false); startGame(); };
  $('btnBackMenu').onclick = function () { mask('resultMask', false); show('scr-menu'); };
  $('btnPause').onclick = function () { togglePause(); };
  $('btnQuit').onclick = function () {
    if (G && !G.over) { G.over = true; G.running = false; if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; } }
    $('pauseOverlay').style.display = 'none';
    show('scr-menu');
  };
  $('pauseOverlay').onclick = function () { togglePause(false); };
}

function bindLayout() {
  $('layWidth').oninput = function () { $('valWidth').textContent = this.value + '%'; };
  $('layBlock').oninput = function () { $('valBlock').textContent = this.value + '%'; };
  $('layJudge').oninput = function () { $('valJudge').textContent = this.value + '%'; };
  $('laySave').onclick = function () {
    S.layout.width = Number($('layWidth').value);
    S.layout.block = Number($('layBlock').value);
    S.layout.judge = Number($('layJudge').value);
    S.layout.showKeys = $('layShowKeys').checked;
    saveJson('dili.layout', S.layout);
    mask('layoutMask', false);
    WB.ui.toast('布局已保存', 'ok');
  };
  $('layReset').onclick = function () {
    S.layout = {
      width: DEFAULT_LAYOUT.width, block: DEFAULT_LAYOUT.block, judge: DEFAULT_LAYOUT.judge,
      showKeys: DEFAULT_LAYOUT.showKeys
    };
    saveJson('dili.layout', S.layout);
    openLayout();
  };
  $('layClose').onclick = function () { mask('layoutMask', false); };
}

function bindSkin() {
  var files = { fileBg: 'bg', fileKeyBg: 'keyBg', fileNote: 'note', fileHit: 'hit', fileHitSnd: 'hitSound', fileErrSnd: 'errSound' };
  for (var id in files) {
    (function (inputId, field) {
      $(inputId).onchange = function () {
        readFile(this, function (uri) {
          S.draft[field] = uri;
          updateThumbs(); updateSizeTip(); renderPreview();
        });
      };
    })(id, files[id]);
  }
  var clears = document.querySelectorAll('[data-clear]');
  for (var i = 0; i < clears.length; i++) {
    clears[i].onclick = function () {
      S.draft[this.getAttribute('data-clear')] = null;
      updateThumbs(); updateSizeTip(); renderPreview();
    };
  }
  var plays = document.querySelectorAll('[data-play]');
  for (var j = 0; j < plays.length; j++) {
    plays[j].onclick = function () {
      var uri = S.draft[this.getAttribute('data-play')];
      if (!uri) { WB.ui.toast('这个音效还没选文件', 'warn'); return; }
      playSkinSound(this.getAttribute('data-play') === 'hitSound' ? 'hit' : 'err', uri);
    };
  }
  $('skinOpacity').oninput = function () { $('valOpacity').textContent = this.value + '%'; renderPreview(); };
  $('skinSaveLocal').onclick = function () {
    var skin = collectDraft();
    if (!saveJson('dili.skin.current', skin)) {
      WB.ui.toast('素材太大，浏览器存不下——试试压缩图片，或只上传到广场', 'warn');
      return;
    }
    applySkin(skin, false);
    mask('skinMask', false);
    WB.ui.toast('皮肤「' + skin.name + '」已保存并使用', 'ok');
  };
  $('skinUpload').onclick = function () {
    var skin = collectDraft();
    if (draftSize() > 3 * 1024 * 1024) { WB.ui.toast('皮肤整体超过 3MB，无法上传', 'warn'); return; }
    S.net.send({ t: 'dili.skin.upload', skin: skin });
  };
  $('skinPlaza').onclick = openPlaza;
  $('skinReset').onclick = function () {
    applySkin(null, true);
    WB.ui.toast('已恢复默认皮肤', 'ok');
    mask('skinMask', false);
  };
  $('skinClose').onclick = function () { mask('skinMask', false); };
  $('plazaClose').onclick = function () { mask('plazaMask', false); };
}

function bindBoard() { bindBoardChips(); }

/* ================= 键盘 / 指针 ================= */
function inTextInput(e) {
  var t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
function bindInput() {
  document.addEventListener('keydown', function (e) {
    if (inTextInput(e)) return;
    // 结算界面：R 重开
    if ($('resultMask').style.display !== 'none' && e.key.toLowerCase() === 'r') {
      mask('resultMask', false); startGame(); return;
    }
    if (!$('scr-game') || $('scr-game').style.display === 'none') return;
    if (e.repeat) return;                          // 长按/连发不算——否则自动重复会被当成连击，出现"莫名其妙失败"
    if (!G || G.over) return;
    if ($('pauseOverlay').style.display !== 'none') { e.preventDefault(); togglePause(false); return; }
    if (e.code === 'Escape') { e.preventDefault(); togglePause(); return; }
    // 轨道键优先：5K 的中间轨本身就是空格，不能先被"空格=暂停"截走
    var track = trackCodes(S.keys).indexOf(e.code);
    if (track !== -1) { e.preventDefault(); handleHit(track); return; }
    if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  });
  $('gameViewport').addEventListener('pointerdown', function (e) {
    if (!G || G.over || G.paused) return;
    if (e.target && e.target.closest && e.target.closest('.game-hud')) return;   // 点 HUD 上的按钮不算判定
    var inner = $('gameInner').getBoundingClientRect();
    var track = Math.floor((e.clientX - inner.left) / G.metrics.blockSize);
    if (track < 0) track = 0;
    if (track >= S.keys) track = S.keys - 1;
    handleHit(track);
  });
}

/* ================= 主页键位：点一下就能改键 =================
 * 与右上角 ⚙ 设置里的键位表读写同一份数据（WB.settings.keymaps.dili），
 * 所以在哪儿改都会立即同步；save() 会 dispatch wb:settings → renderKeyHint 重画。
 */
/** 当前键数对应的平台玩家 id（4K→p4k、5K→p5k、6K→p6k） */
function currentPid() { return ['p4k', 'p5k', 'p6k'][KEY_PLAYER[S.keys] || 0]; }

/** 主页键位显示：4K 显示 4 个键、5K 显示 5 个、6K 显示 6 个；每个键点一下即可改 */
function renderKeyHint() {
  var el = $('keyHint');
  if (!el) return;
  var map = WB.settings.keysFor('dili', KEY_PLAYER[S.keys] || 0) || {};
  var html = '键位：';
  for (var i = 0; i < S.keys; i++) {
    var code = map['t' + (i + 1)];
    html += '<button type="button" class="key-btn" data-track="' + i + '" title="点一下，再按新键即可修改">' +
      esc(codeLabel(code)) + '</button>';
  }
  el.innerHTML = html + ' <span class="dim small">（点一下就能改键 · 也可在右上角 ⚙ 设置里改）</span>';
  var btns = el.querySelectorAll('.key-btn');
  for (var b = 0; b < btns.length; b++) btns[b].onclick = function () { captureKey(this); };
}

/** 主页改键：抓一次按键写进平台设置（设置弹窗 / 开局键位提示会同步刷新） */
function captureKey(btn) {
  if (S.capturing) return;
  S.capturing = true;
  var track = Number(btn.getAttribute('data-track'));
  var old = btn.textContent;
  btn.classList.add('capturing');
  btn.textContent = '按新键…';
  WB.keys.capture(function (code) {
    S.capturing = false;
    btn.classList.remove('capturing');
    btn.textContent = old;
    if (!code) return;                       // Esc 取消
    var pid = currentPid();
    var action = 't' + (track + 1);
    var conflict = WB.settings.conflict('dili', pid, action, code);
    if (conflict) {
      var label = conflict;
      WB.settings.actionsFor('dili', pid).forEach(function (x) { if (x.k === conflict) label = x.label; });
      WB.ui.toast('该键已被「' + label + '」占用', 'err');
      return;
    }
    var s = WB.settings.get();
    if (!s.keymaps.dili) s.keymaps.dili = {};
    if (!s.keymaps.dili[pid]) s.keymaps.dili[pid] = {};
    s.keymaps.dili[pid][action] = code;
    WB.settings.save();
    WB.ui.toast('键位已更新', 'ok');
  });
}

/* ================= 菜单背景：游戏画面 ================= */
function buildMenuBg() {
  var bg = $('menuBg');
  bg.innerHTML = '';
  var k = 6;
  var w = bg.clientWidth || window.innerWidth;
  var laneW = w / k;
  for (var i = 0; i < k; i++) {
    var lane = document.createElement('div');
    lane.className = 'mb-lane';
    lane.style.left = (i * laneW) + 'px';
    lane.style.width = laneW + 'px';
    bg.appendChild(lane);
  }
  var h = bg.clientHeight || window.innerHeight;
  var cell = Math.max(56, Math.min(laneW, h / 8));
  for (var c = 0; c < k; c++) {
    var n = 2 + Math.floor(Math.random() * 2);
    for (var r = 0; r < n; r++) {
      var note = document.createElement('div');
      note.className = 'mb-note';
      note.style.left = (c * laneW + 3) + 'px';
      note.style.width = (laneW - 6) + 'px';
      note.style.height = (cell - 6) + 'px';
      note.style.top = Math.floor(Math.random() * (h - cell)) + 'px';
      bg.appendChild(note);
    }
  }
}

/* ================= 启动 ================= */
function boot() {
  S.layout = loadLayout();
  S.skin = loadJson('dili.skin.current', null);
  initNet();
  bindMenu(); bindLayout(); bindSkin(); bindBoard(); bindInput();
  $('btnSettings').onclick = WB.ui.openSettings;
  refreshSkinNowLine();
  renderKeyHint();
  window.addEventListener('wb:settings', renderKeyHint);
  buildMenuBg();
  window.addEventListener('resize', function () { buildMenuBg(); });
  // 侧栏「实时」刷新：停在菜单上时每 6 秒拉一次（别人刚刷的纪录也能看到）
  setInterval(function () {
    if ($('scr-menu') && $('scr-menu').style.display !== 'none' && S.net && S.net.status === 'open') refreshBoard();
  }, 6000);
  // 实时数据：连接一好就拉榜单和广场
  S.net.on('hello', function () { refreshBoard(); S.net.send({ t: 'dili.skin.list' }); });
  window.addEventListener('resize', function () { if (G && G.metrics && !$('scr-game').style.display) applyLayout(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
