/**
 * 端到端验证「刷新网页回到对局」（真实服务端 + 真实 WebSocket）
 * 用法：node tools/refresh_e2e.js [port]
 */
'use strict';
const PORT = parseInt(process.argv[2], 10) || 8098;

function mkWS(name, key) {
  const ws = new WebSocket('ws://127.0.0.1:' + PORT);
  const P = { ws, name, key, msgs: [], id: null };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    P.msgs.push(m);
    if (m.t === 'hello') {
      P.id = m.id;
      ws.send(JSON.stringify({ t: 'hello', name }));
    }
  };
  P.send = (o) => ws.send(JSON.stringify(Object.assign({ key }, o)));
  P.last = (t) => P.msgs.filter((m) => m.t === t).pop();
  P.waitFor = (t, ms) => new Promise((res) => {
    const hit = P.msgs.filter((m) => m.t === t).pop();
    if (hit) return res(hit);
    const iv = setInterval(() => {
      const h = P.msgs.filter((m) => m.t === t).pop();
      if (h) { clearInterval(iv); clearTimeout(to); res(h); }
    }, 60);
    const to = setTimeout(() => { clearInterval(iv); res(null); }, ms);
  });
  P.open = new Promise((res) => ws.addEventListener('open', res));
  return P;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const A = mkWS('AA', 'keyA'), B = mkWS('BB', 'keyB');
  await Promise.all([A.open, B.open]);
  await sleep(400);

  A.send({ t: 'ydwg.create' });
  const created = await A.waitFor('ydwg.created', 3000);
  if (!created) throw new Error('建房失败');
  const code = created.code;

  B.send({ t: 'ydwg.join', code });
  await B.waitFor('ydwg.joined', 3000);
  B.send({ t: 'ydwg.ready', ready: true });
  await sleep(300);

  A.send({ t: 'ydwg.start' });
  const ms = await A.waitFor('ydwg.matchStart', 3000);
  console.log('开局模式:', ms && ms.mode);

  // 抢画者：两边都抢 → 直接开始
  A.send({ t: 'ydwg.grab', grab: true });
  B.send({ t: 'ydwg.grab', grab: true });
  const roles = await A.waitFor('ydwg.roles', 4000);
  console.log('身份牌:', roles ? roles.list.map((x) => x.name + '=' + x.role).join(', ') : '没收到');
  const turn = await A.waitFor('ydwg.turn', 8000);
  if (!turn) throw new Error('没进入回合');
  console.log('回合开始，画者 id =', turn.painterId, '（A=' + A.id + ' B=' + B.id + '）');

  // 画一笔（画者发）
  const painter = (turn.painterId === A.id) ? A : B;
  painter.send({
    t: 'ydwg.draw', k: 'seg', S: 's1', L: 0,
    x: 0.6, y: 0.6, px: 0.4, py: 0.4, c: '#e5533d', w: 0.012, a: 1, b: 'pencil', m: 'pen'
  });
  await sleep(400);

  // 刷新「不是画者」的那个人（画者刷新会让本回合作废，那是规则）
  const refresher = (painter === A) ? B : A;
  const rkey = refresher.key;
  const rname = refresher.name;
  console.log('刷新对象:', rname);

  refresher.ws.close();          // 模拟刷新：连接断开
  await sleep(600);

  const R2 = mkWS(rname, rkey);  // 同一个身份 key 回来
  await R2.open;
  await sleep(300);
  R2.send({ t: 'ydwg.join', code });
  const joined = await R2.waitFor('ydwg.joined', 3000);
  const batch = await R2.waitFor('ydwg.opBatch', 3000);
  const room = await R2.waitFor('ydwg.room', 3000);
  await sleep(500);
  const room2 = R2.last('ydwg.room');

  const me = (room2.members || []).find((m) => m.name === rname);
  const result = {
    joined: !!joined,
    roomState: room2 && room2.state,
    memberCount: (room2.members || []).length,
    meLeft: me ? !!me.left : null,
    meDropped: me ? !!me.dropped : null,
    score: me ? me.score : null,
    strokesSentBack: batch ? batch.ops.length : 0
  };
  console.log('\n=== 刷新后结果 ===');
  console.log(JSON.stringify(result, null, 2));

  const okList = [
    ['刷新后能回到房间', result.joined === true],
    ['房间仍在对局中（没被踢回大厅）', result.roomState === 'playing' || result.roomState === 'roles'],
    ['人还在（不是已退出）', result.meLeft === false],
    ['掉线标记已清除', result.meDropped === false],
    ['人数仍是 2', result.memberCount === 2],
    ['已有笔迹补发回来', result.strokesSentBack >= 1]
  ];
  let bad = 0;
  console.log('');
  for (const [label, pass] of okList) {
    console.log((pass ? '  [通过] ' : '  [失败] ') + label);
    if (!pass) bad++;
  }
  A.ws.close(); B.ws.close(); R2.ws.close();
  console.log('\n' + (bad ? ('有 ' + bad + ' 项未通过') : '端到端刷新回对局 ✔'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('异常：', e.message); process.exit(1); });
