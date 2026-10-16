'use strict';
/* ============================================================================
 * 底力练习器 — 内核（浏览器 / Node 共用，UMD）
 *
 * 玩法照搬开源项目 eatcat（吃掉小猫猫，MIT）：
 *   - 音符一行行从下往上滚，最下面一行是「当前要打」的行；
 *   - 每行在 keyCount 条轨道里随机一条放一个音符；
 *   - 点对 → 该行整体上移一格、补一行新音符，分数 +1；
 *   - 点错（点到没有音符的轨道）→ 失误，对局结束；
 *   - 打得越快滚得越快：屏幕上剩余行数越少，滚动加速（吃手速的底力练习）。
 *
 * 这里只放「纯逻辑」：键位映射、随机轨道、加速曲线、坚持时间与评语。
 * 渲染 / 音频 / 存档都留在客户端。
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DiliCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /** 基础滚动间隔（毫秒/行）：1 倍速时每行走这么久，加速后按倍率除 */
  var BASE_TRANSITION_MS = 180;
  /** 加速上限（倍）—— eatcat 的 3 倍封顶 */
  var SPEED_MAX = 3;

  /**
   * 滚动加速曲线（照搬 eatcat updateScrollSpeed）：
   * 屏幕上还没打掉的行数 r —— 越少说明玩家手速越快，滚得越快。
   *   r ≤ 4 → 1 + (4-r)×0.5，最高 3 倍
   *   r ≤ 8 → 1 + (8-r)×0.25（平滑回落）
   *   其余   → 1 倍
   */
  function speedMultiplier(rowsLeft) {
    var r = rowsLeft | 0;
    if (r <= 4) return Math.min(SPEED_MAX, 1 + (4 - r) * 0.5);
    if (r <= 8) return 1 + (8 - r) * 0.25;
    return 1;
  }

  /** 当前滚动间隔（毫秒） */
  function transitionMs(rowsLeft) {
    return Math.max(60, Math.round(BASE_TRANSITION_MS / speedMultiplier(rowsLeft)));
  }

  /** 新一行的音符轨道：均匀随机（允许连续同行同轨，原版如此） */
  function nextTrack(rng, keyCount) {
    var rand = rng || Math.random;
    return Math.floor(rand() * keyCount);
  }

  /**
   * 键位映射解析 —— 支持 ~ 把多个键绑到同一轨道（大键手感）：
   *   'dfjk'    → d/f/j/k 各一轨
   *   's~df~jk~l'（6k）→ s、d 同轨 …
   * 返回 { keyToTrack: {键:轨}, trackKeys: [[键...], ...] }
   */
  function keyMapping(str, keyCount) {
    var allowed = 'abcdefghijklmnopqrstuvwxyz0123456789;\'\\,./[]=-` ';
    var s0 = String(str == null ? '' : str).trim();
    if (!s0) s0 = defaultKeys(keyCount);      // 留空 → 用该键数的默认键位
    var filtered = '';
    for (var i = 0; i < s0.length; i++) {
      var c = s0[i];
      if (c === '~') filtered += '~';
      else if (c >= 'A' && c <= 'Z') filtered += c.toLowerCase();
      else if (allowed.indexOf(c) !== -1) filtered += c;
    }
    while (filtered.charAt(0) === '~') filtered = filtered.slice(1);
    while (filtered.charAt(filtered.length - 1) === '~') filtered = filtered.slice(0, -1);

    var keyToTrack = {}, trackKeys = [];
    var track = 0, used = {};
    for (var j = 0; j < filtered.length && track < keyCount; j++) {
      var ch = filtered[j];
      if (ch === '~') continue;
      if (!used[ch]) {
        used[ch] = true;
        keyToTrack[ch] = track;
        (trackKeys[track] || (trackKeys[track] = [])).push(ch);
      }
      // 下一个是 ~ → 下一颗键还归本轨
      if (filtered[j + 1] !== '~') track++;
    }
    // 缺的轨道从 a 开始补
    var pool = 'abcdefghijklmnopqrstuvwxyz';
    var p = 0;
    while (track < keyCount && p < pool.length) {
      var l = pool[p++];
      if (!used[l]) {
        used[l] = true;
        keyToTrack[l] = track;
        (trackKeys[track] || (trackKeys[track] = [])).push(l);
        track++;
      }
    }
    return { keyToTrack: keyToTrack, trackKeys: trackKeys };
  }

  /** 各键数的默认键位（照搬 eatcat） */
  function defaultKeys(keyCount) {
    var d = { 4: 'dfjk', 5: 'df jk', 6: 'sdfjkl' };   // 5K 中间那颗是空格
    return d[keyCount] || 'dfjk';
  }

  /**
   * 「您坚持了 X 秒」—— 照搬 eatcat 的 deviationTime：
   * 实际经过时间会被暂停、以及"最后一次按键到结束"的空窗打折扣，
   * 取多个口径的最大值，避免挂机也拿满时长。
   */
  function deviationTime(opts) {
    var d = (opts.end - opts.start - (opts.pausedMs || 0)) / 1000;
    if (!(d > 0)) return opts.timeLimit ? opts.timeLimit * 1000 : 0;
    var lc = Math.max(0, (opts.lastTap - opts.start) / 1000 - (opts.pausedMs || 0) / 1000);
    var sec = Math.max(d - 1, d * 0.9, lc, d - 2 * (opts.score || 0) / d);
    return sec * 1000;
  }

  /** 结算评语（照搬 eatcat shareText） */
  function shareText(score, timeLimit) {
    var s = score, t = timeLimit;
    if (s <= 3 * t) return '加油！我相信您可以的！';
    if (s <= 6 * t) return '^_^ 加把劲，底力大王就是您！';
    if (s <= 9 * t) return '您！';
    if (s <= 12 * t) return '太 您 了！';
    return '您是外星人嘛？';
  }

  /** 该档成绩是否应该上传排行榜（限时模式只有三个预选档上榜） */
  function uploadable(mode, seconds) {
    if (mode === 'endless') return true;
    return [20, 60, 180].indexOf(seconds) !== -1;
  }

  /** 榜单 key（与服务端 _boardKey 一致） */
  function boardKey(mode, keys, seconds) {
    return mode + '_' + keys + '_' + (mode === 'timed' ? seconds : 0);
  }

  return {
    BASE_TRANSITION_MS: BASE_TRANSITION_MS,
    SPEED_MAX: SPEED_MAX,
    speedMultiplier: speedMultiplier,
    transitionMs: transitionMs,
    nextTrack: nextTrack,
    keyMapping: keyMapping,
    defaultKeys: defaultKeys,
    deviationTime: deviationTime,
    shareText: shareText,
    uploadable: uploadable,
    boardKey: boardKey
  };
}));
