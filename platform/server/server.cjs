'use strict';
/**
 * 机房小游戏 —— 平台主机（零 npm 依赖，只用 Node 内置模块）
 *
 * 主机只做四件事，**不含任何游戏规则**：
 *   1) 提供静态资源（主页 + 各游戏的客户端）
 *   2) 装配 WebSocket，把消息按各游戏"自己声明"的路由分发过去
 *   3) 驱动各游戏模块的 tick（有 step/broadcast 的才跑）
 *   4) 好友系统（friends.cjs）：好友关系 / 邀请 / 聊天 / 组队邀请，所有游戏通用
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
const Friends = require('./friends.cjs');

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
  // 盐值保持中性：这里属于平台层，不该出现任何具体游戏的名字
  const h = crypto.createHash('md5').update('wb-lan-game|' + ip + '|' + salt).digest();
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

const games = [];                       // [{ name, title, entry, order, card, hub }]
const routes = new Map();               // 消息类型 → (client, msg) => void
const routeOwner = new Map();           // 消息类型 → 注册它的游戏目录名
const routeConflicts = [];              // 同名消息被两个游戏抢（记录后保留先注册的）
const gameWarnings = [];                // 契约上的问题：不致命，但会让"加游戏的人"踩坑

/*
 * 平台层自己的消息路由：好友系统（所有游戏通用，身份以 IP 为单位）。
 * 先于游戏注册 —— 万一哪个游戏也用了 friends. 前缀，下面的冲突机制会当面指出。
 */
const friends = new Friends(ctx);
for (const type of Object.keys(Friends.routes)) {
  const method = Friends.routes[type];
  routes.set(type, (client, msg) => friends[method](client, msg));
  routeOwner.set(type, 'platform(好友系统)');
}
console.log('[platform] 已装配好友系统（' + Object.keys(Friends.routes).length + ' 条消息路由，好友数据所有游戏通用）');

/** 目录名会直接变成 URL 前缀，撞上平台保留路径会让静态挂载互相遮蔽 */
const RESERVED_NAMES = new Set(['shared', 'api', 'platform', 'games', 'tools']);

for (const mod of loadGameModules()) {
  const hub = new mod.Hub(ctx);
  const title = mod.Hub.title || mod.name;
  const entry = mod.Hub.entry || ('/' + mod.name + '/');
  const card = (mod.Hub.card && typeof mod.Hub.card === 'object') ? mod.Hub.card : null;
  const order = Number.isFinite(mod.Hub.order) ? mod.Hub.order : 100;
  games.push({ name: mod.name, title, entry, order, card, hub });

  const warn = (msg) => {
    gameWarnings.push({ game: mod.name, msg: msg });
    console.warn('[game warn] ' + mod.name + '：' + msg);
  };
  if (RESERVED_NAMES.has(mod.name)) warn('目录名与平台保留路径同名，静态资源会被遮蔽，请换一个名字');
  if (!mod.Hub.title) warn('没有声明 Hub.title，主页与日志会显示英文目录名');
  if (entry !== '/' + mod.name + '/') warn('Hub.entry（' + entry + '）与目录名不一致，主页链接可能指向不存在的前缀');
  if (!card) warn('没有声明 Hub.card，主页上这张卡片会缺简介与标签');
  if (card && Array.isArray(card.links) && cardLinks({ card: card }).length < card.links.length) {
    warn('Hub.card.links 里有被丢掉的项：只允许站内相对路径（以 / 开头）且要有 label，最多 3 个');
  }

  const map = mod.Hub.routes || {};
  let wired = 0;
  for (const type of Object.keys(map)) {
    const method = map[type];
    if (typeof hub[method] !== 'function') {
      console.error('[route skip]', type, '→', method, '不存在');
      continue;
    }
    /*
     * 一个消息类型只能有一个主人。这里以前是无声覆盖：后装配的游戏会把先装配的挤掉，
     * 启动日志看不出任何异常 —— 多人协作时两个人各写一个游戏、恰好用了同一个前缀，
     * 就会变成"我的游戏突然收不到消息了"。现在显式报告，并保留先注册的那个。
     */
    const owner = routeOwner.get(type);
    if (owner) {
      routeConflicts.push({ type: type, kept: owner, skipped: mod.name });
      console.error('[route conflict] ' + type + ' 已被「' + owner + '」注册，'
        + '已跳过「' + mod.name + '」的同名路由（两个游戏请各用自己的名字做前缀）');
      continue;
    }
    routeOwner.set(type, mod.name);
    routes.set(type, (client, msg) => hub[method](client, msg));
    wired++;
  }
  console.log('[game] 已装配 ' + title + '  (' + wired + ' 条消息路由)');
}

/* 消息前缀也不该两个游戏共用：类型虽不撞，语义已经混在一起，早晚出事 */
const prefixOwner = new Map();          // 消息前缀 → 游戏目录名
for (const [type, owner] of routeOwner) {
  const prefix = String(type).split('.')[0];
  const prev = prefixOwner.get(prefix);
  if (!prev) { prefixOwner.set(prefix, owner); continue; }
  if (prev === owner) continue;
  if (gameWarnings.some(w => w.game === owner && w.msg.indexOf('消息前缀') === 0)) continue;
  gameWarnings.push({ game: owner, msg: '消息前缀 "' + prefix + '.*" 已被「' + prev + '」使用' });
  console.warn('[game warn] ' + owner + '：消息前缀 "' + prefix + '.*" 已被「' + prev + '」使用，两个游戏共用前缀迟早会撞');
}

/* 主页卡片顺序由游戏自己声明（Hub.order），平台不写死任何游戏名 */
games.sort((a, b) => (a.order - b.order) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** 卡片插画：以 / 开头当绝对路径，否则相对自己的 entry */
function cardArtUrl(g) {
  const art = g.card && g.card.art;
  if (!art) return '';
  return art.charAt(0) === '/' ? art : (g.entry + art);
}

/**
 * 卡片上的「附属入口」：像方块躲避的关卡编辑器这种"游戏的第二个页面"，
 * 由游戏自己声明（Hub.card.links），主页照着渲染，平台照旧不认识任何具体游戏名。
 *
 * 为什么要白名单校验：卡片是给全班同学点的，不能让某个游戏在主页上挂个站外链接把人带走。
 * 所以只收站内相对路径（/ 开头、且不是 //host），标签当纯文本、限长，最多 3 个。
 */
function cardLinks(g) {
  const raw = (g.card && Array.isArray(g.card.links)) ? g.card.links : [];
  const out = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const href = typeof it.href === 'string' ? it.href.trim() : '';
    const label = typeof it.label === 'string' ? it.label.trim().slice(0, 12) : '';
    if (!label || !href) continue;
    if (href.charAt(0) !== '/' || href.charAt(1) === '/') continue;   // 只允许站内路径，挡住 http:// 与协议相对写法
    out.push({ label, href, icon: typeof it.icon === 'string' ? it.icon.slice(0, 2) : '' });
    if (out.length >= 3) break;
  }
  return out;
}

// 游戏都发现了，据此生成静态挂载点（每个游戏的 client/ 与 shared/）
MOUNTS = buildMounts();

/*
 * 装配完就把问题摆到台面上。这些都不致命（服务照样起得来），
 * 但正是多人协作时最费时间的那类问题：一个人改了、另一个人莫名其妙地坏了。
 */
if (routeConflicts.length) {
  console.error('');
  console.error('[!] 有 ' + routeConflicts.length + ' 条消息被两个游戏重复注册（先注册的生效）：');
  routeConflicts.forEach(c => console.error('      ' + c.type + '  →  ' + c.kept + ' 生效，' + c.skipped + ' 未生效'));
  console.error('    改法：每个游戏只用自己的名字做消息前缀，例如 ' + routeConflicts[0].skipped + '.xxx');
  console.error('');
}

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
    friends.onHello(client);   // 好友系统：登记在线状态并下发全量好友数据
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
      /*
       * 主页就拿这个列表渲染卡片 —— 所以「新增游戏 = 新建一个文件夹」是真的，
       * 不需要谁回来手改 platform/web/index.html。
       */
      games: games.map(g => ({
        name: g.name,
        title: g.title,
        entry: g.entry,
        desc: (g.card && g.card.desc) || '',
        tags: (g.card && Array.isArray(g.card.tags)) ? g.card.tags : [],
        art: cardArtUrl(g),
        links: cardLinks(g)              // 游戏的"第二个页面"（如关卡编辑器），没有就是空数组
      })),
      routeConflicts: routeConflicts,     // 非空说明有游戏消息撞车了，测试脚本会断言它为空
      gameWarnings: gameWarnings
    }, friends.stats(), stats)));
    return;
  }
  serveStatic(req, res);
});

/* ---------------- WebSocket ---------------- */
ws.attach(server, (conn, req) => {
  const id = nextClientId++;
  /*
   * 仅测试钩子（WB_TEST_HOOKS=1 才生效）：允许用 ?fip= 覆盖 perceived IP。
   * 好友身份以 IP 为单位，好友自检要在同一台电脑上模拟多台机器，
   * 而沙箱/机房环境往往禁止连接 127.0.0.2 等地址 —— 与 tank.teleport 同一思路。
   * 正式服无视该参数，IP 一律取真实 socket 对端地址。
   */
  let ip = conn.ip;
  if (process.env.WB_TEST_HOOKS) {
    const m = /(?:\?|&)fip=(\d{1,3}(?:\.\d{1,3}){3})/.exec(req.url || '');
    if (m) ip = m[1];
  }
  const client = {
    id,
    conn,
    ip,
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
    friends.onClose(client);
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
