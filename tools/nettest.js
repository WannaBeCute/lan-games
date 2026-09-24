'use strict';
/**
 * 联机自检： node tools/nettest.js [ws://127.0.0.1:8080/ws]
 * 覆盖：静态资源、房间创建/加入、局数设置、开局、状态广播、移动同步、
 *       局数推进与最终结算、五子棋邀请/落子/悔棋/胜负判定、断线清理。
 *
 * 提示：服务端可用 WB_ROUND_LIMIT=6 压缩单局时限，让本脚本快速跑完多局。
 */
const WSURL = process.argv[2] || 'ws://127.0.0.1:8080/ws';
const HTTP = WSURL.replace(/^ws/, 'http').replace(/\/ws$/, '');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log('  [通过] ' + name + (extra != null ? '  ' + extra : '')); }
  else { fails++; console.log('  [失败] ' + name + '  ' + (extra != null ? extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function client(tag) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSURL);
    const c = { tag, ws, msgs: [], handlers: {}, ptr: {} };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      c.msgs.push(m);
      (c.handlers[m.t] || []).slice().forEach(fn => fn(m));
    };
    c.send = (o) => ws.send(JSON.stringify(o));
    /** 等待下一条尚未被消费的指定类型消息 */
    c.wait = (type, timeout = 6000) => new Promise((res, rej) => {
      const idx = c.ptr[type] || 0;
      const list = c.msgs.filter(m => m.t === type);
      if (list.length > idx) { c.ptr[type] = idx + 1; return res(list[idx]); }
      const timer = setTimeout(() => rej(new Error('[' + tag + '] 等待 ' + type + ' 超时')), timeout);
      const h = (m) => {
        clearTimeout(timer);
        const i = c.handlers[type].indexOf(h);
        if (i >= 0) c.handlers[type].splice(i, 1);
        c.ptr[type] = (c.ptr[type] || 0) + 1;
        res(m);
      };
      (c.handlers[type] = c.handlers[type] || []).push(h);
    });
    c.last = (type) => {
      for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === type) return c.msgs[i];
      return null;
    };
    c.count = (type) => c.msgs.filter(m => m.t === type).length;
    c.close = () => ws.close();
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error('[' + tag + '] 连接失败'));
  });
}

/** 发一个动作后等待状态刷新 */
async function settle(ms) { await sleep(ms || 220); }

(async function main() {
  console.log('\n== A. 静态资源 ==');
  for (const p of ['/', '/tank/', '/gomoku/', '/tank/main.js', '/tank/shared/tankcore.js', '/shared/app.css']) {
    try {
      const r = await fetch(HTTP + p);
      ok('GET ' + p, r.status === 200, 'HTTP ' + r.status);
    } catch (e) { ok('GET ' + p, false, e.message); }
  }
  try {
    const st = await (await fetch(HTTP + '/api/status')).json();
    ok('GET /api/status', typeof st.online === 'number', JSON.stringify(st));
  } catch (e) { ok('GET /api/status', false, e.message); }

  console.log('\n== B. 连接与邀请码 ==');
  const a = await client('A');
  const b = await client('B');
  const ha = await a.wait('hello');
  const hb = await b.wait('hello');
  ok('连接后下发身份', !!ha.id && !!ha.inviteCode, 'A 邀请码 ' + ha.inviteCode);
  ok('不同连接邀请码互异', ha.inviteCode !== hb.inviteCode, ha.inviteCode + ' / ' + hb.inviteCode);
  ok('邀请码为 6 位易读字符', /^[A-HJ-NP-Z2-9]{6}$/.test(ha.inviteCode), ha.inviteCode);

  const t0 = Date.now();
  a.send({ t: 'ping', ts: t0 });
  const pong = await a.wait('pong');
  ok('RTT 探测', typeof pong.ts === 'number', '往返 ' + (Date.now() - t0) + 'ms');

  console.log('\n== C. 坦克大战：房间 ==');
  a.send({ t: 'tank.create' });
  const created = await a.wait('tank.created');
  ok('新建房间返回 4 位房间号', /^\d{4}$/.test(created.code), '房间号 ' + created.code);

  b.send({ t: 'tank.join', code: created.code });
  await settle();
  const room1 = a.last('tank.room');
  ok('两人在同一房间', room1.members.length === 2, room1.members.map(m => m.name).join(', '));
  ok('房主为创建者', room1.hostId === ha.id);
  ok('默认局数 20', room1.rounds === 20, 'rounds=' + room1.rounds);

  b.send({ t: 'tank.rounds', rounds: 5 });
  await settle();
  ok('非房主不能改局数', a.last('tank.room').rounds === 20, '仍是 ' + a.last('tank.room').rounds);

  a.send({ t: 'tank.rounds', rounds: 3 });
  await settle();
  ok('房主可设置局数', a.last('tank.room').rounds === 3, 'rounds=3');

  a.send({ t: 'tank.rounds', rounds: 9999 });
  await settle();
  ok('局数上限 999', a.last('tank.room').rounds === 999);
  a.send({ t: 'tank.rounds', rounds: 0 });
  await settle();
  ok('局数下限 1', a.last('tank.room').rounds === 1);
  a.send({ t: 'tank.rounds', rounds: 2 });
  await settle();

  // 房间可勾选「场上掉落哪些道具」，默认全选
  const pu0 = a.last('tank.room').powerups || [];
  ok('房间默认全选 8 种道具', pu0.length === 8 && pu0.indexOf('laser') >= 0 && pu0.indexOf('stealth') >= 0, pu0.join(','));
  ok('下发可选道具总表', (a.last('tank.room').allPowerups || []).length === 8);

  b.send({ t: 'tank.powerups', list: ['laser'] });
  await settle();
  ok('非房主不能改掉落道具', (a.last('tank.room').powerups || []).length === 8,
    (a.last('tank.room').powerups || []).join(','));

  a.send({ t: 'tank.powerups', list: ['laser', 'speed', '不存在的'] });
  await settle();
  const pu1 = a.last('tank.room').powerups || [];
  ok('房主可改掉落道具（非法项被忽略）', pu1.length === 2 && pu1.indexOf('laser') >= 0 && pu1.indexOf('speed') >= 0, pu1.join(','));

  a.send({ t: 'tank.powerups', list: [] });
  await settle();
  ok('不允许把道具全部关掉', (a.last('tank.room').powerups || []).length === 2,
    (a.last('tank.room').powerups || []).join(','));
  ok('清空时给出提示', (a.last('tank.error') || {}).msg === '至少要保留一种道具', (a.last('tank.error') || {}).msg);
  a.send({ t: 'tank.powerups', list: pu0.slice() });
  await settle();
  ok('可以恢复成全选', (a.last('tank.room').powerups || []).length === 8);

  // 自伤开关（默认关闭 = 自己的子弹打不到自己）
  ok('房间默认关闭自伤', a.last('tank.room').selfDamage === false, 'selfDamage=' + a.last('tank.room').selfDamage);
  b.send({ t: 'tank.selfDamage', enabled: true });
  await settle();
  ok('非房主不能改自伤设置', a.last('tank.room').selfDamage === false,
    (b.last('tank.error') || {}).msg || '');
  a.send({ t: 'tank.selfDamage', enabled: true });
  await settle();
  ok('房主可开启自伤', a.last('tank.room').selfDamage === true);
  a.send({ t: 'tank.selfDamage', enabled: false });
  await settle();
  ok('房主可关回自伤', a.last('tank.room').selfDamage === false);

  // 改昵称：重新发 hello 后，房间里的名字要立刻跟着变
  a.send({ t: 'hello', name: '坦克手阿强' });
  await settle();
  const renamed = a.last('tank.room').members.find(m => m.id === ha.id);
  ok('改昵称后房间里的名字同步更新', renamed && renamed.name === '坦克手阿强', renamed ? renamed.name : '无');
  ok('改名后服务端回执也是新名字', (await a.wait('hello')).name === '坦克手阿强');

  a.send({ t: 'tank.config', color: '#ff5d6c', style: 'camo' });
  await settle();
  const me = a.last('tank.room').members.find(m => m.id === ha.id);
  ok('房间内可选颜色/涂装', me.color === '#ff5d6c' && me.style === 'camo', me.color + ' / ' + me.style);

  console.log('\n== C2. 准备状态与 AI 开关 ==');
  let rm = a.last('tank.room');
  ok('每位玩家都有准备字段', rm.members.every(m => typeof m.ready === 'boolean'),
    JSON.stringify(rm.members.map(m => m.name + ':' + m.ready)));
  ok('房主默认视为已就绪', rm.members.find(m => m.id === ha.id).ready === true);
  ok('新加入的玩家默认未准备', rm.members.find(m => m.id === hb.id).ready === false);
  ok('房间下发 AI 开关（默认关闭 = 不补 AI）', rm.addBots === false, 'addBots=' + rm.addBots);
  ok('房间人数上限为 4', rm.maxPlayers === 4);

  b.send({ t: 'tank.ready', ready: true });
  await settle();
  rm = a.last('tank.room');
  ok('玩家准备后状态同步给所有人', rm.members.find(m => m.id === hb.id).ready === true);
  ok('全员就绪后房主可以开始', rm.canStart === true, rm.startHint);
  const grm = b.last('tank.room');
  ok('非房主拿到「等待房主开始」提示', grm.canStart === false && /等待房主/.test(grm.startHint), grm.startHint);

  b.send({ t: 'tank.ready', ready: false });
  await settle();
  ok('可以取消准备', a.last('tank.room').members.find(m => m.id === hb.id).ready === false);
  b.send({ t: 'tank.ready', ready: true });
  await settle();
  b.send({ t: 'tank.bots', enabled: true });
  await settle();
  ok('非房主不能修改 AI 开关', a.last('tank.room').addBots === false,
    (b.last('tank.error') || {}).msg || '');
  a.send({ t: 'tank.bots', enabled: true });
  await settle();
  ok('房主可以打开 AI 开关', a.last('tank.room').addBots === true);
  a.send({ t: 'tank.bots', enabled: false });
  await settle();
  ok('房主可以重新关闭 AI 开关', a.last('tank.room').addBots === false);

  console.log('\n== D. 坦克大战：开局与同步 ==');
  b.send({ t: 'tank.start' });
  await settle(300);
  ok('非房主不能开始游戏', !a.last('tank.round'), a.last('tank.error') ? a.last('tank.error').msg : '');

  b.send({ t: 'tank.ready', ready: false });
  await settle(250);
  a.send({ t: 'tank.start' });
  await settle(300);
  ok('有人没准备时房主也不能开始', !a.last('tank.round'), a.last('tank.error') ? a.last('tank.error').msg : '');

  b.send({ t: 'tank.ready', ready: true });
  await settle(250);
  a.send({ t: 'tank.start' });
  const ra = await a.wait('tank.round');
  const rb = await b.wait('tank.round');
  ok('双方都收到开局消息', !!ra && !!rb, '第 ' + ra.index + '/' + ra.total + ' 局');
  ok('含随机地图数据', typeof ra.tiles === 'string' && ra.tiles.length > 100, 'tiles b64 长度 ' + ra.tiles.length);
  ok('地图尺寸 25x19', ra.cols === 25 && ra.rows === 19);

  const stA = await a.wait('tank.state', 4000);
  ok('收到权威状态快照', stA.tks.length >= 2, stA.tks.length + ' 辆坦克');
  ok('快照含子弹/特殊武器字段', Array.isArray(stA.bl) && Array.isArray(stA.pu));

  let freezeOver = false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const s = a.last('tank.state');
    if (s && s.freeze <= 0) { freezeOver = true; break; }
  }
  ok('开局倒计时结束后可行动', freezeOver);

  const p0 = a.last('tank.state').tks.find(t => t[0] === 1000 + ha.id);
  for (let i = 0; i < 25; i++) { a.send({ t: 'tank.input', up: true }); await sleep(60); }
  const p1 = a.last('tank.state').tks.find(t => t[0] === 1000 + ha.id);
  const moved = Math.hypot(p1[1] - p0[1], p1[2] - p0[2]);
  ok('前进输入驱动坦克移动（沿车头方向）', moved > 20,
    '位移 ' + moved.toFixed(0) + 'px，角度 ' + (p1[3] * 180 / Math.PI).toFixed(0) + '°');

  const ang0 = p1[3];
  for (let i = 0; i < 12; i++) { a.send({ t: 'tank.input', up: false, left: true }); await sleep(60); }
  const ang1 = a.last('tank.state').tks.find(t => t[0] === 1000 + ha.id)[3];
  const turn = Math.abs(ang0 - ang1) * 180 / Math.PI;
  ok('转向输入让坦克旋转', turn > 15, '转了 ' + turn.toFixed(0) + '°');
  a.send({ t: 'tank.input', up: false, left: false });

  a.send({ t: 'tank.input', fire: true });
  let maxMine = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(50);
    const s = a.last('tank.state');
    let n = 0;
    for (const bl of s.bl) if (bl[3] === 1000 + ha.id) n++;
    maxMine = Math.max(maxMine, n);
  }
  a.send({ t: 'tank.input', fire: false });
  ok('服务端强制子弹上限 5', maxMine <= 5, '峰值 ' + maxMine + ' 发');

  // 草丛隐身：站到树丛格里，对方就看不到（自己仍然收得到）
  const tilesBuf = Buffer.from(ra.tiles, 'base64');
  const TILEW = ra.cols;
  /** 该格四周（含自己）没有砖/钢/水 —— 不然坦克站上去会被挤出来 */
  const standable = (idx) => {
    const c = idx % TILEW, r = Math.floor(idx / TILEW);
    if (c < 1 || r < 1 || c >= ra.cols - 1 || r >= ra.rows - 1) return false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = tilesBuf[(r + dy) * TILEW + (c + dx)];
        if (t === 1 || t === 2 || t === 3) return false;
      }
    }
    return true;
  };
  let bushIdx = -1;
  for (let i = 0; i < tilesBuf.length; i++) {
    if (tilesBuf[i] === 4 && standable(i)) { bushIdx = i; break; }
  }
  if (bushIdx < 0) {
    ok('地图里能找到树丛格', false, '整张图没有树丛');
  } else {
    const TILE = 32;
    const bc = bushIdx % ra.cols, br = Math.floor(bushIdx / ra.cols);
    a.send({ t: 'tank.teleport', x: bc * TILE + TILE / 2, y: br * TILE + TILE / 2 });
    await sleep(500);
    const seenA = b.last('tank.state').tks.some(t => t[0] === 1000 + ha.id);
    const selfA = a.last('tank.state').tks.some(t => t[0] === 1000 + ha.id);
    // 草丛是"正常遮挡"（草画在坦克上面），不是把坦克藏起来：
    // 数据照常下发，客户端靠草丛图形盖住它，并且草丛里不画头顶名字
    ok('躲进草丛后坦克仍然正常同步（草丛是遮挡不是隐身）', seenA, '对手快照里' + (seenA ? '有' : '没有') + '你');
    ok('躲进草丛后自己当然也看得到', selfA);
    // 挪回空地 → 对方又能看到
    let emptyIdx = -1;
    for (let i = 0; i < tilesBuf.length; i++) if (tilesBuf[i] === 0) { emptyIdx = i; break; }
    a.send({ t: 'tank.teleport', x: (emptyIdx % ra.cols) * TILE + TILE / 2, y: Math.floor(emptyIdx / ra.cols) * TILE + TILE / 2 });
    await sleep(500);
    ok('离开草丛后对方重新看得到', b.last('tank.state').tks.some(t => t[0] === 1000 + ha.id));
  }

  // 子弹穿草：草丛被打薄成"稀疏草丛"(5)，这个非零值也要同步到对方
  {
    // 找一格"左边是空地"的草丛：把 A 摆在左边朝右开枪，子弹必然穿过去
    // 先按最理想的条件找（左边能站车 + 右边也是空地），找不到就放宽
    const pickBush = (strict) => {
      for (let i = ra.cols + 1; i < tilesBuf.length - ra.cols - 1; i++) {
        if (tilesBuf[i] !== 4) continue;
        const cc = i % ra.cols;
        if (cc <= 1 || cc >= ra.cols - 2) continue;                 // 别贴着左右边界
        if (tilesBuf[i - 1] !== 0 || !standable(i - 1)) continue;    // 左边要能站车
        if (strict && (tilesBuf[i + 1] !== 0 || !standable(i + 1))) continue;  // 右边也留出空间
        return i;
      }
      return -1;
    };
    let target = pickBush(true);
    if (target < 0) target = pickBush(false);
    if (target < 0) {
      ok('找到可以试枪的草丛', false, '没有"左侧是空地"的草丛');
    } else {
      const cc = target % ra.cols, rw = Math.floor(target / ra.cols);
      // B 端自己维护一张地图：用 tank.round 的 b64 + 每帧的 d（[索引,值] 成对）还原
      b.mapTiles = Buffer.from(ra.tiles, 'base64');
      b.mapPatches = [];
      const watchMap = (m) => {
        if (!m || !m.d) return;
        b.mapPatches.push(m.d.slice());
        for (let i = 0; i + 1 < m.d.length; i += 2) b.mapTiles[m.d[i]] = m.d[i + 1];
      };
      (b.handlers['tank.state'] = b.handlers['tank.state'] || []).push(watchMap);
      a.send({ t: 'tank.teleport', x: (cc - 1) * 32 + 16, y: rw * 32 + 16, angle: Math.PI / 2 });
      await sleep(350);
      for (let shot = 0; shot < 2; shot++) {
        a.send({ t: 'tank.input', fire: true });
        await sleep(90);
        a.send({ t: 'tank.input', fire: false });
        await sleep(520);
      }
      const before = tilesBuf[target], after = b.mapTiles[target];
      // 第一发穿过草丛时先变成"轻擦(6)"（只擦破一点，比激光少得多）；多穿几发才会到稀疏(5)再到空地 0
      const first = b.mapPatches.find(d => d.indexOf(target) >= 0);
      const firstVal = first ? first[first.indexOf(target) + 1] : null;
      ok('子弹第一次穿过草丛 → 只轻轻擦破(6)', firstVal === 6,
        '开火前 ' + before + ' → 第一次变更 ' + firstVal);
      ok('地图变更按 [索引, 新值] 成对下发', !!first && first.length % 2 === 0,
        first ? JSON.stringify(first.slice(0, 8)) : '没有收到该格的变更');
      ok('反复穿过会把草丛越打越没（对方地图同步到）', after === 6 || after === 5 || after === 0,
        '对方现在看到 ' + after);
    }
  }

  console.log('\n== E. 坦克大战：局数推进与结算 ==');
  const limit = a.last('tank.state').limit;
  ok('服务端下发单局时限', typeof limit === 'number' && limit > 0, 'limit=' + limit + 's');

  let roundEnd = null, matchEnd = null;
  try { roundEnd = await a.wait('tank.roundEnd', (limit + 10) * 1000); } catch (e) { /* timeout */ }
  ok('单局结束后结算本局', !!roundEnd,
    roundEnd ? ('第 ' + roundEnd.result.index + ' 局，' + (roundEnd.result.winner ? '胜者 ' + roundEnd.result.winner.name : '流局')) : '未收到');
  if (roundEnd) {
    ok('本局给出排名列表', Array.isArray(roundEnd.result.ranked) && roundEnd.result.ranked.length >= 2,
      roundEnd.result.ranked.map(r => r.name).join(' > '));
    ok('返回累计战绩', Array.isArray(roundEnd.scores) && roundEnd.scores.length >= 2);
  }
  try { matchEnd = await a.wait('tank.matchEnd', 40000); } catch (e) { /* timeout */ }
  ok('打满设置局数后结算总排名', !!matchEnd,
    matchEnd ? (matchEnd.rounds + ' 局，冠军 ' + matchEnd.standings[0].name + '（' + matchEnd.standings[0].wins + ' 胜 / ' + matchEnd.standings[0].kills + ' 杀）') : '未收到');
  if (matchEnd) {
    ok('排名按胜场降序', matchEnd.standings[0].wins >= matchEnd.standings[matchEnd.standings.length - 1].wins);
    ok('返回每一局结果', Array.isArray(matchEnd.results) && matchEnd.results.length === matchEnd.rounds);
    ok('每局结果含完整排名', matchEnd.results.every(r => Array.isArray(r.ranked) && r.ranked.length >= 2));
  }
  // 房主发起「再来一届」
  a.send({ t: 'tank.rematch' });
  await settle(450);
  const nr = a.last('tank.round');
  ok('房主可发起再来一届（战绩清零、从第 1 局重开）', !!nr && nr.index === 1 && nr.total === 2,
    nr ? ('第 ' + nr.index + '/' + nr.total + ' 局') : '未收到');

  a.send({ t: 'tank.leave' });
  b.send({ t: 'tank.leave' });
  await settle();

  console.log('\n== F. 五子棋：邀请制联机 ==');
  const g1 = await client('G1');
  const g2 = await client('G2');
  const gh1 = await g1.wait('hello');
  const gh2 = await g2.wait('hello');
  g1.send({ t: 'gomoku.register' });
  const codeMsg = await g1.wait('gomoku.code');
  ok('注册后返回专属邀请码', codeMsg.code === gh1.inviteCode, codeMsg.code);

  g1.send({ t: 'gomoku.invite', code: 'ZZZZZZ' });
  let e = await g1.wait('gomoku.error');
  ok('邀请码不存在时给出提示', /不存在|离线/.test(e.msg), e.msg);

  g1.send({ t: 'gomoku.invite', code: gh2.inviteCode });
  const invited = await g2.wait('gomoku.invited');
  ok('对方收到邀请通知', invited.from.code === gh1.inviteCode, invited.from.name + ' 邀请你');

  g2.send({ t: 'gomoku.reply', matchId: invited.matchId, accept: false });
  e = await g1.wait('gomoku.error');
  ok('拒绝后邀请方收到提示', /拒绝/.test(e.msg), e.msg);

  await settle();
  g1.send({ t: 'gomoku.invite', code: gh2.inviteCode });
  const inv2 = await g2.wait('gomoku.invited');
  g2.send({ t: 'gomoku.reply', matchId: inv2.matchId, accept: true });
  await settle(320);
  const gs1 = g1.last('gomoku.start');
  const gs2 = g2.last('gomoku.start');
  ok('接受后双方进入对局', !!gs1 && !!gs2, '邀请方 you=' + (gs1 && gs1.you) + '，受邀方 you=' + (gs2 && gs2.you));
  // 注意：同一对玩家再开一局时黑白会轮换，所以不能假定"邀请方一定执黑"，
  // 直接按服务端下发的 you 决定谁是黑方 / 白方，后面的用例都按角色走
  const blackIsG1 = gs1.you === 1;
  ok('双方一黑一白、由黑方先行', (gs1.you === 1 && gs2.you === 2) || (gs1.you === 2 && gs2.you === 1),
    '邀请方执' + (gs1.you === 1 ? '黑' : '白') + '，受邀方执' + (gs2.you === 1 ? '黑' : '白'));
  ok('黑方先落子', gs1.turn === 1, 'turn=' + gs1.turn);
  const BK = blackIsG1 ? g1 : g2;      // 执黑方
  const WT = blackIsG1 ? g2 : g1;      // 执白方
  ok('每人各有一次悔棋', gs1.undoLeft[1] === 1 && gs1.undoLeft[2] === 1);
  ok('初始棋盘为空', gs1.board.every(v => v === 0) && gs1.board.length === 225);

  const BI = (x, y) => y * 15 + x;
  BK.send({ t: 'gomoku.move', x: 7, y: 7 });
  await settle();
  let s2 = g2.last('gomoku.state');
  ok('黑棋落子并轮到白棋', s2.board[BI(7, 7)] === 1 && s2.turn === 2);
  ok('白方看到最后一手坐标', s2.last && s2.last.x === 7 && s2.last.y === 7);

  WT.send({ t: 'gomoku.move', x: 8, y: 7 });
  await settle();
  let s1b = g1.last('gomoku.state');
  ok('白棋落子且轮到黑棋', s1b.board[BI(8, 7)] === 2 && s1b.turn === 1);

  const errBefore = BK.count('gomoku.error');
  BK.send({ t: 'gomoku.move', x: 7, y: 7 });
  await settle();
  ok('禁止下在已有棋子的位置', BK.count('gomoku.error') > errBefore && /已有棋子/.test(BK.last('gomoku.error').msg), BK.last('gomoku.error').msg);

  const errBefore2 = WT.count('gomoku.error');
  WT.send({ t: 'gomoku.move', x: 0, y: 14 });
  await settle();
  ok('未轮到的一方不能落子', WT.count('gomoku.error') > errBefore2 && /还没轮到/.test(WT.last('gomoku.error').msg), WT.last('gomoku.error').msg);

  console.log('\n== G. 五子棋：落子预览同步（对方可见） ==');
  // 此时轮到黑方落子，黑方刚落下 (7,7)
  BK.send({ t: 'gomoku.hover', x: 3, y: 3 });
  const hv1 = await WT.wait('gomoku.hover', 3000);
  ok('轮到自己时，预览会同步给对方', hv1.p === 1 && hv1.x === 3 && hv1.y === 3, JSON.stringify(hv1));

  const hvBefore = BK.count('gomoku.hover');
  WT.send({ t: 'gomoku.hover', x: 4, y: 4 });
  await settle(260);
  ok('没轮到的一方，预览不会被转发', BK.count('gomoku.hover') === hvBefore, '对方新增 ' + (BK.count('gomoku.hover') - hvBefore) + ' 条');

  BK.send({ t: 'gomoku.hover', x: 7, y: 7 });     // 已有棋子的位置
  const hv2 = await WT.wait('gomoku.hover', 3000);
  ok('预览落在已有棋子上会被清掉', hv2.x === -1 && hv2.y === -1, JSON.stringify(hv2));

  BK.send({ t: 'gomoku.hover', x: -1, y: -1 });
  const hv3 = await WT.wait('gomoku.hover', 3000);
  ok('离开棋盘后对方预览消失', hv3.x === -1, JSON.stringify(hv3));

  console.log('\n== H. 五子棋：悔棋（不需要对方同意） ==');
  // 当前：黑(7,7) 白(8,7)，轮到黑方，双方各有 1 次悔棋；最后一手是白方的
  const stB0 = g1.last('gomoku.state');
  ok('对方已应手时 canUndo 为假', stB0.canUndo[1] === false && stB0.canUndo[2] === true, JSON.stringify(stB0.canUndo));

  const reqBefore = g1.count('gomoku.undo.request') + g2.count('gomoku.undo.request');
  const errB1 = BK.count('gomoku.error');
  BK.send({ t: 'gomoku.undo' });
  await settle();
  ok('对方已经应手 → 悔棋被拒', BK.count('gomoku.error') > errB1 && /对方已经落子/.test(BK.last('gomoku.error').msg), BK.last('gomoku.error').msg);
  ok('被拒后机会不消耗', g1.last('gomoku.state').undoLeft[1] === 1, '黑方剩余 ' + g1.last('gomoku.state').undoLeft[1]);

  // 白方刚落下 (8,7)、黑方还没应手 —— 白方直接悔棋
  WT.send({ t: 'gomoku.undo' });
  const unW = await WT.wait('gomoku.undone', 3000);
  await settle();
  const w1 = g1.last('gomoku.state'), w2 = g2.last('gomoku.state');
  ok('白方直接悔棋成功，撤回自己那一手', unW.by === 2 && unW.x === 8 && unW.y === 7, JSON.stringify({ by: unW.by, at: unW.x + ',' + unW.y }));
  ok('悔棋全程不需要对方同意', (g1.count('gomoku.undo.request') + g2.count('gomoku.undo.request')) === reqBefore);
  ok('悔棋后棋盘同步给双方', w1.board[BI(8, 7)] === 0 && w2.board[BI(8, 7)] === 0, '(8,7)=' + w1.board[BI(8, 7)]);
  ok('悔棋后轮次回到悔棋方', w1.turn === 2 && w2.turn === 2, 'turn=' + w1.turn);
  ok('悔棋后手数与剩余次数正确', w1.moves === 1 && w1.undoLeft[2] === 0 && w1.undoLeft[1] === 1,
    '手数 ' + w1.moves + ' 黑剩 ' + w1.undoLeft[1] + ' 白剩 ' + w1.undoLeft[2]);
  ok('canUndo 随局面更新', w1.canUndo[1] === true && w1.canUndo[2] === false, JSON.stringify(w1.canUndo));

  // 白方再落一手 → 轮到黑方，黑方落一手后趁白方没应手再悔
  WT.send({ t: 'gomoku.move', x: 8, y: 7 });
  await settle();
  BK.send({ t: 'gomoku.move', x: 6, y: 7 });
  await settle();
  ok('黑方此刻可以悔棋（自己刚下完）', g1.last('gomoku.state').canUndo[1] === true);
  const undoneBefore = BK.count('gomoku.undone');
  BK.send({ t: 'gomoku.undo' });
  await settle(320);
  const unB = BK.last('gomoku.undone');
  const b1 = g2.last('gomoku.state'), b2 = g1.last('gomoku.state');
  ok('等自己下一手时悔棋成功', BK.count('gomoku.undone') > undoneBefore && unB.by === 1 && unB.x === 6 && unB.y === 7,
    JSON.stringify({ by: unB.by, at: unB.x + ',' + unB.y }));
  ok('只撤回最后落下的那一手', b1.board[BI(6, 7)] === 0 && b1.board[BI(7, 7)] === 1 && b1.board[BI(8, 7)] === 2,
    '(6,7)=' + b1.board[BI(6, 7)] + ' (7,7)=' + b1.board[BI(7, 7)] + ' (8,7)=' + b1.board[BI(8, 7)]);
  ok('悔棋后轮次与手数正确', b1.turn === 1 && b1.moves === 2, 'turn=' + b1.turn + ' 手数 ' + b1.moves);
  ok('双方都同步到新棋盘（不会卡住）', b2.turn === 1 && b2.board[BI(6, 7)] === 0);
  ok('黑方悔棋次数用尽', b1.undoLeft[1] === 0, '黑剩 ' + b1.undoLeft[1]);

  const errB2 = BK.count('gomoku.error');
  BK.send({ t: 'gomoku.undo' });
  await settle();
  ok('同一玩家不能悔两次', BK.count('gomoku.error') > errB2 && /用完/.test(BK.last('gomoku.error').msg), BK.last('gomoku.error').msg);

  // 回归：悔棋之后双方都还能正常落子
  BK.send({ t: 'gomoku.move', x: 6, y: 7 });
  await settle();
  ok('悔棋后黑方仍能落子', g1.last('gomoku.state').board[BI(6, 7)] === 1 && g1.last('gomoku.state').turn === 2);
  WT.send({ t: 'gomoku.move', x: 10, y: 10 });
  await settle();
  ok('悔棋后白方也能落子（不再卡死）', g2.last('gomoku.state').board[BI(10, 10)] === 2 && g2.last('gomoku.state').turn === 1);
  BK.send({ t: 'gomoku.move', x: 5, y: 7 });
  await settle();
  ok('对局恢复正常，轮次交回白方', g1.last('gomoku.state').turn === 2, 'turn=' + g1.last('gomoku.state').turn);

  console.log('\n== I. 五子棋：胜负判定 ==');
  // 白棋随便走，黑棋连成 5 子
  const plan = [
    ['w', 8, 8], ['b', 0, 0], ['w', 9, 9], ['b', 1, 0],
    ['w', 0, 10], ['b', 2, 0], ['w', 1, 11], ['b', 3, 0],
    ['w', 2, 12], ['b', 4, 0]
  ];
  for (const [side, x, y] of plan) {
    (side === 'b' ? BK : WT).send({ t: 'gomoku.move', x, y });
    await settle(140);
  }
  const fin = g1.last('gomoku.state');
  ok('五子连珠判定胜利', fin.state === 'over' && !!fin.win,
    fin.win ? ('胜方执' + (fin.win.p === 1 ? '黑' : '白') + '，连线 ' + (fin.win.line || []).length + ' 子') : '无');
  ok('胜方为黑棋', fin.win && fin.win.p === 1);
  ok('返回获胜连线坐标', fin.win && fin.win.line && fin.win.line.length >= 5,
    fin.win && fin.win.line ? JSON.stringify(fin.win.line[0]) + '→' + JSON.stringify(fin.win.line[fin.win.line.length - 1]) : '');

  console.log('\n== I2. 五子棋：再开一局时黑白轮换 ==');
  const firstYou = gs1.you;      // 上一局邀请方拿到的颜色（1 黑 / 2 白）
  g1.send({ t: 'gomoku.invite', code: gh2.inviteCode });
  const inv3 = await g2.wait('gomoku.invited');
  g2.send({ t: 'gomoku.reply', matchId: inv3.matchId, accept: true });
  await settle(320);
  const n1 = g1.last('gomoku.start'), n2 = g2.last('gomoku.start');
  // 只要求"和上一局相反"：换过几局之后，邀请方不一定还是黑
  ok('第二局黑白互换（上一局执黑的改执白）', n1.you !== firstYou && n2.you !== (firstYou === 1 ? 2 : 1),
    '上一局邀请方 you=' + firstYou + '，本局邀请方 you=' + n1.you + '，受邀方 you=' + n2.you);
  ok('仍然由黑方先行', n1.turn === 1 && n2.turn === 1);
  ok('双方看到的执黑方一致', n1.players[1].name === n2.players[1].name, n1.players[1].name);

  // 再结束一局，第三局应换回邀请方执黑
  g1.send({ t: 'gomoku.resign' });
  await settle(320);
  g1.send({ t: 'gomoku.invite', code: gh2.inviteCode });
  const inv4 = await g2.wait('gomoku.invited');
  g2.send({ t: 'gomoku.reply', matchId: inv4.matchId, accept: true });
  await settle(320);
  const n3 = g1.last('gomoku.start');
  ok('第三局又换回来（不会固定一方执黑）', n3.you === firstYou,
    '第二局邀请方 you=' + n1.you + '，第三局 you=' + n3.you);

  console.log('\n== K. 对局中有人退出 → 整场结束 ==');
  const e1 = await client('E1'), e2 = await client('E2');
  await e1.wait('hello'); await e2.wait('hello');
  e1.send({ t: 'tank.create' });
  const cr2 = await e1.wait('tank.created');
  e2.send({ t: 'tank.join', code: cr2.code });
  await settle();
  e2.send({ t: 'tank.ready', ready: true });
  await settle();
  e1.send({ t: 'tank.start' });
  await e1.wait('tank.round');
  await settle(400);
  e2.close();                       // 对局进行中退出
  let ab = null;
  try { ab = await e1.wait('tank.abort', 6000); } catch (err) { /* 超时 */ }
  ok('对局中有人退出 → 其他人收到结束通知', !!ab && /离开/.test(ab.msg || ''), ab ? ab.msg : '未收到');
  await sleep(500);
  const stAb = await (await fetch(HTTP + '/api/status')).json();
  ok('对局中途结束后房间被回收', stAb.tankRooms === 0, 'tankRooms=' + stAb.tankRooms);
  e1.close();
  await sleep(300);

  console.log('\n== J. 断线清理 ==');
  g1.close(); g2.close(); a.close(); b.close();
  await sleep(600);
  const st2 = await (await fetch(HTTP + '/api/status')).json();
  ok('断线后在线人数与房间数回落', st2.online === 0 && st2.tankRooms === 0 && st2.gomokuMatches === 0, JSON.stringify(st2));

  console.log('\n' + (fails === 0 ? ('全部通过 ✔  (' + passes + ' 项)') : (fails + ' 项失败，' + passes + ' 项通过')));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('\n[测试异常]', e.message); process.exit(1); });
