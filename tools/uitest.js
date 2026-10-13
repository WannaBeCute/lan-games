'use strict';
/**
 * 前端界面自检（用本机 Chrome 无头模式 + DevTools 协议）
 *   node tools/uitest.js [http://127.0.0.1:8080]
 * 覆盖：三个页面能否正常加载、有无 JS 报错、坦克大战能否开局并响应键盘、
 *       五子棋能否落子并触发 AI 应手，并输出截图到 tools/shots/
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const PORT = 9333;
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

function findBrowser() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/* ---------- 极简 CDP 客户端 ---------- */
class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = [];
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => res(this);
      this.ws.onerror = (e) => rej(new Error('CDP 连接失败'));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id != null && this.pending.has(m.id)) {
          const { resolve, reject } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
          return;
        }
        this.events.push(m);
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

(async function main() {
  const exe = findBrowser();
  if (!exe) { console.log('未找到 Chrome/Edge，跳过界面自检'); process.exit(0); }
  console.log('使用浏览器: ' + exe);
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  const profile = path.join(os.tmpdir(), 'wb-uitest-' + Date.now());
  const proc = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    '--window-size=1440,920',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    cdp = new CDP(await getTarget(PORT));
    await cdp.connect();

    const errors = [];
    cdp.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push('异常: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text) + ' @ ' + (d.url || '') + ':' + d.lineNumber);
      } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        errors.push('控制台 ' + m.params.type + ': ' + m.params.args.map(a => a.value != null ? a.value : (a.description || a.type)).join(' '));
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        errors.push('日志: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    const shot = async (name) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
    };
    const goto = async (url) => {
      errors.length = 0;
      await cdp.send('Page.navigate', { url });
      await sleep(1400);
    };
    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
      if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
      return r.result.value;
    };
    /** 需要等待 Promise 的求值 */
    const evalAsync = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面异步求值异常: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
      return r.result.value;
    };
    const key = async (type, code, vk) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type, code, key: code === 'ArrowUp' ? 'ArrowUp' : code,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
      });
    };

    /* ---------- 1. 主页 ---------- */
    console.log('\n== 1. 主页 ==');
    await goto(BASE + '/');
    ok('主页加载无报错', errors.length === 0, errors.join(' | '));
    /* 卡片是脚本读 /api/status 渲染出来的 —— 直接和接口对账，
       以后往 games/ 里加多少游戏，这条断言都不用回来改 */
    const homeCards = JSON.parse(await evalAsync(
      "(async () => {" +
      "  for (let i = 0; i < 40; i++) { if (document.querySelectorAll('.game-card').length) break; await new Promise(r => setTimeout(r, 100)); }" +
      "  const s = await (await fetch('/api/status')).json();" +
      "  const as = Array.from(document.querySelectorAll('.game-card'));" +
      "  const extra = as.map(c => Array.from(c.querySelectorAll('.card-extra a')).map(x => x.getAttribute('href')));" +
      "  const codes = [];" +
      "  for (const h of extra.flat()) { try { codes.push((await fetch(h)).status); } catch (e) { codes.push(0); } }" +
      "  return JSON.stringify({" +
      "    n: as.length," +
      "    want: s.games.map(g => g.entry)," +
      "    hrefs: as.map(c => { const m = c.querySelector('a.card-main'); return m ? m.getAttribute('href') : ''; })," +
      "    titles: as.map(c => (c.querySelector('h2') || {}).textContent || '')," +
      "    tags: as.map(c => c.querySelectorAll('.tags li').length)," +
      "    artOk: as.every(c => { const i = c.querySelector('.art img'); return !!i && i.naturalWidth > 0; })," +
      "    extra: extra," +
      "    wantExtra: s.games.map(g => (g.links || []).map(l => l.href).join('|'))," +
      "    extraCodes: codes" +
      "  });" +
      "})()"
    ));
    ok('主页卡片数 = 接口报出的游戏数', homeCards.n === homeCards.want.length, homeCards.n + ' / ' + homeCards.want.length);
    ok('卡片顺序与入口跟接口一致', homeCards.hrefs.join(',') === homeCards.want.join(','), homeCards.hrefs.join(','));
    ok('每张卡片都渲染出标题与标签', homeCards.titles.every(Boolean) && homeCards.tags.every(n => n > 0),
      homeCards.titles.join(' / ') + '  标签数 ' + homeCards.tags.join(','));
    ok('卡片插画（svg）真的加载出来了', homeCards.artOk === true);
    /* 附属入口 = 游戏的"第二个页面"（如方块躲避的关卡编辑器），由 Hub.card.links 声明 */
    ok('卡片附属入口与接口声明一致',
      homeCards.extra.map(a => a.join('|')).join(',') === homeCards.wantExtra.join(','),
      JSON.stringify(homeCards.extra));
    ok('卡片上确实有附属入口（如关卡编辑器）', homeCards.extra.some(a => a.length > 0),
      JSON.stringify(homeCards.extra));
    ok('附属入口指向的页面都能打开（没有死链）',
      homeCards.extraCodes.length > 0 && homeCards.extraCodes.every(c => c === 200),
      JSON.stringify(homeCards.extraCodes));
    const badge = await evalJs("document.getElementById('netBadge').textContent");
    ok('WebSocket 已连接', /已连接/.test(badge), '状态：' + badge);
    const L = JSON.parse(await evalJs("JSON.stringify({shown:!document.getElementById('lanBanner').classList.contains('hidden'),url:document.getElementById('lanUrl').textContent})"));
    ok('服务器本机打开时给出分享地址', L.shown && /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+/.test(L.url), L.url);
    const lanApi = JSON.parse(await evalAsync("fetch('/api/status').then(r=>r.json()).then(s=>JSON.stringify({urls:s.urls,port:s.port,addresses:s.addresses}))"));
    ok('接口返回可分享的局域网地址', Array.isArray(lanApi.urls) && lanApi.urls.length > 0 && lanApi.port > 0, JSON.stringify(lanApi));
    await evalJs("document.getElementById('btnSettings').click()");
    await sleep(300);
    const dlg = await evalJs("!!document.getElementById('wb-settings')");
    ok('主页可打开设置面板', dlg === true);
    const keyCount = await evalJs("document.querySelectorAll('.wb-key').length");
    ok('设置面板含键位设置（5 键 × 2 玩家）', keyCount === 10, keyCount + ' 个按键框');
    const keysText = await evalJs("Array.from(document.querySelectorAll('.wb-key')).slice(0,5).map(b=>b.textContent).join('/')");
    ok('默认键位为方向键 + 空格', /↑\/↓\/←\/→\/空格/.test(keysText), keysText);
    await evalJs("document.querySelector('#wb-settings .wb-x').click()");
    await sleep(200);
    await shot('1-home');

    /* ---------- 2. 坦克大战 - 单人 ---------- */
    console.log('\n== 2. 坦克大战：单人模式 ==');
    await goto(BASE + '/tank/');
    ok('坦克页加载无报错', errors.length === 0, errors.join(' | '));
    ok('共享内核已加载', await evalJs("typeof TankCore === 'object' && typeof TankCore.createWorld === 'function'"));
    ok('渲染模块已加载', await evalJs("typeof TankRender === 'object'"));
    const modeBtns = await evalJs("document.querySelectorAll('[data-mode]').length");
    ok('提供单人/多人/联机三种模式', modeBtns === 3, modeBtns + ' 个入口');
    await shot('2-tank-menu');

    await evalJs("document.querySelector('[data-mode=\"single\"]').click()");
    await sleep(300);
    ok('进入难度选择', await evalJs("!document.getElementById('scr-single').classList.contains('hidden')"));
    await evalJs("document.querySelector('[data-level=\"1\"]').click()");
    await sleep(2600);   // 等开局倒计时
    ok('进入对局画面', await evalJs("!document.getElementById('scr-game').classList.contains('hidden')"));
    const info = await evalJs("JSON.stringify({cols:__TANK_DEBUG.S.world.cols,rows:__TANK_DEBUG.S.world.rows,tanks:__TANK_DEBUG.S.world.tanks.length,me:!!__TANK_DEBUG.S.me,y:Math.round(__TANK_DEBUG.S.me.y),cvw:document.getElementById('cv').width})");
    const I = JSON.parse(info);
    ok('世界已建立（25x19，含玩家）', I.cols === 25 && I.rows === 19 && I.me, info);
    ok('画布已按容器尺寸渲染', I.cvw > 200, 'canvas 宽 ' + I.cvw + 'px');
    const openRatio = await evalJs("(function(){var w=__TANK_DEBUG.S.world;var n=0;for(var i=0;i<w.tiles.length;i++){var t=w.tiles[i];if(t!==1&&t!==2&&t!==3)n++;}return (n/w.tiles.length).toFixed(3);})()");
    ok('可活动空间 ≥ 屏幕 1/3', parseFloat(openRatio) >= 1 / 3, '空地占比 ' + openRatio);

    const pose0 = JSON.parse(await evalJs("JSON.stringify({x:__TANK_DEBUG.S.me.x,y:__TANK_DEBUG.S.me.y,a:__TANK_DEBUG.S.me.angle})"));
    await key('rawKeyDown', 'ArrowUp', 38);
    await sleep(900);
    const pose1 = JSON.parse(await evalJs("JSON.stringify({x:__TANK_DEBUG.S.me.x,y:__TANK_DEBUG.S.me.y,a:__TANK_DEBUG.S.me.angle})"));
    await key('keyUp', 'ArrowUp', 38);
    const moved = Math.hypot(pose1.x - pose0.x, pose1.y - pose0.y);
    ok('↑ 键可驱动坦克前进（沿车头方向）', moved > 20, '位移 ' + moved.toFixed(0) + 'px');

    await key('rawKeyDown', 'ArrowLeft', 37);
    await sleep(500);
    const ang1 = await evalJs("__TANK_DEBUG.S.me.angle");
    await key('keyUp', 'ArrowLeft', 37);
    const turned = Math.abs(pose1.a - ang1) * 180 / Math.PI;
    ok('← 键可让坦克旋转', turned > 20, '转了 ' + turned.toFixed(0) + '°');

    await key('rawKeyDown', 'Space', 32);
    await sleep(500);
    const bullets = await evalJs("__TANK_DEBUG.S.world.bullets.length");
    await key('keyUp', 'Space', 32);
    ok('开火键可发射子弹', bullets > 0, '场上子弹 ' + bullets);

    const hud = await evalJs("document.getElementById('hKills').textContent + ' / ' + document.getElementById('hLives').textContent");
    ok('HUD 显示击杀与生命', /击杀/.test(hud), hud);

    // 侧栏道具要写清「名称 + 作用」，不能只有一个看不懂的图标
    await evalJs("__TANK_DEBUG.TC.applyPowerup(__TANK_DEBUG.S.world, __TANK_DEBUG.S.me, 'speed')");
    await sleep(400);
    const puText = await evalJs("document.getElementById('powerList').textContent");
    ok('道具栏显示道具名称', /加速/.test(puText), puText.replace(/\s+/g, ' ').slice(0, 60));
    ok('道具栏显示道具作用', /45%/.test(puText), puText.replace(/\s+/g, ' ').slice(0, 60));
    await sleep(2200);
    await shot('3-tank-single');
    const aiCount = await evalJs("__TANK_DEBUG.S.world.tanks.filter(t=>t.bot).length");
    ok('AI 坦克已生成', aiCount > 0, aiCount + ' 辆 AI');
    // 出生点必须够 AI 长到上限：玩家占 1 个，剩下 cap 个留给 AI，否则会出现"生成几个就不动了"
    const spawnInfo = JSON.parse(await evalJs("JSON.stringify({cap:__TANK_DEBUG.S.single.cap,slots:__TANK_DEBUG.S.world.spawns.length})"));
    ok('出生点数量 = 1 个玩家 + AI 上限', spawnInfo.slots === spawnInfo.cap + 1, JSON.stringify(spawnInfo));

    /* ---------- 2b. 坦克大战 - 本地双人 ---------- */
    console.log('\n== 2b. 坦克大战：本地双人（局数制） ==');
    await goto(BASE + '/tank/');
    await sleep(500);
    await evalJs("document.querySelector('[data-mode=\"local\"]').click()");
    await sleep(300);
    ok('本地双人可设置局数', await evalJs("!!document.getElementById('localRounds')"),
      '默认 ' + (await evalJs("document.getElementById('localRounds').value")) + '，上限 ' + (await evalJs("document.getElementById('localRounds').max")));
    const keysPreview = await evalJs("document.getElementById('localKeysPreview').textContent");
    ok('展示双方键位', /P1/.test(keysPreview) && /P2/.test(keysPreview), keysPreview.replace(/\s+/g, ' ').slice(0, 60));
    await evalJs("document.getElementById('localRounds').value='20';document.getElementById('btnLocalStart').click()");
    await sleep(3200);
    const l2 = JSON.parse(await evalJs("JSON.stringify({mode:__TANK_DEBUG.S.mode,tanks:__TANK_DEBUG.S.world.tanks.length,names:__TANK_DEBUG.S.world.tanks.map(t=>t.name),round:document.getElementById('hRound').textContent})"));
    ok('进入双人对局并生成两台坦克', l2.mode === 'local' && l2.tanks === 2 && l2.names.join(',') === 'P1,P2', JSON.stringify(l2));
    ok('HUD 显示局数', /第 1 \/ 20 局/.test(l2.round), l2.round);
    const p2a = JSON.parse(await evalJs("JSON.stringify({x:__TANK_DEBUG.S.world.tanks[1].x,y:__TANK_DEBUG.S.world.tanks[1].y})"));
    await key('rawKeyDown', 'KeyW', 87);
    await sleep(800);
    const p2b = JSON.parse(await evalJs("JSON.stringify({x:__TANK_DEBUG.S.world.tanks[1].x,y:__TANK_DEBUG.S.world.tanks[1].y})"));
    await key('keyUp', 'KeyW', 87);
    const p2m = Math.hypot(p2b.x - p2a.x, p2b.y - p2a.y);
    ok('P2 可用 W 键前进', p2m > 20, '位移 ' + p2m.toFixed(0) + 'px');

    const p1a = JSON.parse(await evalJs("JSON.stringify({x:__TANK_DEBUG.S.world.tanks[0].x,y:__TANK_DEBUG.S.world.tanks[0].y})"));
    await key('rawKeyDown', 'ArrowUp', 38);
    await sleep(800);
    const p1b = JSON.parse(await evalJs("JSON.stringify({x:__TANK_DEBUG.S.world.tanks[0].x,y:__TANK_DEBUG.S.world.tanks[0].y})"));
    await key('keyUp', 'ArrowUp', 38);
    const p1m = Math.hypot(p1b.x - p1a.x, p1b.y - p1a.y);
    ok('P1 可同时用方向键操作', p1m > 20, '位移 ' + p1m.toFixed(0) + 'px');
    await shot('3b-tank-local2p');

    // 草丛：自己踩在树丛格上时，视图里要标记 inBush（渲染成半透明盖在草上）
    const bushProbe = JSON.parse(await evalJs(`(function(){
      var S=__TANK_DEBUG.S, TC=__TANK_DEBUG.TC, w=S.world, me=w.tanks[0];
      var idx=-1; for (var i=0;i<w.tiles.length;i++){ if (w.tiles[i]===TC.BUSH){ idx=i; break; } }
      if (idx<0) return JSON.stringify({bush:false});
      var c=idx%w.cols, r=Math.floor(idx/w.cols);
      var bx=c*TC.TILE+TC.TILE/2, by=r*TC.TILE+TC.TILE/2;
      me.x=bx; me.y=by;
      // 另一台此前用 W 开过一段，可能正好停进草丛里；先把它搬到确定的空地格，
      // 否则下面"另一台没进草丛"的断言会随随机地图偶发失败
      var other=w.tanks[1];
      var ei=-1; for (var k=0;k<w.tiles.length;k++){ if (w.tiles[k]===TC.EMPTY){ ei=k; break; } }
      if (other && ei>=0){ other.x=(ei%w.cols)*TC.TILE+TC.TILE/2; other.y=Math.floor(ei/w.cols)*TC.TILE+TC.TILE/2; }
      var v=__TANK_DEBUG.buildLocalView();
      var t1=null,t2=null;
      for (var j=0;j<v.tanks.length;j++){
        if (v.tanks[j].id===1) t1=v.tanks[j];
        if (v.tanks[j].id===2) t2=v.tanks[j];
      }
      return JSON.stringify({bush:true, mineInBush:!!(t1&&t1.inBush), otherInBush:!!(t2&&t2.inBush)});
    })()`));
    ok('草丛里会被标记 inBush（客户端据此半透明补画自己）', bushProbe.bush && bushProbe.mineInBush === true, JSON.stringify(bushProbe));
    ok('没进草丛的那台不会被标记', bushProbe.otherInBush === false, JSON.stringify(bushProbe));

    // 躲草丛时头顶的名字也要藏起来（否则名字会暴露位置）
    const nameProbe = JSON.parse(await evalJs(`(function(){
      var S=__TANK_DEBUG.S, TC=__TANK_DEBUG.TC, w=S.world;
      var idx=-1; for (var i=0;i<w.tiles.length;i++){ if (w.tiles[i]===TC.BUSH){ idx=i; break; } }
      var c=idx%w.cols, r=Math.floor(idx/w.cols);
      w.tanks[0].x=c*TC.TILE+TC.TILE/2; w.tanks[0].y=r*TC.TILE+TC.TILE/2;
      var v=__TANK_DEBUG.buildLocalView();
      var t1=null; for (var j=0;j<v.tanks.length;j++) if (v.tanks[j].id===1) t1=v.tanks[j];
      // 挪回空地再看一次
      var e=-1; for (var k=0;k<w.tiles.length;k++) if (w.tiles[k]===TC.EMPTY){ e=k; break; }
      w.tanks[0].x=(e%w.cols)*TC.TILE+TC.TILE/2; w.tanks[0].y=Math.floor(e/w.cols)*TC.TILE+TC.TILE/2;
      var v2=__TANK_DEBUG.buildLocalView();
      var t1b=null; for (var m=0;m<v2.tanks.length;m++) if (v2.tanks[m].id===1) t1b=v2.tanks[m];
      return JSON.stringify({inBushName:!!(t1&&t1.showName), groundName:!!(t1b&&t1b.showName)});
    })()`));
    ok('躲草丛时不显示头顶名字', nameProbe.inBushName === false, JSON.stringify(nameProbe));
    ok('离开草丛后名字恢复显示', nameProbe.groundName === true, JSON.stringify(nameProbe));
    ok('隐身时长已加到 20 秒', (await evalJs("__TANK_DEBUG.TC.DURATION.stealth")) === 20);

    /* ---------- 2c. 决出胜负后延迟结算 ---------- */
    console.log('\n== 2c. 坦克大战：延迟 2 秒再结算（动画播完 + 可判平局） ==');
    await evalJs("(function(){var t=__TANK_DEBUG.S.world.tanks[1];t.invuln=0;t.power.shield=0;t.alive=false;t.lives=0;t.respawn=999;return 1})()");
    await sleep(900);
    const d1 = JSON.parse(await evalJs("JSON.stringify({state:__TANK_DEBUG.S.local.state,endTimer:+(__TANK_DEBUG.S.local.endTimer||0).toFixed(2)})"));
    ok('击毁后不会立刻结算（留给爆炸动画）', d1.state === 'play' && d1.endTimer > 0, JSON.stringify(d1));
    await sleep(2000);
    const d2 = JSON.parse(await evalJs("JSON.stringify({state:__TANK_DEBUG.S.local.state})"));
    ok('约 2 秒后才结算本局', d2.state === 'inter', 'state=' + d2.state);

    // 结算浮层中间要显示"获胜的坦克 + 玩家名"
    const banner = JSON.parse(await evalJs(`JSON.stringify({
      hasCanvas: !!document.getElementById('wbTankArt'),
      text: document.getElementById('overlayInner').textContent.replace(/\s+/g,' ').slice(0,80),
      banner: !!document.querySelector('#overlayInner .winner-banner')
    })`));
    ok('局结束界面显示胜者横幅', banner.banner && banner.hasCanvas, JSON.stringify(banner));
    ok('横幅上写着获胜玩家名', /P1/.test(banner.text), banner.text);

    // 结算中双方都阵亡 → 平局（流局），不记胜场
    const d3 = JSON.parse(await evalJs("JSON.stringify({alive:__TANK_DEBUG.S.world.tanks.map(t=>t.alive),contenders:__TANK_DEBUG.TC.contenders(__TANK_DEBUG.S.world).length})"));
    ok('同归于尽时场上无存活者（判平局）', d3.contenders <= 1, JSON.stringify(d3));

    /* ---------- 2d. 打完全部局数 → 再战（画面不能不见 / 按钮不能点不动） ---------- */
    console.log('\n== 2d. 坦克大战：打完再开一局 ==');
    const COLORS = "(function(){var cv=document.getElementById('cv');var c=cv.getContext('2d');var d=c.getImageData(0,0,cv.width,cv.height).data;var s={};for(var i=0;i<d.length;i+=4*331){s[d[i]+','+d[i+1]+','+d[i+2]]=1;}return Object.keys(s).length;})()";
    await goto(BASE + '/tank/');
    await sleep(500);
    await evalJs("document.querySelector('[data-mode=\"local\"]').click()"); await sleep(300);
    await evalJs("document.getElementById('localRounds').value='1'");
    await evalJs("document.getElementById('btnLocalStart').click()"); await sleep(3000);
    await evalJs("__TANK_DEBUG.S.world.tanks[0].kills = 3;");   // 造一个击杀王，方便校验击杀榜
    await evalJs("(function(){var t=__TANK_DEBUG.S.world.tanks[1];t.invuln=0;t.power.shield=0;t.alive=false;t.lives=0;t.respawn=999;return 1})()");
    await sleep(7200);                                    // 2 秒延迟结算 + 3 秒局间 + 全部结束
    const f1 = JSON.parse(await evalJs("JSON.stringify({state:__TANK_DEBUG.S.local.state,btn:!!document.getElementById('ovAgain')})"));
    ok('全部局数打完会弹出结算', f1.state === 'over' && f1.btn, JSON.stringify(f1));
    const fin = JSON.parse(await evalJs(`JSON.stringify({
      text: document.getElementById('overlayInner').textContent.replace(/\s+/g,' '),
      tank: !!document.getElementById('wbTankArt'),
      banner: !!document.querySelector('#overlayInner .winner-banner')
    })`));
    ok('总结算界面有总冠军横幅（含坦克）', fin.banner && fin.tank, JSON.stringify({ banner: fin.banner, tank: fin.tank }));
    ok('总结算界面显示击杀榜第一', /击杀榜第一/.test(fin.text), fin.text.slice(0, 110));
    const len1 = await evalJs("document.getElementById('overlayInner').innerHTML.length");
    await sleep(700);
    const len2 = await evalJs("document.getElementById('overlayInner').innerHTML.length");
    ok('结算浮层不会被每帧重建（否则按钮会点不动）', len1 === len2, '长度 ' + len1 + ' → ' + len2);
    await evalJs("(function(){var b=document.getElementById('ovAgain'); if(b) b.click(); return 1})()");
    await sleep(2500);
    const again = JSON.parse(await evalJs("JSON.stringify({screen:__TANK_DEBUG.S.screen,paused:__TANK_DEBUG.S.paused,mode:__TANK_DEBUG.S.mode,colors:" + COLORS + "})"));
    ok('点「再战」能重新开局且画面正常', again.screen === 'scr-game' && again.mode === 'local' && again.colors > 1 && !again.paused,
      JSON.stringify(again));

    /* ---------- 3. 坦克大战 - 联机大厅 ---------- */
    console.log('\n== 3. 坦克大战：联机房间 ==');
    await goto(BASE + '/tank/');
    await sleep(600);
    await evalJs("document.querySelector('[data-mode=\"online\"]').click()");
    await sleep(300);
    await evalJs("document.getElementById('btnCreateRoom').click()");
    await sleep(1500);
    const code = await evalJs("document.getElementById('roomCode').textContent");
    ok('可以新建房间并展示房间号', /^\d{4}$/.test(code), '房间号 ' + code);
    ok('房间内可选择颜色', (await evalJs("document.querySelectorAll('#colorPick .swatch').length")) === 8);
    ok('房间内可选择涂装', (await evalJs("document.querySelectorAll('#stylePick .style-btn').length")) === 4);
    ok('房间内可设置键位', (await evalJs("document.querySelectorAll('#lobbyKeys button').length")) === 5);
    ok('房主可设置对局局数', (await evalJs("document.getElementById('roomRounds').disabled")) === false,
      '默认 ' + (await evalJs("document.getElementById('roomRounds').value")) + ' 局，上限 ' + (await evalJs("document.getElementById('roomRounds').max")));
    await evalJs("document.getElementById('roomRounds').value='50';document.getElementById('roomRounds').dispatchEvent(new Event('change'))");
    await sleep(500);
    ok('局数修改已同步到服务端', (await evalJs("document.getElementById('roomRounds').value")) === '50');
    // 房间里可勾选掉落道具：默认 8 种全选，点一下能取消
    const puInfo = JSON.parse(await evalJs("JSON.stringify({n:document.querySelectorAll('#puPicks .pu-pick').length,on:document.querySelectorAll('#puPicks .pu-pick.on').length,text:document.getElementById('puPicks').textContent})"));
    ok('房间展示 8 种可掉落道具且默认全选', puInfo.n === 8 && puInfo.on === 8, puInfo.n + ' 种，选中 ' + puInfo.on + '：' + puInfo.text.replace(/\s+/g, ''));
    await evalJs("document.querySelector('#puPicks .pu-pick[data-pu=\"stealth\"]').click()");
    await sleep(500);
    const puAfter = JSON.parse(await evalJs("JSON.stringify({on:document.querySelectorAll('#puPicks .pu-pick.on').length,server:(__TANK_DEBUG.S.room.powerups||[]).length,hasStealth:(__TANK_DEBUG.S.room.powerups||[]).indexOf('stealth')>=0})"));
    ok('取消勾选后同步到服务端', puAfter.on === 7 && puAfter.server === 7 && !puAfter.hasStealth,
      '界面选中 ' + puAfter.on + '，服务端 ' + puAfter.server + ' 种');
    await evalJs("document.querySelector('#puPicks .pu-pick[data-pu=\"stealth\"]').click()");
    await sleep(400);
    ok('可以再勾回来', (await evalJs("document.querySelectorAll('#puPicks .pu-pick.on').length")) === 8);

    // 自伤开关（默认关 = 自己的子弹打不到自己）
    const sd0 = JSON.parse(await evalJs("JSON.stringify({on:document.getElementById('chkSelfDamage').checked,disabled:document.getElementById('chkSelfDamage').disabled,text:document.getElementById('selfDamageHint').textContent})"));
    ok('房间提供「子弹会伤到自己」开关且默认关闭', sd0.on === false && sd0.disabled === false, JSON.stringify(sd0));
    await evalJs("document.getElementById('chkSelfDamage').click()");
    await sleep(500);
    const sd1 = JSON.parse(await evalJs("JSON.stringify({ui:document.getElementById('chkSelfDamage').checked,server:!!__TANK_DEBUG.S.room.selfDamage})"));
    ok('开启自伤后同步到服务端', sd1.ui === true && sd1.server === true, JSON.stringify(sd1));
    await evalJs("document.getElementById('chkSelfDamage').click()");
    await sleep(400);
    ok('可以再关回去', (await evalJs("__TANK_DEBUG.S.room.selfDamage")) === false);
    await shot('4-tank-lobby');

    /* ---------- 4. 五子棋 ---------- */
    console.log('\n== 4. 五子棋 ==');
    await goto(BASE + '/gomoku/');
    ok('五子棋页加载无报错', errors.length === 0, errors.join(' | '));
    ok('AI 模块已加载', await evalJs("typeof GomokuAI === 'object' && typeof GomokuAI.think === 'function'"));
    await shot('6b-gomoku-menu');
    await evalJs("document.querySelector('[data-mode=\"ai\"]').click()");
    await sleep(500);
    ok('进入棋盘界面', await evalJs("!document.getElementById('scr-play').classList.contains('hidden')"));

    const click = await evalJs(`(function(){
      var cv = document.getElementById('board');
      var r = cv.getBoundingClientRect();
      var scale = r.width / (14*36 + 68);
      return JSON.stringify({x: r.left + (34 + 7*36)*scale, y: r.top + (34 + 7*36)*scale});
    })()`);
    const P = JSON.parse(click);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: P.x, y: P.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
    await sleep(1800);
    const g1 = await evalJs("JSON.stringify({stones:(function(){var n=0;for(var i=0;i<225;i++)n++;return n;})(), moves:document.getElementById('metaLine').textContent})");
    ok('点击棋盘可落子并触发 AI 应手', /手数\s*2/.test(JSON.parse(g1).moves), JSON.parse(g1).moves.replace(/\s+/g, ' '));
    const turn = await evalJs("document.getElementById('turnLine').textContent");
    ok('落子后轮次回到玩家', /轮到你/.test(turn), turn);

    // 校验棋子归属（玩家执黑、AI 执白）与画面渲染
    const gd = JSON.parse(await evalJs(`(function(){
      var G = __GOMOKU_DEBUG.G, S = __GOMOKU_DEBUG.S, px = __GOMOKU_DEBUG.px;
      var mine = G.board[7*S+7], ai = 0, aiAt = null;
      for (var i=0;i<S*S;i++) if (G.board[i] && G.board[i]!==1) { ai = G.board[i]; aiAt = {x:i%S, y:(i-i%S)/S}; }
      var cv = document.getElementById('board'), ctx = cv.getContext('2d');
      var sc = ctx.getTransform().a;
      function lum(gx, gy) {
        // 避开棋子正中心的「最后一手」标记，取四个偏心点求平均
        var s = 0;
        [[5, 5], [-5, -5], [5, -5], [-5, 5]].forEach(function (o) {
          var d = ctx.getImageData(Math.round((px(gx) + o[0]) * sc), Math.round((px(gy) + o[1]) * sc), 1, 1).data;
          s += (d[0] + d[1] + d[2]) / 3;
        });
        return s / 4;
      }
      return JSON.stringify({ mine: mine, ai: ai, aiAt: aiAt, lumMine: Math.round(lum(7,7)), lumAi: aiAt?Math.round(lum(aiAt.x, aiAt.y)):null, myColor: G.myColor });
    })()`));
    ok('玩家执黑（先手）', gd.myColor === 1 && gd.mine === 1, '我方棋子=' + gd.mine + '，AI 棋子=' + gd.ai);
    ok('AI 执白并已应手', gd.ai === 2 && gd.aiAt, 'AI 落子于 ' + (gd.aiAt ? ('(' + gd.aiAt.x + ',' + gd.aiAt.y + ')') : '无'));
    ok('黑子渲染为深色、白子为浅色', gd.lumMine < 140 && gd.lumAi > 150,
      '黑子亮度 ' + gd.lumMine + ' / 白子亮度 ' + gd.lumAi);
    await shot('5-gomoku-ai');

    // 悔棋（单机）：撤回自己刚下的一手（连同电脑紧跟的应手）
    const und = JSON.parse(await evalJs(`(function(){
      var G = __GOMOKU_DEBUG.G;
      var before = { moves:G.moves.length, turn:G.turn };
      document.getElementById('btnUndo').click();
      return JSON.stringify({ before:before, moves:G.moves.length, turn:G.turn,
        at77:G.board[7*15+7], left:G.undoLeft[1],
        meta:document.getElementById('metaLine').textContent });
    })()`));
    await sleep(400);
    const undoMeta = await evalJs("document.getElementById('metaLine').textContent");
    ok('悔棋撤回自己刚下的一手', und.moves === 0 && und.at77 === 0, '手数 ' + und.before.moves + ' → ' + und.moves);
    ok('悔棋后轮次回到自己', und.turn === 1, 'turn=' + und.turn);
    ok('悔棋次数减为 0（每人一次）', /悔棋剩余 黑 0/.test(undoMeta), undoMeta.replace(/\s+/g, ' '));

    // 联机面板
    await evalJs("document.getElementById('scr-play').classList.add('hidden');document.getElementById('scr-menu').classList.remove('hidden')");
    await evalJs("document.querySelector('[data-mode=\"online\"]').click()");
    await sleep(600);
    const myCode = await evalJs("document.getElementById('myCode').textContent");
    ok('联机页展示本机专属邀请码', /^[A-HJ-NP-Z2-9]{6}$/.test(myCode), '邀请码 ' + myCode);
    ok('提供输入对方邀请码的入口', await evalJs("!!document.getElementById('inviteCode') && !!document.getElementById('btnInvite')"));
    await shot('6-gomoku-invite');

    /* ---------- 5. 五子棋：悔棋与落子预览（客户端） ---------- */
    console.log('\n== 5. 五子棋：悔棋与落子预览 ==');
    await goto(BASE + '/gomoku/');
    await sleep(400);

    // 5.1 联机局面：收到「悔棋后的新状态」必须真的刷新（历史 bug：消息类型被覆盖，双方卡死）
    const applied = JSON.parse(await evalJs(`(function(){
      var board = new Array(225).fill(0); board[7*15+7] = 1;
      var q = __GOMOKU_DEBUG.applyState;
      // 先进入对局（自己执白，对手刚下了 (7,7)，轮到白方）
      q({ t:'gomoku.start', matchId:'m-ui', size:15, you:2, board:board.slice(), turn:2, moves:1,
          undoLeft:{1:1,2:1}, canUndo:{1:true,2:false},
          players:{1:{name:'对手',code:'AAA111'},2:{name:'我',code:'BBB222'}},
          last:{x:7,y:7,p:1}, win:null, state:'playing' });
      // 白方落子 (8,8) 后又悔棋 —— 服务端广播的新状态
      var b2 = board.slice(); b2[8*15+8] = 2;
      q({ t:'gomoku.state', matchId:'m-ui', size:15, you:2, board:b2.slice(), turn:2, moves:2,
          undoLeft:{1:1,2:0}, canUndo:{1:true,2:false},
          players:{1:{name:'对手',code:'AAA111'},2:{name:'我',code:'BBB222'}},
          last:{x:8,y:8,p:2}, win:null, state:'playing' });
      // 悔棋帧：棋盘回到只有 (7,7)，轮次回到白方（最后一手仍是黑方的 → 黑方还能悔）
      q({ t:'gomoku.state', matchId:'m-ui', size:15, you:2, board:board.slice(), turn:2, moves:1,
          undoLeft:{1:1,2:0}, canUndo:{1:true,2:false},
          players:{1:{name:'对手',code:'AAA111'},2:{name:'我',code:'BBB222'}},
          last:{x:7,y:7,p:1}, win:null, state:'playing' });
      var G = __GOMOKU_DEBUG.G;
      return JSON.stringify({
        mode:G.mode, my:G.myColor, turn:G.turn, moves:G.moves.length,
        at88:G.board[8*15+8], at77:G.board[7*15+7],
        left:G.undoLeft[2], line:document.getElementById('turnLine').textContent,
        btn:document.getElementById('btnUndo').disabled
      });
    })()`));
    ok('联机帧能真正刷新棋盘（悔棋后不再卡住）', applied.mode === 'online' && applied.moves === 1 && applied.at88 === 0 && applied.at77 === 1,
      'mode=' + applied.mode + ' 手数=' + applied.moves + ' (8,8)=' + applied.at88 + ' (7,7)=' + applied.at77);
    ok('悔棋帧更新轮次与剩余次数', applied.turn === 2 && applied.left === 0, 'turn=' + applied.turn + ' 白剩 ' + applied.left);
    ok('悔棋次数用完 → 按钮禁用', applied.btn === true && applied.left === 0 && /轮到你/.test(applied.line),
      applied.line + ' / 剩余 ' + applied.left + ' 次 / disabled=' + applied.btn);

    // 对方还没应手时可以悔棋：canUndo 为真 → 按钮点亮
    const canU = JSON.parse(await evalJs(`(function(){
      var board = new Array(225).fill(0); board[7*15+7]=1;
      __GOMOKU_DEBUG.applyState({ t:'gomoku.state', matchId:'m-ui', size:15, you:1, board:board, turn:2, moves:1,
        undoLeft:{1:1,2:1}, canUndo:{1:true,2:false},
        players:{1:{name:'我',code:'BBB222'},2:{name:'对手',code:'AAA111'}},
        last:{x:7,y:7,p:1}, win:null, state:'playing' });
      var G = __GOMOKU_DEBUG.G;
      return JSON.stringify({ btn:document.getElementById('btnUndo').disabled, line:document.getElementById('turnLine').textContent });
    })()`));
    ok('自己刚落完、对方未应手 → 可以悔棋', canU.btn === false, '按钮 disabled=' + canU.btn);

    // 对方已经应手（最后一手是对方的）→ 不能悔
    const cantU = JSON.parse(await evalJs(`(function(){
      var board = new Array(225).fill(0); board[7*15+7]=1; board[8*15+8]=2;
      __GOMOKU_DEBUG.applyState({ t:'gomoku.state', matchId:'m-ui', size:15, you:1, board:board, turn:1, moves:2,
        undoLeft:{1:1,2:1}, canUndo:{1:false,2:true},
        players:{1:{name:'我',code:'BBB222'},2:{name:'对手',code:'AAA111'}},
        last:{x:8,y:8,p:2}, win:null, state:'playing' });
      var G = __GOMOKU_DEBUG.G;
      return JSON.stringify({ btn:document.getElementById('btnUndo').disabled, line:document.getElementById('turnLine').textContent });
    })()`));
    ok('对方已应手 → 悔棋按钮不可用', cantU.btn === true, '按钮 disabled=' + cantU.btn);

    // 5.2 落子预览：轮到自己才显示，颜色永远是「当前该落子一方」的棋子颜色
    const lumAt = async (gx, gy) => Number(await evalJs(`(function(){
      var cv=document.getElementById('board'), ctx=cv.getContext('2d'), px=__GOMOKU_DEBUG.px;
      // 用画布真实变换取缩放（cv.width/LOGIC 会因取整而采到网格线上）
      var sc = ctx.getTransform().a, vals=[];
      [[5,5],[-5,-5],[5,-5],[-5,5]].forEach(function(o){
        var d=ctx.getImageData(Math.round((px(${gx})+o[0])*sc), Math.round((px(${gy})+o[1])*sc),1,1).data;
        vals.push((d[0]+d[1]+d[2])/3);
      });
      vals.sort(function(a,b){return a-b;});
      return Math.round((vals[1]+vals[2])/2);
    })()`));
    // 局面：对手（黑）已下 (7,7)，自己执白，当前轮到白方
    const putState = (you, turn) => `(function(){
      var board = new Array(225).fill(0); board[7*15+7] = 1;
      __GOMOKU_DEBUG.applyState({ t:'gomoku.state', matchId:'m-ui', size:15, you:${you}, board:board, turn:${turn}, moves:1,
        undoLeft:{1:1,2:1}, canUndo:${turn === you ? '{1:false,2:false}' : '{1:true,2:false}'},
        players:{1:{name:'对手',code:'AAA111'},2:{name:'我',code:'BBB222'}},
        last:{x:7,y:7,p:1}, win:null, state:'playing' });
    })()`;

    // 基准：无悬停
    await evalJs(putState(2, 2) + ";(function(){var G=__GOMOKU_DEBUG.G;G.hx=-1;G.hy=-1;G.rx=-1;G.ry=-1;__GOMOKU_DEBUG.render();return 1;})()");
    const base22 = await lumAt(2, 2), base44 = await lumAt(4, 4);

    // 轮到自己（白方）→ 鼠标悬停产生白色预览
    const pvPos = JSON.parse(await evalJs(`(function(){
      var cv=document.getElementById('board'), r=cv.getBoundingClientRect();
      var scale = r.width / (14*36+68);
      return JSON.stringify({x:r.left+(34+2*36)*scale, y:r.top+(34+2*36)*scale});
    })()`));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pvPos.x, y: pvPos.y, buttons: 0 });
    await sleep(220);
    const hvState = await evalJs("JSON.stringify({hx:__GOMOKU_DEBUG.G.hx, hy:__GOMOKU_DEBUG.G.hy, turn:__GOMOKU_DEBUG.G.turn, my:__GOMOKU_DEBUG.G.myColor})");
    const myPv = await lumAt(2, 2);
    ok('鼠标移到交叉点会产生落子预览', JSON.parse(hvState).hx === 2 && JSON.parse(hvState).hy === 2, hvState);
    ok('轮到自己时预览是自己棋子颜色（白方显白子）', myPv > base22 + 8,
      '空盘 ' + base22 + ' → 白方预览 ' + myPv + '（' + hvState + '）');

    // 换成黑方回合：自己的预览消失，对方（黑）的预览可见
    await evalJs(putState(2, 1) + ";(function(){var G=__GOMOKU_DEBUG.G;G.hx=2;G.hy=2;G.rx=4;G.ry=4;__GOMOKU_DEBUG.render();return 1;})()");
    const offPv22 = await lumAt(2, 2);
    const oppPv44 = await lumAt(4, 4);
    ok('没轮到自己时不显示自己的预览', offPv22 < base22 + 12, '空盘 ' + base22 + ' → 现在 ' + offPv22);
    ok('能看到对方的落子预览（黑方显黑子）', oppPv44 < base44 - 12, '(4,4) 空盘 ' + base44 + ' → 对方预览 ' + oppPv44);
    await shot('9-gomoku-preview');

    console.log('\n== 6. 全程错误汇总 ==');
    ok('全流程无 JS 报错', errors.length === 0, errors.length ? errors.join(' | ') : '无');

    console.log('\n截图已保存到 ' + SHOTS);
  } catch (e) {
    console.error('\n[界面自检异常] ' + e.message);
    fails++;
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) { /* noop */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }

  console.log('\n' + (fails === 0 ? ('界面自检全部通过 ✔  (' + passes + ' 项)') : (fails + ' 项失败，' + passes + ' 项通过')));
  process.exit(fails === 0 ? 0 : 1);
})();
