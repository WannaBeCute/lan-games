'use strict';
/**
 * 底力练习器自检： node tools/dilitest.js（自带临时服务端，不依赖外部）
 *
 * 覆盖：
 *   - 内核 dilicore：加速曲线、键位映射、坚持时间、评语、上榜单判定
 *   - 服务端排行榜：提交/查询/名次、同分排序、分数合理性校验、
 *                   自定义时长不上榜、限时预选档/无尽分榜互不串
 *   - 皮肤广场：上传/列表/获取、非法素材拒绝、超大皮肤拒绝
 *   - 平台约定：Hub.hidden（不在 /api/status 游戏列表里）+ /dili/ 直连可访问
 *   - 持久化：服务端重启后榜单还在
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dili-'));

let fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log('  [通过] ' + name + (extra != null ? '  ' + extra : '')); }
  else { fails++; console.log('  [失败] ' + name + '  ' + (extra != null ? extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let PROC = null;
let SRVLOG = '';
async function startServer(extraEnv) {
  const port = await freePort();
  SRVLOG = '';
  PROC = spawn(process.execPath, [SERVER, '--port', String(port)], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { WB_TEST_HOOKS: '1', WB_DILI_DATA_DIR: TMP }, extraEnv || {})
  });
  PROC.stdout.on('data', d => { SRVLOG += d.toString(); });
  PROC.stderr.on('data', d => { SRVLOG += d.toString(); });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + '/api/status'); if (r.ok) break; } catch (e) { /* 还没起来 */ }
    await sleep(100);
  }
  return { port, base };
}
async function stopServer() {
  if (!PROC) return;
  try { PROC.kill(); } catch (e) { /* 已退出 */ }
  PROC = null;
  await sleep(300);
}

function client(tag, port, fip) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws' + (fip ? '?fip=' + fip : ''));
    const c = { tag, ws, msgs: [], handlers: {}, ptr: {} };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      c.msgs.push(m);
      (c.handlers[m.t] || []).forEach(fn => fn(m));
    };
    c.send = (o) => ws.send(JSON.stringify(o));
    c.wait = (type, timeout = 6000) => {
      const list = c.msgs.filter(m => m.t === type);
      if (list.length > (c.ptr[type] || 0)) { c.ptr[type] = (c.ptr[type] || 0) + 1; return Promise.resolve(list[c.ptr[type] - 1]); }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('[' + tag + '] 等待 ' + type + ' 超时')), timeout);
        const h = (m) => { if (m.t !== type) return; clearTimeout(timer); c.ptr[type] = (c.ptr[type] || 0) + 1; res(m); };
        (c.handlers[type] || (c.handlers[type] = [])).push(h);
      });
    };
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error('连接失败'));
  });
}

async function hello(c) {
  c.send({ t: 'hello', name: c.tag });
  await c.wait('hello');
}

/* 1x1 透明 PNG 与最小合法音效 data URI */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

async function main() {
  console.log('\n== 一、内核 dilicore ==');
  const TC = require(path.join(ROOT, 'games', 'dili', 'shared', 'dilicore.js'));
  ok('基础滚动间隔 180ms/行', TC.transitionMs(20) === 180, TC.transitionMs(20));
  ok('剩余行少时加速：r=2 → 90ms', TC.transitionMs(2) === 90, TC.transitionMs(2));
  ok('极限加速封顶 3 倍：r=0 → 60ms', TC.transitionMs(0) === 60, TC.transitionMs(0));
  ok('中间回落：r=5 → 103ms（1 + 3×0.25 倍）', TC.transitionMs(5) === 103, TC.transitionMs(5));
  const m4 = TC.keyMapping('dfjk', 4);
  ok('4K 默认键位 dfjk 各占一轨', m4.keyToTrack.d === 0 && m4.keyToTrack.f === 1 && m4.keyToTrack.j === 2 && m4.keyToTrack.k === 3);
  const m6 = TC.keyMapping('', 6);
  ok('6K 默认键位 sdfjkl', m6.keyToTrack.s === 0 && m6.keyToTrack.l === 5, Object.keys(m6.keyToTrack).join(''));
  ok('5K 默认键位是 D F 空格 J K（中间那颗是空格）', TC.defaultKeys(5) === 'df jk', TC.defaultKeys(5));
  ok('5K 默认键位解析出 5 条轨道，第 3 轨是空格',
    (function () { const m = TC.keyMapping('', 5); return m.trackKeys.length === 5 && m.trackKeys[2].join('') === ' '; })());
  const mb = TC.keyMapping('s~df~jk~l', 6);
  ok('~ 绑键：s/d 同轨', mb.keyToTrack.s === 0 && mb.keyToTrack.d === 0);
  ok('~ 绑键：f/j 同轨、k/l 同轨', mb.keyToTrack.f === 1 && mb.keyToTrack.j === 1 && mb.keyToTrack.k === 2 && mb.keyToTrack.l === 2);
  ok('随机轨道落在范围内', (function () { for (let i = 0; i < 200; i++) { const t = TC.nextTrack(null, 4); if (t < 0 || t > 3) return false; } return true; })());
  ok('限时 20/60/180 上榜、自定义 30 不上榜', TC.uploadable('timed', 20) && TC.uploadable('timed', 180) && !TC.uploadable('timed', 30));
  ok('无尽模式始终上榜', TC.uploadable('endless', 0));
  ok('榜单 key 与服务端一致', TC.boardKey('timed', 4, 60) === 'timed_4_60' && TC.boardKey('endless', 5, 0) === 'endless_5_0');
  ok('评语分层（3t/6t/9t/12t）',
    TC.shareText(10, 20) === '加油！我相信您可以的！' &&
    TC.shareText(70, 20) === '^_^ 加把劲，底力大王就是您！' &&
    TC.shareText(150, 20) === '您！' &&
    TC.shareText(200, 20) === '太 您 了！' &&
    TC.shareText(300, 20) === '您是外星人嘛？');
  const dev = TC.deviationTime({ start: 0, end: 20000, pausedMs: 0, lastTap: 19500, score: 100, timeLimit: 20 });
  ok('坚持时间取多口径最大（最后按键 19.5s 主导）', dev === 19500, String(dev));

  console.log('\n== 二、服务端装配 ==');
  let srv = await startServer();
  const st = await (await fetch(srv.base + '/api/status')).json();
  ok('Hub.hidden：主页游戏列表里没有底力练习器', !st.games.some(g => g.name === 'dili'));
  const page = await fetch(srv.base + '/dili/');
  ok('/dili/ 直连可访问（hidden 不挡静态挂载）', page.status === 200);
  const core = await fetch(srv.base + '/dili/shared/dilicore.js');
  ok('内核静态挂载可用', core.status === 200);

  const A = await client('小明', srv.port, '10.9.0.1');
  await hello(A);
  A.send({ t: 'dili.register' });
  const hi = await A.wait('dili.hello');
  ok('register 后服务端回 dili.hello', !!hi);

  console.log('\n== 三、排行榜 ==');
  A.send({ t: 'dili.board.submit', mode: 'timed', keys: 4, seconds: 20, score: 100, timeMs: 20000, cps: 5, errors: 1 });
  let r = await A.wait('dili.board.result');
  ok('提交上榜并返回名次', r.rank === 1, 'rank=' + r.rank);
  A.send({ t: 'dili.board.get', mode: 'timed', keys: 4, seconds: 20 });
  r = await A.wait('dili.board');
  ok('查询返回刚提交的成绩', r.list.length === 1 && r.list[0].score === 100 && r.list[0].name === '小明');

  // 不同连接 = 不同 clientId，绕过提交限速
  const B = await client('阿强', srv.port, '10.9.0.2');
  await hello(B);
  B.send({ t: 'dili.board.submit', mode: 'timed', keys: 4, seconds: 20, score: 250, timeMs: 20000, cps: 12.5, errors: 0 });
  r = await B.wait('dili.board.result');
  ok('高分排前面（rank=1）', r.rank === 1);
  A.send({ t: 'dili.board.get', mode: 'timed', keys: 4, seconds: 20 });
  r = await A.wait('dili.board');
  ok('同分排序不串榜、两人都在榜上', r.list.length === 2 && r.list[0].score === 250 && r.list[1].score === 100);

  /* 服务端对提交有 3 秒限速（按连接算），后续提交各用一条新连接 */
  let fipSeq = 20;
  async function fresh(name, fip) {
    const c = await client(name, srv.port, fip || ('10.0.0.' + (fipSeq++)));
    await hello(c);
    return c;
  }

  let B2 = await fresh('阿强');
  B2.send({ t: 'dili.board.submit', mode: 'timed', keys: 4, seconds: 30, score: 999, timeMs: 30000, cps: 33, errors: 0 });
  r = await B2.wait('dili.board.noupload');
  ok('自定义时长（30s）明确不上榜', !!r);
  B2.ws.close();

  let B3 = await fresh('阿强');
  B3.send({ t: 'dili.board.submit', mode: 'timed', keys: 4, seconds: 20, score: 999999, timeMs: 20000, cps: 50, errors: 0 });
  r = await B3.wait('dili.board.reject');
  ok('分数超过合理性上限被拒', /不合法|异常/.test(r.msg), r.msg);
  B3.ws.close();

  let B4 = await fresh('阿强');
  B4.send({ t: 'dili.board.submit', mode: 'timed', keys: 4, seconds: 60, score: 50000, timeMs: 60000, cps: 833, errors: 0 });
  r = await B4.wait('dili.board.reject');
  ok('每秒 > 40 分的数据异常被拒', /异常/.test(r.msg), r.msg);
  B4.ws.close();

  let B5 = await fresh('阿强');
  B5.send({ t: 'dili.board.submit', mode: 'endless', keys: 5, seconds: 0, score: 88, timeMs: 30000, cps: 6.25, errors: 1 });
  r = await B5.wait('dili.board.result');
  ok('无尽模式按 5K 单独成榜', r.board === 'endless_5_0' && r.rank === 1);
  ok('★ 无尽榜按最终速度计分（cps×100 = 625）', r.ownBest && r.ownBest.score === 625, JSON.stringify(r.ownBest));
  B5.ws.close();

  /* 无尽模式的速度上限校验 */
  let B5b = await fresh('阿强');
  B5b.send({ t: 'dili.board.submit', mode: 'endless', keys: 4, seconds: 0, score: 9999, timeMs: 30000, cps: 55, errors: 0 });
  r = await B5b.wait('dili.board.reject');
  ok('无尽速度超过 40 键/秒被拒', /速度|异常/.test(r.msg), r.msg);
  B5b.ws.close();

  A.send({ t: 'dili.board.get', mode: 'endless', keys: 4, seconds: 0 });
  r = await A.wait('dili.board');
  ok('无尽 4K 与 5K 互不串榜', r.list.length === 0);

  /* ---- 每人（按 IP）每榜只留最优 ---- */
  const A2 = await fresh('小明', '10.9.0.1');          // 同一台电脑（同 IP）再来
  A2.send({ t: 'dili.board.submit', mode: 'timed', keys: 4, seconds: 20, score: 90, timeMs: 20000, cps: 4.5, errors: 1 });
  r = await A2.wait('dili.board.result');
  ok('同一个人没破纪录：improved=false，名次仍是原记录', r.improved === false && r.rank === 2, JSON.stringify({ improved: r.improved, rank: r.rank }));
  A2.send({ t: 'dili.board.get', mode: 'timed', keys: 4, seconds: 20 });
  r = await A2.wait('dili.board');
  ok('★ 榜单里同一人只有一条记录', r.list.filter(e => e.name === '小明').length === 1, '条数=' + r.list.filter(e => e.name === '小明').length);
  ok('★ 保留的是最优成绩（100 不是 90）', r.list.find(e => e.name === '小明').score === 100);

  const A3 = await fresh('小明', '10.9.0.1');
  A3.send({ t: 'dili.board.submit', mode: 'timed', keys: 4, seconds: 20, score: 400, timeMs: 20000, cps: 20, errors: 0 });
  r = await A3.wait('dili.board.result');
  ok('破纪录：improved=true 且升到第 1', r.improved === true && r.rank === 1);
  ok('记录带创造时间（date 是毫秒时间戳）', typeof r.ownBest.date === 'number' && r.ownBest.date > 1600000000000, String(r.ownBest.date));

  /* ---- 点赞：一人一票，不能赞自己 ---- */
  const C1 = await fresh('路人甲', '10.9.0.3');
  C1.send({ t: 'dili.like', mode: 'timed', keys: 4, seconds: 20, target: '10.9.0.1' });
  r = await C1.wait('dili.like.ok');
  ok('点赞成功并返回数量 1', r.likes === 1 && r.already === false, JSON.stringify(r));
  C1.send({ t: 'dili.like', mode: 'timed', keys: 4, seconds: 20, target: '10.9.0.1' });
  r = await C1.wait('dili.like.ok');
  ok('同一个人重复点赞不叠加（仍是 1）', r.likes === 1 && r.already === true);
  C1.send({ t: 'dili.like', mode: 'timed', keys: 4, seconds: 20, target: '10.9.0.3' });
  r = await C1.wait('dili.like.fail');
  ok('不能给自己点赞', /自己/.test(r.msg), r.msg);
  C1.send({ t: 'dili.board.get', mode: 'timed', keys: 4, seconds: 20 });
  r = await C1.wait('dili.board');
  ok('榜单里能看到点赞数与趋势字段',
    r.list[0].likes === 1 && 'trend' in r.list[0] && 'date' in r.list[0],
    JSON.stringify({ likes: r.list[0].likes, trend: r.list[0].trend }));
  C1.ws.close();

  console.log('\n== 四、皮肤广场 ==');
  const B6 = await fresh('阿强');   // 上传限速 10s/连接，换新连接
  B6.send({ t: 'dili.skin.upload', skin: { name: '测试皮肤', bg: PNG, note: PNG, hit: PNG, hitOpacity: 0.6, hitSound: WAV } });
  r = await B6.wait('dili.skin.upload.ok');
  const skinId = r.id;
  ok('合法皮肤上传成功', !!skinId && r.name === '测试皮肤');

  A.send({ t: 'dili.skin.list' });
  r = await A.wait('dili.skins');
  ok('广场列表能看到刚上传的皮肤', r.list.some(s => s.id === skinId && s.name === '测试皮肤'));

  A.send({ t: 'dili.skin.get', id: skinId });
  r = await A.wait('dili.skin.one');
  ok('按 id 拉取皮肤，素材完整、透明度正确',
    r.skin && r.skin.note === PNG && r.skin.hitOpacity === 0.6 && r.skin.hitSound === WAV && r.skin.author === '阿强');

  const B7 = await fresh('阿强');
  B7.send({ t: 'dili.skin.upload', skin: { name: '坏皮肤', note: 'http://evil/x.png' } });
  r = await B7.wait('dili.skin.upload.fail');
  ok('非 data URI 的素材被拒', /合法/.test(r.msg), r.msg);
  B7.ws.close();

  const B8 = await fresh('阿强');
  B8.send({ t: 'dili.skin.upload', skin: { name: '大皮肤', note: 'data:image/png;base64,' + 'A'.repeat(900 * 1024) } });
  r = await B8.wait('dili.skin.upload.fail');
  ok('超大素材被拒（单件 ≤ 900KB）', /太大|900/.test(r.msg), r.msg);
  B8.ws.close();

  A.send({ t: 'dili.skin.get', id: '不存在的id!' });
  r = await A.wait('dili.skin.get.fail');
  ok('拉取不存在的皮肤返回失败', /不存在/.test(r.msg));

  console.log('\n== 五、持久化（重启服务端） ==');
  await sleep(800);          // 给 500ms 防抖刷盘留时间（进程退出钩子也能兜底）
  await stopServer();
  srv = await startServer();
  const C = await client('小刚', srv.port);
  await hello(C);
  C.send({ t: 'dili.board.get', mode: 'timed', keys: 4, seconds: 20 });
  r = await C.wait('dili.board');
  ok('重启后榜单还在（落盘生效，含去重后的最优成绩与点赞数）',
    r.list.length === 2 && r.list[0].score === 400 && r.list[0].likes === 1,
    JSON.stringify({ n: r.list.length, top: r.list[0] && r.list[0].score, likes: r.list[0] && r.list[0].likes }));
  C.send({ t: 'dili.skin.list' });
  r = await C.wait('dili.skins');
  ok('重启后皮肤广场还在', r.list.some(s => s.id === skinId));

  C.ws.close();
  await stopServer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

  console.log('\n========================================');
  console.log(fails === 0
    ? '全部通过 ✔ (' + passes + ' 项)'
    : '有 ' + fails + ' 项失败（通过 ' + passes + ' 项）');
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('自检异常：', e && e.message || e);
  await stopServer();
  process.exit(1);
});
