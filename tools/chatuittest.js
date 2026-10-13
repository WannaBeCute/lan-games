'use strict';
/**
 * 聊天控件界面自检： node tools/chatuittest.js
 *
 * 用真实浏览器（无头 Chrome）实测：
 *   A. 控件本体  —— 所有页面都在、**默认收纳**（只显示最新消息）、贴在左下角、
 *                 拖到别处（位置记在本机）、点「–」展开、点「×」隐藏成小圆钮、
 *                 展开后页签**不会被好友列表盖住**、刷新页面状态不丢；
 *   B. 好友私聊  —— 好友列表里点一个好友 → 弹出独立的私聊小窗；
 *                 **换页面小窗还在**，手动刷新网页才清掉；
 *   C. 房间频道  —— enterRoom 之后出现「本局」页签并自动展开，
 *                 房间里所有人可见（用另一个连接当"队友"验证双向可见），离开房间频道消失。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
const SHOTS = path.join(__dirname, 'shots');
const DATA_FILE = path.join(os.tmpdir(), 'wb-chat-ui-friends.json');
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

/** 测试用的"另一个同学"：一条裸 WebSocket（可伪造 IP），用来验证房间聊天对所有成员可见 */
function peer(tag, fip, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?fip=' + fip);
    const c = { tag, ws, msgs: [], ip: fip };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } c.msgs.push(m); };
    c.send = (o) => ws.send(JSON.stringify(o));
    c.waitFor = (fn, timeout = 6000) => new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        const hit = c.msgs.filter(fn).pop();
        if (hit) return res(hit);
        if (Date.now() - t0 > timeout) return rej(new Error('[' + tag + '] 等待消息超时'));
        setTimeout(poll, 60);
      })();
    });
    c.close = () => { try { ws.close(); } catch (e) { /* noop */ } };
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', name: tag })); resolve(c); };
    ws.onerror = () => reject(new Error('[' + tag + '] 连接失败'));
  });
}

(async function main() {
  const exe = CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) { console.log('未找到 Chrome/Edge，跳过界面自检'); process.exit(0); }
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  try { fs.unlinkSync(DATA_FILE); } catch (e) { /* 本来就没有 */ }

  const PORT_SRV = await freePort(), PORT_DBG = await freePort();
  const srv = spawn(process.execPath, [SERVER, '--port', String(PORT_SRV)], {
    cwd: ROOT, stdio: 'ignore',
    env: Object.assign({}, process.env, { WB_TEST_HOOKS: '1', WB_FRIENDS_FILE: DATA_FILE })
  });
  await sleep(1200);
  const BASE = 'http://127.0.0.1:' + PORT_SRV;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-ui-'));
  const chrome = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--window-size=1440,960',
    '--remote-debugging-port=' + PORT_DBG, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

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

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  };
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
  const json = async (expr) => JSON.parse(await evalJs('JSON.stringify(' + expr + ')'));
  /** 取一次 /api/status（页面内部发请求，绕开跨域） */
  const getStatus = async () => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: "fetch('/api/status').then(function(r){return r.json();})",
      returnByValue: true, awaitPromise: true
    });
    return r.result.value;
  };
  const rect = (sel) => json("(function(){var e=document.querySelector('" + sel + "');if(!e)return null;var r=e.getBoundingClientRect();return {left:r.left,top:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2};})()");
  const click = (sel) => evalJs("(function(){var e=document.querySelector('" + sel + "');if(!e)return 'no-el';e.click();return 'ok';})()");
  /** 在某个元素上按下鼠标，拖到 (x,y)，再松开（mousemove / mouseup 发到 window，和真人一样） */
  const dragSelectorTo = async (sel, x2, y2) => {
    const r = await rect(sel);
    await evalJs("(function(){var e=document.querySelector('" + sel + "');var r=e.getBoundingClientRect();" +
      "e.dispatchEvent(new MouseEvent('mousedown',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,bubbles:true,cancelable:true}));return 1;})()");
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = r.cx + (x2 - r.cx) * t, y = r.cy + (y2 - r.cy) * t;
      await evalJs("window.dispatchEvent(new MouseEvent('mousemove',{clientX:" + x + ",clientY:" + y + ",bubbles:true}));1");
    }
    await evalJs("window.dispatchEvent(new MouseEvent('mouseup',{clientX:" + x2 + ",clientY:" + y2 + ",bubbles:true}));1");
  };
  const reload = async () => {
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(1400);
  };

  try {
    /* ================= A. 控件本体 ================= */
    console.log('\n== A. 聊天控件：常驻 / 默认收纳 / 拖动 / 隐藏 ==');
    await cdp.send('Page.navigate', { url: BASE + '/' });
    ok('主页加载出聊天控件（所有页面都常驻）', await waitUntil("!!document.getElementById('wb-chat')"));
    ok('默认是收纳状态（只留一条最新消息）',
      await evalJs("document.getElementById('wb-chat').classList.contains('min')") === true);
    ok('收纳时显示「最新消息」区域',
      await waitUntil("!!document.getElementById('wcPreview')"));
    const pos0 = await rect('#wb-chat');
    const bl = await json("(function(){var r=document.getElementById('wb-chat').getBoundingClientRect();" +
      "return {left:r.left, bottom:window.innerHeight-r.bottom};})()");
    ok('默认贴在左下角', bl.left < 40 && bl.bottom < 40, 'left=' + Math.round(bl.left) + ' bottom=' + Math.round(bl.bottom));
    await shot('chat-collapsed');

    const targetX = pos0.left + 240, targetY = Math.max(60, pos0.top - 160);
    await dragSelectorTo('.wc-head', targetX, targetY);
    await sleep(200);
    const pos1 = await rect('#wb-chat');
    // 拖的是标题栏中心，所以控件左上角会落在「目标点 - 一半宽/高」的位置
    const dx = targetX - pos0.cx;
    ok('按住标题栏能拖动控件',
      Math.abs((pos1.left - pos0.left) - dx) < 20 && pos1.top < pos0.top - 100,
      'left ' + Math.round(pos0.left) + '→' + Math.round(pos1.left) + ' top ' + Math.round(pos0.top) + '→' + Math.round(pos1.top));
    const saved = await json("JSON.parse(localStorage.getItem('wb.chat.state.v1')||'{}')");
    ok('位置记在本机（localStorage）', Math.abs(saved.x - pos1.left) < 2 && Math.abs(saved.y - pos1.top) < 2,
      JSON.stringify(saved));
    ok('收纳状态下就能看到好友列表（不只是最新消息）',
      await evalJs("(function(){var m=document.getElementById('wcMini');" +
        "return !!m && getComputedStyle(m).display !== 'none';})()") === true);

    await click('.wc-head');          // 收纳状态下点一下控件就展开
    await sleep(200);
    ok('点一下控件能展开（收纳 → 展开）',
      await evalJs("!document.getElementById('wb-chat').classList.contains('min')") === true);
    ok('展开后能看到好友列表容器', await waitUntil("!!document.querySelector('#wcPane .wc-list')"));

    // 这条对应"页签被好友列表盖住"的 bug：页签正中心点到的必须还是页签本身
    const tabHit = await evalJs(
      "(function(){var t=document.querySelector('.wc-tab[data-ctab=\"friends\"]');var r=t.getBoundingClientRect();" +
      "var el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);" +
      "return el && (el===t || t.contains(el));})()");
    ok('页签不会被好友列表遮挡（点得到）', tabHit === true);
    await shot('chat-expanded');

    await evalJs("(function(){var b=document.querySelectorAll('.wc-btn');b[b.length-1].click();return 1;})()");
    await sleep(200);
    ok('点「×」把控件隐藏成小圆钮',
      await evalJs("document.getElementById('wb-chat').classList.contains('gone')") === true &&
      await evalJs("!document.getElementById('wcBall').classList.contains('gone')") === true);
    await shot('chat-hidden');
    await click('#wcBall');
    await sleep(200);
    ok('点小圆钮能把控件叫回来',
      await evalJs("!document.getElementById('wb-chat').classList.contains('gone')") === true);

    // 刷新页面：控件还在，位置与展开状态都不丢（"刷新也不得刷新掉"）
    await reload();
    ok('刷新页面后控件依然在', await waitUntil("!!document.getElementById('wb-chat')"));
    const pos2 = await rect('#wb-chat');
    ok('刷新后位置保持不变', Math.abs(pos2.left - pos1.left) < 3 && Math.abs(pos2.top - pos1.top) < 3,
      Math.round(pos2.left) + ',' + Math.round(pos2.top));
    ok('刷新后展开/收纳状态保持（刷新不会重置控件）',
      await evalJs("document.getElementById('wb-chat').classList.contains('min')") === false);

    /* ================= B. 好友私聊：独立小窗 + 跨页面保留 ================= */
    console.log('\n== B. 好友：点好友弹私聊小窗 / 换页面还在 / 刷新才清掉 ==');
    const mate = await peer('同学', '10.2.0.2', PORT_SRV);
    const myIp = (await evalJs("(function(){return WB.friends && WB.friends.me || '';})()")) || '';
    ok('页面知道自己是谁（好友身份以 IP 为单位）', /^\d+\.\d+\.\d+\.\d+$/.test(myIp), myIp);
    mate.send({ t: 'friends.add', ip: myIp });
    ok('好友邀请在左下角弹出来', await waitUntil("!!document.querySelector('.fb-pop .btn.primary')"));
    await evalJs("(function(){var p=document.querySelector('.fb-pop');var b=p.querySelector('.btn.primary');b.click();return 1;})()");
    ok('接受后成为好友（控件好友列表里出现他）',
      await waitUntil("(function(){var f=WB.friends.friends||[];return f.some(function(x){return x.ip==='" + '10.2.0.2' + "';});})()"),
      await evalJs("JSON.stringify((WB.friends.friends||[]).map(function(f){return f.name;}))"));

    // 收纳状态下的好友列表：能看到他，点一下直接开聊（这是"折叠状态也能看好友列表"的核心）
    await evalJs("(function(){var w=document.getElementById('wb-chat');" +
      "if(!w.classList.contains('min'))document.querySelectorAll('.wc-btn')[0].click();return 1;})()");
    await sleep(250);
    ok('点「–」能收起控件（回到收纳状态）',
      await evalJs("document.getElementById('wb-chat').classList.contains('min')") === true);
    ok('收纳状态下好友列表里能看到他',
      await evalJs("(function(){var m=document.getElementById('wcMini');" +
        "return !!m && /同学/.test(m.textContent) && m.querySelectorAll('.wc-row').length >= 1 && getComputedStyle(m).display !== 'none';})()"),
      (await evalJs("(document.getElementById('wcMini')||{}).textContent || ''")).slice(0, 40));
    await evalJs("(function(){var rows=document.querySelectorAll('#wcMini .wc-row');" +
      "for(var i=0;i<rows.length;i++){if(/同学/.test(rows[i].textContent)){rows[i].click();return 1;}}return 0;})()");
    ok('点收纳列表里的好友 → 弹出与他的私聊聊天窗口',
      await waitUntil("!!document.querySelector('.fb-chat')"));
    ok('私聊小窗里能看到对方名字',
      await evalJs("(function(){var w=document.querySelector('.fb-chat');return !!w && /同学/.test(w.textContent);})()"));
    await shot('chat-private');

    // 换页面（点链接式导航）→ 小窗要跟着过来
    await cdp.send('Page.navigate', { url: BASE + '/dodge/' });
    ok('换到游戏页面后控件还在', await waitUntil("!!document.getElementById('wb-chat')"));
    ok('换页面后私聊小窗自动恢复（没有被刷新掉）',
      await waitUntil("!!document.querySelector('.fb-chat')", 6000),
      await evalJs("document.querySelectorAll('.fb-chat').length + ' 个小窗'"));

    // 手动刷新 → 按约定清掉（这是用户明确要求的"除非手动刷新了网页"）
    await reload();
    await waitUntil("!!document.getElementById('wb-chat')");
    await sleep(1200);
    ok('手动刷新网页后私聊小窗不再自动弹出',
      await evalJs("document.querySelectorAll('.fb-chat').length") === 0);
    ok('手动刷新后控件本体仍在（控件本身不会被刷掉）',
      await evalJs("!!document.getElementById('wb-chat')") === true);

    /* ================= C. 房间频道：房间里所有人可见 ================= */
    console.log('\n== C. 对局聊天：进房间就有聊天区 / 房间内所有人可见 ==');
    const room = await peer('队友', '10.2.0.3', PORT_SRV);
    await evalJs("WB.Chat.enterRoom({game:'dodge', code:'4321', title:'方块躲避 · 房间 4321'})");
    await sleep(400);
    ok('进房间后出现「本局」页签', await evalJs("!document.querySelector('.wc-tab[data-ctab=\"room\"]').classList.contains('hidden')"));
    ok('进房间时自动展开到本局频道（创建房间就有聊天区）',
      await evalJs("!document.getElementById('wb-chat').classList.contains('min')") === true &&
      await evalJs("document.querySelector('.wc-tab[data-ctab=\"room\"]').classList.contains('on')") === true);
    room.send({ t: 'chat.join', channel: 'dodge:4321' });
    ok('另一个成员能看到成员列表里有 2 人',
      await waitUntil("!document.querySelector('.wc-tab[data-ctab=\"room\"]').classList.contains('hidden')") &&
      (await evalJs("(function(){var m=(WB.chat.room&&WB.chat.room.members)||[];return m.length;})()")) >= 1);

    await evalJs("(function(){var i=document.querySelector('#wcPane .wc-input input');i.value='这关的缝隙好窄';" +
      "var b=document.querySelector('#wcPane .wc-input button');b.click();return 1;})()");
    const got = await room.waitFor(m => m.t === 'chat.msg' && m.text === '这关的缝隙好窄');
    ok('本局发言房间里所有人都能看到（另一个成员收到了）', got.text === '这关的缝隙好窄', JSON.stringify(got));
    await evalJs("(function(){var i=document.querySelector('#wcPane .wc-input input');i.value='一起冲终点';" +
      "i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 1;})()");
    await sleep(300);
    ok('回车也能发送，并出现在自己的聊天区里',
      await evalJs("/一起冲终点/.test(document.querySelector('#wcPane .wc-msgs').textContent)"));
    ok('自己发的消息只出现一次（本地渲染 + 回显做了去重）',
      await evalJs("(function(){var t=document.querySelector('#wcPane .wc-msgs').textContent;" +
        "return (t.match(/一起冲终点/g)||[]).length;})()") === 1,
      '出现 ' + await evalJs("(function(){var t=document.querySelector('#wcPane .wc-msgs').textContent;return (t.match(/一起冲终点/g)||[]).length;})()") + ' 次');
    ok('自己的消息是自己那一侧的气泡（.wc-msg.me）',
      await evalJs("(function(){var ms=document.querySelectorAll('#wcPane .wc-msg');" +
        "for(var i=0;i<ms.length;i++){if(/一起冲终点/.test(ms[i].textContent))return ms[i].classList.contains('me');}return false;})()") === true);
    await shot('chat-room');

    room.send({ t: 'chat.send', channel: 'dodge:4321', text: '收到，我先探路' });
    ok('队友发言能在自己的聊天区看到',
      await waitUntil("/收到，我先探路/.test(document.querySelector('#wcPane .wc-msgs').textContent)"));
    const st = await getStatus();
    ok('/api/status 里能看到这个频道', st.chatChannels >= 1 && st.chatMembers >= 2,
      JSON.stringify({ chatChannels: st.chatChannels, chatMembers: st.chatMembers }));

    await evalJs("WB.Chat.leaveRoom()");
    await sleep(300);
    ok('离开房间后「本局」页签消失',
      await evalJs("document.querySelector('.wc-tab[data-ctab=\"room\"]').classList.contains('hidden')") === true);
    const st2 = await getStatus();
    ok('自己退出后频道里只剩队友 1 人', st2.chatMembers === 1, 'chatMembers=' + st2.chatMembers);
    room.close();
    await sleep(400);
    const st3 = await getStatus();
    ok('最后一人离开后频道被回收', st3.chatChannels === 0, 'chatChannels=' + st3.chatChannels);

    mate.close();
    ok('全流程无 JS 报错', errors.length === 0, errors.join(' | '));
  } catch (e) {
    fails++;
    console.error('\n[界面自检异常]', e.message);
  } finally {
    cdp.close();
    await sleep(200);
    srv.kill(); chrome.kill();
  }

  console.log('\n========================================');
  console.log('  聊天控件界面自检：' + passes + ' 项通过，' + fails + ' 项失败');
  console.log('========================================');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('\n[自检异常]', e); process.exit(1); });
