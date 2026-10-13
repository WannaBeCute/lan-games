'use strict';
/**
 * 频道聊天自检（平台层）： node tools/chattest.js
 *
 * 覆盖：进频道（回放日志 + 成员列表）、多人发言互相可见、非成员被拒、
 *       频道名校验、离开频道、频道随最后一人退出而回收、断开连接自动摘除、
 *       超长消息截断、/api/status 里的频道统计。
 *
 * 说明：脚本自己拉起一个临时端口的服务端，并用 WB_TEST_HOOKS=1 的 ?fip=
 * 测试钩子模拟三台不同电脑（正式服该参数被忽略，一律用真实 socket IP）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
const DATA_FILE = path.join(os.tmpdir(), 'wb-chat-test-friends.json');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log('  [通过] ' + name + (extra != null ? '  ' + extra : '')); }
  else { fails++; console.log('  [失败] ' + name + '  ' + (extra != null ? extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CH = 'dodge:1234';

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

const IP_A = '10.1.0.2', IP_B = '10.1.0.3', IP_C = '10.1.0.4';

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
    /** 等一条"不是自己发的"频道消息（对方视角） */
    c.waitFrom = (type, ip, timeout) => new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        const hit = c.msgs.filter(m => m.t === type && m.from === ip).pop();
        if (hit) return res(hit);
        if (Date.now() - t0 > (timeout || 6000)) return rej(new Error('[' + tag + '] 等待来自 ' + ip + ' 的 ' + type + ' 超时'));
        setTimeout(poll, 60);
      })();
    });
    /** 等一条满足条件的消息（有就立刻返回，没有就轮询到超时）——比"下一条"稳，不怕中间夹着别的 */
    c.waitMatch = (type, pred, timeout) => new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        const hit = c.msgs.filter(m => m.t === type).filter(pred).pop();
        if (hit) return res(hit);
        if (Date.now() - t0 > (timeout || 6000)) return rej(new Error('[' + tag + '] 等待条件 ' + type + ' 超时'));
        setTimeout(poll, 60);
      })();
    });
    c.last = (type) => {
      for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === type) return c.msgs[i];
      return null;
    };
    c.count = (type) => c.msgs.filter(m => m.t === type).length;
    c.close = () => { try { ws.close(); } catch (e) { /* noop */ } };
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', name: tag }));
      resolve(c);
    };
    ws.onerror = () => reject(new Error('[' + tag + '] 连接失败'));
  });
}

async function status(base) {
  return (await fetch(base + '/api/status')).json();
}

(async function main() {
  const { port, base } = await startServer();

  console.log('\n== A. 进频道：日志回放 + 成员列表 ==');
  const a = await client('A', IP_A, port);
  const b = await client('B', IP_B, port);
  const c = await client('C', IP_C, port);
  await a.wait('hello'); await b.wait('hello'); await c.wait('hello');

  a.send({ t: 'chat.join', channel: CH, title: '方块躲避 · 房间 1234' });
  const logA = await a.wait('chat.log');
  ok('进频道收到日志（首次为空）+ 标题', logA.channel === CH && Array.isArray(logA.list) && logA.list.length === 0 && /房间 1234/.test(logA.title),
    JSON.stringify({ channel: logA.channel, title: logA.title, n: logA.list.length }));
  const memA = await a.wait('chat.members');
  ok('自己是频道成员（self=true）',
    memA.members.length === 1 && memA.members[0].self === true && memA.members[0].ip === IP_A,
    JSON.stringify(memA.members));

  b.send({ t: 'chat.join', channel: CH });
  const memB = await b.wait('chat.members');
  ok('第二个人的成员列表有 2 人且能认出自己',
    memB.members.length === 2 && memB.members.filter(m => m.self).length === 1,
    JSON.stringify(memB.members));
  const sysA = await a.wait('chat.system');
  ok('房间里的人收到"有人进来了"的系统提示', /进入了房间/.test(sysA.text || ''), sysA.text);

  console.log('\n== B. 发言：房间里所有人可见 ==');
  a.drain('chat.msg'); b.drain('chat.msg'); c.drain('chat.msg');
  a.send({ t: 'chat.send', channel: CH, text: '有人吗？', mid: 'm1' });
  const selfMsg = await a.wait('chat.msg');
  ok('自己收到自己的回显（self=true）', selfMsg.self === true && selfMsg.text === '有人吗？' && selfMsg.mid === 'm1');
  const bSees = await b.waitFrom('chat.msg', IP_A);
  ok('同房间的 B 看到 A 的发言（带昵称与 IP）',
    bSees.text === '有人吗？' && bSees.name === 'A' && bSees.from === IP_A && bSees.self === false,
    JSON.stringify(bSees));
  await sleep(200);
  ok('没进这个频道的 C 什么都收不到', c.count('chat.msg') === 0, c.count('chat.msg') + ' 条');

  b.send({ t: 'chat.send', channel: CH, text: '在，开始吧', mid: 'm2' });
  const aSees = await a.waitFrom('chat.msg', IP_B);
  ok('A 也能看到 B 的发言（双向）', aSees.text === '在，开始吧' && aSees.from === IP_B);

  console.log('\n== C. 非成员发言 / 频道名校验 ==');
  c.send({ t: 'chat.send', channel: CH, text: '我也来说一句' });
  const errC = await c.wait('chat.error');
  ok('不在频道里的人发言被挡下', /不在这个房间/.test(errC.msg || ''), errC.msg);
  c.send({ t: 'chat.unsafe', channel: CH });          // 未知类型不会崩
  c.send({ t: 'chat.join', channel: 'bad channel!' });
  const errBad = await c.wait('chat.error');
  ok('频道名格式不对被挡下', /格式/.test(errBad.msg || ''), errBad.msg);
  c.send({ t: 'chat.join', channel: 'x' });
  ok('过短的频道名也被挡下', /格式/.test((await c.wait('chat.error')).msg || ''));

  console.log('\n== D. 后来的人能接上话（日志回放） ==');
  c.send({ t: 'chat.join', channel: CH });
  const logC = await c.wait('chat.log');
  ok('晚进来的人能看到之前的发言（回放 2 条）',
    logC.list.length === 2 && logC.list[0].text === '有人吗？' && logC.list[1].text === '在，开始吧',
    JSON.stringify(logC.list.map(x => x.text)));
  ok('回放里带昵称与时间', logC.list.every(x => !!x.name && !!x.ts));

  console.log('\n== E. 统计 / 离开 / 回收 ==');
  const st1 = await status(base);
  ok('/api/status 里有频道与人数', st1.chatChannels === 1 && st1.chatMembers === 3,
    JSON.stringify({ chatChannels: st1.chatChannels, chatMembers: st1.chatMembers }));

  b.send({ t: 'chat.leave', channel: CH });
  const memAfterLeave = await a.waitMatch('chat.members', m => m.members.length === 2);
  ok('有人退出后成员列表立刻更新（2 人）', memAfterLeave.members.length === 2, JSON.stringify(memAfterLeave.members));
  const sysLeave = await a.waitMatch('chat.system', m => /离开了房间/.test(m.text || ''));
  ok('房间里的人看到"有人离开了房间"', /离开了房间/.test(sysLeave.text || ''), sysLeave.text);
  b.send({ t: 'chat.send', channel: CH, text: '我走了还能发吗' });
  ok('退出频道后再发言被挡下', /不在这个房间/.test((await b.wait('chat.error')).msg || ''));

  console.log('\n== F. 掉线自动摘除 / 频道随最后一人消失 ==');
  c.close();
  await sleep(300);
  const memAfterClose = await a.waitMatch('chat.members', m => m.members.length === 1);
  ok('有人掉线后成员列表少了人', memAfterClose.members.length === 1, JSON.stringify(memAfterClose.members));
  a.close();
  await sleep(400);
  const st2 = await status(base);
  ok('最后一个人离开后频道被回收', st2.chatChannels === 0 && st2.chatMembers === 0,
    JSON.stringify({ chatChannels: st2.chatChannels, chatMembers: st2.chatMembers }));

  console.log('\n== G. 消息长度上限 ==');
  const d = await client('D', '10.1.0.9', port);
  await d.wait('hello');
  d.send({ t: 'chat.join', channel: 'tank:7' });
  await d.wait('chat.log');
  d.drain('chat.msg');
  d.send({ t: 'chat.send', channel: 'tank:7', text: 'x'.repeat(900) });
  const longMsg = await d.wait('chat.msg');
  ok('超长消息被截断到 300 字', longMsg.text.length === 300, longMsg.text.length + ' 字');
  const st3 = await status(base);
  ok('另一个频道（tank:7）也计入统计', st3.chatChannels === 1 && st3.chatMembers === 1,
    JSON.stringify({ chatChannels: st3.chatChannels, chatMembers: st3.chatMembers }));
  d.close();

  console.log('\n== H. 兼容性：好友系统与频道聊天互不影响 ==');
  const e = await client('E', '10.1.0.11', port);
  await e.wait('hello');
  const stE = await e.wait('friends.state');
  ok('频道消息前缀没有撞车（好友系统照常工作）',
    Array.isArray(stE.friends) && Array.isArray(stE.online));
  ok('平台仍无路由冲突', (await status(base)).routeConflicts.length === 0);
  e.close();

  PROC.kill();
  console.log('\n========================================');
  console.log('  频道聊天自检：' + passes + ' 项通过，' + fails + ' 项失败');
  console.log('========================================');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('\n[自检异常]', e && e.message ? e.message : e);
  if (PROC) PROC.kill();
  process.exit(1);
});
