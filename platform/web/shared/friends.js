/*!
 * 好友系统（平台层，所有游戏通用）
 * 依赖：core.js（WB.util / WB.ui / WB.audio）、net.js（WB.Net）
 *
 * 每个页面只需要：
 *   1) index.html 里引入 /shared/friends.css 与 /shared/friends.js
 *   2) 脚本里调用 WB.Friends.boot(net)
 *   3) （游戏页面可选）WB.Friends.registerGame({...}) 登记组队邀请能力
 *
 * 顶栏会出现「👥 好友」按钮：在线人员（显示完整 IP）→ 加好友 →
 * 对方左下角弹出邀请 → 接受后成为好友 → 可直接组队 / 聊天，无需邀请码。
 */
window.WB = window.WB || {};
(function (WB) {
  'use strict';

  var util = WB.util;
  function el(tag, cls, html) { return util.el(tag, cls, html); }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return util.esc(s); }

  var LS_UNREAD = 'wb.friends.unread.v1';   // 各好友的未读数（本机浏览器）
  var SS_OPEN = 'wb.friends.openchats.v1';  // 还开着的私聊小窗（跨页面保留；手动刷新网页才清掉）
  var POP_TTL = 60000;                      // 左下角弹窗 60 秒自动消失
  var MAX_POPUPS = 3;                       // 同时最多堆 3 个弹窗，再多挤掉最旧的

  function loadUnread() {
    try { return JSON.parse(localStorage.getItem(LS_UNREAD) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveUnread(u) {
    try { localStorage.setItem(LS_UNREAD, JSON.stringify(u)); } catch (e) { /* noop */ }
  }
  /** 这次加载是「点链接换页面」还是「手动刷新」——换页面要接着开着的小窗，刷新则重新开始 */
  function isManualReload() {
    try {
      var list = performance.getEntriesByType ? performance.getEntriesByType('navigation') : [];
      var n = list && list[0];
      return !!(n && n.type === 'reload');
    } catch (e) { return false; }
  }
  function loadOpenChats() {
    try { return JSON.parse(sessionStorage.getItem(SS_OPEN) || '[]') || []; } catch (e) { return []; }
  }
  function saveOpenChats(list) {
    try { sessionStorage.setItem(SS_OPEN, JSON.stringify(list)); } catch (e) { /* noop */ }
  }

  /* ================= 游戏注册表 =================
   * 每个游戏页面启动时登记自己，好友系统因此保持「不认识任何游戏」：
   *   WB.Friends.registerGame({
   *     name: 'tank',                              // 游戏标识（随组队邀请发给对方）
   *     label: '坦克大战',                         // 显示名
   *     entry: '/tank/',                          // 受邀方不在这个页面时的跳转地址
   *     param: 'join',                            // 跳转时带的参数名
   *     canInvite: function () {                  // 现在能不能发邀请 → { data, text }
   *       return S.room ? { data: { room: S.room.code }, text: '房间 ' + S.room.code } : null;
   *     },
   *     accept: function (data) {                 // 受邀方就在这个页面 → 直接入座
   *       NET.send({ t: 'tank.join', code: data.room });
   *     }
   *   });
   */
  var gameRegistry = {};

  var Friends = {
    registerGame: function (g) {
      if (g && g.name) gameRegistry[g.name] = g;
    },
    boot: function (net) {
      var app = new FriendApp(net);
      app.mount();
      WB.friends = app;
      return app;
    }
  };

  /* ================= 应用主体 ================= */
  function FriendApp(net) {
    this.net = net;
    this.me = '';
    this.online = [];      // 除我以外的在线者 [{ip,name,friend,requested}]
    this.friends = [];     // 好友 [{ip,name,online,code}]
    this.requests = [];    // 收到的好友邀请 [{ip,name,ts}]
    this.histories = {};   // ip -> [msg]
    this.rendered = {};    // ip -> {mid:true} 已渲染的消息（回显去重）
    this.chatWins = {};    // ip -> 聊天小窗实例
    this.unread = loadUnread();
    this.pops = [];        // 活跃弹窗
    this.panelOpen = false;
    this.tab = 'online';
    // 跨页面保留私聊小窗：点链接换页面时把刚才开着的小窗重新打开；
    // 手动刷新网页（F5 / Ctrl+R）则清空，回到干净状态。
    this._pendingRestore = isManualReload() ? [] : loadOpenChats();
    if (isManualReload()) saveOpenChats([]);
    this._bindNet();
  }

  /** 记一下现在开着哪些私聊小窗（供换页面后恢复） */
  FriendApp.prototype._rememberOpen = function () {
    saveOpenChats(Object.keys(this.chatWins));
  };

  /** 好友列表/未读有变化时，让左下角的聊天控件跟着刷新 */
  FriendApp.prototype._notifyChat = function () {
    if (WB.chat && WB.chat.refreshFromFriends) WB.chat.refreshFromFriends();
  };

  /**
   * 把「上一个页面还开着的私聊小窗」重新打开。
   * 只在拿到最新好友数据之后做一次，所以标题/在线状态都是准的；
   * 换页面（点链接）才恢复，手动刷新网页时列表已被清空，不会自己弹出来。
   */
  FriendApp.prototype._restoreOpenChats = function () {
    var list = this._pendingRestore || [];
    if (!list.length) return;
    this._pendingRestore = [];
    var self = this;
    list.forEach(function (ip) {
      if (!ip || self.chatWins[ip]) return;
      self.openChat(ip, true);      // silent：恢复时不再重新拉一遍历史（openChat 内部会拉）
    });
  };

  FriendApp.prototype.isFriend = function (ip) {
    return this.friends.some(function (f) { return f.ip === ip; });
  };

  FriendApp.prototype.friendName = function (ip) {
    for (var i = 0; i < this.friends.length; i++) if (this.friends[i].ip === ip) return this.friends[i].name;
    for (var j = 0; j < this.online.length; j++) if (this.online[j].ip === ip) return this.online[j].name;
    return ip;
  };

  /* ---------------- 网络消息 ---------------- */
  FriendApp.prototype._bindNet = function () {
    var self = this;
    var net = this.net;

    net.on('friends.state', function (m) {
      self.me = m.me || '';
      self.online = m.online || [];
      self.friends = m.friends || [];
      self.requests = m.requests || [];
      if (self.panelOpen) self.renderBody();
      self.renderBadge();
      // 换页面后把刚才开着的私聊小窗按最新的好友数据重建（标题、在线状态都是新的）
      self._restoreOpenChats();
      self._notifyChat();
    });

    net.on('friends.invited', function (m) { self._onInvited(m); });

    net.on('friends.result', function (m) {
      WB.ui.toast(m.msg || (m.ok ? '操作成功' : '操作失败'), m.ok ? 'ok' : 'err');
      WB.audio.play(m.ok ? 'click' : 'error');
    });

    net.on('friends.presence', function (m) { self._onPresence(m); });

    net.on('friends.chat', function (m) { self._onChat(m); });

    net.on('friends.history', function (m) { self._onHistory(m); });

    net.on('friends.teamInvited', function (m) { self._onTeamInvited(m); });

    net.on('friends.teamResult', function (m) {
      WB.ui.toast(m.name + (m.accept ? ' 接受了你的组队邀请' : ' 拒绝了你的组队邀请'), m.accept ? 'ok' : 'err');
      WB.audio.play(m.accept ? 'go' : 'error');
    });
  };

  /* ---------------- 顶栏按钮 / 停靠区 ---------------- */
  FriendApp.prototype.mount = function () {
    var self = this;
    var host = document.querySelector('.topbar-right') || document.querySelector('.hub-head-right');
    if (host) {
      var btn = el('button', 'btn tiny ghost wb-friends-btn');
      btn.id = 'btnFriends';
      btn.title = '好友（所有游戏通用）';
      var badge = el('span', 'fb-badge hidden');
      badge.id = 'fbBadge';
      badge.textContent = '0';
      btn.appendChild(document.createTextNode('👥 好友'));
      btn.appendChild(badge);
      var settings = document.getElementById('btnSettings');
      if (settings && settings.parentNode === host) host.insertBefore(btn, settings);
      else host.appendChild(btn);
      btn.addEventListener('click', function () { WB.audio.play('click'); self.togglePanel(); });
    }
    this.dock = el('div', 'wb-friends-dock');
    this.dock.id = 'wb-friends-dock';
    document.body.appendChild(this.dock);
    this.renderBadge();
  };

  FriendApp.prototype.renderBadge = function () {
    var badge = $('fbBadge');
    if (!badge) return;
    var n = 0;
    for (var ip in this.unread) n += (this.unread[ip] || 0);
    n += this.requests.length;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n <= 0);
  };

  /* ---------------- 左下角弹窗 ---------------- */
  FriendApp.prototype._popup = function (cls) {
    var self = this;
    var p = el('div', 'fb-pop ' + (cls || ''));
    var x = el('button', 'x', '×');
    x.title = '关闭';
    p.appendChild(x);
    var rec = { node: p, timer: null };
    function close() {
      if (rec.timer) clearTimeout(rec.timer);
      var i = self.pops.indexOf(rec);
      if (i >= 0) self.pops.splice(i, 1);
      if (p.parentNode) p.parentNode.removeChild(p);
    }
    rec.close = close;
    x.addEventListener('click', close);
    rec.timer = setTimeout(close, POP_TTL);
    this.pops.push(rec);
    while (this.pops.length > MAX_POPUPS) this.pops[0].close();
    this.dock.insertBefore(p, this.dock.firstChild);   // 新弹窗放在最上面
    return rec;
  };

  FriendApp.prototype._onInvited = function (m) {
    var self = this;
    WB.audio.play('invite');
    var rec = this._popup('');
    var t = el('div', 't');
    var b = el('b');
    b.textContent = m.name || '有人';
    t.appendChild(document.createTextNode('👋 '));
    t.appendChild(b);
    t.appendChild(document.createTextNode(' 请求加你为好友'));
    var s = el('div', 's');
    s.textContent = 'IP ' + (m.from || '');
    var btns = el('div', 'btns');
    var ok = el('button', 'btn primary', '接受');
    var no = el('button', 'btn ghost', '拒绝');
    ok.addEventListener('click', function () {
      rec.close();
      WB.audio.play('click');
      self.net.send({ t: 'friends.accept', ip: m.from });
    });
    no.addEventListener('click', function () {
      rec.close();
      WB.audio.play('click');
      self.net.send({ t: 'friends.reject', ip: m.from });
    });
    btns.appendChild(ok); btns.appendChild(no);
    rec.node.appendChild(t); rec.node.appendChild(s); rec.node.appendChild(btns);
  };

  FriendApp.prototype._onTeamInvited = function (m) {
    var self = this;
    WB.audio.play('invite');
    var g = gameRegistry[m.game];
    var label = g ? g.label : m.game;
    var rec = this._popup('team');
    var t = el('div', 't');
    var b = el('b');
    b.textContent = m.name || '好友';
    t.appendChild(document.createTextNode('🎮 '));
    t.appendChild(b);
    t.appendChild(document.createTextNode(' 邀请你组队'));
    var s = el('div', 's');
    s.textContent = (label ? label + ' · ' : '') + (m.text || '');
    var btns = el('div', 'btns');
    var ok = el('button', 'btn primary', '接受');
    var no = el('button', 'btn ghost', '拒绝');
    ok.addEventListener('click', function () {
      rec.close();
      WB.audio.play('click');
      self.net.send({ t: 'friends.teamReply', ip: m.from, accept: true });
      // 当前页面就是这个游戏 → 直接入座；否则带上参数跳过去（免输入邀请码）
      if (g && typeof g.accept === 'function') {
        try { g.accept(m.data || {}); return; } catch (e) { /* 落到跳转 */ }
      }
      if (g) {
        location.href = g.entry + '?' + g.param + '=' + encodeURIComponent(JSON.stringify(m.data || {}));
      } else {
        WB.ui.toast('无法识别的游戏：' + m.game, 'err');
      }
    });
    no.addEventListener('click', function () {
      rec.close();
      WB.audio.play('click');
      self.net.send({ t: 'friends.teamReply', ip: m.from, accept: false });
    });
    btns.appendChild(ok); btns.appendChild(no);
    rec.node.appendChild(t); rec.node.appendChild(s); rec.node.appendChild(btns);
  };

  /* ---------------- 好友面板 ---------------- */
  FriendApp.prototype.togglePanel = function () {
    if (this.panelOpen) this.closePanel();
    else this.openPanel();
  };

  FriendApp.prototype.openPanel = function () {
    if (this.panelOpen) return;
    var self = this;
    var mask = el('div', 'wb-mask');
    mask.id = 'wb-friends-mask';
    var dlg = el('div', 'wb-dialog');

    var head = el('div', 'wb-dialog-head');
    var h3 = el('h3', null, '好友');
    var x = el('button', 'wb-x', '×');
    x.setAttribute('data-close', '');
    head.appendChild(h3); head.appendChild(x);

    var tabs = el('div', 'fb-tabs');
    var tabOnline = el('button', 'fb-tab on');
    tabOnline.dataset.tab = 'online';
    tabOnline.appendChild(document.createTextNode('在线人员'));
    var n1 = el('span', 'n'); tabOnline.appendChild(n1);
    var tabFriends = el('button', 'fb-tab');
    tabFriends.dataset.tab = 'friends';
    tabFriends.appendChild(document.createTextNode('我的好友'));
    var n2 = el('span', 'n'); tabFriends.appendChild(n2);
    var hot = el('span', 'hot'); tabFriends.appendChild(hot);
    tabs.appendChild(tabOnline); tabs.appendChild(tabFriends);

    var body = el('div', 'wb-dialog-body');
    body.id = 'fbBody';

    dlg.appendChild(head); dlg.appendChild(tabs); dlg.appendChild(body);
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    this.mask = mask;
    this.panelOpen = true;

    function close() { self.closePanel(); }
    x.addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onEsc, true);
        close();
      }
    }, true);
    // 面板开着时，按键不要漏到游戏里（坦克会把方向键当油门）
    mask.addEventListener('keydown', function (e) { e.stopPropagation(); });
    mask.addEventListener('keyup', function (e) { e.stopPropagation(); });

    tabs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.fb-tab') : null;
      if (!b) return;
      self.tab = b.dataset.tab;
      Array.prototype.forEach.call(tabs.querySelectorAll('.fb-tab'), function (t2) {
        t2.classList.toggle('on', t2 === b);
      });
      WB.audio.play('click');
      self.renderBody();
    });

    // 打开时先拉一次最新全量状态（期间有人上下线也不会漏）
    this.net.send({ t: 'friends.refresh' });
    this.renderBody();
  };

  FriendApp.prototype.closePanel = function () {
    this.panelOpen = false;
    if (this.mask && this.mask.parentNode) this.mask.parentNode.removeChild(this.mask);
    this.mask = null;
  };

  FriendApp.prototype.renderBody = function () {
    var body = $('fbBody');
    if (!body) return;
    var self = this;
    body.textContent = '';

    var tabs = this.mask.querySelectorAll('.fb-tab');
    var nOnline = this.mask.querySelector('[data-tab="online"] .n');
    var nFriend = this.mask.querySelector('[data-tab="friends"] .n');
    var hot = this.mask.querySelector('[data-tab="friends"] .hot');
    if (nOnline) nOnline.textContent = this.online.length ? ' ' + this.online.length : '';
    if (nFriend) nFriend.textContent = this.friends.length ? ' ' + this.friends.length : '';
    if (hot) hot.textContent = this.requests.length ? ' · ' + this.requests.length + ' 个新邀请' : '';
    Array.prototype.forEach.call(tabs, function (t) { t.classList.toggle('on', t.dataset.tab === self.tab); });

    if (this.tab === 'online') this._renderOnline(body);
    else this._renderFriends(body);

    var note = el('p', 'fb-note');
    note.textContent = '好友以「电脑（IP）」为单位：同一台电脑重开页面、换游戏，好友都不会丢；服务端重启后也还在。'
      + '成为好友后即可直接组队、聊天，不用再报邀请码。';
    body.appendChild(note);
  };

  FriendApp.prototype._renderOnline = function (body) {
    var self = this;
    if (!this.online.length) {
      var e = el('div', 'fb-empty', '现在没有其他在线的人。<br>让同学用浏览器打开服务端地址就会出现。');
      body.appendChild(e);
      return;
    }
    var list = el('div', 'fb-list');
    this.online.forEach(function (o) {
      var row = el('div', 'fb-row');
      var dot = el('span', 'dot on');
      var who = el('div', 'who');
      var nm = el('div', 'nm');
      nm.textContent = o.name || '未命名';
      var ip = el('div', 'ip');
      ip.textContent = o.ip || '';
      who.appendChild(nm); who.appendChild(ip);
      var acts = el('div', 'acts');
      if (o.friend) {
        var tag = el('span', 'dim');
        tag.style.fontSize = '12px';
        tag.textContent = '已是好友';
        acts.appendChild(tag);
      } else if (o.requested) {
        var btn2 = el('button', 'btn tiny ghost', '已发邀请');
        btn2.disabled = true;
        acts.appendChild(btn2);
      } else {
        var btn = el('button', 'btn tiny primary', '加好友');
        btn.addEventListener('click', function () {
          WB.audio.play('click');
          self.net.send({ t: 'friends.add', ip: o.ip });
        });
        acts.appendChild(btn);
      }
      row.appendChild(dot); row.appendChild(who); row.appendChild(acts);
      list.appendChild(row);
    });
    body.appendChild(list);
  };

  FriendApp.prototype._renderFriends = function (body) {
    var self = this;

    /* 收到的好友邀请 */
    if (this.requests.length) {
      var st = el('div', 'fb-sec-title');
      st.textContent = '收到的好友邀请（' + this.requests.length + '）';
      body.appendChild(st);
      var rl = el('div', 'fb-list');
      this.requests.forEach(function (r) {
        var row = el('div', 'fb-row req');
        var who = el('div', 'who');
        var nm = el('div', 'nm');
        nm.textContent = r.name || '有人';
        var ip = el('div', 'ip');
        ip.textContent = r.ip || '';
        who.appendChild(nm); who.appendChild(ip);
        var acts = el('div', 'acts');
        var ok = el('button', 'btn tiny primary', '接受');
        var no = el('button', 'btn tiny ghost', '拒绝');
        ok.addEventListener('click', function () {
          WB.audio.play('click');
          self.net.send({ t: 'friends.accept', ip: r.ip });
        });
        no.addEventListener('click', function () {
          WB.audio.play('click');
          self.net.send({ t: 'friends.reject', ip: r.ip });
        });
        acts.appendChild(ok); acts.appendChild(no);
        row.appendChild(who); row.appendChild(acts);
        rl.appendChild(row);
      });
      body.appendChild(rl);
      var gap = el('div');
      gap.style.height = '14px';
      body.appendChild(gap);
    }

    var st2 = el('div', 'fb-sec-title');
    st2.textContent = '我的好友（' + this.friends.length + '）';
    body.appendChild(st2);

    if (!this.friends.length) {
      var e = el('div', 'fb-empty', '还没有好友。<br>切到「在线人员」，点「加好友」邀请同学吧。');
      body.appendChild(e);
      return;
    }

    var list = el('div', 'fb-list');
    this.friends.forEach(function (f) {
      var row = el('div', 'fb-row');
      var dot = el('span', 'dot' + (f.online ? ' on' : ''));
      var who = el('div', 'who');
      var nm = el('div', 'nm');
      nm.textContent = f.name || f.ip;
      var sub = el('div', 'ip');
      sub.textContent = f.ip + (f.online ? '' : ' · 离线');
      who.appendChild(nm); who.appendChild(sub);
      var acts = el('div', 'acts');
      acts.style.position = 'relative';

      var chat = el('button', 'btn tiny ghost', '聊天');
      chat.addEventListener('click', function () {
        WB.audio.play('click');
        self.openChat(f.ip);
      });
      acts.appendChild(chat);

      var team = el('button', 'btn tiny ok', '邀请组队');
      team.addEventListener('click', function () {
        WB.audio.play('click');
        self._teamMenu(team, f.ip);
      });
      acts.appendChild(team);

      var del = el('button', 'btn tiny danger', '删除');
      del.title = '删除好友';
      del.addEventListener('click', function () {
        WB.audio.play('click');
        self.net.send({ t: 'friends.remove', ip: f.ip });
      });
      acts.appendChild(del);

      row.appendChild(dot); row.appendChild(who); row.appendChild(acts);
      list.appendChild(row);
    });
    body.appendChild(list);
  };

  /** 「邀请组队」：汇总当前页面注册过的游戏能提供的邀请，只有一个就直接发 */
  FriendApp.prototype._teamMenu = function (anchor, ip) {
    var self = this;
    var opts = [];
    for (var name in gameRegistry) {
      var g = gameRegistry[name];
      var info = null;
      try { info = g.canInvite && g.canInvite(); } catch (e) { info = null; }
      if (info) opts.push({ g: g, info: info });
    }
    if (!opts.length) {
      WB.ui.toast('当前页面没有可邀请的对局或房间', 'err');
      WB.audio.play('error');
      return;
    }
    function send(g, info) {
      self.net.send({ t: 'friends.team', ip: ip, game: g.name, data: info.data, text: info.text });
    }
    if (opts.length === 1) { send(opts[0].g, opts[0].info); return; }

    // 多个游戏都准备了邀请（罕见）：列出小菜单让人选
    var old = anchor.parentNode.querySelector('.fb-team-menu');
    if (old) { old.parentNode.removeChild(old); return; }
    var menu = el('div', 'fb-team-menu');
    opts.forEach(function (o) {
      var b = el('button', null, (o.g.label || o.g.name) + (o.info.text ? ' · ' + o.info.text : ''));
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (menu.parentNode) menu.parentNode.removeChild(menu);
        send(o.g, o.info);
      });
      menu.appendChild(b);
    });
    anchor.parentNode.appendChild(menu);
    setTimeout(function () {
      document.addEventListener('click', function h() {
        if (menu.parentNode) menu.parentNode.removeChild(menu);
        document.removeEventListener('click', h);
      });
    }, 0);
  };

  /* ---------------- 在线状态 ---------------- */
  FriendApp.prototype._onPresence = function (m) {
    var i = this.online.findIndex(function (o) { return o.ip === m.ip; });
    if (m.online) {
      if (i < 0) {
        this.online.push({
          ip: m.ip, name: m.name || '',
          friend: m.friend !== undefined ? !!m.friend : this.isFriend(m.ip),
          requested: m.requested === true
        });
      } else {
        if (m.name) this.online[i].name = m.name;
        if (m.friend !== undefined) this.online[i].friend = !!m.friend;
        if (m.requested !== undefined) this.online[i].requested = !!m.requested;
      }
    } else if (i >= 0) {
      this.online.splice(i, 1);
    }
    this.friends.forEach(function (f) {
      if (f.ip === m.ip) { f.online = !!m.online; if (m.name) f.name = m.name; }
    });
    var w = this.chatWins[m.ip];
    if (w) w.setStatus(!!m.online);
    if (this.panelOpen) this.renderBody();
    this._notifyChat();
  };

  /* ---------------- 聊天 ---------------- */
  FriendApp.prototype.openChat = function (ip) {
    var self = this;
    if (this.chatWins[ip]) {
      this.chatWins[ip].focus();
      return this.chatWins[ip];
    }
    var name = this.friendName(ip);
    var fr = null;
    for (var i = 0; i < this.friends.length; i++) {
      if (this.friends[i].ip === ip) { fr = this.friends[i]; break; }
    }
    var online = !!(fr && fr.online);

    var root = el('div', 'fb-chat');
    var hd = el('div', 'hd');
    var dot = el('span', 'dot' + (online ? ' on' : ''));
    var nm = el('div', 'nm');
    nm.textContent = name;
    var stt = el('span', 'st');
    stt.textContent = online ? '在线' : '离线';
    var x = el('button', 'x', '×');
    x.title = '关闭聊天';
    hd.appendChild(dot); hd.appendChild(nm); hd.appendChild(stt); hd.appendChild(x);

    var bd = el('div', 'bd');

    var ft = el('div', 'ft');
    var input = el('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = '输入消息，回车发送';
    var sendBtn = el('button', 'btn primary', '发送');
    ft.appendChild(input); ft.appendChild(sendBtn);

    root.appendChild(hd); root.appendChild(bd); root.appendChild(ft);
    this.dock.appendChild(root);   // 聊天小窗固定在停靠区底部

    // 打字时按键不要漏到游戏里（坦克会把 W/方向键当油门）
    root.addEventListener('keydown', function (e) { e.stopPropagation(); });
    root.addEventListener('keyup', function (e) { e.stopPropagation(); });

    var win = {
      ip: ip,
      root: root,
      body: bd,
      input: input,
      focus: function () { input.focus(); },
      close: function () {
        delete self.chatWins[ip];
        if (root.parentNode) root.parentNode.removeChild(root);
        self._rememberOpen();          // 关掉了就别再跨页面恢复了
      },
      setStatus: function (on) {
        dot.classList.toggle('on', !!on);
        stt.textContent = on ? '在线' : '离线';
      },
      sys: function (text) {
        var m = el('div', 'msg sys');
        m.textContent = text;
        bd.appendChild(m);
        bd.scrollTop = bd.scrollHeight;
      },
      bubble: function (mine, text) {
        var m = el('div', 'msg ' + (mine ? 'me' : 'other'));
        m.textContent = text;
        bd.appendChild(m);
        bd.scrollTop = bd.scrollHeight;
      }
    };

    x.addEventListener('click', function () { WB.audio.play('click'); win.close(); });
    function doSend() {
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      self.sendChat(ip, text);
    }
    sendBtn.addEventListener('click', function () { WB.audio.play('click'); doSend(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doSend(); }
    });

    this.chatWins[ip] = win;
    this._markRead(ip);
    this._rememberOpen();
    this._notifyChat();

    var hist = this.histories[ip];
    this.rendered[ip] = {};               // 重开窗口 / 重拉历史时重置去重表，否则旧消息会被跳过
    if (hist && hist.length) {
      hist.forEach(function (m) { self._bubble(win, m); });
    } else {
      win.sys('还没有聊天记录，打个招呼吧');
    }
    // 找服务端要完整记录（含重启前保存的）
    this.net.send({ t: 'friends.history', ip: ip });
    win.focus();
    return win;
  };

  FriendApp.prototype._bubble = function (win, m) {
    if (!this.rendered[win.ip]) this.rendered[win.ip] = {};
    if (m.mid && this.rendered[win.ip][m.mid]) return;   // 回显去重
    if (m.mid) this.rendered[win.ip][m.mid] = true;
    var mine = (m.from === this.me);
    win.bubble(mine, m.text);
  };

  FriendApp.prototype.sendChat = function (ip, text) {
    var mid = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    var msg = { from: this.me, name: '', text: text, ts: Date.now(), mid: mid };
    var win = this.chatWins[ip];
    if (win) this._bubble(win, msg);
    if (!this.histories[ip]) this.histories[ip] = [];
    this.histories[ip].push(msg);
    this.net.send({ t: 'friends.chat', ip: ip, text: text, mid: mid });
  };

  FriendApp.prototype._onChat = function (m) {
    var ip = m.from;
    if (!this.histories[ip]) this.histories[ip] = [];
    this.histories[ip].push({ from: m.from, name: m.name, text: m.text, ts: m.ts, mid: m.mid });
    this._notifyChat();
    var win = this.chatWins[ip];
    if (win) {
      this._bubble(win, m);          // 窗口开着：直接显示（含自己的回显）
      return;
    }
    if (m.self) return;              // 自己的回显，窗口没开就丢了吧（历史里已有）
    // 窗口没开：未读 +1，左下角提示
    this.unread[ip] = (this.unread[ip] || 0) + 1;
    saveUnread(this.unread);
    this.renderBadge();
    var self = this;
    var rec = this._popup('');
    var t = el('div', 't');
    var b = el('b');
    b.textContent = m.name || '好友';
    t.appendChild(document.createTextNode('💬 '));
    t.appendChild(b);
    t.appendChild(document.createTextNode(' 发来一条消息'));
    var s = el('div', 's');
    s.textContent = m.text || '';
    rec.node.appendChild(t); rec.node.appendChild(s);
    // 点弹窗本体（除关闭按钮外）打开聊天小窗
    [t, s].forEach(function (part) {
      part.style.cursor = 'pointer';
      part.addEventListener('click', function () {
        rec.close();
        self.openChat(ip);
      });
    });
    WB.audio.play('invite');
  };

  FriendApp.prototype._onHistory = function (m) {
    var self = this;
    this.histories[m.ip] = (m.list || []).slice();
    var win = this.chatWins[m.ip];
    if (!win) return;
    this.rendered[m.ip] = {};              // 整段重渲染，重置去重表
    win.body.textContent = '';
    if (!this.histories[m.ip].length) {
      win.sys('还没有聊天记录，打个招呼吧');
      return;
    }
    this.histories[m.ip].forEach(function (msg) { self._bubble(win, msg); });
  };

  FriendApp.prototype._markRead = function (ip) {
    this._notifyChat();
    if (!this.unread[ip]) return;
    this.unread[ip] = 0;
    saveUnread(this.unread);
    this.renderBadge();
  };

  WB.Friends = Friends;
})(window.WB);
