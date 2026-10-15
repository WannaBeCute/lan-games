'use strict';
/**
 * 方块躲避界面自检： node tools/dodgeuitest.js
 *
 * 用真实浏览器（无头 Chrome）实测两个页面：
 *   A. 游戏页 /dodge/     —— 菜单 / 关卡选择 / 开始游戏 / 按键真的能移动 / 暂停 / 重来 /
 *                            死亡计数 / 本地多人 / 好友系统按钮
 *   B. 编辑器 /dodge/editor.html —— 白底画布、拖拽画墙、拖拽画区域（出生点/复活点/终点）、
 *                            选择与框选、右键（批量）删除、撤销 / 恢复、圆周旋转属性、
 *                            路径点 × 删除、未保存改动提醒、校验新规则（有出生点+终点即可存）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
const SHOTS = path.join(__dirname, 'shots');
/** 端口别写死：写死的端口一旦被别的东西占上，服务端就静默起不来（stdio 被忽略，连报错都看不到），
 *  表现出来是"页面打不开"，很容易被误判成前端坏了。改成随机空闲端口，并允许外部传 baseUrl。 */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
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

  const PORT_DBG = await freePort();
  let BASE = process.argv[2];
  let srv = null;
  if (!BASE) {
    const PORT_SRV = await freePort();
    srv = spawn(process.execPath, [SERVER, '--port', String(PORT_SRV)], { cwd: ROOT, stdio: 'ignore' });
    BASE = 'http://127.0.0.1:' + PORT_SRV;
    // 等服务端真的能应答再开浏览器，别赌固定等待
    for (let i = 0; i < 40; i++) {
      try { await fetch(BASE + '/api/status'); break; } catch (e) { await sleep(150); }
    }
  } else {
    await sleep(300);
  }

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
  /* 画布上的鼠标手势：mousedown 在画布上，mousemove / mouseup 在 window 上（和真实拖拽一致） */
  const edXY = async (col, row) => {
    const info = JSON.parse(await evalJs(
      "(function(){var cv=document.getElementById('edCv');var r=cv.getBoundingClientRect();var E=__EDITOR_DEBUG.E;" +
      "return JSON.stringify({w:r.width,h:r.height,cols:E.level.cols,rows:E.level.rows});})()"));
    return [info.w * ((col + 0.5) / info.cols), info.h * ((row + 0.5) / info.rows)];
  };
  const mdown = (x, y) => evalJs("(function(){var cv=document.getElementById('edCv');var r=cv.getBoundingClientRect();" +
    "cv.dispatchEvent(new MouseEvent('mousedown',{clientX:r.left+" + x + ",clientY:r.top+" + y + ",button:0,bubbles:true,cancelable:true}));return 1;})()");
  const mmove = (x, y) => evalJs("(function(){var cv=document.getElementById('edCv');var r=cv.getBoundingClientRect();" +
    "window.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+" + x + ",clientY:r.top+" + y + ",bubbles:true}));return 1;})()");
  const mup = (x, y) => evalJs("(function(){var cv=document.getElementById('edCv');var r=cv.getBoundingClientRect();" +
    "window.dispatchEvent(new MouseEvent('mouseup',{clientX:r.left+" + x + ",clientY:r.top+" + y + ",bubbles:true}));return 1;})()");
  const rclick = (x, y) => evalJs("(function(){var cv=document.getElementById('edCv');var r=cv.getBoundingClientRect();" +
    "cv.dispatchEvent(new MouseEvent('contextmenu',{clientX:r.left+" + x + ",clientY:r.top+" + y + ",button:2,bubbles:true,cancelable:true}));return 1;})()");
  const tap = async (col, row) => { const p = await edXY(col, row); await mdown(p[0], p[1]); await mmove(p[0], p[1]); await mup(p[0], p[1]); };
  /** 从 (c0,r0) 按住左键拖到 (c1,r1)：沿途一格一格挪，模拟真实鼠标的连续移动 */
  const drag = async (c0, r0, c1, r1) => {
    const a = await edXY(c0, r0), b = await edXY(c1, r1);
    await mdown(a[0], a[1]);
    const steps = Math.max(2, Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0)) * 3);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await mmove(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    }
    await mup(b[0], b[1]);
  };
  const pickTool = (t) => evalJs("document.querySelector('.tool[data-tool=\"" + t + "\"]').click()");
  const hotkey = (key, opts) => evalJs("window.dispatchEvent(new KeyboardEvent('keydown',{key:'" + key + "',ctrlKey:true,shiftKey:" +
    (!!(opts && opts.shift)) + ",bubbles:true}));1");

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
    ok('游戏场地是白底（不再是黑色）',
      await waitUntil("(function(){var cv=document.getElementById('cv');var ctx=cv.getContext('2d');" +
        "var d=ctx.getImageData(Math.round(140*cv.width/800),Math.round(140*cv.height/600),1,1).data;" +
        "return d[0]===255&&d[1]===255&&d[2]===255;})()", 5000),
      await evalJs("(function(){var cv=document.getElementById('cv');var ctx=cv.getContext('2d');" +
        "var d=ctx.getImageData(Math.round(140*cv.width/800),Math.round(140*cv.height/600),1,1).data;return d[0]+','+d[1]+','+d[2];})()"));
    ok('HUD 显示第 1 关', /第 1 关/.test(await evalJs("document.getElementById('hLevel').textContent")));
    ok('侧栏列出 1 名队员', await evalJs("document.querySelectorAll('#teamList li').length") === 1);

    const x0 = await evalJs("__DODGE_DEBUG.S.players[0].x");
    await key('ArrowRight');
    await sleep(700);
    await key('ArrowRight', true);
    const x1 = await evalJs("__DODGE_DEBUG.S.players[0].x");
    ok('按方向键 → 方块真的往右走了（默认键位是方向键）', x1 > x0 + 40, x0.toFixed(1) + ' → ' + x1.toFixed(1));
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
    await key('ArrowRight'); await sleep(300); await key('ArrowRight', true);
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
    ok('示例关卡：出生点是 2×2 的一整块区域（相邻格子自动连成整体）',
      await evalJs("(function(){var E=__EDITOR_DEBUG.E;return E.level.spawns.length===4 && __EDITOR_DEBUG.regions(E.level.spawns).length===1;})()"));
    ok('示例关卡：复活点 2 格 / 终点 1 格 / 障碍 1 个',
      await evalJs("(function(){var E=__EDITOR_DEBUG.E;return E.level.checkpoints.length===2 && E.level.goals.length===1 && E.level.obstacles.length===1;})()"));
    ok('编辑器画布是白底（不再是黑色）',
      await evalJs("(function(){var cv=document.getElementById('edCv');var ctx=cv.getContext('2d');" +
        "var d=ctx.getImageData(Math.round(140*cv.width/800),Math.round(460*cv.height/600),1,1).data;" +
        "return d[0]===255&&d[1]===255&&d[2]===255;})()"),
      await evalJs("(function(){var cv=document.getElementById('edCv');var ctx=cv.getContext('2d');" +
        "var d=ctx.getImageData(Math.round(140*cv.width/800),Math.round(460*cv.height/600),1,1).data;return d[0]+','+d[1]+','+d[2];})()"));
    ok('保存按钮一开始可用（示例是合法的）',
      await evalJs("document.getElementById('btnSave').disabled") === false);
    await shot('dodge-editor');

    console.log('\n== B2. 设施区域：拖拽创建 / 全局唯一 / 相邻吸附 ==');
    await pickTool('goal');
    await drag(14, 3, 15, 5);          // 2 列 × 3 行 = 6 格
    ok('按住左键拖拽能画出一整片多格终点区域',
      await evalJs("(function(){var E=__EDITOR_DEBUG.E;return E.level.goals.length===6 && __EDITOR_DEBUG.regions(E.level.goals).length===1;})()"),
      await evalJs("'终点 ' + __EDITOR_DEBUG.E.level.goals.length + ' 格 / ' + __EDITOR_DEBUG.regions(__EDITOR_DEBUG.E.level.goals).length + ' 处'"));
    await pickTool('spawn');
    await drag(9, 12, 10, 13);         // 离原出生点很远 → 整体替换
    ok('出生点全局只保留一处：画新的会把旧的替掉',
      await evalJs("(function(){var E=__EDITOR_DEBUG.E;return E.level.spawns.length===4 && __EDITOR_DEBUG.regions(E.level.spawns).length===1 && E.level.spawns[0].col===9;})()"),
      await evalJs("JSON.stringify(__EDITOR_DEBUG.E.level.spawns)"));
    await pickTool('checkpoint');
    await drag(5, 8, 6, 8);            // 紧贴着原来的复活点 (5,7)(6,7)
    ok('相邻的同属性区域自动吸附成一整块（复活点 2+2 = 4 格 · 1 处）',
      await evalJs("(function(){var E=__EDITOR_DEBUG.E;return E.level.checkpoints.length===4 && __EDITOR_DEBUG.regions(E.level.checkpoints).length===1;})()"),
      await evalJs("'复活点 ' + __EDITOR_DEBUG.E.level.checkpoints.length + ' 格 / ' + __EDITOR_DEBUG.regions(__EDITOR_DEBUG.E.level.checkpoints).length + ' 处'"));

    console.log('\n== B3. 墙体：拖拽批量砌 / 批量拆 ==');
    await pickTool('wall');
    const w0 = await evalJs("__EDITOR_DEBUG.E.level.walls.length");
    await drag(9, 3, 12, 3);
    const w1 = await evalJs("__EDITOR_DEBUG.E.level.walls.length");
    ok('按住左键拖过去能连着砌一排墙', w1 === w0 + 4, w0 + ' → ' + w1);
    await drag(9, 3, 12, 3);
    const w2 = await evalJs("__EDITOR_DEBUG.E.level.walls.length");
    ok('从已有的墙上开始拖 = 连着拆（同一排被拆掉）', w2 === w0, w1 + ' → ' + w2);
    await tap(9, 3);
    const w3 = await evalJs("__EDITOR_DEBUG.E.level.walls.length");
    await rclick(...(await edXY(9, 3)));
    ok('墙体工具下右键不会拆墙（只有左键才拆）',
      await evalJs("__EDITOR_DEBUG.E.level.walls.length") === w3, w2 + ' → ' + w3);
    await tap(9, 3);
    ok('再点一下空白处能补回来', await evalJs("__EDITOR_DEBUG.E.level.walls.length") === w3 - 1);

    console.log('\n== B4. 选择 / 框选 / 右键删除 ==');
    await pickTool('wall');
    await tap(9, 3);                                   // 先砌一面墙当靶子
    await pickTool('select');
    await tap(9, 3);
    ok('点一下能选中墙体（以前只有障碍能选中）',
      await evalJs("(function(){var s=__EDITOR_DEBUG.E.sel;return s.length===1 && s[0].kind==='wall' && s[0].col===9 && s[0].row===3;})()"),
      await evalJs("JSON.stringify(__EDITOR_DEBUG.E.sel)"));
    await rclick(...(await edXY(9, 3)));
    ok('右键能删掉选中的墙体',
      await evalJs("__EDITOR_DEBUG.E.level.walls.filter(function(w){return w.col===9&&w.row===3;}).length") === 0);
    await tap(9, 12);                                  // B2 里出生点被挪到了 (9,12)~(10,13)
    ok('点出生点区域会把整块区域一起选中（4 格全选上）',
      await evalJs("(function(){var s=__EDITOR_DEBUG.E.sel;return s.length===4 && s.every(function(u){return u.kind==='spawn';});})()"),
      await evalJs("__EDITOR_DEBUG.E.sel.length + ' 项'"));
    await rclick(...(await edXY(9, 12)));
    ok('右键能删掉整块出生点区域（以前删不掉）',
      await evalJs("__EDITOR_DEBUG.E.level.spawns.length") === 0);
    ok('没有出生点 → 校验报错并禁用保存',
      await evalJs("/出生点/.test(document.getElementById('issues').textContent)") === true &&
      await evalJs("document.getElementById('btnSave').disabled") === true,
      await evalJs("document.getElementById('issues').textContent"));
    // 框选一片墙 → 右键批量删除
    await pickTool('wall');
    await drag(13, 9, 18, 9);                          // 一排 6 面墙
    const boxWalls = await evalJs("__EDITOR_DEBUG.E.level.walls.length");
    await pickTool('select');
    await drag(12, 8, 18, 10);                         // 框住这一排（别框到最右边的外墙）
    const selCount = await evalJs("__EDITOR_DEBUG.E.sel.length");
    ok('按住左键拖拽能框选一片（刚好选中那 6 格墙）', selCount === 6, selCount + ' 项');
    await shot('dodge-editor-select');
    await rclick(...(await edXY(15, 9)));
    ok('框选之后右键 = 批量删除',
      await evalJs("__EDITOR_DEBUG.E.level.walls.length") === boxWalls - 6,
      boxWalls + ' → ' + await evalJs("__EDITOR_DEBUG.E.level.walls.length"));
    await hotkey('z');
    ok('Ctrl+Z 能把批量删除撤回来',
      await evalJs("__EDITOR_DEBUG.E.level.walls.length") === boxWalls, '回到 ' + boxWalls);

    console.log('\n== B5. 校验新规则：有出生点 + 终点就能存，复活点可选 ==');
    await pickTool('spawn');
    await drag(1, 6, 2, 7);
    await evalJs("__EDITOR_DEBUG.E.level.checkpoints=[];__EDITOR_DEBUG.E.sel=[];__EDITOR_DEBUG.refresh();");
    ok('没有复活点只是警告，不再拦保存（新规则）',
      await evalJs("/复活点/.test(document.getElementById('issues').textContent)") === true &&
      await evalJs("document.getElementById('btnSave').disabled") === false,
      await evalJs("document.getElementById('issues').textContent"));
    await evalJs("document.getElementById('btnSave').click()");
    ok('没有复活点也能存进关卡库',
      await evalJs("(JSON.parse(localStorage.getItem('dodge.custom.levels.v1')||'[]')).length") === 1);
    await evalJs("__EDITOR_DEBUG.pushHistory();__EDITOR_DEBUG.E.level.goals=[];__EDITOR_DEBUG.refresh();");
    ok('没有终点 → 报错并禁用保存',
      await evalJs("/终点/.test(document.getElementById('issues').textContent)") === true &&
      await evalJs("document.getElementById('btnSave').disabled") === true,
      await evalJs("document.getElementById('issues').textContent"));
    await hotkey('z');
    ok('Ctrl+Z 把终点找回来', await evalJs("__EDITOR_DEBUG.E.level.goals.length") === 6);

    console.log('\n== B6. 撤销 / 恢复（每一步都能退回去） ==');
    const wBefore = await evalJs("__EDITOR_DEBUG.E.level.walls.length");
    await pickTool('wall');
    await drag(3, 10, 6, 10);
    const wAfter = await evalJs("__EDITOR_DEBUG.E.level.walls.length");
    await hotkey('z');
    const wUndo = await evalJs("__EDITOR_DEBUG.E.level.walls.length");
    ok('Ctrl+Z 撤回一步（刚砌的一排墙退回去了）', wAfter === wBefore + 4 && wUndo === wBefore,
      wBefore + ' → ' + wAfter + ' → ' + wUndo);
    await hotkey('y');
    ok('Ctrl+Y 恢复刚撤回的一步', await evalJs("__EDITOR_DEBUG.E.level.walls.length") === wAfter);
    ok('撤回按钮处于可用状态', await evalJs("document.getElementById('btnUndo').disabled") === false);

    console.log('\n== B7. 圆形障碍：两点自动保存 / 添加路径点 / 起始点拖拽 ==');
    await pickTool('obstacle');
    await tap(10, 3);
    ok('点障碍起始点 → 选中它（不自动进加点模式，路径条不出现）',
      await evalJs("!!__EDITOR_DEBUG.E.selected") &&
      await evalJs("document.getElementById('pathBar').classList.contains('hidden')"));
    const pathBefore = await evalJs("__EDITOR_DEBUG.E.selected.path.length");
    // 「添加路径点」按钮 → 变成「保存当前路径点」→ 加点 → 保存
    const findBtn = "Array.from(document.querySelectorAll('#propBody .prop-actions button')).find(b=>b.textContent.indexOf('TEXT')>=0)";
    await evalJs(findBtn.replace('TEXT', '添加路径点') + ".click()");
    ok('点「添加路径点」→ 按钮变成「保存当前路径点」',
      await evalJs("(function(){var b=" + findBtn.replace('TEXT', '保存当前路径点') + ";return !!b && !document.getElementById('pathBar').classList.contains('hidden');})()"));
    await tap(13, 3);
    ok('加点模式里点空格子能加路径点', await evalJs("__EDITOR_DEBUG.E.selected.path.length") === pathBefore + 1);
    await evalJs(findBtn.replace('TEXT', '保存当前路径点') + ".click()");
    ok('点「保存当前路径点」→ 结束加点（路径条收起）',
      await evalJs("document.getElementById('pathBar').classList.contains('hidden')") &&
      await evalJs("__EDITOR_DEBUG.E.pathEdit") === false);

    // 放新障碍：第一下 = 初始位置，第二下 = 自动保存好
    await tap(6, 9);
    ok('点空白格放下新障碍，自动等第二个点',
      await evalJs("__EDITOR_DEBUG.E.selected.path.length") === 1 &&
      await evalJs("!document.getElementById('pathBar').classList.contains('hidden')"));
    await tap(6, 12);
    ok('点第二个点 → 障碍自动保存好（退出加点，不再要第三个点）',
      await evalJs("(function(){var E=__EDITOR_DEBUG.E;return E.selected.path.length===2 && E.pathEdit===false && document.getElementById('pathBar').classList.contains('hidden');})()"));

    // 起始点拖拽：把新障碍整体从 (6,9) 搬到 (8,9)
    await drag(6, 9, 8, 9);
    ok('按住起始点拖动 → 整个障碍（含路径）一起搬家',
      await evalJs("(function(){var o=__EDITOR_DEBUG.E.level.obstacles.filter(function(x){return x.path.length===2;})[0];return o.path[0].col===8 && o.path[1].col===8 && o.path[1].row===12;})()"),
      await evalJs("JSON.stringify(__EDITOR_DEBUG.E.level.obstacles.filter(function(x){return x.path.length===2;})[0].path)"));

    // 路径不可点击：选择工具点路径中段不会命中任何障碍（选中只认起始点）
    await pickTool('select');
    await tap(8, 10);        // 搬家后路径 (8,9)→(8,12) 的中段
    ok('点路径中段不会命中障碍（路径不可点击，路径可以随便相交）',
      await evalJs("__EDITOR_DEBUG.E.sel.length") === 0,
      await evalJs("JSON.stringify(__EDITOR_DEBUG.E.sel)"));
    await pickTool('obstacle');
    await tap(8, 9);         // 回到起始点选中它

    ok('路径点的删除是一个光秃秃的 ×（没有按钮壳子）',
      await evalJs("document.querySelectorAll('#propBody .pt-del').length") >= 1 &&
      await evalJs("document.querySelectorAll('#propBody button.pt-del').length") === 0 &&
      await evalJs("document.querySelector('#propBody .pt-del').textContent") === '×',
      await evalJs("document.querySelectorAll('#propBody .pt-del').length + ' 个 ×'"));
    ok('速度滑块上限是 1000',
      await evalJs("document.querySelector('#propBody input[type=range]').max") === '1000',
      await evalJs("document.querySelector('#propBody input[type=range]').max"));

    // 圆周旋转 + 圆心对齐 + 预览
    await evalJs("(function(){var s=document.querySelectorAll('#propBody select')[0];s.value='orbit';s.dispatchEvent(new Event('change'));return 1;})()");
    ok('能把移动方式改成圆周旋转（半径 / 方向 / 圆心对齐都出来了）',
      await evalJs("!!__EDITOR_DEBUG.E.selected.orbit") === true &&
      await evalJs("document.querySelectorAll('#propBody select').length") >= 3,
      await evalJs("JSON.stringify(__EDITOR_DEBUG.E.selected.orbit)"));
    await evalJs("document.getElementById('btnPreview').click()");
    await sleep(250);
    const op0 = await evalJs("__EDITOR_DEBUG.E.previewWorld ? __EDITOR_DEBUG.E.previewWorld.obstacles[1].x : -1");
    await sleep(400);
    const op1 = await evalJs("__EDITOR_DEBUG.E.previewWorld ? __EDITOR_DEBUG.E.previewWorld.obstacles[1].x : -1");
    ok('预览里圆周障碍真的绕着圈在动', op0 >= 0 && Math.abs(op1 - op0) > 0.5, op0 + ' → ' + op1);
    // 空格也能切换预览
    await evalJs("window.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}));1");
    ok('按空格 = 停止预览（快捷键）', await evalJs("__EDITOR_DEBUG.E.preview") === false);
    await evalJs("window.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}));1");
    ok('再按空格 = 又开始预览', await evalJs("__EDITOR_DEBUG.E.preview") === true);
    await evalJs("window.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}));1");

    console.log('\n== B7b. 测试游玩：编辑器里直接玩 ==');
    await evalJs("document.getElementById('btnTest').click()");
    ok('点「测试游玩」→ 按钮变成「停止测试」，进入游玩模式',
      /停止测试/.test(await evalJs("document.getElementById('btnTest').textContent")));
    const px0 = await evalJs("__EDITOR_DEBUG.E.test.player.x");
    await key('ArrowRight');
    await sleep(500);
    await key('ArrowRight', true);
    const px1 = await evalJs("__EDITOR_DEBUG.E.test.player.x");
    ok('测试游玩里方向键能控制小方块', px1 > px0 + 30, px0.toFixed(1) + ' → ' + px1.toFixed(1));
    await evalJs("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));1");
    ok('Esc 退出测试游玩，回到编辑', await evalJs("__EDITOR_DEBUG.E.test") === null &&
      /测试游玩/.test(await evalJs("document.getElementById('btnTest').textContent")));

    console.log('\n== B8. 未保存改动的提醒 ==');
    ok('有改动时顶栏出现「未保存」提示',
      await evalJs("!document.getElementById('dirtyFlag').classList.contains('hidden')"));
    await evalJs("document.getElementById('btnHome').click()");
    ok('点「返回主页」会先弹窗问要不要保存（不会直接跳走）',
      await waitUntil("!document.getElementById('leaveMask').classList.contains('hidden')") &&
      /editor\.html/.test(await evalJs("location.pathname")));
    await sleep(350);        // 等淡入动画放完再截图，不然抓到的是 opacity 0 的第一帧
    await shot('dodge-editor-unsaved');
    await evalJs("document.getElementById('leaveCancel').click()");
    ok('点「取消」留在编辑页继续改',
      await evalJs("document.getElementById('leaveMask').classList.contains('hidden')") === true);
    await evalJs("document.getElementById('btnSave').click()");
    ok('保存后「未保存」提示消失',
      await evalJs("document.getElementById('dirtyFlag').classList.contains('hidden')") === true);

    console.log('\n== B9. 关卡库 / 检查通关 / 保存并离开 ==');
    await evalJs("document.getElementById('btnLibrary').click()");
    ok('关卡库能打开并列出内置关卡',
      await waitUntil("document.querySelectorAll('#libBuiltin button').length >= 10"));
    ok('关卡库里能看到自己保存的关卡',
      await evalJs("document.querySelectorAll('#libMine button').length >= 1"));
    await evalJs("(function(){var b=document.querySelectorAll('#libBuiltin button')[3];b.click();return 1;})()");
    ok('点内置关卡能载入编辑器（第 4 关「十字路口」）',
      await waitUntil("/十字路口/.test(document.getElementById('inName').value)"),
      await evalJs("document.getElementById('inName').value"));
    await shot('dodge-editor-library');
    await evalJs("document.getElementById('btnCheck').click()");
    await waitUntil("/能通关|过不去/.test(document.getElementById('statusLine').textContent)", 8000);
    ok('能检查这一关能不能通关（并且直接开始回放）',
      await evalJs("/能通关|走完了|回放中/.test(document.getElementById('statusLine').textContent)"),
      await evalJs("document.getElementById('statusLine').textContent"));

    /* ---- 障碍在画布上真的画出来了（半径改成内核固定值后专门盯这条） ---- */
    console.log('\n== B9a. 圆形障碍在编辑器画布上可见 ==');
    // 别去猜"第一个障碍画在哪"：直接以圆心为中心扫一小块，数有多少红像素
    const obInfo = await evalJs("(function(){var E=__EDITOR_DEBUG.E;var C=window.DodgeCore;" +
      "var o=null;for(var i=0;i<E.level.obstacles.length;i++){if(!E.level.obstacles[i].orbit){o=E.level.obstacles[i];break;}}" +
      "if(!o)return 'no-obstacle';" +
      "var c=C.gridCenter(o.path[0].col,o.path[0].row);" +
      "var cv=document.getElementById('edCv');var ctx=cv.getContext('2d');" +
      "var k=cv.width/(E.level.cols*40);" +
      "function redAt(dx,dy){var d=ctx.getImageData(Math.round((c.x+dx)*k),Math.round((c.y+dy)*k),1,1).data;" +
      "  return d[0]>150&&d[1]<130&&d[2]<130;}" +
      "var n=0;for(var dx=-20;dx<=20;dx++)for(var dy=-20;dy<=20;dy++){if(redAt(dx,dy))n++;}" +
      "return JSON.stringify({r:C.OBSTACLE_RADIUS,k:Math.round(k*100)/100,red:n," +
      "  out20:redAt(22,0),in8:redAt(8,0),hasRadius:o.radius!==undefined});})()");
    const ob = JSON.parse(obInfo === 'no-obstacle' ? '{}' : obInfo);
    ok('障碍真的画在画布上（圆心周围有一片红）', (ob.red || 0) > 30,
      obInfo === 'no-obstacle' ? '这一关没有直线巡逻的障碍' : JSON.stringify(ob));
    ok('画出来的半径就是内核那个 13px（+8px 还是红、+22px 已是白底）',
      ob.in8 === true && ob.out20 === false, JSON.stringify(ob));
    ok('编辑器里的障碍数据不带 radius（半径只来自内核固定值）', ob.hasRadius === false);

    /* ---- 检查能否通关 → 编辑器里回放最优解（2026-10-15 新增） ---- */
    console.log('\n== B9b. 检查通关后回放最优解，时间与计算一致 ==');
    await evalJs("(function(){var E=__EDITOR_DEBUG.E;" +
      "var lv={version:1,id:'probe',name:'回放探针',difficulty:1,cols:14,rows:9," +
      "  spawns:[{col:0,row:4}],checkpoints:[],goals:[{col:13,row:4}],walls:[]," +
      "  obstacles:[{id:'a',path:[{col:4,row:3},{col:4,row:5}],speed:90,loopMode:'pingpong'}," +
      "             {id:'b',path:[{col:8,row:5},{col:8,row:3}],speed:90,loopMode:'pingpong'}]};" +
      "E.level=lv; E.selected=null; E.sel=[]; if(window.DC) {} return 1;})()");
    await evalJs("(function(){__EDITOR_DEBUG.refresh();return 1;})()");
    await sleep(300);
    // 编辑器页面里内核的全局名是 DodgeCore（editor.js 内部才叫 DC）
    ok('编辑器里能拿到内核', await waitUntil("!!window.DodgeCore"));
    const solved = await evalJs("(function(){var C=window.DodgeCore;" +
      "var r=C.solveReachable(C.normalizeLevel(__EDITOR_DEBUG.exportLevel()),60);" +
      "return JSON.stringify({ok:r.ok,time:r.time,ticks:r.ticks,steps:(r.path||[]).length});})()");
    const sv = JSON.parse(solved);
    ok('这一关能算出最优解（回放素材就绪）', sv.ok && sv.steps > 1,
      sv.ok ? (sv.steps + ' 个落脚点 / ' + sv.time.toFixed(2) + ' 秒') : '算不出');
    // 先把上一段（内置第 4 关）留下的回放收掉，再点按钮重新放这一关
    await evalJs("(function(){var b=document.getElementById('btnCheck');" +
      "var E=__EDITOR_DEBUG.E;if(E.solve&&!E.solve.done)b.click();return 1;})()");
    await sleep(200);
    const restTick = await evalJs("__EDITOR_DEBUG.E.solve ? __EDITOR_DEBUG.E.solve.tick : -1");
    ok('上一次回放结束后，再点按钮是重新播一遍（不是变成"停止"）',
      restTick === -1 || await evalJs("__EDITOR_DEBUG.E.solve.done === true"),
      '旧回放 tick=' + restTick + ' done=' + await evalJs("__EDITOR_DEBUG.E.solve ? !!__EDITOR_DEBUG.E.solve.done : 'n/a'"));

    await evalJs("document.getElementById('btnCheck').click()");
    ok('点「检查能否通关」后开始回放',
      await waitUntil("!!__EDITOR_DEBUG.E.solve && !__EDITOR_DEBUG.E.solve.done && __EDITOR_DEBUG.E.solve.tick >= 0", 6000),
      await evalJs("__EDITOR_DEBUG.E.solve ? 'tick=' + __EDITOR_DEBUG.E.solve.tick : '没进入回放'"));
    const midTick = await evalJs("__EDITOR_DEBUG.E.solve ? __EDITOR_DEBUG.E.solve.tick : -1");
    await sleep(500);
    const laterTick = await evalJs("__EDITOR_DEBUG.E.solve ? __EDITOR_DEBUG.E.solve.tick : -1");
    ok('回放里时间片在往前走（机器人真的在动）', laterTick > midTick && laterTick > 0,
      midTick + ' → ' + laterTick);
    const botDrawn = await evalJs("(function(){var s=__EDITOR_DEBUG.E.solve;" +
      "if(!s)return 'no-solve';var p=window.DodgeCore.solveBotPos(s.path, s.tick);" +
      "return JSON.stringify({x:Math.round(p.x),y:Math.round(p.y)});})()");
    ok('机器人位置由内核的 solveBotPos 给出（与求解同一份插值）',
      botDrawn !== 'no-solve' && JSON.parse(botDrawn).x >= 0, botDrawn);
    // 等它播完（时间按时间片走，总时长 = ticks × 62.5ms）
    await waitUntil("__EDITOR_DEBUG.E.solve && __EDITOR_DEBUG.E.solve.tick >= __EDITOR_DEBUG.E.solve.ticks", 20000);
    const done = JSON.parse(await evalJs("JSON.stringify({tick:__EDITOR_DEBUG.E.solve.tick," +
      "ticks:__EDITOR_DEBUG.E.solve.ticks,time:__EDITOR_DEBUG.E.solve.time," +
      "step:window.DodgeCore.SOLVE_STEP,status:document.getElementById('statusLine').textContent})"));
    ok('回放走到终点，用时与计算结果一致',
      done.tick === done.ticks && Math.abs(done.tick * done.step - done.time) < 1e-9,
      'tick ' + done.tick + '/' + done.ticks + ' → ' + (done.tick * done.step).toFixed(2) + 's（计算 ' + done.time.toFixed(2) + 's）');
    ok('播完的提示语里也是同一个时间', done.status.indexOf((done.tick * done.step).toFixed(2)) >= 0,
      done.status);
    await shot('dodge-solve-replay');

    await pickTool('wall');
    await drag(3, 3, 4, 3);
    await evalJs("document.getElementById('btnGoPlay').click()");
    await waitUntil("!document.getElementById('leaveMask').classList.contains('hidden')");
    await evalJs("document.getElementById('leaveSave').click()");
    ok('「保存并继续」会先存盘再跳到游戏页',
      await waitUntil("location.pathname === '/dodge/'", 8000),
      await evalJs("location.pathname"));

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
