'use strict';
/**
 * 玩家名字注册表（平台层）
 *
 * 规则：名字全服独占，先到先得 —— 一台电脑（IP）当前用着什么名字，别的电脑就不能冒用。
 *   - 换了新名字，旧名字自动释放，别的电脑就可以注册了（历史里仍留一笔，/info IP 可查）；
 *   - 同一台电脑重连 / 换页面继续用自己现在的名字，完全放行；
 *   - 「玩家573」这类随机兜底名同样占用，防止有人故意撞名；
 *   - 登记结果落盘（names-registry.json），重启服务器也不丢。
 *
 * 除了给 hello 做查重，还服务控制台命令：
 *   /info 玩家名  → ownerIp(name)   反查 IP（只查当前占用，释放过的查不到）
 *   /info IP      → namesOfIp(ip)   这个 IP 用过哪些名字（含已释放的）
 */
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.WB_NAMES_FILE || path.join(__dirname, 'names-registry.json');

/** 名字归一：查重时忽略大小写和首尾空格（「Tom」和「tom」算同一个名字） */
function norm(s) { return String(s || '').trim().toLowerCase(); }

class NameRegistry {
  constructor() {
    /** 归一名 -> { name, ip, ts }：当前被占用的名字（name 是首次登记时的原始写法） */
    this.byName = new Map();
    /** ip -> (归一名 -> { name, ts })：这台电脑用过的所有名字（含已释放的），按首次使用时间 */
    this.history = new Map();
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && raw.names && typeof raw.names === 'object') {
        for (const k of Object.keys(raw.names)) {
          const r = raw.names[k];
          if (r && typeof r.name === 'string' && typeof r.ip === 'string') {
            this.byName.set(k, { name: r.name, ip: r.ip, ts: r.ts || 0 });
            this._remember(r.ip, r.name, r.ts || 0);   // 旧档没有历史表，先从占用表补出来
          }
        }
      }
      if (raw && raw.history && typeof raw.history === 'object') {
        for (const ip of Object.keys(raw.history)) {
          const h = raw.history[ip];
          if (!h || typeof h !== 'object') continue;
          for (const k of Object.keys(h)) {
            const r = h[k];
            if (r && typeof r.name === 'string') this._remember(ip, r.name, r.ts || 0);
          }
        }
      }
    } catch (e) { /* 存档损坏就当没有，不影响开服 */ }
  }

  _remember(ip, name, ts) {
    let h = this.history.get(ip);
    if (!h) { h = new Map(); this.history.set(ip, h); }
    const k = norm(name);
    if (!h.has(k)) h.set(k, { name, ts: ts || Date.now() });
  }

  /** 防抖落盘：临时文件 + rename，写一半断电也不坏档 */
  _persist() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const names = {};
        for (const [k, r] of this.byName) names[k] = r;
        const history = {};
        for (const [ip, h] of this.history) {
          const item = {};
          for (const [k, r] of h) item[k] = r;
          history[ip] = item;
        }
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ v: 2, savedAt: Date.now(), names, history }));
        fs.renameSync(tmp, DATA_FILE);
      } catch (e) { /* 磁盘出问题不影响内存里的登记 */ }
    }, 600);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /** 名字对这台电脑是否可用（没被别人注册过；同 IP 自己的可以继续用） */
  available(name, ip) {
    const rec = this.byName.get(norm(name));
    return !rec || rec.ip === ip;
  }

  /**
   * 登记 / 换名占用。被别人占着就返回 false（调用方自己去提示用户换名）。
   * 同一台电脑换用新名字时，旧名字自动释放给别人（历史里仍记一笔）。
   */
  register(name, ip) {
    const n = String(name || '').trim();
    if (!n || !ip) return false;
    if (!this.available(n, ip)) return false;
    const k = norm(n);
    const prev = this.byName.get(k);
    const ts = (prev && prev.ts) || Date.now();
    this.byName.set(k, { name: (prev && prev.name) || n, ip, ts });
    for (const [kk, r] of this.byName) {   // 这台电脑现在只用新名字，旧的都放掉
      if (kk !== k && r.ip === ip) this.byName.delete(kk);
    }
    this._remember(ip, n, ts);
    this._persist();
    return true;
  }

  /** 这个名字现在被哪台电脑（IP）占着；没人占用返回 null（被释放过的名字查不到） */
  ownerIp(name) {
    const rec = this.byName.get(norm(name));
    return rec ? rec.ip : null;
  }

  /** 这台电脑用过的所有名字（含已释放的，按首次使用时间升序） */
  namesOfIp(ip) {
    const h = this.history.get(ip);
    if (!h) return [];
    return Array.from(h.values()).sort((a, b) => a.ts - b.ts);
  }

  stats() { return { registeredNames: this.byName.size }; }
}

NameRegistry.DATA_FILE = DATA_FILE;

module.exports = NameRegistry;
