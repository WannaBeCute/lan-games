/*!
 * TankCore —— 坦克大战共享内核（物理 / 规则 / 迷宫地图 / 机器人）
 * 浏览器: window.TankCore   Node: require('.../tankcore.js')
 *
 * 操作模型：坦克可 360° 连续旋转
 *   ↑ 前进   ↓ 后退   ← 左转   → 右转   开火键 发射
 * 子弹：沿车头方向飞出、撞墙反弹、有存活时间、会打中自己（含反弹回来的）
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') { module.exports = factory(); }
  else { root.TankCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var TILE = 32;
  var EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, BUSH = 4;
  // 被子弹"打薄"的草丛：还能看、还能挡视线，但**不能再藏坦克**了
  var BUSH_THIN = 5;
  var GRAZED = 6;            // 被轻轻擦过的草：比完整草丛稀疏一点，但远没到"稀疏草丛"的程度

  var TANK_R = 11;                  // 坦克碰撞半径（圆形，支持任意角度）
  var TANK_SIZE = TANK_R * 2;
  var BULLET_R = 3;
  var MAX_BULLETS = 5;              // 子弹上限五颗

  var TANK_SPEED = 104;             // px/s 前进
  var BACK_SPEED = 62;              // px/s 后退
  var ROT_SPEED = 2.5;              // rad/s 旋转（约 143°/s；调低过，原来 4.2 太灵敏）
  var SPEED_BOOST = 1.45;           // 加速道具的倍率
  /**
   * 子弹速度：比原来的 372 慢约 20%，看得清弹道。
   * 但必须**明显快于坦克的最大速度**（含加速道具），否则往前打出的子弹会被自己追上，
   * 变成"朝前开火把自己打死"。这里用公式兜住：就算以后调快坦克，也会自动把子弹顶上去。
   */
  var BULLET_SPEED = Math.max(298, TANK_SPEED * SPEED_BOOST * 1.6);
  var FIRE_CD = 0.30;               // 开火间隔(秒)
  var BULLET_LIFE = 5;              // 子弹存活时间(秒) —— 到点自行消失
  var MAX_BOUNCE = 8;               // 最多反弹次数（防死循环）

  var MAX_POWERUPS = 3;
  var POWERUP_TTL = 26;
  // 刷新间隔（秒）：POWERUP_GAP ~ POWERUP_GAP + POWERUP_JITTER。
  // 配合下面的「洗牌袋」，一轮 8 种道具大约 40 秒就能全见一遍，
  // 不会出现"玩了半天连激光都没见到"。
  var POWERUP_GAP = 4, POWERUP_JITTER = 3;
  var POWERUP_TYPES = ['speed', 'rapid', 'triple', 'power', 'laser', 'stealth', 'shield', 'life'];
  /**
   * 注意：power（穿甲弹）**不在这里** —— 它是"按发数"的弹药，不是按秒的 buff。
   * 以前它也是 18 秒的时长，于是捡到之后一整个 18 秒都是穿甲弹，打不完，
   * 看起来像"一直有穿甲弹"。现在是 AP_ROUNDS 发，打光就没了。
   */
  var DURATION = { speed: 18, rapid: 18, triple: 18, laser: 14, stealth: 20, shield: 14, life: 0 };
  var AP_ROUNDS = 3;                // 捡到一个穿甲弹道具给几发（上限也是它）
  /** 图标要一眼看懂，不用抽象英文缩写 */
  var PU_LABEL = { speed: '⚡', rapid: '🔥', triple: '🔱', power: '🎯', laser: '🔫', stealth: '👻', shield: '🛡', life: '❤️' };
  var PU_COLOR = { speed: '#2fd39b', rapid: '#f5a524', triple: '#4c8dff', power: '#c85dff', laser: '#ff2e88', stealth: '#9b8cff', shield: '#54c7ec', life: '#ff5f6d' };
  var PU_NAME = { speed: '加速', rapid: '连发', triple: '三连发', power: '穿甲弹', laser: '激光', stealth: '隐身', shield: '护盾', life: '加命' };
  /** 每个道具一句人话说明，用在 UI 提示里 */
  var PU_DESC = {
    speed: '移动速度 +45%', rapid: '开火间隔 -58%', triple: '一次射出 3 颗平行子弹',
    power: '给 ' + AP_ROUNDS + ' 发穿甲弹：能打穿钢墙、弹速更快，打光就没了',
    laser: '下一次开火变成贯穿光束，扫平沿途砖墙、钢墙与草丛（只能用一次）',
    stealth: '20 秒隐形；开火或捡到别的道具会立刻现形',
    shield: '免疫下一次伤害（挡 1 颗子弹）', life: '命数 +1'
  };
  var SHIELD_BLOCKS = 1;            // 护盾能挡几颗子弹

  var LASER_RANGE = 384;            // 激光最大路程（12 格），到点即止
  // 激光束的半宽：判定按"点到射线的垂距"算，和坦克车身一样宽，
  // 光束压到车身上就算命中（画出来的光束压在车上却没伤害，就是"激光打歪了"）
  var LASER_HALF_W = TANK_R + 6;      // 光束半宽（比车身略宽，看得清也打得准）
  var LASER_CD = 0.66;              // 激光的开火间隔（比普通子弹慢）

  var LIVES_DEFAULT = 1;            // 每局生命数：默认 1 条
  var MAX_LIVES = 5;                // 每局生命数上限 5 条

  var RESPAWN_DELAY = 2.0;
  var INVULN = 2.5;
  var ROUND_LIMIT = 150;            // 单局时限(秒)

  var TANK_COLORS = ['#4c8dff', '#ff5d6c', '#2fd39b', '#f5a524', '#c85dff', '#54c7ec', '#ff8f4c', '#e6e9f5'];
  var TANK_COLOR_NAMES = ['蓝', '红', '绿', '黄', '紫', '青', '橙', '白'];
  var TANK_STYLES = ['classic', 'stripe', 'camo', 'neon'];
  var TANK_STYLE_NAMES = ['经典', '条纹', '迷彩', '霓虹'];

  /* 地图参数：随机墙体，只是"长得像迷宫"，不是规则迷宫 */
  var WALL_STROKES = 0.052;         // 内部每格面积画多少段随机墙（系数）
  var BLOCK_COUNT = 0.020;          // 随机 2x2 方块数量系数
  var BUSH_PATCHES = 0.023;         // 树丛"片"数（成片生长，供坦克藏身）
  var BUSH_PATCH_MIN = 7, BUSH_PATCH_MAX = 16;   // 每片草丛包含的格数
  var STEEL_RATIO = 0.42;           // 墙段中钢墙占比（其余为可击毁的砖墙）
  var MIN_SPAWN_DIST = 6;           // 出生点之间的最小格距（避免挨太近）
  var MIN_WALL = 0.24;              // 内部墙体占比下限（保证"墙面多、像迷宫"）
  var MAX_WALL = 0.42;              // 内部墙体占比上限（避免挤成一团）

  /* ---------------- 角度工具 ---------------- */
  function norm(a) {
    a = a % (Math.PI * 2);
    if (a > Math.PI) a -= Math.PI * 2;
    if (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function dirX(a) { return Math.sin(a); }
  function dirY(a) { return -Math.cos(a); }

  /* ---------------- 随机数 ---------------- */
  function rngFrom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- 碰撞判定（圆形） ---------------- */
  function isWallTank(t) { return t === BRICK || t === STEEL || t === WATER; }
  function isWallBullet(t) { return t === BRICK || t === STEEL; }

  /** 圆是否与任何墙体相交 */
  function circleFree(world, x, y, r) {
    var c0 = Math.floor((x - r) / TILE), c1 = Math.floor((x + r) / TILE);
    var r0 = Math.floor((y - r) / TILE), r1 = Math.floor((y + r) / TILE);
    if (c0 < 0 || r0 < 0 || c1 >= world.cols || r1 >= world.rows) return false;
    for (var ty = r0; ty <= r1; ty++) {
      for (var tx = c0; tx <= c1; tx++) {
        if (!isWallTank(world.tiles[ty * world.cols + tx])) continue;
        // 圆心到该格矩形的最短距离
        var nx = Math.max(tx * TILE, Math.min(x, tx * TILE + TILE));
        var ny = Math.max(ty * TILE, Math.min(y, ty * TILE + TILE));
        var dx = x - nx, dy = y - ny;
        if (dx * dx + dy * dy < r * r) return false;
      }
    }
    return true;
  }

  function tankAt(world, x, y, ignoreId) {
    for (var i = 0; i < world.tanks.length; i++) {
      var t = world.tanks[i];
      if (!t.alive || t.id === ignoreId) continue;
      var dx = t.x - x, dy = t.y - y;
      if (dx * dx + dy * dy < (TANK_R * 2 - 3) * (TANK_R * 2 - 3)) return t;
    }
    return null;
  }

  function canStand(world, x, y, id) {
    return circleFree(world, x, y, TANK_R) && !tankAt(world, x, y, id);
  }

  /* ---------------- 迷宫地图 ---------------- */
  function nearAnySpawn(spawns, c, r, d) {
    for (var i = 0; i < spawns.length; i++) {
      if (Math.abs(spawns[i][0] - c) <= d && Math.abs(spawns[i][1] - r) <= d) return true;
    }
    return false;
  }

  /** 连通性 + 可活动面积校验：可达空地必须 ≥ 全图 1/3，且所有出生点互通 */
  function analyze(tiles, cols, rows, spawns) {
    var total = cols * rows, open = 0, i;
    for (i = 0; i < total; i++) if (!isWallTank(tiles[i])) open++;
    if (open < total / 3) return { ok: false, open: open / total };

    var start = spawns[0][1] * cols + spawns[0][0];
    var seen = new Uint8Array(total);
    var stack = [start];
    seen[start] = 1;
    var count = 0;
    while (stack.length) {
      var cur = stack.pop(); count++;
      var cc = cur % cols, rr = (cur - cc) / cols;
      var nb = [[cc - 1, rr], [cc + 1, rr], [cc, rr - 1], [cc, rr + 1]];
      for (var k = 0; k < 4; k++) {
        var nc = nb[k][0], nr = nb[k][1];
        if (nc < 1 || nr < 1 || nc >= cols - 1 || nr >= rows - 1) continue;
        var ni = nr * cols + nc;
        if (seen[ni] || isWallTank(tiles[ni])) continue;
        seen[ni] = 1; stack.push(ni);
      }
    }
    if (count < total / 3) return { ok: false, open: count / total };
    for (var s = 0; s < spawns.length; s++) {
      if (!seen[spawns[s][1] * cols + spawns[s][0]]) return { ok: false, open: count / total };
    }
    return { ok: true, open: count / total };
  }

  /**
   * 随机墙体地图：在空场地上画大量随机走向的墙段（会拐弯）+ 随机方块，
   * 形成"像迷宫一样"的多岔路、死胡同布局 —— 但不用规则迷宫算法，每次都不一样。
   * 之后从可达空地中用「最远点采样」挑出彼此拉开距离的随机出生点。
   */
  function paintWalls(cols, rows, rand, density) {
    var tiles = new Uint8Array(cols * rows);
    var c, r, i, k;
    // 外圈：不可摧毁的钢墙
    for (c = 0; c < cols; c++) { tiles[c] = STEEL; tiles[(rows - 1) * cols + c] = STEEL; }
    for (r = 0; r < rows; r++) { tiles[r * cols] = STEEL; tiles[r * cols + cols - 1] = STEEL; }

    var area = Math.max(1, (cols - 2) * (rows - 2));
    var DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

    // 1) 随机墙段：从随机点出发走向随机，途中随机拐弯
    var strokes = Math.max(3, Math.round(area * WALL_STROKES * density));
    for (i = 0; i < strokes; i++) {
      var x = 2 + Math.floor(rand() * Math.max(1, cols - 4));
      var y = 2 + Math.floor(rand() * Math.max(1, rows - 4));
      var d = Math.floor(rand() * 4);
      var len = 4 + Math.floor(rand() * 8);
      var type = rand() < STEEL_RATIO ? STEEL : BRICK;
      for (k = 0; k < len; k++) {
        if (x >= 2 && y >= 2 && x <= cols - 3 && y <= rows - 3) tiles[y * cols + x] = type;
        if (rand() < 0.26) d = (d + (rand() < 0.5 ? 1 : 3)) % 4;
        x += DX[d]; y += DY[d];
        if (x < 2 || y < 2 || x > cols - 3 || y > rows - 3) break;
      }
    }

    // 2) 随机 2x2 方块，打散大片空地
    var blocks = Math.max(0, Math.round(area * BLOCK_COUNT * density));
    for (i = 0; i < blocks; i++) {
      var bx = 2 + Math.floor(rand() * Math.max(1, cols - 5));
      var by = 2 + Math.floor(rand() * Math.max(1, rows - 5));
      var bt = rand() < 0.7 ? BRICK : STEEL;
      for (var yy = 0; yy < 2; yy++) {
        for (var xx = 0; xx < 2; xx++) tiles[(by + yy) * cols + bx + xx] = bt;
      }
    }

    // 3) 树丛：成片生长（一片 7~16 格），只长在空地上 —— 坦克可以钻进去藏身
    var patches = Math.max(5, Math.round(area * BUSH_PATCHES));
    for (i = 0; i < patches; i++) {
      var gx = 2 + Math.floor(rand() * Math.max(1, cols - 4));
      var gy = 2 + Math.floor(rand() * Math.max(1, rows - 4));
      var cells = BUSH_PATCH_MIN + Math.floor(rand() * (BUSH_PATCH_MAX - BUSH_PATCH_MIN + 1));
      for (var q = 0; q < cells; q++) {
        // 以片心为中心随机扩散，连成一大块而不是东一块西一块
        var bx = gx + Math.round((rand() - 0.5) * 4.4);
        var by = gy + Math.round((rand() - 0.5) * 4.4);
        if (bx < 1 || by < 1 || bx >= cols - 1 || by >= rows - 1) continue;
        if (tiles[by * cols + bx] === EMPTY) tiles[by * cols + bx] = BUSH;
      }
    }
    return tiles;
  }

  /** 内部区域的墙体占比 */
  function interiorWallRatio(tiles, cols, rows) {
    var total = 0, wall = 0;
    for (var r = 1; r < rows - 1; r++) {
      for (var c = 1; c < cols - 1; c++) {
        total++;
        if (isWallTank(tiles[r * cols + c])) wall++;
      }
    }
    return total ? wall / total : 1;
  }

  /** 某个格子周围 3x3 是否足够空旷 */
  function openAround(tiles, cols, rows, c, r, need) {
    var free = 0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        var cc = c + x, rr = r + y;
        if (cc < 1 || rr < 1 || cc >= cols - 1 || rr >= rows - 1) return false;
        if (!isWallTank(tiles[rr * cols + cc])) free++;
      }
    }
    return free >= need;
  }

  /**
   * 随机出生点：先从开阔空地中随机取一个，再不断挑「离已选点最远」的位置，
   * 保证坦克之间不会挨得太近；彼此格距不足 MIN_SPAWN_DIST 则重新生成。
   */
  function pickSpawns(tiles, cols, rows, n, rand) {
    var cands = [], c, r, i, j;
    for (r = 2; r < rows - 2; r++) {
      for (c = 2; c < cols - 2; c++) {
        if (isWallTank(tiles[r * cols + c])) continue;
        if (openAround(tiles, cols, rows, c, r, 7)) cands.push([c, r]);
      }
    }
    if (cands.length < n) return null;

    var picked = [cands[Math.floor(rand() * cands.length)]];
    while (picked.length < n) {
      var best = -1, bestD = -1;
      for (i = 0; i < cands.length; i++) {
        var dmin = Infinity;
        for (j = 0; j < picked.length; j++) {
          var ddx = cands[i][0] - picked[j][0], ddy = cands[i][1] - picked[j][1];
          var dd = ddx * ddx + ddy * ddy;
          if (dd < dmin) dmin = dd;
        }
        if (dmin > bestD) { bestD = dmin; best = i; }
      }
      if (best < 0) return null;
      picked.push(cands[best]);
    }

    // 校验最小间距
    var minD2 = Infinity;
    for (i = 0; i < picked.length; i++) {
      for (j = i + 1; j < picked.length; j++) {
        var ex = picked[i][0] - picked[j][0], ey = picked[i][1] - picked[j][1];
        var e2 = ex * ex + ey * ey;
        if (e2 < minD2) minD2 = e2;
      }
    }
    if (Math.sqrt(minD2) < MIN_SPAWN_DIST) return null;
    return picked;
  }

  /** 兜底出生点：四角 + 四边中点，最多 8 个（单人生存需要更多同屏坦克） */
  function fallbackSpawns(cols, rows, n) {
    var midC = Math.floor(cols / 2), midR = Math.floor(rows / 2);
    var all = [
      [3, 3], [cols - 4, rows - 4], [cols - 4, 3], [3, rows - 4],
      [midC, 3], [midC, rows - 4], [3, midR], [cols - 4, midR]
    ];
    return all.slice(0, Math.max(2, Math.min(8, n)));
  }

  function buildLayout(cols, rows, spawnCount, rand) {
    // 最多 8 个出生点：单人生存同屏坦克会更多，需要更多出生格（联机/本地仍只请求 2~4 个，不受影响）
    var n = Math.max(2, Math.min(8, spawnCount || 2));
    var density = 1;
    for (var attempt = 0; attempt < 40; attempt++) {
      var tiles = paintWalls(cols, rows, rand, density);

      // 墙体密度不合适就调整重画（太稀不像迷宫，太密走不动）
      var wr = interiorWallRatio(tiles, cols, rows);
      if (wr < MIN_WALL) { density *= 1.22; continue; }
      if (wr > MAX_WALL) { density *= 0.82; continue; }

      var picked = pickSpawns(tiles, cols, rows, n, rand);
      if (!picked) { density *= 0.9; continue; }

      // 出生点周围清空，保证不会一出生就卡住
      for (var i = 0; i < picked.length; i++) {
        for (var oy = -1; oy <= 1; oy++) {
          for (var ox = -1; ox <= 1; ox++) {
            var sc = picked[i][0] + ox, sr = picked[i][1] + oy;
            if (sc > 0 && sr > 0 && sc < cols - 1 && sr < rows - 1) tiles[sr * cols + sc] = EMPTY;
          }
        }
      }
      var res = analyze(tiles, cols, rows, picked);
      if (res.ok) return { tiles: tiles, spawns: picked, open: res.open, wallRatio: wr };
      density *= 0.9;
    }
    // 极端兜底：空场地 + 均匀出生点
    var empty = new Uint8Array(cols * rows);
    for (var c2 = 0; c2 < cols; c2++) { empty[c2] = STEEL; empty[(rows - 1) * cols + c2] = STEEL; }
    for (var r2 = 0; r2 < rows; r2++) { empty[r2 * cols] = STEEL; empty[r2 * cols + cols - 1] = STEEL; }
    return { tiles: empty, spawns: fallbackSpawns(cols, rows, n), open: 1, wallRatio: 0 };
  }

  function buildMap(cols, rows, spawnCount, rand) {
    return buildLayout(cols, rows, spawnCount, rand);
  }

  /* ---------------- 世界 ---------------- */
  function createWorld(cfg) {
    cfg = cfg || {};
    var cols = cfg.cols || 25, rows = cfg.rows || 19;
    var seed = cfg.seed == null ? ((Math.random() * 0x7fffffff) | 0) : (cfg.seed | 0);
    var rand = rngFrom(seed);
    var map = buildMap(cols, rows, cfg.tankSlots || 2, rand);
    return {
      cols: cols, rows: rows, tiles: map.tiles, seed: seed,
      openRatio: map.open,
      spawns: map.spawns.map(function (s) { return [s[0] * TILE + TILE / 2, s[1] * TILE + TILE / 2]; }),
      spawnTiles: map.spawns,
      tanks: [], bullets: [], powerups: [], events: [],
      // 被摧毁的墙格（联机时必须同步给客户端，否则客户端会一直画着已经不存在的"假墙"）
      tileChanges: [],
      // 联机标记：隐身道具只在联机（有别的真人玩家可骗）时才有意义
      online: !!cfg.online,
      // 子弹是否会伤到自己（反弹回来的子弹）。默认 false = 不伤自己，房主可改
      selfDamage: !!cfg.selfDamage,
      // 本局允许掉落的道具（房主在房间里勾选的），不填 = 全部
      puPool: Array.isArray(cfg.powerups) ? cfg.powerups.slice() : null,
      puBag: [], puBagSig: null,
      time: 0, freeze: cfg.freeze == null ? 2.6 : cfg.freeze,
      powerTimer: POWERUP_GAP + rand() * POWERUP_JITTER,
      rand: rand, nextEntity: 1, state: 'play'
    };
  }

  function addTank(world, opts) {
    opts = opts || {};
    var slot = opts.slot == null ? world.tanks.length : opts.slot;
    var sp = world.spawns[slot % world.spawns.length];
    // 出生时车头朝向地图中心（出生点随机，朝中心比较自然）
    var toCenter = Math.atan2(world.cols * TILE / 2 - sp[0], -(world.rows * TILE / 2 - sp[1]));
    var t = {
      id: opts.id != null ? opts.id : world.nextEntity++,
      x: sp[0], y: sp[1],
      angle: opts.angle == null ? toCenter : opts.angle,     // 0 = 朝上，顺时针为正
      alive: true, lives: opts.lives == null ? LIVES_DEFAULT : opts.lives,
      cooldown: 0, invuln: INVULN, respawn: 0,
      power: { speed: 0, rapid: 0, triple: 0, power: 0, laser: 0, stealth: 0, shield: 0 },
      kills: 0, deaths: 0,
      color: opts.color || '#4c8dff', style: opts.style || 'classic',
      name: opts.name || ('P' + (slot + 1)),
      slot: slot,
      bot: opts.bot || null,
      input: { up: false, down: false, left: false, right: false, fire: false },
      spawn: sp
    };
    world.tanks.push(t);
    return t;
  }

  function findTank(world, id) {
    for (var i = 0; i < world.tanks.length; i++) if (world.tanks[i].id === id) return world.tanks[i];
    return null;
  }

  /* ---------------- 坦克移动（旋转 + 前后） ---------------- */
  /**
   * 固定子步长（px）。
   * 「贴着墙能停多近」必须和帧率无关 —— 否则客户端（比如 144Hz，每帧 0.7px）
   * 与服务端（固定 60Hz，每帧 1.7px）会在墙边算出**不同的停靠点**，
   * 差个 1px 上下；而客户端每收到一次快照（30Hz）就会把预测位置往回拽 35%，
   * 下一帧预测又推回去 —— 看起来就是坦克顶着墙角时不停地抖，
   * 炮口位置跟着晃，子弹自然也就"打偏"了。
   * 统一成固定子步 + 二分贴墙之后，两边算出的停靠点一致（误差 ~0.02px）。
   */
  var MOVE_SUB = 0.6;
  var CONTACT_ITER = 5;             // 二分次数：5 次 → 精度 1/32 步长

  /**
   * 从 (x,y) 沿 (dx,dy) 最多能走多少比例而不撞墙/撞车。
   * 1 = 整步都能走；0 = 一步都走不了；中间值 = 刚好贴住障碍。
   */
  function freeFraction(world, x, y, dx, dy, id) {
    if (canStand(world, x + dx, y + dy, id)) return 1;
    var lo = 0, hi = 1;
    for (var k = 0; k < CONTACT_ITER; k++) {
      var mid = (lo + hi) / 2;
      if (canStand(world, x + dx * mid, y + dy * mid, id)) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * 走一小步：
   *   1) 整步走得通 → 直接走；
   *   2) 走不通 → 分轴滑行（贴着墙也能顺着墙走），每个轴各自"贴到刚好为止"；
   *   3) 两个轴都动不了（墙角死角）→ 沿原方向二分贴住墙，然后停下。
   */
  function moveStep(world, tank, sx, sy, id) {
    if (canStand(world, tank.x + sx, tank.y + sy, id)) { tank.x += sx; tank.y += sy; return true; }

    var moved = false;
    if (Math.abs(sx) > 1e-9) {
      var fx = freeFraction(world, tank.x, tank.y, sx, 0, id);
      if (fx > 1e-6) { tank.x += sx * fx; moved = true; }
    }
    if (Math.abs(sy) > 1e-9) {
      var fy = freeFraction(world, tank.x, tank.y, 0, sy, id);
      if (fy > 1e-6) { tank.y += sy * fy; moved = true; }
    }
    if (moved) return true;

    var f = freeFraction(world, tank.x, tank.y, sx, sy, id);
    if (f > 1e-6) { tank.x += sx * f; tank.y += sy * f; }
    return false;                    // 已经贴住墙：这一帧的移动到此为止
  }

  function moveTank(world, tank, dt) {
    var inp = tank.input;

    // 转向
    if (inp.left && !inp.right) tank.angle = norm(tank.angle - ROT_SPEED * dt);
    else if (inp.right && !inp.left) tank.angle = norm(tank.angle + ROT_SPEED * dt);

    // 前后
    var sp = 0;
    if (inp.up) sp += TANK_SPEED * (tank.power && tank.power.speed > 0 ? SPEED_BOOST : 1);
    if (inp.down) sp -= BACK_SPEED;
    if (!sp) return;

    var dx = dirX(tank.angle) * sp * dt;
    var dy = dirY(tank.angle) * sp * dt;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.max(1, Math.ceil(dist / MOVE_SUB));
    var sx = dx / steps, sy = dy / steps;
    for (var i = 0; i < steps; i++) {
      if (!moveStep(world, tank, sx, sy, tank.id)) break;
    }
  }

  /**
   * 坦克是不是正躲在树丛里（车体中心所在的格子是树丛）。
   * 用途：草丛里不显示头顶名字；自己的车会被半透明补画在草丛之上（否则会被草完全盖住）。
   * 草丛本身是**正常遮挡**（草画在坦克上面），不是把坦克藏起来。
   */
  function inBush(world, tank) {
    if (!world || !tank) return false;
    var c = Math.floor(tank.x / TILE), r = Math.floor(tank.y / TILE);
    if (c < 0 || r < 0 || c >= world.cols || r >= world.rows) return false;
    return world.tiles[r * world.cols + c] === BUSH;
  }

  /** 改一格地形：记录 [索引, 新值] 对（联机时据此同步），需要的话再发一条事件 */
  function setTile(world, idx, value, ev) {
    if (world.tiles[idx] === value) return false;
    world.tiles[idx] = value;
    world.tileChanges.push(idx, value);
    if (ev) world.events.push(ev);
    return true;
  }

  /**
   * 草丛磨损：分三档，越后面越稀疏。
   *   完整草丛(BUSH) → 轻擦(GRAZED) → 稀疏草丛(BUSH_THIN) → 空地(EMPTY)
   * 子弹是"轻力度"：每次只削一档，所以一发散弹过去草丛只是被擦破一点；
   * 激光是"大力度"：直接跳两级，光束正面一整格清空，周围一圈也被削到很薄/直接没了。
   */
  function wearBush(world, idx, hard) {
    var t = world.tiles[idx];
    var c = idx % world.cols, r = Math.floor(idx / world.cols);
    var x = c * TILE + TILE / 2, y = r * TILE + TILE / 2;
    var ev = { k: 'bushcut', x: x, y: y, hard: !!hard };
    if (hard) {
      // 激光：大力度，跳两级
      if (t === BUSH)      { setTile(world, idx, BUSH_THIN, ev); return true; }
      if (t === GRAZED)    { setTile(world, idx, EMPTY,     ev); return true; }
      if (t === BUSH_THIN) { setTile(world, idx, EMPTY,     ev); return true; }
      return false;
    }
    // 子弹：轻力度，每次只削一档
    if (t === BUSH)      { setTile(world, idx, GRAZED,    ev); return true; }
    if (t === GRAZED)    { setTile(world, idx, BUSH_THIN, ev); return true; }
    if (t === BUSH_THIN) { setTile(world, idx, EMPTY,     ev); return true; }
    return false;
  }

  /** 隐身中被打断（开火 / 捡到别的道具）→ 立刻现形 */
  function reveal(world, tank) {
    if (!tank.power || tank.power.stealth <= 0) return false;
    tank.power.stealth = 0;
    world.events.push({ k: 'reveal', x: tank.x, y: tank.y, id: tank.id });
    return true;
  }

  /**
   * 激光：沿车头方向瞬间打出一条光束，贯穿沿途的砖墙与钢墙，
   * 打中第一辆坦克就停在那里；路程上限 LASER_RANGE（不会打到地图外圈）。
   */
  function fireLaser(world, tank) {
    var a = tank.angle;
    // 炮口起点：和子弹用的是同一个公式，光束与炮管方向严格一致
    var x0 = tank.x + dirX(a) * (TANK_R + 1);
    var y0 = tank.y + dirY(a) * (TANK_R + 1);
    var x = x0, y = y0;
    var dx = dirX(a), dy = dirY(a);
    // 激光是一次性的：这一发打出去就不再有了（不是"持续时间里随便射"）
    tank.power.laser = 0;

    /**
     * 先用"点到射线的垂距"找出会打中哪辆坦克 —— 和画出来的光束一样是有宽度的，
     * 以前只在射线上取点做圆形判定，坦克稍微偏一点就会"明明打中了却没伤害"。
     */
    var hitTank = null, hitAt = Infinity, k;
    for (k = 0; k < world.tanks.length; k++) {
      var tk = world.tanks[k];
      if (!tk.alive || tk.id === tank.id) continue;
      var px = tk.x - x, py = tk.y - y;
      var along = px * dx + py * dy;                 // 沿射线方向的距离
      if (along <= 0 || along > LASER_RANGE) continue;
      var qx = px - dx * along, qy = py - dy * along; // 垂直分量
      var perp = Math.sqrt(qx * qx + qy * qy);
      if (perp > LASER_HALF_W) continue;             // 在光束宽度之外
      if (along < hitAt) { hitAt = along; hitTank = tk; }
    }

    // 再沿射线推进：扫掉沿途的砖墙钢墙，遇到外圈或"比墙更近的坦克"就停
    var step = 2, travel = 0, cut = LASER_RANGE;
    while (travel < LASER_RANGE) {
      x += dx * step; y += dy * step; travel += step;
      // 坦克比墙近 → 先打中坦克（光束在这里结束）
      if (hitTank && travel >= hitAt) { cut = hitAt; break; }
      var c = Math.floor(x / TILE), r = Math.floor(y / TILE);
      // 打到最后一道外圈就停（外圈不可摧毁，否则坦克能开出地图）
      if (c <= 0 || r <= 0 || c >= world.cols - 1 || r >= world.rows - 1) { cut = travel; break; }
      var ti = r * world.cols + c;
      var tt = world.tiles[ti];
      if (tt === BRICK || tt === STEEL || tt === BUSH || tt === BUSH_THIN || tt === GRAZED) {
        var wasBush = (tt === BUSH || tt === BUSH_THIN || tt === GRAZED);
        setTile(world, ti, EMPTY, {
          k: 'brick', x: c * TILE + TILE / 2, y: r * TILE + TILE / 2,
          power: true, bush: wasBush
        });
        // 激光对草丛是"大幅度"消失：不只清掉光束正面这一格，周围一圈也一起打薄/烧掉。
        // 因为本格已经变成空地，后面光束再扫到同一格不会重复触发，不会无限蔓延。
        if (wasBush) {
          for (var oy = -1; oy <= 1; oy++) {
            for (var ox = -1; ox <= 1; ox++) {
              if (!ox && !oy) continue;
              var nc = c + ox, nr = r + oy;
              if (nc <= 0 || nr <= 0 || nc >= world.cols - 1 || nr >= world.rows - 1) continue;
              var ni = nr * world.cols + nc;
              var nt = world.tiles[ni];
              if (nt === BUSH || nt === BUSH_THIN || nt === GRAZED) wearBush(world, ni, true);
            }
          }
        }
        continue;                                     // 激光贯穿，不停
      }
    }
    if (hitTank && cut === hitAt) {
      applyHit(world, hitTank, tank.id, x0 + dx * hitAt, y0 + dy * hitAt);
    }

    tank.cooldown = LASER_CD * (tank.power.rapid > 0 ? 0.6 : 1);
    reveal(world, tank);
    // 事件里带的起点与角度必须和上面推演用的是同一组，客户端画出来的光束才不会歪
    world.events.push({ k: 'laser', x: x0, y: y0, a: a, len: Math.round(cut), id: tank.id });
    return true;
  }

  /* ---------------- 开火 ---------------- */
  function fire(world, tank) {
    if (tank.cooldown > 0) return false;
    if (tank.power.laser > 0) return fireLaser(world, tank);   // 有激光就发激光

    var mine = 0, i;
    for (i = 0; i < world.bullets.length; i++) if (world.bullets[i].owner === tank.id) mine++;
    if (mine >= MAX_BULLETS) return false;          // 子弹上限五颗

    tank.cooldown = FIRE_CD * (tank.power.rapid > 0 ? 0.42 : 1);
    var a = tank.angle;
    var mdx = dirX(a), mdy = dirY(a);
    var px = tank.x + mdx * (TANK_R + 1);
    var py = tank.y + mdy * (TANK_R + 1);
    if (!circleFree(world, px, py, BULLET_R)) {
      /*
       * 顶着墙开火：炮口已经插进墙里了。以前是直接退回车体中心出生 ——
       * 子弹从车底"倒退"半车身才出来，出生就撞墙反弹，看着像弹道歪了。
       * 改成从车体中心朝炮口方向二分，取最远的自由点当出生点：
       * 车体中心一定自由（坦克能站在那，BULLET_R 又比 TANK_R 小），所以必有解。
       */
      var mlo = 0, mhi = 1;
      for (var mk = 0; mk < 6; mk++) {
        var mmid = (mlo + mhi) / 2;
        if (circleFree(world, tank.x + mdx * (TANK_R + 1) * mmid, tank.y + mdy * (TANK_R + 1) * mmid, BULLET_R)) mlo = mmid;
        else mhi = mmid;
      }
      px = tank.x + mdx * (TANK_R + 1) * mlo;
      py = tank.y + mdy * (TANK_R + 1) * mlo;
    }

    var offs = (tank.power.triple > 0) ? [-9, 0, 9] : [0];
    var perpX = dirY(a), perpY = -dirX(a);
    // 穿甲弹是按"发"算的（捡到给 AP_ROUNDS 发），不是按时间 —— 打一发少一发
    var power = (tank.power.power | 0) > 0;
    var shots = 0;
    for (i = 0; i < offs.length; i++) {
      if (tank.power.triple > 0 && mine + i >= MAX_BULLETS) break;
      world.bullets.push({
        id: world.nextEntity++,
        x: px + perpX * offs[i], y: py + perpY * offs[i],
        angle: a, owner: tank.id, power: power,
        speed: BULLET_SPEED * (power ? 1.15 : 1),
        age: 0, bounce: 0, armed: false
      });
      shots++;
    }
    if (power && shots > 0) tank.power.power = Math.max(0, (tank.power.power | 0) - 1);
    world.events.push({ k: 'shoot', x: tank.x, y: tank.y, a: a, id: tank.id });
    reveal(world, tank);            // 开火即现形
    return true;
  }

  /**
   * 一颗子弹/一束激光命中坦克时的统一结算：
   * 护盾挡下（且只挡一次）→ 出生保护免伤 → 正常扣命。
   */
  function applyHit(world, tk, byId, x, y) {
    if (tk.power.shield > 0) {
      tk.power.shield = 0;
      world.events.push({ k: 'shield', x: x, y: y, id: tk.id });
      return 'shield';
    }
    if (tk.invuln > 0) {
      world.events.push({ k: 'spark', x: x, y: y });
      return 'invuln';
    }
    damageTank(world, tk, byId);
    return 'kill';
  }

  /* ---------------- 子弹（反弹 + 寿命 + 可自伤） ---------------- */
  /**
   * 圆在 (x,y) 处与哪些墙格相交，返回**最近的那一格**索引。
   * 不能用「沿弹道前探固定距离」来猜，那样在格子边界附近会指到相邻的空格，
   * 表现就是砖块被打中却「只弹不碎」——看起来像一堵打不烂的假墙。
   */
  function hitTile(world, x, y, r) {
    var c0 = Math.floor((x - r) / TILE), c1 = Math.floor((x + r) / TILE);
    var r0 = Math.floor((y - r) / TILE), r1 = Math.floor((y + r) / TILE);
    var best = -1, bestD = Infinity;
    for (var ty = r0; ty <= r1; ty++) {
      for (var tx = c0; tx <= c1; tx++) {
        if (tx < 0 || ty < 0 || tx >= world.cols || ty >= world.rows) continue;
        if (!isWallBullet(world.tiles[ty * world.cols + tx])) continue;
        var nx = Math.max(tx * TILE, Math.min(x, tx * TILE + TILE));
        var ny = Math.max(ty * TILE, Math.min(y, ty * TILE + TILE));
        var dx = x - nx, dy = y - ny;
        var d = dx * dx + dy * dy;
        if (d < r * r && d < bestD) { bestD = d; best = ty * world.cols + tx; }
      }
    }
    return best;
  }

  function updateBullets(world, dt) {
    var i, j;
    for (i = world.bullets.length - 1; i >= 0; i--) {
      var b = world.bullets[i];
      b.age += dt;

      // 存活时间到 / 反弹次数过多 → 自动消失
      if (b.age >= BULLET_LIFE || b.bounce > MAX_BOUNCE) {
        world.events.push({ k: 'fade', x: b.x, y: b.y });
        world.bullets.splice(i, 1);
        continue;
      }

      // 离开炮口后就可以打中自己了
      if (!b.armed) {
        var owner = findTank(world, b.owner);
        if (!owner) b.armed = true;
        else {
          var odx = b.x - owner.x, ody = b.y - owner.y;
          if (odx * odx + ody * ody > (TANK_R + BULLET_R) * (TANK_R + BULLET_R)) b.armed = true;
        }
      }

      var remain = b.speed * dt;
      var dead = false;
      while (remain > 0.0001 && !dead) {
        var step = Math.min(remain, 4);
        var nx = b.x + dirX(b.angle) * step;
        var ny = b.y + dirY(b.angle) * step;
        var okBoth = circleFree(world, nx, ny, BULLET_R);
        var okX = circleFree(world, nx, b.y, BULLET_R);
        var okY = circleFree(world, b.x, ny, BULLET_R);

        if (okBoth) {
          b.x = nx; b.y = ny; remain -= step;
          // 子弹穿过草丛：把这一格打薄一档（完整 → 稀疏 → 空地）。
          // 用 b.tile 记住上次处理过的格子，免得同一格每帧都被打一次。
          var bc = Math.floor(b.x / TILE), br2 = Math.floor(b.y / TILE);
          var bi = br2 * world.cols + bc;
          if (bi !== b.tile) {
            b.tile = bi;
            var bt = world.tiles[bi];
            if (bt === BUSH || bt === BUSH_THIN || bt === GRAZED) wearBush(world, bi, false);
          }
        }
        else {
          // 撞墙：先处理被击中的那一格，再反弹
          var fi = hitTile(world, nx, ny, BULLET_R);
          if (fi >= 0) {
            var ft = world.tiles[fi];
            if (ft === BRICK) {
              setTile(world, fi, EMPTY, { k: 'brick', x: b.x, y: b.y, power: !!b.power });
            } else if (ft === STEEL && b.power) {
              setTile(world, fi, EMPTY, { k: 'brick', x: b.x, y: b.y, power: true });
            } else {
              world.events.push({ k: 'spark', x: b.x, y: b.y });
            }
          }
          /*
           * 反射：以被击中那格的矩形接触法线为准 —— 竖直面翻 x、水平面翻 y、
           * 正中角落（打到角点）原路返回。
           * 以前拿 okX/okY 猜反射面：顶着凸出来的墙角斜射时，两个单轴位置都合法、
           * 只有对角被挡，会落进"否则翻 y"的兜底 —— 子弹朝一个没道理的方向飞，
           * 就是贴着墙角开火时看到的「弹道偏离」。fi<0（地图外边界）时才退回老猜法。
           */
          var refl = fi >= 0;
          if (refl) {
            var fc = (fi % world.cols) * TILE, fr2 = Math.floor(fi / world.cols) * TILE;
            var qx = Math.max(fc, Math.min(nx, fc + TILE));
            var qy = Math.max(fr2, Math.min(ny, fr2 + TILE));
            var ex = nx - qx, ey = ny - qy;
            if (Math.abs(ex) > Math.abs(ey) + 1e-6) b.angle = norm(-b.angle);
            else if (Math.abs(ey) > Math.abs(ex) + 1e-6) b.angle = norm(Math.PI - b.angle);
            else if (ex !== 0 || ey !== 0) b.angle = norm(b.angle + Math.PI);
            else refl = false;              // 圆心已经陷进墙格里：没法判法线，退回老猜法
          }
          if (!refl) {
            if (!okX && !okY) b.angle = norm(b.angle + Math.PI);
            else if (!okX) b.angle = norm(-b.angle);
            else b.angle = norm(Math.PI - b.angle);
          }
          b.bounce++;
          world.events.push({ k: 'ricochet', x: b.x, y: b.y });
          break;    // 本帧在此处结束（下一帧沿新方向继续）
        }
      }
      if (dead) { world.bullets.splice(i, 1); continue; }

      // 击中坦克（包含自己）
      for (j = 0; j < world.tanks.length; j++) {
        var tk = world.tanks[j];
        if (!tk.alive) continue;
        if (tk.id === b.owner && !b.armed) continue;
        // 关掉自伤时，自己的子弹对自己完全无效（穿过去，不是弹开）
        if (tk.id === b.owner && !world.selfDamage) continue;
        var ddx = tk.x - b.x, ddy = tk.y - b.y;
        var rr = TANK_R + BULLET_R - 1;
        if (ddx * ddx + ddy * ddy < rr * rr) {
          applyHit(world, tk, b.owner, b.x, b.y);
          dead = true; break;
        }
      }
      if (dead) { world.bullets.splice(i, 1); continue; }

      // 子弹对撞
      for (j = 0; j < world.bullets.length; j++) {
        var o = world.bullets[j];
        if (o === b || o.owner === b.owner) continue;
        var ox = o.x - b.x, oy = o.y - b.y;
        if (ox * ox + oy * oy < (BULLET_R * 2) * (BULLET_R * 2)) {
          world.events.push({ k: 'spark', x: b.x, y: b.y });
          world.bullets.splice(world.bullets.indexOf(o), 1);
          dead = true; break;
        }
      }
      if (dead) world.bullets.splice(i, 1);
    }
  }

  /* ---------------- 伤害 / 复活 ---------------- */
  function damageTank(world, tank, byId) {
    if (!tank.alive) return false;
    if (tank.power.shield > 0 || tank.invuln > 0) return false;
    tank.alive = false;
    tank.lives = Math.max(0, tank.lives - 1);
    tank.respawn = RESPAWN_DELAY;
    tank.deaths++;
    var killer = findTank(world, byId);
    if (killer && killer.id !== tank.id) killer.kills++;
    world.events.push({
      k: 'kill', x: tank.x, y: tank.y, id: tank.id, by: byId,
      suicide: byId === tank.id
    });
    return true;
  }

  function reviveTank(world, tank) {
    var list = [tank.spawn].concat(world.spawns);
    for (var i = 0; i < list.length; i++) {
      var sp = list[i];
      if (!sp) continue;
      if (canStand(world, sp[0], sp[1], tank.id)) {
        tank.x = sp[0]; tank.y = sp[1];
        tank.alive = true; tank.invuln = INVULN; tank.cooldown = 0;
        tank.angle = dirY(0) < 0 ? 0 : 0;
        tank.power = { speed: 0, rapid: 0, triple: 0, power: 0, laser: 0, stealth: 0, shield: 0 };
        world.events.push({ k: 'spawn', x: tank.x, y: tank.y, id: tank.id });
        return true;
      }
    }
    // 扫全图找空位
    for (var r = 1; r < world.rows - 1; r++) {
      for (var c = 1; c < world.cols - 1; c++) {
        var x = c * TILE + TILE / 2, y = r * TILE + TILE / 2;
        if (canStand(world, x, y, tank.id)) {
          tank.x = x; tank.y = y; tank.alive = true; tank.invuln = INVULN;
          world.events.push({ k: 'spawn', x: x, y: y, id: tank.id });
          return true;
        }
      }
    }
    tank.respawn = 0.5;
    return false;
  }

  /* ---------------- 特殊武器 ---------------- */

  /**
   * 当前对局会掉落的道具种类。三道过滤，按顺序：
   *   1. 房主在房间里勾选的道具池（world.puPool，不填就是全部）；
   *   2. 隐身只在联机模式出现 —— 单机/本地双人对战时对手就在同一块屏幕上，隐身没有意义，
   *      反而会让 AI 和玩家看得莫名其妙（本地机器人是靠读战场数据找目标的，隐身对它无效）；
   *   3. 兜底：万一上面过滤完是空的（配置写错），就退回全部，绝不能导致一个道具都不刷。
   */
  function powerupTypes(world) {
    var list = POWERUP_TYPES;
    if (world && world.puPool && world.puPool.length) {
      var picked = [];
      for (var i = 0; i < POWERUP_TYPES.length; i++) {
        if (world.puPool.indexOf(POWERUP_TYPES[i]) >= 0) picked.push(POWERUP_TYPES[i]);
      }
      if (picked.length) list = picked;
    }
    if (world && !world.online) {
      var noStealth = list.filter(function (t) { return t !== 'stealth'; });
      if (noStealth.length) list = noStealth;
    }
    return list;
  }

  /**
   * 抽一个道具种类：用「洗牌袋」而不是纯随机。
   * 纯随机会出现某种道具连着十几把都不出现（8 种时，一局 40 秒只掉 8 个，
   * 激光/隐身经常整局不见）—— 洗牌袋保证一轮之内每种各出现一次，只是顺序随机。
   */
  function pickPowerupType(world) {
    var pool = powerupTypes(world);
    if (!world.puBag) world.puBag = [];
    // 池子变了（房主中途改配置 / 换模式）就重新洗牌，别把已被关掉的道具留在袋子里
    var sig = pool.join(',');
    if (world.puBagSig !== sig) { world.puBag = []; world.puBagSig = sig; }
    if (!world.puBag.length) {
      var bag = pool.slice();
      for (var i = bag.length - 1; i > 0; i--) {
        var j = Math.floor(world.rand() * (i + 1));
        var tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
      }
      world.puBag = bag;
    }
    return world.puBag.pop();
  }

  function spawnPowerup(world, type) {
    var pool = powerupTypes(world);
    if (!type) type = pickPowerupType(world);
    // 兜底：万一外部硬塞了一个本局不掉的道具，也别生成出来
    if (pool.indexOf(type) < 0) type = pickPowerupType(world);
    var tries = 0;
    while (tries++ < 120) {
      var c = 2 + Math.floor(world.rand() * (world.cols - 4));
      var r = 2 + Math.floor(world.rand() * (world.rows - 4));
      var i = r * world.cols + c;
      if (world.tiles[i] !== EMPTY) continue;
      var x = c * TILE + TILE / 2, y = r * TILE + TILE / 2;
      if (!circleFree(world, x, y, 13)) continue;
      var far = true;
      for (var k = 0; k < world.tanks.length; k++) {
        var t = world.tanks[k];
        if (!t.alive) continue;
        if (Math.abs(t.x - x) < TILE * 2 && Math.abs(t.y - y) < TILE * 2) { far = false; break; }
      }
      if (!far) continue;
      var pu = { id: world.nextEntity++, x: x, y: y, type: type, ttl: POWERUP_TTL };
      world.powerups.push(pu);
      world.events.push({ k: 'spawn-pu', x: x, y: y, p: type });
      return pu;
    }
    return null;
  }

  function applyPowerup(world, tank, type) {
    var full = false;
    if (type === 'life') {
      // 命数必须有上限：以前可以无限叠加，连捡几个就"怎么打都打不完"，看起来像开了无敌
      if (tank.lives >= MAX_LIVES) full = true;
      else tank.lives = Math.min(MAX_LIVES, tank.lives + 1);
    } else if (type === 'power') {
      // 穿甲弹：发数制，最多 AP_ROUNDS 发（再捡一个只是补满，不会越攒越多）
      tank.power.power = Math.min(AP_ROUNDS, (tank.power.power | 0) + AP_ROUNDS);
    } else {
      tank.power[type] = Math.max(tank.power[type] || 0, DURATION[type]);
    }
    // 隐身时捡到别的道具会立刻现形（再捡一个隐身只是续时间）
    if (type !== 'stealth') reveal(world, tank);
    world.events.push({ k: 'pickup', x: tank.x, y: tank.y, id: tank.id, p: type, lv: tank.lives, full: full });
  }

  function updatePowerups(world, dt) {
    var i, j;
    for (i = world.powerups.length - 1; i >= 0; i--) {
      var pu = world.powerups[i];
      pu.ttl -= dt;
      if (pu.ttl <= 0) { world.powerups.splice(i, 1); continue; }
      for (j = 0; j < world.tanks.length; j++) {
        var t = world.tanks[j];
        if (!t.alive) continue;
        var dx = t.x - pu.x, dy = t.y - pu.y;
        if (dx * dx + dy * dy < (TANK_R + 9) * (TANK_R + 9)) {
          applyPowerup(world, t, pu.type);
          world.powerups.splice(i, 1);
          break;
        }
      }
    }
    if (world.freeze > 0) return;
    world.powerTimer -= dt;
    if (world.powerTimer <= 0) {
      world.powerTimer = POWERUP_GAP + world.rand() * POWERUP_JITTER;
      if (world.powerups.length < MAX_POWERUPS) spawnPowerup(world);
    }
  }

  /* ---------------- 机器人 ---------------- */
  function makeBot(level) {
    return { level: level || 1, turnDir: 1, blind: 0, stuck: 0, lastX: null, lastY: null, field: null, fieldT: 0, fieldTx: -1, fieldTy: -1 };
  }

  function nearestEnemy(world, tank) {
    var best = null, bd = Infinity;
    for (var i = 0; i < world.tanks.length; i++) {
      var t = world.tanks[i];
      if (!t.alive || t.id === tank.id) continue;
      if (t.power && t.power.stealth > 0) continue;      // 隐形的看不见
      var d = Math.abs(t.x - tank.x) + Math.abs(t.y - tank.y);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  function pathAhead(world, tank, dist) {
    var x = tank.x + dirX(tank.angle) * dist;
    var y = tank.y + dirY(tank.angle) * dist;
    return circleFree(world, x, y, TANK_R - 2) && !tankAt(world, x, y, tank.id);
  }

  /** 从目标格出发做一次 BFS，得到全图各格到目标的最短步数（-1 = 不可达） */
  function bfsField(world, sx, sy) {
    var cols = world.cols, rows = world.rows;
    var dist = new Int16Array(cols * rows).fill(-1);
    if (sx < 1 || sy < 1 || sx >= cols - 1 || sy >= rows - 1) return dist;
    var start = sy * cols + sx;
    if (isWallTank(world.tiles[start])) return dist;
    dist[start] = 0;
    var q = [start], head = 0;
    while (head < q.length) {
      var cur = q[head++];
      var cx = cur % cols, cy = (cur - cx) / cols;
      var d = dist[cur] + 1;
      if (cx > 1) { var a1 = cur - 1; if (dist[a1] === -1 && !isWallTank(world.tiles[a1])) { dist[a1] = d; q.push(a1); } }
      if (cx < cols - 2) { var a2 = cur + 1; if (dist[a2] === -1 && !isWallTank(world.tiles[a2])) { dist[a2] = d; q.push(a2); } }
      if (cy > 1) { var a3 = cur - cols; if (dist[a3] === -1 && !isWallTank(world.tiles[a3])) { dist[a3] = d; q.push(a3); } }
      if (cy < rows - 2) { var a4 = cur + cols; if (dist[a4] === -1 && !isWallTank(world.tiles[a4])) { dist[a4] = d; q.push(a4); } }
    }
    return dist;
  }

  /**
   * 机器人：用 BFS 距离场在迷宫里找路，朝「离目标更近的邻格」行驶；
   * 车头对准目标时开火，贴住时也会开火。
   */
  function botThink(world, tank, dt) {
    var b = tank.bot;
    var lvl = b.level;
    tank.input.up = tank.input.down = tank.input.left = tank.input.right = false;
    tank.input.fire = false;

    var target = nearestEnemy(world, tank);

    // 看不见敌人（都死了，或对手隐身了）→ 在迷宫里巡逻找人，而不是站着不动
    if (!target) {
      tank.input.up = true;
      b.blind -= dt;
      if (!pathAhead(world, tank, 30)) {
        b.stuck = 0;
        b.turnDir = -b.turnDir || 1;
        tank.input.up = false;
        tank.input.left = b.turnDir < 0;
        tank.input.right = b.turnDir > 0;
      }
      return;
    }

    var dx = target.x - tank.x, dy = target.y - tank.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var want = Math.atan2(dx, -dy);

    // ---- 用 BFS 距离场决定该往哪个邻格走 ----
    var tcx = Math.floor(target.x / TILE), tcy = Math.floor(target.y / TILE);
    b.fieldT -= dt;
    if (!b.field || b.fieldT <= 0 || b.fieldTx !== tcx || b.fieldTy !== tcy) {
      b.field = bfsField(world, tcx, tcy);
      b.fieldTx = tcx; b.fieldTy = tcy;
      b.fieldT = lvl === 2 ? 0.25 : 0.45;
    }
    var ccx = Math.floor(tank.x / TILE), ccy = Math.floor(tank.y / TILE);
    var ci = ccy * world.cols + ccx;
    var here = (ci >= 0 && ci < b.field.length) ? b.field[ci] : -1;
    var goal = want;
    if (here > 0) {
      var cand = [[ccx - 1, ccy], [ccx + 1, ccy], [ccx, ccy - 1], [ccx, ccy + 1]];
      var bestD = here, bx = -1, by = -1;
      for (var k = 0; k < 4; k++) {
        var nx2 = cand[k][0], ny2 = cand[k][1];
        if (nx2 < 1 || ny2 < 1 || nx2 >= world.cols - 1 || ny2 >= world.rows - 1) continue;
        var d2 = b.field[ny2 * world.cols + nx2];
        if (d2 >= 0 && d2 < bestD) { bestD = d2; bx = nx2; by = ny2; }
      }
      if (bx >= 0) {
        var gx = bx * TILE + TILE / 2, gy = by * TILE + TILE / 2;
        goal = Math.atan2(gx - tank.x, -(gy - tank.y));
      }
    }

    // ---- 转向 + 前进 ----
    var tol = lvl === 2 ? 0.10 : (lvl === 1 ? 0.17 : 0.28);
    var diff = norm(goal - tank.angle);
    if (Math.abs(diff) > tol) {
      if (diff > 0) tank.input.right = true; else tank.input.left = true;
    }
    if (Math.abs(diff) < 0.6) tank.input.up = true;

    // ---- 开火 ----
    var aim = Math.abs(norm(want - tank.angle));
    if (dist < 34 || (aim < tol * 1.8 && pathAhead(world, tank, 26))) tank.input.fire = true;
    b.blind -= dt;
    if (b.blind <= 0) {
      b.blind = lvl === 2 ? 1.6 : (lvl === 1 ? 2.4 : 3.4);
      if (world.rand() < 0.35 && pathAhead(world, tank, 46)) tank.input.fire = true;
    }

    // ---- 卡住检测（只在「想走却走不动」时累计）----
    if (b.lastX != null) {
      var moved = Math.abs(tank.x - b.lastX) + Math.abs(tank.y - b.lastY);
      if (moved < 0.4 && tank.input.up) b.stuck += dt; else b.stuck = 0;
    }
    b.lastX = tank.x; b.lastY = tank.y;
    if (b.stuck > 0.7) {
      b.stuck = 0;
      b.field = null;                       // 强制重新寻路
      b.turnDir = -b.turnDir || 1;
      tank.input.up = false;
      tank.input.left = b.turnDir < 0;
      tank.input.right = b.turnDir > 0;
    }
  }

  /* ---------------- 主循环 ---------------- */
  function stepWorld(world, dt) {
    if (world.state !== 'play') return;
    if (world.freeze > 0) { world.freeze -= dt; return; }
    world.time += dt;

    var i, k;
    for (i = 0; i < world.tanks.length; i++) {
      var t = world.tanks[i];
      if (!t.alive) {
        if (t.lives > 0) {
          t.respawn -= dt;
          if (t.respawn <= 0) reviveTank(world, t);
        }
        continue;
      }
      if (t.cooldown > 0) t.cooldown = Math.max(0, t.cooldown - dt);
      if (t.invuln > 0) t.invuln = Math.max(0, t.invuln - dt);
      // 注意：power（穿甲弹）存的是"还剩几发"，不是秒数，不能按帧递减
      for (k in t.power) if (k !== 'power' && t.power[k] > 0) t.power[k] = Math.max(0, t.power[k] - dt);
      if (t.bot) botThink(world, t, dt);
      if (t.input.fire) fire(world, t);
      moveTank(world, t, dt);
    }
    updateBullets(world, dt);
    updatePowerups(world, dt);
  }

  function contenders(world) {
    var list = [];
    for (var i = 0; i < world.tanks.length; i++) {
      var t = world.tanks[i];
      if (t.alive || t.lives > 0) list.push(t);
    }
    return list;
  }

  function flushEvents(world) {
    var e = world.events;
    world.events = [];
    return e;
  }

  /** 取走并清空「本帧被摧毁的墙格」列表（联机快照据此把墙同步给客户端） */
  function flushTiles(world) {
    var d = world.tileChanges || [];
    world.tileChanges = [];
    return d;
  }

  function serialize(world) {
    var tanks = [], bullets = [], pus = [], i;
    for (i = 0; i < world.tanks.length; i++) {
      var t = world.tanks[i];
      tanks.push([t.id, Math.round(t.x * 10) / 10, Math.round(t.y * 10) / 10,
        Math.round(t.angle * 100) / 100, t.alive ? 1 : 0,
        t.lives, Math.round(t.invuln * 10) / 10, t.kills, t.deaths,
        // 技能剩余时间必须发真实秒数：以前发的是 0/1，客户端只能显示成恒定的"1s"
        Math.round(t.power.speed * 10) / 10, Math.round(t.power.rapid * 10) / 10,
        Math.round(t.power.triple * 10) / 10,
        // 穿甲弹这一位发的是"还剩几发"（0~AP_ROUNDS），不是秒数
        (t.power.power | 0),
        Math.round(t.power.shield * 10) / 10,
        Math.round((t.power.laser || 0) * 10) / 10, Math.round((t.power.stealth || 0) * 10) / 10]);
    }
    for (i = 0; i < world.bullets.length; i++) {
      var b = world.bullets[i];
      bullets.push([Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10,
        Math.round(b.angle * 100) / 100, b.owner, b.power ? 1 : 0]);
    }
    for (i = 0; i < world.powerups.length; i++) {
      var p = world.powerups[i];
      pus.push([Math.round(p.x), Math.round(p.y), p.type, Math.round(p.ttl * 10) / 10]);
    }
    return { t: tanks, b: bullets, p: pus };
  }

  return {
    TILE: TILE, EMPTY: EMPTY, BRICK: BRICK, STEEL: STEEL, WATER: WATER, BUSH: BUSH, BUSH_THIN: BUSH_THIN, GRAZED: GRAZED,
    setTile: setTile, wearBush: wearBush,
    TANK_R: TANK_R, TANK_SIZE: TANK_SIZE, BULLET_R: BULLET_R, MAX_BULLETS: MAX_BULLETS,
    TANK_SPEED: TANK_SPEED, BULLET_SPEED: BULLET_SPEED, ROT_SPEED: ROT_SPEED,
    SPEED_BOOST: SPEED_BOOST, MAX_TANK_SPEED: TANK_SPEED * SPEED_BOOST,
    BULLET_LIFE: BULLET_LIFE, MAX_BOUNCE: MAX_BOUNCE, ROUND_LIMIT: ROUND_LIMIT,
    FIRE_CD: FIRE_CD, RESPAWN_DELAY: RESPAWN_DELAY, INVULN: INVULN,
    POWERUP_TYPES: POWERUP_TYPES, PU_LABEL: PU_LABEL, PU_COLOR: PU_COLOR, PU_NAME: PU_NAME,
    PU_DESC: PU_DESC, SHIELD_BLOCKS: SHIELD_BLOCKS, powerupTypes: powerupTypes,
    pickPowerupType: pickPowerupType, POWERUP_GAP: POWERUP_GAP, POWERUP_JITTER: POWERUP_JITTER,
    LASER_RANGE: LASER_RANGE, LASER_CD: LASER_CD, LASER_HALF_W: LASER_HALF_W,
    LIVES_DEFAULT: LIVES_DEFAULT, MAX_LIVES: MAX_LIVES,
    DURATION: DURATION, POWERUP_TTL: POWERUP_TTL, AP_ROUNDS: AP_ROUNDS,
    TANK_COLORS: TANK_COLORS, TANK_COLOR_NAMES: TANK_COLOR_NAMES,
    TANK_STYLES: TANK_STYLES, TANK_STYLE_NAMES: TANK_STYLE_NAMES,
    STEEL_RATIO: STEEL_RATIO, MIN_SPAWN_DIST: MIN_SPAWN_DIST,
    WALL_STROKES: WALL_STROKES, BLOCK_COUNT: BLOCK_COUNT,
    BUSH_PATCHES: BUSH_PATCHES, BUSH_PATCH_MIN: BUSH_PATCH_MIN, BUSH_PATCH_MAX: BUSH_PATCH_MAX,
    norm: norm, dirX: dirX, dirY: dirY,
    rngFrom: rngFrom, createWorld: createWorld, addTank: addTank, findTank: findTank,
    stepWorld: stepWorld, moveTank: moveTank, fire: fire, canStand: canStand,
    circleFree: circleFree, tankAt: tankAt, botThink: botThink, makeBot: makeBot,
    nearestEnemy: nearestEnemy, hitTile: hitTile, applyPowerup: applyPowerup,
    bfsField: bfsField, spawnPowerup: spawnPowerup, serialize: serialize, flushEvents: flushEvents,
    flushTiles: flushTiles,
    contenders: contenders, reviveTank: reviveTank, damageTank: damageTank, inBush: inBush,
    fireLaser: fireLaser, fire: fire,
    buildMap: buildMap, buildLayout: buildLayout, pickSpawns: pickSpawns
  };
});
