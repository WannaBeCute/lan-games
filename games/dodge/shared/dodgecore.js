/*!
 * DodgeCore —— 方块躲避共享内核（网格 / 碰撞 / 玩家 / 巡逻障碍 / 关卡校验 / 寻路机器人）
 * 浏览器: window.DodgeCore    Node: require('.../dodgecore.js')
 *
 * 玩法参考老版《史上最难的游戏》：
 *   · 关卡建在固定网格上（每格 GRID_SIZE=40），玩家是 36×36 的方格，画在格子中心
 *   · 障碍是圆形（半径 18，略小于半格），沿「网格中心点」连成的路径巡逻
 *   · 玩家自由移动（不是逐格跳），撞到圆形障碍即死亡，回到最近的复活点
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
  var PLAYER_SIZE = 36;        // 玩家方格边长（比格子略小，站得进去）
  var OBSTACLE_RADIUS = 18;    // 圆形障碍半径（略小于半格 20）
  var PLAYER_SPEED = 160;      // 玩家速度（像素/秒）
  var DEATH_FREEZE = 0.45;     // 死亡后定格时间，给"被撞飞"的动画留点时间
  var RESPAWN_INVULN = 0.5;    // 复活后无敌时间，避免复活点边上被反复摩擦
  var RESCUE_CD = 3;           // 接应传送冷却（秒）
  var RESCUE_FLIGHT = 0.5;     // 接应传送动画时长（秒）
  var ARRIVE_EPS = 0.6;        // 到达路径点的判定容差（像素）
  var MAX_COLS = 60, MAX_ROWS = 45;   // 关卡尺寸上限（编辑器也用它做校验）
  var MIN_COLS = 4, MIN_ROWS = 4;

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
      return {
        id: String((o && o.id) || ('obstacle_' + (i + 1))),
        path: path,
        speed: clamp(Number(o && o.speed) || 100, 10, 400),
        loopMode: (o && o.loopMode === 'loop') ? 'loop' : 'pingpong',
        radius: clamp(Number(o && o.radius) || OBSTACLE_RADIUS, 6, GRID_SIZE / 2 - 2)
      };
    }).filter(function (o) { return o.path.length > 0; });

    if (!level.spawns.length) level.spawns = [{ col: 1, row: Math.floor(level.rows / 2) }];
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
    if (!spawns.length) errors.push('请至少放置 1 个出生点');
    if (!checkpoints.length) errors.push('请至少放置 1 个复活点');
    if (!goals.length) warnings.push('还没有终点：这关无法通关（可以先保存，之后再补）');

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

    // 出生点/复活点与障碍同格 → 一复活就死
    (level.obstacles || []).forEach(function (o) {
      (o.path || []).forEach(function (p) {
        spawns.forEach(function (s) {
          if (s.col === p.col && s.row === p.row) warnings.push('出生点 (' + s.col + ',' + s.row + ') 就在障碍「' + (o.id || '') + '」的巡逻点上，开局即死');
        });
        checkpoints.forEach(function (s) {
          if (s.col === p.col && s.row === p.row) warnings.push('复活点 (' + s.col + ',' + s.row + ') 就在障碍「' + (o.id || '') + '」的巡逻点上，复活即死');
        });
      });
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
    return {
      id: data.id, path: data.path.slice(), speed: data.speed,
      loopMode: data.loopMode, radius: data.radius,
      x: first.x, y: first.y,
      seg: 0,          // 当前正走向 path[seg + dir]
      dir: 1,          // pingpong 用：+1 前进，-1 返回
      static: data.path.length === 1
    };
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

  /* ================= 玩家 ================= */

  function spawnPointOf(level, index) {
    var s = level.spawns[index % level.spawns.length] || level.spawns[0];
    return gridCenter(s.col, s.row);
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

  function respawnSpot(player, level) {
    var cell = player.cp || level.spawns[player.index % level.spawns.length] || level.spawns[0];
    return gridCenter(cell.col, cell.row);
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

    // 碰到圆形障碍 → 死亡（无敌期内不判定）
    if (player.invuln <= 0) {
      var hit = hitsObstacle(world, player.x, player.y, 0);
      if (hit) {
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
   * 返回 { ok, time, ticks }：ok=true 表示存在一条通关路线，time 是到达用时（秒）。
   */
  function solveReachable(level, seconds) {
    level = level.cols ? level : normalizeLevel(level);
    var limit = Math.max(5, seconds || DEFAULT_SOLVE_SECONDS);
    var ticks = Math.floor(limit / SOLVE_STEP);
    var frames = obstacleTimeline(level, ticks);
    var cols = level.cols, rows = level.rows;

    var spawn = level.spawns[0];
    var goals = {};
    level.goals.forEach(function (g) { goals[cellKey(g.col, g.row)] = 1; });
    if (!spawn || !level.goals.length) return { ok: false, time: 0, reason: '缺少出生点或终点' };
    if (level.goals.some(function (g) { return isWallAt(level, g.col, g.row); })) return { ok: false, time: 0, reason: '终点在墙里' };
    // 出生点开局就被障碍压住 → 起手即死、复活后仍在原地，等于过不去
    var spawnPos = gridCenter(spawn.col, spawn.row);
    if (!playerSafeAt(frames[0], spawnPos.x, spawnPos.y)) {
      return { ok: false, time: 0, reason: '出生点落在障碍巡逻线上，开局即死' };
    }

    // BFS：(格子, 时间片)
    var startKey = spawn.col + ',' + spawn.row + '@0';
    var seen = {};
    seen[startKey] = 1;
    var queue = [{ col: spawn.col, row: spawn.row, t: 0 }];
    var head = 0;
    while (head < queue.length) {
      var cur = queue[head++];
      if (goals[cellKey(cur.col, cur.row)]) return { ok: true, time: cur.t * SOLVE_STEP, ticks: cur.t };

      // 原地等一个时间片
      var nt = cur.t + 1;
      if (nt < ticks) {
        var k = cur.col + ',' + cur.row + '@' + nt;
        if (!seen[k]) {
          var pc = gridCenter(cur.col, cur.row);
          if (playerSafeAt(frames[nt], pc.x, pc.y)) { seen[k] = 1; queue.push({ col: cur.col, row: cur.row, t: nt }); }
        }
      }
      // 走到相邻格子
      var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var d = 0; d < dirs.length; d++) {
        var nc = cur.col + dirs[d][0], nr = cur.row + dirs[d][1];
        if (isWallAt(level, nc, nr)) continue;
        var tick = cur.t + SOLVE_MOVE_TICKS;
        if (tick >= ticks) continue;
        var key = nc + ',' + nr + '@' + tick;
        if (seen[key]) continue;
        var a = gridCenter(cur.col, cur.row), b = gridCenter(nc, nr);
        var free = true;
        for (var s = 1; s <= SOLVE_MOVE_TICKS && free; s++) {           // 走的过程中每 1/4 都要安全
          var r = s / SOLVE_MOVE_TICKS;
          if (!playerSafeAt(frames[cur.t + s], a.x + (b.x - a.x) * r, a.y + (b.y - a.y) * r)) free = false;
        }
        if (!free) continue;
        seen[key] = 1;
        queue.push({ col: nc, row: nr, t: tick });
      }
    }
    return { ok: false, time: 0, reason: '在 ' + limit + ' 秒内找不到安全路线' };
  }

  /* ================= 格子连通性（编辑器用：终点是不是被墙彻底堵死） ================= */

  /** 只考虑墙体，出生点能否走到终点（能走到不代表能躲开障碍，但走不到就一定不能通关） */
  function reachable(level) {
    level = level.cols ? level : normalizeLevel(level);
    if (!level.spawns.length || !level.goals.length) return false;
    var start = level.spawns[0], goal = level.goals[0];
    var seen = {}, queue = [[start.col, start.row]];
    seen[cellKey(start.col, start.row)] = 1;
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (queue.length) {
      var cur = queue.shift();
      if (cur[0] === goal.col && cur[1] === goal.row) return true;
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
    PLAYER_COLORS: PLAYER_COLORS, PLAYER_COLOR_NAMES: PLAYER_COLOR_NAMES, LOCAL_KEY_DESC: LOCAL_KEY_DESC,
    /* 坐标 */
    gridToPixel: gridToPixel, gridCenter: gridCenter, pixelToGrid: pixelToGrid, cellKey: cellKey,
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
    /* 关卡可通关性（编辑器与自检共用） */
    solveReachable: solveReachable, reachable: reachable, obstacleTimeline: obstacleTimeline,
    SOLVE_STEP: SOLVE_STEP
  };
});
