/*!
 * 绘画区组件 PaintPad v3 —— 独立、零依赖、可嵌入
 *
 * 挂到全局 WB.PaintPad，任何页面 include 这个 js + paintpad.css 就能用：
 *
 *   var pad = WB.PaintPad.create(document.getElementById('mount'), {
 *     onOp:     function (op) { ... },    // 本地操作（发给服务端 / 存档）
 *     onNotice: function (text, kind) {}  // 需要提示用户时回调
 *   });
 *   pad.setEnabled(true);   // false = 只读（看别人画，左侧工具栏会整个隐藏）
 *   pad.applyOp(op);        // 应用远端操作（坐标归一化，两端自动对齐）
 *   pad.resetAll();         // 新回合，全部清空
 *   pad.getDataURL();       // 导出当前画面
 *
 * 对外 API：getImageData() / getDataURL() / toBlob() / clear() / undo() / redo() /
 *           truncate(n) / setTool() / setBrush() / setColor() / setEnabled() /
 *           applyOp() / resetAll() / zoomAt() / panBy() / fitView() / toggleFullscreen()
 *
 * v3 相对 v2 的改动：
 *   · 笔刷从 4 个变成 12 个真正不一样的笔刷（铅笔/针管笔/马克笔/蜡笔/粉笔/炭笔/
 *     毛笔/喷枪/水彩/霓虹/荧光笔/点点笔），合并成一个按钮 + 弹出菜单，
 *     菜单里每条都用该笔刷画一条波浪线当预览
 *   · 「画笔 / 橡皮 / 涂抹」是三种模式，各自使用当前选中的笔刷纹理；
 *     而且「每种笔刷 × 每种模式」的粗细/不透明度/强度/流量都是独立保存的
 *   · 形状工具改用当前笔刷描边（而不是一根没有性格的实线）
 *   · 撤销/重做改成「整笔」为单位，修掉撤销看起来没反应的 bug
 *   · 滚轮 = 平移画布，Ctrl/⌘ + 滚轮 = 缩放；左侧/下侧加了可拖动的平移条
 *   · 只读（猜的人）时隐藏整个工具栏，视图控件挪到右下角
 */
(function (WB) {
  'use strict';

  if (!WB) throw new Error('PaintPad 需要先加载 core.js');

  var MAX_LAYERS = 4;
  var OP_LIMIT = 6000;        // 必须与服务端 room.js 的 MAX_OPS 保持一致
  var RECENT_MAX = 10;
  var STAMP_CACHE_MAX = 260;
  /* ★ 画纸固定 4:3。以前画布是"撑满容器"的，容器比例一变（比如全屏、拉窗口），
     归一化坐标就会被拉伸 → 笔迹变形。固定比例后放大缩小只是变大变小，形状不变。 */
  var PAGE_AR = 4 / 3;

  /* ============================================================
   * 笔刷表
   *
   *   hard   0..1   边缘硬度（1 = 硬边实心，0 = 极柔）
   *   grain  0..1   颗粒感（用确定性噪声做减法，两端算出来必须一模一样）
   *   build  0..1   单个戳子的不透明度（喷枪/水彩靠重叠堆色，所以要低）
   *   sp            戳子间距 = 半径 × sp
   *   sizeMul       相对基准粗细的倍率
   *   defSize/defOpa  默认粗细 / 默认不透明度
   *   taper         速度越快越细（毛笔）
   *   scatter       每一步撒几个小点（喷枪）
   *   glow          光晕半径倍率（霓虹）
   *   square        方形笔尖（荧光笔）
   * ============================================================ */
  var BRUSHES = [
    { id: 'pencil', label: '铅笔', hard: 0.90, grain: 0.24, build: 1, sp: 0.14, sizeMul: 1.00, defSize: 5, defOpa: 100, tip: '硬边带一点颗粒，打稿勾线都顺手' },
    { id: 'pen', label: '针管笔', hard: 1.00, grain: 0.00, build: 1, sp: 0.06, sizeMul: 0.50, defSize: 4, defOpa: 100, tip: '最细最实，边缘干净，画细节用' },
    { id: 'marker', label: '马克笔', hard: 0.42, grain: 0.00, build: 1, sp: 0.12, sizeMul: 1.20, defSize: 16, defOpa: 60, tip: '圆头半透明，笔与笔重叠会加深' },
    { id: 'crayon', label: '蜡笔', hard: 0.68, grain: 0.58, build: 1, sp: 0.16, sizeMul: 1.00, defSize: 13, defOpa: 90, tip: '颗粒很粗，涂色有蜡质纹理' },
    { id: 'chalk', label: '粉笔', hard: 0.28, grain: 0.86, build: 1, sp: 0.20, sizeMul: 1.25, defSize: 20, defOpa: 80, tip: '边缘松散、颗粒很大，像黑板粉笔' },
    { id: 'charcoal', label: '炭笔', hard: 0.16, grain: 0.46, build: 0.72, sp: 0.22, sizeMul: 1.30, defSize: 28, defOpa: 75, tip: '大面积柔和的暗影，铺调子' },
    { id: 'ink', label: '毛笔', hard: 0.72, grain: 0.10, build: 1, sp: 0.09, sizeMul: 1.00, defSize: 11, defOpa: 100, taper: 0.74, tip: '快笔细、慢笔粗，有提按的力道' },
    { id: 'spray', label: '喷枪', hard: 0.50, grain: 0.00, build: 0.13, sp: 0.30, sizeMul: 1.60, defSize: 36, defOpa: 90, scatter: 9, tip: '一团散点，做渐变和雾最合适' },
    { id: 'water', label: '水彩', hard: 0.05, grain: 0.34, build: 0.30, sp: 0.10, sizeMul: 1.60, defSize: 30, defOpa: 90, tip: '非常柔的湿边，叠色像晕染' },
    { id: 'neon', label: '霓虹', hard: 1.00, grain: 0.00, build: 1, sp: 0.10, sizeMul: 1.00, defSize: 7, defOpa: 100, glow: 2.6, tip: '外圈发光 + 实心亮芯，夜里最好看' },
    { id: 'hl', label: '荧光笔', hard: 1.00, grain: 0.00, build: 1, sp: 0.10, sizeMul: 2.00, defSize: 24, defOpa: 35, square: 1, tip: '扁平方头、半透明，划重点的' },
    { id: 'dots', label: '点点笔', hard: 0.95, grain: 0.00, build: 1, sp: 1.30, sizeMul: 1.40, defSize: 13, defOpa: 100, tip: '间距很大的圆点串，装饰用' }
  ];

  /* 三种模式：都用「当前选中的笔刷」，只是拿它去干不同的事 */
  var MODES = [
    { id: 'pen', label: '画笔', icon: 'brush', tip: '画笔 · 用当前笔刷上色' },
    { id: 'erase', label: '橡皮', icon: 'eraser', tip: '橡皮 · 用当前笔刷的纹理擦掉笔迹' },
    { id: 'smudge', label: '涂抹', icon: 'smudge', tip: '涂抹 · 用当前笔刷把颜色推着走' }
  ];

  var SHAPES = [
    { id: 'line', label: '直线' },
    { id: 'rect', label: '矩形' },
    { id: 'ellipse', label: '圆形' },
    { id: 'triangle', label: '三角形' },
    { id: 'arc', label: '弧线' },
    { id: 'arrow', label: '箭头' }
  ];

  /* 快捷预选色 */
  var PRESETS = [
    '#2b2620', '#6b6257', '#b9ad9c', '#ffffff',
    '#e5533d', '#f08a24', '#f2c53d', '#7bc043',
    '#28a06a', '#12a3b8', '#2f7de1', '#7a5bd8',
    '#d94f8a', '#a462e8', '#8b5a2b', '#ffb3c1'
  ];

  /* 光圈专用笔刷描述（霓虹的外辉光） */
  var HALO = { id: 'pp_halo', hard: 0.04, grain: 0, square: 0 };

  /* 图标（24×24 线条风，用 currentColor 跟着主题走） */
  var ICONS = {
    brush: '<path d="M15.6 3.6l4.8 4.8-8.2 8.2-4.8-4.8 8.2-8.2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7.4 11.8l-2.6 2.6c-1.1 1.1-1.4 3-.7 4.4.7 1.4 2.2 2.1 3.6 1.7 1.2-.3 2-1 2.7-1.9l2.3-2.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.6 19.4c.9-.2 1.7-.9 2.1-1.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    pencil: '<path d="M4 20.5l4.2-1.1L19 8.6a2.2 2.2 0 0 0-3.1-3.1L5.1 16.3 4 20.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14.8 6.6l2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.7"/>',
    marker: '<path d="M6 20.5h5l2-2H8l-2 2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 16.5h5.5L18 13V8.5l-4-4H11l2 2v6.5l-4 3.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    eraser: '<path d="M8.5 20.5h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M13.5 4.5l6 6-8 8H8l-3-3 8.5-11z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    smudge: '<path d="M12 3.5c3.2 4 5 6.4 5 8.9a5 5 0 0 1-10 0c0-2.5 1.8-4.9 5-8.9z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.4 13.6c.5 1.2 1.4 1.9 2.6 1.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    fill: '<path d="M5.5 12.5l6-6 6.5 6.5-6 6a2 2 0 0 1-2.8 0l-3.7-3.7a2 2 0 0 1 0-2.8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 5.5L7.6 4.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M19.5 15.5c1 1.4 1.5 2.3 1.5 3a1.6 1.6 0 0 1-3.2 0c0-.7.6-1.6 1.7-3z" fill="currentColor"/>',
    pick: '<path d="M15.5 3.8l4.7 4.7-2 2-1.4-1.4-6.2 6.2.6 2.6-1.9 1.9-4-4 1.9-1.9 2.6.6 6.2-6.2-1.4-1.4 2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    line: '<path d="M4.5 19.5L19.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    rect: '<rect x="4.5" y="5.5" width="15" height="13" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    ellipse: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    triangle: '<path d="M12 4.6L20.2 19.4H3.8L12 4.6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    arc: '<path d="M4 18.6C6.2 9.4 17.8 9.4 20 18.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    arrow: '<path d="M4.5 19.5L19.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12.5 4.5h7v7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    undo: '<path d="M8 8H15.5a4.5 4.5 0 0 1 0 9H9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M11 4.5L7.5 8l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    redo: '<path d="M16 8H8.5a4.5 4.5 0 0 0 0 9H15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M13 4.5L16.5 8 13 11.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    trash: '<path d="M5.5 7.5h13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M9 7.5V5.2h6v2.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 7.5l.9 11.3h8.2L17 7.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10.3 11v5M13.7 11v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    eye: '<path d="M2.8 12S6.3 6.5 12 6.5 21.2 12 21.2 12 17.7 17.5 12 17.5 2.8 12 2.8 12z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    eyeoff: '<path d="M4 4l16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M2.8 12S6.3 6.5 12 6.5c1.6 0 3 .4 4.2 1M21.2 12s-3.5 5.5-9.2 5.5c-1.5 0-2.8-.4-4-1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    zin: '<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 15.5l4 4M10.5 7.6v5.8M7.6 10.5h5.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    zout: '<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 15.5l4 4M7.6 10.5h5.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    fit: '<rect x="4" y="6" width="16" height="12" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10h8M8 13.5h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    expand: '<path d="M4.5 9.5v-5h5M19.5 9.5v-5h-5M4.5 14.5v5h5M19.5 14.5v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    shrink: '<path d="M9.5 4.5v5h-5M14.5 4.5v5h5M9.5 19.5v-5h-5M14.5 19.5v-5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    layers: '<path d="M12 3.8l8.2 4.4L12 12.6 3.8 8.2 12 3.8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3.8 12.4L12 16.8l8.2-4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    chev: '<path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    close: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };

  function icon(name, cls) {
    var d = mk('span', 'pp-ico' + (cls ? ' ' + cls : ''));
    d.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    return d;
  }

  /* ---------------- 小工具 ---------------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function hexToRgb(h) {
    h = String(h || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    function f(v) { var s = Math.round(clamp(v, 0, 255)).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + f(r) + f(g) + f(b);
  }
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h: h, s: mx ? d / mx : 0, v: mx };
  }
  function newCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  function ctxOf(c) { return c.getContext('2d', { willReadFrequently: true }); }

  /* 确定性伪随机：两端用同一个 key 算出来必须一模一样，否则「我看到的」和
     「别人看到的」就会不一样（这正是 v1 颜色 bug 的同类问题）。 */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h >>> 0;
  }
  function rnd2(x, y, seed) {
    var h = ((x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = (h * 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function brushById(id) {
    for (var i = 0; i < BRUSHES.length; i++) if (BRUSHES[i].id === id) return BRUSHES[i];
    return BRUSHES[0];
  }

  /* ---------------- 戳子（笔尖的一"点"） ---------------- */
  var STAMP_CACHE = {};

  function falloff(t, hard) {
    if (t >= 1) return 0;
    if (hard >= 0.995) return 1;
    var a = clamp((1 - t) / Math.max(1e-4, 1 - hard), 0, 1);
    return a * a * (3 - 2 * a);
  }

  /** 生成/取缓存一个笔尖戳子（radius 用设备像素） */
  function makeStamp(b, radius, rgb) {
    radius = Math.max(0.55, radius);
    var r = Math.round(radius * 4) / 4;             // 量化，提高缓存命中
    var key = b.id + '|' + r + '|' + (b.hard || 0) + '|' + (b.grain || 0) + '|' +
      (b.square ? 1 : 0) + '|' + rgb.r + ',' + rgb.g + ',' + rgb.b;
    if (STAMP_CACHE[key]) return STAMP_CACHE[key];

    var size = Math.max(3, Math.ceil(r * 2) + 3);
    // ★ 必须是奇数：偶数尺寸时没有任何一个像素中心落在圆心，
    //   小半径的戳子（喷枪的散点）会一个像素都画不出来 → 看起来是空白。
    if (size % 2 === 0) size += 1;
    var c = newCanvas(size, size), x = ctxOf(c);
    var id = x.createImageData(size, size), d = id.data;
    var c0 = size / 2, seed = hashStr(key);
    for (var py = 0; py < size; py++) {
      for (var px = 0; px < size; px++) {
        var dx = px + 0.5 - c0, dy = py + 0.5 - c0;
        var dist = b.square ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.sqrt(dx * dx + dy * dy);
        var a = falloff(dist / r, b.hard || 1);
        if (a > 0 && b.grain) a *= (1 - b.grain * rnd2(px, py, seed));
        if (a <= 0.004) continue;
        var o = (py * size + px) * 4;
        d[o] = rgb.r; d[o + 1] = rgb.g; d[o + 2] = rgb.b;
        d[o + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    }
    x.putImageData(id, 0, 0);
    STAMP_CACHE[key] = c;
    if (Object.keys(STAMP_CACHE).length > STAMP_CACHE_MAX) STAMP_CACHE = {};
    return c;
  }

  /** 在一点上盖一个戳子（含喷枪散点 / 霓虹光晕）。mul = 额外的整体透明度 */
  function stampAt(ctx, b, rgb, p, radius, seed, idx, mul) {
    var alpha = (b.build == null ? 1 : b.build) * (mul == null ? 1 : mul);
    if (b.scatter) {
      var sc = makeStamp(b, Math.max(0.8, radius * 0.20), rgb);
      ctx.globalAlpha = alpha;
      for (var i = 0; i < b.scatter; i++) {
        var ang = rnd2(idx, i, seed) * Math.PI * 2;
        var rr = Math.sqrt(rnd2(i, idx, seed + 977)) * radius;
        ctx.drawImage(sc, p.x + Math.cos(ang) * rr - sc.width / 2, p.y + Math.sin(ang) * rr - sc.height / 2);
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (b.glow) {
      var halo = makeStamp(HALO, radius * b.glow, rgb);
      ctx.globalAlpha = alpha * 0.42;
      ctx.drawImage(halo, p.x - halo.width / 2, p.y - halo.height / 2);
    }
    var st = makeStamp(b, radius, rgb);
    ctx.globalAlpha = alpha;
    ctx.drawImage(st, p.x - st.width / 2, p.y - st.height / 2);
    ctx.globalAlpha = 1;
  }

  /** 沿折线打点成一条笔画（preview 与画布共用同一套逻辑） */
  function strokePath(ctx, b, rgb, pts, radius, seed, mul) {
    if (!pts || !pts.length) return;
    var spacing = Math.max(0.55, radius * (b.sp || 0.14));
    var n = 0;
    stampAt(ctx, b, rgb, pts[0], radius, seed, n, mul);
    var prev = pts[0];
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i];
      var dx = p.x - prev.x, dy = p.y - prev.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-4) continue;
      var steps = Math.max(1, Math.ceil(dist / spacing));
      var r = radius;
      if (b.taper) r = radius * (1 - b.taper * clamp(dist / (radius * 3.4), 0, 1));
      for (var k = 1; k <= steps; k++) {
        var t = k / steps;
        stampAt(ctx, b, rgb, { x: prev.x + dx * t, y: prev.y + dy * t }, r, seed, ++n, mul);
      }
      prev = p;
    }
  }

  /* ============================================================
   *  Pad
   * ============================================================ */
  function Pad(mount, opts) {
    opts = opts || {};
    this.mount = mount;
    this.opts = opts;
    this.onOp = opts.onOp || function () { };
    this.onNotice = opts.onNotice || function () { };

    this.cssW = 0; this.cssH = 0; this.dpr = 1;
    this.enabled = opts.enabled !== false;

    this.layers = [];
    this.activeLayer = 0;
    this.ops = [];
    this.cursor = 0;
    this.seq = 0;

    this.tool = 'pen';                       // pen | erase | smudge | pick | fill | shape
    this.shape = 'line';
    this.brush = 'pencil';                   // 当前笔刷（纹理）

    /* 每种「模式 × 笔刷」各自一套参数 —— 这就是「切换笔刷时粗细/不透明度都不一样」 */
    this.cfg = { pen: {}, erase: {}, smudge: {} };
    this.size = 5; this.opacity = 1; this.strength = 0.7; this.flow = 0.55;

    this.color = opts.color || '#e5533d';
    this.hsv = rgbToHsv(hexToRgb(this.color).r, hexToRgb(this.color).g, hexToRgb(this.color).b);
    this.tolerance = 45;
    this.edge = 1;
    this.shapeFill = false;
    this.recent = [];

    // 视图（缩放/平移）—— 只影响看，不影响存下来的操作
    this.view = { s: 1, x: 0, y: 0 };

    this._live = null;
    this._shapeDrag = null;
    this._drawing = false;
    this._rafPending = false;
    this._panning = false;

    this._buildDom();
    this._bindEvents();
    this._loadCfg();
    this.resize();
  }

  /* ---------------- 参数（按 模式×笔刷 存） ---------------- */
  Pad.prototype._cfgOf = function (mode, brushId) {
    mode = (mode === 'erase' || mode === 'smudge') ? mode : 'pen';
    var b = brushById(brushId);
    var bag = this.cfg[mode] || (this.cfg[mode] = {});
    if (!bag[b.id]) {
      if (mode === 'erase') {
        bag[b.id] = { size: Math.max(18, Math.round(b.defSize * b.sizeMul * 2.2)), opa: 100 };
      } else if (mode === 'smudge') {
        bag[b.id] = { size: Math.max(20, Math.round(b.defSize * b.sizeMul * 1.8)), opa: 100, strength: 70, flow: 55 };
      } else {
        bag[b.id] = { size: Math.max(1, Math.round(b.defSize * b.sizeMul)), opa: b.defOpa };
      }
    }
    return bag[b.id];
  };

  /** 当前的"参数模式"：形状/填色/吸管也算画笔那一套 */
  Pad.prototype._paramMode = function () {
    return (this.tool === 'erase' || this.tool === 'smudge') ? this.tool : 'pen';
  };

  Pad.prototype._loadCfg = function () {
    var c = this._cfgOf(this._paramMode(), this.brush);
    this.size = c.size;
    this.opacity = (c.opa == null ? 100 : c.opa) / 100;
    this.strength = (c.strength == null ? 70 : c.strength) / 100;
    this.flow = (c.flow == null ? 55 : c.flow) / 100;
    this._syncCfgUI();
    this._syncCursor();
  };

  Pad.prototype._saveCfg = function (patch) {
    var c = this._cfgOf(this._paramMode(), this.brush);
    for (var k in patch) if (patch.hasOwnProperty(k)) c[k] = patch[k];
  };

  Pad.prototype._syncCfgUI = function () {
    var c = this._cfgOf(this._paramMode(), this.brush);
    if (this.rowSize) {
      this.rowSize._inp.value = c.size;
      this.rowSize._out.textContent = c.size + 'px';
    }
    if (this.rowOpa) {
      var opa = c.opa == null ? 100 : c.opa;
      this.rowOpa._inp.value = opa;
      this.rowOpa._out.textContent = opa + '%';
    }
    if (this.rowStrength) {
      this.rowStrength._inp.value = c.strength == null ? 70 : c.strength;
      this.rowStrength._out.textContent = (c.strength == null ? 70 : c.strength) + '%';
    }
    if (this.rowFlow) {
      this.rowFlow._inp.value = c.flow == null ? 55 : c.flow;
      this.rowFlow._out.textContent = (c.flow == null ? 55 : c.flow) + '%';
    }
    if (this.cfgHint) {
      var b = brushById(this.brush);
      var mode = MODES.filter(function (m) { return m.id === this._paramMode(); }.bind(this))[0];
      this.cfgHint.textContent = (mode ? mode.label : '画笔') + ' · ' + b.label + '：粗细 ' + c.size +
        'px，不透明度 ' + (c.opa == null ? 100 : c.opa) + '%' +
        ((c.strength != null) ? '，强度 ' + c.strength + '%' : '');
    }
  };

  /* ---------------- DOM ---------------- */
  Pad.prototype._buildDom = function () {
    var self = this;
    var root = mk('div', 'pp-root');

    /* ---- 左侧工具栏 ---- */
    var side = mk('div', 'pp-side');

    /* ===== 笔刷 ===== */
    var secBrush = mk('div', 'pp-sec');
    secBrush.appendChild(mk('h4', null, '笔刷'));

    // 模式：画笔 / 橡皮 / 涂抹（都用当前笔刷）
    var modes = mk('div', 'pp-modes');
    MODES.forEach(function (m) {
      var el = mk('button', 'pp-tool');
      el.title = m.tip;
      el.dataset.mode = m.id;
      el.appendChild(icon(m.icon));
      el.appendChild(mk('span', 'pp-tlabel', m.label));
      el.onclick = function () { self.setTool(m.id); };
      modes.appendChild(el);
    });
    secBrush.appendChild(modes);

    // 笔刷选择：一个大按钮，点开是菜单
    var pickWrap = mk('div', 'pp-bpick-wrap');
    this.brushBtn = mk('button', 'pp-bbtn');
    this.brushBtn.title = '点一下选笔刷（12 种）';
    this.brushBtnIcon = icon('brush');
    this.brushBtnName = mk('span', 'pp-bname', '铅笔');
    var chev = icon('chev', 'pp-chev');
    this.brushBtn.appendChild(this.brushBtnIcon);
    this.brushBtn.appendChild(this.brushBtnName);
    this.brushBtn.appendChild(chev);
    this.brushBtn.onclick = function (e) { e.stopPropagation(); self._toggleBrushMenu(); };

    this.brushMenu = mk('div', 'pp-bmenu');
    this.brushMenu.appendChild(mk('div', 'pp-bmenu-h', '选一个笔刷（下面的线条就是它的效果）'));
    var grid = mk('div', 'pp-bmenu-grid');
    BRUSHES.forEach(function (b) {
      var item = mk('button', 'pp-bitem');
      item.dataset.brush = b.id;
      item.title = b.tip;
      var cv = newCanvas(232, 68);
      cv.className = 'pp-bprev';
      item.appendChild(cv);
      item.appendChild(mk('span', 'pp-bitem-name', b.label));
      item.onclick = function (e) { e.stopPropagation(); self.setBrush(b.id); self._closeBrushMenu(); };
      grid.appendChild(item);
      (self._prevCanvases || (self._prevCanvases = [])).push({ cv: cv, id: b.id });
    });
    this.brushMenu.appendChild(grid);
    pickWrap.appendChild(this.brushBtn);
    pickWrap.appendChild(this.brushMenu);
    secBrush.appendChild(pickWrap);

    // 参数：粗细 / 不透明度 / 强度 / 流量（按 模式×笔刷 独立保存）
    this.rowSize = this._sliderRow('粗细', 1, 90, 5, 'px', function (v) {
      self.size = v; self._saveCfg({ size: v }); self._syncCfgUI(); self._syncCursor();
    });
    secBrush.appendChild(this.rowSize);
    this.rowOpa = this._sliderRow('不透明度', 5, 100, 100, '%', function (v) {
      self.opacity = v / 100; self._saveCfg({ opa: v }); self._syncCfgUI();
    });
    secBrush.appendChild(this.rowOpa);
    this.rowStrength = this._sliderRow('强度', 5, 100, 70, '%', function (v) {
      self.strength = v / 100; self._saveCfg({ strength: v }); self._syncCfgUI();
    });
    secBrush.appendChild(this.rowStrength);
    this.rowFlow = this._sliderRow('流量', 5, 100, 55, '%', function (v) {
      self.flow = v / 100; self._saveCfg({ flow: v }); self._syncCfgUI();
    });
    secBrush.appendChild(this.rowFlow);

    this.cfgHint = mk('div', 'pp-cfghint');
    secBrush.appendChild(this.cfgHint);
    side.appendChild(secBrush);

    /* ===== 颜色 ===== */
    var secColor = mk('div', 'pp-sec');
    secColor.appendChild(mk('h4', null, '颜色'));

    var presets = mk('div', 'pp-presets');
    PRESETS.forEach(function (c) {
      var b = mk('button', 'pp-preset');
      b.style.background = c;
      b.title = c.toUpperCase();
      b.onclick = function () { self.setColor(c); self._pushRecent(c); };
      presets.appendChild(b);
    });
    secColor.appendChild(presets);

    var wheelWrap = mk('div', 'pp-wheelWrap');
    this.wheel = newCanvas(150, 150);
    this.wheel.className = 'pp-wheel';
    wheelWrap.appendChild(this.wheel);
    this.swatch = mk('div', 'pp-swatch');
    wheelWrap.appendChild(this.swatch);
    secColor.appendChild(wheelWrap);

    this.hexLabel = mk('div', 'pp-hex', this.color.toUpperCase());
    secColor.appendChild(this.hexLabel);

    this.recentWrap = mk('div', 'pp-recent');
    secColor.appendChild(this.recentWrap);

    var actRow = mk('div', 'pp-actrow');
    var pickBtn = mk('button', 'pp-tool');
    pickBtn.title = '吸管取色 · 在画布上点一下取那里的颜色';
    pickBtn.dataset.act = 'pick';
    pickBtn.appendChild(icon('pick'));
    pickBtn.appendChild(mk('span', 'pp-tlabel', '吸管'));
    pickBtn.onclick = function () { self.setTool('pick'); };
    this.pickBtn = pickBtn;
    var fillBtn = mk('button', 'pp-tool');
    fillBtn.title = '油漆桶 · 点封闭区域快速上色';
    fillBtn.dataset.act = 'fill';
    fillBtn.appendChild(icon('fill'));
    fillBtn.appendChild(mk('span', 'pp-tlabel', '填色'));
    fillBtn.onclick = function () { self.setTool('fill'); };
    this.fillBtn = fillBtn;
    actRow.appendChild(pickBtn);
    actRow.appendChild(fillBtn);
    secColor.appendChild(actRow);

    this.rowTol = this._sliderRow('容差', 0, 255, this.tolerance, '', function (v) { self.tolerance = v; });
    secColor.appendChild(this.rowTol);
    this.rowEdge = this._sliderRow('边缘扩张', 0, 3, this.edge, 'px', function (v) { self.edge = v; });
    secColor.appendChild(this.rowEdge);
    side.appendChild(secColor);

    /* ===== 形状 ===== */
    var secShape = mk('div', 'pp-sec');
    secShape.appendChild(mk('h4', null, '形状'));
    var shapes = mk('div', 'pp-shapes');
    SHAPES.forEach(function (s) {
      var el = mk('button', 'pp-tool');
      el.title = s.label + ' · 用当前笔刷和颜色描边';
      el.dataset.shape = s.id;
      el.appendChild(icon(s.id));
      el.onclick = function () { self.setTool('shape:' + s.id); };
      shapes.appendChild(el);
    });
    secShape.appendChild(shapes);
    var fillToggle = mk('label', 'pp-check');
    this.shapeFillBox = mk('input');
    this.shapeFillBox.type = 'checkbox';
    this.shapeFillBox.onchange = function () { self.shapeFill = self.shapeFillBox.checked; };
    fillToggle.appendChild(this.shapeFillBox);
    fillToggle.appendChild(mk('span', null, '矩形/圆形/三角形填充'));
    secShape.appendChild(fillToggle);
    side.appendChild(secShape);

    /* ===== 图层 ===== */
    var secLayer = mk('div', 'pp-sec pp-sec-layer');
    var lhead = mk('div', 'pp-lhead');
    this.layerToggle = mk('button', 'pp-fold');
    this.layerToggle.appendChild(icon('layers'));
    this.layerToggle.appendChild(mk('span', null, '图层'));
    this.layerToggle.onclick = function () {
      var folded = secLayer.classList.toggle('folded');
      self.layerToggle.classList.toggle('folded', folded);
    };
    lhead.appendChild(this.layerToggle);
    secLayer.appendChild(lhead);
    this.layerBody = mk('div', 'pp-lbody');
    secLayer.appendChild(this.layerBody);
    side.appendChild(secLayer);

    /* ===== 操作 ===== */
    var secAct = mk('div', 'pp-sec');
    secAct.appendChild(mk('h4', null, '操作'));
    var acts = mk('div', 'pp-acts');
    this.undoBtn = mk('button', 'pp-tool');
    this.undoBtn.title = '撤销上一笔 (Ctrl+Z)';
    this.undoBtn.appendChild(icon('undo'));
    this.undoBtn.onclick = function () { self.undo(); };
    this.redoBtn = mk('button', 'pp-tool');
    this.redoBtn.title = '重做 (Ctrl+Shift+Z)';
    this.redoBtn.appendChild(icon('redo'));
    this.redoBtn.onclick = function () { self.redo(); };
    this.clearBtn = mk('button', 'pp-tool pp-warn');
    this.clearBtn.title = '清空画布（点两次确认）';
    this.clearBtn.appendChild(icon('trash'));
    this.clearBtn.onclick = function () { self._askClear(); };
    acts.appendChild(this.undoBtn);
    acts.appendChild(this.redoBtn);
    acts.appendChild(this.clearBtn);
    secAct.appendChild(acts);
    side.appendChild(secAct);

    /* ---- 中间画布 ---- */
    var main = mk('div', 'pp-main');
    var wrap = mk('div', 'pp-canvas-wrap');
    this.display = newCanvas(640, 480);
    this.display.className = 'pp-canvas';
    wrap.appendChild(this.display);
    this.cursorEl = mk('div', 'pp-cursor');
    this.cursorEl.style.display = 'none';
    wrap.appendChild(this.cursorEl);

    // 左上角：收起/展开左边的工具栏（画的时候想要更大的画布）
    this.sideBtn = mk('button', 'pp-sidebtn');
    this.sideBtn.title = '收起工具栏';
    this.sideBtn.appendChild(icon('brush'));
    this.sideBtn.appendChild(mk('span', 'pp-sidelab', '工具'));
    this.sideBtn.onclick = function (e) { e.stopPropagation(); self.toggleSide(); };
    wrap.appendChild(this.sideBtn);

    // 右下角视图控件（缩放 / 适应 / 全屏）—— 放右下才不会挡住右上角"不许写字"的提示
    var viewbar = mk('div', 'pp-viewbar');
    function vbtn(name, title, fn) {
      var b = mk('button', 'pp-vbtn');
      b.title = title;
      b.appendChild(icon(name));
      b.onclick = fn;
      viewbar.appendChild(b);
      return b;
    }
    vbtn('zout', '缩小（Ctrl + 滚轮）', function () { self.zoomStep(1 / 1.25); });
    this.zoomLabel = mk('span', 'pp-zlabel', '100%');
    viewbar.appendChild(this.zoomLabel);
    vbtn('zin', '放大（Ctrl + 滚轮）', function () { self.zoomStep(1.25); });
    vbtn('fit', '回到 100%', function () { self.fitView(); });
    this.fsBtn = vbtn('expand', '全屏（F 键）', function () { self.toggleFullscreen(); });
    wrap.appendChild(viewbar);

    // 左 / 下两条可拖动的平移条
    var panY = mk('div', 'pp-pan pp-pan-y');
    this.panYThumb = mk('div', 'pp-pan-thumb');
    panY.appendChild(this.panYThumb);
    var panX = mk('div', 'pp-pan pp-pan-x');
    this.panXThumb = mk('div', 'pp-pan-thumb');
    panX.appendChild(this.panXThumb);
    wrap.appendChild(panY);
    wrap.appendChild(panX);
    this.panX = panX; this.panY = panY;

    main.appendChild(wrap);
    root.appendChild(side);
    root.appendChild(main);
    this.mount.innerHTML = '';
    this.mount.appendChild(root);

    this.root = root;
    this.wrap = wrap;
    this.dcv = ctxOf(this.display);

    this._tmp = newCanvas(this.display.width, this.display.height);
    this._flat = newCanvas(this.display.width, this.display.height);
    this.tctx = ctxOf(this._tmp);
    this.fctx = ctxOf(this._flat);
    this.newLayer();
    this._renderWheel();
    this._renderRecent();
    this._renderPresetsState();
    this._renderBrushPreviews();
    this._syncTool();
    this._renderLayers();
    this._syncPans();
  };

  Pad.prototype._sliderRow = function (label, min, max, val, unit, onchange) {
    var row = mk('div', 'pp-row');
    var lab = mk('span', 'pp-lab', label);
    var inp = mk('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.value = val;
    var out = mk('span', 'pp-val', val + unit);
    inp.oninput = function () { out.textContent = inp.value + unit; onchange(Number(inp.value)); };
    row.appendChild(lab); row.appendChild(inp); row.appendChild(out);
    row._out = out; row._inp = inp;
    return row;
  };

  /* ---------------- 笔刷菜单 ---------------- */
  Pad.prototype._toggleBrushMenu = function () {
    var open = this.brushMenu.classList.toggle('open');
    if (!open) return;
    this._renderBrushPreviews();
    this._placeBrushMenu();
  };
  Pad.prototype._closeBrushMenu = function () { this.brushMenu.classList.remove('open'); };

  Pad.prototype._placeBrushMenu = function () {
    var r = this.brushBtn.getBoundingClientRect();
    var w = Math.max(206, Math.min(268, Math.round((this.cssW || 640) * 0.52)));
    var left = clamp(r.left, 8, Math.max(8, window.innerWidth - w - 8));
    this.brushMenu.style.left = left + 'px';
    this.brushMenu.style.width = w + 'px';
    this.brushMenu.style.top = '0px';
    var natural = this.brushMenu.offsetHeight || 320;
    var below = window.innerHeight - r.bottom - 12;
    var above = r.top - 12;
    var useBelow = below >= natural || below >= above;
    var h = Math.max(150, Math.min(natural, useBelow ? below : above));
    this.brushMenu.style.top = (useBelow ? (r.bottom + 6) : Math.max(8, r.top - h - 6)) + 'px';
    this.brushMenu.style.maxHeight = h + 'px';
    this.brushMenu.style.overflow = 'auto';
    this._menuAnchor = { top: r.top, left: r.left };   // 记住锚点，滚走了才自动关
  };

  /** 菜单里每条都用该笔刷画一条波浪线当预览 */
  Pad.prototype._renderBrushPreviews = function () {
    var rgb = hexToRgb(this.color);
    (this._prevCanvases || []).forEach(function (it) {
      var dark = (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) > 200 ? { r: 43, g: 38, b: 32 } : rgb;
      drawBrushPreview(it.cv, brushById(it.id), dark);
    });
  };

  /* ---------------- 尺寸 / 画布 ---------------- */
  Pad.prototype.resize = function () {
    var r = this.wrap.getBoundingClientRect();
    // 隐藏时（切视图的瞬间）rect 是 0，这时候千万别按 0 去重建画布，
    // 否则会得到一张被压扁的图，再显示出来就是"重叠/错位"的来源。
    if (r.width < 8 || r.height < 8) return;
    // 画纸按 4:3 在容器里等比内缩 + 居中，剩下的地方由容器底色当"桌面"
    var availW = Math.max(40, r.width - 2), availH = Math.max(30, r.height - 2);
    var w = availW, h = w / PAGE_AR;
    if (h > availH) { h = availH; w = h * PAGE_AR; }
    w = Math.round(w); h = Math.round(h);
    if (w === this.cssW && h === this.cssH) return;
    var first = !this.cssW;
    this.cssW = w; this.cssH = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    var dw = Math.round(w * this.dpr), dh = Math.round(h * this.dpr);
    this.display.width = dw; this.display.height = dh;
    this.display.style.width = w + 'px';
    this.display.style.height = h + 'px';

    if (first) {
      this.layers.forEach(function (L) { L.cv = newCanvas(dw, dh); L.ctx = ctxOf(L.cv); });
      this._live = null;
    } else if (this.ops.length && this.ops.length <= 900) {
      // 尺寸变了：按操作重放，最精确（不会越缩越糊）
      this._live = null;
      this._rebuild();
    } else {
      // 操作太多就按比例搬过去（保住画面，稍微糊一点）
      this.layers.forEach(function (L) {
        var old = L.cv, nc = newCanvas(dw, dh);
        ctxOf(nc).drawImage(old, 0, 0, dw, dh);
        L.cv = nc; L.ctx = ctxOf(nc);
      });
      if (this._live) {
        var ol = this._live.cv, nl = newCanvas(dw, dh);
        ctxOf(nl).drawImage(ol, 0, 0, dw, dh);
        this._live.cv = nl; this._live.ctx = ctxOf(nl);
      }
    }
    this._flat = newCanvas(dw, dh); this.fctx = ctxOf(this._flat);
    this._tmp = newCanvas(dw, dh); this.tctx = ctxOf(this._tmp);
    this._clampView();
    this._renderLayers();
    this._updateUndo();
    this._syncPans();
    this._schedule();
  };

  Pad.prototype._layerAt = function (i) { return this.layers[i] || this.layers[0]; };

  Pad.prototype.newLayer = function () {
    if (this.layers.length >= MAX_LAYERS) return false;
    var cv = newCanvas(this.display.width || 640, this.display.height || 480);
    this.layers.push({ cv: cv, ctx: ctxOf(cv), name: '图层 ' + (this.layers.length + 1), visible: true, opacity: 1 });
    return true;
  };

  /* ---------------- 渲染 ---------------- */
  Pad.prototype._renderTo = function (ctx, includeLive) {
    var cv = ctx.canvas, W = cv.width, H = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = this.opts.outside || '#e7ddcc';
    ctx.fillRect(0, 0, W, H);

    var v = this.view;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.s, v.s);
    ctx.fillStyle = this.opts.background || '#fffdf7';
    ctx.fillRect(0, 0, W, H);

    var live = includeLive ? this._live : null;
    var self = this;

    for (var i = 0; i < this.layers.length; i++) {
      var L = this.layers[i];
      if (!L.visible) continue;
      var la = (L.opacity == null ? 1 : L.opacity);
      if (la <= 0) continue;
      var isLive = !!live && (i === live.L);

      if (isLive && (live.mode === 'erase' || live.brush === 'eraser')) {
        // 橡皮只擦本层：先拷一份本层，擦完再整体画上去
        self.tctx.setTransform(1, 0, 0, 1, 0, 0);
        self.tctx.globalAlpha = 1;
        self.tctx.globalCompositeOperation = 'source-over';
        self.tctx.clearRect(0, 0, W, H);
        self.tctx.drawImage(L.cv, 0, 0);
        self.tctx.globalCompositeOperation = 'destination-out';
        self.tctx.globalAlpha = live.a;
        self.tctx.drawImage(live.cv, 0, 0);
        self.tctx.globalCompositeOperation = 'source-over';
        self.tctx.globalAlpha = 1;
        ctx.globalAlpha = la;
        ctx.drawImage(self._tmp, 0, 0);
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = la;
        ctx.drawImage(L.cv, 0, 0);
        if (isLive) {
          ctx.globalAlpha = la * live.a;
          ctx.drawImage(live.cv, 0, 0);
        }
        ctx.globalAlpha = 1;
      }
    }

    if (includeLive && this._shapeDrag) this._drawShape(ctx, this._shapeDrag, true);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  };

  Pad.prototype._paint = function () {
    this._renderTo(this.dcv, true);
    if (this.opts.onFrame) this.opts.onFrame();
    this._syncPans();
  };

  Pad.prototype._flatten = function (includeLive) {
    this._renderTo(this.fctx, includeLive !== false);
    return this._flat;
  };

  Pad.prototype._schedule = function () {
    var self = this;
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(function () { self._rafPending = false; self._paint(); });
  };

  /* ---------------- 视图：缩放 / 平移 / 全屏 ---------------- */
  Pad.prototype._clampView = function () {
    var v = this.view, W = this.display.width, H = this.display.height;
    if (v.s >= 1) {
      v.x = clamp(v.x, W * (1 - v.s), 0);
      v.y = clamp(v.y, H * (1 - v.s), 0);
    } else {
      v.x = clamp(v.x, 0, W * (1 - v.s));
      v.y = clamp(v.y, 0, H * (1 - v.s));
    }
  };

  Pad.prototype.zoomStep = function (f) {
    this.zoomAt(f, this.display.width / 2, this.display.height / 2);
  };

  Pad.prototype.zoomAt = function (f, cx, cy) {
    var v = this.view;
    var ns = clamp(v.s * f, 0.4, 8);
    if (Math.abs(ns - v.s) < 1e-6) return;
    var k = ns / v.s;
    v.x = cx - k * (cx - v.x);
    v.y = cy - k * (cy - v.y);
    v.s = ns;
    this._clampView();
    this._updateZoomLabel();
    this._syncPans();
    this._schedule();
  };

  Pad.prototype.panBy = function (dxDev, dyDev) {
    this.view.x += dxDev;
    this.view.y += dyDev;
    this._clampView();
    this._syncPans();
    this._schedule();
  };

  /** 按归一化位置平移（0..1 表示内容上/左边缘对齐视口） */
  Pad.prototype.panTo = function (fx, fy) {
    var v = this.view, W = this.display.width, H = this.display.height;
    fx = clamp(fx, 0, 1); fy = clamp(fy, 0, 1);
    if (v.s >= 1) {
      v.x = -fx * W * (v.s - 1);
      v.y = -fy * H * (v.s - 1);
    }
    this._clampView();
    this._syncPans();
    this._schedule();
  };

  Pad.prototype.fitView = function () {
    this.view.s = 1; this.view.x = 0; this.view.y = 0;
    this._updateZoomLabel();
    this._syncPans();
    this._schedule();
  };

  Pad.prototype._updateZoomLabel = function () {
    if (this.zoomLabel) this.zoomLabel.textContent = Math.round(this.view.s * 100) + '%';
  };

  Pad.prototype._syncPans = function () {
    var v = this.view, W = this.cssW, H = this.cssH;
    if (!W || !H) return;
    var s = v.s;
    if (s <= 1.0001) {
      this.panXThumb.style.width = '100%';
      this.panXThumb.style.left = '0px';
      this.panYThumb.style.height = '100%';
      this.panYThumb.style.top = '0px';
      this.wrap.classList.add('no-pan');
      return;
    }
    this.wrap.classList.remove('no-pan');
    var fr = 1 / s;
    var tw = Math.max(30, W * fr);
    var fx = clamp(-(v.x / this.dpr) / (W * (s - 1)), 0, 1);
    this.panXThumb.style.width = tw + 'px';
    this.panXThumb.style.left = (fx * (W - tw)) + 'px';

    var th = Math.max(30, H * fr);
    var fy = clamp(-(v.y / this.dpr) / (H * (s - 1)), 0, 1);
    this.panYThumb.style.height = th + 'px';
    this.panYThumb.style.top = (fy * (H - th)) + 'px';
  };

  /** 收起 / 展开左边的工具栏 */
  Pad.prototype.toggleSide = function (on) {
    var folded = (on == null) ? !this.root.classList.contains('folded') : !!on;
    this.root.classList.toggle('folded', folded);
    if (this.sideBtn) this.sideBtn.title = folded ? '展开工具栏' : '收起工具栏';
    var self = this;
    setTimeout(function () { self.resize(); }, 0);
  };

  Pad.prototype.toggleFullscreen = function () {
    var el = this.root;
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () { }).call(document);
    } else if (el.requestFullscreen) {
      el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  };

  /* ---------------- 坐标（含视图变换） ---------------- */
  Pad.prototype._pt = function (ev) {
    var r = this.display.getBoundingClientRect();
    var sx = this.display.width / Math.max(1, r.width), sy = this.display.height / Math.max(1, r.height);
    var dx = (ev.clientX - r.left) * sx, dy = (ev.clientY - r.top) * sy;
    var v = this.view;
    return {
      x: clamp((dx - v.x) / v.s / this.display.width, -0.4, 1.4),
      y: clamp((dy - v.y) / v.s / this.display.height, -0.4, 1.4)
    };
  };
  Pad.prototype._ptDev = function (ev) {
    var p = this._pt(ev);
    return { x: p.x * this.display.width, y: p.y * this.display.height, nx: p.x, ny: p.y };
  };
  /** 光标是容器的子元素，所以按容器定位（画布在容器里是居中的） */
  Pad.prototype._ptCss = function (ev) {
    var wr = this.wrap.getBoundingClientRect();
    return { x: ev.clientX - wr.left - 1, y: ev.clientY - wr.top - 1 };
  };

  Pad.prototype._radiusDev = function (op) {
    var wN = (op && op.w != null) ? op.w : ((this.size / Math.max(1, this.cssW)) / this.view.s);
    return Math.max(0.5, (wN * this.display.width) / 2);
  };

  /* ---------------- 应用操作 ---------------- */
  Pad.prototype.applyOp = function (op, fromLocal) {
    if (!op || !op.k) return;
    switch (op.k) {
      case 'seg': this._applySeg(op); break;
      case 'sege': this._commitLive(); break;
      case 'shape': this._applyShape(op); break;
      case 'fill': this._applyFill(op); break;
      case 'clr': this._clearLayer(op.L, true); break;
      case 'ladd': this._applyLayerAdd(op); break;
      case 'ldel': this._applyLayerDel(op); break;
      case 'lvis': this._applyLayerVis(op); break;
      case 'lopa': this._applyLayerOpa(op); break;
      default: return;
    }
    if (!fromLocal) this._schedule();
  };

  /* 老版本的操作里 b 是笔刷名（pencil/marker/eraser/smudge），
     新版本拆成：m = 模式（pen/erase/smudge），z = 笔刷 id。这里做兼容。 */
  function segMode(op) {
    if (op.m) return op.m;
    if (op.brush === 'eraser' || op.b === 'eraser') return 'erase';
    if (op.brush === 'smudge' || op.b === 'smudge') return 'smudge';
    return 'pen';
  }
  function segBrush(op) {
    var z = op.z || op.brush;
    if (z && z !== 'eraser' && z !== 'smudge') return z;
    return 'pencil';
  }

  Pad.prototype._applySeg = function (op) {
    var mode = segMode(op);
    var bid = segBrush(op);
    var live = this._beginLive(op.S != null ? op.S : 'x', mode, bid, op.a != null ? op.a : 1, op.c || this.color, op.L);
    live.wN = op.w;
    var W = this.display.width, H = this.display.height;
    var pts = [{ x: op.px * W, y: op.py * H }, { x: op.x * W, y: op.y * H }];
    var r = this._radiusDev(op);
    var seed = hashStr((op.S || 'x') + bid);
    if (mode === 'smudge') this._smudgeTo(live, pts, bid);
    else if (mode === 'erase') strokePath(live.ctx, brushById(bid), { r: 0, g: 0, b: 0 }, pts, r, seed);
    else strokePath(live.ctx, brushById(bid), hexToRgb(op.c || this.color), pts, r, seed);
  };

  Pad.prototype._applyShape = function (op) {
    var L = this._layerAt(op.L);
    L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._drawShape(L.ctx, op, false);
  };

  /* ---------------- 形状：用当前笔刷描边 ---------------- */
  /** 把形状拆成若干条折线（设备坐标） */
  function shapePaths(sh, W, H) {
    var x0 = sh.x0 * W, y0 = sh.y0 * H, x1 = sh.x1 * W, y1 = sh.y1 * H, i;
    if (sh.s === 'line') return [[{ x: x0, y: y0 }, { x: x1, y: y1 }]];
    if (sh.s === 'rect') return [[
      { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }
    ]];
    if (sh.s === 'ellipse') {
      var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
      var pts = [];
      var n = Math.max(24, Math.ceil((rx + ry) / 3));
      for (i = 0; i <= n; i++) {
        var a = i / n * Math.PI * 2;
        pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
      }
      return [pts];
    }
    if (sh.s === 'triangle') return [[
      { x: (x0 + x1) / 2, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: (x0 + x1) / 2, y: y0 }
    ]];
    if (sh.s === 'arc') {
      // 弧线：包住包围盒，从左上到右上向上拱一道。用二次贝塞尔采样成折线，
      // 这样任意笔刷（铅笔/马克笔/炭笔…）描出来的手感都和直线一致。
      var a0x = x0, a0y = y1, a1x = x1, a1y = y1, ccx = (x0 + x1) / 2, ccy = y0;
      var arc = [];
      for (var k = 0; k <= 18; k++) {
        var t = k / 18, mt = 1 - t;
        arc.push({
          x: mt * mt * a0x + 2 * mt * t * ccx + t * t * a1x,
          y: mt * mt * a0y + 2 * mt * t * ccy + t * t * a1y
        });
      }
      return [arc];
    }
    // arrow
    var ang = Math.atan2(y1 - y0, x1 - x0);
    var head = Math.max(Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) * 0.24, 8);
    return [
      [{ x: x0, y: y0 }, { x: x1, y: y1 }],
      [{ x: x1, y: y1 }, { x: x1 - head * Math.cos(ang - 0.45), y: y1 - head * Math.sin(ang - 0.45) }],
      [{ x: x1, y: y1 }, { x: x1 - head * Math.cos(ang + 0.45), y: y1 - head * Math.sin(ang + 0.45) }]
    ];
  }

  Pad.prototype._drawShape = function (ctx, sh, preview) {
    var W = this.display.width, H = this.display.height;
    var s = Math.max(0.6, (sh.w || 0.01) * W);
    var rgb = hexToRgb(sh.c);
    var bid = sh.z || sh.brush || 'pencil';
    if (bid === 'eraser' || bid === 'smudge') bid = 'pencil';
    var b = brushById(bid);
    var paths = shapePaths(sh, W, H);

    ctx.save();
    var alpha = sh.a != null ? sh.a : 1;
    var seed = hashStr('shape' + (sh.s || 'line') + bid + Math.round(sh.x0 * 1000) + Math.round(sh.y0 * 1000));

    // 填充先铺底：**和描边同一个颜色、同一个不透明度**
    // （以前这里是 alpha * 0.9，填充比边框淡一档，看起来"里面的颜色和边框不一样"）
    if (sh.f && (sh.s === 'rect' || sh.s === 'ellipse' || sh.s === 'triangle')) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = sh.c;
      if (sh.s === 'rect') {
        var rx = Math.min(sh.x0, sh.x1) * W, ry = Math.min(sh.y0, sh.y1) * H;
        ctx.fillRect(rx, ry, Math.abs(sh.x1 - sh.x0) * W, Math.abs(sh.y1 - sh.y0) * H);
      } else if (sh.s === 'triangle') {
        var tp = shapePaths({ s: 'triangle', x0: sh.x0, y0: sh.y0, x1: sh.x1, y1: sh.y1 }, W, H)[0];
        ctx.beginPath();
        ctx.moveTo(tp[0].x, tp[0].y);
        for (var ti = 1; ti < tp.length; ti++) ctx.lineTo(tp[ti].x, tp[ti].y);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse((sh.x0 + sh.x1) / 2 * W, (sh.y0 + sh.y1) / 2 * H,
          Math.abs(sh.x1 - sh.x0) * W / 2, Math.abs(sh.y1 - sh.y0) * H / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = alpha;
    for (var i = 0; i < paths.length; i++) {
      strokePath(ctx, b, rgb, paths[i], s / 2, seed + i * 131);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* ---------------- 笔画缓冲 ---------------- */
  Pad.prototype._beginLive = function (S, mode, brushId, alpha, color, layerIdx) {
    if (this._live && this._live.S === S) return this._live;
    this._commitLive();
    var cv = newCanvas(this.display.width, this.display.height);
    var L = (layerIdx == null) ? this.activeLayer : layerIdx;
    this._live = {
      S: S, mode: mode, brush: brushId, a: alpha, c: color, cv: cv, ctx: ctxOf(cv),
      L: clamp(L, 0, this.layers.length - 1), sm: null
    };
    return this._live;
  };

  Pad.prototype._commitLive = function () {
    var live = this._live;
    if (!live) return;
    var L = this.layers[live.L] || this._layerAt(this.activeLayer);
    L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    L.ctx.globalAlpha = live.a;
    L.ctx.globalCompositeOperation = (live.mode === 'erase' || live.brush === 'eraser') ? 'destination-out' : 'source-over';
    L.ctx.drawImage(live.cv, 0, 0);
    L.ctx.globalCompositeOperation = 'source-over';
    L.ctx.globalAlpha = 1;
    this._live = null;
  };

  /* ---------------- 涂抹（按 Procreate 思路） ----------------
   * 手上带一坨颜色（load），沿笔画一路"推"过去：
   *   ① 先把手上的颜色按「强度」盖到画面上；
   *   ② 再从"含本次笔迹的合成图"上按「流量」蘸一点补进手里。
   * 笔刷的硬度和颗粒决定 mask 的样子，所以不同笔刷抹出来手感不一样。
   */
  Pad.prototype._smudgeTo = function (live, pts, brushId) {
    var b = brushById(brushId);
    var r = Math.max(2, this._radiusDev({ w: live.wN }));
    var rad = Math.ceil(r) + 1;
    var d = rad * 2;
    var mask = makeStamp({ id: 'sm' + b.id, hard: b.hard, grain: b.grain, square: b.square }, rad - 1, { r: 0, g: 0, b: 0 });

    if (!live.sm) {
      var first = newCanvas(d, d), fx = ctxOf(first);
      var src0 = this._flatten(true);
      fx.drawImage(src0, pts[0].x - rad, pts[0].y - rad, d, d, 0, 0, d, d);
      fx.globalCompositeOperation = 'destination-in';
      fx.drawImage(mask, 0, 0, d, d);
      fx.globalCompositeOperation = 'source-over';
      live.sm = { load: first, rad: rad, d: d };
    }
    var sm = live.sm;
    if (sm.rad !== rad) { sm.rad = rad; sm.d = rad * 2; }

    var dist = Math.sqrt((pts[1].x - pts[0].x) * (pts[1].x - pts[0].x) + (pts[1].y - pts[0].y) * (pts[1].y - pts[0].y));
    var steps = Math.max(1, Math.min(24, Math.ceil(dist / Math.max(1, r * 0.3))));
    var loadCtx = ctxOf(sm.load);
    var tmp = this._smudgeTmp && this._smudgeTmp.width === d ? this._smudgeTmp : (this._smudgeTmp = newCanvas(d, d));
    var tctx = ctxOf(tmp);
    var snap = null;

    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      var px = pts[0].x + (pts[1].x - pts[0].x) * t, py = pts[0].y + (pts[1].y - pts[0].y) * t;

      // ① 盖上手上的颜色
      live.ctx.globalAlpha = this.strength;
      live.ctx.drawImage(sm.load, px - sm.rad, py - sm.rad, sm.d, sm.d);
      live.ctx.globalAlpha = 1;

      // ② 蘸一点回来混进手里
      if (!snap) snap = this._flatten(true);
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = 'source-over';
      tctx.clearRect(0, 0, sm.d, sm.d);
      tctx.drawImage(snap, px - sm.rad, py - sm.rad, sm.d, sm.d, 0, 0, sm.d, sm.d);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(mask, 0, 0, sm.d, sm.d);
      tctx.globalCompositeOperation = 'source-over';

      loadCtx.globalAlpha = this.flow;
      loadCtx.drawImage(tmp, 0, 0);
      loadCtx.globalAlpha = 1;
    }
  };

  /* ---------------- 油漆桶 / 扫描线种子填充 ----------------
   * ★ 关键：在两个客户端上必须算出**同一块区域**。
   *   大家的画布尺寸不一样（窗口大小不同），如果各按自己的分辨率做漫水填充，
   *   一条 4px 的线在 946 宽下是闭合的、在 696 宽下可能被抗锯齿切出一个缝，
   *   点还可能正好落在线上——于是画者填得好好的，猜者那边就填花了。
   *   做法：统一按「逻辑分辨率」把画面重采样一次再算，然后把 mask 放大回去。
   */
  /**
   * 计算填色遮罩时的上限（**逻辑像素 / CSS 像素**，不是设备像素）。
   *
   * 为什么必须按逻辑分辨率算：画布位图大小 = CSS 尺寸 × devicePixelRatio，
   * 而窗口一全屏、CSS 尺寸又会变大。以前这里用的是**设备像素**、上限还卡在 512，
   * 于是同一个点击在不同窗口大小 / 不同 dpr 下会得到**不同的填色范围**：
   *   全屏后重采样压得更狠，细线被"糊"掉 → 漫水填充从缝里漏出去，整片区域变大，
   *   看起来就和实际线条错位；同时下面的"边缘扩张"是按遮罩像素膨胀的，也跟着忽大忽小。
   * 按逻辑分辨率算之后，线宽在遮罩里始终等于它在画纸上的 CSS 像素宽，
   * 画者/猜者、不同窗口大小算出来的填色范围也就一致了。
   */
  var FILL_REF = 1280;

  /** 起点微调：在点击处附近取"出现最多的颜色"，再从最近的地方起填。
   *  这样即使点偏一点点压在线上，也能填到该填的区域里。 */
  function pickSeed(data, w, h, x, y) {
    var R = 3, i, dx, dy, xx, yy;
    var counts = {}, order = [], best = null;
    for (dy = -R; dy <= R; dy++) {
      for (dx = -R; dx <= R; dx++) {
        xx = clamp(x + dx, 0, w - 1); yy = clamp(y + dy, 0, h - 1);
        i = (yy * w + xx) * 4;
        var key = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4) + ',' + (data[i + 3] >> 5);
        counts[key] = (counts[key] || 0) + 1;
        if (best === null || counts[key] > counts[best]) best = key;
        order.push({ x: xx, y: yy, k: key, d: dx * dx + dy * dy });
      }
    }
    var cand = order.filter(function (o) { return o.k === best; })
      .sort(function (a, b) { return a.d - b.d; });
    return cand.length ? cand[0] : { x: x, y: y };
  }

  Pad.prototype._applyFill = function (op) {
    var W = this.display.width, H = this.display.height;
    var src = this._flatten(false);
    var tol = op.tol == null ? 45 : op.tol;
    var edge = op.e == null ? this.edge : op.e;

    // 按逻辑（CSS）分辨率算遮罩：这样"窗口多大 / dpr 多少"都不影响填出来的范围。
    // 注意 W 是设备像素，要除掉 dpr 才是画纸在屏幕上看起来的大小。
    var cssW = Math.max(1, Math.round(this.cssW || (W / (this.dpr || 1))));
    var rw = Math.min(FILL_REF, Math.max(16, cssW));
    var rh = Math.max(8, Math.round(rw * H / Math.max(1, W)));
    var small = newCanvas(rw, rh), sctx = ctxOf(small);
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(src, 0, 0, rw, rh);
    var sd = sctx.getImageData(0, 0, rw, rh).data;

    var sx = Math.floor(clamp(op.x, 0, 1) * (rw - 1));
    var sy = Math.floor(clamp(op.y, 0, 1) * (rh - 1));
    var seed = pickSeed(sd, rw, rh, sx, sy);
    var res = floodFill(sd, rw, rh, seed.x, seed.y, tol);
    if (!res.count) return;
    if (res.count > rw * rh * 0.85) this.onNotice('这一片没有封闭起来，整张都填上了', 'warn');
    // 「边缘扩张」是画纸上的像素：遮罩被重采样过就要按比例换算，
    // 否则同一个设置在全屏前后扩张出来的宽度不一样（看起来就是填色范围忽大忽小）
    var dil = Math.round(clamp(edge, 0, 6) * (rw / cssW));
    if (dil > 0) dilate(res.mask, rw, rh, dil);

    var mask = newCanvas(rw, rh), mctx = ctxOf(mask);
    var id = mctx.createImageData(rw, rh);
    var rgb = hexToRgb(op.c);
    var d = id.data;
    for (var i = 0; i < rw * rh; i++) {
      if (!res.mask[i]) continue;
      var o = i * 4;
      d[o] = rgb.r; d[o + 1] = rgb.g; d[o + 2] = rgb.b; d[o + 3] = 255;
    }
    mctx.putImageData(id, 0, 0);

    var target = this._layerAt(op.L);
    target.ctx.setTransform(1, 0, 0, 1, 0, 0);
    target.ctx.globalAlpha = op.a == null ? 1 : op.a;
    target.ctx.globalCompositeOperation = 'source-over';
    // 不插值：填出来的边要跟"边缘扩张"设置一致，选 0 就是硬边，
    // 插值会凭空糊出一圈半透明的边，看起来像没生效
    target.ctx.imageSmoothingEnabled = false;
    target.ctx.drawImage(mask, 0, 0, W, H);
    target.ctx.globalAlpha = 1;
  };

  function floodFill(data, w, h, sx, sy, tol) {
    var mask = new Uint8Array(w * h);
    var si = (sy * w + sx) * 4;
    var sr = data[si], sg = data[si + 1], sb = data[si + 2], sa = data[si + 3];
    function ok(x, y) {
      var i = (y * w + x) * 4;
      return Math.abs(data[i] - sr) <= tol && Math.abs(data[i + 1] - sg) <= tol &&
        Math.abs(data[i + 2] - sb) <= tol && Math.abs(data[i + 3] - sa) <= tol;
    }
    if (!ok(sx, sy)) return { mask: mask, count: 0 };
    var stack = [sx, sy], count = 0;
    while (stack.length) {
      var y = stack.pop(), x = stack.pop();
      if (mask[y * w + x]) continue;
      var xl = x;
      while (xl > 0 && !mask[y * w + xl - 1] && ok(xl - 1, y)) xl--;
      var xr = x;
      while (xr < w - 1 && !mask[y * w + xr + 1] && ok(xr + 1, y)) xr++;
      for (var i = xl; i <= xr; i++) {
        mask[y * w + i] = 1; count++;
        if (y > 0 && !mask[(y - 1) * w + i] && ok(i, y - 1)) stack.push(i, y - 1);
        if (y < h - 1 && !mask[(y + 1) * w + i] && ok(i, y + 1)) stack.push(i, y + 1);
      }
    }
    return { mask: mask, count: count };
  }

  function dilate(mask, w, h, n) {
    for (var k = 0; k < n; k++) {
      var add = [];
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var i = y * w + x;
          if (mask[i]) continue;
          if ((x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) ||
            (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) add.push(i);
        }
      }
      for (var j = 0; j < add.length; j++) mask[add[j]] = 1;
      if (!add.length) break;
    }
  }

  /* ---------------- 图层操作 ---------------- */
  Pad.prototype._applyLayerAdd = function () {
    if (this.layers.length >= MAX_LAYERS) return;
    this.newLayer();
    this.activeLayer = this.layers.length - 1;
    this._renderLayers();
  };
  Pad.prototype._applyLayerDel = function (op) {
    if (this.layers.length <= 1) return;
    var i = op.L;
    if (i < 0 || i >= this.layers.length) return;
    this.layers.splice(i, 1);
    this.activeLayer = clamp(this.activeLayer, 0, this.layers.length - 1);
    this._renderLayers();
  };
  Pad.prototype._applyLayerVis = function (op) {
    var L = this.layers[op.L];
    if (L) L.visible = !!op.v;
    this._renderLayers();
  };
  Pad.prototype._applyLayerOpa = function (op) {
    var L = this.layers[op.L];
    if (L) L.opacity = clamp(op.v == null ? 1 : op.v, 0, 1);
    this._renderLayers();
  };
  Pad.prototype._clearLayer = function (i, silent) {
    var L = this.layers[i];
    if (!L) return;
    L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    L.ctx.globalAlpha = 1;
    L.ctx.globalCompositeOperation = 'source-over';
    L.ctx.clearRect(0, 0, L.cv.width, L.cv.height);
    if (!silent) this._renderLayers();
  };

  Pad.prototype._renderLayers = function () {
    var self = this;
    this.layerBody.innerHTML = '';
    for (var i = this.layers.length - 1; i >= 0; i--) {
      (function (idx) {
        var L = self.layers[idx];
        var card = mk('div', 'pp-layer' + (idx === self.activeLayer ? ' on' : ''));

        var head = mk('div', 'pp-layer-head');
        var eye = mk('button', 'pp-eye' + (L.visible ? ' on' : ''));
        eye.title = L.visible ? '隐藏这一层' : '显示这一层';
        eye.appendChild(icon(L.visible ? 'eye' : 'eyeoff'));
        eye.onclick = function (e) {
          e.stopPropagation();
          self.localOp({ k: 'lvis', L: idx, v: L.visible ? 0 : 1 });
        };
        head.appendChild(eye);
        head.appendChild(mk('span', 'pp-lname', L.name));
        if (self.layers.length > 1) {
          var del = mk('button', 'pp-ldel');
          del.title = '删掉这一层';
          del.appendChild(icon('trash'));
          del.onclick = function (e) {
            e.stopPropagation();
            self.localOp({ k: 'ldel', L: idx });
          };
          head.appendChild(del);
        }
        card.appendChild(head);

        var orow = mk('div', 'pp-opa');
        orow.appendChild(mk('span', 'pp-opa-lab', '透明度'));
        var rin = mk('input');
        rin.type = 'range'; rin.min = 5; rin.max = 100;
        rin.value = Math.round((L.opacity == null ? 1 : L.opacity) * 100);
        var rout = mk('span', 'pp-opa-val', rin.value + '%');
        rin.oninput = function () {
          rout.textContent = rin.value + '%';
          self.localOp({ k: 'lopa', L: idx, v: Number(rin.value) / 100 });
        };
        rin.onclick = function (e) { e.stopPropagation(); };
        orow.appendChild(rin); orow.appendChild(rout);
        card.appendChild(orow);

        card.onclick = function () { self.activeLayer = idx; self._renderLayers(); };
        self.layerBody.appendChild(card);
      })(i);
    }
    if (this.layers.length < MAX_LAYERS) {
      var add = mk('button', 'pp-btn pp-ladd');
      add.appendChild(icon('plus'));
      add.appendChild(mk('span', null, '新增图层'));
      add.onclick = function () { self.localOp({ k: 'ladd' }); };
      this.layerBody.appendChild(add);
    }
  };

  /* ---------------- 撤销 / 重做 ---------------- */
  Pad.prototype.localOp = function (op) {
    if (!this.enabled) return;
    this._pushHistory(op);
    this.applyOp(op, true);
    this._schedule();
    this._updateUndo();
    this.onOp(op);
  };

  Pad.prototype._pushHistory = function (op) {
    if (this.cursor < this.ops.length) this.ops = this.ops.slice(0, this.cursor);
    // 裁剪规则必须和服务端一模一样，否则操作数对不上，撤销就会错位
    if (this.ops.length >= OP_LIMIT) this.ops.shift();
    this.ops.push(op);
    this.cursor = this.ops.length;
    this._redoGroups = [];        // 有新操作就作废重做栈
  };

  /** 从 cursor 往前数「一整笔」有几条 op（一笔 = 若干 seg + 收尾的 sege） */
  Pad.prototype._groupSizeAt = function (cursor) {
    if (cursor <= 0) return 0;
    var last = this.ops[cursor - 1];
    var n = 1;
    if (last && last.k === 'sege') {
      while (cursor - n - 1 >= 0) {
        var p = this.ops[cursor - n - 1];
        if (p.k === 'seg' && p.S === last.S) n++; else break;
      }
    }
    return n;
  };

  Pad.prototype.undo = function () {
    if (!this.enabled) return;
    if (this.opts.onUndo) { this.opts.onUndo(); return; }   // 交给服务端拍板
    if (this.cursor <= 0) return;
    // ★ 必须按「一整笔」回退。只退掉收尾的 sege 的话，那些 seg 会被笔画缓冲
    //   重新提交，画面上看起来就是「撤销没反应」。
    var n = this._groupSizeAt(this.cursor);
    if (!n) return;
    this._redoGroups = this._redoGroups || [];
    this._redoGroups.push(n);
    this.cursor -= n;
    this._rebuild(); this._updateUndo();
  };
  Pad.prototype.redo = function () {
    if (!this.enabled) return;
    if (this.opts.onRedo) { this.opts.onRedo(); return; }
    this._redoGroups = this._redoGroups || [];
    if (!this._redoGroups.length) return;
    var n = this._redoGroups.pop();
    this.cursor = Math.min(this.ops.length, this.cursor + n);
    this._rebuild(); this._updateUndo();
  };

  Pad.prototype.truncate = function (n) {
    n = Math.max(0, Math.min(this.ops.length, n | 0));
    if (n === this.cursor) return;
    this.cursor = n; this._rebuild(); this._updateUndo();
  };

  Pad.prototype._rebuild = function () {
    this.layers = [];
    this.activeLayer = 0;
    this._live = null;
    this.newLayer();
    for (var i = 0; i < this.cursor; i++) {
      var op = this.ops[i];
      if (op.k === 'ladd') this._applyLayerAdd();
      else if (op.k === 'ldel') this._applyLayerDel(op);
      else if (op.k === 'lvis') this._applyLayerVis(op);
      else if (op.k === 'lopa') this._applyLayerOpa(op);
      else this.applyOp(op, true);
    }
    this._commitLive();
    this._renderLayers();
    this._schedule();
  };

  Pad.prototype._updateUndo = function () {
    if (this.undoBtn) this.undoBtn.disabled = this.cursor <= 0;
    if (this.redoBtn) this.redoBtn.disabled = this.cursor >= this.ops.length;
  };

  /* ---------------- 清空（二次确认） ---------------- */
  Pad.prototype._askClear = function () {
    var self = this;
    if (!this.enabled) return;
    if (this._clearArmed) {
      this._clearArmed = false;
      this.clearBtn.classList.remove('arming');
      this.clearBtn.title = '清空画布（点两次确认）';
      this.clearAll();
      return;
    }
    this._clearArmed = true;
    this.clearBtn.classList.add('arming');
    this.clearBtn.title = '再点一次就真的清空';
    this.onNotice('再点一次「清空」就会清掉整个画布', 'warn');
    clearTimeout(this._clearTimer);
    this._clearTimer = setTimeout(function () {
      self._clearArmed = false;
      self.clearBtn.classList.remove('arming');
      self.clearBtn.title = '清空画布（点两次确认）';
    }, 3000);
  };

  Pad.prototype.clearAll = function () {
    var n = this.layers.length;
    for (var i = 0; i < n; i++) this.localOp({ k: 'clr', L: i });
  };
  Pad.prototype.clear = function () { this.localOp({ k: 'clr', L: this.activeLayer }); };

  /* ---------------- 工具切换 ---------------- */
  Pad.prototype.setTool = function (t) {
    if (!t) return;
    // 兼容老写法
    if (t === 'pencil' || t === 'marker') { this.brush = t; t = 'pen'; }
    else if (t === 'eraser') t = 'erase';
    else if (t === 'smudge') t = 'smudge';

    if (t.indexOf('shape:') === 0) {
      this.shape = t.slice(6);
      this.tool = 'shape';
    } else if (t === 'pen' || t === 'erase' || t === 'smudge' || t === 'fill' || t === 'pick') {
      this.tool = t;
      if (t !== 'pick') this._lastBrushTool = t;
    } else {
      this.tool = 'pen';
    }
    this._loadCfg();
    this._syncTool();
  };

  Pad.prototype.setBrush = function (id) {
    this.brush = brushById(id).id;
    this._loadCfg();
    this._syncTool();
  };

  Pad.prototype.setColor = function (hex) {
    this.color = hex;
    this.hsv = rgbToHsv(hexToRgb(hex).r, hexToRgb(hex).g, hexToRgb(hex).b);
    this._renderWheel();
    this._renderPresetsState();
    this._renderBrushPreviews();
    this._syncTool();
  };

  Pad.prototype._renderPresetsState = function () {
    var cur = String(this.color).toLowerCase();
    Array.prototype.forEach.call(this.root.querySelectorAll('.pp-preset'), function (b) {
      var own = String(b.title || '').toLowerCase();
      b.classList.toggle('on', own === cur);
    });
  };

  Pad.prototype._syncTool = function () {
    var self = this, t = this.tool;

    Array.prototype.forEach.call(this.root.querySelectorAll('.pp-tool[data-mode]'), function (b) {
      b.classList.toggle('on', b.dataset.mode === t);
    });
    Array.prototype.forEach.call(this.root.querySelectorAll('.pp-tool[data-shape]'), function (b) {
      b.classList.toggle('on', t === 'shape' && b.dataset.shape === self.shape);
    });
    if (this.pickBtn) this.pickBtn.classList.toggle('on', t === 'pick');
    if (this.fillBtn) this.fillBtn.classList.toggle('on', t === 'fill');

    var b = brushById(this.brush);
    if (this.brushBtnName) this.brushBtnName.textContent = b.label;
    if (this.brushMenu) {
      Array.prototype.forEach.call(this.brushMenu.querySelectorAll('.pp-bitem'), function (el) {
        el.classList.toggle('on', el.dataset.brush === b.id);
      });
    }

    this.swatch.style.background = this.color;
    this.hexLabel.textContent = String(this.color).toUpperCase();

    // 参数滑杆按当前模式显示：涂抹要强度/流量，填色要容差/边缘
    var pm = this._paramMode();
    this.rowSize.style.display = (t === 'fill' || t === 'pick') ? 'none' : '';
    this.rowOpa.style.display = (t === 'fill' || t === 'pick' || pm === 'smudge') ? 'none' : '';
    this.rowStrength.style.display = (t === 'smudge') ? '' : 'none';
    this.rowFlow.style.display = (t === 'smudge') ? '' : 'none';
    var fillish = (t === 'fill');
    this.rowTol.style.display = fillish ? '' : 'none';
    this.rowEdge.style.display = fillish ? '' : 'none';
    if (this.cfgHint) this.cfgHint.style.display = (t === 'fill' || t === 'pick') ? 'none' : '';

    this._syncCfgUI();
    this._syncCursor();
  };

  Pad.prototype._renderRecent = function () {
    var self = this;
    this.recentWrap.innerHTML = '';
    if (!this.recent.length) return;
    this.recentWrap.appendChild(mk('span', 'pp-mini', '最近'));
    this.recent.forEach(function (c) {
      var b = mk('button', 'pp-recent-dot');
      b.style.background = c;
      b.title = c.toUpperCase();
      b.onclick = function () { self.setColor(c); };
      self.recentWrap.appendChild(b);
    });
  };

  Pad.prototype._pushRecent = function (hex) {
    var i = this.recent.indexOf(hex);
    if (i >= 0) this.recent.splice(i, 1);
    this.recent.unshift(hex);
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
    this._renderRecent();
  };

  /* ---------------- 色环 ---------------- */
  Pad.prototype._renderWheel = function () {
    var c = this.wheel, x = ctxOf(c);
    var W = c.width, H = c.height, cx = W / 2, cy = H / 2;
    var R = W / 2 - 2, r = R - 12;
    var id = x.createImageData(W, H), d = id.data;
    for (var y = 0; y < H; y++) {
      for (var xx = 0; xx < W; xx++) {
        var dx = xx - cx, dy = y - cy, dist = Math.sqrt(dx * dx + dy * dy);
        var o = (y * W + xx) * 4;
        if (dist > R) continue;
        if (dist >= r) {
          var hue = Math.atan2(dy, dx) * 180 / Math.PI;
          if (hue < 0) hue += 360;
          var rgb = hsvToRgb(hue, 1, 1);
          d[o] = rgb.r; d[o + 1] = rgb.g; d[o + 2] = rgb.b; d[o + 3] = 255;
        } else if (Math.abs(dx) <= r * 0.707 && Math.abs(dy) <= r * 0.707) {
          var s = (dx + r * 0.707) / (r * 1.414);
          var v = 1 - (dy + r * 0.707) / (r * 1.414);
          var rg = hsvToRgb(this.hsv.h, clamp(s, 0, 1), clamp(v, 0, 1));
          d[o] = rg.r; d[o + 1] = rg.g; d[o + 2] = rg.b; d[o + 3] = 255;
        }
      }
    }
    x.putImageData(id, 0, 0);
    var ha = this.hsv.h * Math.PI / 180;
    x.beginPath();
    x.arc(cx + Math.cos(ha) * (r + 6), cy + Math.sin(ha) * (r + 6), 5.5, 0, Math.PI * 2);
    x.lineWidth = 2.4; x.strokeStyle = '#fff'; x.stroke();
    x.lineWidth = 1.2; x.strokeStyle = '#3b3227'; x.stroke();
    var half = r * 0.707;
    var mx = cx - half + this.hsv.s * half * 2;
    var my = cy - half + (1 - this.hsv.v) * half * 2;
    x.beginPath(); x.arc(mx, my, 5, 0, Math.PI * 2);
    x.lineWidth = 2.4; x.strokeStyle = '#fff'; x.stroke();
    x.lineWidth = 1.2; x.strokeStyle = '#3b3227'; x.stroke();
  };

  /* ---------------- 光标 ---------------- */
  Pad.prototype._syncCursor = function () {
    var d = Math.max(6, this.size);
    var el = this.cursorEl;
    el.style.width = d + 'px';
    el.style.height = d + 'px';
    el.className = 'pp-cursor';
    var t = this.tool;
    if (t === 'erase') el.classList.add('erase');
    else if (t === 'smudge') el.classList.add('smudge');
    else if (t === 'pick' || t === 'fill') el.classList.add('tool');
    else el.classList.add('pencil');
    if (t === 'pen') el.style.borderColor = this.color;
    else el.style.borderColor = '';
    el.style.marginLeft = (-d / 2) + 'px';
    el.style.marginTop = (-d / 2) + 'px';
  };

  Pad.prototype._moveCursor = function (ev) {
    if (!this.enabled) { this.cursorEl.style.display = 'none'; return; }
    var p = this._ptCss(ev);
    this.cursorEl.style.display = '';
    this.cursorEl.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
    this._syncCursor();
  };

  /* ---------------- 事件 ---------------- */
  Pad.prototype._bindEvents = function () {
    var self = this;
    var cv = this.display;
    var wrap = this.wrap;

    cv.addEventListener('pointerdown', function (ev) {
      if (!self.enabled) return;
      if (self._panning || ev.button === 1) return;
      ev.preventDefault();
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      self._onDown(ev);
    });
    cv.addEventListener('pointermove', function (ev) {
      self._moveCursor(ev);
      if (!self.enabled || !self._drawing) return;
      ev.preventDefault();
      self._onMove(ev);
    });
    cv.addEventListener('pointerup', function (ev) {
      self.cursorEl.style.display = 'none';
      if (!self.enabled) return;
      self._onUp(ev);
    });
    cv.addEventListener('pointercancel', function () { self._onUp(); });
    cv.addEventListener('pointerleave', function () {
      self.cursorEl.style.display = 'none';
      if (self._drawing) self._onUp();
    });
    cv.addEventListener('pointerenter', function (ev) {
      if (self.enabled && self.tool !== 'pick') { self.cursorEl.style.display = ''; self._moveCursor(ev); }
    });

    /* 滚轮：默认平移画布；按住 Ctrl / ⌘ 才是缩放 */
    wrap.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var step = (ev.deltaMode === 1 ? 16 : 1);
      if (ev.ctrlKey || ev.metaKey) {
        var r = cv.getBoundingClientRect();
        var sx = cv.width / Math.max(1, r.width), sy = cv.height / Math.max(1, r.height);
        self.zoomAt(ev.deltaY < 0 ? 1.12 : 1 / 1.12, (ev.clientX - r.left) * sx, (ev.clientY - r.top) * sy);
      } else {
        var k = self.dpr;
        self.panBy(-ev.deltaX * step * k, -ev.deltaY * step * k);
      }
    }, { passive: false });

    /* 中键 / 空格 + 拖动 = 平移（保留这个顺手的老习惯） */
    var panFrom = null;
    wrap.addEventListener('pointerdown', function (ev) {
      if (!self.enabled) return;
      if (ev.button !== 1 && !self._spaceDown) return;
      ev.preventDefault();
      self._panning = true;
      panFrom = { x: ev.clientX, y: ev.clientY, vx: self.view.x, vy: self.view.y };
      try { wrap.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    });
    wrap.addEventListener('pointermove', function (ev) {
      if (!self._panning || !panFrom) return;
      ev.preventDefault();
      var r = cv.getBoundingClientRect();
      var sx = cv.width / Math.max(1, r.width), sy = cv.height / Math.max(1, r.height);
      self.view.x = panFrom.vx + (ev.clientX - panFrom.x) * sx;
      self.view.y = panFrom.vy + (ev.clientY - panFrom.y) * sy;
      self._clampView();
      self._syncPans();
      self._schedule();
    });
    function endPan() { self._panning = false; panFrom = null; }
    wrap.addEventListener('pointerup', endPan);
    wrap.addEventListener('pointercancel', endPan);

    /* 左 / 下两条平移条：按住拖动就能挪画布 */
    function bindPanTrack(track, thumb, axis) {
      var dragging = false;
      function apply(ev) {
        var r = track.getBoundingClientRect();
        var size = axis === 'x' ? r.width : r.height;
        var th = axis === 'x' ? thumb.offsetWidth : thumb.offsetHeight;
        var pos = axis === 'x' ? (ev.clientX - r.left) : (ev.clientY - r.top);
        var span = Math.max(1, size - th);
        self.panTo(axis === 'x' ? (pos - th / 2) / span : self._panFrac('x'),
          axis === 'y' ? (pos - th / 2) / span : self._panFrac('y'));
      }
      thumb.addEventListener('pointerdown', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        dragging = true;
        try { thumb.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      });
      thumb.addEventListener('pointermove', function (ev) {
        if (!dragging) return;
        ev.preventDefault(); ev.stopPropagation();
        apply(ev);
      });
      thumb.addEventListener('pointerup', function (ev) {
        dragging = false; ev.stopPropagation();
      });
      thumb.addEventListener('pointercancel', function () { dragging = false; });
      // 点轨道空白处：直接跳到那个位置
      track.addEventListener('pointerdown', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        apply(ev);
      });
    }
    bindPanTrack(this.panX, this.panXThumb, 'x');
    bindPanTrack(this.panY, this.panYThumb, 'y');

    /* 快捷键 */
    this._keyHandler = function (e) {
      var t = e.target;
      var inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      if (e.code === 'Space' && !inField) { self._spaceDown = true; return; }
      if (!self.enabled || inField) return;
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) self.redo(); else self.undo();
      } else if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'y') {
        e.preventDefault(); self.redo();
      } else if (String(e.key).toLowerCase() === 'f') {
        e.preventDefault(); self.toggleFullscreen();
      }
    };
    this._keyUpHandler = function (e) { if (e.code === 'Space') self._spaceDown = false; };
    document.addEventListener('keydown', this._keyHandler);
    document.addEventListener('keyup', this._keyUpHandler);

    document.addEventListener('click', function () { self._closeBrushMenu(); });
    this.brushMenu.addEventListener('click', function (e) { e.stopPropagation(); });
    // 菜单是 fixed 定位的：只有当"锚点按钮"真的被滚走了才关掉。
    // （以前只要有任何滚动就关，于是在菜单里滚轮翻页、拖滚动条都会把菜单关掉）
    window.addEventListener('scroll', function (e) {
      if (self.brushMenu.contains(e.target)) return;          // 菜单自己的滚动不算
      if (!self.brushMenu.classList.contains('open')) return;
      var r = self.brushBtn.getBoundingClientRect();
      if (self._menuAnchor && Math.abs(r.top - self._menuAnchor.top) < 1.5 &&
        Math.abs(r.left - self._menuAnchor.left) < 1.5) return;
      self._closeBrushMenu();
    }, true);
    window.addEventListener('resize', function () {
      if (self.brushMenu.classList.contains('open')) self._placeBrushMenu();
    });

    document.addEventListener('fullscreenchange', function () {
      self.fsBtn.title = document.fullscreenElement ? '退出全屏（F 键）' : '全屏（F 键）';
      setTimeout(function () { self.resize(); }, 60);
    });

    this._bindWheel();

    // 容器尺寸变化（比如窗口缩放、切视图）自己跟着调整，避免画布和面板错位
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self.resize(); });
      this._ro.observe(this.wrap);
    }
  };

  Pad.prototype._panFrac = function (axis) {
    var v = this.view, W = this.cssW, H = this.cssH;
    if (v.s <= 1.0001) return 0;
    if (axis === 'x') return clamp(-(v.x / this.dpr) / (W * (v.s - 1)), 0, 1);
    return clamp(-(v.y / this.dpr) / (H * (v.s - 1)), 0, 1);
  };

  /* 色环：外圈选色相，里面的方块选饱和度和明度 */
  Pad.prototype._wheelGeom = function () {
    var W = this.wheel.width;
    return { cx: W / 2, cy: W / 2, R: W / 2 - 2, r: W / 2 - 2 - 12, half: (W / 2 - 2 - 12) * 0.707 };
  };

  Pad.prototype._wheelAt = function (ev) {
    var r = this.wheel.getBoundingClientRect();
    var g = this._wheelGeom();
    var sx = this.wheel.width / Math.max(1, r.width), sy = this.wheel.height / Math.max(1, r.height);
    var x = (ev.clientX - r.left) * sx, y = (ev.clientY - r.top) * sy;
    var dx = x - g.cx, dy = y - g.cy, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > g.r - 2 && dist <= g.R + 6) return { zone: 'ring', dx: dx, dy: dy };
    if (Math.abs(dx) <= g.half && Math.abs(dy) <= g.half) return { zone: 'square', dx: dx, dy: dy };
    return null;
  };

  Pad.prototype._bindWheel = function () {
    var self = this;
    var dragging = false;
    var dragZone = null;    // ★ 按下时锁定区域
    function apply(ev) {
      var hit = self._wheelAt(ev);
      if (!hit) return;
      var g = self._wheelGeom();
      // 从哪个区域开始拖，整段拖拽就只改那个区域的值：
      // 在方块里拖到外面，也只把饱和度/明度夹到 0~1，绝不会跑去改色相
      // （以前不锁定，拖出方块边界就会跳到圆环上把色相也改了，很反直觉）
      var zone = dragZone || hit.zone;
      if (zone === 'ring') {
        var hue = Math.atan2(hit.dy, hit.dx) * 180 / Math.PI;
        if (hue < 0) hue += 360;
        self.hsv.h = hue;
      } else {
        self.hsv.s = clamp((hit.dx + g.half) / (g.half * 2), 0, 1);
        self.hsv.v = clamp(1 - (hit.dy + g.half) / (g.half * 2), 0, 1);
      }
      var rgb = hsvToRgb(self.hsv.h, self.hsv.s, self.hsv.v);
      self.color = rgbToHex(rgb.r, rgb.g, rgb.b);
      self._renderWheel();
      self._renderPresetsState();
      self._syncTool();
    }
    this.wheel.addEventListener('pointerdown', function (ev) {
      if (!self.enabled) return;
      ev.preventDefault();
      var start = self._wheelAt(ev);
      if (!start) return;
      dragZone = start.zone;        // 锁定：这次拖拽只动这一个区域
      dragging = true;
      try { self.wheel.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      apply(ev);
    });
    this.wheel.addEventListener('pointermove', function (ev) { if (dragging) { ev.preventDefault(); apply(ev); } });
    this.wheel.addEventListener('pointerup', function () {
      if (dragging) { dragging = false; dragZone = null; self._pushRecent(self.color); self._renderBrushPreviews(); }
    });
    this.wheel.addEventListener('pointercancel', function () { dragging = false; dragZone = null; });
  };

  Pad.prototype._onDown = function (ev) {
    var p = this._ptDev(ev);
    if (this.tool === 'pick') { this._pick(p); return; }
    if (this.tool === 'fill') {
      this.localOp({ k: 'fill', L: this.activeLayer, x: p.nx, y: p.ny, c: this.color, a: this.opacity, tol: this.tolerance, e: this.edge });
      return;
    }
    if (this.tool === 'shape') {
      this._drawing = true;
      this._shapeStart = { x: p.nx, y: p.ny };
      this._shift = !!ev.shiftKey;
      return;
    }
    this._drawing = true;
    this._S = 'S' + (++this.seq) + '-' + Date.now().toString(36);
    this._last = { x: p.nx, y: p.ny };
    this._beginLive(this._S, this.tool, this.brush, this.opacity, this.color, this.activeLayer);
    var seg = this._makeSeg(p.nx, p.ny, p.nx, p.ny);
    this._pending = [seg];
    this._applySeg(seg);
    this._schedule();
  };

  /** 笔宽按"画布空间"记：放大了就自动变细，屏幕上看还是一样粗，方便抠细节 */
  Pad.prototype._makeSeg = function (x, y, px, py) {
    return {
      k: 'seg', S: this._S, L: this.activeLayer,
      x: x, y: y, px: px, py: py,
      c: this.color, w: (this.size / Math.max(1, this.cssW)) / this.view.s,
      a: this.opacity, m: this.tool, z: this.brush
    };
  };

  Pad.prototype._onMove = function (ev) {
    var p = this._ptDev(ev);
    if (this.tool === 'shape') {
      this._shapeDrag = this._shapeOp(ev, p);
      this._schedule();
      return;
    }
    if (!this._live) return;
    var seg = this._makeSeg(p.nx, p.ny, this._last.x, this._last.y);
    this._last = { x: p.nx, y: p.ny };
    this._applySeg(seg);
    this._pending.push(seg);
    this._flushPending();
    this._schedule();
  };

  Pad.prototype._shapeOp = function (ev, p) {
    var s = this._shapeStart;
    var x1 = p.nx, y1 = p.ny;
    if (ev.shiftKey) {
      if (this.shape === 'line' || this.shape === 'arrow') {
        var dx = x1 - s.x, dy = y1 - s.y;
        var ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        var len = Math.sqrt(dx * dx + dy * dy);
        x1 = s.x + Math.cos(ang) * len; y1 = s.y + Math.sin(ang) * len;
      } else {
        var side = Math.max(Math.abs(x1 - s.x), Math.abs(y1 - s.y));
        x1 = s.x + Math.sign(x1 - s.x || 1) * side;
        y1 = s.y + Math.sign(y1 - s.y || 1) * side;
      }
    }
    return {
      k: 'shape', L: this.activeLayer, s: this.shape,
      x0: s.x, y0: s.y, x1: x1, y1: y1,
      c: this.color, w: (this.size / Math.max(1, this.cssW)) / this.view.s, a: this.opacity,
      m: 'pen', z: this.brush,
      f: (this.shape === 'rect' || this.shape === 'ellipse') && this.shapeFill ? 1 : 0
    };
  };

  Pad.prototype._flushPending = function () {
    if (!this._pending || !this._pending.length) return;
    var list = this._pending;
    this._pending = [];
    for (var i = 0; i < list.length; i++) {
      this._pushHistory(list[i]);
      this.onOp(list[i]);
    }
    this._updateUndo();
  };

  Pad.prototype._onUp = function () {
    if (!this._drawing) return;
    this._drawing = false;
    if (this.tool === 'shape' && this._shapeDrag) {
      var sh = this._shapeDrag;
      this._shapeDrag = null;
      if (Math.abs(sh.x1 - sh.x0) * this.cssW > 3 || Math.abs(sh.y1 - sh.y0) * this.cssH > 3) this.localOp(sh);
      this._schedule();
      return;
    }
    this._flushPending();
    if (this._live) {
      this._commitLive();
      var end = { k: 'sege', S: this._S };
      this._pushHistory(end);
      this.onOp(end);
    }
    this._schedule();
  };

  /* ---------------- 取色器 ---------------- */
  Pad.prototype._pick = function (p) {
    var c = this._flatten(false);
    var W = c.width, H = c.height;
    var d = c.getContext('2d').getImageData(
      clamp(Math.floor(p.nx * (W - 1)), 0, W - 1), clamp(Math.floor(p.ny * (H - 1)), 0, H - 1), 1, 1).data;
    var hex = rgbToHex(d[0], d[1], d[2]);
    this.setColor(hex);
    this._pushRecent(hex);
    this.setTool(this._lastBrushTool || 'pen');
    this.onNotice('取到颜色 ' + hex.toUpperCase(), 'ok');
  };

  /* ---------------- 对外 API ---------------- */
  Pad.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    // 只读（猜的人）时把整个左侧工具栏收起来，画布多吃点宽度
    this.root.classList.toggle('disabled', !this.enabled);
    this.root.classList.toggle('viewonly', !this.enabled);
    if (this.sideBtn) this.sideBtn.style.display = this.enabled ? '' : 'none';
    this._syncTool();
    if (!this.enabled) this._closeBrushMenu();
    var self = this;
    setTimeout(function () { self.resize(); }, 0);
  };

  Pad.prototype.applyRemote = function (op) {
    this._pushHistory(op);
    this.applyOp(op, true);
    this._schedule();
    this._updateUndo();
  };

  Pad.prototype.resetAll = function () {
    this.ops = []; this.cursor = 0;
    this._live = null; this._shapeDrag = null; this._drawing = false; this._pending = null;
    this.layers = []; this.activeLayer = 0;
    this.fitView();
    this.newLayer();
    this._renderLayers();
    this._updateUndo();
    this._schedule();
  };

  Pad.prototype.getImageData = function () {
    var c = this._flatten(true);
    return c.getContext('2d').getImageData(0, 0, c.width, c.height);
  };

  Pad.prototype.getDataURL = function (type) {
    var W = this.display.width, H = this.display.height;
    var out = newCanvas(W, H), x = ctxOf(out);
    x.fillStyle = this.opts.background || '#fffdf7';
    x.fillRect(0, 0, W, H);
    x.drawImage(this._flatten(true), 0, 0);
    return out.toDataURL(type || 'image/png');
  };

  Pad.prototype.toBlob = function (cb, type) {
    var self = this;
    var url = this.getDataURL(type);
    if (!cb) return url;
    var img = new Image();
    img.onload = function () {
      var c = newCanvas(self.display.width, self.display.height);
      ctxOf(c).drawImage(img, 0, 0);
      c.toBlob(cb, type || 'image/png');
    };
    img.src = url;
    return url;
  };

  /* ---------------- 笔刷预览（菜单里那条波浪线） ----------------
   * 用该笔刷真实的打点逻辑画一条波浪线，所以颗粒/软硬/粗细/透明度
   * 都能在菜单里直接看出来。每支笔刷给一个能体现性格的预览粗细。
   */
  var PREVIEW_R = {
    pencil: 3.0, pen: 1.4, marker: 4.2, crayon: 3.6, chalk: 4.8, charcoal: 6.4,
    ink: 3.4, spray: 4.6, water: 6.2, neon: 2.8, hl: 5.6, dots: 3.0
  };

  function drawBrushPreview(cv, b, rgb) {
    var W = cv.width, H = cv.height;
    var x = ctxOf(cv);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1;
    x.clearRect(0, 0, W, H);
    var pts = [], n = 46, pad = 14;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      pts.push({
        x: pad + t * (W - pad * 2),
        y: H / 2 + Math.sin(t * Math.PI * 2.4) * (H * 0.22)
      });
    }
    var radius = PREVIEW_R[b.id] || 3.6;
    var mul = (b.defOpa == null ? 1 : b.defOpa / 100);
    strokePath(x, b, rgb, pts, radius, hashStr('prev' + b.id), mul);
  }

  /* ---------------- 导出 ---------------- */
  WB.PaintPad = {
    create: function (mount, opts) { return new Pad(mount, opts); },
    Pad: Pad,
    BRUSHES: BRUSHES,
    MODES: MODES,
    SHAPES: SHAPES,
    PRESETS: PRESETS,
    version: '3.0.0'
  };
})(window.WB);
