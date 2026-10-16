'use strict';
/* ============================================================================
 * 底力练习器 — 服务端（单人音游，无房间）
 *
 * 职责（都很薄，玩法全在客户端）：
 *   1. 排行榜：限时模式（仅 20s / 60s / 180s 三个预选档上传）与无尽模式
 *      （4k / 5k / 6k 各一张榜），落盘 JSON，掉电不丢。
 *   2. 皮肤广场：玩家把自制皮肤（base64 内联的图片/音效）上传到服务器，
 *      其他人从广场拉列表、取皮肤直接用。
 *
 * 平台约定：
 *   - Hub.hidden = true —— 不上主页卡片，但 /dili/ 直连照常（开发者入口）。
 *   - busy() 恒返回 null —— 单人游戏，永远不算「组队中」。
 *   - 消息前缀 dili.*，不和别的游戏撞车。
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

/* 数据目录：可用 WB_DILI_DATA_DIR 重定向（自检脚本用，避免污染真实存档） */
const DATA_DIR = process.env.WB_DILI_DATA_DIR || path.join(__dirname, 'data');
const SKINS_DIR = path.join(DATA_DIR, 'skins');
const BOARDS_FILE = path.join(DATA_DIR, 'boards.json');

/* 限时模式允许上榜的时长（秒）——自定义时长只在本地玩，不上传 */
const TIMED_PRESETS = [20, 60, 180];
const ALLOWED_KEYS = [4, 5, 6];
const BOARD_KEEP = 50;          // 每张榜保留前多少名
const MAX_SCORE = 99999;        // 分数合理性上限（防手滑/恶意）
const SKIN_MAX_BYTES = 3 * 1024 * 1024;   // 单个皮肤总大小上限
const ASSET_MAX_BYTES = 900 * 1024;       // 皮肤里单张图片/音效上限
const SKIN_KEEP = 200;          // 广场最多存多少个皮肤（超出删最旧的）
const TREND_WINDOW_MS = 48 * 3600 * 1000; // 排名趋势的观察窗口（48 小时）
const RANKLOG_KEEP = 24;        // 每条记录最多保留多少个排名轨迹点

/** 图片/音效的 data URI 白名单：只收 base64，杜绝奇怪的内容 */
const ASSET_RE = /^data:(image\/(png|jpeg|webp|gif)|audio\/(mpeg|mp3|wav|ogg|aac));base64,[A-Za-z0-9+/=]+$/;

class DiliHub {
  constructor(ctx) {
    this.ctx = ctx;
    this.boards = null;                       // 懒加载：{ "timed_4_60": [entry...] }
    this._saveQueued = false;
    this._lastSubmitAt = new Map();           // clientId -> ts（提交限速）
    this._lastSkinAt = new Map();             // clientId -> ts（上传限速）
    if (!fs.existsSync(SKINS_DIR)) fs.mkdirSync(SKINS_DIR, { recursive: true });
    // 进程退出时把还没刷盘的榜单同步补写（防抖 500ms 内被 kill 也不丢榜）
    if (!DiliHub._exitHooked) {
      DiliHub._exitHooked = true;
      const self = this;
      process.on('exit', function () {
        if (!self._saveQueued) return;
        self._saveQueued = false;
        try {
          const tmp = BOARDS_FILE + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(self.boards || {}));
          fs.renameSync(tmp, BOARDS_FILE);
        } catch (e) { /* 退出路径里没机会善后，尽力而为 */ }
      });
    }
  }

  /* ---------------- 数据读写 ---------------- */
  _loadBoards() {
    if (this.boards) return this.boards;
    try {
      const raw = JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8'));
      this.boards = (raw && typeof raw === 'object') ? raw : {};
    } catch (e) { this.boards = {}; }
    return this.boards;
  }

  _saveBoards() {
    // 500ms 合并写：短时间多人上榜不至于疯狂刷盘
    if (this._saveQueued) return;
    this._saveQueued = true;
    setTimeout(() => {
      this._saveQueued = false;
      try {
        const tmp = BOARDS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.boards || {}));
        fs.renameSync(tmp, BOARDS_FILE);
      } catch (e) { console.error('[dili] 排行榜落盘失败:', e.message); }
    }, 500);
  }

  _boardKey(mode, keys, seconds) {
    return mode + '_' + keys + '_' + (mode === 'timed' ? seconds : 0);
  }

  /* ---------------- 排行榜 ---------------- */
  boardGet(client, msg) {
    const key = this._normBoardKey(msg);
    if (!key) { this.ctx.send(client, { t: 'dili.board', list: [] }); return; }
    const list = this._loadBoards()[key] || [];
    this.ctx.send(client, { t: 'dili.board', board: key, mode: (msg && msg.mode) || 'timed', list: this._publicList(list) });
  }

  boardSubmit(client, msg) {
    const now = Date.now();
    const last = this._lastSubmitAt.get(client.id) || 0;
    if (now - last < 3000) { this.ctx.send(client, { t: 'dili.board.reject', msg: '提交太频繁，稍后再试' }); return; }
    this._lastSubmitAt.set(client.id, now);

    const key = this._normBoardKey(msg);
    // key 为空 = 自定义时长限时局（或参数不合法）：明确告诉客户端"不上榜"
    if (!key) { this.ctx.send(client, { t: 'dili.board.noupload' }); return; }

    let score = Math.floor(Number(msg.score));
    const timeMs = Math.max(0, Math.floor(Number(msg.timeMs) || 0));
    const cps = Math.max(0, Math.min(99, Number(msg.cps) || 0));
    const errors = Math.max(0, Math.floor(Number(msg.errors) || 0));
    const isEndless = (msg && msg.mode === 'endless');
    if (isEndless) {
      /*
       * 无尽模式的名次看「最终速度」（键/秒，也就是 CPS）：
       * 音符自动下落、越来越快，答不上来为止 —— 死时能顶到的速度就是成绩。
       * 为了沿用同一套榜单排序，分数字段存 cps×100（保留两位小数）。
       */
      if (!(cps > 0) || cps > 40) { this.ctx.send(client, { t: 'dili.board.reject', msg: '速度数据异常，未上榜' }); return; }
      score = Math.round(cps * 100);
    }
    if (!isFinite(score) || score < 0 || score > MAX_SCORE) {
      this.ctx.send(client, { t: 'dili.board.reject', msg: '分数不合法' }); return;
    }
    if (!isEndless) {
      // 限时模式合理性：再快也不可能每秒 40 分
      const seconds = Math.max(1, timeMs / 1000);
      if (score / seconds > 40) { this.ctx.send(client, { t: 'dili.board.reject', msg: '数据异常，未上榜' }); return; }
    }

    const boards = this._loadBoards();
    const list = boards[key] || (boards[key] = []);
    // 一张榜里每人（按 IP）只保留最优成绩：更好的才进榜，否则原记录原样保留
    const ip = client.ip;
    const oldIdx = list.findIndex(e => e.ip === ip);
    if (oldIdx !== -1) {
      const old = list[oldIdx];
      const better = score > old.score || (score === old.score && timeMs < old.timeMs);
      if (!better) {
        const rank = oldIdx + 1;
        this.ctx.send(client, {
          t: 'dili.board.result',
          board: key,
          rank: rank <= BOARD_KEEP ? rank : null,
          improved: false,
          best: { name: old.name, score: old.score },
          ownBest: { score: old.score, timeMs: old.timeMs, date: old.date },
          list: this._publicList(list)
        });
        return;
      }
      list.splice(oldIdx, 1);   // 破纪录：旧记录让位（创造时间换成这次）
    }
    const entry = {
      name: String(client.name || '无名').slice(0, 12),
      ip: ip,
      score, timeMs, cps, errors,
      date: now,                     // 这条记录创造的时间
      likes: 0,                      // 点赞数
      likedBy: []                    // 谁赞过（按 IP，一人一票）
    };
    list.push(entry);
    // 分数高在前；同分按用时短在前
    list.sort((a, b) => (b.score - a.score) || (a.timeMs - b.timeMs));
    let rank = list.findIndex(e => e === entry) + 1;
    if (list.length > BOARD_KEEP) list.length = BOARD_KEEP;
    if (rank > BOARD_KEEP) rank = 0;   // 没进前 50 就不宣传名次了
    this._markRanks(list);             // 记录名次轨迹（48h 趋势箭头用）
    this._saveBoards();

    this.ctx.send(client, {
      t: 'dili.board.result',
      board: key,
      mode: msg.mode,
      rank: rank || null,
      improved: true,
      best: list[0] ? { name: list[0].name, score: list[0].score } : null,
      ownBest: { score: entry.score, timeMs: entry.timeMs, date: entry.date },
      list: this._publicList(list)
    });
  }

  /** 给榜上每条记录记一份名次轨迹（变化才记点），48 小时趋势箭头靠它 */
  _markRanks(list) {
    const now = Date.now();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const rank = i + 1;
      const log = e.rankLog || (e.rankLog = []);
      const last = log[log.length - 1];
      if (!last || last.r !== rank) log.push({ r: rank, at: now });
      // 只留 48h 窗口内的点 + 一个窗口外的基准点，最多 24 个
      let base = null;
      const kept = [];
      for (const p of log) {
        if (p.at <= now - TREND_WINDOW_MS) base = p;
        else kept.push(p);
      }
      e.rankLog = base ? [base].concat(kept).slice(-RANKLOG_KEEP) : kept.slice(-RANKLOG_KEEP);
    }
  }

  /** 48h 内排名升了 → 'up'；降了 → 'down'；没变 → '' */
  _trendOf(e, rank, now) {
    const log = e.rankLog || [];
    if (!log.length) return '';
    let base = null;
    for (const p of log) { if (p.at <= now - TREND_WINDOW_MS) base = p; else break; }
    if (!base) base = log[0];          // 榜龄不足 48h：以最早记录为基准
    if (base.r === rank) return '';
    return rank < base.r ? 'up' : 'down';
  }

  /** 下发给客户端的榜单：剥掉内部字段，带上点赞数与趋势 */
  _publicList(list) {
    const now = Date.now();
    return list.slice(0, 20).map((e, i) => ({
      name: e.name, ip: e.ip,
      score: e.score, timeMs: e.timeMs, cps: e.cps, errors: e.errors,
      date: e.date, likes: e.likes || 0,
      trend: this._trendOf(e, i + 1, now)
    }));
  }

  /** 点赞：一人（IP）一票，不能赞自己 */
  like(client, msg) {
    const key = this._normBoardKey(msg);
    if (!key) { this.ctx.send(client, { t: 'dili.like.fail', msg: '榜单不存在' }); return; }
    const target = String(msg && msg.target || '');
    if (target === client.ip) { this.ctx.send(client, { t: 'dili.like.fail', msg: '不能给自己点赞哦' }); return; }
    const list = this._loadBoards()[key] || [];
    const entry = list.find(e => e.ip === target);
    if (!entry) { this.ctx.send(client, { t: 'dili.like.fail', msg: '这条记录已经不在榜上了' }); return; }
    entry.likedBy = entry.likedBy || [];
    if (entry.likedBy.length > 200) entry.likedBy = entry.likedBy.slice(-200);
    if (entry.likedBy.indexOf(client.ip) !== -1) {
      this.ctx.send(client, { t: 'dili.like.ok', likes: entry.likes || 0, already: true });
      return;
    }
    entry.likedBy.push(client.ip);
    entry.likes = entry.likedBy.length;
    this._saveBoards();
    this.ctx.send(client, { t: 'dili.like.ok', likes: entry.likes, already: false });
  }

  /** 校验并归一化榜单 key；不该上榜的返回 null */
  _normBoardKey(msg) {
    const mode = msg && msg.mode;
    const keys = Math.floor(Number(msg && msg.keys));
    const seconds = Math.floor(Number(msg && msg.seconds));
    if (ALLOWED_KEYS.indexOf(keys) === -1) return null;
    if (mode === 'timed') {
      if (TIMED_PRESETS.indexOf(seconds) === -1) return null;   // 自定义时长不上传
      return this._boardKey('timed', keys, seconds);
    }
    if (mode === 'endless') return this._boardKey('endless', keys, 0);
    return null;
  }

  /* ---------------- 皮肤广场 ---------------- */
  skinList(client) {
    let ids = [];
    try { ids = fs.readdirSync(SKINS_DIR).filter(f => f.endsWith('.json')); } catch (e) { ids = []; }
    const list = [];
    for (const f of ids) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SKINS_DIR, f), 'utf8'));
        list.push({ id: s.id, name: s.name, author: s.author, time: s.time, size: s._size || 0 });
      } catch (e) { /* 单个坏了不影响整体 */ }
    }
    list.sort((a, b) => b.time - a.time);
    this.ctx.send(client, { t: 'dili.skins', list: list.slice(0, 100) });
  }

  skinGet(client, msg) {
    const id = String(msg && msg.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!id) { this.ctx.send(client, { t: 'dili.skin.get.fail', msg: '皮肤不存在' }); return; }
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SKINS_DIR, id + '.json'), 'utf8'));
      this.ctx.send(client, { t: 'dili.skin.one', skin: this._publicSkin(s) });
    } catch (e) {
      this.ctx.send(client, { t: 'dili.skin.get.fail', msg: '皮肤不存在' });
    }
  }

  skinUpload(client, msg) {
    const now = Date.now();
    const last = this._lastSkinAt.get(client.id) || 0;
    if (now - last < 10000) { this.ctx.send(client, { t: 'dili.skin.upload.fail', msg: '上传太频繁，稍后再试' }); return; }
    this._lastSkinAt.set(client.id, now);

    const skin = msg && msg.skin;
    if (!skin || typeof skin !== 'object') { this.ctx.send(client, { t: 'dili.skin.upload.fail', msg: '皮肤数据不完整' }); return; }

    const name = String(skin.name || '').trim().slice(0, 20) || '未命名皮肤';
    const clean = { name, author: String(client.name || '无名').slice(0, 12), time: now };

    // 逐字段校验：只认白名单字段 + data URI 格式 + 大小上限
    const fields = ['bg', 'keyBg', 'note', 'hit', 'hitSound', 'errSound'];
    let total = 0;
    for (const f of fields) {
      const v = skin[f];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v !== 'string' || !ASSET_RE.test(v) || v.length > ASSET_MAX_BYTES) {
        this.ctx.send(client, { t: 'dili.skin.upload.fail', msg: '素材「' + f + '」不是合法的图片/音效或太大（单件 ≤ 900KB）' });
        return;
      }
      total += v.length;
      clean[f] = v;
    }
    if (total > SKIN_MAX_BYTES) {
      this.ctx.send(client, { t: 'dili.skin.upload.fail', msg: '皮肤整体超过 3MB，请压缩素材' }); return;
    }
    const op = Number(skin.hitOpacity);
    clean.hitOpacity = isFinite(op) ? Math.max(0, Math.min(1, op)) : 0.5;

    // id 用时间+随机，避开并发撞名
    const id = 's' + now.toString(36) + Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
    clean.id = id;
    clean._size = total;
    try {
      fs.writeFileSync(path.join(SKINS_DIR, id + '.json'), JSON.stringify(clean));
    } catch (e) {
      this.ctx.send(client, { t: 'dili.skin.upload.fail', msg: '服务器保存失败' }); return;
    }
    this._pruneSkins();
    this.ctx.send(client, { t: 'dili.skin.upload.ok', id, name });
    console.log('[dili] 皮肤「' + name + '」由', client.name, '上传到广场');
  }

  /** 广场只保留最近 SKIN_KEEP 个，超了删最旧的 */
  _pruneSkins() {
    let ids = [];
    try { ids = fs.readdirSync(SKINS_DIR).filter(f => f.endsWith('.json')); } catch (e) { return; }
    if (ids.length <= SKIN_KEEP) return;
    const metas = [];
    for (const f of ids) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SKINS_DIR, f), 'utf8'));
        metas.push({ f, time: s.time || 0 });
      } catch (e) { metas.push({ f, time: 0 }); }
    }
    metas.sort((a, b) => a.time - b.time);
    for (let i = 0; i < metas.length - SKIN_KEEP; i++) {
      try { fs.unlinkSync(path.join(SKINS_DIR, metas[i].f)); } catch (e) { /* 忽略 */ }
    }
  }

  /** 下发皮肤时剥掉内部字段 */
  _publicSkin(s) {
    return {
      id: s.id, name: s.name, author: s.author, time: s.time,
      bg: s.bg || null, keyBg: s.keyBg || null, note: s.note || null, hit: s.hit || null,
      hitSound: s.hitSound || null, errSound: s.errSound || null,
      hitOpacity: typeof s.hitOpacity === 'number' ? s.hitOpacity : 0.5
    };
  }

  /* ---------------- 平台约定 ---------------- */
  register(client) {
    // 单人游戏不需要发什么状态；发个"就绪"让客户端知道 dili.* 路由活着
    this.ctx.send(client, { t: 'dili.hello' });
  }

  busy() { return null; }

  stats() {
    let skins = 0;
    try { skins = fs.readdirSync(SKINS_DIR).filter(f => f.endsWith('.json')).length; } catch (e) { /* 空 */ }
    return { diliSkins: skins };
  }
}

DiliHub.routes = {
  'dili.register': 'register',
  'dili.board.get': 'boardGet',
  'dili.board.submit': 'boardSubmit',
  'dili.like': 'like',
  'dili.skin.list': 'skinList',
  'dili.skin.get': 'skinGet',
  'dili.skin.upload': 'skinUpload'
};
DiliHub.title = '底力练习器';
DiliHub.entry = '/dili/';
DiliHub.order = 60;
DiliHub.hidden = true;    // 暂不上主页：/dili/ 直连进入
DiliHub.card = {
  desc: '音游底力练习器（限时 / 无尽，4k-6k，皮肤广场）',
  tags: ['单人练习 · 不需要房间', '限时 / 无尽 · 4K / 5K / 6K', '皮肤工坊 + 皮肤广场', '排行榜实时看'],
  links: []
};

module.exports = DiliHub;
