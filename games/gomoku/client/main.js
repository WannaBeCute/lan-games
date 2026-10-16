/*!
 * 五子棋 —— 客户端主逻辑（单人对战 AI / 邀请制联机）
 * 规则：传统五子棋，五子连线即胜；每人各有一次悔棋机会（联机需对方同意）
 */
(function () {
  'use strict';

  var SIZE = 15, CELL = 36, PAD = 34;
  var LOGIC = (SIZE - 1) * CELL + PAD * 2;
  var STAR = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
  var WB = window.WB;

  var cv, ctx;
  var G = {
    mode: null,              // 'ai' | 'online'
    board: new Array(SIZE * SIZE).fill(0),
    moves: [],
    turn: 1,
    myColor: 1,
    over: false,
    win: null,
    last: null,
    undoLeft: { 1: 1, 2: 1 },
    canUndo: { 1: false, 2: false },
    dropped: { 1: false, 2: false },   // 谁掉线了（宽限期里服务端不会结束对局）
    aiLevel: 1,
    thinking: false,
    aiTimer: 0,
    hx: -1, hy: -1,          // 我方预览位置
    rx: -1, ry: -1,          // 对方预览位置（联机）
    showNum: false,
    showCoord: true,
    matchId: null,
    players: null,
    myCode: '',
    waitingInvite: null,
    lastKey: '',
    hoverKey: '',
    hoverAt: 0,
    scale: 1
  };

  /** 现在是不是轮到我落子（决定我方预览显不显示） */
  function isMyTurn() {
    if (G.over) return false;
    if (G.mode === 'ai') return G.turn === 1 && !G.thinking;
    if (G.mode === 'online') return G.turn === G.myColor;
    return false;
  }

  function $(id) { return document.getElementById(id); }
  function esc(s) { return WB.util.esc(s); }
  function idx(x, y) { return y * SIZE + x; }

  /* ================= 画面 ================= */
  var SCREENS = ['scr-menu', 'scr-online', 'scr-play'];
  function show(id) {
    SCREENS.forEach(function (s) { $(s).classList.toggle('hidden', s !== id); });
    if (id === 'scr-play') resizeBoard();
  }

  /* ================= 画布 ================= */
  function resizeBoard() {
    var wrapEl = document.querySelector('.board-wrap');
    var availW = Math.min(window.innerWidth - 60, window.innerHeight - 200, 720);
    availW = Math.max(300, availW);
    var scale = Math.min(1.15, availW / LOGIC);
    G.scale = scale;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.width = Math.round(LOGIC * scale) + 'px';
    cv.style.height = Math.round(LOGIC * scale) + 'px';
    cv.width = Math.round(LOGIC * scale * dpr);
    cv.height = Math.round(LOGIC * scale * dpr);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    render();
  }
  window.addEventListener('resize', function () { if (G.mode) resizeBoard(); });

  function px(i) { return PAD + i * CELL; }

  var SERIF = '"楷体","KaiTi","STKaiti","宋体","SimSun",Georgia,serif';

  function render() {
    ctx.clearRect(0, 0, LOGIC, LOGIC);

    // 外面一圈深一点的木框
    var IN = 6;
    ctx.fillStyle = '#a9713c';
    ctx.fillRect(0, 0, LOGIC, LOGIC);

    // 棋盘面：浅木色 + 细木纹
    var IW = LOGIC - IN * 2;
    ctx.fillStyle = '#deb887';
    ctx.fillRect(IN, IN, IW, IW);
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = '#7a4f21';
    for (var g1 = 0; g1 < 140; g1++) ctx.fillRect(IN, IN + g1 * (IW / 140), IW, 1);
    ctx.globalAlpha = 0.03;
    ctx.fillStyle = '#4a2e12';
    for (var g2 = 0; g2 < 26; g2++) ctx.fillRect(IN, IN + ((g2 * 53) % IW), IW, 2);
    ctx.restore();

    // 棋盘面与木框的交界
    ctx.strokeStyle = 'rgba(120,80,44,.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(IN + 0.5, IN + 0.5, IW - 1, IW - 1);

    // 网格线（深棕）
    ctx.strokeStyle = '#5a3a22';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i < SIZE; i++) {
      ctx.moveTo(px(i), px(0)); ctx.lineTo(px(i), px(SIZE - 1));
      ctx.moveTo(px(0), px(i)); ctx.lineTo(px(SIZE - 1), px(i));
    }
    ctx.stroke();
    // 棋盘外框略粗
    ctx.lineWidth = 2;
    ctx.strokeRect(px(0), px(0), (SIZE - 1) * CELL, (SIZE - 1) * CELL);

    // 星位
    ctx.fillStyle = '#4a2e18';
    STAR.forEach(function (s) {
      ctx.beginPath(); ctx.arc(px(s[0]), px(s[1]), 3.6, 0, Math.PI * 2); ctx.fill();
    });

    // 坐标
    if (G.showCoord) {
      ctx.fillStyle = '#6b4a2f';
      ctx.font = '600 13px ' + SERIF;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var c = 0; c < SIZE; c++) {
        ctx.fillText(String.fromCharCode(65 + c), px(c), PAD - 17);
        ctx.fillText(String(c + 1), PAD - 17, px(c));
      }
    }

    // 棋子
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) {
        var v = G.board[idx(x, y)];
        if (v) drawStone(px(x), px(y), v);
      }
    }

    // 最后一手：传统红点标记
    if (G.last && !G.over) {
      ctx.beginPath();
      ctx.arc(px(G.last.x), px(G.last.y), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#b23a2e';
      ctx.fill();
    }

    // 手数
    if (G.showNum && G.moves.length) {
      ctx.font = '600 13px Georgia, ' + SERIF;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var m = 0; m < G.moves.length; m++) {
        var mv = G.moves[m];
        ctx.fillStyle = mv.p === 1 ? 'rgba(247,243,232,.85)' : 'rgba(20,16,12,.8)';
        ctx.fillText(String(m + 1), px(mv.x), px(mv.y));
      }
    }

    // 五连：朴素的红棕细线
    if (G.win && G.win.line && G.win.line.length) {
      var a = G.win.line[0], b = G.win.line[G.win.line.length - 1];
      ctx.save();
      ctx.strokeStyle = 'rgba(178,58,46,.9)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px(a[0]), px(a[1]));
      ctx.lineTo(px(b[0]), px(b[1]));
      ctx.stroke();
      ctx.restore();
    }

    // 对方的落子预览（联机）：淡棋子 + 虚线圈，颜色就是当前该落子的一方
    if (!G.over && G.mode === 'online' && G.turn !== G.myColor &&
        G.rx >= 0 && G.ry >= 0 && G.board[idx(G.rx, G.ry)] === 0) {
      ctx.save();
      ctx.globalAlpha = 0.26;
      drawStone(px(G.rx), px(G.ry), G.turn);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = 'rgba(178,58,46,.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(px(G.rx), px(G.ry), CELL * 0.44 + 3.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 我方的落子预览：轮到自己时才显示，颜色是自己棋子的颜色（黑方显黑子、白方显白子）
    if (isMyTurn() && G.hx >= 0 && G.hy >= 0 && G.board[idx(G.hx, G.hy)] === 0) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      drawStone(px(G.hx), px(G.hy), G.myColor);
      ctx.restore();
    }
  }

  function drawStone(x, y, p) {
    var r = CELL * 0.44;
    // 淡淡的投影，让棋子像落在木板上
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + 1.5, y + 2.5, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(60,36,16,.3)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (p === 1) {
      ctx.fillStyle = '#0e0e0e';          // 黑子：纯黑
      ctx.fill();
      ctx.strokeStyle = '#000';
    } else {
      ctx.fillStyle = '#f7f3e8';          // 白子：米白
      ctx.fill();
      ctx.strokeStyle = '#b9ac90';
    }
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /* ================= 规则 ================= */
  function findLine(board, x, y, p) {
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var d = 0; d < 4; d++) {
      var line = [[x, y]];
      for (var s = 1; s <= 1; s++) {
        // 正向
        var cx = x + dirs[d][0], cy = y + dirs[d][1];
        while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[idx(cx, cy)] === p) { line.push([cx, cy]); cx += dirs[d][0]; cy += dirs[d][1]; }
        // 反向
        cx = x - dirs[d][0]; cy = y - dirs[d][1];
        while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[idx(cx, cy)] === p) { line.push([cx, cy]); cx -= dirs[d][0]; cy -= dirs[d][1]; }
      }
      if (line.length >= 5) {
        line.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        return line;
      }
    }
    return null;
  }

  /* ================= 单人对战 AI ================= */
  var PENDING = null;

  function newAiGame(level) {
    if (level != null) G.aiLevel = level;
    clearTimeout(PENDING);
    G.mode = 'ai';
    G.board = new Array(SIZE * SIZE).fill(0);
    G.moves = [];
    G.turn = 1;
    G.myColor = 1;
    G.over = false; G.win = null; G.last = null;
    G.undoLeft = { 1: 1, 2: 1 };
    G.canUndo = { 1: false, 2: false };
    G.thinking = false;
    resetPreview();
    G.players = { 1: { name: WB.playerName() }, 2: { name: '电脑 · ' + ['简单', '普通', '困难'][G.aiLevel] } };
    G.matchId = null;
    $('codePanel').classList.add('hidden');
    $('btnUndo').style.display = '';
    $('btnResign').style.display = '';
    $('btnNew').textContent = '重新开始';
    hideOverlay();
    show('scr-play');
    updatePanel();
    render();
  }

  function aiMove() {
    if (G.over || G.mode !== 'ai') return;
    G.thinking = true;
    updatePanel();
    var mv = window.GomokuAI.think(G.board, SIZE, 2, G.aiLevel);
    PENDING = setTimeout(function () {
      G.thinking = false;
      if (G.over || G.mode !== 'ai') return;
      playLocal(mv.x, mv.y, 2);
      if (!G.over) G.turn = 1;
      updatePanel();
      render();
      checkEnd();
    }, 260 + Math.random() * 320);
  }

  function playLocal(x, y, p) {
    G.board[idx(x, y)] = p;
    G.moves.push({ x: x, y: y, p: p });
    G.last = { x: x, y: y, p: p };
    WB.audio.play('place');
    var line = findLine(G.board, x, y, p);
    if (line) { G.win = { p: p, line: line }; G.over = true; }
    else if (G.moves.length >= SIZE * SIZE) { G.win = { p: 0, line: [] }; G.over = true; }
  }

  function checkEnd() {
    if (!G.over) return;
    if (G.win.p === 0) {
      showOverlay('<h2>平局</h2><p>棋盘已满，本局不分胜负</p>' + btns());
      WB.audio.play('error');
    } else {
      var iWin = G.win.p === G.myColor;
      showOverlay('<h2>' + (iWin ? '你赢了！' : '电脑获胜') + '</h2>' +
        '<p>' + (iWin ? '五子连珠，漂亮' : '再来一局试试另一个思路') + '</p>' + btns());
      WB.audio.play(iWin ? 'win' : 'lose');
    }
    bindOverlay();
  }
  function btns() {
    return '<div class="obtns"><button class="btn primary" id="ovAgain">再来一局</button>' +
      '<button class="btn ghost" id="ovMenu">返回菜单</button></div>';
  }
  function bindOverlay() {
    var a = $('ovAgain'); if (a) a.onclick = function () { if (G.mode === 'ai') newAiGame(); else reInvite(); };
    var m = $('ovMenu'); if (m) m.onclick = function () { toMenu(); };
    var h = $('ovBack'); if (h) h.onclick = function () { toMenu(); };
  }
  function showOverlay(html) { $('overlayInner').innerHTML = html; $('overlay').classList.remove('hidden'); }
  function hideOverlay() { $('overlay').classList.add('hidden'); }

  function toMenu() {
    clearTimeout(PENDING);
    if (G.mode === 'online' && G.matchId && !G.over) SEND({ t: 'gomoku.leave' });
    if (G.matchId) WB.Chat.leaveRoom();       // 离开这一局 → 关掉对局聊天频道
    G.mode = null; G.matchId = null; G.over = false;
    resetPreview();
    hideOverlay();
    show('scr-menu');
  }

  function resetPreview() {
    G.hx = -1; G.hy = -1; G.rx = -1; G.ry = -1; G.hoverKey = '';
  }

  /* ================= 悔棋 ================= */
  function canUndoAi() {
    if (G.over || G.mode !== 'ai') return false;
    if (G.undoLeft[1] <= 0) return false;
    for (var i = G.moves.length - 1; i >= 0; i--) if (G.moves[i].p === 1) return true;
    return false;
  }

  /** 单机：撤回自己最近一手（连同电脑紧跟的那一手应手） */
  function undoAi() {
    if (G.over) { WB.ui.toast('本局已结束'); return; }
    if (G.undoLeft[1] <= 0) { WB.ui.toast('你的悔棋机会已用完', 'err'); WB.audio.play('error'); return; }
    var at = -1;
    for (var i = G.moves.length - 1; i >= 0; i--) if (G.moves[i].p === 1) { at = i; break; }
    if (at < 0) { WB.ui.toast('还没有可以撤回的棋'); return; }
    clearTimeout(PENDING);
    G.thinking = false;
    var removed = G.moves.splice(at);
    removed.forEach(function (m) { G.board[idx(m.x, m.y)] = 0; });
    G.undoLeft[1] -= 1;
    G.turn = 1;
    G.over = false; G.win = null;
    G.last = G.moves.length ? G.moves[G.moves.length - 1] : null;
    WB.audio.play('undo');
    WB.ui.toast('已悔棋，剩余 ' + G.undoLeft[1] + ' 次', 'ok');
    hideOverlay();
    updatePanel();
    render();
  }

  function doUndo() {
    if (G.over) { WB.ui.toast('本局已结束'); return; }
    if (G.mode === 'ai') { undoAi(); return; }
    if (G.mode !== 'online') return;
    if (G.undoLeft[G.myColor] <= 0) { WB.ui.toast('你的悔棋机会已用完', 'err'); WB.audio.play('error'); return; }
    if (!G.canUndo[G.myColor]) {
      WB.ui.toast('对方已经落子，这一手不能悔了', 'err');
      WB.audio.play('error');
      return;
    }
    // 不需要对方同意，直接悔
    SEND({ t: 'gomoku.undo' });
    WB.audio.play('click');
  }

  /* ================= 联机 ================= */
  var NET = null;
  /** 好友组队邀请直达：从 /gomoku/?invite=... 打开时，拿到自己的邀请码后自动向对方发起对局 */
  var PENDING_FRIEND_INVITE = null;
  /*
   * 本标签页的稳定身份钥匙（平台层 WB.me 提供）。
   * 平台每次连接都会分配新的 id、昵称没设置时还是随机的 —— 于是「刷新一下、
   * 断网重连一下」在服务端看来就是换了个陌生人：对局被当成掉线销毁，页面却还停在
   * 棋盘上，点哪儿都没反应（连接徽标还是绿的、聊天也正常）。每条消息都带上这把钥匙，
   * 服务端就能认出「还是同一个人」，把对局原样还回来。
   */
  var ME_KEY = WB.me.key();
  function SEND(o) {
    if (!NET) return;
    NET.send(Object.assign({ key: ME_KEY }, o));
  }

  function onHello() {
    // 重连时连「我还以为自己在哪一局」一起报上去：服务端认不回来就如实告诉页面，别让它装死
    SEND({
      t: 'gomoku.register',
      matchId: (G.mode === 'online' && G.matchId && !G.over) ? G.matchId : null
    });
  }

  function onCode(m) {
    G.myCode = m.code;
    WB.Friends.refreshGame();   // 拿到邀请码了 → 好友面板里的「邀请组队」可以出现了
    $('myCode').textContent = m.code;
    $('myCode2').textContent = m.code;
    var ip = String(m.ip || '');
    var masked = ip.split('.').map(function (p, i) { return i < 2 ? p : '···'; }).join('.');
    $('myIp').textContent = 'IP ' + masked + (m.online ? ' · 在线 ' + m.online + ' 人' : '');
    // 通过好友邀请跳转过来的：直接替玩家发起对局，不用手动输邀请码
    if (PENDING_FRIEND_INVITE) {
      var code = PENDING_FRIEND_INVITE;
      PENDING_FRIEND_INVITE = null;
      if (code === G.myCode) { WB.ui.toast('不能邀请自己', 'err'); return; }
      show('scr-online');
      $('waitTip').textContent = '';
      SEND({ t: 'gomoku.invite', code: code });
      WB.ui.toast('已接受好友邀请，正在向 ' + code + ' 发起对局…', 'ok');
    }
  }

  function applyState(m) {
    if (m.t === 'gomoku.start') {
      G.mode = 'online';
      G.matchId = m.matchId;
      G.moves = [];
      hideOverlay();
      // 对局一开始就开好聊天频道：这一局里两个人可以边下边聊
      if (G.matchId) WB.Chat.enterRoom({ game: 'gomoku', code: G.matchId, title: '五子棋 · 对局聊天' });
    }
    G.board = m.board.slice();
    G.myColor = m.you;
    G.turn = m.turn;
    G.undoLeft = { 1: m.undoLeft[1], 2: m.undoLeft[2] };
    G.canUndo = { 1: !!(m.canUndo && m.canUndo[1]), 2: !!(m.canUndo && m.canUndo[2]) };
    G.dropped = { 1: !!(m.dropped && m.dropped[1]), 2: !!(m.dropped && m.dropped[2]) };
    G.players = m.players;
    G.last = m.last;
    G.win = m.win;
    G.over = m.state === 'over';
    G.thinking = false;
    // 轮到自己了 → 对方的预览失效；对局结束同理
    if (G.turn === G.myColor || G.over) { G.rx = -1; G.ry = -1; }
    // 用棋子还原手数（用于显示与悔棋判断）
    G.moves = [];
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) {
        if (G.board[idx(x, y)]) G.moves.push({ x: x, y: y, p: G.board[idx(x, y)] });
      }
    }
    $('codePanel').classList.remove('hidden');
    $('btnUndo').style.display = '';
    $('btnResign').style.display = '';
    $('btnNew').textContent = '再来一局';
    if (m.t !== 'gomoku.start' && m.last) {
      var key = m.last.x + ',' + m.last.y + ',' + m.last.p + ',' + m.moves;
      if (key !== G.lastKey) { G.lastKey = key; WB.audio.play('place'); }
    }
    show('scr-play');
    updatePanel();
    render();
    sendHover(true);            // 轮次变化后重新同步预览（该自己下了就把预览亮出来）
    if (G.over) endOnline();
  }

  function endOnline() {
    var iWin = G.win && G.win.p === G.myColor;
    var draw = G.win && G.win.p === 0;
    var title = draw ? '平局' : (iWin ? '你赢了！' : '你输了');
    if (G.win && G.win.resign) title = iWin ? '对方认输，你获胜' : '你已认输';
    var opp = G.players ? (G.myColor === 1 ? G.players[2] : G.players[1]) : null;
    showOverlay(
      '<h2>' + title + '</h2>' +
      '<p>' + (draw ? '棋盘已满' : '五子连珠') + '</p>' +
      '<div class="obtns">' +
        '<button class="btn primary" id="ovAgain">邀他再来一局</button>' +
        '<button class="btn ghost" id="ovBack">返回菜单</button>' +
      '</div>'
    );
    bindOverlay();
    WB.audio.play(iWin && !draw ? 'win' : 'lose');
  }

  function reInvite() {
    var opp = G.players ? (G.myColor === 1 ? G.players[2] : G.players[1]) : null;
    if (!opp || !opp.code) { toMenu(); return; }
    SEND({ t: 'gomoku.invite', code: opp.code });
    if (G.matchId) WB.Chat.leaveRoom();        // 上一局的聊天频道先关掉
    G.mode = 'online';
    G.matchId = null;
    G.over = false;
    hideOverlay();
    show('scr-online');
    $('waitTip').textContent = '已向 ' + opp.name + ' 发出邀请，等待对方接受…';
    WB.audio.play('invite');
  }

  /* ================= 询问弹窗 ================= */
  function ask(title, desc, yesText, noText, onYes, onNo) {
    var mask = document.createElement('div');
    mask.className = 'ask-mask';
    mask.innerHTML = '<div class="ask-box"><h3>' + esc(title) + '</h3><p>' + desc + '</p>' +
      '<div class="obtns"><button class="btn primary" id="askYes">' + esc(yesText) + '</button>' +
      '<button class="btn ghost" id="askNo">' + esc(noText) + '</button></div></div>';
    document.body.appendChild(mask);
    function close() { mask.remove(); }
    mask.querySelector('#askYes').onclick = function () { close(); WB.audio.play('click'); onYes && onYes(); };
    mask.querySelector('#askNo').onclick = function () { close(); WB.audio.play('error'); onNo && onNo(); };
  }

  /* ================= 面板 ================= */
  function updatePanel() {
    var box = $('players');
    var p1 = G.players && G.players[1] ? G.players[1].name : '黑方';
    var p2 = G.players && G.players[2] ? G.players[2].name : '白方';
    if (G.mode === 'ai') { p2 = G.players[2].name; }
    box.innerHTML =
      plHtml(1, p1, G.turn === 1 && !G.over) +
      plHtml(2, p2, G.turn === 2 && !G.over);

    var line = $('turnLine');
    line.className = 'turn-line';
    if (G.over) {
      line.textContent = '本局结束';
    } else if (G.mode === 'ai') {
      line.textContent = isMyTurn() ? '轮到你落子' : (G.thinking ? '电脑思考中…' : '电脑回合');
    } else if (G.mode === 'online') {
      var mine = G.turn === G.myColor;
      var oppColor = G.myColor === 1 ? 2 : 1;
      if (G.dropped[oppColor]) line.textContent = '对方掉线了，正在等他回来…';
      else if (mine) line.textContent = '轮到你落子';
      else if (G.rx >= 0 && G.ry >= 0) line.textContent = '对方正在选择落子位置…';
      else line.textContent = '等待对方落子…';
      // 对方还没应手 → 现在正是悔棋的时机
      if (!mine && G.canUndo[G.myColor]) line.classList.add('undo-ok');
    }

    var hint = '';
    if (G.mode === 'online') {
      hint = G.canUndo[G.myColor]
        ? '现在可以悔棋（对方还没应手）'
        : (G.undoLeft[G.myColor] > 0 ? '悔棋只在对方应手前可用' : '悔棋机会已用完');
    } else if (G.mode === 'ai') {
      hint = G.undoLeft[1] > 0 ? '悔棋会撤回你刚下的一手' : '悔棋机会已用完';
    }
    $('metaLine').innerHTML = '手数 <b>' + G.moves.length + '</b> · 悔棋剩余 黑 ' + G.undoLeft[1] + ' / 白 ' + G.undoLeft[2] +
      (G.mode === 'online' ? '<br>你执' + (G.myColor === 1 ? '黑' : '白') + '棋' : '') +
      (hint ? '<br><span class="hint-line">' + hint + '</span>' : '');

    var u = $('btnUndo');
    var canU = G.mode === 'ai' ? canUndoAi() : !!G.canUndo[G.myColor];
    u.disabled = G.over || G.undoLeft[G.myColor] <= 0 || !canU;
    u.textContent = '悔棋（剩 ' + G.undoLeft[G.myColor] + ' 次）';
    u.title = u.disabled ? '对方已应手，这一手不能悔；等自己下一手再悔' : '撤回自己刚下的这一手（无需对方同意）';
  }

  function plHtml(color, name, active) {
    var me = G.mode === 'online' && color === G.myColor;
    var off = G.mode === 'online' && G.dropped && G.dropped[color];
    return '<div class="pl' + (active ? ' active' : '') + '">' +
      '<span class="stone ' + (color === 1 ? 'b' : 'w') + '"></span>' +
      '<span class="nm">' + esc(name) + '</span>' +
      (off ? '<span class="tag drop">掉线中</span>'
           : (me ? '<span class="tag">我</span>' : '<span class="uni">' + (color === 1 ? '先手' : '后手') + '</span>')) +
      '</div>';
  }

  /* ================= 落子交互 ================= */
  function boardPos(ev) {
    var rect = cv.getBoundingClientRect();
    var mx = (ev.clientX - rect.left) / G.scale;
    var my = (ev.clientY - rect.top) / G.scale;
    var x = Math.round((mx - PAD) / CELL);
    var y = Math.round((my - PAD) / CELL);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return null;
    var dx = mx - px(x), dy = my - px(y);
    if (Math.sqrt(dx * dx + dy * dy) > CELL * 0.62) return null;
    return { x: x, y: y };
  }

  function humanPlay(x, y) {
    if (G.over) { WB.ui.toast('本局已结束'); return; }
    if (G.board[idx(x, y)] !== 0) { WB.audio.play('error'); return; }
    if (G.mode === 'ai') {
      if (G.turn !== 1 || G.thinking) { WB.ui.toast('请等待电脑落子'); return; }
      playLocal(x, y, 1);
      updatePanel();
      render();
      if (G.over) { checkEnd(); return; }
      G.turn = 2;
      updatePanel();
      aiMove();
    } else if (G.mode === 'online') {
      if (G.turn !== G.myColor) { WB.ui.toast('还没轮到你'); WB.audio.play('error'); return; }
      SEND({ t: 'gomoku.move', x: x, y: y });
      WB.audio.play('place');
      G.hx = -1; G.hy = -1;
      sendHover(true);          // 落子后清掉对方看到的预览
    }
  }

  /**
   * 把「我正在考虑落子的位置」同步给对方。
   * 只有轮到自己时才会发送（服务端也会二次校验），
   * 所以对面看到的预览一定是当前该落子那一方的棋子颜色。
   */
  function sendHover(force) {
    if (G.mode !== 'online' || !NET) return;
    var mine = !G.over && G.turn === G.myColor && G.hx >= 0 && G.hy >= 0;
    var key = mine ? (G.hx + ',' + G.hy) : 'none';
    if (!force && key === G.hoverKey) return;
    G.hoverKey = key;
    SEND({ t: 'gomoku.hover', x: mine ? G.hx : -1, y: mine ? G.hy : -1 });
  }

  function moveCursor(nx, ny) {
    var same = (nx === G.hx && ny === G.hy) || (nx < 0 && G.hx < 0);
    G.hx = nx; G.hy = ny;
    if (same) return;
    render();
    sendHover(false);
  }

  function bindBoard() {
    cv.addEventListener('mousemove', function (ev) {
      var p = boardPos(ev);
      moveCursor(p ? p.x : -1, p ? p.y : -1);
    });
    cv.addEventListener('mouseleave', function () { moveCursor(-1, -1); });
    cv.addEventListener('click', function (ev) {
      var p = boardPos(ev);
      if (p) humanPlay(p.x, p.y);
    });
    // 触屏：手指在棋盘上划动选择位置时，对方同样能看到预览
    cv.addEventListener('touchmove', function (ev) {
      if (!ev.touches || !ev.touches.length) return;
      ev.preventDefault();
      var t = ev.touches[0];
      var p = boardPos({ clientX: t.clientX, clientY: t.clientY });
      moveCursor(p ? p.x : -1, p ? p.y : -1);
    }, { passive: false });
    cv.addEventListener('touchstart', function (ev) {
      if (!ev.touches || !ev.touches.length) return;
      var t = ev.touches[0];
      var p = boardPos({ clientX: t.clientX, clientY: t.clientY });
      moveCursor(p ? p.x : -1, p ? p.y : -1);
    }, { passive: true });
  }

  /* ================= 网络初始化 ================= */
  function initNet() {
    NET = new WB.Net();
    WB.bindNetBadge($('netBadge'), NET);

    /* ---------- 好友系统（平台层，所有游戏通用） ---------- */
    WB.Friends.boot(NET);
    /* ---------- 聊天控件（左下角，平台层通用）：对局聊天走频道 ---------- */
    WB.Chat.boot(NET);
    // 向好友系统登记「组队邀请」能力：好友点接受后直接开局，不用报邀请码
    WB.Friends.registerGame({
      name: 'gomoku',
      label: '五子棋',
      entry: '/gomoku/',
      param: 'invite',
      // 拿到自己的邀请码后才能邀请（服务端据此找到你）
      canInvite: function () {
        if (!G.myCode) return null;
        return { data: { code: G.myCode }, text: '五子棋对局' };
      },
      // 受邀方就在本页面：直接拿对方的邀请码发起对局
      accept: function (data) {
        var code = String((data && data.code) || '').toUpperCase().trim();
        if (code.length < 4) { WB.ui.toast('邀请信息不完整', 'err'); WB.audio.play('error'); return; }
        if (code === G.myCode) { WB.ui.toast('不能邀请自己', 'err'); return; }
        show('scr-online');
        $('waitTip').textContent = '';
        SEND({ t: 'gomoku.invite', code: code });
        WB.ui.toast('已接受好友邀请，正在发起对局…', 'ok');
      }
    });

    NET.on('hello', onHello);
    NET.on('gomoku.code', onCode);
    NET.on('gomoku.error', function (m) {
      WB.ui.toast(m.msg || '操作失败', 'err');
      WB.audio.play('error');
      G.waitingInvite = null;
      $('waitTip').textContent = '';
      updatePanel();
    });
    NET.on('gomoku.waiting', function (m) {
      G.waitingInvite = m.matchId;
      $('waitTip').textContent = '已向 ' + m.to.name + ' 发出邀请，等待对方接受…';
      WB.audio.play('invite');
    });
    NET.on('gomoku.invited', function (m) {
      WB.audio.play('invite');
      ask('收到对局邀请', '<b>' + esc(m.from.name) + '</b>（邀请码 ' + esc(m.from.code) + '）邀请你下一局五子棋。',
        '接受', '拒绝',
        function () { SEND({ t: 'gomoku.reply', matchId: m.matchId, accept: true }); },
        function () { SEND({ t: 'gomoku.reply', matchId: m.matchId, accept: false }); });
    });
    NET.on('gomoku.start', function (m) { applyState(m); WB.ui.toast('对局开始，你执' + (m.you === 1 ? '黑' : '白') + '棋', 'ok'); });
    NET.on('gomoku.state', function (m) { applyState(m); });
    /*
     * 带着同一把钥匙回到服务端（刷新页面 / 断线重连 / 网络抖了一下）：
     * 对局被原样还了回来，不用重新邀请，接着下就行。
     */
    NET.on('gomoku.reattached', function (m) {
      WB.ui.toast('已重新连上，对局已恢复', 'ok');
    });
    /*
     * 服务端说这一局已经没了（宽限期过了、对手走了…）：
     * 老老实实回菜单，不要在死棋盘上继续装作能下棋。
     */
    NET.on('gomoku.gone', function (m) {
      WB.ui.toast((m && m.msg) || '这一局已经结束了', 'err');
      WB.audio.play('error');
      G.over = true;          // 先置位：toMenu 里就不会再补发一条 leave
      toMenu();
    });
    /* 对手掉线：他还有宽限期，先提示，别急着结束对局 */
    NET.on('gomoku.drop', function (m) {
      WB.ui.toast((m && m.name ? m.name : '对方') + '掉线了，正在等他回来…', 'err');
      WB.audio.play('error');
      updatePanel();
    });
    // 悔棋不需要对方同意：棋盘状态随后就到，这条只负责提示
    NET.on('gomoku.undone', function (m) {
      var who = m.by === G.myColor ? '你' : '对方';
      WB.ui.toast(who + '悔棋，撤回了一手棋');
      WB.audio.play('undo');
    });
    // 对方的落子预览
    NET.on('gomoku.hover', function (m) {
      if (m.p === G.myColor) return;
      if (m.x >= 0 && m.y >= 0) { G.rx = m.x; G.ry = m.y; }
      else { G.rx = -1; G.ry = -1; }
      render();
      updatePanel();
    });
    // 对方离开/掉线：对局直接结束并回到主页，不再停在棋盘上
    NET.on('gomoku.oppLeft', function (m) {
      WB.ui.toast((m && m.msg) || '对方已离开对局，对局结束', 'err');
      G.over = true;
      hideOverlay();
      toMenu();
    });
    // 设置里改了昵称：立刻同步给服务器（否则棋盘上还是旧名字）
    window.addEventListener('wb:settings', function () {
      NET.send({ t: 'hello', name: WB.playerName() });
    });
    NET.connect();
  }

  /* ================= 绑定 ================= */
  function bindUi() {
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.onclick = function () {
        WB.audio.play('click');
        if (b.dataset.mode === 'ai') newAiGame();
        else { show('scr-online'); $('waitTip').textContent = ''; }
      };
    });
    document.querySelectorAll('[data-level]').forEach(function (b) {
      b.onclick = function () {
        G.aiLevel = parseInt(b.dataset.level, 10);
        document.querySelectorAll('[data-level]').forEach(function (x) { x.classList.toggle('on', x === b); });
        WB.audio.play('click');
      };
    });
    document.querySelectorAll('[data-back]').forEach(function (b) {
      b.onclick = function () { WB.audio.play('click'); toMenu(); };
    });
    $('btnSettings').onclick = WB.ui.openSettings;
    $('btnCopyCode').onclick = function () {
      var c = G.myCode || '------';
      var done = function () { WB.ui.toast('邀请码 ' + c + ' 已复制', 'ok'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c).then(done, done);
      else { WB.ui.toast('邀请码：' + c, 'ok'); }
      WB.audio.play('click');
    };
    $('btnInvite').onclick = function () {
      var code = ($('inviteCode').value || '').toUpperCase().trim();
      if (code.length < 4) { WB.ui.toast('请输入对方邀请码', 'err'); WB.audio.play('error'); return; }
      if (code === G.myCode) { WB.ui.toast('不能邀请自己', 'err'); return; }
      SEND({ t: 'gomoku.invite', code: code });
      WB.audio.play('click');
    };
    // 邀请好友：打开好友面板，对好友点「邀请组队」即可直接开局（不用报邀请码）
    $('btnInviteFriend').onclick = function () {
      WB.audio.play('click');
      if (WB.friends) WB.friends.openPanel();
    };
    $('inviteCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btnInvite').click();
    });
    $('inviteCode').addEventListener('input', function () {
      this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    $('btnCancelWait').onclick = function () {
      $('waitTip').textContent = '';
      G.waitingInvite = null;
      WB.ui.toast('已取消邀请等待');
      WB.audio.play('click');
      toMenu();
    };
    $('btnUndo').onclick = doUndo;
    $('btnNew').onclick = function () {
      WB.audio.play('click');
      if (G.mode === 'ai') { newAiGame(); return; }
      if (G.over) { reInvite(); return; }
      WB.ui.toast('对局进行中，如需重开请先认输');
    };
    $('btnResign').onclick = function () {
      if (G.over) { WB.ui.toast('本局已结束'); return; }
      ask('确认认输', '认输后本局立即结束。', '确认认输', '再想想',
        function () {
          if (G.mode === 'online') SEND({ t: 'gomoku.resign' });
          else {
            G.over = true;
            G.win = { p: 2, line: [] };
            showOverlay('<h2>你认输了</h2><p>本局结束</p>' + btns());
            bindOverlay();
            WB.audio.play('lose');
          }
        });
    };
    $('chkNum').onchange = function () { G.showNum = this.checked; render(); };
    $('chkCoord').onchange = function () { G.showCoord = this.checked; render(); };
  }

  /* ================= 启动 ================= */
  cv = $('board');
  ctx = cv.getContext('2d');
  bindUi();
  bindBoard();
  initNet();

  /* 好友组队邀请直达：URL 带 ?invite=邀请码 时，等服务端下发我的邀请码后自动发起对局 */
  (function autoInviteFromFriend() {
    var raw = '';
    try { raw = new URLSearchParams(location.search).get('invite') || ''; } catch (e) { return; }
    if (!raw) return;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { data = { code: raw }; }
    var code = String((data && data.code) || '').toUpperCase().trim();
    if (code.length < 4) return;
    PENDING_FRIEND_INVITE = code;
  })();

  resizeBoard();
  window.__GOMOKU_DEBUG = {
    G: G, S: SIZE, CELL: CELL, PAD: PAD, px: px, render: render,
    applyState: applyState, isMyTurn: isMyTurn, sendHover: sendHover
  };
})();
