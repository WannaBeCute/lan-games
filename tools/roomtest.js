'use strict';
/**
 * 坦克大战「联机大厅」端到端测试
 *   node tools/roomtest.js [http://127.0.0.1:8080]
 * 用一个真实浏览器当房主（走完整 UI），再用一个 Node WebSocket 客户端当第二个玩家，
 * 覆盖：新建房间 → 对方加入 → 准备状态 → 房主开始游戏 → 双方进入对局。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const PORT_DBG = 9334;
const SHOTS = path.join(__dirname, 'shots');
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

async function getTarget(port, retry) {
  for (let i = 0; i < (retry || 40); i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('无法连接 Chrome 调试端口');
}

/** 玩家用的极简 WebSocket 客户端 */
function wsClient(tag) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    const c = { tag, ws, msgs: [], handlers: {}, ptr: {} };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      c.msgs.push(m);
      (c.handlers[m.t] || []).slice().forEach(fn => fn(m));
    };
    c.send = (o) => ws.send(JSON.stringify(o));
    c.wait = (type, timeout = 6000) => new Promise((res, rej) => {
      const idx = c.ptr[type] || 0;
      const list = c.msgs.filter(m => m.t === type);
      if (list.length > idx) { c.ptr[type] = idx + 1; return res(list[idx]); }
      const timer = setTimeout(() => rej(new Error('[' + tag + '] 等待 ' + type + ' 超时')), timeout);
      const h = (m) => { clearTimeout(timer); c.ptr[type] = (c.ptr[type] || 0) + 1; res(m); };
      (c.handlers[type] = c.handlers[type] || []).push(h);
    });
    c.last = (type) => { for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === type) return c.msgs[i]; return null; };
    c.close = () => ws.close();
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error('[' + tag + '] 连接失败'));
  });
}

(async function main() {
  const exe = CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) { console.log('未找到 Chrome/Edge，跳过大厅测试'); process.exit(0); }
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  const profile = path.join(os.tmpdir(), 'wb-roomtest-' + Date.now());
  const proc = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--window-size=1440,920',
    '--remote-debugging-port=' + PORT_DBG, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null, guest = null;
  try {
    cdp = new CDP(await getTarget(PORT_DBG));
    await cdp.connect();
    const errors = [];
    cdp.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push('异常: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text) + ' @' + d.lineNumber);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push('console.error: ' + m.params.args.map(a => a.value != null ? a.value : a.description).join(' '));
      }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
      if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
    };

    console.log('\n== 坦克大战联机大厅 ==');
    await cdp.send('Page.navigate', { url: BASE + '/tank/' });
    await sleep(1500);

    // 房主建房间
    await evalJs("document.querySelector('[data-mode=\"online\"]').click()");
    await sleep(300);
    await evalJs("document.getElementById('btnCreateRoom').click()");
    await sleep(1200);
    const code = await evalJs("document.getElementById('roomCode').textContent");
    ok('房主新建房间', /^\d{4}$/.test(code), '房间号 ' + code);

    // ---- 单人 + AI 开关 ----
    const readBtn = async () => JSON.parse(await evalJs("JSON.stringify({disabled:document.getElementById('btnStartGame').disabled,text:document.getElementById('btnStartGame').textContent,tip:document.getElementById('lobbyTip').textContent,bots:document.getElementById('chkBots').checked})"));
    let b0 = await readBtn();
    ok('单人时默认不补 AI，房主暂时不能开始', b0.disabled === true && b0.bots === false && /AI/.test(b0.tip), JSON.stringify(b0));

    await evalJs("var c=document.getElementById('chkBots');c.checked=true;c.dispatchEvent(new Event('change'))");
    await sleep(600);
    let b1 = await readBtn();
    ok('打开 AI 补充后单人就能开始', b1.disabled === false && b1.bots === true, JSON.stringify(b1));

    await evalJs("var c=document.getElementById('chkBots');c.checked=false;c.dispatchEvent(new Event('change'))");
    await sleep(600);
    let b2 = await readBtn();
    ok('关回 AI 后又不能开始，并说明原因', b2.disabled === true && b2.bots === false && /AI/.test(b2.tip), JSON.stringify(b2));

    await evalJs("var c=document.getElementById('chkBots');c.checked=true;c.dispatchEvent(new Event('change'))");
    await sleep(600);

    // ---- 第二个人加入 ----
    guest = await wsClient('客人');
    await guest.wait('hello');
    guest.send({ t: 'tank.join', code: code });
    const joined = await guest.wait('tank.joined');
    ok('第二个人成功加入房间', !!joined, '房间 ' + joined.code);
    await sleep(600);

    const list = await evalJs("Array.from(document.querySelectorAll('#playerList li')).map(li=>li.textContent.replace(/\\s+/g,' ').trim())");
    ok('房主列表里能看到两个人', list.length === 2, JSON.stringify(list));
    ok('列表里显示准备状态', /已就绪/.test(list[0] || '') && /未准备/.test(list[1] || ''), JSON.stringify(list));

    let b3 = await readBtn();
    ok('有人未准备时房主不能开始', b3.disabled === true && /未准备/.test(b3.tip), JSON.stringify(b3));

    // 客人可以自己点准备吗（UI 层面只验证按钮存在）
    const guestReadyBtn = await evalJs("JSON.stringify({hidden:document.getElementById('btnReady').classList.contains('hidden'),text:document.getElementById('btnReady').textContent})");
    ok('房主界面不显示准备按钮（房主无需准备）', JSON.parse(guestReadyBtn).hidden === true, guestReadyBtn);

    // ---- 客人准备 ----
    guest.send({ t: 'tank.ready', ready: true });
    await sleep(700);
    let b4 = await readBtn();
    ok('所有人都准备后房主可以开始', b4.disabled === false, JSON.stringify(b4));
    const list2 = await evalJs("Array.from(document.querySelectorAll('#playerList li')).map(li=>li.textContent.replace(/\\s+/g,' ').trim())");
    ok('列表里房主能看到对方已准备', /已准备/.test(JSON.stringify(list2)), JSON.stringify(list2));

    // 从客人（纯 WS 客户端）角度看下发的房间状态
    const grm = guest.last('tank.room');
    ok('服务端向每位玩家下发准备状态', !!grm && grm.members.every(m => typeof m.ready === 'boolean'),
      grm ? JSON.stringify(grm.members.map(m => m.name + ':' + m.ready)) : '无');
    ok('非房主收到「等待房主开始」的提示', grm && grm.canStart === false && /等待房主/.test(grm.startHint), grm ? grm.startHint : '');
    ok('房间状态里带 AI 开关与人数上限', grm && typeof grm.addBots === 'boolean' && grm.maxPlayers === 4,
      grm ? ('addBots=' + grm.addBots + ' maxPlayers=' + grm.maxPlayers) : '');
    await shot('7-lobby-ready');

    // ---- 房主点开始 ----
    await evalJs("document.getElementById('btnStartGame').click()");
    await sleep(1200);
    const roundMsg = await guest.wait('tank.round', 5000);
    ok('客人收到开局消息', !!roundMsg, '第 ' + roundMsg.index + '/' + roundMsg.total + ' 局');
    ok('2 个真人时不加入任何 AI 坦克', roundMsg.players.filter(p => !p.bot).length === 2 && roundMsg.players.filter(p => p.bot).length === 0,
      JSON.stringify(roundMsg.players.map(p => p.name + (p.bot ? '(AI)' : ''))));
    const scr = await evalJs("JSON.stringify({game:!document.getElementById('scr-game').classList.contains('hidden'),lobby:!document.getElementById('scr-lobby').classList.contains('hidden')})");
    const S2 = JSON.parse(scr);
    ok('房主页面切到对局画面（此前的 TypeError 已修复）', S2.game === true && S2.lobby === false, scr);
    await sleep(2500);
    await shot('8-room-round');

    // 房主断开后房间应回收
    await evalJs("document.getElementById('btnQuit').click()");
    await sleep(600);
    const st = await (await fetch(BASE + '/api/status')).json();
    ok('房主退出后房间被回收', st.tankRooms <= 1, JSON.stringify(st));

    ok('全流程无 JS 报错', errors.length === 0, errors.join(' | ') || '无');
  } catch (e) {
    console.error('\n[测试异常] ' + e.message);
    fails++;
  } finally {
    if (guest) { try { guest.close(); } catch (e) { /* noop */ } }
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) { /* noop */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }

  console.log('\n' + (fails === 0 ? ('大厅测试全部通过 ✔  (' + passes + ' 项)') : (fails + ' 项失败，' + passes + ' 项通过')));
  process.exit(fails === 0 ? 0 : 1);
})();
