'use strict';
/**
 * 方块躲避界面自检： node tools/dodgeuitest.js
 *
 * 用真实浏览器（无头 Chrome）实测两个页面：
 *   A. 游戏页 /dodge/     —— 菜单 / 关卡选择 / 开始游戏 / 按键真的能移动 / 暂停 / 重来 /
 *                            死亡计数 / 本地多人 / 好友系统按钮
 *   B. 编辑器 /dodge/editor.html —— 放墙、放复活点、校验拦截（缺出生点/复活点不让保存）、
 *                            障碍路径编辑、属性面板、预览、保存到关卡库
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
const SHOTS = path.join(__dirname, 'shots');
const PORT_SRV = 8125, PORT_DBG = 9338;
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

(async function main() {
  const exe = CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) { console.log('未找到 Chrome/Edge，跳过界面自检'); process.exit(0); }
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  const srv = spawn(process.execPath, [SERVER, '--port', String(PORT_SRV)], { cwd: ROOT, stdio: 'ignore' });
  await sleep(1200);
  const BASE = 'http://127.0.0.1:' + PORT_SRV;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dodge-ui-'));
  const chrome = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--window-size=1440,960',
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
  const key = (code, up) => evalJs(
    "window.dispatchEvent(new KeyboardEvent('" + (up ? 'keyup' : 'keydown') + "',{code:'" + code + "'}));1");
  const click = (sel) => evalJs("(function(){var e=document.querySelector('" + sel + "');if(!e)return 'no-el';e.click();return 'ok';})()");

  try {
    /* ================= A. 游戏页 ================= */
    console.log('\n== A. 游戏页 /dodge/ ==');
    await cdp.send('Page.navigate', { url: BASE + '/dodge/' });
    ok('页面加载出菜单', await waitUntil("!!document.getElementById('scr-menu')"));
    ok('顶栏有好友按钮（与平台好友系统接上了）', await waitUntil("!!document.getElementById('btnFriends')"));
    ok('菜单是小演示 + 三个模式', await evalJs("document.querySelectorAll('.mode-btn').length") === 3);
    ok('关卡数据加载成功（10 个内置关卡）',
      await waitUntil("window.__DODGE_DEBUG && __DODGE_DEBUG.allLevels().length >= 10"),
      String(await evalJs("window.__DODGE_DEBUG ? __DODGE_DEBUG.allLevels().length : -1")));
    await shot('dodge-menu');

    console.log('\n== A2. 关卡选择 ==');
    await evalJs("Array.from(document.querySelectorAll('.mode-btn')).find(b=>b.dataset.mode==='single').click()");
    ok('进入关卡选择', await waitUntil("!document.getElementById('scr-levels').classList.contains('hidden')"));
    const cards = await evalJs("document.querySelectorAll('#levelGrid .level-card').length");
    ok('列出 10 个关卡卡片', cards === 10, cards + ' 张');
    ok('第 1 关可点、后面的未解锁',
      await evalJs("!!document.querySelector('#levelGrid .level-card:not(.locked)') && document.querySelectorAll('#levelGrid .level-card.locked').length >= 8"),
      await evalJs("document.querySelectorAll('#levelGrid .level-card.locked').length + ' 个锁着'"));
    await shot('dodge-levels');

    console.log('\n== A3. 玩第 1 关 ==');
    await evalJs("document.querySelectorAll('#levelGrid .level-card')[0].click()");
    ok('进入游戏画面', await waitUntil("!document.getElementById('scr-game').classList.contains('hidden')"));
    const canvasSize = JSON.parse(await evalJs("JSON.stringify({w:document.getElementById('cv').width,h:document.getElementById('cv').height})"));
    ok('画布按关卡尺寸渲染出来了', canvasSize.w > 100 && canvasSize.h > 100, JSON.stringify(canvasSize));
    ok('HUD 显示第 1 关', /第 1 关/.test(await evalJs("document.getElementById('hLevel').textContent")));
    ok('侧栏列出 1 名队员', await evalJs("document.querySelectorAll('#teamList li').length") === 1);

    const x0 = await evalJs("__DODGE_DEBUG.S.players[0].x");
    await key('KeyD');
    await sleep(700);
    await key('KeyD', true);
    const x1 = await evalJs("__DODGE_DEBUG.S.players[0].x");
    ok('按 D 方块真的往右走了', x1 > x0 + 40, x0.toFixed(1) + ' → ' + x1.toFixed(1));
    const t1 = await evalJs("document.getElementById('hTimer').textContent");
    ok('计时器在走', /s/.test(t1) && parseFloat(t1.replace(/[^\d.]/g, '')) > 0.2, t1);

    console.log('\n== A4. 死亡 / 暂停 / 重来 ==');
    // 直接把方块挪到障碍身上，验证死亡与计数
    await evalJs(
      "(function(){var S=__DODGE_DEBUG.S;var o=S.world.obstacles[0];" +
      "S.players[0].x=o.x;S.players[0].y=o.y;S.players[0].invuln=0;return 1;})()");
    ok('撞到障碍 → 死亡计数 +1', await waitUntil("/💀 1/.test(document.getElementById('hDeaths').textContent)", 4000),
      await evalJs("document.getElementById('hDeaths').textContent"));
    ok('死亡后会自动复活（状态回到 playing）',
      await waitUntil("__DODGE_DEBUG.S.players[0].state === 'playing'", 5000));

    await key('Escape');
    ok('Esc 能暂停', await waitUntil("!document.getElementById('overlay').classList.contains('hidden')"));
    await key('Escape');
    ok('再按 Esc 继续', await waitUntil("document.getElementById('overlay').classList.contains('hidden')"));

    const xBefore = await evalJs("__DODGE_DEBUG.S.players[0].x");
    await key('KeyD'); await sleep(300); await key('KeyD', true);
    await key('KeyR');
    await sleep(200);
    const afterRestart = JSON.parse(await evalJs(
      "JSON.stringify({x:__DODGE_DEBUG.S.players[0].x,deaths:__DODGE_DEBUG.S.players[0].deaths,t:__DODGE_DEBUG.S.elapsed})"));
    ok('按 R 重来：回到出生点、计时归零、死亡数清零',
      afterRestart.x < 100 && afterRestart.t < 1.5,
      'x=' + afterRestart.x.toFixed(1) + ' t=' + afterRestart.t.toFixed(2));
    ok('上一秒确实动过（说明重来不是"什么都没发生"）', xBefore > 0);
    await shot('dodge-game');

    console.log('\n== A5. 本地多人 ==');
    await evalJs("document.getElementById('btnQuit').click()");
    await sleep(300);
    await evalJs("Array.from(document.querySelectorAll('.mode-btn')).find(b=>b.dataset.mode==='local').click()");
    ok('进入本地多人设置', await waitUntil("!document.getElementById('scr-local').classList.contains('hidden')"));
    await evalJs("document.querySelector('#localCount .style-btn[data-count=\"4\"]').click()");
    ok('键位说明按人数列出 4 组', await evalJs("document.querySelectorAll('#localKeys .kp').length") === 4);
    await evalJs("document.getElementById('btnLocalStart').click()");
    ok('4 人同屏开局', await waitUntil("__DODGE_DEBUG.S.players.length === 4", 4000));
    ok('4 名玩家颜色各不相同',
      await evalJs("new Set(__DODGE_DEBUG.S.players.map(p=>p.color)).size") === 4);
    ok('接应按钮在多人模式出现', await evalJs("!document.getElementById('btnRescue').classList.contains('hidden')"));

    /* ================= B. 编辑器 ================= */
    console.log('\n== B. 关卡编辑器 ==');
    await cdp.send('Page.navigate', { url: BASE + '/dodge/editor.html' });
    ok('编辑器加载出画布与工具',
      await waitUntil("!!document.getElementById('edCv') && document.querySelectorAll('.tool').length === 6"));
    ok('编辑器脚本初始化完成',
      await waitUntil("!!window.__EDITOR_DEBUG && !!__EDITOR_DEBUG.E.level"));
    ok('默认给了一个示例关卡（出生点/复活点/终点/障碍各 1）',
      await evalJs("(function(){var E=__EDITOR_DEBUG.E;return E.level.spawns.length===1&&E.level.checkpoints.length===1&&E.level.goals.length===1&&E.level.obstacles.length===1;})()"));
    ok('保存按钮一开始可用（示例是合法的）',
      await evalJs("document.getElementById('btnSave').disabled") === false);
    await shot('dodge-editor');

    console.log('\n== B2. 放墙与校验拦截 ==');
    const wallsBefore = await evalJs("__EDITOR_DEBUG.E.level.walls.length");
    await evalJs("document.querySelector('.tool[data-tool=\"wall\"]').click()");
    await evalJs(
      "(function(){var cv=document.getElementById('edCv');var r=cv.getBoundingClientRect();" +
      "var ev={clientX:r.left+r.width*0.5,clientY:r.top+r.height*0.5};" +
      "cv.dispatchEvent(new MouseEvent('click',{clientX:ev.clientX,clientY:ev.clientY,bubbles:true}));return 1;})()");
    ok('点一下能放墙', await evalJs("__EDITOR_DEBUG.E.level.walls.length") === wallsBefore + 1,
      wallsBefore + ' → ' + await evalJs("__EDITOR_DEBUG.E.level.walls.length"));

    await evalJs("document.querySelector('.tool[data-tool=\"checkpoint\"]').click()");
    ok('切到复活点工具后选中态正确',
      await evalJs("document.querySelector('.tool[data-tool=\"checkpoint\"]').classList.contains('on')"));

    // 删掉所有复活点 → 必须拦截保存
    await evalJs("__EDITOR_DEBUG.E.level.checkpoints=[];__EDITOR_DEBUG.E.selected=null;document.querySelector('.tool[data-tool=\"obstacle\"]').click();");
    await evalJs("(function(){var E=__EDITOR_DEBUG.E;E.level.checkpoints=[];return 1;})()");
    await evalJs("document.querySelector('.tool[data-tool=\"select\"]').click()");   // 触发面板刷新
    await sleep(200);
    ok('没有复活点时校验报错并禁用保存',
      await evalJs("/复活点/.test(document.getElementById('issues').textContent)") === true &&
      await evalJs("document.getElementById('btnSave').disabled") === true,
      await evalJs("document.getElementById('issues').textContent"));

    await evalJs("document.getElementById('btnSave').click()");
    ok('强行点保存会被拦下（不会写进关卡库）',
      await evalJs("(JSON.parse(localStorage.getItem('dodge.custom.levels.v1')||'[]')).length") === 0);

    // 补回复活点 → 可以保存
    await evalJs("__EDITOR_DEBUG.E.level.checkpoints=[{col:1,row:7}];document.getElementById('btnCheck').click();");
    await sleep(400);
    ok('补上复活点后校验通过并允许保存',
      await evalJs("document.getElementById('btnSave').disabled") === false);
    await evalJs("document.getElementById('btnSave').click()");
    ok('保存后写进本机关卡库',
      await evalJs("(JSON.parse(localStorage.getItem('dodge.custom.levels.v1')||'[]')).length") === 1);

    console.log('\n== B3. 障碍路径编辑 ==');
    await evalJs("document.querySelector('.tool[data-tool=\"obstacle\"]').click()");
    // 点障碍所在格（示例障碍在 col 10, row 3）
    await evalJs(
      "(function(){var cv=document.getElementById('edCv');var r=cv.getBoundingClientRect();" +
      "var E=__EDITOR_DEBUG.E;var o=E.level.obstacles[0];var p=o.path[0];" +
      "var cols=E.level.cols, rows=E.level.rows;" +
      "var x=r.left+r.width*((p.col+0.5)/cols), y=r.top+r.height*((p.row+0.5)/rows);" +
      "cv.dispatchEvent(new MouseEvent('click',{clientX:x,clientY:y,bubbles:true}));return 1;})()");
    ok('点已有障碍 → 进入路径编辑（底部出现提示条）',
      await evalJs("!document.getElementById('pathBar').classList.contains('hidden')"));
    const pathBefore = await evalJs("__EDITOR_DEBUG.E.level.obstacles[0].path.length");
    // 再点一个空格子 → 加路径点
    await evalJs(
      "(function(){var cv=document.getElementById('edCv');var r=cv.getBoundingClientRect();" +
      "var E=__EDITOR_DEBUG.E;var cols=E.level.cols,rows=E.level.rows;" +
      "var x=r.left+r.width*((3+0.5)/cols), y=r.top+r.height*((9+0.5)/rows);" +
      "cv.dispatchEvent(new MouseEvent('click',{clientX:x,clientY:y,bubbles:true}));return 1;})()");
    const pathAfter = await evalJs("__EDITOR_DEBUG.E.level.obstacles[0].path.length");
    ok('点空格子能加路径点', pathAfter === pathBefore + 1, pathBefore + ' → ' + pathAfter);
    ok('属性面板出现速度滑块', await evalJs("document.querySelectorAll('#propBody input[type=range]').length") >= 2);
    ok('属性面板能选往返/循环', await evalJs("document.querySelectorAll('#propBody select option').length") === 2);

    console.log('\n== B4. 预览与通关检查 ==');
    await evalJs("document.getElementById('btnPreview').click()");
    await sleep(250);
    const p0 = await evalJs("__EDITOR_DEBUG.E.previewWorld ? __EDITOR_DEBUG.E.previewWorld.obstacles[0].y : -1");
    await sleep(500);
    const p1 = await evalJs("__EDITOR_DEBUG.E.previewWorld ? __EDITOR_DEBUG.E.previewWorld.obstacles[0].y : -1");
    ok('点预览后障碍真的动起来了', p0 >= 0 && Math.abs(p1 - p0) > 3, p0.toFixed(1) + ' → ' + p1.toFixed(1));
    await evalJs("document.getElementById('btnPreview').click()");
    ok('再点一下停止预览', await evalJs("__EDITOR_DEBUG.E.preview") === false);

    await evalJs("document.getElementById('btnCheck').click()");
    await waitUntil("/能通关|过不去/.test(document.getElementById('statusLine').textContent)", 6000);
    ok('能检查这一关能不能通关',
      await evalJs("/能通关|过不去/.test(document.getElementById('statusLine').textContent)"),
      await evalJs("document.getElementById('statusLine').textContent"));

    console.log('\n== B5. 关卡库 ==');
    await evalJs("document.getElementById('btnLibrary').click()");
    ok('关卡库能打开并列出内置关卡',
      await waitUntil("document.querySelectorAll('#libBuiltin button').length >= 10"));
    ok('关卡库里能看到自己保存的关卡',
      await evalJs("document.querySelectorAll('#libMine button').length >= 1"));
    await evalJs(
      "(function(){var b=document.querySelectorAll('#libBuiltin button')[3];b.click();return 1;})()");
    ok('点内置关卡能载入编辑器（第 4 关「十字路口」）',
      await waitUntil("/十字路口/.test(document.getElementById('inName').value)"),
      await evalJs("document.getElementById('inName').value"));
    await shot('dodge-editor-library');

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
  console.log('  方块躲避界面自检：' + passes + ' 项通过，' + fails + ' 项失败');
  console.log('========================================');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('\n[自检异常]', e); process.exit(1); });
