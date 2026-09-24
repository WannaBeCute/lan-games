/*!
 * 网络层：WebSocket 客户端（自动重连 / RTT 统计 / 消息分发）
 */
window.WB = window.WB || {};
(function (WB) {
  'use strict';

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function Net(opts) {
    opts = opts || {};
    var self = this;
    this.url = opts.url || wsUrl();
    this.handlers = {};
    this.queue = [];
    this.ws = null;
    this.status = 'closed';
    this.id = 0;
    this.inviteCode = '';
    this.ip = '';
    this.rtt = 0;
    this.retry = 0;
    this.manualClose = false;
    this.pingTimer = null;

    this.on = function (type, fn) {
      (self.handlers[type] = self.handlers[type] || []).push(fn);
      return self;
    };
    this.emit = function (type, data) {
      (self.handlers[type] || []).forEach(function (fn) {
        try { fn(data); } catch (e) { console.error('[net handler]', type, e); }
      });
    };
    this._setStatus = function (s) {
      if (self.status === s) return;
      self.status = s;
      self.emit('status', s);
    };
  }

  Net.prototype.connect = function () {
    var self = this;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.manualClose = false;
    this._setStatus('connecting');
    var ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._setStatus('closed'); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      self.retry = 0;
      self._setStatus('open');
      self.send({ t: 'hello', name: WB.playerName() });
      var q = self.queue; self.queue = [];
      q.forEach(function (m) { self.send(m); });
      if (self.pingTimer) clearInterval(self.pingTimer);
      self.pingTimer = setInterval(function () { self.send({ t: 'ping', ts: Date.now() }); }, 2000);
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'pong') {
        self.rtt = Date.now() - msg.ts;
        self.emit('rtt', self.rtt);
        return;
      }
      if (msg.t === 'hello') {
        self.id = msg.id; self.inviteCode = msg.inviteCode; self.ip = msg.ip;
        self.emit('hello', msg);
      }
      self.emit(msg.t, msg);
      self.emit('*', msg);
    };

    ws.onclose = function () {
      self._setStatus('closed');
      if (self.pingTimer) { clearInterval(self.pingTimer); self.pingTimer = null; }
      if (self.manualClose) return;
      self.retry++;
      var delay = Math.min(500 * self.retry, 4000);
      setTimeout(function () { if (!self.manualClose) self.connect(); }, delay);
    };
    ws.onerror = function () { /* onclose 会接管 */ };
  };

  Net.prototype.send = function (obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    } else if (obj.t !== 'ping' && obj.t !== 'tank.input' && obj.t !== 'gomoku.hover') {
      // 预览/输入这类瞬时消息断线后没有补发的意义，不进重连队列
      if (this.queue.length < 40) this.queue.push(obj);
      this.connect();
    }
  };

  Net.prototype.close = function () {
    this.manualClose = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  };

  WB.Net = Net;

  /** 顶栏连接状态徽标 */
  WB.bindNetBadge = function (el, net) {
    function render() {
      if (!el) return;
      var map = { open: ['已连接', 'ok'], connecting: ['连接中…', 'wait'], closed: ['已断开', 'bad'] };
      var s = map[net.status] || map.closed;
      el.textContent = s[0] + (net.rtt ? ' · ' + net.rtt + 'ms' : '');
      el.className = 'net-badge ' + s[1];
      el.title = net.id ? ('我的邀请码: ' + net.inviteCode + '   IP: ' + net.ip) : '';
    }
    net.on('status', render);
    net.on('hello', render);
    net.on('rtt', render);
    render();
  };
})(window.WB);
