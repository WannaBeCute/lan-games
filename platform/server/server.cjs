'use strict';
/**
 * 机房小游戏 —— 平台主机（零 npm 依赖，只用 Node 内置模块）
 *
 * 主机只做三件事，**不含任何游戏规则**：
 *   1) 提供静态资源（主页 + 各游戏的客户端）
 *   2) 装配 WebSocket，把消息按各游戏"自己声明"的路由分发过去
 *   3) 驱动各游戏模块的 tick（有 step/broadcast 的才跑）
 *
 * 具体玩法都在 games/<名字>/ 里。新增一个游戏 = 新建一个文件夹，
 * 主机自动发现，不用回来改这个文件。
 *
 * 启动: node platform/server/server.cjs [--port 8080]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ws = require('./ws');

const ROOT = path.resolve(__dirname, '..', '..');            // 仓库根
const WEB_DIR = path.join(ROOT, 'platform', 'web');          // 平台前端（主页 + 通用库）
const GAMES_DIR = path.join(ROOT, 'games');                  // 各游戏模块

/* ---------------- 参数 ---------------- */
function readPort() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') return parseInt(argv[i + 1], 10) || 8080;
  }
  return parseInt(process.env.PORT, 10) || 8080;
}
const PORT = readPort();

/* ============================================================
 *  静态资源：多个根，按 URL 前缀挂载（前缀长的优先）
 *    /shared/*           平台通用库与样式（platform/web/shared）
 *    /                   平台主页（platform/web）
 *    /<游戏名>/*         该游戏客户端（games/<名>/client）
 *    /<游戏名>/shared/*  该游戏内核（games/<名>/shared，存在才挂）
 *  游戏挂载点由 buildMounts() 在发现游戏后自动补上 —— 所以"加一个游戏"
 *  只需要在 games/ 下新建文件夹，这里不用改。
 * ============================================================ */
const PLATFORM_MOUNTS = [
  { prefix: '/shared/', dir: path.join(WEB_DIR, 'shared') },
  { prefix: '/', dir: WEB_DIR }
];

let MOUNTS = [];                  // 由 buildMounts() 在发现游戏后填充

/** 平台挂载点 + 每个游戏各自的挂载点（长前缀优先匹配） */
function buildMounts() {
  const list = PLATFORM_MOUNTS.slice();
  for (const g of games) {
    const sharedDir = path.join(GAMES_DIR, g.name, 'shared');
    if (fs.existsSync(sharedDir)) list.push({ prefix: '/' + g.name + '/shared/', dir: sharedDir });
    list.push({ prefix: '/' + g.name + '/', dir: path.join(GAMES_DIR, g.name, 'client') });
  }
  return list.sort((a, b) => b.prefix.length - a.prefix.length);
}

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

/** 把一个 URL 映射到磁盘文件；不在任何挂载点内 → null */
function mapToFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.charAt(0) !== '/') p = '/' + p;

  let hit = null;
  for (let i = 0; i < MOUNTS.length; i++) {
    const m = MOUNTS[i];
    if (p === m.prefix.slice(0, -1) || p.indexOf(m.prefix) === 0) { hit = m; break; }
  }
  if (!hit) return null;

  let rest = p.slice(hit.prefix.length);
  if (p === hit.prefix.slice(0, -1)) rest = '';   // 访问 "/tank" 也当作 "/tank/"
  if (rest === '' || rest.charAt(rest.length - 1) === '/') rest += 'index.html';

  const full = path.normalize(path.join(hit.dir, rest));
  if (full !== hit.dir && full.indexOf(hit.dir + path.sep) !== 0) return null;   // 防目录穿越
  return full;
}

function serveStatic(req, res) {
  const file = mapToFile(req.url || '/');
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

const ctx = {
  send,
  clients,
  findByInviteCode: (code) => byInviteCode.get(String(code || '').toUpperCase().trim()) || null,
  listOnline: () => Array.from(clients.values()).map(c => ({ name: c.name, code: c.inviteCode, ip: c.ip }))
};

/* ============================================================
 *  装配各游戏模块（自动发现 games/<名字>/server/room.js）
 *  模块约定（都可选，有就用，没有就跳过）：
 *    Hub.routes  : { 消息类型: Hub 方法名 }
 *    Hub.title   : 显示名
 *    Hub.entry   : 访问入口（如 /tank/）
 *    hub.stats() : 给 /api/status 的统计
 *    hub.onClose(client) / hub.onRename(client) : 生命周期钩子
 *    hub.step(dt) / hub.broadcast(dt)          : 需要按帧推进的游戏才实现
 * ============================================================ */
function loadGameModules() {
  let names = [];
  try {
    names = fs.readdirSync(GAMES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) { names = []; }

  const mods = [];
  for (const name of names) {
    const entry = path.join(GAMES_DIR, name, 'server', 'room.js');
    if (!fs.existsSync(entry)) continue;
    try {
      mods.push({ name, Hub: require(entry) });
    } catch (e) {
      console.error('[game load failed]', name, e.message);
    }
  }
  return mods;
}

const games = [];                       // [{ name, title, entry, hub }]
const routes = new Map();               // 消息类型 → (client, msg) => void

for (const mod of loadGameModules()) {
  const hub = new mod.Hub(ctx);
  const title = mod.Hub.title || mod.name;
  const entry = mod.Hub.entry || ('/' + mod.name + '/');
  games.push({ name: mod.name, title, entry, hub });

  const map = mod.Hub.routes || {};
  for (const type of Object.keys(map)) {
    const method = map[type];
    if (typeof hub[method] !== 'function') {
      console.error('[route skip]', type, '→', method, '不存在');
      continue;
    }
    routes.set(type, (client, msg) => hub[method](client, msg));
  }
  console.log('[game] 已装配 ' + title + '  (' + Object.keys(map).length + ' 条消息路由)');
}

// 游戏都发现了，据此生成静态挂载点（每个游戏的 client/ 与 shared/）
MOUNTS = buildMounts();

/* ---------------- 消息处理（通用部分 + 各游戏路由） ---------------- */
function eachHub(fn) {
  for (const g of games) { try { fn(g.hub, g); } catch (e) { console.error('[' + g.name + ']', e.message); } }
}

function handleMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;

  /* 通用：心跳 */
  if (msg.t === 'ping') { send(client, { t: 'pong', ts: msg.ts, now: Date.now() }); return; }

  /* 通用：握手 / 改名（改名要通知每个游戏刷新显示名） */
  if (msg.t === 'hello') {
    if (typeof msg.name === 'string') {
      const next = msg.name.slice(0, 12).trim();
      if (next && next !== client.name) {
        client.name = next;
        eachHub((hub) => { if (hub.onRename) hub.onRename(client); });
      }
    }
    send(client, {
      t: 'hello', id: client.id, name: client.name, ip: client.ip,
      inviteCode: client.inviteCode, serverTime: Date.now()
    });
    return;
  }

  /* 其余交给「游戏自己声明的路由」 */
  const fn = routes.get(msg.t);
  if (fn) fn(client, msg);
}

/* ---------------- HTTP 服务器 ---------------- */
const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/status')) {
    const stats = {};
    eachHub((hub) => { if (hub.stats) Object.assign(stats, hub.stats()); });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(Object.assign({
      online: clients.size,
      uptime: Math.round(process.uptime()),
      port: PORT,
      urls: LAN_URLS,
      addresses: LAN,
      games: games.map(g => ({ name: g.name, title: g.title, entry: g.entry }))
    }, stats)));
    return;
  }
  serveStatic(req, res);
});

/* ---------------- WebSocket ---------------- */
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
    eachHub((hub) => { if (hub.onClose) hub.onClose(client); });
  });
});

/* ---------------- 主循环：只驱动"需要按帧推进"的游戏（目前只有坦克） ---------------- */
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
    eachHub((hub) => { if (hub.step) hub.step(STEP); });
    acc -= STEP;
  }
  eachHub((hub) => { if (hub.broadcast) hub.broadcast(dt); });
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
  console.log('  机房小游戏服务器已启动     ' + games.map(g => g.title).join('  +  '));
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
  console.log('  游戏入口（主页里也能点）：');
  games.forEach(g => console.log('      ' + String(g.entry).padEnd(12) + g.title));
  console.log('  关闭本窗口 或按 Ctrl+C 即可停止服务');
  console.log('');
  console.log('  别的电脑打不开？99% 是 Windows 防火墙拦了入站端口：');
  console.log('      右键「开放防火墙端口.bat」→ 以管理员身份运行，然后重试。');
  console.log(line);
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
