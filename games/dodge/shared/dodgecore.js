/*!
 * DodgeCore —— 方块躲避共享内核（网格 / 碰撞 / 玩家 / 巡逻障碍 / 关卡校验 / 寻路机器人）
 * 浏览器: window.DodgeCore    Node: require('.../dodgecore.js')
 *
 * 玩法参考老版《史上最难的游戏》：
 *   · 关卡建在固定网格上（每格 GRID_SIZE=40），玩家是 36×36 的方格，画在格子中心
 *   · 障碍是圆形（半径 18，略小于半格），沿「网格中心点」连成的路径巡逻；
 *     也可以改成「圆周旋转」——绕某个格心画圆转圈，半径自己定
 *   · 玩家自由移动（不是逐格跳），撞到圆形障碍即死亡，回到最近的复活点
 *
 * ★ 出生点 / 复活点 / 终点都是「区域」而不是单个格子：
 *   它们本质是一组格子，四方向相邻的格子会被 groupCells 认成同一处（相邻自动吸附成整体）。
 *   玩家出生在整块区域的中心，走到终点区域里的任意一格都算到达。
 *   数据格式仍是格子列表，所以老的关卡 JSON 不用改一个字就能继续跑。
 *
 * ★ 核心难度来源 —— 「缝隙判定」：
 *   玩家是有体积的方格，两个相邻格子的障碍圆心相距 40px，两个圆之间的空隙只有 4px，
 *   远小于玩家 36px 的边长，所以玩家**绝对无法从两个相邻障碍中间挤过去**。
 *   这条规则不是特判出来的，而是「点到矩形最近点」这个标准算法自然得到的结果：
 *   只要算出圆心到玩家方格的最近点距离 < 半径，就算相交。
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') { module.exports = factory(); }
  else { root.DodgeCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var GRID_SIZE = 40;          // 每格 40×40 像素
  var PLAYER_SIZE = 28;        // 玩家方块边长：标准正方形，明显小于格子
  var OBSTACLE_RADIUS = 13;    // 圆形障碍半径（固定值，不给调）
  var PLAYER_SPEED = 160;      // 玩家速度（像素/秒）
  var DEATH_FREEZE = 0.45;     // 死亡后定格时间，给"被撞飞"的动画留点时间
  var RESPAWN_INVULN = 0.5;    // 复活后无敌时间，避免复活点边上被反复摩擦
  var RESCUE_CD = 3;           // 接应传送冷却（秒）
  var RESCUE_FLIGHT = 0.5;     // 接应传送动画时长（秒）
  var ARRIVE_EPS = 0.6;        // 到达路径点的判定容差（像素）
  var MAX_COLS = 60, MAX_ROWS = 45;   // 关卡尺寸上限（编辑器也用它做校验）
  var MIN_COLS = 4, MIN_ROWS = 4;
  var SPEED_MIN = 10, SPEED_MAX = 1000;   // 圆形障碍速度范围（px/s）——圆周旋转也用它
  var ORBIT_MIN = 20, ORBIT_MAX = 500;    // 圆周旋转的半径范围（像素）

  /** 4 名玩家的颜色（与本地多人、联机房间一致） */
  var PLAYER_COLORS = ['#4c8dff', '#2fd39b', '#f5a524', '#c85dff'];
  var PLAYER_COLOR_NAMES = ['蓝', '绿', '黄', '紫'];

  /** 本地多人 / 联机里每个玩家的键位说明（仅用于界面文案） */
  var LOCAL_KEY_DESC = [
    'W A S D',
    '↑ ↓ ← →',
    'I J K L',
    '小键盘 8 4 5 6'
  ];

  /* ================= 坐标换算 ================= */
  function gridToPixel(col, row) { return { x: col * GRID_SIZE, y: row * GRID_SIZE }; }
  function gridCenter(col, row) {
    return { x: col * GRID_SIZE + GRID_SIZE / 2, y: row * GRID_SIZE + GRID_SIZE / 2 };
  }
  function pixelToGrid(x, y) { return { col: Math.floor(x / GRID_SIZE), row: Math.floor(y / GRID_SIZE) }; }
  function cellKey(col, row) { return col + ',' + row; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ================= 关卡：创建 / 规格化 / 校验 ================= */

  /** 新建一个空关卡：四周自动加一圈墙，玩家跑不出去 */
  function createLevel(cols, rows) {
    cols = clamp(Math.round(cols) || 20, MIN_COLS, MAX_COLS);
    rows = clamp(Math.round(rows) || 15, MIN_ROWS, MAX_ROWS);
    var walls = [];
    for (var c = 0; c < cols; c++) { walls.push({ col: c, row: 0 }); walls.push({ col: c, row: rows - 1 }); }
    for (var r = 1; r < rows - 1; r++) { walls.push({ col: 0, row: r }); walls.push({ col: cols - 1, row: r }); }
    return {
      version: 1, id: 0, name: '新关卡', difficulty: 1,
      cols: cols, rows: rows,
      spawns: [], checkpoints: [], goals: [], walls: walls, obstacles: []
    };
  }

  function cellList(list) {
    var out = [], seen = {};
    (list || []).forEach(function (p) {
      if (!p) return;
      var col = Math.round(p.col), row = Math.round(p.row);
      if (!isFinite(col) || !isFinite(row)) return;
      var k = cellKey(col, row);
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ col: col, row: row });
    });
    return out;
  }

  /**
   * 把一堆格子按「四方向相邻」分成若干连通区域。
   * 出生点 / 复活点 / 终点都是区域：相邻的同属性格子会自然连成「一个整体」，
   * 编辑器里拖拽画出来的大块区域就是靠这个函数被认成一处的。
   */
  function groupCells(cells) {
    var set = {}, list = [];
    (cells || []).forEach(function (c) {
      if (!c) return;
      var k = cellKey(c.col, c.row);
      if (set[k]) return;
      set[k] = 1; list.push({ col: c.col, row: c.row });
    });
    var seen = {}, out = [], DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    list.forEach(function (start) {
      var sk = cellKey(start.col, start.row);
      if (seen[sk]) return;
      seen[sk] = 1;
      var queue = [start], head = 0, group = [];
      while (head < queue.length) {
        var cur = queue[head++];
        group.push(cur);
        for (var i = 0; i < 4; i++) {
          var nc = cur.col + DIRS[i][0], nr = cur.row + DIRS[i][1];
          var nk = cellKey(nc, nr);
          if (set[nk] && !seen[nk]) { seen[nk] = 1; queue.push({ col: nc, row: nr }); }
        }
      }
      out.push(group);
    });
    return out;
  }

  /** 一个连通区域的包围盒信息（编辑器画框、算出生位置都用它） */
  function regionInfo(group) {
    var minCol = Infinity, minRow = Infinity, maxCol = -Infinity, maxRow = -Infinity;
    group.forEach(function (c) {
      if (c.col < minCol) minCol = c.col;
      if (c.col > maxCol) maxCol = c.col;
      if (c.row < minRow) minRow = c.row;
      if (c.row > maxRow) maxRow = c.row;
    });
    return {
      cells: group,
      size: group.length,
      minCol: minCol, minRow: minRow, maxCol: maxCol, maxRow: maxRow,
      width: maxCol - minCol + 1, height: maxRow - minRow + 1,
      // 包围盒中心的像素坐标：整块区域的正中心，玩家站这里
      x: (minCol + maxCol + 1) * GRID_SIZE / 2,
      y: (minRow + maxRow + 1) * GRID_SIZE / 2
    };
  }

  /** 一组格子 → 区域列表 */
  function regions(cells) { return groupCells(cells).map(regionInfo); }

  /**
   * 区域的「落脚点」：优先用包围盒中心；万一中心被墙压住（L 形区域的中心可能落在墙角上），
   * 就退回到离中心最近的那个格子中心。
   */
  function regionAnchor(level, region) {
    if (!boxBlockedAt(level, region.x, region.y)) return { x: region.x, y: region.y };
    var best = null, bestD = Infinity;
    region.cells.forEach(function (c) {
      var p = gridCenter(c.col, c.row);
      if (boxBlockedAt(level, p.x, p.y)) return;
      var d = (p.x - region.x) * (p.x - region.x) + (p.y - region.y) * (p.y - region.y);
      if (d < bestD) { bestD = d; best = p; }
    });
    return best || { x: region.x, y: region.y };
  }

  /** 区域里离某个点最近的格子（求解器要用它把「落在区域里的点」换成 BFS 起点格） */
  function nearestCell(region, x, y) {
    var best = region.cells[0], bestD = Infinity;
    region.cells.forEach(function (c) {
      var p = gridCenter(c.col, c.row);
      var d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d < bestD) { bestD = d; best = c; }
    });
    return best;
  }

  /** 取某个设施字段的区域列表（带落脚点）。不缓存：设施列表都很小，随取随算最省心 */
  function facilityRegions(level, field) {
    return regions(level[field] || []).map(function (r) {
      r.anchor = regionAnchor(level, r);
      return r;
    });
  }

  /**
   * 区域外轮廓线段（像素坐标 [x1,y1,x2,y2]）：
   * 只画「外侧」的边，内部相邻的边不画 —— 于是整块区域看起来是一个完整的整体。
   * 内核不依赖 canvas，把线段丢给渲染方去画，游戏页和编辑器共用同一套轮廓。
   */
  function regionOutline(cells) {
    var set = {};
    (cells || []).forEach(function (c) { set[cellKey(c.col, c.row)] = 1; });
    var segs = [];
    (cells || []).forEach(function (c) {
      var x = c.col * GRID_SIZE, y = c.row * GRID_SIZE;
      if (!set[cellKey(c.col, c.row - 1)]) segs.push([x, y, x + GRID_SIZE, y]);
      if (!set[cellKey(c.col, c.row + 1)]) segs.push([x, y + GRID_SIZE, x + GRID_SIZE, y + GRID_SIZE]);
      if (!set[cellKey(c.col - 1, c.row)]) segs.push([x, y, x, y + GRID_SIZE]);
      if (!set[cellKey(c.col + 1, c.row)]) segs.push([x + GRID_SIZE, y, x + GRID_SIZE, y + GRID_SIZE]);
    });
    return segs;
  }

  /** 把外部 JSON 规格化成运行时关卡：补默认值、去重、裁剪非法坐标 */
  function normalizeLevel(raw) {
    raw = raw || {};
    var level = {
      version: 1,
      id: Number(raw.id) || 0,
      name: String(raw.name || '未命名关卡'),
      difficulty: clamp(Number(raw.difficulty) || 1, 1, 5),
      cols: clamp(Math.round(Number(raw.cols)) || 20, MIN_COLS, MAX_COLS),
      rows: clamp(Math.round(Number(raw.rows)) || 15, MIN_ROWS, MAX_ROWS),
      spawns: [], checkpoints: [], goals: [], walls: [], obstacles: []
    };
    var inB = function (p) { return p.col >= 0 && p.col < level.cols && p.row >= 0 && p.row < level.rows; };
    level.spawns = cellList(raw.spawns).filter(inB);
    level.checkpoints = cellList(raw.checkpoints).filter(inB);
    level.goals = cellList(raw.goals).filter(inB);
    level.walls = cellList(raw.walls).filter(inB);
    // 出生点/复活点/终点不会被墙压住（数据手改坏了也能开起来）
    var wallSet = {};
    level.walls.forEach(function (w) { wallSet[cellKey(w.col, w.row)] = 1; });
    var strip = function (list) { return list.filter(function (p) { return !wallSet[cellKey(p.col, p.row)]; }); };
    level.spawns = strip(level.spawns);
    level.checkpoints = strip(level.checkpoints);
    level.goals = strip(level.goals);

    level.obstacles = (raw.obstacles || []).map(function (o, i) {
      var path = cellList(o && o.path).filter(inB);
      if (!path.length && o && isFinite(o.col) && isFinite(o.row)) path = [{ col: Math.round(o.col), row: Math.round(o.row) }];
      var orbitRadius = Number(o && o.orbit && o.orbit.radius);
      var item = {
        id: String((o && o.id) || ('obstacle_' + (i + 1))),
        path: path,
        speed: clamp(Number(o && o.speed) || 100, SPEED_MIN, SPEED_MAX),
        loopMode: (o && o.loopMode === 'loop') ? 'loop' : 'pingpong',
        // 半径是固定值：老关卡 JSON 里存的 radius 一律忽略，直接钉死成 OBSTACLE_RADIUS，
        // 这样"看到的圆"和"判定用的圆"永远是同一个大小（编辑器里也早已删掉半径滑块）。
        radius: OBSTACLE_RADIUS
      };
      // 圆周旋转：绕着 path[0] 这一格转圈（半径自己定），和巡逻路径二选一
      if (isFinite(orbitRadius) && orbitRadius > 0) {
        item.orbit = {
          radius: clamp(Math.round(orbitRadius), ORBIT_MIN, ORBIT_MAX),
          cw: !(o && o.orbit && o.orbit.cw === false),        // 默认顺时针
          angle: Number(o && o.orbit && o.orbit.angle) || 0   // 起始角度（弧度），0 = 圆心正右方
        };
        // 圆心对齐：'cell' = 格子中心（默认），'cross' = 网格十字交点
        item.centerSnap = (o && o.centerSnap === 'cross') ? 'cross' : 'cell';
      }
      return item;
    }).filter(function (o) { return o.path.length > 0; });

    if (!level.spawns.length) level.spawns = [{ col: 1, row: Math.floor(level.rows / 2) }];
    // 预先把三类设施按连通区域算好，渲染与寻路都用它（区域里相邻格子自动算成"一处"）
    level.spawnRegions = facilityRegions(level, 'spawns');
    level.checkpointRegions = facilityRegions(level, 'checkpoints');
    level.goalRegions = facilityRegions(level, 'goals');
    return level;
  }

  /**
   * 关卡校验（编辑器和自检共用）：
   *   errors  = 不能保存的问题
   *   warnings = 能保存但会坑人的地方
   */
  function validateLevel(level) {
    var errors = [], warnings = [];
    level = level || {};
    var cols = Number(level.cols) || 0, rows = Number(level.rows) || 0;
    if (cols < MIN_COLS || cols > MAX_COLS || rows < MIN_ROWS || rows > MAX_ROWS) {
      errors.push('关卡尺寸必须在 ' + MIN_COLS + '×' + MIN_ROWS + ' ~ ' + MAX_COLS + '×' + MAX_ROWS + ' 之间');
    }
    var spawns = level.spawns || [], checkpoints = level.checkpoints || [], goals = level.goals || [];
    // 能保存、能玩的最低要求只有两条：有出生点、有终点。
    // 复活点是可选的 —— 没有复活点就死了回出生点，不该拦着人家保存。
    if (!spawns.length) errors.push('请至少放置 1 个出生点');
    if (!goals.length) errors.push('请至少放置 1 个终点（没有终点没法通关）');
    if (!checkpoints.length) warnings.push('还没有复活点：被撞后会回到出生点（不拦保存，随时可以再补）');
    var spawnRegions = groupCells(spawns).length, goalRegions = groupCells(goals).length;
    if (spawns.length > 1 && spawnRegions > 1) warnings.push('出生点有 ' + spawnRegions + ' 块互不相连的区域（多人时会分散出生）');
    if (goals.length > 1 && goalRegions > 1) warnings.push('终点有 ' + goalRegions + ' 块互不相连的区域');

    var used = {};
    function scan(list, label) {
      list.forEach(function (p) {
        var k = cellKey(p.col, p.row);
        if (p.col < 0 || p.col >= cols || p.row < 0 || p.row >= rows) { errors.push(label + ' (' + p.col + ',' + p.row + ') 在关卡范围外'); return; }
        if (used[k]) warnings.push(label + ' (' + p.col + ',' + p.row + ') 与「' + used[k] + '」重叠'); else used[k] = label;
      });
    }
    scan(level.walls || [], '墙体');
    scan(spawns, '出生点');
    scan(checkpoints, '复活点');
    scan(goals, '终点');

    // 出生/复活/终点不能压在墙上（normalizeLevel 会悄悄删掉它们，这里要明说）
    var wallSet = {};
    (level.walls || []).forEach(function (w) { wallSet[cellKey(w.col, w.row)] = 1; });
    [['出生点', spawns], ['复活点', checkpoints], ['终点', goals]].forEach(function (pair) {
      pair[1].forEach(function (p) {
        if (wallSet[cellKey(p.col, p.row)]) errors.push(pair[0] + ' (' + p.col + ',' + p.row + ') 压在墙体上');
      });
    });

    // 障碍轨迹与设施重叠的提醒：出生点/复活点不再是安全区（站里面照样被撞死），终点保留免死
    (level.obstacles || []).forEach(function (o) {
      (o.path || []).forEach(function (p) {
        spawns.forEach(function (s) {
          if (s.col === p.col && s.row === p.row) warnings.push('出生点 (' + s.col + ',' + s.row + ') 在障碍「' + (o.id || '') + '」的轨迹上 —— 出生点不是安全区，出生/复活落在这里照样会被撞死，建议避开');
        });
        checkpoints.forEach(function (s) {
          if (s.col === p.col && s.row === p.row) warnings.push('复活点 (' + s.col + ',' + s.row + ') 在障碍「' + (o.id || '') + '」的轨迹上 —— 复活点不是安全区，复活到这里只有 0.5 秒无敌，过了照样被撞死，建议避开');
        });
        goals.forEach(function (s) {
          if (s.col === p.col && s.row === p.row) warnings.push('终点 (' + s.col + ',' + s.row + ') 在障碍「' + (o.id || '') + '」的轨迹上 —— 终点区内不会被撞死（到达优先），不影响通关');
        });
      });
    });

    // 路径障碍的「起始点」（path[0]）不能重复：路径可以随便相交，但两个障碍不能共用同一个家。
    // 圆周旋转障碍的 path[0] 只是圆心锚点，不占空间，不受这条约束。
    var startSeen = {};
    (level.obstacles || []).forEach(function (o) {
      if (o.orbit) return;
      var s = o.path && o.path[0];
      if (!s) return;
      var k = cellKey(s.col, s.row);
      if (startSeen[k]) errors.push('障碍「' + (o.id || '') + '」的起始点 (' + s.col + ',' + s.row + ') 和「' + startSeen[k] + '」重叠 —— 起始点不能重复');
      else startSeen[k] = (o.id || '');
    });

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  /* ================= 世界 ================= */

  function isWallAt(level, col, row) {
    if (col < 0 || row < 0 || col >= level.cols || row >= level.rows) return true;
    var hit = false;
    for (var i = 0; i < level.walls.length; i++) {
      if (level.walls[i].col === col && level.walls[i].row === row) { hit = true; break; }
    }
    return hit;
  }

  /** 关卡里所有静态「挡路」的格子（墙 + 只在一个点上不动的障碍），寻路用 */
  function staticBlockers(level) {
    var set = {}, list = [];
    level.walls.forEach(function (w) { var k = cellKey(w.col, w.row); if (!set[k]) { set[k] = 1; list.push(k); } });
    (level.obstacles || []).forEach(function (o) {
      if (o.path.length === 1) { var k = cellKey(o.path[0].col, o.path[0].row); if (!set[k]) { set[k] = 1; list.push(k); } }
    });
    return set;
  }

  /** 生成巡逻障碍的运行时状态：沿路径点依次移动，位置是浮点像素坐标 */
  function createObstacle(data) {
    var first = gridCenter(data.path[0].col, data.path[0].row);
    var o = {
      id: data.id, path: data.path.slice(), speed: data.speed,
      loopMode: data.loopMode, radius: data.radius,
      x: first.x, y: first.y,
      seg: 0,          // 当前正走向 path[seg + dir]
      dir: 1,          // pingpong 用：+1 前进，-1 返回
      static: data.path.length === 1
    };
    // 圆周旋转：圆心是 path[0]（对齐方式可选「格心」或「网格十字交点」），障碍绕着它转圈。
    // 圆心只是轨迹锚点，不占空间 —— 可以落在出生点/复活点/终点上
    // （注意：出生/复活点不保命，转圈扫过去照样撞死人，只有终点区免死）。
    if (data.orbit) {
      var cen = (data.centerSnap === 'cross') ? gridToPixel(data.path[0].col, data.path[0].row) : first;
      o.orbit = { radius: data.orbit.radius, cw: data.orbit.cw !== false };
      o.centerSnap = (data.centerSnap === 'cross') ? 'cross' : 'cell';
      o.angle = data.orbit.angle || 0;
      o.cx = cen.x; o.cy = cen.y;
      o.static = false;
      o.x = o.cx + o.orbit.radius * Math.cos(o.angle);
      o.y = o.cy + o.orbit.radius * Math.sin(o.angle);
    }
    return o;
  }

  /** 圆周障碍的圆心像素坐标（编辑器画图与放置都用同一个算法） */
  function orbitCenter(o) {
    var p = o.path[0];
    return (o.centerSnap === 'cross') ? gridToPixel(p.col, p.row) : gridCenter(p.col, p.row);
  }

  /** 建立一个可玩的世界（含障碍物运行时状态） */
  function createWorld(level) {
    level = level.cols ? level : normalizeLevel(level);
    return {
      level: level,
      obstacles: level.obstacles.map(createObstacle),
      time: 0
    };
  }

  /** 推进所有圆形障碍（线性插值，浮点位置） */
  function stepObstacles(world, dt) {
    var list = world.obstacles;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      // 圆周旋转：角速度 = 线速度 ÷ 半径（v = ωr），半径越小转得越快
      if (o.orbit) {
        o.angle += (o.speed / o.orbit.radius) * dt * (o.orbit.cw ? 1 : -1);
        if (o.angle > Math.PI * 2) o.angle -= Math.PI * 2;
        else if (o.angle < 0) o.angle += Math.PI * 2;
        o.x = o.cx + o.orbit.radius * Math.cos(o.angle);
        o.y = o.cy + o.orbit.radius * Math.sin(o.angle);
        continue;
      }
      if (o.static) continue;
      var remain = o.speed * dt;
      var guard = 0;
      while (remain > 0 && guard++ < 64) {
        var nextIndex = o.seg + o.dir;
        if (nextIndex < 0 || nextIndex >= o.path.length) {
          // 到端点：往返就掉头，循环就绕回起点
          if (o.loopMode === 'loop') {
            var wrap = (o.seg + o.dir + o.path.length) % o.path.length;
            o.seg = wrap === o.seg ? 0 : o.seg;
            nextIndex = wrap;
          } else {
            o.dir = -o.dir;
            nextIndex = o.seg + o.dir;
          }
          if (nextIndex < 0 || nextIndex >= o.path.length) { o.dir = 1; nextIndex = 0; }
        }
        var target = gridCenter(o.path[nextIndex].col, o.path[nextIndex].row);
        var dx = target.x - o.x, dy = target.y - o.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= remain || dist < 1e-6) {
          o.x = target.x; o.y = target.y; o.seg = nextIndex; remain -= dist;
        } else {
          o.x += (dx / dist) * remain; o.y += (dy / dist) * remain; remain = 0;
        }
      }
    }
    world.time += dt;
  }

  /* ================= 碰撞 ================= */

  /**
   * 点到矩形最近点 —— 圆与玩家方格的碰撞判定。
   * 这个算法天然实现「不能穿过两个障碍中间的缝隙」：玩家有体积，
   * 两个圆心较近时中间空隙小于玩家边长，玩家方格必然与某个圆相交。
   */
  function rectCircleCollide(rect, cx, cy, r) {
    var closestX = clamp(cx, rect.x, rect.x + rect.w);
    var closestY = clamp(cy, rect.y, rect.y + rect.h);
    var dx = cx - closestX, dy = cy - closestY;
    return dx * dx + dy * dy < r * r;
  }

  function playerRect(p) {
    return { x: p.x - PLAYER_SIZE / 2, y: p.y - PLAYER_SIZE / 2, w: PLAYER_SIZE, h: PLAYER_SIZE };
  }

  /** 以 (x,y) 为中心放置玩家方格时，是否压到墙或越界（分轴检测靠它实现贴墙滑动） */
  function boxBlockedAt(level, x, y, half) {
    half = half || PLAYER_SIZE / 2;
    var c0 = Math.floor((x - half) / GRID_SIZE);
    var c1 = Math.floor((x + half - 0.001) / GRID_SIZE);
    var r0 = Math.floor((y - half) / GRID_SIZE);
    var r1 = Math.floor((y + half - 0.001) / GRID_SIZE);
    for (var c = c0; c <= c1; c++) {
      for (var r = r0; r <= r1; r++) {
        if (isWallAt(level, c, r)) return true;
      }
    }
    return false;
  }

  /** 某个位置是否会被圆形障碍撞到（可忽略免疫期与已到达的玩家） */
  function hitsObstacle(world, x, y, pad) {
    var rect = { x: x - PLAYER_SIZE / 2, y: y - PLAYER_SIZE / 2, w: PLAYER_SIZE, h: PLAYER_SIZE };
    for (var i = 0; i < world.obstacles.length; i++) {
      var o = world.obstacles[i];
      if (rectCircleCollide(rect, o.x, o.y, o.radius + (pad || 0))) return o;
    }
    return null;
  }

  /* ================= 安全区（只有终点免死） ================= */

  /**
   * 玩家方格（含边界线）是否处在「终点区」里：终点区域的任意一格。
   * 出生点 / 复活点**不是**安全区：站在里面被圆形障碍碰到照样死亡
   * （复活只有 RESPAWN_INVULN 的短暂无敌，过了就正常判死）。
   * 终点保留免死：走到终点格边缘那一瞬，到达判定紧接着发生，不该被同帧的障碍抢杀。
   * 障碍的轨迹依旧可以随便画（圆心不占空间、路径可以穿过任何格子）。
   */
  function inSafeZone(level, x, y) {
    var half = PLAYER_SIZE / 2;
    var list = level.goals || [];
    for (var k = 0; k < list.length; k++) {
      var cx = list[k].col * GRID_SIZE, cy = list[k].row * GRID_SIZE;
      if (x + half >= cx && x - half <= cx + GRID_SIZE && y + half >= cy && y - half <= cy + GRID_SIZE) return true;
    }
    return false;
  }

  /* ================= 玩家 ================= */

  /**
   * 第 index 个出生区域的落脚点（多人时按人分配不同出生区域）。
   * 区域可以是一大片格子，取整块的中心，玩家就站在区域正中间。
   */
  function spawnPointOf(level, index) {
    var regs = facilityRegions(level, 'spawns');
    if (!regs.length) return { x: GRID_SIZE / 2, y: GRID_SIZE / 2 };
    return { x: regs[index % regs.length].anchor.x, y: regs[index % regs.length].anchor.y };
  }

  /**
   * 创建玩家。index 决定用哪个出生点、什么颜色。
   * state: playing（正在跑）/ arrived（已到终点）/ dead（刚被撞，等复活）
   */
  function createPlayer(world, index, name) {
    var p = spawnPointOf(world.level, index);
    return {
      index: index,
      name: name || ('玩家' + (index + 1)),
      color: PLAYER_COLORS[index % PLAYER_COLORS.length],
      x: p.x, y: p.y,
      state: 'playing',
      deadTimer: 0,
      invuln: 0,
      cp: null,           // 最近经过的复活点（没有就用出生点）
      deaths: 0,
      arriveTime: 0,
      rescueCd: 0,
      fx: null            // 接应飞行的临时动画数据（客户端用）
    };
  }

  /**
   * 复活位置：踩过的复活点（整块区域）中心；没踩过任何复活点就回自己的出生区域中心。
   */
  function respawnSpot(player, level) {
    if (player.cp) {
      var cpRegs = facilityRegions(level, 'checkpoints');
      for (var i = 0; i < cpRegs.length; i++) {
        for (var k = 0; k < cpRegs[i].cells.length; k++) {
          if (sameCell(player.cp, cpRegs[i].cells[k])) return { x: cpRegs[i].anchor.x, y: cpRegs[i].anchor.y };
        }
      }
    }
    return spawnPointOf(level, player.index);
  }

  /** 复活：回到最近的复活点（没经过任何复活点就回出生点），带短暂无敌 */
  function respawn(world, player) {
    var p = respawnSpot(player, world.level);
    player.x = p.x; player.y = p.y;
    player.state = 'playing';
    player.deadTimer = 0;
    player.invuln = RESPAWN_INVULN;
  }

  function sameCell(a, b) { return a && b && a.col === b.col && a.row === b.row; }

  /**
   * 推进一个玩家。
   * input: { up, down, left, right } 布尔量（八方向，斜向会做归一化，不会更快）
   * 返回事件：{ moved, died, respawned, arrived, checkpoint }
   */
  function stepPlayer(world, player, input, dt) {
    var ev = { moved: false, died: false, respawned: false, arrived: false, checkpoint: false };
    if (!player || player.state === 'arrived') return ev;

    // 死亡定格 → 复活
    if (player.state === 'dead') {
      player.deadTimer -= dt;
      if (player.deadTimer <= 0) { respawn(world, player); ev.respawned = true; }
      return ev;
    }

    var level = world.level;
    if (player.invuln > 0) player.invuln = Math.max(0, player.invuln - dt);
    if (player.rescueCd > 0) player.rescueCd = Math.max(0, player.rescueCd - dt);

    input = input || {};
    var dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    var dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    if (dx || dy) {
      var len = Math.sqrt(dx * dx + dy * dy);
      dx = dx / len; dy = dy / len;                 // 斜向归一化，保证速度恒定
      var stepX = dx * PLAYER_SPEED * dt;
      var stepY = dy * PLAYER_SPEED * dt;
      // 分轴检测：撞墙时该轴停下，另一轴照常走 —— 于是贴着墙也能滑动
      if (!boxBlockedAt(level, player.x + stepX, player.y)) { player.x += stepX; ev.moved = true; }
      if (!boxBlockedAt(level, player.x, player.y + stepY)) { player.y += stepY; ev.moved = true; }

      // 经过复活点就把它记为「当前复活点」
      var at = pixelToGrid(player.x, player.y);
      for (var i = 0; i < level.checkpoints.length; i++) {
        if (level.checkpoints[i].col === at.col && level.checkpoints[i].row === at.row) {
          if (!sameCell(player.cp, level.checkpoints[i])) { player.cp = level.checkpoints[i]; ev.checkpoint = true; }
          break;
        }
      }
    }

    // 碰到圆形障碍 → 死亡（无敌期内不判定；出生/复活点不保命，只有终点区内不判死）
    if (player.invuln <= 0) {
      var hit = hitsObstacle(world, player.x, player.y, 0);
      if (hit && !inSafeZone(level, player.x, player.y)) {
        player.state = 'dead';
        player.deadTimer = DEATH_FREEZE;
        player.deaths++;
        player.hitBy = hit.id;
        ev.died = true;
        return ev;
      }
    }

    // 到达终点？
    var g = pixelToGrid(player.x, player.y);
    for (var k = 0; k < level.goals.length; k++) {
      if (level.goals[k].col === g.col && level.goals[k].row === g.row) {
        player.state = 'arrived';
        ev.arrived = true;
        break;
      }
    }
    return ev;
  }

  /** 所有人都到达终点 → 本关通关 */
  function allArrived(players) {
    if (!players.length) return false;
    return players.every(function (p) { return p.state === 'arrived'; });
  }

  /**
   * 接应传送（已到达的玩家救队友）：把所有还在跑/正在复活的队友直接送到终点。
   * 服务器与本地多人共用这一份逻辑。
   * 返回被传送的玩家列表（带上起点用于画飞行动画）。
   */
  function rescue(world, players, byIndex) {
    var from = players[byIndex];
    if (!from || from.state !== 'arrived' || from.rescueCd > 0) return [];
    var goal = world.level.goals[0];
    if (!goal) return [];
    var target = gridCenter(goal.col, goal.row);
    var moved = [];
    players.forEach(function (p) {
      if (p === from || p.state === 'arrived') return;
      moved.push({ index: p.index, fromX: p.x, fromY: p.y });
      p.x = target.x; p.y = target.y;
      p.state = 'arrived';
      p.invuln = 0;
      p.rescued = true;
      p.fx = { fromX: moved[moved.length - 1].fromX, fromY: moved[moved.length - 1].fromY, t: 0 };
    });
    from.rescueCd = RESCUE_CD;
    world.lastRescue = { by: byIndex, at: world.time };
    return moved;
  }

  /** 重置整关（本地重开 / 联机重来） */
  function resetLevel(world, players) {
    world.obstacles = world.level.obstacles.map(createObstacle);
    world.time = 0;
    players.forEach(function (p) {
      var s = spawnPointOf(world.level, p.index);
      p.x = s.x; p.y = s.y;
      p.state = 'playing'; p.deadTimer = 0; p.invuln = 0; p.cp = null;
      p.rescued = false; p.fx = null; p.rescueCd = 0; p.arriveTime = 0;
    });
  }

  /* ================= 可通关判定（时间展开搜索，编辑器与自检共用） ================= */

  /**
   * 「这一关到底能不能过？」
   *
   * 障碍的运动是完全确定的（沿路径匀速巡逻），所以可以把时间切成小片：
   * 状态 = (站在哪一格, 第几个时间片)，每一步要么原地等、要么走到相邻一格，
   * 只要全程不会被任何圆形障碍撞到，就是一条可行的通关路线。
   * 用一个最朴素的 BFS 在 (格子 × 时间) 上搜，找到终点格即判可通关。
   *
   * 注意：它算的是「沿格子中心走、每 1/4 秒做一个决定」的保守模型 ——
   * 真实玩家可以贴边走、可以踩在格子任意位置，只会更容易，
   * 所以这里判「不行」不一定真的不行，判「行」则一定行。
   */
  var SOLVE_STEP = 1 / 16;      // 时间片 62.5ms
  var SOLVE_MOVE_TICKS = 4;     // 走一格 = 0.25 秒（40px ÷ 160px/s）
  var DEFAULT_SOLVE_SECONDS = 60;

  function playerSafeAt(circles, x, y) {
    var rect = playerRect({ x: x, y: y });
    for (var i = 0; i < circles.length; i++) {
      if (rectCircleCollide(rect, circles[i].x, circles[i].y, circles[i].r)) return false;
    }
    return true;
  }

  /** 预先算好每个时间片上障碍的位置（分辨率 SOLVE_STEP） */
  function obstacleTimeline(level, ticks) {
    var sim = createWorld(level);
    var frames = [sim.obstacles.map(function (o) { return { x: o.x, y: o.y, r: o.radius }; })];
    for (var t = 1; t < ticks; t++) {
      stepObstacles(sim, SOLVE_STEP);
      frames.push(sim.obstacles.map(function (o) { return { x: o.x, y: o.y, r: o.radius }; }));
    }
    return frames;
  }

  /**
   * 返回 { ok, time, ticks, path }：ok=true 表示存在一条通关路线，time 是到达用时（秒）。
   * path 是这条最优路线（按格子中心走的落脚点序列，每项带它到达的时间片 t），
   * 编辑器「检查能否通关」的机器人回放就是照着它播的 —— 播完的用时必须等于 time。
   */
  function solveReachable(level, seconds) {
    level = level.cols ? level : normalizeLevel(level);
    var limit = Math.max(5, seconds || DEFAULT_SOLVE_SECONDS);
    var ticks = Math.floor(limit / SOLVE_STEP);
    var frames = obstacleTimeline(level, ticks);
    var cols = level.cols, rows = level.rows;

    var spawnRegs = facilityRegions(level, 'spawns');
    var goals = {};
    level.goals.forEach(function (g) { goals[cellKey(g.col, g.row)] = 1; });
    if (!spawnRegs.length || !level.goals.length) return { ok: false, time: 0, reason: '缺少出生点或终点' };
    if (level.goals.some(function (g) { return isWallAt(level, g.col, g.row); })) return { ok: false, time: 0, reason: '终点在墙里' };
    // 出生点已经是个区域：从区域里离落脚点最近的那一格开始搜
    var startCell = nearestCell(spawnRegs[0], spawnRegs[0].anchor.x, spawnRegs[0].anchor.y);
    var spawnPos = spawnRegs[0].anchor;
    // 与游戏同一套判定：只有终点区免死，出生点/复活点上被扫到照样算死
    function safeAt(tick, x, y) {
      return inSafeZone(level, x, y) || playerSafeAt(frames[tick], x, y);
    }
    // 出生点开局就被障碍压住 → 起手即死、复活后仍在原地，等于过不去
    if (!safeAt(0, spawnPos.x, spawnPos.y)) {
      return { ok: false, time: 0, reason: '出生点落在障碍巡逻线上，开局即死' };
    }

    // BFS：(格子, 时间片)
    // 记下来源，命中终点时就能把整条最优路线拼出来 —— 编辑器要照着它回放一遍。
    var startKey = startCell.col + ',' + startCell.row + '@0';
    var seen = {};
    var from = {};                 // key -> 上一步的 key（null = 起点）
    seen[startKey] = 1;
    from[startKey] = null;
    var queue = [{ col: startCell.col, row: startCell.row, t: 0 }];
    var head = 0;
    function keyOf(st) { return st.col + ',' + st.row + '@' + st.t; }
    function tracePath(endKey) {
      var out = [], k = endKey;
      while (k) {
        var parts = k.split('@');
        out.push({ col: parseInt(parts[0].split(',')[0], 10), row: parseInt(parts[0].split(',')[1], 10), t: parseInt(parts[1], 10) });
        k = from[k];
      }
      return out.reverse();
    }
    while (head < queue.length) {
      var cur = queue[head++];
      if (goals[cellKey(cur.col, cur.row)]) {
        return { ok: true, time: cur.t * SOLVE_STEP, ticks: cur.t, path: tracePath(keyOf(cur)) };
      }

      // 原地等一个时间片
      var nt = cur.t + 1;
      if (nt < ticks) {
        var k = keyOf({ col: cur.col, row: cur.row, t: nt });
        if (!seen[k]) {
          var pc = gridCenter(cur.col, cur.row);
          if (safeAt(nt, pc.x, pc.y)) {
            seen[k] = 1; from[k] = keyOf(cur);
            queue.push({ col: cur.col, row: cur.row, t: nt });
          }
        }
      }
      // 走到相邻格子
      var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var d = 0; d < dirs.length; d++) {
        var nc = cur.col + dirs[d][0], nr = cur.row + dirs[d][1];
        if (isWallAt(level, nc, nr)) continue;
        var tick = cur.t + SOLVE_MOVE_TICKS;
        if (tick >= ticks) continue;
        var key = keyOf({ col: nc, row: nr, t: tick });
        if (seen[key]) continue;
        var a = gridCenter(cur.col, cur.row), b = gridCenter(nc, nr);
        var free = true;
        for (var s = 1; s <= SOLVE_MOVE_TICKS && free; s++) {           // 走的过程中每 1/4 都要安全
          var r = s / SOLVE_MOVE_TICKS;
          if (!safeAt(cur.t + s, a.x + (b.x - a.x) * r, a.y + (b.y - a.y) * r)) free = false;
        }
        if (!free) continue;
        seen[key] = 1; from[key] = keyOf(cur);
        queue.push({ col: nc, row: nr, t: tick });
      }
    }
    return { ok: false, time: 0, reason: '在 ' + limit + ' 秒内找不到安全路线' };
  }

  /**
   * 求解路线上「第 f 个时间片」（f 可以是小数）机器人在哪。
   * 编辑器画回放、自检离线复算，都走这一个函数 —— 只有一份插值实现，
   * "回放里看到的" 才真的等于 "求解时算的"。
   * 相邻两个落脚点之间差 SOLVE_MOVE_TICKS 片（走一格），差 1 表示原地等一拍。
   */
  function solveBotPos(path, f) {
    if (!path || !path.length) return null;
    if (f <= path[0].t) return gridCenter(path[0].col, path[0].row);
    for (var i = 1; i < path.length; i++) {
      var a = path[i - 1], b = path[i];
      if (f > b.t) continue;
      var pa = gridCenter(a.col, a.row);
      var span = b.t - a.t;
      if (span <= 1) return pa;                       // 原地等一拍
      var pb = gridCenter(b.col, b.row);
      var k = (f - a.t) / span;
      return { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k };
    }
    var last = path[path.length - 1];
    return gridCenter(last.col, last.row);
  }

  /* ================= 格子连通性（编辑器用：终点是不是被墙彻底堵死） ================= */

  /** 只考虑墙体，出生点能否走到终点（能走到不代表能躲开障碍，但走不到就一定不能通关） */
  function reachable(level) {
    level = level.cols ? level : normalizeLevel(level);
    if (!level.spawns.length || !level.goals.length) return false;
    var spawnRegs = facilityRegions(level, 'spawns');
    if (!spawnRegs.length) return false;
    var start = nearestCell(spawnRegs[0], spawnRegs[0].anchor.x, spawnRegs[0].anchor.y);
    var goalSet = {};
    level.goals.forEach(function (g) { goalSet[cellKey(g.col, g.row)] = 1; });
    var seen = {}, queue = [[start.col, start.row]];
    seen[cellKey(start.col, start.row)] = 1;
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (queue.length) {
      var cur = queue.shift();
      if (goalSet[cellKey(cur[0], cur[1])]) return true;
      for (var i = 0; i < dirs.length; i++) {
        var nc = cur[0] + dirs[i][0], nr = cur[1] + dirs[i][1];
        if (isWallAt(level, nc, nr)) continue;
        var k = cellKey(nc, nr);
        if (seen[k]) continue;
        seen[k] = 1;
        queue.push([nc, nr]);
      }
    }
    return false;
  }

  /* ================= 序列化（联机快照用） ================= */
  function serializeLevel(level) {
    return {
      id: level.id, name: level.name, difficulty: level.difficulty,
      cols: level.cols, rows: level.rows,
      spawns: level.spawns, checkpoints: level.checkpoints, goals: level.goals,
      walls: level.walls, obstacles: level.obstacles
    };
  }

  return {
    /* 常量 */
    GRID_SIZE: GRID_SIZE, PLAYER_SIZE: PLAYER_SIZE, OBSTACLE_RADIUS: OBSTACLE_RADIUS,
    PLAYER_SPEED: PLAYER_SPEED, DEATH_FREEZE: DEATH_FREEZE, RESPAWN_INVULN: RESPAWN_INVULN,
    RESCUE_CD: RESCUE_CD, RESCUE_FLIGHT: RESCUE_FLIGHT,
    MAX_COLS: MAX_COLS, MAX_ROWS: MAX_ROWS, MIN_COLS: MIN_COLS, MIN_ROWS: MIN_ROWS,
    SPEED_MIN: SPEED_MIN, SPEED_MAX: SPEED_MAX, ORBIT_MIN: ORBIT_MIN, ORBIT_MAX: ORBIT_MAX,
    PLAYER_COLORS: PLAYER_COLORS, PLAYER_COLOR_NAMES: PLAYER_COLOR_NAMES, LOCAL_KEY_DESC: LOCAL_KEY_DESC,
    /* 坐标 */
    gridToPixel: gridToPixel, gridCenter: gridCenter, pixelToGrid: pixelToGrid, cellKey: cellKey,
    /* 设施区域（出生点 / 复活点 / 终点都是一片区域） */
    groupCells: groupCells, regions: regions, regionAnchor: regionAnchor, nearestCell: nearestCell,
    facilityRegions: facilityRegions, regionOutline: regionOutline,
    /* 关卡 */
    createLevel: createLevel, normalizeLevel: normalizeLevel, validateLevel: validateLevel,
    isWallAt: isWallAt, staticBlockers: staticBlockers, serializeLevel: serializeLevel,
    /* 世界与玩家 */
    createWorld: createWorld, stepObstacles: stepObstacles, createPlayer: createPlayer,
    stepPlayer: stepPlayer, respawn: respawn, resetLevel: resetLevel, allArrived: allArrived,
    rescue: rescue, respawnSpot: respawnSpot,
    /* 碰撞 */
    rectCircleCollide: rectCircleCollide, playerRect: playerRect, boxBlockedAt: boxBlockedAt,
    hitsObstacle: hitsObstacle,
    /* 安全区（仅终点内不判死）与圆周圆心 */
    inSafeZone: inSafeZone, orbitCenter: orbitCenter,
    /* 关卡可通关性（编辑器与自检共用） */
    solveReachable: solveReachable, reachable: reachable, obstacleTimeline: obstacleTimeline,
    solveBotPos: solveBotPos,
    SOLVE_STEP: SOLVE_STEP, SOLVE_MOVE_TICKS: SOLVE_MOVE_TICKS
  };
});
