'use strict';
/**
 * 极简 WebSocket 服务端（RFC6455），仅依赖 Node 内置模块。
 * 支持：文本帧、分片、ping/pong、close、掩码解码。
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 21; // 2MB

function acceptValue(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WSConn extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this._buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this._fragOp = 0;
    this._fragParts = [];
    this.readyState = 1;
    this.isAlive = true;
    this.ip = (socket.remoteAddress || '').replace(/^::ffff:/, '');

    try { socket.setNoDelay(true); } catch (e) { /* noop */ }

    socket.on('data', (chunk) => {
      this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
      this._parse();
    });
    socket.on('close', () => this._teardown());
    socket.on('end', () => this._teardown());
    socket.on('error', () => { this._teardown(); });

    if (this._buf.length) this._parse();
  }

  get buffered() { return this.socket.writableLength || 0; }

  _teardown() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  _parse() {
    try {
      while (this._parseFrame()) { /* keep going */ }
    } catch (e) {
      this.close(1002, 'protocol');
    }
  }

  /** @returns {boolean} 是否消费了一帧 */
  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;

    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;

    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) throw new Error('too big');
      len = Number(big); off = 10;
    }
    if (len > MAX_PAYLOAD) throw new Error('too big');

    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return false;

    let payload = buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    } else {
      payload = Buffer.from(payload);
    }
    this._buf = buf.subarray(off + maskLen + len);

    // 控制帧
    if (opcode === 0x08) { this.close(1000, ''); return true; }
    if (opcode === 0x09) { this._frame(0x0A, payload); return true; }
    if (opcode === 0x0A) { this.isAlive = true; return true; }

    if (opcode === 0x00) {
      if (!this._fragOp) throw new Error('unexpected continuation');
      this._fragParts.push(payload);
    } else {
      if (this._fragOp) throw new Error('nested fragment');
      this._fragOp = opcode;
      this._fragParts = [payload];
    }
    if (!fin) return true;

    const data = Buffer.concat(this._fragParts);
    const op = this._fragOp;
    this._fragOp = 0; this._fragParts = [];

    if (op === 0x01) this.emit('message', data.toString('utf8'));
    else if (op === 0x02) this.emit('binary', data);
    return true;
  }

  _frame(opcode, payload) {
    if (this.readyState === 3 || !this.socket.writable) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { this._teardown(); }
  }

  send(data) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this._frame(0x01, payload);
  }

  ping() { this._frame(0x09, Buffer.alloc(0)); }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    try {
      const b = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
      b.writeUInt16BE(code, 0);
      b.write(reason, 2, 'utf8');
      this._frame(0x08, b);
      this.socket.end();
    } catch (e) { /* noop */ }
    this.readyState = 2;
  }
}

/**
 * 给 http.Server 挂载 WebSocket 能力
 * @param {import('http').Server} server
 * @param {(conn: WSConn, req: import('http').IncomingMessage) => void} onConn
 */
function attach(server, onConn) {
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = (req.headers['upgrade'] || '').toLowerCase();
    if (!key || upgrade !== 'websocket') {
      socket.destroy();
      return;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + acceptValue(key)
    ];
    socket.write(headers.join('\r\n') + '\r\n\r\n');
    const conn = new WSConn(socket, head);
    onConn(conn, req);
  });
}

module.exports = { attach, WSConn, acceptValue };
