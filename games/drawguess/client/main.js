/*!
 * 你画我猜 · 客户端主逻辑
 *
 * 分工：服务端管权威（答案、计时、计分、冷却、换题、操作列表），这里只做四件事 ——
 *   1) 大厅：建房/加入/设置/身份/准备/抢画者；
 *   2) 绘画区：直接用独立的 PaintPad 组件，把本地操作发给服务端、把远端操作喂回去；
 *   3) 猜：输入框 + 冷却倒计时（冷却中点「猜」不清空输入框）+ 聊天区里的小「猜」按钮；
 *   4) 聊天/提示/单局结束弹窗（10 秒自动关）/ 终局结算（返回房间 / 退出房间）+ 保存作品。
 */
(function () {
  'use strict';

  var net = new WB.Net();
  window.net = net;                                  // 供 friends.js / 注册邀请用

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return WB.util.esc(s); };

  var state = {
    code: '', hostId: '', myId: 0,
    view: 'home',
    room: null,
    turn: null,
    isPainter: false,
    order: null, done: null,
    settling: false,        // 停在结算页时，不要被房间推送拽回大厅
    cdUntil: {},            // memberId -> 冷却结束时间戳
    turnTimer: null, settleTimer: null,
    tickLeft: 0
  };
  window.state = state;

  /* ---------------- 绘画区组件 ---------------- */
  var pad = WB.PaintPad.create($('padMount'), {
    background: '#fffdf7',
    onOp: function (op) { net.send(Object.assign({ t: 'ydwg.draw' }, op)); },
    onUndo: function () { net.send({ t: 'ydwg.canvas', op: 'undo' }); },
    onRedo: function () { net.send({ t: 'ydwg.canvas', op: 'redo' }); },
    onNotice: function (text, kind) { WB.ui.toast(text, kind === 'warn' ? 'err' : 'ok'); }
  });
  pad.setEnabled(false);
  window.pad = pad;

  window.addEventListener('resize', function () { pad.resize(); });

  /* ---------------- 视图切换 ---------------- */
  function show(v) {
    state.view = v;
    ['Home', 'Lobby', 'Grab', 'Play'].forEach(function (k) {
      $('view' + k).classList.toggle('hidden', k.toLowerCase() !== v.toLowerCase());
    });
    if (v === 'Play') setTimeout(function () { pad.resize(); }, 30);
  }

  /* ---------------- 冷却 ---------------- */
  function cdSecs(id) {
    return Math.max(0, Math.ceil(((state.cdUntil[id] || 0) - Date.now()) / 1000));
  }
  function setCd(id, secs) {
    var until = Date.now() + secs * 1000;
    if (!state.cdUntil[id] || until > state.cdUntil[id]) state.cdUntil[id] = until;
  }
  function syncCdFromRoom(m) {
    m.members.forEach(function (p) { if (p.cd > 0) setCd(p.id, p.cd); });
  }

  setInterval(function () {
    var mine = cdSecs(state.myId);
    var chip = $('cdChip');
    if (mine > 0) {
      chip.classList.remove('hidden');
      chip.textContent = '冷却 ' + mine + 's';
    } else {
      chip.classList.add('hidden');
    }
    // 只刷新冷却数字。原来这里每 500ms 就整块重建一次成员列表 + 积分榜，
    // 一秒两次全量 DOM 重建，纯属浪费，还会让大厅一直处于「重排」状态。
    if (state.room && state.view !== 'home') syncCdChips();
  }, 500);

  /* ---------------- 大厅渲染 ---------------- */
  function renderRoom(m) {
    // 换房间了：设置面板 / 聊天输入框是按房间缓存的，必须作废重建
    if (state.code && state.code !== m.code) { settingsRefs = null; chatBuilt = false; }
    state.room = m;
    state.code = m.code; state.hostId = m.hostId;
    syncCdFromRoom(m);
    $('roomCode').textContent = m.code;
    var actCount = activeCount(m);
    var leftCount = m.members.length - actCount;
    $('countText').textContent = '(' + actCount + '/' + m.maxPlayers + ')' + (leftCount > 0 ? ' · ' + leftCount + ' 人已退出' : '');
    $('shareLink').value = location.origin + '/drawguess/?join=' + m.code;

    var stateText = { lobby: '大厅', grabbing: '抢画者', playing: '进行中', turnEnd: '回合结束', over: '结算' }[m.state] || m.state;
    var pill = $('roomState');
    pill.textContent = stateText;
    pill.className = 'pill' + (m.state === 'playing' ? ' act' : (m.state === 'over' ? ' ok' : ''));

    // 先渲染大厅操作区（房主的「开始游戏」按钮最关键，必须最先落地，
    // 避免后面 renderMembers/renderSettings 万一抛错把它一起吞掉）
    renderActions(m);
    // 兜底：房主在大厅却一个按钮都没有，就再渲染一次。
    // 正常走不到这里，防的是「别人进房后按钮莫名消失」这类玄学问题。
    if (m.state === 'lobby' && m.hostId === state.myId) {
      var la = $('lobbyActions');
      if (la && !la.querySelector('button')) renderActions(m);
    }
    renderMembers(m);
    renderSettings(m);
    renderInfo(m);
    renderChatInput();

    // 视图跟随房间状态；停在结算页时不打扰
    if (m.state === 'grabbing' && state.view !== 'Play') { renderGrab(m); }
    else if (m.state === 'lobby' && !state.settling) { show('Lobby'); }
  }

  /** 还在房间里的人数（已退出的只是留档，不算名额、不算门槛） */
  function activeCount(m) {
    return m && m.activeCount != null ? m.activeCount : (m ? m.members.filter(function (p) { return !p.left; }).length : 0);
  }

  /* ---------------- 排行榜 ---------------- */
  var MEDALS = ['🥇', '🥈', '🥉'];

  /** 按分数排出名次（同分并列，比如 1、1、3） */
  function ranked(list) {
    var sorted = list.slice().sort(function (a, b) {
      return (b.score - a.score) || ((b.right || 0) - (a.right || 0)) || ((a.id || 0) - (b.id || 0));
    });
    var out = [], rank = 0, prev = null;
    sorted.forEach(function (p, i) {
      if (prev === null || p.score !== prev) { rank = i + 1; prev = p.score; }
      out.push({ rank: rank, p: p });
    });
    return out;
  }

  /** 排行榜的一行：名次（前三名给奖牌）+ 圆点 + 名字 + 标签 + 分数 */
  function lbRow(rank, o) {
    var row = WB.util.el('div', 'lbrow' + (o.me ? ' me' : '') + (rank <= 3 ? ' medal' + rank : ''));
    var badge = rank <= 3
      ? '<span class="lbrk big">' + MEDALS[rank - 1] + '</span>'
      : '<span class="lbrk">' + rank + '</span>';
    row.innerHTML = badge +
      '<span class="dot" style="background:' + (o.color || '#ccc') + '"></span>' +
      '<span class="nm">' + esc(o.name) + (o.me ? '（我）' : '') + '</span>' +
      (o.tags || '') +
      '<span class="score">' + (o.score || 0) + '</span>';
    return row;
  }

  function renderMembers(m) {
    var ml = $('memberList');
    if (!ml) return;
    ml.innerHTML = '';
    m.members.forEach(function (p) {
      var row = WB.util.el('div', 'mem' + (p.id === state.myId ? ' me' : '') + (p.left ? ' gone' : ''));
      // 已经退出的人：留在名单里（成绩也算数），只标一下状态
      if (p.left) {
        row.innerHTML =
          '<span class="dot" style="background:' + p.color + '"></span>' +
          '<span class="nm">' + esc(p.name) + '</span>' +
          '<span class="tag gone">已退出</span>' +
          '<span class="score">' + p.score + '</span>';
        ml.appendChild(row);
        return;
      }
      var tags = [];
      if (p.host) tags.push(['房主', 'host']);
      if (m.state === 'lobby' || m.state === 'grabbing') {
        if (m.settings.rotate) {
          // 抢画者标签只在「抢画者」阶段显示；大厅阶段不显示，避免误导成「没选身份」
          if (m.state === 'grabbing') {
            if (p.grabChoice === true) tags.push(['抢画者', 'ok']);
            else if (p.grabChoice === false) tags.push(['排后面', '']);
            else tags.push(['还没选', 'warn']);
          }
        } else {
          // 不轮换模式才需要「愿不愿意当画者」这个身份；勾选了画者轮换就不该出现
          if (!p.roleChosen) tags.push(['没选身份', 'warn']);
          else if (p.willDraw) tags.push(['画者', 'ok']);
          else tags.push(['只猜不画', '']);
        }
        if (p.ready) tags.push(['已准备', 'ok']);
        else if (!p.host) tags.push(['未准备', 'warn']);
      }
      if (p.lottery) tags.push(['抽签画者', 'host']);
      row.innerHTML =
        '<span class="dot" style="background:' + p.color + '"></span>' +
        '<span class="nm">' + esc(p.name) + (p.id === state.myId ? '（我）' : '') + '</span>' +
        tags.map(function (t) { return '<span class="tag ' + t[1] + '">' + esc(t[0]) + '</span>'; }).join('') +
        '<span class="tag cd' + (cdSecs(p.id) > 0 ? '' : ' hidden') + '" data-cdfor="' + p.id + '">冷却 ' + cdSecs(p.id) + 's</span>' +
        (m.state === 'playing' || m.state === 'turnEnd' || m.state === 'over'
          ? '<span class="score">' + p.score + '</span>' : '');
      ml.appendChild(row);
    });

    // 对局内右侧「积分排行榜」
    var sl = $('scoreList');
    if (sl) {
      sl.innerHTML = '';
      ranked(m.members).forEach(function (r) {
        var p = r.p;
        // 不轮换时身份是固定的，排行榜上直接标出来
        var roleTag = (!m.settings.rotate && !p.left && p.roleChosen)
          ? '<span class="tag ' + (p.willDraw ? 'host' : '') + '">' + (p.willDraw ? '画者' : '猜者') + '</span>'
          : '';
        var tags = (p.left ? '<span class="tag gone">已退出</span>' : '') +
          (!p.left && p.dropped ? '<span class="tag warn">掉线中</span>' : '') +
          roleTag +
          (p.id === m.painterId && !p.left ? '<span class="tag host">正在画</span>' : '') +
          '<span class="tag cd' + (cdSecs(p.id) > 0 && !p.left ? '' : ' hidden') + '" data-cdfor="' + p.id + '">冷却 ' + cdSecs(p.id) + 's</span>';
        sl.appendChild(lbRow(r.rank, {
          name: p.name, color: p.color, score: p.score, me: p.id === state.myId, tags: tags
        }));
      });
    }
  }

  /* ---------------- 本局信息（任务 / 进度 / 谁在画 / 猜对记录） ---------------- */
  var infoLogSig = '';
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var mm = Math.floor(sec / 60), ss = sec % 60;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function renderInfo(m) {
    var d = m.done || {};
    var rounds = m.settings.rounds || 0;
    // 任务：本局在哪些类别里出题 + 每局多久 + 打几局
    $('infoTask').textContent = (m.settings.categories || []).join(' / ') +
      ' · 每局 ' + m.settings.minutes + ' 分钟 · 共 ' + rounds + ' 局' +
      (m.settings.rotate ? '（轮换）' : '（不轮换）');

    // 进度：轮换模式看"第几圈第几人"，不轮换看"第几回合"
    if (m.settings.rotate && d.total) {
      $('infoProgress').textContent = '第 ' + Math.min(d.cycle + 1, rounds) + '/' + rounds + ' 圈 · 本圈第 ' +
        Math.min(d.pos + 1, d.total) + '/' + d.total + ' 人';
    } else {
      $('infoProgress').textContent = '第 ' + Math.min((d.turn || 0) + 1, rounds || 1) + '/' + (rounds || 1) + ' 回合';
    }

    // 谁在画
    if (m.painterId) {
      var who = m.members.filter(function (p) { return p.id === m.painterId; })[0];
      var left = state.tickLeft || Math.max(0, (m.turnTotal || 0) - (m.turnElapsed || 0));
      $('infoPainter').innerHTML = who
        ? '<span class="idot" style="background:' + who.color + '"></span>' +
          esc(who.name) + (who.id === state.myId ? '（我）' : '') +
          '<span class="dim" id="infoLeft"> · 剩 ' + fmtClock(left) + '</span>'
        : '—';
    } else {
      $('infoPainter').textContent = m.state === 'grabbing' ? '还没开始抢' : '本回合还没开始';
    }

    // 提示：给了哪几档（谁都能看到，和聊天区一致）
    var LABEL = { type: '类型', len: '几个字', origin: '来自哪里' };
    var hs = (m.hints || []).map(function (k) { return LABEL[k] || k; });
    $('infoHints').textContent = hs.length ? ('已给：' + hs.join('、')) : '还没给提示';

    // 猜对记录
    var log = m.log || [];
    var sig = log.map(function (r) { return r.n + '/' + r.solver + '/' + r.word + '/' + r.secs; }).join('|');
    if (sig === infoLogSig) return;
    infoLogSig = sig;
    var box = $('infoLog');
    box.innerHTML = '';
    if (!log.length) {
      box.appendChild(WB.util.el('div', 'tip', '还没有记录，打完第一回合就会出现在这里。'));
      return;
    }
    log.forEach(function (r) {
      var row = WB.util.el('div', 'lrow ' + (r.solver ? 'ok' : 'miss'));
      var title = '第 ' + r.n + (r.cycle ? ' 回（第 ' + r.cycle + ' 圈）' : ' 回合');
      row.innerHTML =
        '<span class="ln">' + title + '</span>' +
        '<span class="lw">' + esc(r.word) + '</span>' +
        (r.solver
          ? '<span class="ls">' + esc(r.solver) + ' 猜中</span>'
          : '<span class="ls">' + (r.reason === 'timeout' ? '没人猜出来' : '本回合作废') + '</span>') +
        '<span class="ls dim">画者 ' + esc(r.painter) + '</span>' +
        '<span class="lt">' + (r.solver ? fmtClock(r.secs) : '—') + '</span>';
      box.appendChild(row);
    });
  }

  /** 只刷新"谁在画"那行的时间（每秒 tick 用，别整块重建） */
  function updateInfoClock() {
    var el = $('infoLeft');
    if (el) el.textContent = ' · 剩 ' + fmtClock(state.tickLeft || 0);
  }

  /** 只刷新冷却倒计时标签，不重建列表（500ms 心跳专用） */
  function syncCdChips() {
    var chips = document.querySelectorAll('[data-cdfor]');
    for (var i = 0; i < chips.length; i++) {
      var n = cdSecs(+chips[i].getAttribute('data-cdfor'));
      chips[i].textContent = '冷却 ' + n + 's';
      chips[i].classList.toggle('hidden', n <= 0);
    }
  }

  function renderActions(m) {
    var box = $('lobbyActions');
    box.innerHTML = '';
    var me = m.members.filter(function (p) { return p.id === state.myId; })[0];
    var iAmHost = m.hostId === state.myId;
    renderRoleBox(m, me);

    if (m.state === 'lobby') {
      if (iAmHost) {
        var canStart = activeCount(m) >= 2 && m.ready.allReady;
        // 不能加 ghost：.btn.ghost 会把底色刷成白色，而 .btn.primary 的文字还是白色，
        // 白字白底 + disabled 半透明 = 文字完全看不见，看起来就像按钮「不见了」
        var go = el('button', 'btn primary', '开始游戏');
        go.disabled = !canStart;
        go.onclick = function () { net.send({ t: 'ydwg.start' }); };
        box.appendChild(go);
        var tipText;
        if (activeCount(m) < 2) tipText = '至少 2 个人才能开始';
        else if (m.ready.noRole && m.ready.noRole.length) tipText = '还没选身份：' + m.ready.noRole.join('、');
        else if (m.ready.waiting.length) tipText = '还没准备好：' + m.ready.waiting.join('、');
        else tipText = '大家都准备好了，点「开始游戏」';
        box.appendChild(WB.util.el('span', 'tip', tipText));
      } else if (me) {
        var needRole = !m.settings.rotate && !me.roleChosen;
        var rdy = el('button', 'btn ' + (me.ready ? 'ghost' : (needRole ? 'ghost' : 'ok')),
          me.ready ? '取消准备' : (needRole ? '先选身份再准备' : '我准备好了'));
        rdy.disabled = needRole;
        rdy.onclick = function () { net.send({ t: 'ydwg.ready', ready: !me.ready }); };
        box.appendChild(rdy);
        if (m.ready.waiting.length) {
          box.appendChild(WB.util.el('span', 'tip', '还差：' + m.ready.waiting.join('、')));
        }
      }
    }
  }

  /** 不轮换模式才需要「愿不愿意当画者」这个开关 */
  function renderRoleBox(m, me) {
    var box = $('roleBox');
    box.innerHTML = '';
    if (!me || m.state !== 'lobby' || m.settings.rotate || activeCount(m) === 0) return;

    var wrap = WB.util.el('div', 'roleBox');
    wrap.appendChild(WB.util.el('h4', null, '你要当画者吗？'));
    wrap.appendChild(WB.util.el('div', 'tip', me.roleChosen
      ? '已经选好了。换身份会把「准备」取消，要重新准备一次。'
      : '必须先选一个身份，才能点「我准备好了」。'));

    var pick = WB.util.el('div', 'rolePick');
    var yes = el('button', 'btn' + (me.roleChosen && me.willDraw ? ' on primary' : ''), '我愿意当画者');
    yes.onclick = function () { net.send({ t: 'ydwg.role', willDraw: true }); };
    var no = el('button', 'btn' + (me.roleChosen && !me.willDraw ? ' on primary' : ''), '我只想猜');
    no.onclick = function () { net.send({ t: 'ydwg.role', willDraw: false }); };
    pick.appendChild(yes); pick.appendChild(no);
    wrap.appendChild(pick);

    if (me.roleChosen && m.members.filter(function (p) { return !p.left && p.roleChosen && p.willDraw; }).length === 0) {
      wrap.appendChild(WB.util.el('div', 'tip', '现在没人愿意当画者，开局时会随机抽一个人来画。'));
    }
    box.appendChild(wrap);
  }

  /* ---------------- 房间设置（只有房主能改） ---------------- */
  /*
   * 设置面板只完整构建一次，之后每次房间推送都「就地更新」控件的值，
   * 不再整块 innerHTML 重建。原来每改一个设置就要重建 10 个类别 + 两个滑杆 +
   * 重绑所有事件，既卡又会把用户正在拖的滑杆/焦点打飞 —— 这就是切换
   * 「画者轮换」时感觉发涩的真正原因。
   */
  var settingsRefs = null;

  function renderSettings(m) {
    var body = $('settingsBody');
    var canEdit = m.hostId === state.myId && m.state === 'lobby';
    var s = m.settings, L = m.limits;

    if (!settingsRefs) {
      var html = '';
      html += '<div class="setRow"><label>类别</label><span class="tip" style="margin:0">（默认全选，每类 ' + m.categories[0].count + '+ 个词）</span></div>';
      html += '<div class="cats" id="catBox">';
      m.categories.forEach(function (c) {
        html += '<label class="cat" data-cat-wrap="' + esc(c.name) + '"><input type="checkbox" data-cat="' + esc(c.name) + '">' +
          '<span class="mark"></span>' + esc(c.name) + '<span class="n">' + c.count + '</span></label>';
      });
      html += '</div>';
      html += '<div class="row" style="margin:6px 0 14px"><button class="btn tiny ghost" id="catAll">全选</button><button class="btn tiny ghost" id="catNone">全不选（会保留一个）</button></div>';

      html += '<div class="setRow"><label>每局时长</label>' +
        '<input type="range" id="setMin" min="' + L.minMinutes + '" max="' + L.maxMinutes + '" step="1">' +
        '<span class="val" id="minVal"></span></div>';

      html += '<div class="setRow"><label>画者轮换</label>' +
        '<label class="wb-check"><input type="checkbox" id="setRotate"> 每人轮着画一轮</label></div>';
      // 只有「不轮换」时才显示这段说明；勾选了画者轮换就不该再出现
      html += '<div class="tip" id="rotateTip" style="margin:-4px 0 12px">不轮换：每人先选「愿不愿意当画者」，都选完才能准备；没人愿意画就抽签。</div>';

      html += '<div class="setRow"><label>对局局数</label>' +
        '<input type="range" id="setRounds" min="1" max="' + L.maxRounds + '" step="1">' +
        '<span class="val" id="roundsVal"></span></div>';
      html += '<div class="tip" id="setFoot" style="margin-top:14px"></div>';

      body.innerHTML = html;

      settingsRefs = {
        wraps: Array.prototype.slice.call(body.querySelectorAll('[data-cat-wrap]')),
        inputs: Array.prototype.slice.call(body.querySelectorAll('#catBox input')),
        setMin: $('setMin'), minVal: $('minVal'),
        setRotate: $('setRotate'), rotateTip: $('rotateTip'),
        setRounds: $('setRounds'), roundsVal: $('roundsVal'),
        setFoot: $('setFoot'), catAll: $('catAll'), catNone: $('catNone')
      };

      // 事件只绑一次
      var cats = function () {
        return settingsRefs.inputs.filter(function (i) { return i.checked; }).map(function (i) { return i.dataset.cat; });
      };
      var push = function (extra) {
        net.send(Object.assign({ t: 'ydwg.settings', categories: cats() }, extra || {}));
      };
      settingsRefs.inputs.forEach(function (i) { i.onchange = function () { push({}); }; });
      settingsRefs.catAll.onclick = function () {
        settingsRefs.inputs.forEach(function (i) { i.checked = true; });
        push({});
      };
      settingsRefs.catNone.onclick = function () {
        settingsRefs.inputs.forEach(function (i, idx) { i.checked = (idx === 0); });
        push({});
      };
      var min = settingsRefs.setMin;
      min.oninput = function () { settingsRefs.minVal.textContent = min.value + ' 分钟'; };
      min.onchange = function () { push({ minutes: +min.value }); };
      settingsRefs.setRotate.onchange = function () { push({ rotate: settingsRefs.setRotate.checked }); };
      var rnds = settingsRefs.setRounds;
      rnds.oninput = function () { settingsRefs.roundsVal.textContent = rnds.value + ' 局'; };
      rnds.onchange = function () { push({ rounds: +rnds.value }); };
    }

    // ---- 就地同步，不重建 DOM ----
    settingsRefs.inputs.forEach(function (i, idx) {
      var on = s.categories.indexOf(i.dataset.cat) >= 0;
      i.checked = on;
      i.disabled = !canEdit;
      var wrap = settingsRefs.wraps[idx];
      wrap.classList.toggle('on', on);
      wrap.classList.toggle('locked', !canEdit);
      wrap.querySelector('.mark').textContent = on ? '✓' : '';
    });
    settingsRefs.setMin.disabled = !canEdit;
    settingsRefs.setMin.value = s.minutes;
    settingsRefs.minVal.textContent = s.minutes + ' 分钟';
    settingsRefs.setRotate.disabled = !canEdit;
    settingsRefs.setRotate.checked = !!s.rotate;
    settingsRefs.rotateTip.style.display = s.rotate ? 'none' : '';
    settingsRefs.setRounds.disabled = !canEdit;
    settingsRefs.setRounds.value = s.rounds;
    settingsRefs.roundsVal.textContent = s.rounds + ' 局';
    settingsRefs.setFoot.textContent = (canEdit ? '你是房主，可直接修改。' : '只有房主能改设置。') +
      ' 上限 ' + L.maxPlayers + ' 人 · 局数上限 ' + L.maxRounds + '。';
  }

  /* ---------------- 抢画者 ---------------- */
  function renderGrab(m) {
    show('Grab');
    var yes = m.members.filter(function (p) { return !p.left && p.grabChoice === true; });
    var no = m.members.filter(function (p) { return !p.left && p.grabChoice === false; });
    var wait = m.members.filter(function (p) { return !p.left && p.grabChoice === null; });

    function fill(box, list, emptyText) {
      box.innerHTML = '';
      if (!list.length) { box.appendChild(WB.util.el('div', 'empty', emptyText)); return; }
      list.forEach(function (p) {
        var row = WB.util.el('div', 'mem' + (p.id === state.myId ? ' me' : ''));
        row.innerHTML = '<span class="dot" style="background:' + p.color + '"></span><span class="nm">' +
          esc(p.name) + (p.id === state.myId ? '（我）' : '') + '</span>';
        box.appendChild(row);
      });
    }
    fill($('grabYes'), yes, '还没人抢');
    fill($('grabNo'), no, '还没有人排队');
    $('grabYesN').textContent = yes.length;
    $('grabNoN').textContent = no.length;

    $('grabWait').textContent = wait.length
      ? '还有 ' + wait.length + ' 人没选（' + wait.map(function (p) { return p.name; }).join('、') + '），选完立刻开始。'
      : '所有人都选好了。';

    var me = m.members.filter(function (p) { return p.id === state.myId; })[0];
    $('btnGrab').classList.toggle('on', !!(me && me.grabChoice === true));
    $('btnGrabNo').classList.toggle('on', !!(me && me.grabChoice === false));
    $('btnGrab').textContent = me && me.grabChoice === true ? '已抢（点一下取消）' : '我要先画';
    $('btnGrabNo').textContent = me && me.grabChoice === false ? '已排后面（点一下取消）' : '我排后面';

    var acts = $('grabActions');
    acts.innerHTML = '';
    if (m.hostId === state.myId) {
      var go = el('button', 'btn ok', '就这个顺序，开始');
      go.onclick = function () { net.send({ t: 'ydwg.startNow' }); };
      acts.appendChild(go);
    } else {
      acts.appendChild(WB.util.el('span', 'tip', '房主可以随时提前开始。'));
    }
  }

  /* ---------------- 对局渲染 ---------------- */
  function startTurn(m) {
    state.turn = m;
    state.isPainter = m.painterId === state.myId;
    state.order = m.order || null;
    state.done = m.done;
    state.canHint = false;
    state.hintLeft = m.hintUnlock || 0;      // 距离"可以发提示"还差多少秒
    state.hintUsed = {};
    pad.resetAll();
    pad.setEnabled(state.isPainter);
    if (state.room) renderMembers(state.room);   // 让积分板立刻有内容，别等到下一次房间推送

    $('secretBox').classList.toggle('hidden', !state.isPainter);
    $('secretOrigin').textContent = '';
    $('guessBox').classList.toggle('hidden', state.isPainter);
    $('noText').hidden = !state.isPainter;
    $('turnWho').textContent = '本回合作画：' + m.painterName + (state.isPainter ? '（你）' : '');
    $('roundPill').textContent = m.order
      ? '第 ' + (m.done.cycle + 1) + '/' + m.rounds + ' 圈 · 本圈第 ' + (m.done.pos + 1) + '/' + m.done.total + ' 人'
      : '第 ' + (m.done.turn + 1) + '/' + m.done.total + ' 回合';
    closeTurnDialog();
    hide$('maskOver');
    state.settling = false;
    show('Play');
    renderHints();
    renderChatInput();
    showRoleBanner(m);
    log('sys', '—— ' + m.painterName + ' 开始作画（' + Math.round(m.total / 60) + ' 分钟）——');
  }

  function renderHints() {
    var row = $('hintRow');
    row.innerHTML = '';
    if (!state.isPainter || !state.turn) {
      row.appendChild(WB.util.el('span', 'tip', state.hintLog || '画家给出提示后会显示在这里。'));
      return;
    }
    var can = !!state.canHint;
    var HINTS = [['type', '类型', -3], ['len', '几个字', -5], ['origin', '来自哪里', -8]];
    HINTS.forEach(function (h) {
      var used = state.hintUsed && state.hintUsed[h[0]];
      var on = can && !used;
      var b = el('button', 'btn tiny hintBtn' + (on ? ' primary' : ''),
        (can || used) ? (h[1] + ' ' + h[2] + '分') : '？');
      b.disabled = !on;
      b.title = used ? '这一档已经给过了' : (can ? '' : '开局 30% 之后才能给提示');
      b.onclick = function () { net.send({ t: 'ydwg.hint', kind: h[0] }); };
      row.appendChild(b);
    });

    var sw = el('button', 'btn tiny ok', '换一个（剩 ' + (state.turn ? state.turn.swaps : 0) + '）');
    sw.onclick = function () { net.send({ t: 'ydwg.swap' }); };
    row.appendChild(sw);

    if (!can) {
      // 还没到 30%：三个提示按钮是灰的，并且明确告诉画家还差多少秒
      var badge = WB.util.el('span', 'hintWait');
      badge.id = 'hintWait';
      badge.textContent = hintWaitText(state.hintLeft);
      row.appendChild(badge);
      row.appendChild(WB.util.el('span', 'tip', '提示只有被猜中时才扣分，给越多扣越多；画板里不许写字。'));
      return;
    }
    row.appendChild(WB.util.el('span', 'tip', '提示只有被猜中时才扣分，给越多扣越多；画板里不许写字。'));
  }

  /* ---------------- 本回合角色提示（画者 / 猜的人） ---------------- */
  var roleTimer = null;
  function hideRoleBanner() {
    hide$('roleBanner');
    if (roleTimer) { clearTimeout(roleTimer); roleTimer = null; }
  }
  function showRoleBanner(m) {
    var el = $('roleBanner');
    if (!el) return;
    el.classList.toggle('draw', state.isPainter);
    el.classList.toggle('guess', !state.isPainter);
    el.classList.remove('hidden');
    $('rbBadge').textContent = state.isPainter ? '你是画者' : '你是猜的人';
    $('rbText').innerHTML = state.isPainter
      ? '本回合由你来画，题目在左上角；<b>画板里不许写字</b>'
      : '本轮由「<b>' + esc(m.painterName || '') + '</b>」来画，共 <b>' + (m.wordLen || 0) + '</b> 个字，快猜！';
    if (roleTimer) clearTimeout(roleTimer);
    roleTimer = setTimeout(hideRoleBanner, 3600);
  }
  /* ---------------- 开局身份牌：谁画谁猜（3 秒后自动进对局） ---------------- */
  var rolesTimer = null;
  function hideRolesPanel() {
    hide$('rolesPanel');
    if (rolesTimer) { clearTimeout(rolesTimer); rolesTimer = null; }
  }
  function showRolesPanel(m) {
    var panel = $('rolesPanel');
    if (!panel) return;
    var list = m.list || [];
    var box = $('rpList');
    box.innerHTML = '';
    list.forEach(function (p) {
      var row = WB.util.el('div', 'rprow ' + (p.role === 'draw' ? 'draw' : ''));
      row.innerHTML =
        '<span class="dot" style="background:' + (p.color || '#ccc') + '"></span>' +
        '<span class="nm">' + esc(p.name) + (p.id === state.myId ? '（我）' : '') + '</span>' +
        '<span class="rk">' + (p.role === 'draw' ? '画者' : '猜者') + '</span>';
      box.appendChild(row);
    });
    var tip = m.mode === 'rotate' && (m.order || []).length
      ? '画者顺序：' + m.order.join(' → ') + '（每回合轮换）'
      : '画者固定，其他人负责猜';
    $('rpTip').textContent = tip;
    panel.classList.remove('hidden');
    if (rolesTimer) clearTimeout(rolesTimer);
    rolesTimer = setTimeout(hideRolesPanel, Math.max(1000, m.delay || 3000));
  }

  /** 画者拿到答案后把弹窗里的提示补全 */
  function updateRoleBannerWord(word, origin) {
    if (!state.isPainter) return;
    var el = $('roleBanner');
    if (!el || el.classList.contains('hidden')) return;
    $('rbText').innerHTML = '本回合由你来画：<b>' + esc(word) + '</b>' +
      (origin ? '<span class="dim">（' + esc(origin) + '）</span>' : '') +
      ' · 画板里不许写字';
    if (roleTimer) clearTimeout(roleTimer);
    roleTimer = setTimeout(hideRoleBanner, 3600);
  }

  function hintWaitText(left) {
    var n = Math.max(0, Math.ceil(left || 0));
    return n > 0 ? (n + ' 秒后你可以选择发送提示') : '现在可以发提示了';
  }

  var chatBuilt = false, chatMode = null;
  function renderChatInput() {
    var row = $('chatRow');
    var mode = (state.isPainter && state.turn) ? 'painter' : 'talk';
    // 形态没变就不重建。原来每次房间推送都清空重造一遍，
    // 用户正在输入框里打的字会被直接清掉，白打。
    if (chatBuilt && chatMode === mode) return;
    chatBuilt = true; chatMode = mode;
    row.innerHTML = '';
    if (mode === 'painter') {
      row.appendChild(WB.util.el('div', 'tip', '作画时你不能发言（但能看见他们说什么）。'));
      return;
    }
    var input = WB.util.el('input', 'field');
    input.id = 'chatInput';
    input.maxLength = 80;
    input.placeholder = '说点什么…（回车发送）';
    var send = function () {
      var v = input.value.trim();
      if (v) { net.send({ t: 'ydwg.chat', text: v }); input.value = ''; }
    };
    var guess = function () {
      // 聊天区的「猜」：把输入框里的内容当作答案交上去
      var v = input.value;
      if (doGuess(v)) input.value = '';
    };
    // 回车 = 发送聊天（不是猜答案）
    input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } };
    row.appendChild(input);

    var bSend = el('button', 'btn', '发送');
    bSend.title = '回车也可以发送';
    bSend.onclick = send;
    row.appendChild(bSend);

    var bGuess = el('button', 'btn primary', '猜');
    bGuess.id = 'btnChatGuess';
    bGuess.title = '把输入框里的内容当作答案提交（想猜答案就用这个按钮）';
    bGuess.onclick = guess;
    row.appendChild(bGuess);
  }

  function log(kind, html) {
    var box = $('chatLog');
    var line = WB.util.el('div', 'line ' + kind, html);
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------- 猜 ---------------- */
  /** 返回 true 表示这次提交被接受了（调用方可以清空输入框） */
  function doGuess(text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return false;
    if (!state.turn || state.isPainter) {
      WB.ui.toast('现在不能猜', 'err');
      return false;
    }
    var left = cdSecs(state.myId);
    if (left > 0) {
      // 冷却没到：保留输入框里的内容，别把人家打的字清了
      WB.ui.toast('还在冷却，' + left + ' 秒后才能再猜', 'err');
      return false;
    }
    net.send({ t: 'ydwg.guess', text: text });
    return true;
  }

  /* ---------------- 单局结束弹窗（10 秒自动关） ---------------- */
  function closeTurnDialog() {
    hide$('maskTurn');
    if (state.turnTimer) { clearInterval(state.turnTimer); state.turnTimer = null; }
  }

  /** 把「你这局加了多少分 + 明细（详细）」渲染进结算弹窗 */
  function renderGain(gainId, boxId, btnId, bodyId, detail) {
    var mine = (detail || {})[state.myId];
    var gEl = $(gainId); if (!gEl) return;
    if (!mine || !mine.pts) {
      gEl.textContent = '+0';
      gEl.style.color = 'var(--dim)';
      hide$(boxId);
      return;
    }
    gEl.textContent = '+' + mine.pts;
    gEl.style.color = 'var(--ok)';
    var body = $(bodyId);
    body.innerHTML = (mine.items || []).map(function (it) {
      return '<div class="drow"><span>' + esc(it.label) + '</span>' +
        '<span class="' + (it.pts >= 0 ? 'plus' : 'minus') + '">' +
        (it.pts >= 0 ? '+' : '') + it.pts + ' 分</span></div>';
    }).join('');
    $(boxId).classList.remove('hidden');
    var btn = $(btnId);
    btn.textContent = '详细';
    btn.onclick = function () {
      var open = body.classList.toggle('hidden') === false;
      btn.textContent = open ? '详细 ▾' : '详细';
    };
  }

  function showTurnDialog(d) {
    state.lastWord = d.word;
    renderGain('turnGain', 'turnDetailBox', 'turnDetailBtn', 'turnDetail', d.detail);
    $('turnWord').textContent = d.word || '—';
    var tip;
    if (d.reason === 'timeout') tip = '时间到了，没人猜出来。';
    else if (d.reason === 'left') tip = '画者中途走了，本回合作废。';
    else tip = '有人猜中啦！';
    $('turnTip').textContent = tip;
    var box = $('turnScore');
    box.innerHTML = '';
    var turnRank = d.ranking || [];
    turnRank.forEach(function (r, i) {
      box.appendChild(rankRow(r, i, turnRank));
    });

    var secs = Math.max(1, Math.round((d.gapMs || 10000) / 1000));
    var btn = $('btnTurnOk');
    btn.textContent = '我知道了';
    $('turnCountdown').textContent = secs + ' 秒后自动关闭，进入下一回合…';
    show$('maskTurn');
    if (state.turnTimer) clearInterval(state.turnTimer);
    state.turnTimer = setInterval(function () {
      secs--;
      if (secs <= 0) { closeTurnDialog(); return; }
      $('turnCountdown').textContent = secs + ' 秒后自动关闭，进入下一回合…';
    }, 1000);
  }

  /** 在结算名单里的名次（同分并列） */
  function rankIn(list, i) {
    var s = list[i].score || 0, above = 0;
    for (var k = 0; k < list.length; k++) if (k !== i && (list[k].score || 0) > s) above++;
    return above + 1;
  }

  function rankRow(r, i, list) {
    var tags = (r.left ? '<span class="tag gone">已退出</span>' : '') +
      (r.host ? '<span class="tag host">房主</span>' : '') +
      (r.right ? '<span class="tag">猜对 ' + r.right + '</span>' : '');
    return lbRow(rankIn(list || [], i), { name: r.name, color: r.color, score: r.score, tags: tags });
  }

  /* ---------------- 终局结算 ---------------- */
  function showSettle(d) {
    state.settling = true;
    closeTurnDialog();
    state.lastWord = d.word || state.lastWord;
    $('overWord').textContent = d.word || '—';
    $('overTip').textContent = '全部 ' + (state.room ? state.room.settings.rounds : '') + ' 局都打完了，下面是最终排名。';

    renderGain('overGain', 'overDetailBox', 'overDetailBtn', 'overDetail', d.detail);
    var box = $('overScore');
    box.innerHTML = '';
    var finalRank = d.ranking || [];
    finalRank.forEach(function (r, i) { box.appendChild(rankRow(r, i, finalRank)); });

    var secs = Math.max(1, Math.round((d.settleMs || 30000) / 1000));
    $('overCountdown').textContent = secs + ' 秒内不做选择，就当作退出房间。';
    show$('maskOver');
    if (state.settleTimer) clearInterval(state.settleTimer);
    state.settleTimer = setInterval(function () {
      secs--;
      if (secs <= 0) { clearInterval(state.settleTimer); state.settleTimer = null; return; }
      $('overCountdown').textContent = secs + ' 秒内不做选择，就当作退出房间。';
    }, 1000);
  }

  function hideSettle() {
    hide$('maskOver');
    if (state.settleTimer) { clearInterval(state.settleTimer); state.settleTimer = null; }
  }

  /* ---------------- 保存作品 ---------------- */
  function stamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  function safeName(s) {
    return String(s || '作品').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 24) || '作品';
  }
  function saveArt(word) {
    try {
      var url = pad.getDataURL('image/png');
      var name = '你画我猜-' + safeName(word) + '-' + stamp() + '.png';
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      WB.ui.toast('已保存 ' + name, 'ok');
    } catch (e) {
      WB.ui.toast('保存失败了：' + e.message, 'err');
    }
  }

  /** 给导出文件起名用的答案：作画时自己有；猜的人在回合结束后才知道 */
  function currentArtName() {
    if (state.isPainter) {
      var w = $('secretWord').textContent;
      if (w && w !== '—') return w;
    }
    return state.lastWord || '作品';
  }

  /* ---------------- 小工具 ---------------- */
  function el(tag, cls, text) { return WB.util.el(tag, cls, text == null ? '' : esc(text)); }
  function show$(id) { $(id).classList.remove('hidden'); }
  function hide$(id) { $(id).classList.add('hidden'); }

  /* ---------------- 事件绑定 ---------------- */
  $('btnHome').onclick = function () {
    // 对局中直接跳走会把一局搅了，先问一句
    if (!confirmLeave()) return;
    location.href = '/';
  };
  $('btnSettings').onclick = function () { WB.ui.openSettings(); };
  $('btnCreate').onclick = function () { net.send({ t: 'ydwg.create', key: ME_KEY }); };
  $('btnJoin').onclick = function () {
    var c = $('joinCode').value.trim();
    if (c) net.send({ t: 'ydwg.join', code: c, key: ME_KEY });
  };
  $('joinCode').onkeydown = function (e) { if (e.key === 'Enter') $('btnJoin').click(); };
  $('btnCopy').onclick = function () {
    var link = $('shareLink').value;
    if (navigator.clipboard) navigator.clipboard.writeText(link);
    $('shareLink').select();
    WB.ui.toast('邀请链接已复制', 'ok');
  };
  /* 三个面板都能收起：本局信息 / 积分排行榜 / 聊天区 */
  Array.prototype.forEach.call(document.querySelectorAll('.foldBtn'), function (b) {
    b.onclick = function () {
      var target = document.getElementById(b.dataset.fold);
      if (!target) return;
      var folded = target.classList.toggle('folded');
      b.textContent = folded ? '展开' : '收起';
      if (b.dataset.fold === 'chatPanel') {
        var log = $('chatLog');
        log.scrollTop = log.scrollHeight;
      }
    };
  });

  $('btnGuess').onclick = function () {
    var inp = $('guessInput');
    if (doGuess(inp.value)) inp.value = '';
  };
  $('guessInput').onkeydown = function (e) { if (e.key === 'Enter') $('btnGuess').click(); };
  $('btnGrab').onclick = function () {
    var me = state.room && state.room.members.filter(function (p) { return p.id === state.myId; })[0];
    net.send({ t: 'ydwg.grab', grab: !(me && me.grabChoice === true) });
  };
  $('btnGrabNo').onclick = function () {
    var me = state.room && state.room.members.filter(function (p) { return p.id === state.myId; })[0];
    net.send({ t: 'ydwg.grab', grab: !(me && me.grabChoice === false) ? false : null });
  };
  $('btnTurnOk').onclick = closeTurnDialog;
  $('btnSaveArt').onclick = function () { saveArt(currentArtName()); };
  $('btnSaveOver').onclick = function () { saveArt(state.lastWord || currentArtName()); };
  $('btnBackRoom').onclick = function () {
    hideSettle();
    state.settling = false;
    net.send({ t: 'ydwg.toLobby' });
    show('Lobby');
  };
  $('btnExitRoom').onclick = function () {
    if (!confirmLeave()) return;
    hideSettle();
    net.send({ t: 'ydwg.exitRoom' });
    goHome();
  };
  /** 对局中想离开/回主页：先二次确认，免得手滑把一局搅了 */
  function confirmLeave() {
    var r = state.room;
    var busy = r && (r.state === 'playing' || r.state === 'grabbing' ||
                     r.state === 'roles' || r.state === 'turnEnd');
    if (!busy) return true;
    return window.confirm('这一局还在进行中，现在离开会直接退出房间，确定吗？');
  }
  window.__ydwgConfirmLeave = confirmLeave;

  function goHome() {
    if (WB.Chat && WB.Chat.leaveRoom) WB.Chat.leaveRoom();
    if (WB.Friends && WB.Friends.refreshGame) WB.Friends.refreshGame();
    state.code = ''; state.room = null; state.turn = null;
    state.isPainter = false; state.settling = false;
    hideRoleBanner();
    settingsRefs = null; chatBuilt = false;   // 缓存作废，下次进房间按新房重建
    forgetRoom();                             // 主动离开才忘掉房间号
    pad.resetAll(); pad.setEnabled(false);
    $('chatLog').innerHTML = '';
    show('Home');
  }
  /* 刷新 / 关页面时**不要**发 leave：以前这么做，刷新一下就先把自己踢出房间了
     （2 人房还会因为人数不足直接回大厅）。现在靠 WebSocket 断开 + 服务端
     "掉线宽限期"来兜：30 秒内带着同一个身份 key 回来，座位和分数都还在。 */
  window.addEventListener('beforeunload', function () { /* 交给服务端宽限期处理 */ });

  /* ---------------- 网络消息 ---------------- */
  net.on('hello', function (m) { state.myId = m.id; });

  /** 建房 / 入房时同步平台侧：进本局频道 + 让好友面板刷新「邀请组队」 */
  function enterPlatformChat(code) {
    if (WB.Chat && WB.Chat.enterRoom) {
      WB.Chat.enterRoom({ game: 'drawguess', code: code, title: '你画我猜 · 房间 ' + code });
    }
    if (WB.Friends && WB.Friends.refreshGame) WB.Friends.refreshGame();
  }
  net.on('ydwg.created', function (m) {
    state.code = m.code; state.settling = false; rememberRoom(m.code);
    enterPlatformChat(m.code); show('Lobby');
  });
  net.on('ydwg.joined', function (m) {
    state.code = m.code; state.settling = false; rememberRoom(m.code);
    enterPlatformChat(m.code); show('Lobby');
  });

  net.on('ydwg.room', function (m) {
    renderRoom(m);
    // 刷新/重连回到进行中的对局：把已有的画补回来（每人只要一次）
    if ((m.state === 'playing' || m.state === 'roles') && !state.syncedTurn) {
      state.syncedTurn = m.turnStamp || 1;
      net.send({ t: 'ydwg.canvas', op: 'sync' });
    }
    if (m.state !== 'playing' && m.state !== 'roles') state.syncedTurn = 0;
  });
  net.on('ydwg.error', function (m) {
    WB.ui.toast(m.msg, 'err');
    if (m.cdLeft) setCd(state.myId, m.cdLeft);
  });
  net.on('ydwg.notice', function (m) { log('sys', esc(m.text)); WB.ui.toast(m.text, 'wait'); });

  /* 聊天：之前客户端漏了这个处理器，消息发出去到了服务端、也广播回来了，
     但没人在界面上渲染 —— 表现就是「发出去就没了」。 */
  net.on('ydwg.chat', function (m) {
    var mine = m.id === state.myId;
    log('chat', '<span class="who">' + esc(m.name) + '</span>' + (mine ? '（我）' : '') + '：' + esc(m.text));
  });
  net.on('ydwg.host', function (m) { log('sys', '房主变成 ' + esc(m.name)); });
  net.on('ydwg.playerLeft', function (m) {
    log('sys', esc(m.text || (m.name + ' 退出了房间')));
    WB.ui.toast(m.text || (m.name + ' 退出了房间'), 'err');
  });

  // 开局身份牌：先亮 3 秒「谁画谁猜」，服务端 3 秒后才开始第一回合
  net.on('ydwg.roles', function (m) { showRolesPanel(m); });

  net.on('ydwg.grabStart', function () { show('Grab'); });
  net.on('ydwg.matchStart', function () { $('chatLog').innerHTML = ''; });

  net.on('ydwg.turn', function (m) {
    hideRolesPanel();
    state.syncedTurn = 1;
    state.hintUsed = {}; state.canHint = false; state.hintLog = '';
    startTurn(m);
  });

  net.on('ydwg.secret', function (m) {
    if (!state.turn) return;
    $('secretWord').textContent = m.word;
    $('secretOrigin').textContent = '（' + (m.origin || '') + '）';
    updateRoleBannerWord(m.word, m.origin);   // 顺带把"你是画者"弹窗补全题目
  });

  net.on('ydwg.tick', function (m) {
    if (m.grabLeft != null) {
      $('grabTimer').textContent = m.grabLeft;
      var total = (state.room && state.room.limits && state.room.limits.grabMs) ? state.room.limits.grabMs / 1000 : 15;
      $('grabBar').style.width = Math.max(0, Math.min(100, m.grabLeft / total * 100)) + '%';
      return;
    }
    if (m.settleLeft != null) return;
    var s = Math.max(0, m.left);
    var mm = String(Math.floor(s / 60)).padStart(2, '0');
    var ss = String(s % 60).padStart(2, '0');
    $('timerPill').textContent = mm + ':' + ss;
    $('timerPill').classList.toggle('act', s <= 10);
    state.tickLeft = s;
    updateInfoClock();
    if (state.isPainter) {
      var wasCan = !!state.canHint;
      state.canHint = !!m.canHint;
      state.hintLeft = m.hintLeft != null ? m.hintLeft : 0;
      if (state.canHint !== wasCan) {
        renderHints();                       // 刚解锁：三个按钮一次性变亮
      } else if (!state.canHint) {
        var badge = $('hintWait');
        if (badge) badge.textContent = hintWaitText(state.hintLeft);
      }
    }
  });

  /* 画板操作：远端来的直接用组件消化 */
  net.on('ydwg.op', function (m) { pad.applyRemote(m.op); });
  // 刷新/中途回来：服务端把这一回合已有的笔迹整批补发过来
  net.on('ydwg.opBatch', function (m) {
    (m.ops || []).forEach(function (op) { pad.applyRemote(op); });
  });
  net.on('ydwg.opCount', function (m) { pad.truncate(m.n); });

  net.on('ydwg.hint', function (m) {
    if (state.hintUsed == null) state.hintUsed = {};
    state.hintUsed[m.kind] = true;
    // ★ 猜的人也要看到提示（以前只有画者会写 hintLog，猜的人那一行一直是占位文字）
    state.hintLog = state.isPainter
      ? '已给提示：' + m.label + '（' + m.text + '），若被猜中将扣 ' + m.cost + ' 分'
      : '画家的提示 · ' + m.label + '：' + m.text;
    renderHints();
    log('hint', '画家给了「' + esc(m.label) + '」提示：' + esc(m.text) + '（被猜中则扣 ' + m.cost + ' 分）');
  });

  net.on('ydwg.swapped', function (m) {
    log('sys', esc(m.by) + ' 换了一道题（还能换 ' + m.left + ' 次）；提示已刷新，可以重新给');
    // ★ 换了题，之前用掉的提示自动刷新（服务端已经把 hints 清空、代价归零）
    state.hintUsed = {};
    state.hintLog = state.isPainter
      ? '换了新题，三档提示都可以重新给了'
      : '画家换了新题，字数已经更新';
    if (state.isPainter && state.turn) state.turn.swaps = m.left;
    renderHints();
  });

  net.on('ydwg.guessMiss', function (m) {
    log('miss', '<span class="who">' + esc(m.name) + '</span> 猜：<b>' + esc(m.text) + '</b>（' + m.cd + 's 冷却）');
    setCd(m.id, m.cd);
    if (state.room) renderMembers(state.room);
  });

  net.on('ydwg.win', function (m) {
    log('sys', '<b>' + esc(m.by) + '</b> 猜中了！');
    (m.gains || []).forEach(function (g) { log('sys', '　' + esc(g.name) + ' +' + g.pts + ' 分'); });
  });

  net.on('ydwg.turnEnd', function (m) {
    hideRoleBanner();
    state.isPainter = false;
    pad.setEnabled(false);
    if (m.isLast) return;                 // 最后一局直接等结算弹窗
    showTurnDialog(m);
  });

  net.on('ydwg.over', function (m) { showSettle(m); });
  net.on('ydwg.settleTimeout', function () {
    WB.ui.toast('你有一阵子没做选择，已经退出房间', 'err');
    goHome();
  });
  net.on('ydwg.exited', function () { WB.ui.toast('已退出房间', 'ok'); forgetRoom(); goHome(); });

  net.on('ydwg.toLobby', function (m) {
    if (m && m.text) log('sys', esc(m.text));
    if (!state.settling) show('Lobby');
  });

  /* ---------------- 好友系统 ---------------- */
  WB.Friends.boot(net);
  // 平台层的聊天控件（左下角那个）：好友私聊 + 本局频道。
  // 它和游戏里自带的「聊天区」是两回事，互不干扰：这里进的是平台频道。
  // 用守卫包起来 —— 没有 chat.js 的平台（老分支）也能安全跑。
  if (WB.Chat && WB.Chat.boot) WB.Chat.boot(net);
  WB.Friends.registerGame({
    name: 'drawguess',
    label: '你画我猜',
    entry: '/drawguess/',
    param: 'join',
    canInvite: function () { return state.code ? { data: { code: state.code }, text: '房间 ' + state.code } : null; },
    accept: function (data) { net.send({ t: 'ydwg.join', code: data.code, key: ME_KEY }); }
  });

  /* ---------------- 启动 ---------------- */
  WB.bindNetBadge($('netBadge'), net);

  var params = new URLSearchParams(location.search);
  var joinCode = params.get('join');
  /*
   * 记住房间号。机房里的真实场景：开第二个标签页拉人时，第一个（后台）标签页会被
   * Chrome 回收/重载，而 beforeunload 已经把主人踢出房间 —— 一回来就「开始游戏
   * 按钮不见了」「身份不更新」「看不到别人的设置」。所以把房间号存进
   * localStorage，重载或断线重连后自动回房；服务端再按 ip+昵称 把房主身份
   * 还回来（见 server/room.js 的 hostKey）。
   */
  /*
   * 用 sessionStorage（每个标签页独立、且重载仍然保留）：
   *  - 房间号：后台标签页被 Chrome 回收重载后，能自动回房
   *    （否则一回来就「开始游戏按钮不见了」「身份不更新」「看不到别人的设置」）
   *  - 身份密钥：平台每次连接都换 id、没设昵称时还换随机名，
   *    所以「ip+昵称」在重连后对不上；用这个持久 key 才能准确认出
   *    「还是同一个人」，服务端才能把房主身份还给他。
   *    每个标签页一把钥匙 → 同一台机器开两个标签页就是两个玩家，不会互相抢房主。
   */
  var ROOM_KEY = 'drawguess.room';
  var ID_KEY = 'drawguess.id';
  function myKey() {
    try {
      var k = sessionStorage.getItem(ID_KEY);
      if (!k) {
        k = 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(ID_KEY, k);
      }
      return k;
    } catch (e) { return ''; }
  }
  var ME_KEY = myKey();
  function rememberRoom(code) {
    try { sessionStorage.setItem(ROOM_KEY, JSON.stringify({ code: code, ts: Date.now() })); } catch (e) { /* noop */ }
  }
  function forgetRoom() {
    try { sessionStorage.removeItem(ROOM_KEY); } catch (e) { /* noop */ }
  }
  function recalledRoom() {
    try {
      var o = JSON.parse(sessionStorage.getItem(ROOM_KEY) || 'null');
      if (o && o.code && Date.now() - o.ts < 2 * 3600 * 1000) return o.code;   // 2 小时内才自动回
    } catch (e) { /* noop */ }
    return null;
  }
  var wantCode = joinCode || recalledRoom();

  net.on('status', function (s) {
    // net.js 连上时派发的是 'status'（值为 open），没有 'open' 事件
    if (s !== 'open') return;
    var code = joinCode || state.code || wantCode;
    if (code) net.send({ t: 'ydwg.join', code: code, key: ME_KEY });
  });
  net.connect();
  pad.resize();
})();
