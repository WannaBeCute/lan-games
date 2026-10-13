'use strict';
/**
 * 好友系统界面自检： node tools/friendsuitest.js
 *
 * 用一个真实浏览器（房主视角）+ 一个 Node WebSocket 客户端（模拟另一台电脑，
 * 借助 WB_TEST_HOOKS=1 的 ?fip= 钩子获得独立 IP），覆盖好友功能的完整界面链路：
 *   1) 顶栏出现「👥 好友」按钮
 *   2) 对方加好友 → 左下角弹出邀请（不遮挡画面：贴在左下角）
 *   3) 点「接受」→ 好友列表出现对方（完整 IP + 在线状态）
 *   4) 聊天小窗：收消息 / 发消息 / 回车发送
 *   5) 组队邀请免邀请码：对方在坦克房间里发邀请 → 点接受 → 自动跳转并加入房间
 *   6) 五子棋：带 ?invite= 打开 → 自动向好友发起对局 → 双方进入棋盘
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
const SHOTS = path.join(__dirname, 'shots');
const PORT_SRV = 8123;
const PORT_DBG = 9336;
const DATA_FILE = path.join(os.tmpdir(), 'wb-friends-uitest.json');
const PEER_IP = '10.1.1.9';                 // 模拟"另一台电脑"的 IP
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

let fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log('  [通过] ' + name + (extra != null ? '  ' + extra : '')); }
  else { fails++; console.log('  [失败] ' + name + '  ' + (extra != null ? extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* ---------------- 极简 CDP 客户端（与 roomtest 同款） ---------------- */
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => res(this);
      this.ws.onerror = () => rej(new Error('CDP 连接失败'));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id != null && this.pending.has(m.id)) {
          const { resolve, reject } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
          return;
        }
        this.listeners.slice().forEach(fn => fn(m));
      };
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch (e) { /* noop */ } }
}

/* ---------------- Node 端"另一台电脑" ---------------- */
function peer(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?fip=' + PEER_IP);
    const c = { ws, msgs: [], handlers: {}, ptr: {}, code: '' };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      c.msgs.push(m);
      if (m.t === 'hello') c.code = m.inviteCode;
      (c.handlers[m.t] || []).slice().forEach(fn => fn(m));
    };
    c.send = (o) => ws.send(JSON.stringify(o));
    c.wait = (type, timeout = 8000) => new Promise((res, rej) => {
      const idx = c.ptr[type] || 0;
      const list = c.msgs.filter(m => m.t === type);
      if (list.length > idx) { c.ptr[type] = idx + 1; return res(list[idx]); }
      const timer = setTimeout(() => rej(new Error('[peer] 等待 ' + type + ' 超时')), timeout);
      const h = (m) => {
        clearTimeout(timer);
        const i = c.handlers[type].indexOf(h);
        if (i >= 0) c.handlers[type].splice(i, 1);
        c.ptr[type] = (c.ptr[type] || 0) + 1;
        res(m);
      };
      (c.handlers[type] = c.handlers[type] || []).push(h);
    });
    c.close = () => { try { ws.close(); } catch (e) { /* noop */ } };
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', name: '小明' }));
      resolve(c);
    };
    ws.onerror = () => reject(new Error('[peer] 连接失败'));
  });
}

(async function main() {
  const exe = CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) { console.log('未找到 Chrome/Edge，跳过好友界面自检'); process.exit(0); }
  try { fs.unlinkSync(DATA_FILE); } catch (e) { /* noop */ }
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  /* 服务端（测试钩子：独立 IP + 临时数据文件） */
  const srv = spawn(process.execPath, [SERVER, '--port', String(PORT_SRV)], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { WB_TEST_HOOKS: '1', WB_FRIENDS_FILE: DATA_FILE })
  });
  await sleep(1200);
  const BASE = 'http://127.0.0.1:' + PORT_SRV;

  /* 浏览器 */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-friends-ui-'));
  const chrome = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--window-size=1440,920',
    '--remote-debugging-port=' + PORT_DBG, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT_DBG + '/json/list')).json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* retry */ }
    await sleep(200);
  }
  if (!wsUrl) { console.log('浏览器调试端口未就绪'); srv.kill(); chrome.kill(); process.exit(1); }

  const cdp = new CDP(wsUrl);
  await cdp.connect();
  const errors = [];
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('异常: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + m.params.args.map(a => a.value != null ? a.value : a.description).join(' '));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evalJs = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  };
  /** 轮询等待页面条件成立 */
  const waitUntil = async (expr, timeout = 8000) => {
    const t0 = Date.now();
    for (;;) {
      try { if (await evalJs(expr)) return true; } catch (e) { /* 继续等 */ }
      if (Date.now() - t0 > timeout) return false;
      await sleep(150);
    }
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  };

  try {
    /* ============ 1. 打开坦克页，好友按钮就位 ============ */
    console.log('\n== 1. 页面与好友按钮 ==');
    const buddy = peer(PORT_SRV);
    await cdp.send('Page.navigate', { url: BASE + '/tank/' });
    ok('坦克页加载出好友按钮', await waitUntil("!!document.getElementById('btnFriends')"));
    ok('好友停靠区已创建（左下角）', await evalJs("!!document.getElementById('wb-friends-dock')"));
    const badge0 = await evalJs("document.getElementById('fbBadge').classList.contains('hidden')");
    ok('按钮初始无未读徽标', badge0 === true);

    /* ============ 2. 好友邀请弹窗（左下角） ============ */
    console.log('\n== 2. 左下角好友邀请 ==');
    buddy.then(c => c.send({ t: 'friends.add', ip: '127.0.0.1' })).catch(() => {});
    const peerClient = await buddy;
    ok('浏览器左下角弹出邀请', await waitUntil("!!document.querySelector('.fb-pop')"));
    const popText = await evalJs("(document.querySelector('.fb-pop')||{}).innerText||''");
    ok('弹窗显示对方昵称', /小明/.test(popText), popText.replace(/\n/g, ' '));
    ok('弹窗贴在左下角（不遮挡画面）', await evalJs(
      "(function(){var p=document.querySelector('.fb-pop');var r=p.getBoundingClientRect();" +
      "return r.left < 40 && r.bottom > window.innerHeight - 60 && r.width < 320;})()"));
    const resPeer = await peerClient.wait('friends.result');
    ok('对方收到发送回执', resPeer.ok === true, resPeer.msg);
    await shot('friends-invite-popup');

    /* ============ 3. 接受 → 好友列表 ============ */
    console.log('\n== 3. 接受邀请成为好友 ==');
    await evalJs("Array.from(document.querySelectorAll('.fb-pop .btn')).find(b=>b.textContent==='接受').click()");
    const resPeer2 = await peerClient.wait('friends.result');
    ok('对方收到成为好友通知', /好友/.test(resPeer2.msg || ''), resPeer2.msg);
    ok('浏览器弹出成功提示', await waitUntil(
      "(function(){var t=Array.from(document.querySelectorAll('.wb-toast'));return t.some(x=>/好友/.test(x.textContent));})()"));

    // 打开好友面板 → 我的好友
    await evalJs("document.getElementById('btnFriends').click()");
    ok('好友面板打开', await waitUntil("!!document.getElementById('wb-friends-mask')"));
    await evalJs("document.querySelector('.fb-tab[data-tab=\"friends\"]').click()");
    await sleep(300);
    const friendRow = await evalJs(
      "(function(){var rows=Array.from(document.querySelectorAll('#fbBody .fb-row'));" +
      "var r=rows.find(x=>/小明/.test(x.textContent));" +
      "return r?{name:/小明/.test(r.textContent),ip:/10\\.1\\.1\\.9/.test(r.textContent),online:/离线/.test(r.textContent)?false:true}:null;})()");
    ok('好友列表显示昵称 + 完整 IP + 在线状态', !!friendRow && friendRow.name && friendRow.ip && friendRow.online,
      JSON.stringify(friendRow));
    await shot('friends-panel');

    /* ============ 4. 聊天 ============ */
    console.log('\n== 4. 好友聊天 ==');
    await evalJs("Array.from(document.querySelectorAll('#fbBody .fb-row .btn')).find(b=>b.textContent==='聊天').click()");
    ok('聊天小窗打开', await waitUntil("!!document.querySelector('.fb-chat')"));
    peerClient.send({ t: 'friends.chat', ip: '127.0.0.1', text: '来一局坦克？', mid: 'ui1' });
    ok('小窗实时收到消息', await waitUntil(
      "(function(){var m=Array.from(document.querySelectorAll('.fb-chat .msg.other'));return m.some(x=>/来一局坦克/.test(x.textContent));})()"));
    const echo = await peerClient.wait('friends.chat');
    ok('对方收到自己消息的回显', echo.self === true && echo.text === '来一局坦克？');
    await evalJs(
      "(function(){var i=document.querySelector('.fb-chat .ft input');i.value='马上来';" +
      "i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 1;})()");
    const chatBack = await peerClient.wait('friends.chat');
    ok('对方收到回车发出的消息', chatBack.text === '马上来' && chatBack.self === false, chatBack.text);
    ok('聊天小窗在左下角且不宽', await evalJs(
      "(function(){var r=document.querySelector('.fb-chat').getBoundingClientRect();" +
      "return r.left < 40 && r.bottom > window.innerHeight - 40 && r.width <= 320;})()"));
    await shot('friends-chat');

    /* ============ 5. 组队邀请：免邀请码直达坦克房间 ============ */
    console.log('\n== 5. 组队邀请直达（坦克） ==');
    // 对方先建一个房间
    peerClient.send({ t: 'tank.create' });
    const created = await peerClient.wait('tank.created');
    ok('对方创建坦克房间', /^\d{4}$/.test(created.code), created.code);
    peerClient.send({ t: 'friends.team', ip: '127.0.0.1', game: 'tank', data: { room: created.code }, text: '房间 ' + created.code });
    ok('浏览器收到组队邀请弹窗', await waitUntil(
      "(function(){var p=Array.from(document.querySelectorAll('.fb-pop.team'));return p.length>0 && /小明/.test(p[0].textContent);})()"));
    await evalJs("Array.from(document.querySelectorAll('.fb-pop.team .btn')).find(b=>b.textContent==='接受').click()");
    ok('点击接受后自动跳转并加入房间', await waitUntil(
      "(function(){return !document.getElementById('scr-lobby').classList.contains('hidden')" +
      " && document.getElementById('roomCode').textContent === '" + created.code + "';})()"));
    const teamRes = await peerClient.wait('friends.teamResult');
    ok('对方收到接受组队的回执', teamRes.accept === true, JSON.stringify(teamRes));

    /* ============ 6. 五子棋：?invite= 自动发起对局 ============ */
    console.log('\n== 6. 好友直达（五子棋） ==');
    await cdp.send('Page.navigate', { url: BASE + '/gomoku/?invite=' + peerClient.code });
    ok('带邀请码打开五子棋页', await waitUntil("!!document.getElementById('board')"));
    ok('自动向好友发起对局（无需手动输邀请码）', await waitUntil(
      "(function(){var t=document.getElementById('waitTip').textContent;return /等待对方接受/.test(t);})()", 10000),
      await evalJs("document.getElementById('waitTip').textContent"));
    const gomokuInvited = await peerClient.wait('gomoku.invited');
    ok('对方收到对局邀请', gomokuInvited.from.name === '浏览器' || /玩家/.test(gomokuInvited.from.name || ''), JSON.stringify(gomokuInvited.from));
    peerClient.send({ t: 'gomoku.reply', matchId: gomokuInvited.matchId, accept: true });
    ok('双方进入棋盘', await waitUntil(
      "(function(){return !document.getElementById('scr-play').classList.contains('hidden');})()", 10000));
    const boardInfo = await evalJs(
      "JSON.stringify({me:window.__GOMOKU_DEBUG.G.myColor,turn:window.__GOMOKU_DEBUG.G.turn,mode:window.__GOMOKU_DEBUG.G.mode})");
    ok('对局正式开始（黑白已分配）', /"mode":"online"/.test(boardInfo), boardInfo);
    await shot('friends-gomoku');

    /* ============ 汇总 ============ */
    ok('全流程无 JS 报错', errors.length === 0, errors.join(' | '));
  } catch (e) {
    fails++;
    console.error('\n[界面自检异常]', e.message);
  } finally {
    cdp.close();
    await sleep(200);
    srv.kill(); chrome.kill();
    try { fs.unlinkSync(DATA_FILE); } catch (e) { /* noop */ }
  }

  console.log('\n========================================');
  console.log('  好友界面自检：' + passes + ' 项通过，' + fails + ' 项失败');
  console.log('========================================');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('\n[自检异常]', e);
  process.exit(1);
});
