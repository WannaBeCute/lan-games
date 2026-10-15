'use strict';
/**
 * 「你画我猜」对局页界面自检： node tools/drawguessuitest.js [baseUrl]
 *
 * 目前只覆盖一块（2026-10-15 用户报"聊天区没有上限高度，聊天越多越高"）：
 *   A. 聊天区有上限高度 —— 灌 60 条发言，日志区不超过上限；
 *   B. 超出部分能滚动 —— 自己出滚动条，滚到底最后一条可见；
 *   C. 页面不会被聊天撑高 —— 60 条 vs 3 条，整页高度差很小（以前是差 2000+px）；
 *   D. 折叠按钮 —— 收起只留最近 3 条，展开恢复正常。
 *
 * 真实浏览器（无头 Chrome）实测。跟其他 *uitest 一样需要外接服务端。
 */
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
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
function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => res(this);
      this.ws.onerror = () => rej(new Error('CDP 连接失败'));
      this.ws.onmessage = ev => {
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
}

(async function main() {
  const exe = CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) { console.log('未找到 Chrome/Edge，跳过界面自检'); process.exit(0); }
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  const PORT_SRV = await freePort(), PORT_DBG = await freePort();
  const srv = spawn(process.execPath, [SERVER, '--port', String(PORT_SRV)],
    { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { WB_TEST_HOOKS: '1' }) });
  await sleep(1200);
  const BASE = process.argv[2] || ('http://127.0.0.1:' + PORT_SRV);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dg-ui-'));
  const chrome = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--window-size=1440,960',
    '--remote-debugging-port=' + PORT_DBG, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
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
  cdp.on(m => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('异常: ' + ((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + m.params.args.map(a => a.value != null ? a.value : a.description).join(' '));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面求值异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  const json = async (expr) => JSON.parse(await evalJs('JSON.stringify(' + expr + ')'));
  const waitUntil = async (expr, timeout = 8000) => {
    const t0 = Date.now();
    for (;;) {
      try { if (await evalJs(expr)) return true; } catch (e) { }
      if (Date.now() - t0 > timeout) return false;
      await sleep(150);
    }
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  /** 往聊天区灌 n 条发言，并返回关键尺寸 */
  const fill = (n) => json("(function(n){" +
    "var box=document.getElementById('chatLog'); box.textContent='';" +
    "for(var i=1;i<=n;i++){var d=document.createElement('div');d.className='line chat';" +
    "d.innerHTML='<span class=\"who\">同学'+i+'</span>：这是一条测试发言，用来把聊天区撑得很长很长 '+i;" +
    "box.appendChild(d);}" +
    "var r=box.getBoundingClientRect();" +
    "return {logH:Math.round(r.height), scrollH:box.scrollHeight, clientH:box.clientHeight," +
    "  docH:document.documentElement.scrollHeight, vh:window.innerHeight};})(" + n + ")");

  try {
    console.log('\n== A. 你画我猜对局页：聊天区有上限高度 ==');
    await cdp.send('Page.navigate', { url: BASE + '/drawguess/' });
    ok('页面加载出聊天区', await waitUntil("!!document.getElementById('chatLog')"));
    // 直接把对局页显示出来（不必真开一局）
    await evalJs("(function(){document.getElementById('viewPlay').classList.remove('hidden');" +
      "['viewHome','viewLobby','viewHelp'].forEach(function(id){var e=document.getElementById(id);if(e)e.classList.add('hidden');});return 1;})()");
    await sleep(400);

    const few = await fill(3);
    const many = await fill(60);
    ok('灌 60 条发言后聊天区不超过上限高度', many.logH <= Math.min(340, Math.round(many.vh * 0.34)),
      '日志 ' + many.logH + 'px（视口 ' + many.vh + '，3 条时 ' + few.logH + 'px）');
    ok('超出上限的部分变成可滚动（scrollHeight > clientHeight）',
      many.scrollH > many.clientH + 2, '内容 ' + many.scrollH + 'px / 可见 ' + many.clientH + 'px');
    ok('页面不会被聊天条数撑高（60 条 vs 3 条，整页高度差 ≤ 60px）',
      many.docH - few.docH <= 60, '3 条 ' + few.docH + 'px → 60 条 ' + many.docH + 'px');
    const lastVisible = await evalJs(
      "(function(){var b=document.getElementById('chatLog');b.scrollTop=b.scrollHeight;" +
      "var l=b.lastElementChild.getBoundingClientRect(),r=b.getBoundingClientRect();" +
      "return l.bottom<=r.bottom+1&&l.top>=r.top-1;})()");
    ok('滚到底部时最后一条发言可见（滚动真的能用）', lastVisible === true);
    await shot('drawguess-chat-cap');

    console.log('\n== B. 折叠 / 展开 ==');
    const fold = await json("(function(){var p=document.getElementById('chatPanel');p.classList.add('folded');" +
      "var b=document.getElementById('chatLog');" +
      "var vis=Array.prototype.filter.call(b.querySelectorAll('.line'),function(l){return getComputedStyle(l).display!=='none';}).length;" +
      "var h=Math.round(b.getBoundingClientRect().height);" +
      "var inp=!!document.getElementById('chatRow');" +
      "p.classList.remove('folded');return {vis:vis,h:h,hasInput:inp};})()");
    ok('折叠后只留最近 3 条', fold.vis === 3, '可见 ' + fold.vis + ' 条');
    ok('折叠后高度很小（≤ 90px）', fold.h <= 90, fold.h + 'px');
    ok('折叠时输入框还在（随时能说话）', fold.hasInput === true);
    const after = await fill(60);
    ok('展开后又能装下 60 条并封顶', after.logH <= Math.min(340, Math.round(after.vh * 0.34)), after.logH + 'px');

    ok('全流程无 JS 报错', errors.length === 0, errors.join(' | '));
  } catch (e) {
    console.log('  [异常] ' + e.message);
    fails++;
  } finally {
    try { srv.kill(); } catch (e) { }
    try { chrome.kill(); } catch (e) { }
  }

  console.log('\n========================================');
  console.log(fails ? '  有失败项：' + fails + ' 项失败，' + passes + ' 项通过' : '  全部通过 ✔ (' + passes + ' 项)');
  console.log('========================================');
  process.exit(fails ? 1 : 0);
})();
