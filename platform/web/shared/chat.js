/*!
 * 聊天控件（平台层，所有游戏通用）
 * 依赖：core.js（WB.util / WB.ui / WB.audio）、net.js（WB.Net）、friends.js（好友列表 + 聊天小窗）
 *
 * 每个页面只需要：
 *   1) index.html 里引入 /shared/chat.css 与 /shared/chat.js
 *   2) 脚本里调用 WB.Chat.boot(net)
 *   3) （游戏页面）房间创建 / 加入 / 开局时调用：
 *        WB.Chat.enterRoom({ game: 'dodge', code: '1234', title: '方块躲避 · 房间 1234' })
 *      离开房间 / 对局结束时：WB.Chat.leaveRoom()
 *
 * 分工（界面上是一个控件，背后是两块能力）：
 *   · 「好友」页签 —— 列好友、点谁就跟谁聊；真正的私聊窗口由好友系统提供
 *     （WB.friends.openChat，独立小窗，带历史记录，**切页面不会丢，只有手动刷新才清掉**）；
 *   · 「本局」页签 —— 房间频道聊天，房间里所有人可见（chat.join / chat.send，临时频道）。
 *
 * 样子与行为：
 *   · 默认贴在**左下角**，按住标题栏可以**拖到任意地方**，位置记在本机；
 *   · 点「–」收起成一条，只显示**最新一条消息**（谁说的 + 内容）+ 未读角标；
 *   · 点「×」**隐藏**成一个小圆钮（带未读角标），点它再回来。
 */
window.WB = window.WB || {};
(function (WB) {
  'use strict';

  var util = WB.util;
  function el(tag, cls, html) { return util.el(tag, cls, html); }
  function esc(s) { return util.esc(s); }

  var LS_STATE = 'wb.chat.state.v1';       // { x, y, min, hidden, tab, activeRoom }
  var BALL = 48;
  /* 好友私聊小窗的"落脚区"（尺寸与位置见 friends.css 的 .wb-friends-dock / .fb-chat）。
     控件只要压在这块上，小窗就会往右让开 —— 否则小窗会正好糊在控件上，
     连「好友 / 本局」这两个页签都点不到（详情见下面 syncDockSide）。 */
  var DOCK_ZONE = { left: 14, bottom: 14, width: 302, height: 384 };

  function load(key, dft) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || dft; } catch (e) { return dft; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* noop */ }
  }
  function hhmm(ts) {
    var d = new Date(ts || Date.now());
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ================= 入口 ================= */
  var Chat = {
    boot: function (net) {
      if (WB.chat) return WB.chat;
      if (!net) return null;
      var app = new ChatApp(net);
      app.mount();
      WB.chat = app;
      return app;
    },
    enterRoom: function (info) { return WB.chat ? WB.chat.enterRoom(info) : null; },
    leaveRoom: function () { return WB.chat ? WB.chat.leaveRoom() : null; },
    openPrivate: function (ip, name) { return WB.chat ? WB.chat.openPrivate(ip, name) : null; },
    openRoom: function () { return WB.chat ? WB.chat.openRoom() : null; }
  };

  /* ================= 应用主体 ================= */
  function ChatApp(net) {
    this.net = net;
    this.room = null;              // { channel, title, members: [] }
    this.roomConv = null;          // { channel, title, list: [], members: [] }
    this.roomUnread = 0;
    this.lastMsg = null;           // 最新消息（收起时显示）
    this.friendUnreadSeen = {};    // 好友系统那边的未读快照（点开对话就归零）

    var st = load(LS_STATE, {});
    this.pos = (typeof st.x === 'number' && typeof st.y === 'number') ? { x: st.x, y: st.y } : null;
    // 默认是**收纳状态**（就一条，显示最新消息）：想看好友列表再点开。
    // 位置 / 收纳 / 隐藏这些状态都记在本机，**刷新页面也不会被重置**
    // （这是聊天控件的"常驻"承诺：所有页面都在、刷新也不掉）。
    this.min = st.min === undefined ? true : !!st.min;
    this.hidden = !!st.hidden;
    this.tab = st.tab === 'room' ? 'room' : 'friends';
    this._bindNet();
  }

  ChatApp.prototype._saveState = function () {
    save(LS_STATE, {
      x: this.pos ? this.pos.x : undefined,
      y: this.pos ? this.pos.y : undefined,
      min: this.min, hidden: this.hidden, tab: this.tab
    });
  };

  ChatApp.prototype.friendsApp = function () { return WB.friends || null; };
  ChatApp.prototype.friendList = function () {
    var f = this.friendsApp();
    return (f && f.friends) ? f.friends : [];
  };
  ChatApp.prototype.privateUnread = function (ip) {
    var f = this.friendsApp();
    if (!f) return 0;
    if (ip) return f.unread[ip] || 0;
    var n = 0;
    for (var k in f.unread) n += (f.unread[k] || 0);
    return n;
  };
  ChatApp.prototype.totalUnread = function () { return this.privateUnread() + this.roomUnread; };

  /* ---------------- 网络（只关心"最新消息"与房间频道） ---------------- */
  ChatApp.prototype._bindNet = function () {
    var self = this;

    this.net.on('friends.chat', function (m) {
      if (m.self) return;
      var f = self.friendsApp();
      var name = m.name || (f ? f.friendName(m.from) : m.from);
      self.lastMsg = { name: name, text: m.text, room: false };
      self.refreshFromFriends();
    });

    this.net.on('chat.log', function (m) {
      var conv = self._ensureRoom(m.channel, m.title);
      conv.list = (m.list || []).slice();
      if (self._roomOpen()) self.renderPane();
    });
    this.net.on('chat.members', function (m) {
      var conv = self._ensureRoom(m.channel, m.title);
      conv.members = m.members || [];
      if (m.title) conv.title = m.title;
      if (self.room && self.room.channel === m.channel) self.room.members = conv.members;
      if (self._roomOpen()) self.renderPane();
      self.renderBadge();
    });
    this.net.on('chat.msg', function (m) {
      var conv = self._ensureRoom(m.channel, self.room ? self.room.title : m.channel);
      // 自己发的消息本地已经画过一次了，服务端回显（self=true）按 mid 去重，别画两遍
      if (m.mid && conv.list.some(function (x) { return x.mid === m.mid; })) return;
      conv.list.push({ from: m.from, name: m.name, text: m.text, ts: m.ts, mid: m.mid, mine: !!m.self });
      if (conv.list.length > 300) conv.list.splice(0, conv.list.length - 300);
      self.lastMsg = { name: m.name || '有人', text: m.text, room: true };
      var openHere = self._roomOpen() && !m.self;
      if (!m.self && !openHere) {
        self.roomUnread++;
        WB.audio.play('invite');
      }
      if (self._roomOpen()) self.renderPane();
      self.renderBadge();
      self.renderPreview();
    });
    this.net.on('chat.system', function (m) {
      var conv = self.roomConv;
      if (!conv || conv.channel !== m.channel) return;
      conv.list.push({ sys: true, text: m.text, ts: Date.now() });
      if (self._roomOpen()) self.renderPane();
    });
    this.net.on('chat.error', function (m) { WB.ui.toast(m.msg || '聊天出错了', 'err'); });
  };

  ChatApp.prototype._ensureRoom = function (channel, title) {
    if (!this.roomConv || this.roomConv.channel !== channel) {
      this.roomConv = { channel: channel, title: title || channel, list: [], members: [] };
    }
    if (title) this.roomConv.title = title;
    return this.roomConv;
  };

  /** 好友系统那边未读/在线有变化时调过来（好友列表与角标要跟着动） */
  ChatApp.prototype.refreshFromFriends = function () {
    if (this._expanded() && this.tab === 'friends' && !this.activeRoomOpen()) this.renderPane();
    this.renderBadge();
    this.renderPreview();
  };

  /* ---------------- 挂载 ---------------- */
  ChatApp.prototype._expanded = function () { return !this.min && !this.hidden; };
  ChatApp.prototype.activeRoomOpen = function () { return false; };   // 私聊在独立小窗里，控件本身没有"打开的会话"
  ChatApp.prototype._roomOpen = function () { return this._expanded() && this.tab === 'room' && !!this.room; };

  ChatApp.prototype.mount = function () {
    var self = this;

    // wb-dark：控件自带一套深色配色，不跟所在页面的主题走（见 app.css 的注释）
    var root = el('div', 'wb-chat wb-dark' + (this.min ? ' min' : '') + (this.hidden ? ' gone' : ''));
    root.id = 'wb-chat';

    var head = el('div', 'wc-head');
    var title = el('div', 'wc-title', '💬 聊天');
    var sub = el('div', 'wc-sub');
    sub.id = 'wcSub';
    var minBtn = el('button', 'wc-btn', '–');
    minBtn.type = 'button';
    minBtn.title = '收起（只留最新消息）';
    var hideBtn = el('button', 'wc-btn', '×');
    hideBtn.type = 'button';
    hideBtn.title = '隐藏聊天（点小圆钮再打开）';
    head.appendChild(title); head.appendChild(sub); head.appendChild(minBtn); head.appendChild(hideBtn);

    var preview = el('div', 'wc-preview');
    preview.id = 'wcPreview';

    /* 收纳状态下也直接列出好友（点谁跟谁聊），不再是只能看一条消息 */
    var mini = el('div', 'wc-mini');
    mini.id = 'wcMini';

    var body = el('div', 'wc-body');
    var tabs = el('div', 'wc-tabs');
    var tabRoom = el('button', 'wc-tab');
    tabRoom.dataset.ctab = 'room';            // 用 ctab：不和好友面板的 data-tab="friends" 撞选择器
    tabRoom.textContent = '本局';
    var tabFriends = el('button', 'wc-tab');
    tabFriends.dataset.ctab = 'friends';
    tabFriends.textContent = '好友';
    tabs.appendChild(tabRoom); tabs.appendChild(tabFriends);
    var pane = el('div', 'wc-pane');
    pane.id = 'wcPane';
    body.appendChild(tabs); body.appendChild(pane);

    root.appendChild(head); root.appendChild(preview); root.appendChild(mini); root.appendChild(body);
    document.body.appendChild(root);
    this.root = root; this.head = head; this.subEl = sub;
    this.previewEl = preview; this.miniEl = mini; this.pane = pane; this.tabsEl = tabs;
    this.tabRoomEl = tabRoom; this.tabFriendsEl = tabFriends;

    var ball = el('button', 'wc-ball wb-dark');
    ball.id = 'wcBall';
    ball.type = 'button';
    ball.title = '打开聊天';
    ball.appendChild(document.createTextNode('💬'));
    var badge = el('span', 'wc-ball-badge hidden');
    ball.appendChild(badge);
    ball.classList.toggle('gone', !this.hidden);
    document.body.appendChild(ball);
    this.ball = ball; this.ballBadge = badge;

    minBtn.addEventListener('click', function (e) { e.stopPropagation(); WB.audio.play('click'); self.toggleMin(); });
    hideBtn.addEventListener('click', function (e) { e.stopPropagation(); WB.audio.play('click'); self.hide(); });
    ball.addEventListener('click', function () { WB.audio.play('click'); self.show(); });
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.wc-tab') : null;
      if (!b) return;
      self.tab = b.dataset.ctab;
      self._saveState();
      WB.audio.play('click');
      self.renderPane(true);        // 用户主动切页签 → 这时才去要一次最新好友数据
      self.renderBadge();
    });
    this._bindDrag();
    // 收纳状态下点一下控件（标题栏或"最新消息"那条）就展开；点好友行则是开聊，不展开
    root.addEventListener('click', function (e) {
      if (!self.min) return;
      if (e.target.closest && (e.target.closest('.wc-btn') || e.target.closest('.wc-row'))) return;
      WB.audio.play('click');
      self.toggleMin();
    });

    root.addEventListener('keydown', function (e) { e.stopPropagation(); });
    root.addEventListener('keyup', function (e) { e.stopPropagation(); });

    this.applyPos();
    this.renderPane();
    this.renderPreview();
    this.renderBadge();
  };

  ChatApp.prototype.applyPos = function () {
    var r = this.root;
    var box = r.getBoundingClientRect();
    var w = box.width || 296, h = box.height || 0;
    if (!this.pos) {
      r.classList.add('wc-default');
      r.style.left = ''; r.style.top = ''; r.style.bottom = '';
      this.ball.classList.add('wc-default');
      this.ball.style.left = ''; this.ball.style.top = '';
      this.syncDockSide();
      return;
    }
    r.classList.remove('wc-default');
    this.ball.classList.remove('wc-default');
    // 位置是本机记下来的，可能来自"窗口还很大 / 还是收纳态"的时候：
    // 这里按**现在的尺寸**再夹一次，保证整个控件都留在屏幕里（别把页签顶到屏幕外）
    var x = Math.max(0, Math.min(this.pos.x, Math.max(0, window.innerWidth - w)));
    var y = Math.max(0, Math.min(this.pos.y, Math.max(0, window.innerHeight - h - 4)));
    r.style.left = x + 'px'; r.style.top = y + 'px'; r.style.bottom = 'auto';
    this.ball.style.left = Math.max(0, Math.min(x + 10, window.innerWidth - BALL - 4)) + 'px';
    this.ball.style.top = y + 'px';
    this.syncDockSide();
  };

  /**
   * 控件是不是正压在「好友私聊小窗的落脚区」上？
   * 是的话给小窗算一个"往右让开"的距离（--wb-dock-shift，见 friends.css），
   * 因为小窗比控件还大（302×384 vs 296×346）又压在同一角，不让开的话
   * 页签会被小窗（确切说是它的消息区 div）盖住，点不着。
   * 让开距离按**控件当前实际位置**算：控件被拖到哪，小窗就让到它右边 8px；
   * 但也不能把自己顶出屏幕（右边至少留 14px）。
   */
  ChatApp.prototype.syncDockSide = function () {
    if (!document.body || !this.root) return;
    var on = false, shift = 0;
    var box = this.root.getBoundingClientRect();
    if (!this.hidden && box.width > 0 && box.height > 0) {
      var vh = window.innerHeight;
      var zl = DOCK_ZONE.left, zr = zl + DOCK_ZONE.width;
      var zb = vh - DOCK_ZONE.bottom, zt = zb - DOCK_ZONE.height;
      on = box.left < zr && box.right > zl && box.top < zb && box.bottom > zt;
      if (on) {
        var winW = document.querySelector('.wb-friends-dock .fb-chat');
        winW = (winW && winW.offsetWidth) || DOCK_ZONE.width;
        var maxShift = Math.max(0, window.innerWidth - zl - winW - 14);
        shift = Math.max(0, Math.min(Math.round(box.right + 8 - zl), maxShift));
      }
    }
    document.body.classList.toggle('wc-dock-side', !!on);
    document.body.style.setProperty('--wb-dock-shift', shift + 'px');
  };

  ChatApp.prototype._bindDrag = function () {
    var self = this;
    var dragging = null;

    function point(ev) {
      if (ev.touches && ev.touches[0]) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
      return { x: ev.clientX, y: ev.clientY };
    }
    function down(ev) {
      if (ev.target.closest && ev.target.closest('.wc-btn')) return;
      var p = point(ev);
      var r = self.root.getBoundingClientRect();
      dragging = { dx: p.x - r.left, dy: p.y - r.top, moved: false };
      self.root.classList.add('dragging');
      if (ev.cancelable) ev.preventDefault();
    }
    function move(ev) {
      if (!dragging) return;
      var p = point(ev);
      // 也按控件当前尺寸夹：拖到边角时整个控件都留在屏幕里，不会"半截在外面"
      var w = self.root.offsetWidth || 296, h = self.root.offsetHeight || 0;
      var x = Math.max(0, Math.min(p.x - dragging.dx, Math.max(0, window.innerWidth - w)));
      var y = Math.max(0, Math.min(p.y - dragging.dy, Math.max(0, window.innerHeight - h)));
      if (!self.pos || Math.abs(x - self.pos.x) > 1 || Math.abs(y - self.pos.y) > 1) dragging.moved = true;
      self.pos = { x: x, y: y };
      self.applyPos();
      if (ev.cancelable) ev.preventDefault();
    }
    function up() {
      if (!dragging) return;
      var moved = dragging.moved;
      dragging = null;
      self.root.classList.remove('dragging');
      if (moved) { self._saveState(); WB.audio.play('click'); }
    }

    this.head.addEventListener('mousedown', down);
    this.head.addEventListener('touchstart', down, { passive: false });
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', up);
    window.addEventListener('touchend', up);
    window.addEventListener('resize', function () { self.applyPos(); });
  };

  /* ---------------- 状态切换 ---------------- */
  ChatApp.prototype.toggleMin = function () {
    this.min = !this.min;
    if (!this.min) this.hidden = false;
    this.root.classList.toggle('min', this.min);
    this.root.classList.toggle('gone', this.hidden);
    this.ball.classList.toggle('gone', !this.hidden);
    if (!this.min) { this.renderPane(true); if (this._focusInput) this._focusInput.focus(); }
    this.renderPreview();
    this.applyPos();      // 展开/收起高度差很多，按新高度重新夹一次，保证整体在屏幕里
    this.syncDockSide();
    this._saveState();
  };

  ChatApp.prototype.hide = function () {
    this.hidden = true;
    this.root.classList.add('gone');
    this.ball.classList.remove('gone');
    this.syncDockSide();
    this._saveState();
    WB.ui.toast('聊天已隐藏，点 💬 小圆钮可以叫回来');
  };

  ChatApp.prototype.show = function () {
    this.hidden = false;
    this.root.classList.remove('gone');
    this.ball.classList.add('gone');
    this.syncDockSide();
    this._saveState();
    this.renderPane(true);        // 从小圆钮叫回来 = 用户刚打开，拉一次最新
    this.renderPreview();
  };

  /**
   * 收纳状态下的小名单：最新消息下面直接列好友，点谁跟谁聊。
   * （这样收起时"看消息"和"找人"两件事都能干，不用先展开）
   */
  ChatApp.prototype.renderMini = function () {
    var mini = this.miniEl;
    if (!mini) return;
    mini.textContent = '';
    var self = this;
    var arr = this.friendList();
    if (!arr.length) {
      mini.appendChild(el('div', 'wc-mini-empty', '还没有好友 · 点开看详情'));
      return;
    }
    arr.slice().sort(function (a, b) {
      var ua = self.privateUnread(a.ip), ub = self.privateUnread(b.ip);
      if (ua !== ub) return ub - ua;
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    }).slice(0, 8).forEach(function (fr) {
      var row = el('div', 'wc-row mini');
      row.appendChild(el('span', 'wc-dot' + (fr.online ? ' on' : '')));
      row.appendChild(el('div', 'wc-nm', esc(fr.name || fr.ip)));
      var u = self.privateUnread(fr.ip);
      if (u > 0) {
        var b = el('span', 'wc-badge');
        b.textContent = u > 99 ? '99+' : String(u);
        row.appendChild(b);
      }
      row.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        WB.audio.play('click');
        self.openPrivate(fr.ip, fr.name);
      });
      mini.appendChild(row);
    });
  };

  ChatApp.prototype.renderBadge = function () {
    var pu = this.privateUnread();
    var n = this.totalUnread();
    if (this.ballBadge) {
      this.ballBadge.textContent = n > 99 ? '99+' : String(n);
      this.ballBadge.classList.toggle('hidden', n <= 0);
    }
    if (this.subEl) {
      var txt = [];
      if (this.room) txt.push(this.room.title || '本局');
      txt.push(n > 0 ? (n + ' 条未读') : '在线聊天');
      this.subEl.textContent = txt.join(' · ');
    }
    this.tabRoomEl.classList.toggle('hidden', !this.room);
    this.tabRoomEl.textContent = '本局' + (this.room && this.roomUnread ? '·' + this.roomUnread : '');
    this.tabFriendsEl.textContent = '好友' + (pu ? '·' + pu : '');
    this.tabRoomEl.classList.toggle('on', this.tab === 'room' && !!this.room);
    this.tabFriendsEl.classList.toggle('on', this.tab !== 'room' || !this.room);
    this.renderMini();
  };

  ChatApp.prototype.renderPreview = function () {
    var p = this.previewEl;
    if (!p) return;
    p.textContent = '';
    p.classList.toggle('hidden', !this.min);
    if (!this.min) return;
    var line = el('div', 'wc-preview-line');
    if (this.lastMsg) {
      line.innerHTML = '<b>' + esc(this.lastMsg.name || '有人') + '</b>：' + esc(this.lastMsg.text);
    } else {
      line.innerHTML = '<span class="dim">还没有消息，点开聊两句</span>';
    }
    p.appendChild(line);
    var n = this.totalUnread();
    if (n > 0) {
      var b = el('span', 'wc-badge');
      b.textContent = n > 99 ? '99+' : String(n);
      p.appendChild(b);
    }
  };

  /* ---------------- 面板 ---------------- */
  /**
   * @param pullFresh  true = "用户刚打开好友页，主动向服务端要一次最新数据"。
   *   默认 false —— 因为 friends.state 的处理也会走到这里，如果在这里无条件发
   *   friends.refresh，就会形成死循环：
   *     renderPane → friends.refresh → 服务端回 friends.state
   *                → refreshFromFriends() → renderPane → ……
   *   服务端本来就会在任何变化时主动推 friends.state，所以"被动渲染"根本不用再问。
   */
  ChatApp.prototype.renderPane = function (pullFresh) {
    var pane = this.pane;
    if (!pane || this.min || this.hidden) return;
    if (this.tab === 'room' && !this.room) this.tab = 'friends';
    pane.textContent = '';
    if (this.tab === 'room') this._renderRoom();
    else this._renderFriendList(pullFresh);
  };

  /** 顺手加一道保险：即便将来有人又在上层发了 refresh，2 秒内也不重复发第二趟 */
  ChatApp.prototype._pullFriendsOnce = function () {
    var f = this.friendsApp();
    if (!f || !f.net) return;
    var now = Date.now();
    if (this._lastFriendsPull && now - this._lastFriendsPull < 2000) return;
    this._lastFriendsPull = now;
    f.net.send({ t: 'friends.refresh' });
  };

  ChatApp.prototype._renderFriendList = function (pullFresh) {
    var self = this;
    var f = this.friendsApp();
    if (pullFresh) this._pullFriendsOnce();
    var list = el('div', 'wc-list');
    var arr = this.friendList();
    if (!arr.length) {
      list.appendChild(el('div', 'wc-empty', '还没有好友。<br>点右上角「👥 好友」→「在线人员」→「加好友」，之后就能在这里跟他聊天。'));
    } else {
      arr.slice().sort(function (a, b) {
        var ua = self.privateUnread(a.ip), ub = self.privateUnread(b.ip);
        if (ua !== ub) return ub - ua;
        if (!!a.online !== !!b.online) return a.online ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''));
      }).forEach(function (fr) {
        var row = el('div', 'wc-row');
        row.appendChild(el('span', 'wc-dot' + (fr.online ? ' on' : '')));
        var who = el('div', 'wc-who');
        who.appendChild(el('div', 'wc-nm', esc(fr.name || fr.ip)));
        who.appendChild(el('div', 'wc-sub', esc((fr.online ? '在线 · ' : '离线 · ') + fr.ip)));
        row.appendChild(who);
        var u = self.privateUnread(fr.ip);
        if (u > 0) {
          var b = el('span', 'wc-badge');
          b.textContent = u > 99 ? '99+' : String(u);
          row.appendChild(b);
        }
        row.addEventListener('click', function () { WB.audio.play('click'); self.openPrivate(fr.ip, fr.name); });
        list.appendChild(row);
      });
    }
    paneAppend(this.pane, list);
    paneAppend(this.pane, el('p', 'wc-note', '点一个好友就开聊：聊天窗口是独立的小窗，**换个页面也不会关**（只有手动刷新网页才会清掉）。'));
  };

  ChatApp.prototype._renderRoom = function () {
    var self = this;
    var conv = this.roomConv;
    var head = el('div', 'wc-conv-head');
    head.appendChild(el('div', 'wc-conv-name', esc((this.room && this.room.title) || (conv ? conv.title : '本局'))));
    var names = ((this.room && this.room.members) || (conv && conv.members) || [])
      .map(function (m) { return m.self ? '我' : (m.name || m.ip); });
    head.appendChild(el('span', 'wc-sub', names.length + ' 人'));
    paneAppend(this.pane, head);

    var msgs = el('div', 'wc-msgs');
    var list = (conv && conv.list) || [];
    if (!list.length) {
      msgs.appendChild(el('div', 'wc-msg sys', names.length ? ('房间聊天已就绪（' + esc(names.join('、')) + '），说点什么吧') : '房间聊天已就绪，房间里所有人都能看到你的发言'));
    }
    list.forEach(function (m) {
      if (m.sys) { msgs.appendChild(el('div', 'wc-msg sys', esc(m.text))); return; }
      var mine = !!m.mine || m.from === (self.friendsApp() ? self.friendsApp().me : '');
      var d = el('div', 'wc-msg ' + (mine ? 'me' : 'other'));
      if (!mine) d.appendChild(el('div', 'wc-from', esc(m.name || '有人')));
      d.appendChild(el('div', 'wc-text', esc(m.text)));
      d.appendChild(el('div', 'wc-ts', hhmm(m.ts)));
      msgs.appendChild(d);
    });
    paneAppend(this.pane, msgs);

    var ft = el('div', 'wc-input');
    var input = el('input');
    input.type = 'text';
    input.maxLength = 300;
    input.placeholder = '对房间里的人说…（回车发送）';
    var sendBtn = el('button', 'btn tiny primary', '发送');
    ft.appendChild(input); ft.appendChild(sendBtn);
    paneAppend(this.pane, ft);

    function doSend() {
      var text = input.value.trim();
      if (!text || !self.room) return;
      input.value = '';
      self.sendRoom(text);
      msgs.scrollTop = msgs.scrollHeight;
    }
    sendBtn.addEventListener('click', function () { WB.audio.play('click'); doSend(); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSend(); } });
    msgs.scrollTop = msgs.scrollHeight;
    this._focusInput = input;
  };

  function paneAppend(pane, node) { pane.appendChild(node); }

  /* ---------------- 对外动作 ---------------- */
  ChatApp.prototype.openPrivate = function (ip, name) {
    var f = this.friendsApp();
    if (!f || !f.openChat) return null;
    if (this.hidden) this.show();
    var win = f.openChat(ip);                 // 独立小窗（跨页面保留）
    this.privateOpened = ip;
    this.renderBadge();
    this.renderPreview();
    return win;
  };

  ChatApp.prototype.sendRoom = function (text) {
    if (!this.room) return;
    var mid = 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    var f = this.friendsApp();
    var conv = this._ensureRoom(this.room.channel, this.room.title);
    conv.list.push({ from: f ? f.me : '', name: f ? f.me : '我', text: text, ts: Date.now(), mid: mid, mine: true });
    this.lastMsg = { name: '我', text: text, room: true };
    this.roomUnread = 0;
    this.net.send({ t: 'chat.send', channel: this.room.channel, text: text, mid: mid });
    this.renderPane();
    this.renderBadge();
    this.renderPreview();
  };

  ChatApp.prototype.enterRoom = function (info) {
    info = info || {};
    var game = String(info.game || '').trim();
    var code = String(info.code == null ? '' : info.code).trim();
    if (!game || !code) return null;
    var channel = game + ':' + code;
    if (this.room && this.room.channel === channel) return this.roomConv;
    if (this.room) this.leaveRoom();
    this.room = { channel: channel, title: info.title || (game + ' · ' + code), members: [] };
    this.roomConv = { channel: channel, title: this.room.title, list: [], members: [] };
    this.roomUnread = 0;
    this.tab = 'room';
    this.hidden = false;
    this.min = false;
    this.root.classList.remove('gone');
    this.root.classList.remove('min');
    this.ball.classList.add('gone');
    this.net.send({ t: 'chat.join', channel: channel, title: this.room.title });
    this.renderPane();
    this.renderBadge();
    this.renderPreview();
    this.applyPos();          // 展开到本局频道后重新贴边：别让控件跑到屏幕外面
    this.syncDockSide();
    this._saveState();
    WB.ui.toast('房间聊天已开启：本局里所有人可见', 'ok');
    return this.roomConv;
  };

  ChatApp.prototype.leaveRoom = function () {
    if (!this.room) return;
    var channel = this.room.channel;
    this.net.send({ t: 'chat.leave', channel: channel });
    this.room = null;
    this.roomConv = null;
    this.roomUnread = 0;
    this.lastMsg = null;
    if (this.tab === 'room') this.tab = 'friends';
    if (!this.min && !this.hidden) this.renderPane();
    this.renderBadge();
    this.renderPreview();
    this._saveState();
  };

  ChatApp.prototype.openRoom = function () {
    if (!this.room) return null;
    this.tab = 'room';
    this.roomUnread = 0;
    if (this.hidden) this.show();
    if (this.min) this.toggleMin();
    this.renderPane();
    this.renderBadge();
    this._saveState();
    if (this._focusInput) this._focusInput.focus();
    return this.roomConv;
  };

  WB.Chat = Chat;
})(window.WB);
