'use strict';
/**
 * 好友系统自检： node tools/friendstest.js
 *
 * 覆盖：全量状态与刷新、加好友邀请（左下角弹窗的数据源）、接受/拒绝、成为好友、
 *       好友聊天（收发 + 回显去重 + 历史记录）、组队邀请与应答、
 *       删除好友、异常分支（加自己/加离线/和非好友聊天/重复邀请）、
 *       掉线后好友不丢、同一 IP 多页面引用计数、落盘持久化、/api/status 统计。
 *
 * 说明：好友身份以 IP 为单位。本脚本自己拉起一个临时端口的服务端，
 * 并用 WB_TEST_HOOKS=1 的 ?fip= 测试钩子让三个客户端拥有三个不同 IP
 * （在同一台电脑上模拟三台机器；正式服该参数被忽略，一律用真实 socket IP）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
const DATA_FILE = path.join(os.tmpdir(), 'wb-friends-test.json');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log('  [通过] ' + name + (extra != null ? '  ' + extra : '')); }
  else { fails++; console.log('  [失败] ' + name + '  ' + (extra != null ? extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function settle(ms) { await sleep(ms || 260); }

/* ---------------- 临时端口 / 拉起服务端 ---------------- */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let PROC = null;
async function startServer() {
  try { fs.unlinkSync(DATA_FILE); } catch (e) { /* 本来就没有 */ }
  const port = await freePort();
  PROC = spawn(process.execPath, [SERVER, '--port', String(port)], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { WB_TEST_HOOKS: '1', WB_FRIENDS_FILE: DATA_FILE })
  });
  let log = '';
  PROC.stdout.on('data', d => { log += d.toString(); });
  PROC.stderr.on('data', d => { log += d.toString(); });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + '/api/status'); if (r.ok) break; } catch (e) { /* 还没起来 */ }
    await sleep(100);
  }
  return { port, base };
}

/* ---------------- 测试客户端（?fip= 模拟不同电脑） ---------------- */
const IP_A = '10.0.0.2', IP_B = '10.0.0.3', IP_C = '10.0.0.4';

function client(tag, fip, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?fip=' + fip);
    const c = { tag, ws, msgs: [], handlers: {}, ptr: {}, ip: fip };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      c.msgs.push(m);
      (c.handlers[m.t] || []).slice().forEach(fn => fn(m));
    };
    c.send = (o) => ws.send(JSON.stringify(o));
    /** 把已收到的同类消息全部标记为已消费，之后 wait 只等新消息 */
    c.drain = (type) => { c.ptr[type] = c.msgs.filter(m => m.t === type).length; };
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
    c.close = () => { try { ws.close(); } catch (e) { /* noop */ } };
    ws.onopen = () => {
      // 和浏览器一样：连上先报个昵称（好友系统在首条 hello 后下发全量状态）
      ws.send(JSON.stringify({ t: 'hello', name: tag }));
      resolve(c);
    };
    ws.onerror = () => reject(new Error('[' + tag + '] 连接失败'));
  });
}

(async function main() {
  const { port, base } = await startServer();
  console.log('\n== A. 连接与全量状态 ==');
  const a = await client('A', IP_A, port);
  const b = await client('B', IP_B, port);
  const c = await client('C', IP_C, port);
  const ha = await a.wait('hello');
  ok('A 连接且 IP 为模拟值', ha.ip === IP_A, ha.ip);
  await a.wait('friends.state');
  ok('A 连接后即收到全量好友状态', a.count('friends.state') >= 1);
  // 三人都在线后主动刷新一次，拿准确快照
  a.drain('friends.state');
  a.send({ t: 'friends.refresh' });
  const sa = await a.wait('friends.state');
  ok('在线人员含 B 与 C（不含自己）',
    sa.online.some(o => o.ip === IP_B) && sa.online.some(o => o.ip === IP_C) && !sa.online.some(o => o.ip === IP_A),
    JSON.stringify(sa.online.map(o => o.ip)));
  ok('在线人员带完整 IP', sa.online.every(o => /^\d+\.\d+\.\d+\.\d+$/.test(o.ip || '')));
  ok('初始没有好友与邀请', sa.friends.length === 0 && sa.requests.length === 0);
  a.drain('friends.presence');   // 之前 B/C 上线的广播已看过，后续只等新的

  console.log('\n== B. 好友邀请 ==');
  a.send({ t: 'friends.add', ip: IP_B });
  const invited = await b.wait('friends.invited');
  ok('B 左下角收到好友邀请', invited.from === IP_A && !!invited.name, JSON.stringify(invited));
  const resAdd = await a.wait('friends.result');
  ok('A 收到发送成功回执', resAdd.ok === true && /已发送/.test(resAdd.msg || ''), resAdd.msg);
  // 重复邀请应被挡下
  a.send({ t: 'friends.add', ip: IP_B });
  const resDup = await a.wait('friends.result');
  ok('重复邀请被挡下', resDup.ok === false && /等待对方回应/.test(resDup.msg || ''), resDup.msg);

  console.log('\n== C. 接受邀请成为好友 ==');
  b.send({ t: 'friends.accept', ip: IP_A });
  const resAcceptA = await a.wait('friends.result');
  ok('A 收到接受通知', resAcceptA.ok === true && /好友/.test(resAcceptA.msg || ''), resAcceptA.msg);
  const resAcceptB = await b.wait('friends.result');
  ok('B 收到成为好友回执', resAcceptB.ok === true && /好友/.test(resAcceptB.msg || ''), resAcceptB.msg);
  await settle();
  const sa2 = a.last('friends.state'), sb2 = b.last('friends.state');
  ok('A 的好友列表有 B', sa2.friends.some(f => f.ip === IP_B));
  ok('B 的好友列表有 A', sb2.friends.some(f => f.ip === IP_A));
  ok('互为好友且在线', sa2.friends.find(f => f.ip === IP_B).online === true);

  console.log('\n== D. 好友聊天 ==');
  a.send({ t: 'friends.chat', ip: IP_B, text: '你好，下一局坦克？', mid: 'm1' });
  const chatB = await b.wait('friends.chat');
  ok('B 实时收到消息', chatB.text === '你好，下一局坦克？' && chatB.self === false && chatB.mid === 'm1');
  const echoA = await a.wait('friends.chat');
  ok('A 收到自己的回显（用于多窗口去重）', echoA.self === true && echoA.mid === 'm1');
  b.send({ t: 'friends.chat', ip: IP_A, text: '没问题', mid: 'm2' });
  const chatA = await a.wait('friends.chat');
  ok('A 实时收到回复', chatA.text === '没问题' && chatA.self === false);
  a.send({ t: 'friends.history', ip: IP_B });
  const hist = await a.wait('friends.history');
  ok('聊天历史可查（双向）', hist.list.length === 2 && hist.list[0].mid === 'm1' && hist.list[1].mid === 'm2',
    '共 ' + hist.list.length + ' 条');

  console.log('\n== E. 组队邀请（免邀请码直达） ==');
  a.send({ t: 'friends.team', ip: IP_B, game: 'tank', data: { room: '1234' }, text: '房间 1234' });
  const teamB = await b.wait('friends.teamInvited');
  ok('B 收到组队邀请（带游戏与房间）', teamB.game === 'tank' && teamB.data.room === '1234' && teamB.from === IP_A);
  const resTeam = await a.wait('friends.result');
  ok('A 收到组队邀请回执', resTeam.ok === true);
  b.send({ t: 'friends.teamReply', ip: IP_A, accept: true });
  const teamRes = await a.wait('friends.teamResult');
  ok('A 收到对方接受组队', teamRes.accept === true && teamRes.ip === IP_B);
  const resTeamB = await b.wait('friends.result');
  ok('B 收到自己的应答回执', resTeamB.ok === true && /接受/.test(resTeamB.msg || ''), resTeamB.msg);

  console.log('\n== F. 拒绝好友邀请 ==');
  c.send({ t: 'friends.add', ip: IP_A });
  const resCAdd = await c.wait('friends.result');
  ok('C 收到发送成功回执', resCAdd.ok === true);
  const invitedC = await a.wait('friends.invited');
  ok('A 收到 C 的邀请', invitedC.from === IP_C);
  a.send({ t: 'friends.reject', ip: IP_C });
  const resRejA = await a.wait('friends.result');
  ok('A 收到拒绝回执', resRejA.ok === true && /已拒绝/.test(resRejA.msg || ''), resRejA.msg);
  const resRej = await c.wait('friends.result');
  ok('C 收到拒绝通知', resRej.ok === false && /拒绝/.test(resRej.msg || ''), resRej.msg);

  console.log('\n== G. 删除好友 ==');
  a.send({ t: 'friends.remove', ip: IP_B });
  const resDelA = await a.wait('friends.result');
  ok('A 收到删除回执', resDelA.ok === true && /删除/.test(resDelA.msg || ''), resDelA.msg);
  const resDelB = await b.wait('friends.result');
  ok('B 收到被移除通知', resDelB.ok === false && /移除/.test(resDelB.msg || ''), resDelB.msg);
  await settle();
  ok('双方好友列表都变空',
    a.last('friends.state').friends.length === 0 && b.last('friends.state').friends.length === 0);

  console.log('\n== H. 异常分支 ==');
  a.send({ t: 'friends.add', ip: IP_A });
  ok('不能添加自己', (await a.wait('friends.result')).ok === false);
  a.send({ t: 'friends.add', ip: '10.9.9.9' });
  const resOff = await a.wait('friends.result');
  ok('对方不在线被挡下', resOff.ok === false && /不在线/.test(resOff.msg || ''), resOff.msg);
  a.send({ t: 'friends.chat', ip: IP_B, text: '在吗', mid: 'm3' });
  const resChat = await a.wait('friends.result');
  ok('非好友不能聊天', resChat.ok === false && /好友/.test(resChat.msg || ''), resChat.msg);
  a.send({ t: 'friends.team', ip: IP_B, game: 'tank', data: { room: '1' }, text: 'x' });
  const resTeam2 = await a.wait('friends.result');
  ok('非好友不能组队邀请', resTeam2.ok === false && /好友/.test(resTeam2.msg || ''), resTeam2.msg);
  // 再加回来，验证「已是好友」分支
  a.send({ t: 'friends.add', ip: IP_B });
  const resReAdd = await a.wait('friends.result');
  ok('可以重新加回好友', resReAdd.ok === true, resReAdd.msg);
  await b.wait('friends.invited');
  b.send({ t: 'friends.accept', ip: IP_A });
  const resAcceptA2 = await a.wait('friends.result');
  ok('A 再次收到成为好友通知', resAcceptA2.ok === true);
  await b.wait('friends.result');
  await settle();
  a.send({ t: 'friends.add', ip: IP_B });
  const resAlready = await a.wait('friends.result');
  ok('已是好友时重复添加被挡下', resAlready.ok === false && /已经是好友/.test(resAlready.msg || ''), resAlready.msg);

  console.log('\n== I. 掉线 / 重连（好友不丢） ==');
  b.close();
  const presOff = await a.wait('friends.presence');
  ok('B 掉线后 A 收到离线通知', presOff.ip === IP_B && presOff.online === false);
  const b2 = await client('B2', IP_B, port);
  await b2.wait('hello');
  const presOn = await a.wait('friends.presence');
  ok('B 重连后 A 收到上线通知', presOn.ip === IP_B && presOn.online === true && presOn.friend === true);
  // 刷新全量状态：好友关系与在线标记都应对
  a.drain('friends.state');
  a.send({ t: 'friends.refresh' });
  const sa3 = await a.wait('friends.state');
  ok('重连后好友关系仍在（IP 身份）', sa3.friends.some(f => f.ip === IP_B && f.online === true));
  // 重连后还能直接聊天 → 证明配对没丢
  a.send({ t: 'friends.chat', ip: IP_B, text: '重连了还能聊', mid: 'm4' });
  const chatB2 = await b2.wait('friends.chat');
  ok('重连后聊天直达', chatB2.text === '重连了还能聊' && chatB2.mid === 'm4');

  console.log('\n== J. 同一 IP 多个页面（引用计数） ==');
  const a2 = await client('A2', IP_A, port);
  await a2.wait('hello');
  await settle();
  a.drain('friends.state');
  a.send({ t: 'friends.refresh' });
  const saJ = await a.wait('friends.state');
  ok('同 IP 第二页不产生第二个身份',
    !saJ.online.some(o => o.ip === IP_A) && saJ.online.some(o => o.ip === IP_B),
    JSON.stringify(saJ.online.map(o => o.ip)));
  a2.close();
  await settle(500);
  ok('关掉同 IP 其中一个页面不会广播掉线',
    a.msgs.filter(m => m.t === 'friends.presence' && m.ip === IP_A && !m.online).length === 0);

  console.log('\n== K. 持久化与统计 ==');
  await settle(900);   // 等防抖落盘（600ms）
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* noop */ }
  ok('好友数据已落盘', !!saved && saved.pairs && saved.pairs[IP_A] && saved.pairs[IP_A].includes(IP_B),
    saved ? Object.keys(saved.pairs).join(',') : '无文件');
  const chatKey = IP_A < IP_B ? (IP_A + '|' + IP_B) : (IP_B + '|' + IP_A);
  ok('聊天记录已落盘', !!saved && saved.chats && Array.isArray(saved.chats[chatKey]) && saved.chats[chatKey].length >= 2);
  const st = await (await fetch(base + '/api/status')).json();
  ok('/api/status 上报好友统计', typeof st.friendPairs === 'number' && st.friendPairs >= 1,
    'friendPairs=' + st.friendPairs + ' friendOnlineIps=' + st.friendOnlineIps);

  /* ---------------- 收尾 ---------------- */
  a.close(); b2.close(); c.close();
  await sleep(200);
  if (PROC) PROC.kill();
  try { fs.unlinkSync(DATA_FILE); } catch (e) { /* noop */ }

  console.log('\n========================================');
  console.log('  好友系统自检：' + passes + ' 项通过，' + fails + ' 项失败');
  console.log('========================================');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('\n[自检异常]', e);
  if (PROC) PROC.kill();
  try { fs.unlinkSync(DATA_FILE); } catch (e2) { /* noop */ }
  process.exit(1);
});
