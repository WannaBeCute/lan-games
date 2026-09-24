'use strict';
/**
 * 机房小游戏服务端 —— 零 npm 依赖（只用 Node 内置模块）
 * 启动: node server/server.js  [--port 8080]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ws = require('./ws');
const TankHub = require('./tank-room');
const GomokuHub = require('./gomoku-room');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------------- 参数 ---------------- */
function readPort() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') return parseInt(argv[i + 1], 10) || 8080;
  }
  return parseInt(process.env.PORT, 10) || 8080;
}
const PORT = readPort();

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function safeResolve(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

function serveStatic(req, res) {
  let file = safeResolve(req.url || '/');
  if (!file) { res.writeHead(403); res.end('403'); return; }

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err2, data) => {
      if (err2) {
        // 单页应用回退：/tank/any → /tank/index.html
        const alt = path.join(path.dirname(file), 'index.html');
        fs.readFile(alt, (e3, d3) => {
          if (e3) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(d3);
        });
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': data.length
      });
      res.end(data);
    });
  });
}

/* ---------------- 客户端注册 ---------------- */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const clients = new Map();
const byInviteCode = new Map();   // 邀请码 → client
let nextClientId = 1;

function inviteCodeFor(ip, salt) {
  const h = crypto.createHash('md5').update('wb-gomoku|' + ip + '|' + salt).digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[h[i] % CODE_ALPHABET.length];
  return s;
}

function assignInviteCode(client) {
  for (let salt = 0; salt < 200; salt++) {
    const code = inviteCodeFor(client.ip, salt);
    if (!byInviteCode.has(code)) {
      client.inviteCode = code;
      byInviteCode.set(code, client);
      return code;
    }
  }
  const code = inviteCodeFor(client.ip, Date.now());
  client.inviteCode = code;
  byInviteCode.set(code, client);
  return code;
}

function send(client, obj) {
  if (!client || !client.conn || client.conn.readyState !== 1) return;
  try { client.conn.send(JSON.stringify(obj)); } catch (e) { /* noop */ }
}

/* ---------------- Hub ---------------- */
const ctx = {
  send,
  clients,
  findByInviteCode: (code) => byInviteCode.get(String(code || '').toUpperCase().trim()) || null,
  listOnline: () => Array.from(clients.values()).map(c => ({ name: c.name, code: c.inviteCode, ip: c.ip }))
};

const tankHub = new TankHub(ctx);
const gomokuHub = new GomokuHub(ctx);

/* ---------------- 消息路由 ---------------- */
function handleMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    /* 通用 */
    case 'ping': send(client, { t: 'pong', ts: msg.ts, now: Date.now() }); return;
    case 'hello':
      if (typeof msg.name === 'string') {
        const next = msg.name.slice(0, 12).trim();
        // 玩家在设置里改了昵称：房间列表 / 对局里的名字都要立刻跟着变
        if (next && next !== client.name) {
          client.name = next;
          tankHub.onRename(client);
          gomokuHub.onRename(client);
        }
      }
      send(client, {
        t: 'hello', id: client.id, name: client.name, ip: client.ip,
        inviteCode: client.inviteCode, serverTime: Date.now()
      });
      return;

    /* 坦克大战 */
    case 'tank.create': tankHub.create(client, msg); return;
    case 'tank.join': tankHub.join(client, msg); return;
    case 'tank.leave': tankHub.leave(client); return;
    case 'tank.config': tankHub.config(client, msg); return;
    case 'tank.ready': tankHub.setReady(client, msg); return;
    case 'tank.bots': tankHub.setBots(client, msg); return;
    case 'tank.rounds': tankHub.setRounds(client, msg); return;
    case 'tank.lives': tankHub.setLives(client, msg); return;
    case 'tank.selfDamage': tankHub.setSelfDamage(client, msg); return;
    case 'tank.powerups': tankHub.setPowerups(client, msg); return;
    case 'tank.start': tankHub.start(client); return;
    case 'tank.input': tankHub.input(client, msg); return;
    case 'tank.teleport': tankHub.teleport(client, msg); return;   // 仅测试（WB_TEST_HOOKS=1）
    case 'tank.rematch': tankHub.rematch(client); return;

    /* 五子棋 */
    case 'gomoku.register': gomokuHub.register(client); return;
    case 'gomoku.invite': gomokuHub.invite(client, msg); return;
    case 'gomoku.reply': gomokuHub.replyInvite(client, msg); return;
    case 'gomoku.move': gomokuHub.move(client, msg); return;
    case 'gomoku.undo': gomokuHub.undo(client); return;
    case 'gomoku.hover': gomokuHub.hover(client, msg); return;
    case 'gomoku.resign': gomokuHub.resign(client); return;
    case 'gomoku.leave': gomokuHub.leave(client); return;
    default: return;
  }
}

/* ---------------- 服务器 ---------------- */
const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      online: clients.size,
      tankRooms: tankHub.roomCount(),
      gomokuMatches: gomokuHub.matchCount(),
      uptime: Math.round(process.uptime()),
      port: PORT,
      urls: LAN_URLS,
      addresses: LAN
    }));
    return;
  }
  serveStatic(req, res);
});

ws.attach(server, (conn, req) => {
  const id = nextClientId++;
  const client = {
    id,
    conn,
    ip: conn.ip,
    name: '玩家' + id,
    inviteCode: '',
    room: null,
    match: null
  };
  assignInviteCode(client);
  clients.set(id, client);

  send(client, {
    t: 'hello', id, name: client.name, ip: client.ip,
    inviteCode: client.inviteCode, serverTime: Date.now()
  });

  conn.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    try { handleMessage(client, msg); } catch (e) {
      console.error('[msg error]', msg && msg.t, e.message);
    }
  });

  conn.on('close', () => {
    clients.delete(id);
    if (client.inviteCode) byInviteCode.delete(client.inviteCode);
    try { tankHub.onClose(client); } catch (e) { /* noop */ }
    try { gomokuHub.onClose(client); } catch (e) { /* noop */ }
  });
});

/* ---------------- 主循环（60Hz 权威模拟） ---------------- */
const STEP = 1 / 60;
let last = Date.now();
let acc = 0;
setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard++ < 8) {
    tankHub.step(STEP);
    acc -= STEP;
  }
  tankHub.broadcast(dt);
}, 8);

/* 心跳 */
setInterval(() => {
  clients.forEach((c) => {
    if (c.conn.readyState !== 1) return;
    if (!c.conn.isAlive) { c.conn.close(1001, 'timeout'); return; }
    c.conn.isAlive = false;
    c.conn.ping();
  });
}, 20000).unref();

/* ---------------- 启动 ---------------- */
/** 列出可用于「给别的电脑访问」的局域网地址，过滤掉虚拟机/WSL 等虚拟网卡 */
const VIRTUAL_RE = /(vmware|virtualbox|hyper-?v|vethernet|wsl|docker|loopback|tap|tun\b|bluetooth|radmin|zerotier|tailscale|npcap|virtual)/i;

function lanAddresses() {
  const all = [], real = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((ni) => {
      if (ni.family !== 'IPv4' || ni.internal) return;
      if (/^169\.254\./.test(ni.address)) return;      // APIPA 自动地址，不通
      const item = { name, address: ni.address };
      all.push(item);
      if (!VIRTUAL_RE.test(name)) real.push(item);
    });
  });
  return real.length ? real : all;
}

const LAN = lanAddresses();
const LAN_URLS = LAN.map(a => 'http://' + a.address + ':' + PORT);

server.listen(PORT, '0.0.0.0', () => {
  const line = '='.repeat(64);
  console.log(line);
  console.log('  机房小游戏服务器已启动     坦克大战  +  五子棋');
  console.log(line);
  console.log('');
  console.log('  【本机打开】  http://localhost:' + PORT);
  console.log('');
  if (LAN.length) {
    console.log('  【让别的电脑访问下面这个地址】');
    LAN.forEach(a => console.log('      ' + ('http://' + a.address + ':' + PORT).padEnd(34) + '(' + a.name + ')'));
  } else {
    console.log('  【提示】没有检测到局域网 IP，请确认本机已连接机房网络/网线。');
  }
  console.log('');
  console.log('  游戏入口：  /tank/  坦克大战        /gomoku/  五子棋');
  console.log('  关闭本窗口 或按 Ctrl+C 即可停止服务');
  console.log('');
  console.log('  别的电脑打不开？99% 是 Windows 防火墙拦了入站端口：');
  console.log('      右键「开放防火墙端口.bat」→ 以管理员身份运行，然后重试。');
  console.log(line);
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
