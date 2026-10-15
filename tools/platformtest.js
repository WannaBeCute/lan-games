'use strict';
/**
 * 平台级装配自检： node tools/platformtest.js            （自己拉起一个服务端，用临时端口）
 *                   node tools/platformtest.js http://127.0.0.1:8080   （测已运行的服务端）
 *
 * 它不测任何玩法的业务逻辑，只回答一个问题：
 *   「往 games/ 里丢一个新文件夹，平台层真的能自己接住吗？」
 *
 * 静态部分（不需要服务端）：
 *   A. 每个 games/<名>/server/room.js 的契约完整性（title / entry / routes 方法真的存在 / client 页面）
 *   B. 全局唯一性：消息类型不重复、消息前缀不跨游戏共用、目录名不撞平台保留路径
 *   C. 卡片元数据与插画资源（Hub.card.art）真的存在
 * 动态部分：
 *   D. /api/status 报出的 games 与静态扫描结果完全一致 —— 自动发现没漏也没多
 *   E. 每个 entry、每张卡片插画、平台通用库都是 200，且卡片有简介与标签
 *   F. 主页没有写死任何游戏入口 —— 卡片确实是读 /api/status 渲染出来的
 *
 * 这一层测试的意义：加游戏的人（或 AI）跑一遍这个脚本，
 * 就能知道自己是"漏了契约"还是"平台接不住"，不用去猜哪里没生效。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
const GIVEN_BASE = process.argv[2] || '';
/** 和 platform/server/server.cjs 里的 RESERVED_NAMES 保持一致：目录名会变成 URL 前缀 */
const RESERVED_NAMES = ['shared', 'api', 'platform', 'games', 'tools'];

let fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log('  [通过] ' + name + (extra != null ? '  ' + extra : '')); }
  else { fails++; console.log('  [失败] ' + name + '  ' + (extra != null ? extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- 静态扫描：把每个游戏自己声明的契约读出来 ---------------- */
const fakeCtx = {
  send() {},
  clients: new Map(),
  findByInviteCode() { return null; },
  listOnline() { return []; }
};

function gameDirs() {
  let names = [];
  try {
    names = fs.readdirSync(GAMES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch (e) { return []; }
  // 判定条件与主机一致：有 server/room.js 才算一个游戏
  return names.filter(n => fs.existsSync(path.join(GAMES_DIR, n, 'server', 'room.js')));
}

function scan() {
  return gameDirs().map((name) => {
    const dir = path.join(GAMES_DIR, name);
    const file = path.join(dir, 'server', 'room.js');
    try {
      const Hub = require(file);
      let hub = null, hubError = null;
      try { hub = new Hub(fakeCtx); } catch (e) { hubError = e.message; }
      return {
        name, dir, Hub, hub, hubError,
        title: Hub.title, entry: Hub.entry, order: Hub.order,
        hidden: Hub.hidden === true,        // 声明不上主页（入口仍可直连）
        routes: Hub.routes || {}, card: Hub.card || null
      };
    } catch (e) {
      return { name, dir, error: e.message, routes: {}, card: null };
    }
  });
}

/* ---------------- 临时端口 / 拉起服务端 ---------------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER, '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d.toString(); });
  proc.stderr.on('data', (d) => { log += d.toString(); });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + '/api/status');
      if (r.ok) return { proc, base, log: () => log };
    } catch (e) { /* 还没起来 */ }
    await sleep(100);
  }
  try { proc.kill(); } catch (e) { /* noop */ }
  throw new Error('服务端 12 秒内没起来：\n' + log);
}

(async function main() {
  /* ================= A. 契约完整性 ================= */
  console.log('\n== A. 每个游戏的契约 ==');
  const mods = scan();
  ok('games/ 下发现了游戏（至少一个）', mods.length > 0,
    mods.length + ' 个：' + mods.map(m => m.name).join(', '));

  for (const m of mods) {
    if (m.error) { ok('games/' + m.name + '/server/room.js 能被加载', false, m.error); continue; }
    ok(m.name + ' · 声明了 Hub.title', typeof m.title === 'string' && m.title.length > 0, String(m.title));
    ok(m.name + ' · Hub.entry 与目录名一致', m.entry === '/' + m.name + '/', String(m.entry));
    ok(m.name + ' · 有 client/index.html', fs.existsSync(path.join(m.dir, 'client', 'index.html')));
    ok(m.name + ' · Hub 能被实例化', !m.hubError, m.hubError || '');

    const types = Object.keys(m.routes);
    ok(m.name + ' · 声明了 Hub.routes', types.length > 0, types.length + ' 条');
    const broken = m.hub ? types.filter(t => typeof m.hub[m.routes[t]] !== 'function') : [];
    ok(m.name + ' · 每条路由都指向真实存在的方法', broken.length === 0,
      broken.map(t => t + '→' + m.routes[t]).join(', '));

    /* ================= C. 卡片元数据 ================= */
    ok(m.name + ' · 声明了 Hub.card（主页卡片内容）', !!m.card);
    if (m.card) {
      ok(m.name + ' · 卡片有简介', typeof m.card.desc === 'string' && m.card.desc.length > 0);
      ok(m.name + ' · 卡片有标签', Array.isArray(m.card.tags) && m.card.tags.length > 0,
        Array.isArray(m.card.tags) ? m.card.tags.length + ' 个' : typeof m.card.tags);
      if (m.card.art) {
        const art = String(m.card.art);
        const abs = art.charAt(0) === '/' ? path.join(ROOT, art) : path.join(m.dir, 'client', art);
        ok(m.name + ' · 卡片插画 ' + art + ' 存在', fs.existsSync(abs), abs);
      }
    }
  }

  /* ================= B. 全局唯一性 ================= */
  console.log('\n== B. 隔离与唯一性（多人协作最容易撞的地方）==');
  for (const m of mods) {
    ok(m.name + ' · 目录名没撞平台保留路径', RESERVED_NAMES.indexOf(m.name) < 0, m.name);
  }

  const routeOwner = new Map(), dups = [];
  for (const m of mods) {
    for (const t of Object.keys(m.routes)) {
      if (routeOwner.has(t)) dups.push(t + '（' + routeOwner.get(t) + ' 与 ' + m.name + '）');
      else routeOwner.set(t, m.name);
    }
  }
  ok('没有两个游戏注册同一条消息类型', dups.length === 0, dups.join(' / '));

  const prefixOwner = new Map(), shared = [];
  for (const [t, owner] of routeOwner) {
    const prefix = String(t).split('.')[0];
    if (prefixOwner.has(prefix) && prefixOwner.get(prefix) !== owner) {
      if (shared.indexOf(prefix) < 0) shared.push(prefix + '（' + prefixOwner.get(prefix) + ' 与 ' + owner + '）');
    } else if (!prefixOwner.has(prefix)) {
      prefixOwner.set(prefix, owner);
    }
  }
  ok('没有两个游戏共用消息前缀', shared.length === 0, shared.join(' / '));

  /* ================= D~F. 起服务端，看平台是不是真的接住了 ================= */
  console.log('\n== D. 主机自动装配（' + (GIVEN_BASE || '自动拉起服务端') + '）==');
  let proc = null, base = GIVEN_BASE;
  if (!base) {
    const started = await startServer();
    proc = started.proc;
    base = started.base;
    ok('服务端能起来', true, base);
  }

  try {
    const st = await (await fetch(base + '/api/status')).json();
    ok('/api/status 返回 games 列表', Array.isArray(st.games), typeof st.games);

    const apiNames = (st.games || []).map(g => g.name).sort().join(',');
    const dirNames = mods.map(m => m.name).sort().join(',');
    /*
     * 主页列表 = games/ 下的目录 **减去** 声明了 Hub.hidden 的游戏。
     * hidden 只是"先不上主页"（还在打磨），游戏本身照常加载、路由照常装配。
     */
    const visibleNames = mods.filter(m => !m.hidden).map(m => m.name).sort().join(',');
    ok('主页列表 = games/ 目录减去声明 Hub.hidden 的游戏', apiNames === visibleNames,
      '接口=' + apiNames + '  可见=' + visibleNames + '  磁盘=' + dirNames);

    /* 隐藏的游戏必须还能直连 —— 否则"给开发者留门"就成了空话 */
    const hiddenMods = mods.filter(m => m.hidden);
    ok('声明 Hub.hidden 的游戏都不上主页', hiddenMods.every(m => apiNames.indexOf(m.name) < 0),
      hiddenMods.length ? hiddenMods.map(m => m.name).join(', ') : '（当前没有）');
    for (const m of hiddenMods) {
      const hr = await fetch(base + (m.entry || ('/' + m.name + '/')));
      ok('隐藏的 ' + m.name + ' 仍能用 ' + (m.entry || ('/' + m.name + '/')) + ' 直连', hr.status === 200,
        'HTTP ' + hr.status);
    }

    ok('没有消息路由冲突', Array.isArray(st.routeConflicts) && st.routeConflicts.length === 0,
      JSON.stringify(st.routeConflicts));

    /* 契约上的提醒（没声明 title、entry 与目录名不一致、Hub.card.links 被丢掉等）。
       它是"非致命但会让加游戏的人踩坑"的信号，自检里必须为空 —— 否则就是有人的声明写错了。 */
    ok('没有游戏契约警告（gameWarnings 为空）',
      Array.isArray(st.gameWarnings) && st.gameWarnings.length === 0, JSON.stringify(st.gameWarnings));

    /* 主页只应该有一个空容器，卡片全部由脚本渲染 —— 这是"新游戏上不了主页"的根因回归 */
    const homeRes = await fetch(base + '/');
    const home = await homeRes.text();
    ok('GET / 可访问', homeRes.status === 200, 'HTTP ' + homeRes.status);
    ok('主页有动态卡片容器 #hubGrid', home.indexOf('id="hubGrid"') >= 0);
    ok('主页引用了平台通用库', home.indexOf('/shared/core.js') >= 0 && home.indexOf('/shared/net.js') >= 0);
    ok('主页引用了聊天控件（所有页面常驻）',
      home.indexOf('/shared/chat.js') >= 0 && home.indexOf('/shared/chat.css') >= 0);

    /* 平台层通用能力：好友系统 + 频道聊天（游戏都能用，但 platform/ 不认识任何游戏） */
    ok('/api/status 带频道聊天统计',
      typeof st.chatChannels === 'number' && typeof st.chatMembers === 'number',
      JSON.stringify({ chatChannels: st.chatChannels, chatMembers: st.chatMembers }));

    console.log('\n== E. 每个游戏的入口与卡片资源 ==');
    for (const g of (st.games || [])) {
      const r = await fetch(base + g.entry);
      const ct = String(r.headers.get('content-type') || '');
      ok('GET ' + g.entry + '（' + g.title + '）', r.status === 200 && ct.indexOf('text/html') >= 0,
        'HTTP ' + r.status + ' ' + ct);
      ok(g.title + ' · 卡片有简介', typeof g.desc === 'string' && g.desc.length > 0);
      ok(g.title + ' · 卡片有标签', Array.isArray(g.tags) && g.tags.length > 0,
        Array.isArray(g.tags) ? g.tags.length + ' 个' : typeof g.tags);
      if (g.art) {
        const ar = await fetch(base + g.art);
        const act = String(ar.headers.get('content-type') || '');
        ok('GET ' + g.art, ar.status === 200 && act.indexOf('image') >= 0, 'HTTP ' + ar.status + ' ' + act);
      }
      ok('主页没有写死 ' + g.entry + ' 入口（卡片由 /api/status 渲染）',
        home.indexOf('href="' + g.entry + '"') < 0);
      ok(g.title + ' · 目录名与 entry 一致', g.entry === '/' + g.name + '/', g.entry);

      /*
       * 卡片附属入口 = 游戏的"第二个页面"（方块躲避的关卡编辑器就是这类）。
       * 服务端只放行站内相对路径，所以这里既验格式也验它真的能打开 ——
       * 免得主页卡片上挂一个 404，点了才发现。
       */
      const links = Array.isArray(g.links) ? g.links : [];
      ok(g.title + ' · 附属入口不超过 3 个', links.length <= 3, links.length + ' 个');
      for (const l of links) {
        ok(g.title + ' · 附属入口是站内相对路径（' + l.href + '）',
          typeof l.href === 'string' && l.href.charAt(0) === '/' && l.href.charAt(1) !== '/',
          l.href);
        const lr = await fetch(base + l.href);
        ok('GET ' + l.href + '（' + g.title + ' · ' + l.label + '）', lr.status === 200, 'HTTP ' + lr.status);
      }
    }

    console.log('\n== F. 平台通用库 ==');
    for (const p of ['/shared/core.js', '/shared/net.js', '/shared/app.css',
                     '/shared/friends.js', '/shared/friends.css', '/shared/chat.js', '/shared/chat.css']) {
      const r = await fetch(base + p);
      ok('GET ' + p, r.status === 200, 'HTTP ' + r.status);
    }

    /* 每个游戏页面都必须挂上聊天控件：需求是"所有页面都有" */
    for (const g of (st.games || [])) {
      const html = await (await fetch(base + g.entry)).text();
      ok(g.title + ' · 页面引入了聊天控件',
        html.indexOf('/shared/chat.js') >= 0 && html.indexOf('/shared/chat.css') >= 0);
    }
  } finally {
    if (proc) { try { proc.kill(); } catch (e) { /* noop */ } }
  }

  console.log('\n' + (fails === 0
    ? ('平台装配全部通过 ✔  (' + passes + ' 项)')
    : (fails + ' 项失败，' + passes + ' 项通过')));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('\n[测试异常]', e.message); process.exit(1); });
