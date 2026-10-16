'use strict';
/**
 * 你画我猜 · 自检（服务端规则 / 联机流程）
 *
 * 自己拉起一个临时端口的服务端，用真实 WebSocket 客户端把几个玩家拉进来，
 * 把需求里的规则一条条跑一遍：人数上限、时长上下限、类别默认全选、
 * 轮换默认开启、身份/准备门槛、抢画者排序与自动开始、抽签画者、
 * 提示 30% 门槛与扣分、换题上限、猜错冷却、全房可见的猜词与聊天、
 * 画板操作（笔迹/形状/填充/图层）与撤销重做、轮换一圈才算一局、
 * 终局结算与退出房间。
 *
 * 用法：node tools/drawguess_test.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  [通过] ' + label); }
  else { fail++; console.log('  [失败] ' + label + (extra ? '  → ' + extra : '')); }
}
function group(name) { console.log('\n== ' + name + ' =='); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- 极简 WebSocket 客户端（只用文本帧，够测试用） ---------- */
class MiniWS {
  constructor(url) {
    this.handlers = [];
    this.ready = false;
    const u = new URL(url);
    const crypto = require('crypto');
    const key = crypto.randomBytes(16).toString('base64');
    this.sock = require('net').connect(Number(u.port), u.hostname, () => {
      this.sock.write(
        'GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    this.buf = Buffer.alloc(0);
    this.upgraded = false;
    this.sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      if (!this.upgraded) {
        const i = this.buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        this.buf = this.buf.slice(i + 4);
        this.upgraded = true;
        this.ready = true;
      }
      this._parse();
    });
    this.sock.on('error', () => {});
  }
  _parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      if (masked) {
        const key = this.buf.slice(off - 4, off);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
      }
      this.buf = this.buf.slice(off + len);

      if (opcode === 1) {
        let msg;
        try { msg = JSON.parse(payload.toString()); } catch (e) { continue; }
        for (const h of this.handlers) h(msg);
      } else if (opcode === 2) {
        continue;
      } else if (opcode === 8) {
        this.sock.end();
        return;
      } else if (opcode === 9) {
        this._frame(payload, 0x0a);
      } else if (opcode === 10) {
        continue;
      }
    }
  }
  _frame(data, opcode) {
    const len = data.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    this.sock.write(Buffer.concat([head, data]));
  }
  send(obj) { if (this.upgraded) this._frame(Buffer.from(JSON.stringify(obj)), 0x1); }
  on(fn) { this.handlers.push(fn); }
  close() {
    try {
      if (this.upgraded && !this.sock.destroyed) {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(1000, 0);
        this._frame(b, 0x08);
      }
    } catch (e) { /* noop */ }
    try { this.sock.end(); } catch (e) { }
    setTimeout(() => { try { this.sock.destroy(); } catch (e) { } }, 60);
  }
}

class Player {
  constructor(url, name) {
    this.ws = new MiniWS(url);
    this.name = name;
    this.msgs = [];
    this.id = 0;
    this.ws.on((m) => {
      this.msgs.push(m);
      if (m.t === 'hello') {
        this.id = m.id;
        if (!this.named) { this.named = true; this.ws.send({ t: 'hello', name: name }); }
      }
    });
  }
  send(o) { this.ws.send(o); }
  get closed() { return this.ws.sock.destroyed || this.ws.sock.writableEnded; }
  last(type) { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === type) return this.msgs[i]; return null; }
  all(type) { return this.msgs.filter((m) => m.t === type); }
  clear() { this.msgs = []; }
  mark() { return this.msgs.length; }
  async wait(type, ms, since) {
    const from = since == null ? 0 : since;
    const end = Date.now() + (ms || 3000);
    while (Date.now() < end) {
      for (let i = this.msgs.length - 1; i >= from; i--) if (this.msgs[i].t === type) return this.msgs[i];
      await sleep(20);
    }
    return null;
  }
  close() { this.ws.close(); }
}

/* 一个新的画板操作（服务端只认白名单字段）
   m = 模式（pen/erase/smudge），z = 笔刷 id（12 种之一） */
function op(extra) {
  return Object.assign({
    t: 'ydwg.draw', k: 'seg', S: 's1', L: 0,
    x: 0.5, y: 0.5, px: 0.4, py: 0.4, c: '#e5533d', w: 0.012, a: 1, m: 'pen', z: 'pencil'
  }, extra || {});
}

async function main() {
  const port = 5300 + Math.floor(Math.random() * 400);
  const base = 'ws://127.0.0.1:' + port + '/ws';
  const srv = spawn(process.execPath, [path.join(ROOT, 'platform/server/server.cjs'), '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    // 打开测试钩子，才能用 ?fip= 指定"这台机器"的 IP，用来验证房主重连拿回身份
    env: Object.assign({}, process.env, { WB_TEST_HOOKS: '1' })
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d.toString(); if (process.env.YDWG_VERBOSE) process.stdout.write(d); });
  srv.stderr.on('data', (d) => { log += d.toString(); if (process.env.YDWG_VERBOSE) process.stdout.write(d); });

  let up = false;
  for (let i = 0; i < 80; i++) {
    await sleep(80);
    try { await new Promise((res, rej) => { const s = require('net').connect(port, '127.0.0.1', () => { s.end(); res(); }); s.on('error', rej); }); up = true; break; } catch (e) { }
  }
  if (!up) { console.log('服务端没起来\n' + log); srv.kill(); process.exit(1); }

  try {
    await runTests(base, log);
  } finally {
    srv.kill();
  }
  console.log('\n共 ' + (pass + fail) + ' 项：通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

async function runTests(base) {
  const Hub = require(path.join(ROOT, 'games/drawguess/server/room.js'));
  const RULES = Hub.RULES;

  /* ========== 题库 ========== */
  group('A. 题库');
  const WORDS = require(path.join(ROOT, 'games/drawguess/shared/words.js'));

  /* 客户端渲染没法在这里跑，但两个踩过的坑可以用源码断言挡住回归 */
  group('A2. 客户端回归守卫');
  const fs = require('fs');
  const padSrc = fs.readFileSync(path.join(ROOT, 'games/drawguess/client/paintpad.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'games/drawguess/client/main.js'), 'utf8');
  ok(/var key = [^;]*rgb\.r/.test(padSrc),
    '★ 笔刷戳子的缓存键带上了颜色分量（否则换色还是画成第一个颜色）', '');
  ok(/net\.on\('ydwg\.chat'/.test(mainSrc),
    '★ 客户端有处理 ydwg.chat（否则聊天发出去就没了）', '');
  ok(/localStorage\.getItem\('drawguess\.room'\)/.test(mainSrc) === false,
    '房间号/身份用 sessionStorage（每个标签页独立，重载还留得住）', '');

  /* v3：至少 10 种笔刷，而且笔刷白名单必须和服务端对得上 */
  const mBrushBlock = padSrc.match(/var BRUSHES = \[([\s\S]*?)\n  \];/);
  const padBrushIds = mBrushBlock
    ? (mBrushBlock[1].match(/id: '([a-z0-9_]+)'/g) || []).map((s) => s.replace(/id: '|'/g, ''))
    : [];
  ok(padBrushIds.length >= 10, '★ 笔刷至少 10 种', padBrushIds.length + ' 种：' + padBrushIds.join('/'));
  ok(new Set(padBrushIds).size === padBrushIds.length, '笔刷 id 没有重复', String(padBrushIds.length));
  const roomSrc = fs.readFileSync(path.join(ROOT, 'games/drawguess/server/room.js'), 'utf8');
  const mBrushes = roomSrc.match(/const BRUSH_IDS = \[([\s\S]*?)\];/);
  const srvBrushIds = mBrushes ? (mBrushes[1].match(/'([a-z0-9_]+)'/g) || []).map((s) => s.replace(/'/g, '')) : [];
  ok(srvBrushIds.length && padBrushIds.every((b) => srvBrushIds.indexOf(b) >= 0),
    '★ 服务端笔刷白名单覆盖客户端全部笔刷（否则会被静默换成铅笔）',
    'srv=' + srvBrushIds.join('/'));
  /* 三种模式（画笔/橡皮/涂抹）都要能被服务端接受 */
  ok(/MODES_OK = \['pen', 'erase', 'smudge'\]/.test(roomSrc), '服务端接受 pen/erase/smudge 三种模式', '');
  /* 撤销按整笔：服务端必须把同一条笔画的 seg 一起弹掉 */
  ok(/prev\.k === 'seg' && prev\.S === last\.S/.test(roomSrc),
    '★ 撤销按"整笔"回退（否则只弹掉 sege，画面看起来撤销没反应）', '');
  /* 每条笔刷/每个模式都要有独立参数袋 */
  ok(/this\.cfg = \{ pen: \{\}, erase: \{\}, smudge: \{\} \}/.test(padSrc),
    '★ 粗细/不透明度按「模式 × 笔刷」各自存一份', '');
  /* 客户端与服务端的历史条数上限必须一致，否则 truncate 会错位 */
  const mOpLimit = padSrc.match(/OP_LIMIT = (\d+)/);
  const mMaxOps = roomSrc.match(/MAX_OPS = (\d+)/);
  ok(mOpLimit && mMaxOps && mOpLimit[1] === mMaxOps[1],
    '★ 客户端 OP_LIMIT 与服务端 MAX_OPS 一致（否则撤销会错位）',
    (mOpLimit ? mOpLimit[1] : '?') + ' vs ' + (mMaxOps ? mMaxOps[1] : '?'));
  /* 只读时隐藏工具栏 + 滚轮平移/Ctrl 缩放 */
  const padCssSrc = fs.readFileSync(path.join(ROOT, 'games/drawguess/client/paintpad.css'), 'utf8');
  ok(/\.pp-root\.viewonly \.pp-side/.test(padCssSrc), '★ 只读（猜的人）时隐藏整个左侧工具栏', '');
  ok(/ev\.ctrlKey \|\| ev\.metaKey[\s\S]{0,300}zoomAt/.test(padSrc) && /else \{[\s\S]{0,140}panBy/.test(padSrc),
    '★ 滚轮 = 平移画布，Ctrl/⌘ + 滚轮 = 缩放', '');
  ok(/bindPanTrack/.test(padSrc), '左边/下边有可拖动的平移条', '');
  // 画纸比例必须固定：不然全屏/拉窗口时归一化坐标被拉伸，笔迹就变形了
  ok(/var PAGE_AR = 4 \/ 3;/.test(padSrc) && /w = h \* PAGE_AR/.test(padSrc),
    '★ 画布按固定比例（4:3）内缩居中，缩放/全屏都不会把笔迹拉伸', '');
  ok(/\.pp-canvas \{[^}]*left: 50%/.test(padCssSrc), '画布在容器里居中（而不是撑满）', '');
  // 本局信息 / 角色提示 这些新面板
  ok(/function renderInfo\(m\)/.test(mainSrc) && /function showRoleBanner\(m\)/.test(mainSrc),
    '★ 有"本局信息"面板和"本轮你是画者/猜的人"弹窗', '');
  ok(/foldBtn/.test(mainSrc) && /data-fold="scorePanel"/.test(
    fs.readFileSync(path.join(ROOT, 'games/drawguess/client/index.html'), 'utf8')),
    '★ 本局信息 / 积分排行榜 / 聊天区 都能收起', '');
  for (const c of WORDS.CATEGORIES) {
    ok(c.words.length >= 50, '类别「' + c.name + '」至少 50 个词', c.words.length + ' 个');
  }
  ok(WORDS.CATEGORIES.length >= 4, '类别数量至少 4 个', WORDS.CATEGORIES.length + ' 个');
  const all = WORDS.allWords();
  const texts = all.map((w) => w.text);
  // 画板不许写字：题面本身也不能是纯数字/纯字母，否则没法画
  const bad = texts.filter((t) => /[0-9]/.test(t) || /^[A-Za-z\s]+$/.test(t));
  ok(bad.length === 0, '没有数字题 / 纯字母题（画板不许写字）', bad.join('、'));
  const dup = texts.filter((t, i) => texts.indexOf(t) !== i);
  ok(new Set(dup).size === 0, '同一个词没有在不同类别里重复出现', Array.from(new Set(dup)).slice(0, 5).join('、'));
  // 用户点名过的那条：樱桃小丸子相关必须是日本动画，不是国产动画
  const cherry = all.filter((w) => w.text.indexOf('小丸子') >= 0);
  ok(cherry.length >= 1 && cherry.every((w) => /日本/.test(w.origin)),
    '「樱桃小丸子」及其家人的出处是日本动画（不是国产动画）',
    cherry.map((w) => w.text + '→' + w.origin).join('、'));
  const batman = all.filter((w) => w.text === '蝙蝠侠')[0];
  ok(batman && /DC/.test(batman.origin), '「蝙蝠侠」的出处是 DC（不是漫威）', batman ? batman.origin : '缺');
  const yaya = all.filter((w) => w.text === '蜡笔小新')[0];
  ok(yaya && /日本/.test(yaya.origin), '「蜡笔小新」的出处是日本动画', yaya ? yaya.origin : '缺');

  /* ========== 房间与设置 ========== */
  group('B. 房间与房主设置');
  const host = new Player(base, '房主');
  await host.wait('hello', 2000);
  host.send({ t: 'ydwg.create' });
  const created = await host.wait('ydwg.created');
  ok(!!created, '房主能创建房间并拿到房间号', JSON.stringify(created));
  const code = created.code;
  ok(/^\d{4}$/.test(code), '房间号是 4 位数字', code);

  const room0 = await host.wait('ydwg.room');
  ok(!!room0, '房主收到房间状态');
  ok(room0.settings.categories.length === WORDS.CATEGORIES.length, '类别默认全选', room0.settings.categories.length + '/' + WORDS.CATEGORIES.length);
  ok(room0.maxPlayers === 10, '人数上限 10 人（含房主）', String(room0.maxPlayers));
  ok(room0.settings.minutes === 5, '默认时长 5 分钟', String(room0.settings.minutes));
  ok(room0.settings.rotate === true, '★ 画者轮换默认开启', String(room0.settings.rotate));
  ok(room0.settings.rounds === 5, '★ 轮换模式默认 5 局', String(room0.settings.rounds));

  async function setAndRead(payload) {
    const mark = host.mark();
    host.send(Object.assign({ t: 'ydwg.settings' }, payload));
    return (await waitRoom(host, 900, mark)).settings || {};
  }
  ok((await setAndRead({ minutes: 1 })).minutes === 1, '时长下限 1 分钟可用');
  ok((await setAndRead({ minutes: 30 })).minutes === 30, '时长上限 30 分钟可用');
  ok((await setAndRead({ minutes: 999 })).minutes === 30, '超过上限被夹到 30', '');
  ok((await setAndRead({ minutes: 0 })).minutes === 1, '低于下限被夹到 1', '');
  await setAndRead({ minutes: 5 });

  ok((await setAndRead({ rounds: 100 })).rounds === 100, '局数上限 100', '');
  ok((await setAndRead({ rounds: 5000 })).rounds === 100, '超过 100 局被夹住', '');
  const rFixed = await setAndRead({ rotate: false });
  ok(rFixed.rotate === false && rFixed.rounds === 10, '★ 关掉轮换后默认变成 10 局', JSON.stringify(rFixed));
  const rBack = await setAndRead({ rotate: true });
  ok(rBack.rotate === true && rBack.rounds === 5, '★ 打开轮换又回到默认 5 局', JSON.stringify(rBack));

  let s2 = await setAndRead({ categories: ['动物'] });
  ok(s2.categories.length === 1 && s2.categories[0] === '动物', '房主可以只留一个类别', JSON.stringify(s2.categories));
  s2 = await setAndRead({ categories: [] });
  ok(s2.categories.length >= 1, '一个都不选时至少保留一个类别', '');
  await setAndRead({ categories: WORDS.CATEGORIES.map((c) => c.name) });

  const p2 = new Player(base, '小明');
  await p2.wait('hello', 2000);
  p2.send({ t: 'ydwg.join', code: code });
  const joined = await p2.wait('ydwg.joined');
  ok(!!joined, '第二个人能按房间号加入');
  p2.clear();
  p2.send({ t: 'ydwg.settings', minutes: 20 });
  const errP2 = await p2.wait('ydwg.error', 800);
  ok(!!errP2 && /房主/.test(errP2.msg), '非房主改设置被拒绝并收到提示', JSON.stringify(errP2));

  /* ========== 人数上限 ========== */
  group('C. 人数上限');
  const extras = [];
  for (let i = 0; i < 9; i++) {
    const p = new Player(base, '闲' + i);
    await p.wait('hello', 1500);
    p.send({ t: 'ydwg.join', code: code });
    extras.push(p);
  }
  await sleep(400);
  const rFull = await waitRoom(host, 600);
  ok(rFull.members.length === 10, '满房就是 10 人（10 人上限含房主）', rFull.members.length + ' 人');
  const rejected = extras.filter((p) => p.last('ydwg.error'));
  ok(rejected.length >= 1, '第 11 个人被拒绝', rejected.length + ' 人收到提示');
  ok(/满/.test((rejected[0] && rejected[0].last('ydwg.error').msg) || ''), '拒绝原因是「房间已满」', rejected[0] ? rejected[0].last('ydwg.error').msg : '');
  const mk = host.mark();
  for (const p of extras) p.close();
  const rCleared = await waitRoom(host, 4000, mk);
  ok(rCleared.activeCount === 2 && rCleared.members.length === 2,
    '★ 大厅里走的人直接清掉（还没参与过，不必留档）', rCleared.activeCount + ' 人 / 名单 ' + rCleared.members.length + ' 人');
  ok(rCleared.members.map((m) => m.name).sort().join(',') === '小明,房主',
    '剩下的正是房主和小明', rCleared.members.map((m) => m.name).join(','));

  /* ========== 不轮换：身份 · 准备门槛 · 抽签 ========== */
  group('D. 不轮换 · 身份 / 准备门槛 / 抽签画者');
  host.clear(); p2.clear();
  let rmark = host.mark();
  host.send({ t: 'ydwg.settings', rotate: false, minutes: 1, rounds: 3 });
  await waitRoom(host, 900, rmark);

  // 没选身份不能准备
  p2.clear();
  p2.send({ t: 'ydwg.ready', ready: true });
  const e0 = await p2.wait('ydwg.error', 900);
  ok(!!e0 && /身份/.test(e0.msg), '★ 还没选身份时不能点准备', e0 ? e0.msg : '（没有收到提示）');

  // 两个人都不愿意当画者 → 抽签
  rmark = host.mark();
  host.send({ t: 'ydwg.role', willDraw: false });
  p2.send({ t: 'ydwg.role', willDraw: false });
  const rRole = await waitRoom(host, 900, rmark);
  ok(rRole.members.length === 2 && rRole.members.every((m) => m.roleChosen === true),
    '★ 每个人都能选「愿不愿意当画者」', JSON.stringify(rRole.members.map((m) => [m.willDraw, m.roleChosen])));
  ok(rRole.members.every((m) => m.willDraw === false), '★ 人员列表里能看到这个身份', '');
  ok(rRole.ready.noRole.length === 0 && rRole.ready.waiting.length === 1, '★ 身份表明"还差谁准备"', JSON.stringify(rRole.ready));

  // 有人没准备 → 房主开不了局
  host.clear();
  host.send({ t: 'ydwg.start' });
  const estart = await host.wait('ydwg.error', 1200);
  ok(!!estart && /没准备好/.test(estart.msg), '★ 有人没准备时房主开不了局（并点名是谁）', estart ? estart.msg : '（竟然开局了）');

  // 准备之后就能开
  p2.clear();
  const mkReady = host.mark();
  p2.send({ t: 'ydwg.ready', ready: true });
  const rReady = await waitRoom(host, 1200, mkReady);
  ok(rReady.ready.allReady === true, '★ 都准备好后 ready.allReady 为真', JSON.stringify(rReady.ready));

  host.clear(); p2.clear();
  host.send({ t: 'ydwg.start' });
  const ms = await host.wait('ydwg.matchStart', 1500);
  ok(!!ms && ms.mode === 'fixed', '不轮换模式可以开局', JSON.stringify(ms));
  const notice = host.last('ydwg.notice');
  ok(!!notice && /抽签/.test(notice.text), '没人愿意画时系统自动抽签一个画者', notice ? notice.text : '没有提示');
  ok((await waitRoom(host, 800)).members.some((m) => m.lottery), '被抽中的那个人在列表里有标记');

  // ★ 开局先弹 3 秒「谁画谁猜」身份牌，之后才进第一个回合
  const roles = await host.wait('ydwg.roles', 2000);
  ok(!!roles && (roles.list || []).length === 2, '开局先广播身份牌（谁画谁猜）', JSON.stringify(roles && roles.list));
  ok(!!roles && (roles.list || []).filter((x) => x.role === 'draw').length === 1,
    '★ 身份牌里只有一个人是画者（不会所有人都是画者）', JSON.stringify(roles && roles.list));
  ok(!!roles && roles.delay >= 3000, '身份牌显示 3 秒后才进对局', String(roles && roles.delay));

  const turn = await host.wait('ydwg.turn', 6000);
  ok(!!turn, '开局后进入第一个回合');
  ok(!!turn.painterId, '有画者被指定', JSON.stringify(turn));

  const painterClient = (turn.painterId === host.id ? host : p2);
  const guesserClient = (turn.painterId === host.id ? p2 : host);
  const secret = await painterClient.wait('ydwg.secret', 1500);
  ok(!!secret && typeof secret.word === 'string' && secret.word.length > 0, '画者收到了答案', JSON.stringify(secret));
  ok(!guesserClient.all('ydwg.secret').length, '猜的人拿不到答案', '');
  ok(guesserClient.last('ydwg.turn').wordLen === secret.word.length, '猜的人拿到的字数与答案一致', '');
  ok(guesserClient.last('ydwg.turn').hintUnlock === Math.round(60 * 0.3), '回合消息里带"多少秒后可以给提示"', String(guesserClient.last('ydwg.turn').hintUnlock));

  /* ========== 画板操作 ========== */
  group('E. 画板操作 / 撤销重做');
  guesserClient.clear(); painterClient.clear();
  guesserClient.send(op());
  await sleep(250);
  ok(!painterClient.last('ydwg.op'), '非画者的操作被丢弃', '');
  painterClient.clear();
  painterClient.send(op());
  const gotOp = await guesserClient.wait('ydwg.op', 1200);
  ok(!!gotOp && gotOp.op && gotOp.op.k === 'seg', '★ 画者的笔迹广播成 ydwg.op', JSON.stringify(gotOp));
  ok(gotOp && gotOp.op.c === '#e5533d', '颜色被原样带过去', gotOp ? gotOp.op.c : '');

  guesserClient.clear();
  painterClient.send({ t: 'ydwg.draw', k: 'seg', S: 'sx', L: 0, x: 0.2, y: 0.2, px: 0.2, py: 0.2, c: 'javascript:alert(1)', w: 5, a: 9, m: 'nope', z: 'nope' });
  const badOp = await guesserClient.wait('ydwg.op', 1200);
  ok(badOp && /^#[0-9a-fA-F]{3,6}$/.test(badOp.op.c), '非法的颜色被换成默认色', badOp ? badOp.op.c : '');
  ok(badOp && badOp.op.a <= 1 && badOp.op.w <= 0.09, '★ 不透明度和线宽被夹到合法区间', badOp ? JSON.stringify({ a: badOp.op.a, w: badOp.op.w }) : '');
  ok(badOp && badOp.op.m === 'pen' && badOp.op.z === 'pencil', '不认识的模式/笔刷回退成画笔+铅笔', badOp ? JSON.stringify({ m: badOp.op.m, z: badOp.op.z }) : '');

  // 12 种笔刷 + 三种模式都要能原样透传（这是「不同笔刷/不同工具手感不一样」的前提）
  guesserClient.clear();
  const brushOk = [];
  for (const z of ['pencil', 'pen', 'marker', 'crayon', 'chalk', 'charcoal', 'ink', 'spray', 'water', 'neon', 'hl', 'dots']) {
    guesserClient.clear();
    painterClient.send(op({ S: 'bz', z: z, m: 'pen' }));
    const g = await guesserClient.wait('ydwg.op', 1200);
    brushOk.push(g && g.op.z === z);
  }
  ok(brushOk.every(Boolean), '★ 12 种笔刷 id 都能原样透传给其他人', String(brushOk.filter(Boolean).length) + '/12');
  guesserClient.clear();
  painterClient.send(op({ S: 'em', m: 'erase', z: 'chalk' }));
  const eOp = await guesserClient.wait('ydwg.op', 1200);
  ok(eOp && eOp.op.m === 'erase' && eOp.op.z === 'chalk',
    '★ 橡皮模式也会带上当前笔刷（chalk）', eOp ? JSON.stringify({ m: eOp.op.m, z: eOp.op.z }) : '');
  guesserClient.clear();
  painterClient.send(op({ S: 'sm', m: 'smudge', z: 'water' }));
  const sOp = await guesserClient.wait('ydwg.op', 1200);
  ok(sOp && sOp.op.m === 'smudge' && sOp.op.z === 'water',
    '★ 涂抹模式也会带上当前笔刷（water）', sOp ? JSON.stringify({ m: sOp.op.m, z: sOp.op.z }) : '');
  // 形状也要带笔刷
  guesserClient.clear();
  painterClient.send({ t: 'ydwg.draw', k: 'shape', L: 0, s: 'rect', x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5, c: '#2f7de1', w: 0.01, a: 1, f: 0, z: 'crayon' });
  const shOp = await guesserClient.wait('ydwg.op', 1200);
  ok(shOp && shOp.op.k === 'shape' && shOp.op.z === 'crayon',
    '★ 形状也带上当前笔刷（形状用当前笔刷描边）', shOp ? JSON.stringify(shOp.op) : '');

  guesserClient.clear();
  painterClient.send({ t: 'ydwg.draw', k: 'fill', L: 0, x: 0.3, y: 0.3, c: '#2f7de1', a: 1, tol: 9999, e: 99 });
  const fillOp = await guesserClient.wait('ydwg.op', 1200);
  ok(fillOp && fillOp.op.k === 'fill' && fillOp.op.tol === 255, '★ 油漆桶的容差被夹到 0~255', fillOp ? String(fillOp.op.tol) : '');
  ok(fillOp && fillOp.op.e === 6, '★ 填充带上"边缘扩张"参数（不带的话两边填出来不一样）', fillOp ? String(fillOp.op.e) : '');
  guesserClient.clear();
  painterClient.send({ t: 'ydwg.draw', k: 'fill', L: 0, x: 0.4, y: 0.4, c: '#2f7de1', a: 1 });
  const fillOp2 = await guesserClient.wait('ydwg.op', 1200);
  ok(fillOp2 && fillOp2.op.e === 1, '没传边缘扩张时用默认值 1', fillOp2 ? String(fillOp2.op.e) : '');
  // 容差和边缘扩张都要能选 0（0 是合法值，不能被当成"没填"）
  guesserClient.clear();
  painterClient.send({ t: 'ydwg.draw', k: 'fill', L: 0, x: 0.35, y: 0.35, c: '#28a06a', a: 1, tol: 0, e: 0 });
  const fillZero = await guesserClient.wait('ydwg.op', 1200);
  ok(fillZero && fillZero.op.tol === 0, '★ 油漆桶容差可以选 0', fillZero ? String(fillZero.op.tol) : '');
  ok(fillZero && fillZero.op.e === 0, '★ 边缘扩张可以选 0', fillZero ? String(fillZero.op.e) : '');

  guesserClient.clear();
  painterClient.send({ t: 'ydwg.draw', k: 'ladd' });
  const ladd = await guesserClient.wait('ydwg.op', 1200);
  ok(ladd && ladd.op.k === 'ladd', '★ 新增图层能同步出去', JSON.stringify(ladd));

  guesserClient.clear();
  painterClient.send({ t: 'ydwg.draw', k: 'lopa', L: 0, v: 0.42 });
  const lopa = await guesserClient.wait('ydwg.op', 1200);
  ok(lopa && lopa.op.k === 'lopa' && Math.abs(lopa.op.v - 0.42) < 0.001,
    '★ 图层透明度能同步出去', JSON.stringify(lopa));

  guesserClient.clear();
  painterClient.send({ t: 'ydwg.draw', k: 'lopa', L: 0, v: 5 });
  const lopa2 = await guesserClient.wait('ydwg.op', 1200);
  ok(lopa2 && lopa2.op.v === 1, '图层透明度被夹到 0~1', lopa2 ? String(lopa2.op.v) : '');

  guesserClient.clear();
  painterClient.send({ t: 'ydwg.draw', k: '完全瞎写的' });
  await sleep(300);
  ok(!guesserClient.last('ydwg.op'), '不认识的操作类型被丢掉', '');

  // 撤销 / 重做 / 清空：服务端拍板操作数
  painterClient.clear(); guesserClient.clear();
  painterClient.send({ t: 'ydwg.canvas', op: 'undo' });
  const oc1 = await painterClient.wait('ydwg.opCount', 1500);
  ok(oc1 && typeof oc1.n === 'number', '★ 撤销：服务端回一个"还剩几条操作"', JSON.stringify(oc1));
  const nAfterUndo = oc1 ? oc1.n : -1;
  painterClient.clear();
  painterClient.send({ t: 'ydwg.canvas', op: 'redo' });
  const oc2 = await painterClient.wait('ydwg.opCount', 1500);
  ok(oc2 && oc2.n === nAfterUndo + 1, '★ 重做把操作数加回来', JSON.stringify(oc2));
  painterClient.clear();
  painterClient.send({ t: 'ydwg.canvas', op: 'clear' });
  const oc3 = await painterClient.wait('ydwg.opCount', 1500);
  ok(oc3 && oc3.n === 0, '★ 清空把这一回合的操作全部清掉', JSON.stringify(oc3));

  /* ★★ 撤销必须按「整笔」回退
     一笔 = 若干 seg + 一个收尾的 sege。以前只弹掉最后一条 sege，
     客户端重放时那些 seg 又被笔画缓冲重新提交 → 画面上看起来"撤销没反应"。 */
  painterClient.clear();
  painterClient.send(op({ S: 'u1' }));
  painterClient.send({ t: 'ydwg.draw', k: 'sege', S: 'u1' });
  painterClient.send(op({ S: 'u2' }));
  painterClient.send({ t: 'ydwg.draw', k: 'sege', S: 'u2' });
  await sleep(350);
  painterClient.clear();
  painterClient.send({ t: 'ydwg.canvas', op: 'undo' });
  const ug = await painterClient.wait('ydwg.opCount', 1500);
  ok(ug && ug.n === 2, '★ 撤销按"整笔"回退（4 条 → 2 条，不会只弹掉收尾的 sege）', ug ? String(ug.n) : '');
  painterClient.clear();
  painterClient.send({ t: 'ydwg.canvas', op: 'redo' });
  const rg = await painterClient.wait('ydwg.opCount', 1500);
  ok(rg && rg.n === 4, '★ 重做把整笔加回来（2 条 → 4 条）', rg ? String(rg.n) : '');
  // 把这一回合的操作再清掉，后面的用例不受影响
  painterClient.clear();
  painterClient.send({ t: 'ydwg.canvas', op: 'clear' });
  await painterClient.wait('ydwg.opCount', 1500);

  /* ========== 提示规则 ========== */
  group('F. 提示规则');
  guesserClient.clear();
  painterClient.send({ t: 'ydwg.hint', kind: 'type' });
  const tooEarly = await painterClient.wait('ydwg.error', 1200);
  ok(!!tooEarly && /30%/.test(tooEarly.msg), '开局 30% 之前给提示被拒绝', tooEarly ? tooEarly.msg : '');
  ok(!guesserClient.last('ydwg.hint'), '被拒的提示不会发给猜的人', '');

  console.log('  · 等待进入提示阶段（约 18 秒）…');
  let hinted = null;
  for (let i = 0; i < 70; i++) {
    const tick = painterClient.last('ydwg.tick');
    if (tick && tick.canHint) {
      painterClient.clear();
      painterClient.send({ t: 'ydwg.hint', kind: 'type' });
      hinted = await painterClient.wait('ydwg.hint', 1500);
      break;
    }
    await sleep(400);
  }
  ok(!!hinted, '过了 30% 之后可以给提示', '');
  const wordCat = (function (word) {
    for (const c of WORDS.CATEGORIES) for (const raw of c.words) if (raw.split('|')[0] === word) return c.name;
    return null;
  })(secret.word);
  ok(!!hinted && hinted.text === wordCat, '「类型」提示给的是这道题真正的类别', hinted ? hinted.text + '（应为 ' + wordCat + '）' : '');
  ok(hinted && hinted.cost === 3, '「类型」提示的代价是 3 分', hinted ? String(hinted.cost) : '');

  painterClient.clear(); guesserClient.clear();
  painterClient.send({ t: 'ydwg.hint', kind: 'type' });
  await sleep(300);
  ok(!painterClient.last('ydwg.hint'), '同一档提示不能重复给', '');

  painterClient.clear();
  painterClient.send({ t: 'ydwg.hint', kind: 'len' });
  const hinted2 = await painterClient.wait('ydwg.hint', 1500);
  ok(!!hinted2 && hinted2.cost === 3, '「几个字」提示代价也是 3 分（三档统一）', hinted2 ? String(hinted2.cost) : '');
  painterClient.clear();
  painterClient.send({ t: 'ydwg.hint', kind: 'origin' });
  const hinted3 = await painterClient.wait('ydwg.hint', 1500);
  ok(!!hinted3 && hinted3.cost === 3, '「来自哪里」提示代价还是 3 分（不给"最贵"的档位）', hinted3 ? String(hinted3.cost) : '');
  ok(hinted3 && hinted3.text.length > 0, '「来自哪里」有内容', hinted3 ? hinted3.text : '');
  ok(hinted2 && hinted2.text === secret.word.length + ' 个字', '「几个字」给的是字数', hinted2 ? hinted2.text : '');

  const hintTick = painterClient.last('ydwg.tick');
  ok(!hintTick || hintTick.canHint === true, '提示解锁后 tick 里 canHint 为真', '');

  /* ========== 猜错冷却 + 全房可见 ========== */
  group('G. 猜 · 冷却 · 全房可见');
  guesserClient.send({ t: 'ydwg.guess', text: '肯定不对的答案' });
  const miss = await host.wait('ydwg.guessMiss', 3000);
  ok(!!miss, '猜错会广播给全房', '');
  ok(miss && miss.text === '肯定不对的答案', '猜错的词全房可见（谁打的、打什么都公开）', miss ? miss.text : '');
  ok(miss && miss.name === guesserClient.name, '广播里带猜的人名字', miss ? miss.name : '');
  guesserClient.clear();
  guesserClient.send({ t: 'ydwg.guess', text: '再猜一次' });
  const cd = await guesserClient.wait('ydwg.error', 2000);
  ok(!!cd && /秒/.test(cd.msg), '猜错一次进入冷却', cd ? cd.msg : '');
  ok(!!cd && cd.keepInput === true && typeof cd.cdLeft === 'number',
    '★ 冷却被拒时告诉客户端"别清空输入框"和还剩几秒', cd ? JSON.stringify({ keepInput: cd.keepInput, cdLeft: cd.cdLeft }) : '');

  /* ========== 聊天 ========== */
  group('H. 聊天');
  guesserClient.clear(); painterClient.clear();
  guesserClient.send({ t: 'ydwg.chat', text: '这是三个字吗' });
  const chat = await painterClient.wait('ydwg.chat', 1500);
  ok(!!chat && chat.text === '这是三个字吗', '猜的人的聊天，画者能看见', JSON.stringify(chat));
  const chatOther = await guesserClient.wait('ydwg.chat', 1200);
  ok(!!chatOther, '其他猜的人也能看到这条聊天', '');
  painterClient.clear();
  painterClient.send({ t: 'ydwg.chat', text: '我偷偷告诉你' });
  const chatErr = await painterClient.wait('ydwg.error', 1500);
  ok(!!chatErr && /不能发言/.test(chatErr.msg), '画者作画时不能发言', chatErr ? chatErr.msg : '');

  /* ========== 换题 ========== */
  group('I. 换题');
  painterClient.clear();
  painterClient.send({ t: 'ydwg.swap' });
  const sw1 = await painterClient.wait('ydwg.secret', 1500);
  ok(!!sw1 && typeof sw1.word === 'string', '第一次换题成功并给了新答案', JSON.stringify(sw1));
  const newWord = sw1 && sw1.word;
  // ★ 换题之后，之前用掉的提示要自动刷新（新题可以重新给）
  painterClient.clear();
  painterClient.send({ t: 'ydwg.hint', kind: 'type' });
  const hintAfterSwap = await painterClient.wait('ydwg.hint', 1500);
  ok(!!hintAfterSwap, '★ 换题后用过的提示自动刷新，可以重新给', hintAfterSwap ? JSON.stringify(hintAfterSwap) : '');
  painterClient.clear();
  painterClient.send({ t: 'ydwg.swap' });
  const sw2 = await painterClient.wait('ydwg.secret', 1500);
  ok(!!sw2 && sw2.word && sw2.word !== newWord, '第二次换题又换了一道', JSON.stringify(sw2));
  painterClient.clear();
  painterClient.send({ t: 'ydwg.swap' });
  const swErr = await painterClient.wait('ydwg.error', 1200);
  ok(!!swErr && /换过/.test(swErr.msg), '一回合只能换两次', swErr ? swErr.msg : '');

  /* ========== 猜中 → 计分 ========== */
  group('J. 猜中与计分');
  const word = sw2;
  ok(!!word && typeof word.word === 'string', '画者手上握着答案', word ? word.word : '');
  host.clear(); painterClient.clear();
  const cooler = turn.painterId === host.id ? p2 : host;
  let win = null;
  for (let i = 0; i < 30 && !win; i++) {
    cooler.clear();
    cooler.send({ t: 'ydwg.guess', text: word.word });
    const r = await cooler.wait('ydwg.win', 500);
    if (r) win = r;
    else await sleep(400);
  }
  ok(!!win, '答案完全一致就算猜中（冷却结束后）', JSON.stringify(win));
  const painterGain = win && win.gains.filter((g) => g.id === turn.painterId)[0];
  const guesserGain = win && win.gains.filter((g) => g.id !== turn.painterId)[0];
  ok(!!guesserGain && guesserGain.pts >= 10, '猜对的人加分', guesserGain ? guesserGain.pts + ' 分' : '');
  ok(!!painterGain, '画被猜中，画家也加分', painterGain ? painterGain.pts + ' 分' : '');
  const tickNow = painterClient.last('ydwg.tick');
  const ratio = tickNow ? Math.max(0, 1 - (tickNow.total - tickNow.left) / tickNow.total) : 1;
  const expectedRaw = 15 + Math.round(15 * ratio);
  // 换题会把提示代价一起重置（新题重新算），而且**换题本身不扣分** —— 所以这里就是满额
  ok(painterGain && Math.abs(painterGain.pts - Math.max(0, expectedRaw)) <= 1,
    '换题不扣分（换题只重置提示代价），画家实得 = 基础分',
    painterGain ? ('实得 ' + painterGain.pts + '，期望约 ' + Math.max(0, expectedRaw) + '（未扣分前 ' + expectedRaw + '）') : '');
  ok(painterGain && painterGain.pts >= 0, '画家分数不会被扣成负数', painterGain ? String(painterGain.pts) : '');

  // ★ 本局信息面板要用：回合战报（谁画了什么、谁猜中了、用了多久）
  const roomAfterWin = await waitRoom(host, 1500);
  const lg = (roomAfterWin.log || [])[0];
  const solverName = win.gains.filter((g) => g.id !== turn.painterId)[0].name;
  ok(!!lg && lg.word === word.word, '★ 推送里带"猜对记录"：这一回合画的是什么', JSON.stringify(lg));
  ok(!!lg && lg.solver === solverName, '★ 记录里写了是谁猜中的', lg ? String(lg.solver) : '');
  ok(!!lg && lg.secs >= 0 && typeof lg.secs === 'number', '★ 记录里有用时', lg ? String(lg.secs) : '');
  ok(!!lg && !!lg.painter, '记录里有画者', lg ? lg.painter : '');
  ok(typeof roomAfterWin.painterName === 'string' && roomAfterWin.painterName.length > 0,
    '★ 推送里直接带画者名字（本局信息面板"谁在画"）', String(roomAfterWin.painterName));
  ok(Array.isArray(roomAfterWin.hints), '推送里带"已给哪些提示"列表', JSON.stringify(roomAfterWin.hints));
  ok(typeof roomAfterWin.turnTotal === 'number' && roomAfterWin.turnTotal > 0, '推送里带本回合总时长', String(roomAfterWin.turnTotal));

  const te = await cooler.wait('ydwg.turnEnd', 3000);
  ok(!!te && !!te.word, '回合结束会公布答案', te ? te.word : '');
  ok(te && te.reason === 'guessed', '结束原因是「被猜中」', te ? te.reason : '');
  ok(te && te.done && te.done.turn === 1, '不轮换模式一回合算一局', JSON.stringify(te ? te.done : {}));
  ok(te && te.ranking && te.ranking.length === 2, '结算里有排名', '');
  ok(te && te.ranking.some((r) => r.host === true), '★ 结算里标注了谁是房主', JSON.stringify((te ? te.ranking : []).map((r) => r.name + (r.host ? '(房主)' : ''))));
  ok(te && te.gapMs === 10000, '★ 单局结束到下一回合间隔 10 秒（和客户端弹窗自动关闭一致）', te ? String(te.gapMs) : '');
  ok(te && te.isLast === false, '还没打完会标记 isLast=false', String(te ? te.isLast : ''));

  /* ========== 轮换模式 · 抢画者 ========== */
  group('K. 轮换模式 · 抢画者');
  host.send({ t: 'ydwg.toLobby' });
  await sleep(600);
  let rmark2 = host.mark();
  host.send({ t: 'ydwg.settings', rotate: true });
  const rRot = await waitRoom(host, 1200, rmark2);
  ok(rRot.settings.rotate === true, '可以切换成轮换模式', JSON.stringify(rRot.settings));
  ok(rRot.settings.rounds === 5, '轮换模式默认 5 局', String(rRot.settings.rounds));
  // 这一局只打 1 圈，方便马上验终局结算
  const rmark3 = host.mark();
  host.send({ t: 'ydwg.settings', rounds: 1 });
  const rOne = await waitRoom(host, 900, rmark3);
  ok(rOne.settings.rounds === 1, '轮换模式局数可以调到 1', String(rOne.settings.rounds));
  // 轮换模式下不用选身份，也不应该能改身份
  p2.clear();
  p2.send({ t: 'ydwg.role', willDraw: true });
  const roleErr = await p2.wait('ydwg.error', 900);
  ok(!!roleErr && /轮换/.test(roleErr.msg), '轮换模式不需要选身份（会被拒绝）', roleErr ? roleErr.msg : '');
  // 准备一次
  p2.clear();
  p2.send({ t: 'ydwg.ready', ready: true });
  await sleep(300);

  host.clear(); p2.clear();
  host.send({ t: 'ydwg.start' });
  const grabStart = await host.wait('ydwg.grabStart', 2000);
  ok(!!grabStart, '轮换模式开局后进入抢画者阶段');
  ok(!!grabStart && grabStart.until > Date.now(), '抢画者窗口带结束时间戳（给进度条用）', grabStart ? String(grabStart.until - Date.now()) + 'ms' : '');

  let gmark = host.mark();
  p2.send({ t: 'ydwg.grab', grab: true });
  const rG = await waitRoom(host, 900, gmark);
  ok(rG.grab && rG.grab.grabbers === 1 && rG.grab.undecided === 1,
    '★ 抢画者状态实时同步（谁抢了 / 还有几个没选）', JSON.stringify(rG.grab));
  const meP2 = rG.members.filter((m) => m.name === '小明')[0];
  ok(meP2 && meP2.grabChoice === true, '★ 人员列表里能看到抢画者的选择', JSON.stringify(meP2));

  // 取消再抢回来
  gmark = host.mark();
  p2.send({ t: 'ydwg.grab', grab: false });
  const rG2 = await waitRoom(host, 900, gmark);
  ok(rG2.grab && rG2.grab.grabbers === 0, '★ 抢了还能取消', JSON.stringify(rG2.grab));

  // 全员选完 → 自动开始（不用等倒计时）
  host.clear(); p2.clear();
  p2.send({ t: 'ydwg.grab', grab: true });
  host.send({ t: 'ydwg.grab', grab: false });
  const msRot = await host.wait('ydwg.matchStart', 3000);
  ok(!!msRot && msRot.mode === 'rotate', '★ 所有人都选完之后自动开始（不用干等 15 秒）', JSON.stringify(msRot));
  ok(msRot && msRot.order.length === 2, '作画顺序包含全部玩家', msRot ? String(msRot.order.length) : '');
  ok(msRot && msRot.order[0].id === p2.id, '抢到画者的人排在最前面', msRot ? JSON.stringify(msRot.order) : '');
  ok(msRot && msRot.order[1].id === host.id, '没抢的排最后', '');

  const rolesRot = await host.wait('ydwg.roles', 2000);
  ok(!!rolesRot && (rolesRot.order || []).length === 2,
    '★ 抢完画者后也弹身份牌，并给出画者顺序', JSON.stringify(rolesRot && rolesRot.order));
  const t1 = await host.wait('ydwg.turn', 6000);
  ok(t1 && t1.painterId === p2.id, '第一个画者是抢到的那个', t1 ? String(t1.painterId) + ' vs 小明 ' + p2.id : '');
  ok(t1 && t1.done.cycle === 0 && t1.done.pos === 0, '显示"第 1 圈第 1 人"', JSON.stringify(t1 ? t1.done : {}));
  ok(t1 && t1.done.total === 2, '圈的长度 = 玩家数', t1 ? String(t1.done.total) : '');

  const p1turnId = t1.painterId;
  const pw = p1turnId === host.id ? host : p2;
  const gg = p1turnId === host.id ? p2 : host;
  const w1 = await pw.wait('ydwg.secret', 2000);
  ok(!!w1, '轮换模式第一回合画者拿到了答案');
  if (w1) gg.send({ t: 'ydwg.guess', text: w1.word });
  const te1 = await host.wait('ydwg.turnEnd', 3000);
  ok(te1 && te1.done.cycle === 0 && te1.done.pos === 1, '第一个人画完只是走到圈里下一个人（还没算一局）', JSON.stringify(te1 ? te1.done : {}));

  host.clear(); p2.clear();
  const t2 = await host.wait('ydwg.turn', 16000);
  ok(t2 && t2.painterId !== p1turnId, '换到下一个人作画', t2 ? String(t2.painterId) + '（上一个是 ' + p1turnId + '）' : '没等到第二回合');
  if (!t2) throw new Error('第二回合没开始，后续用例无法进行');
  const pw2 = t2.painterId === host.id ? host : p2;
  const g2 = t2.painterId === host.id ? p2 : host;
  const w2 = await pw2.wait('ydwg.secret', 2500);
  ok(!!w2, '第二回合画者拿到了答案', JSON.stringify(w2));
  pw2.clear();
  pw2.send({ t: 'ydwg.swap' });
  const swNewRound = await pw2.wait('ydwg.secret', 1500);
  ok(!!swNewRound, '新回合里换题次数是重新算的（还能再换两次）', JSON.stringify(swNewRound));
  if (swNewRound) g2.send({ t: 'ydwg.guess', text: swNewRound.word });
  const te2 = await host.wait('ydwg.turnEnd', 4000);
  ok(te2 && te2.done.cycle === 1, '轮完一圈才算完成一「局」', JSON.stringify(te2 ? te2.done : {}));

  /* ========== 终局结算 ========== */
  group('L. 终局结算 / 退出房间');
  host.send({ t: 'ydwg.skip' });          // 房主跳过 10 秒间歇，直接进结算
  const over = await host.wait('ydwg.over', 6000);
  ok(!!over && over.tag === 'final', '★ 打完所有局会推一个终局结算', JSON.stringify(over && { tag: over.tag, word: over.word }));
  ok(!!over && typeof over.word === 'string' && over.word.length > 0, '★ 结算里带着最后一题的答案（导出文件名要用）', over ? over.word : '');
  ok(!!over && over.ranking && over.ranking.length === 2, '结算里有最终排名', over ? String(over.ranking.length) : '');
  ok(!!over && over.ranking.some((r) => r.host), '★ 结算里标注房主', JSON.stringify((over ? over.ranking : []).map((r) => r.name + (r.host ? '(房主)' : ''))));
  ok(!!over && over.settleMs === 30000, '★ 结算给了"不做选择"的时限', over ? String(over.settleMs) : '');
  ok(!!(await waitRoom(host, 900)).members.every((m) => m.settleUntil > 0), '★ 每个人的结算截止时间都下发了', '');

  // 退出房间
  const beforeExit = (await waitRoom(host, 600)).activeCount;
  p2.clear(); host.clear();
  p2.send({ t: 'ydwg.exitRoom' });
  const exited = await p2.wait('ydwg.exited', 2000);
  ok(!!exited, '★ 点「退出房间」会收到确认', JSON.stringify(exited));
  const afterExit = await waitRoom(host, 1500);
  ok(afterExit.activeCount === beforeExit - 1, '★ 退出的人不再占名额', beforeExit + ' → ' + afterExit.activeCount);
  ok(afterExit.members.some((m) => m.left), '★ 退出的人留在名单里标「已退出」（不删记录）', JSON.stringify(afterExit.members.map((m) => m.name + (m.left ? '(已退出)' : ''))));
  ok(afterExit.members.filter((m) => !m.left).every((m) => m.host), '★ 房主退出后，房主身份交给还在房间里的人', JSON.stringify(afterExit.members.filter((m) => !m.left).map((m) => m.name)));

  // 返回房间
  host.clear();
  host.send({ t: 'ydwg.toLobby' });
  const backRoom = await host.wait('ydwg.toLobby', 2000);
  ok(!!backRoom && /回到房间/.test(backRoom.text), '★ 点「返回房间」会回到大厅', backRoom ? backRoom.text : '');
  const lobbyNow = await waitRoom(host, 900);
  ok(lobbyNow.state === 'lobby', '★ 返回后房间状态是 lobby', lobbyNow.state);

  host.close();

  /* ========== 进程内直测：那些要等很久或很难摆的边界 ========== */
  group('M. 边界（进程内直测）');

  // 1) 冷却状态会推给房间里的每个人
  const cdProbe = (function () {
    const clients = new Map();
    const out = [];
    const hub = new Hub({ clients: clients, send: function (c, o) { if (c) out.push(o); } });
    const A = { id: 1, name: 'A' }, B = { id: 2, name: 'B' };
    clients.set(1, A); clients.set(2, B);
    hub.create(A);
    const code = [...hub.rooms.keys()][0];
    hub.join(B, { code: code });
    const m = hub._memberOf(hub.rooms.get(code), 2);
    m.guessCdUntil = Date.now() + 8000;
    out.length = 0;
    hub._push(hub.rooms.get(code));
    const last = out.filter((o) => o.t === 'ydwg.room').pop();
    return last ? last.members.map((x) => ({ name: x.name, cd: x.cd })) : null;
  })();
  ok(cdProbe && cdProbe.length === 2 && cdProbe.some((m) => m.cd > 0),
    '冷却状态会推送给房间里每一个人', JSON.stringify(cdProbe));

  // 2) 房主自己没选身份也不能开局
  const hostRoleProbe = (function () {
    const clients = new Map();
    const out = [];
    const hub = new Hub({ clients: clients, send: function (c, o) { if (c) out.push(o); } });
    const A = { id: 1, name: 'A' }, B = { id: 2, name: 'B' };
    clients.set(1, A); clients.set(2, B);
    hub.create(A);
    const code = [...hub.rooms.keys()][0];
    const room = hub.rooms.get(code);
    hub.join(B, { code: code });
    hub.settings(A, { rotate: false });
    hub.role(B, { willDraw: true });
    hub.ready(B, { ready: true });
    out.length = 0;
    hub.start(A);                                   // 房主自己不选身份
    const err = out.filter((o) => o.t === 'ydwg.error').pop();
    hub.role(A, { willDraw: true });
    out.length = 0;
    hub.start(A);                                   // 现在可以了
    const started = out.some((o) => o.t === 'ydwg.matchStart');
    return { err: err ? err.msg : null, started: started };
  })();
  ok(hostRoleProbe.err && /身份/.test(hostRoleProbe.err), '★ 房主自己没选身份时也开不了局', hostRoleProbe.err);
  ok(hostRoleProbe.started === true, '★ 房主选了身份后就能开局', String(hostRoleProbe.started));

  // 3) 结算超时：不做选择就被移出房间
  const settleProbe = (function () {
    const clients = new Map();
    const out = [];
    const hub = new Hub({ clients: clients, send: function (c, o) { if (c) out.push({ to: c.id, msg: o }); } });
    const A = { id: 1, name: 'A' }, B = { id: 2, name: 'B' };
    clients.set(1, A); clients.set(2, B);
    hub.create(A);
    const code = [...hub.rooms.keys()][0];
    hub.join(B, { code: code });
    const room = hub.rooms.get(code);
    room.state = 'over';
    room.turn = {
      word: { text: '测试', cat: '动物', origin: 'x' }, painterId: 1, painterName: 'A',
      total: 60, elapsed: 0, hints: {}, swaps: 2, ops: [], redo: [], guessers: []
    };
    room.members.forEach((m) => { m.settleUntil = Date.now() - 1; });
    hub.step(1);
    return {
      left: room.members.filter((m) => !m.left).length,
      kept: room.members.length,
      toldA: out.some((x) => x.to === 1 && x.msg.t === 'ydwg.settleTimeout'),
      toldB: out.some((x) => x.to === 2 && x.msg.t === 'ydwg.settleTimeout'),
      destroyed: !hub.rooms.has(code)
    };
  })();
  ok(settleProbe.toldA && settleProbe.toldB, '★ 结算超时会通知到本人', JSON.stringify(settleProbe));
  ok(settleProbe.left === 0 && settleProbe.destroyed, '★ 谁都没做选择，房间就空掉回收了', JSON.stringify(settleProbe));

  // 4) 对局中途有人退出 → 聊天区提示 + 本回合作废
  const midLeaveProbe = (function () {
    const clients = new Map();
    const out = [];
    const hub = new Hub({ clients: clients, send: function (c, o) { if (c) out.push(o); } });
    const A = { id: 1, name: 'A' }, B = { id: 2, name: 'B' }, C = { id: 3, name: 'C' };
    clients.set(1, A); clients.set(2, B); clients.set(3, C);
    hub.create(A);
    const code = [...hub.rooms.keys()][0];
    hub.join(B, { code: code }); hub.join(C, { code: code });
    const room = hub.rooms.get(code);
    hub.settings(A, { rotate: false });
    [A, B, C].forEach((c) => hub.role(c, { willDraw: true }));
    [B, C].forEach((c) => hub.ready(c, { ready: true }));
    hub.start(A);
    room.nextAt = Date.now();      // 跳过开局的 3 秒身份牌
    hub.step(0);
    room.painterId = 2;
    if (room.turn) room.turn.painterId = 2;
    out.length = 0;
    hub.leave(B);                                     // 画者主动退出（不是断线）
    const left = out.filter((o) => o.t === 'ydwg.playerLeft').pop();
    const notice = out.filter((o) => o.t === 'ydwg.notice').pop();
    return { left: left ? left.text : null, reason: left ? left.reason : null, notice: notice ? notice.text : null, state: room.state };
  })();
  ok(!!midLeaveProbe.left && /退出了房间/.test(midLeaveProbe.left), '★ 中途退出会广播出来（聊天区可以显示）', midLeaveProbe.left);
  ok(midLeaveProbe.reason === 'left', '★ 退出原因标记为 left（区别于结算超时）', String(midLeaveProbe.reason));
  ok(!!midLeaveProbe.notice && /作废/.test(midLeaveProbe.notice), '★ 画者中途走了，本回合作废', midLeaveProbe.notice);

  // 5) 操作数上限
  ok(RULES.MAX_LAYERS === 4, '图层数量上限是 4', String(RULES.MAX_LAYERS));
  ok(RULES.TURN_GAP_MS === 10000 && RULES.SETTLE_MS === 30000,
    '回合间隔 10 秒 / 结算时限 30 秒', RULES.TURN_GAP_MS + '/' + RULES.SETTLE_MS);

  // 6) 轮换模式下"身份"这回事根本不该存在：不选身份也应该能准备、能开局
  //    （这是真踩过的坑：轮换模式里 role 路由被拒 → roleChosen 永远为假 → 准备被误拒）
  const rotateReadyProbe = (function () {
    const clients = new Map();
    const out = [];
    const hub = new Hub({ clients: clients, send: function (c, o) { if (c) out.push(o); } });
    const A = { id: 1, name: 'A' }, B = { id: 2, name: 'B' };
    clients.set(1, A); clients.set(2, B);
    hub.create(A);
    const code = [...hub.rooms.keys()][0];
    const room = hub.rooms.get(code);
    hub.join(B, { code: code });
    out.length = 0;
    hub.ready(B, { ready: true });                 // 默认就是轮换模式
    const err = out.filter((o) => o.t === 'ydwg.error').pop();
    const ready = hub._memberOf(room, 2).ready;
    out.length = 0;
    hub.start(A);
    const started = out.some((o) => o.t === 'ydwg.grabStart');
    return { err: err ? err.msg : null, ready: ready, started: started };
  })();
  ok(!rotateReadyProbe.err && rotateReadyProbe.ready === true,
    '★ 轮换模式下不选身份也能准备（身份只在关掉轮换时才有意义）', JSON.stringify(rotateReadyProbe));
  ok(rotateReadyProbe.started === true, '★ 轮换模式下房主能正常开局（进抢画者）', String(rotateReadyProbe.started));

  // 6) 掉线清理 & 房间回收
  const leaveProbe = (function () {
    const clients = new Map();
    const hub = new Hub({ clients: clients, send: function () { } });
    const mk = (id, name) => { const c = { id: id, name: name }; clients.set(id, c); return c; };
    const A = mk(1, 'A'), B = mk(2, 'B'), C = mk(3, 'C');
    hub.create(A);
    const code = [...hub.rooms.keys()][0];
    hub.join(B, { code: code });
    hub.join(C, { code: code });
    const totalN = () => hub.rooms.get(code).members.length;
    const three = totalN();
    hub.leave(B);                         // 大厅里退出：还没参与过，直接清掉
    const two = totalN();
    // 对局中掉线：留档 + 标「已退出」
    const room = hub.rooms.get(code);
    room.state = 'playing';
    room.turn = {
      painterId: A.id, painterName: 'A', word: { text: 'x', cat: '动物', origin: 'y' },
      total: 60, elapsed: 0, hints: {}, swaps: 2, ops: [], redo: [], guessers: []
    };
    hub.leave(C);                         // 对局中主动退出：留档
    const kept = totalN();
    const leftTag = hub.rooms.get(code).members.filter((m) => m.left).map((m) => m.name);
    hub.leave(A);
    return { three: three, two: two, kept: kept, leftTag: leftTag, gone: !hub.rooms.has(code) };
  })();
  ok(leaveProbe.three === 3 && leaveProbe.two === 2, '大厅里掉线的人直接清掉（还没参与过）', JSON.stringify(leaveProbe));
  ok(leaveProbe.kept === 2 && leaveProbe.leftTag.join() === 'C',
    '★ 对局中退出的人留在名单里留档（不删记录），并标出是谁', JSON.stringify(leaveProbe));
  ok(leaveProbe.gone === true, '房间空了会自动回收', JSON.stringify(leaveProbe));

  // 7) 房主掉线重连：按持久身份密钥把房主还给他
  //    真实场景：后台标签页被 Chrome 回收 → 重载 → 平台换了连接 id、没设昵称时还会换随机名
  //    → 服务端若还记着旧 id，房主就再也看不到「开始游戏」按钮。
  const hostKeyProbe = (function () {
    const clients = new Map();
    const hub = new Hub({ clients: clients, send: function () { } });
    const mk = (id, name, ip) => { const c = { id: id, name: name, ip: ip }; clients.set(id, c); return c; };
    const A = mk(1, '房主甲', '10.0.0.1');
    const B = mk(2, '玩家乙', '10.0.0.2');
    hub.create(A, { key: 'KEY-A' });                 // 带持久密钥建房
    const code = [...hub.rooms.keys()][0];
    const room = hub.rooms.get(code);
    hub.join(B, { code: code, key: 'KEY-B' });
    const hostBefore = room.hostId;

    clients.delete(1);            // 连接真的断了
    hub.onClose(A);               // 掉线 → 房主转给 B
    const hostAfterLeave = room.hostId;

    // 同一个人重连：key 不变，但连接 id 和昵称都变了（平台每次连接都换 id）
    const A2 = mk(9, '玩家999', '10.0.0.9');
    hub.join(A2, { code: code, key: 'KEY-A' });
    const hostAfterBack = room.hostId;

    // 同 ip 但不同 key（另一个人）→ 不该拿回
    const X = mk(11, '房主甲', '10.0.0.1');
    hub.join(X, { code: code, key: 'KEY-X' });
    const hostAfterOther = room.hostId;

    return {
      A: A.id, B: B.id, A2: A2.id, X: X.id, members: room.members.length,
      hostBefore: hostBefore, hostAfterLeave: hostAfterLeave,
      hostAfterBack: hostAfterBack, hostAfterOther: hostAfterOther
    };
  })();
  ok(hostKeyProbe.hostBefore === hostKeyProbe.A, '建房的人是房主', JSON.stringify(hostKeyProbe));
  ok(hostKeyProbe.hostAfterLeave === hostKeyProbe.B, '房主掉线后身份转给还在的人', JSON.stringify(hostKeyProbe));
  ok(hostKeyProbe.hostAfterBack === hostKeyProbe.A2,
    '★ 原房主重连（同一个持久 key）后拿回房主身份，否则再也看不到「开始游戏」', JSON.stringify(hostKeyProbe));
  ok(hostKeyProbe.hostAfterOther !== hostKeyProbe.X, '不同的 key（哪怕是同 ip 同昵称）不会抢走房主', JSON.stringify(hostKeyProbe));

  /* ---- 刷新网页回到对局（不是被踢回大厅） ---- */
  const rejoinProbe = (function () {
    const clients = new Map();
    const out = [];
    const hub = new Hub({ clients: clients, send: function (c, o) { if (c) out.push({ to: c.id, msg: o }); } });
    const mk = (id, name, ip) => { const c = { id: id, name: name, ip: ip }; clients.set(id, c); return c; };
    const A = mk(1, 'A', '10.0.0.1'), B = mk(2, 'B', '10.0.0.2'), C = mk(3, 'C', '10.0.0.3');
    hub.create(A, { key: 'kA' });
    const code = [...hub.rooms.keys()][0];
    hub.join(B, { code: code, key: 'kB' });
    hub.join(C, { code: code, key: 'kC' });   // 三个人：A 刷新时还剩 2 人，本回合不会作废
    const room = hub.rooms.get(code);
    hub.settings(A, { rotate: false });
    [A, B, C].forEach((c) => hub.role(c, { willDraw: true }));
    hub.role(C, { willDraw: false });
    [B, C].forEach((c) => hub.ready(c, { ready: true }));
    hub.start(A);
    room.nextAt = Date.now(); hub.step(0);          // 跳过 3 秒身份牌
    const stateBefore = room.state;
    // 让 B 来画、A 负责猜：这样 A 刷新时本回合不会作废，笔迹才留得下来
    room.turn.painterId = 2; room.turn.painterName = 'B';
    room.scores[1] = 20;                             // 先攒点分
    room.turn.ops.push({ k: 'seg', S: 's1', L: 0, x: .5, y: .5, px: .4, py: .4, c: '#e5533d', w: .012, a: 1, b: 'pencil', m: 'pen' });

    // 模拟刷新：旧连接断开，新连接带着同一个 key 回来
    hub.onClose(A);
    const afterClose = hub.rooms.get(code) ? hub.rooms.get(code).members.filter((m) => !m.left).length : -1;
    const A2 = mk(9, 'A', '10.0.0.1');
    out.length = 0;
    hub.join(A2, { code: code, key: 'kA' });
    const room2 = hub.rooms.get(code);
    const me = room2 ? room2.members.find((m) => m.clientId === 9) : null;
    const snap = out.filter((o) => o.to === 9 && o.msg.t === 'ydwg.opBatch').pop();
    return {
      stateBefore: stateBefore,
      afterClose: afterClose,
      joined: out.some((o) => o.to === 9 && o.msg.t === 'ydwg.joined'),
      back: me ? !me.left : false,
      score: room2 ? (room2.scores[9] || 0) : -1,
      active: room2 ? room2.members.filter((m) => !m.left).length : -1,
      ops: snap ? snap.msg.ops.length : -1
    };
  })();
  ok(rejoinProbe.joined === true, '★ 对局进行中带着同一个 key 回来，服务端放行（不是被踢出房间）', JSON.stringify(rejoinProbe));
  ok(rejoinProbe.back === true && rejoinProbe.active === 3, '★ 刷新后回到原来的座位，人还在房间里', JSON.stringify(rejoinProbe));
  ok(rejoinProbe.score === 20, '★ 刷新后分数还在（不会因为换了个连接就清零）', String(rejoinProbe.score));
  ok(rejoinProbe.ops === 1, '★ 刷新后把已有笔迹整批补发回来（不会看到空画板）', String(rejoinProbe.ops));

  /* ---- 回合结束的得分明细（结算弹窗的「详细」） ---- */
  const detailProbe = (function () {
    const clients = new Map();
    const out = [];
    const hub = new Hub({ clients: clients, send: function (c, o) { if (c) out.push({ to: c.id, msg: o }); } });
    const mk = (id, name, ip) => { const c = { id: id, name: name, ip: ip }; clients.set(id, c); return c; };
    const A = mk(1, 'A', '10.0.0.1'), B = mk(2, 'B', '10.0.0.2');
    hub.create(A, { key: 'kA' });
    const code = [...hub.rooms.keys()][0];
    hub.join(B, { code: code, key: 'kB' });
    const room = hub.rooms.get(code);
    hub.settings(A, { rotate: false });
    hub.role(A, { willDraw: true }); hub.role(B, { willDraw: false });
    hub.ready(B, { ready: true });
    hub.start(A);
    room.nextAt = Date.now(); hub.step(0);
    room.turn.painterId = 1; room.turn.painterName = 'A';
    room.turn.hints = { type: true }; room.turn.hintCost = 3;
    room.turn.swapsUsed = 1;
    out.length = 0;
    hub.guess(B, { text: room.turn.word.text });
    const end = out.filter((o) => o.msg.t === 'ydwg.turnEnd').pop();
    const d = end ? end.msg.detail : null;
    const painter = d ? d[1] : null;
    const guesser = d ? d[2] : null;
    return {
      hasDetail: !!d,
      painterPts: painter ? painter.pts : -1,
      painterItems: painter ? painter.items.map((i) => i.label + ':' + i.pts).join(' | ') : '',
      hasHint: painter ? painter.items.some((i) => i.pts < 0 && /提示/.test(i.label)) : false,
      hasSwap: painter ? painter.items.some((i) => /换题/.test(i.label)) : false,
      guesserPts: guesser ? guesser.pts : -1
    };
  })();
  ok(detailProbe.hasDetail === true, '★ 回合结束会带上「得分明细」（结算弹窗的详细要用）', JSON.stringify(detailProbe));
  ok(detailProbe.hasHint && detailProbe.hasSwap, '★ 明细里写清了「使用了提示」（扣分）与「换题」（不扣分）', detailProbe.painterItems);
  ok(detailProbe.painterPts >= 0, '★ 画者得分不会是负数', String(detailProbe.painterPts));
  ok(detailProbe.guesserPts > 0, '猜中的人有加分', String(detailProbe.guesserPts));

  /* ---- 新规则：猜错扣 2 分 / 画者可放弃绘画（需对局满 1 分钟） ---- */
  const ruleProbe = (function () {
    const clients = new Map();
    const out = [];
    const hub = new Hub({ clients: clients, send: function (c, o) { if (c) out.push({ to: c.id, msg: o }); } });
    const mk = (id, name, ip) => { const c = { id: id, name: name, ip: ip }; clients.set(id, c); return c; };
    const A = mk(1, 'A', '10.0.0.1'), B = mk(2, 'B', '10.0.0.2');
    hub.create(A, { key: 'rA' });
    const code = [...hub.rooms.keys()].pop();
    hub.join(B, { code: code, key: 'rB' });
    const room = hub.rooms.get(code);
    hub.settings(A, { rotate: false });
    hub.role(A, { willDraw: true }); hub.role(B, { willDraw: false });
    hub.ready(B, { ready: true });
    hub.start(A);
    room.nextAt = Date.now(); hub.step(0);

    const painterId = room.turn.painterId;
    const painter = painterId === A.id ? A : B;
    const guesser = painterId === A.id ? B : A;
    const guesserMember = room.members.find((m) => m.clientId === guesser.id);
    // 注意：ctx.send 收集的是 { to, msg } 信封，这里要取出里面的 msg，别拿信封当消息用
    const lastOut = (t) => { const hit = out.filter((o) => o.msg.t === t).pop(); return hit ? hit.msg : null; };

    // ① 猜错扣 2 分（先把猜的人垫成 10 分，否则 0 分扣不出效果）
    room.scores[guesser.id] = 10;
    out.length = 0;
    hub.guess(guesser, { text: '一定不是这个' });
    const missMsg = lastOut('ydwg.guessMiss');
    const afterMiss = room.scores[guesser.id];

    // ② 已经是 0 分时不再往下扣（不能变成负分）
    room.scores[guesser.id] = 0;
    if (guesserMember) guesserMember.guessCdUntil = 0;      // 清掉冷却，好再猜一次
    out.length = 0;
    hub.guess(guesser, { text: '再错一次试试' });
    const missMsg2 = lastOut('ydwg.guessMiss');
    const atZero = room.scores[guesser.id];

    // ③ 对局没满 1 分钟 → 拒绝放弃
    out.length = 0;
    hub.giveup(painter);
    const early = lastOut('ydwg.error');

    // ④ 非画者不能放弃
    out.length = 0;
    hub.giveup(guesser);
    const notPainter = lastOut('ydwg.error');

    // ⑤ 满 1 分钟后：画者放弃 → 公布答案 + 本回合立刻结束
    room.matchStartAt = Date.now() - 61000;
    const answer = room.turn.word.text;
    out.length = 0;
    hub.giveup(painter);
    const gaveUp = lastOut('ydwg.giveup');
    const turnEnd = lastOut('ydwg.turnEnd');

    return {
      missPenalty: missMsg ? missMsg.penalty : null,
      afterMiss: afterMiss,
      zeroPenalty: missMsg2 ? missMsg2.penalty : null,
      atZero: atZero,
      earlyRejected: early ? /1 分钟/.test(early.msg) : false,
      nonPainterRejected: notPainter ? /只有画者/.test(notPainter.msg) : false,
      gaveUp: !!gaveUp,
      revealed: gaveUp ? gaveUp.word : '',
      answer: answer,
      turnEndReason: turnEnd ? turnEnd.reason : ''
    };
  })();
  ok(ruleProbe.missPenalty === 2 && ruleProbe.afterMiss === 8,
    '★ 猜错一次扣 2 分（10 分 → 8 分）',
    'penalty=' + ruleProbe.missPenalty + ' 分数=' + ruleProbe.afterMiss);
  ok(ruleProbe.zeroPenalty === 0 && ruleProbe.atZero === 0,
    '★ 已经是 0 分时不再往下扣（不会扣成负分）',
    'penalty=' + ruleProbe.zeroPenalty + ' 分数=' + ruleProbe.atZero);
  ok(ruleProbe.earlyRejected === true, '★ 对局没满 1 分钟不能放弃绘画', '');
  ok(ruleProbe.nonPainterRejected === true, '★ 只有画者能放弃绘画', '');
  ok(ruleProbe.gaveUp === true && ruleProbe.revealed === ruleProbe.answer,
    '★ 放弃绘画会公布答案', ruleProbe.revealed);
  ok(ruleProbe.turnEndReason === 'giveup', '★ 放弃后本回合立刻结束（reason=giveup）', ruleProbe.turnEndReason);

  /* ---- 掉线宽限期：刷新网页不该把对局冲掉 ---- */
  const dropProbe = (function () {
    const clients = new Map();
    const out = [];
    const hub = new Hub({ clients: clients, send: function (c, o) { if (c) out.push({ to: c.id, msg: o }); } });
    const mk = (id, name, ip) => { const c = { id: id, name: name, ip: ip }; clients.set(id, c); return c; };
    const A = mk(1, 'A', '10.0.0.1'), B = mk(2, 'B', '10.0.0.2');
    hub.create(A, { key: 'kA' });
    const code = [...hub.rooms.keys()][0];
    hub.join(B, { code: code, key: 'kB' });
    const room = hub.rooms.get(code);
    hub.settings(A, { rotate: false });
    hub.role(A, { willDraw: true }); hub.role(B, { willDraw: false });
    hub.ready(B, { ready: true });
    hub.start(A);
    room.nextAt = Date.now(); hub.step(0);
    room.scores[1] = 12;
    const statePlaying = room.state;

    hub.onClose(A);                      // 刷新：连接断了
    const stateAfterDrop = hub.rooms.get(code) ? hub.rooms.get(code).state : 'gone';
    const me = room.members.find((m) => m.key === 'kA');
    const droppedFlag = me ? !!me.dropped : false;
    const seats = hub._active(room).length;    // 座位还留着

    const A2 = mk(9, 'A', '10.0.0.1');
    hub.join(A2, { code: code, key: 'kA' });   // 30 秒内回来
    const back = room.members.find((m) => m.clientId === 9);
    const restored = back ? (!back.dropped && !back.left) : false;
    const score = room.scores[9] || 0;

    // 宽限期过了还没回来 → 正式移除（留档）
    hub.onClose(A2);
    const m2 = room.members.find((m) => m.key === 'kA');
    if (m2) m2.dropAt = Date.now() - 40000;    // 假装 40 秒前断的
    hub.step(0);
    const afterGrace = room.members.find((m) => m.key === 'kA');
    return {
      statePlaying: statePlaying,
      stateAfterDrop: stateAfterDrop,
      droppedFlag: droppedFlag,
      seats: seats,
      restored: restored,
      score: score,
      archived: afterGrace ? !!afterGrace.left : false
    };
  })();
  ok(dropProbe.stateAfterDrop === 'playing',
    '★ 刷新/掉线后对局还在进行中（不会因为人数不足被踢回大厅）', JSON.stringify(dropProbe));
  ok(dropProbe.droppedFlag === true && dropProbe.seats === 2,
    '★ 掉线的人先占着座位（宽限期内等他回来）', JSON.stringify(dropProbe));
  ok(dropProbe.restored === true && dropProbe.score === 12,
    '★ 宽限期内回来：座位和分数都还在', JSON.stringify(dropProbe));
  ok(dropProbe.archived === true, '宽限期过了还没回来才会被移出（留档）', JSON.stringify(dropProbe));
}

async function waitRoom(player, ms, since) {
  const m = await player.wait('ydwg.room', ms || 500, since);
  return m || { members: [], ready: { waiting: [], noRole: [], allReady: false }, grab: {}, settings: {} };
}

main();
