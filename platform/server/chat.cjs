'use strict';
/**
 * 频道聊天（平台层，所有游戏通用）
 *
 * 和好友系统的分工：
 *   · friends.cjs —— 「好友之间」的私聊，按 IP 落盘、跨游戏跨页面都在；
 *   · chat.cjs    —— 「一个房间里」的公共聊天，谁进了这个频道谁就看得见。
 * 两者在页面上由同一个聊天控件（shared/chat.js）呈现，用户不必关心背后是两套。
 *
 * 频道 id 由调用方约定：`<游戏>:<房间标志>`，例如 dodge:1234 / tank:0421 / gomoku:m_ab12cd。
 * 服务端不解析含义，只做格式校验（防止有人拿它当任意群发通道）。
 * 频道是**临时**的：没人了就删掉，日志只放内存（房间消失，聊天记录也该跟着消失）。
 *
 * 消息一览（C=客户端 S=服务端）：
 *   C→S  chat.join   { channel, title }        进频道（创建房间 / 加入房间 / 开局时调用）
 *   C→S  chat.leave  { channel }               离开频道（也可以不带 channel：退掉全部）
 *   C→S  chat.send   { channel, text, mid }    在频道里发言
 *   S→C  chat.log    { channel, title, list }  刚进频道时补一段最近记录
 *   S→C  chat.msg    { channel, from, name, text, ts, mid, self }
 *   S→C  chat.members{ channel, members:[{name, ip, self}] }
 *   S→C  chat.system { channel, text }         系统提示（谁进来 / 谁离开）
 *   S→C  chat.error  { msg }
 *
 * 服务端零依赖：只用 Node 内置模块，没有落盘（频道是临时的）。
 */

const CHANNEL_RE = /^[a-z0-9_-]{2,24}:[A-Za-z0-9_-]{1,24}$/;   // 例：dodge:1234
const LOG_CAP = 80;        // 每个频道最多记住多少条（回放给后来的人）
const LOG_REPLAY = 30;     // 进频道时最多回放多少条
const TEXT_MAX = 300;      // 单条消息长度上限
const MEMBER_MAX = 16;     // 一个频道最多多少人（房间最多 4 人，留足余量）
const TITLE_MAX = 40;

class Chat {
  constructor(ctx) {
    this.ctx = ctx;
    /** channelId -> { id, title, members: Map<clientId,{id,name,ip}>, log: [] } */
    this.channels = new Map();
  }

  /* ================= 内部工具 ================= */
  _send(client, obj) { this.ctx.send(client, obj); }

  _fail(client, msg) { this._send(client, { t: 'chat.error', msg }); }

  _normChannel(raw) {
    const id = String(raw || '').trim();
    return CHANNEL_RE.test(id) ? id : null;
  }

  _members(id) {
    const ch = this.channels.get(id);
    if (!ch) return;
    const list = [];
    for (const m of ch.members.values()) list.push({ name: m.name, ip: m.ip });
    for (const m of ch.members.values()) {
      const c = this.ctx.clients.get(m.id);
      if (!c) continue;
      this._send(c, {
        t: 'chat.members', channel: id, title: ch.title,
        members: list.map((x) => ({ name: x.name, ip: x.ip, self: x.ip === m.ip }))
      });
    }
  }

  _system(id, text) {
    const ch = this.channels.get(id);
    if (!ch) return;
    for (const m of ch.members.values()) {
      const c = this.ctx.clients.get(m.id);
      if (c) this._send(c, { t: 'chat.system', channel: id, text });
    }
  }

  /** 把某个连接从所有频道里摘掉（断开连接时用）；返回受影响过的频道 id */
  _detach(client) {
    const left = [];
    for (const [id, ch] of this.channels) {
      if (!ch.members.has(client.id)) continue;
      ch.members.delete(client.id);
      left.push(id);
    }
    for (const id of left) {
      const ch = this.channels.get(id);
      if (!ch) continue;
      if (!ch.members.size) { this.channels.delete(id); continue; }   // 没人的频道直接回收
      this._members(id);
      this._system(id, (client.name || '有人') + ' 离开了房间');
    }
    return left;
  }

  /* ================= 消息处理 ================= */
  join(client, msg) {
    const id = this._normChannel(msg && msg.channel);
    if (!id) { this._fail(client, '频道格式不对'); return; }
    let ch = this.channels.get(id);
    if (!ch) {
      ch = { id, title: '', members: new Map(), log: [] };
      this.channels.set(id, ch);
    }
    if (!ch.members.has(client.id) && ch.members.size >= MEMBER_MAX) {
      this._fail(client, '这个房间的聊天人数已满');
      return;
    }
    const isNew = !ch.members.has(client.id);
    ch.members.set(client.id, { id: client.id, name: client.name, ip: client.ip });
    const title = String((msg && msg.title) || '').slice(0, TITLE_MAX);
    if (title) ch.title = title;
    // 回放最近记录（新进来的人也能接上话）
    this._send(client, { t: 'chat.log', channel: id, title: ch.title, list: ch.log.slice(-LOG_REPLAY) });
    this._members(id);
    if (isNew) this._system(id, (client.name || '有人') + ' 进入了房间');
  }

  leave(client, msg) {
    const raw = String((msg && msg.channel) || '').trim();
    if (!raw) { this._detach(client); return; }
    const id = this._normChannel(raw);
    if (!id) return;
    const ch = this.channels.get(id);
    if (!ch || !ch.members.has(client.id)) return;
    ch.members.delete(client.id);
    if (!ch.members.size) { this.channels.delete(id); return; }
    this._members(id);
    this._system(id, (client.name || '有人') + ' 离开了房间');
  }

  /** 在频道里发言：房间里所有人都能看到（含自己，self=true 用于回显区分） */
  send(client, msg) {
    const id = this._normChannel(msg && msg.channel);
    if (!id) { this._fail(client, '频道格式不对'); return; }
    const ch = this.channels.get(id);
    if (!ch || !ch.members.has(client.id)) { this._fail(client, '你不在这个房间里'); return; }
    const text = String((msg && msg.text) || '').slice(0, TEXT_MAX).trim();
    if (!text) return;
    const mid = String((msg && msg.mid) || '').slice(0, 40) ||
      (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    const entry = { from: client.ip, name: client.name, text, ts: Date.now(), mid };
    ch.log.push(entry);
    if (ch.log.length > LOG_CAP) ch.log.splice(0, ch.log.length - LOG_CAP);
    for (const m of ch.members.values()) {
      const c = this.ctx.clients.get(m.id);
      if (!c) continue;
      this._send(c, {
        t: 'chat.msg', channel: id, from: entry.from, name: entry.name,
        text: entry.text, ts: entry.ts, mid: entry.mid, self: m.id === client.id
      });
    }
  }

  /* ================= 生命周期 / 统计 ================= */
  onClose(client) { this._detach(client); }

  stats() {
    let members = 0;
    for (const ch of this.channels.values()) members += ch.members.size;
    return { chatChannels: this.channels.size, chatMembers: members };
  }
}

Chat.routes = {
  'chat.join': 'join',
  'chat.leave': 'leave',
  'chat.send': 'send'
};

module.exports = Chat;
