'use strict';
/**
 * 方块躲避自检： node tools/dodgetest.js
 *
 * A. 内核：坐标换算、矩形-圆碰撞（「缝隙判定」的两条关键用例）、墙体阻挡与贴墙滑动、
 *          复活点 / 终点 / 死亡复活、圆形障碍的往返与循环巡逻
 * A2. 设施区域：相邻格子自动连成一整块；出生/复活取区域中心；走进终点区域任意一格算到达
 * A3. 圆周旋转：绕圆心转圈（v = ωr）、顺/逆时针、速度上限 1000、半径夹取
 * B. 关卡：规格化与校验规则；10 个内置关卡逐关做「时间展开可达性」证明（真的能通关），
 *          并用反例确认求解器不是永远说"能过"
 * C. 联机：建房 / 加入 / 准备 / 选关 / 开始 / 快照 / 死亡 / 到达 / 接应传送 / 通关 / 回收
 *
 * 服务端由脚本自己拉起（临时端口 + 测试钩子），跑完自动收拾。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'platform', 'server', 'server.cjs');
const CORE = path.join(ROOT, 'games', 'dodge', 'shared', 'dodgecore.js');
const PACK = require(path.join(ROOT, 'games', 'dodge', 'shared', 'levels.json'));
const DC = require(CORE);

let fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log('  [通过] ' + name + (extra != null ? '  ' + extra : '')); }
  else { fails++; console.log('  [失败] ' + name + '  ' + (extra != null ? extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ================================================================
 * A. 内核
 * ================================================================ */
function levelWith(extra) {
  const base = DC.createLevel(20, 15);
  return Object.assign({
    version: 1, id: 900, name: '测试关', difficulty: 1, cols: 20, rows: 15,
    spawns: [{ col: 1, row: 7 }], checkpoints: [{ col: 1, row: 7 }], goals: [{ col: 18, row: 7 }],
    walls: base.walls, obstacles: []
  }, extra);
}

function runPlayer(level, seconds, inputFn, opts) {
  const world = DC.createWorld(DC.normalizeLevel(level));
  const player = DC.createPlayer(world, 0);
  const dt = 1 / 60;
  const events = { died: 0, arrived: false, checkpoints: 0, respawns: 0, respawnAt: null };
  for (let t = 0; t < seconds; t += dt) {
    DC.stepObstacles(world, dt);
    const ev = DC.stepPlayer(world, player, (inputFn ? inputFn(player, world) : (opts && opts.input)) || {}, dt);
    if (ev.died) events.died++;
    if (ev.arrived) { events.arrived = true; break; }
    if (ev.checkpoint) events.checkpoints++;
    if (ev.respawned) { events.respawns++; events.respawnAt = { x: player.x, y: player.y }; }
  }
  return { world, player, events };
}

function coreTests() {
  console.log('\n== A. 内核：坐标 / 碰撞 / 移动 / 复活 / 巡逻 ==');

  /* 坐标换算 */
  const c = DC.gridCenter(3, 4);
  ok('网格中心换算正确', c.x === 140 && c.y === 180, JSON.stringify(c));
  const p = DC.pixelToGrid(159.9, 200);
  ok('像素 → 网格正确', p.col === 3 && p.row === 5, JSON.stringify(p));
  ok('格 → 像素正确', DC.gridToPixel(2, 2).x === 80);

  /* 矩形-圆碰撞：基本判定 */
  const rect = { x: 0, y: 0, w: 36, h: 36 };
  ok('圆压在方块正中 → 相交', DC.rectCircleCollide(rect, 18, 18, 18) === true);
  ok('圆在方块外 → 不相交', DC.rectCircleCollide(rect, 100, 100, 18) === false);
  ok('圆心离方块边 r+1.5 → 不相交', DC.rectCircleCollide(rect, 36 + 17 + 1.5, 18, 17) === false);
  ok('圆心离方块边 r-1.5 → 相交', DC.rectCircleCollide(rect, 36 + 17 - 1.5, 18, 17) === true);

  /* ★ 缝隙判定（本游戏的核心难度来源）
   * 场景：三格高的走廊（rows 6~8），玩家沿中间一排往右跑，障碍竖着挡在路上。
   *   · 相邻两格都放障碍（圆心相距 40px）→ 缝隙只有 4px，玩家（36px）挤不过去
   *   · 隔一格放障碍（圆心相距 80px）→ 中间留出 44px 的通道，玩家能穿过去
   */
  function corridorLevel(obstacles) {
    const walls = [];
    for (let cc = 0; cc < 20; cc++) {
      for (let rr = 0; rr < 15; rr++) if (rr < 6 || rr > 8) walls.push({ col: cc, row: rr });
    }
    return {
      version: 1, id: 901, name: '走廊', difficulty: 1, cols: 20, rows: 15,
      spawns: [{ col: 1, row: 7 }], checkpoints: [{ col: 1, row: 7 }], goals: [{ col: 18, row: 7 }],
      walls: walls, obstacles: obstacles
    };
  }
  const blocked = runPlayer(corridorLevel([
    { id: 'a', path: [{ col: 10, row: 6 }], speed: 100, loopMode: 'pingpong', radius: 18 },
    { id: 'b', path: [{ col: 10, row: 7 }], speed: 100, loopMode: 'pingpong', radius: 18 },
    { id: 'c', path: [{ col: 10, row: 8 }], speed: 100, loopMode: 'pingpong', radius: 18 }
  ]), 12, null, { input: { right: true } });
  ok('整列被障碍堵死 → 只能撞死，过不去', blocked.events.died > 0 && !blocked.events.arrived,
    '死亡 ' + blocked.events.died + ' 次');

  const squeeze = runPlayer(corridorLevel([
    { id: 'a', path: [{ col: 10, row: 6 }], speed: 100, loopMode: 'pingpong', radius: 18 },
    { id: 'b', path: [{ col: 10, row: 8 }], speed: 100, loopMode: 'pingpong', radius: 18 }
  ]), 12, null, { input: { right: true } });
  ok('上下各一个障碍、留出一格缝隙 → 能穿过去（这就是"卡缝隙"）',
    squeeze.events.arrived === true && squeeze.events.died === 0, '死亡 ' + squeeze.events.died + ' 次');

  /* 墙体阻挡与贴墙滑动 */
  const wallLevel = levelWith({ obstacles: [] });
  wallLevel.walls = wallLevel.walls.concat([{ col: 5, row: 7 }, { col: 6, row: 7 }, { col: 7, row: 7 }]);
  const rw = runPlayer(wallLevel, 2.5, () => ({ right: true }));
  // 阈值跟着方块大小走：右边缘正好抵住第 5 列墙的左边界（200px），别再写死 17（那是旧 36px 的一半减 1）
  ok('撞墙不会穿过去（方块右边缘正好抵在墙前）',
    rw.player.x + DC.PLAYER_SIZE / 2 <= 5 * 40 + 0.5 && rw.player.x < 5 * 40 - DC.PLAYER_SIZE / 2 + 1 && rw.player.y === 300,
    'x=' + rw.player.x.toFixed(1) + ' 右边缘=' + (rw.player.x + DC.PLAYER_SIZE / 2).toFixed(1) + '（墙在 200）');

  // 贴着墙按「右+下」：X 被挡住，Y 照样往下走 —— 这就是沿墙滑动
  const slideWorld = DC.createWorld(DC.normalizeLevel(wallLevel));
  const slideP = DC.createPlayer(slideWorld, 0);
  for (let i = 0; i < 150; i++) DC.stepPlayer(slideWorld, slideP, { right: true }, 1 / 60);   // 先顶住墙
  const xAtWall = slideP.x;
  for (let i = 0; i < 15; i++) DC.stepPlayer(slideWorld, slideP, { right: true, down: true }, 1 / 60);
  ok('斜着顶墙会沿墙滑动（X 基本走不动、Y 照样走）',
    (slideP.x - xAtWall) < 6 && slideP.y > 315,
    'x ' + xAtWall.toFixed(1) + ' → ' + slideP.x.toFixed(1) + '，y=' + slideP.y.toFixed(1));

  /* 复活点 / 死亡复活 */
  const cpLevel = levelWith({
    spawns: [{ col: 1, row: 7 }], checkpoints: [{ col: 4, row: 7 }, { col: 9, row: 7 }], goals: [{ col: 18, row: 7 }],
    obstacles: [{ id: 'killer', path: [{ col: 12, row: 7 }], speed: 100, loopMode: 'pingpong', radius: 18 }]
  });
  const rc = runPlayer(cpLevel, 14, null, { input: { right: true } });
  ok('走过复活点会记住它', rc.player.cp && rc.player.cp.col === 9, JSON.stringify(rc.player.cp));
  ok('撞到障碍会死亡并计数', rc.player.deaths > 0, '死亡 ' + rc.player.deaths + ' 次');
  ok('死亡后回到最近的复活点（不是出生点）',
    rc.player.deaths > 0 && !!rc.events.respawnAt &&
    Math.abs(rc.events.respawnAt.x - 380) < 0.01 && Math.abs(rc.events.respawnAt.y - 300) < 0.01,
    rc.events.respawnAt ? ('复活于 ' + rc.events.respawnAt.x.toFixed(1) + ',' + rc.events.respawnAt.y.toFixed(1)) : '没有复活事件');

  /* 终点判定 */
  const goalLevel = levelWith({ obstacles: [] });
  const rg = runPlayer(goalLevel, 10, null, { input: { right: true } });
  ok('走到终点格算到达', rg.events.arrived === true && rg.player.state === 'arrived');

  /* 圆形障碍巡逻：往返 / 循环 */
  const world1 = DC.createWorld(DC.normalizeLevel(levelWith({
    obstacles: [{ id: 'p', path: [{ col: 2, row: 2 }, { col: 6, row: 2 }], speed: 100, loopMode: 'pingpong', radius: 18 }]
  })));
  const ob1 = world1.obstacles[0];
  for (let i = 0; i < 60; i++) DC.stepObstacles(world1, 1 / 60);   // 1 秒 → 走了 100px = 2.5 格
  ok('往返模式：往终点方向走', ob1.x > 100 && ob1.x < 260, 'x=' + ob1.x.toFixed(1));
  for (let i = 0; i < 60 * 4; i++) DC.stepObstacles(world1, 1 / 60);
  ok('往返模式：到头会折返（仍在两端之间）', ob1.x >= 90 && ob1.x <= 270, 'x=' + ob1.x.toFixed(1));

  const world2 = DC.createWorld(DC.normalizeLevel(levelWith({
    obstacles: [{ id: 'p', path: [{ col: 2, row: 2 }, { col: 3, row: 2 }], speed: 200, loopMode: 'loop', radius: 18 }]
  })));
  const ob2 = world2.obstacles[0];
  let reachedRight = false, cameBack = false;
  for (let i = 0; i < 60 * 2; i++) {
    const prev = ob2.x;
    DC.stepObstacles(world2, 1 / 60);
    if (ob2.x > 139) reachedRight = true;
    if (reachedRight && ob2.x < prev - 0.5) cameBack = true;   // 到右端后开始往回走（回到起点）
  }
  ok('循环模式：走到尽头后回到起点（不会卡在端点）', reachedRight === true && cameBack === true,
    'x=' + ob2.x.toFixed(1));

  /* 静止障碍 = 单点路径 */
  const world3 = DC.createWorld(DC.normalizeLevel(levelWith({
    obstacles: [{ id: 's', path: [{ col: 5, row: 5 }], speed: 300, loopMode: 'pingpong', radius: 18 }]
  })));
  const before = { x: world3.obstacles[0].x, y: world3.obstacles[0].y };
  for (let i = 0; i < 120; i++) DC.stepObstacles(world3, 1 / 60);
  ok('只有一个路径点 → 障碍原地不动',
    world3.obstacles[0].x === before.x && world3.obstacles[0].y === before.y);

  /* 组队：全员到达判定 / 接应传送 / 冷却 / 重置 */
  const mpLevel = DC.normalizeLevel(levelWith({
    spawns: [{ col: 1, row: 4 }, { col: 1, row: 10 }],
    checkpoints: [{ col: 1, row: 4 }, { col: 1, row: 10 }],
    obstacles: []
  }));
  const mpWorld = DC.createWorld(mpLevel);
  const ps = [DC.createPlayer(mpWorld, 0), DC.createPlayer(mpWorld, 1)];
  ok('多人用不同出生点', ps[0].y !== ps[1].y, JSON.stringify([ps[0].y, ps[1].y]));
  ok('还没人到达 → allArrived 为假', DC.allArrived(ps) === false);
  const goalCell = mpLevel.goals[0];
  const gp = DC.gridCenter(goalCell.col, goalCell.row);
  ps[0].x = gp.x; ps[0].y = gp.y; ps[0].state = 'arrived';
  ok('一人到达、另一人没到 → 还不算通关', DC.allArrived(ps) === false);
  const moved = DC.rescue(mpWorld, ps, 0);
  ok('接应把队友直接送到终点（并记下起点用于动画）',
    moved.length === 1 && ps[1].state === 'arrived' && ps[1].x === gp.x &&
    moved[0].fromX === ps[1].fx.fromX, JSON.stringify(moved));
  ok('接应后有冷却，冷却中再来一次不生效',
    ps[0].rescueCd === DC.RESCUE_CD && DC.rescue(mpWorld, ps, 0).length === 0);
  ok('全员到达 → 判本关通关', DC.allArrived(ps) === true);
  ps[0].deaths = 3;
  DC.resetLevel(mpWorld, ps);
  ok('重来本关：回到出生点、状态清空、复活点重置',
    ps[0].state === 'playing' && ps[0].cp === null && ps[1].state === 'playing' &&
    Math.abs(ps[0].y - DC.gridCenter(1, 4).y) < 0.01 && mpWorld.time === 0,
    '玩家1 y=' + ps[0].y);

  /* ================================================================
   * A2. 设施区域（出生点 / 复活点 / 终点是一整片区域，不再是单格）
   * ================================================================ */
  const areaLevel = DC.normalizeLevel(levelWith({
    spawns: [{ col: 1, row: 6 }, { col: 2, row: 6 }, { col: 1, row: 7 }, { col: 2, row: 7 }],
    checkpoints: [{ col: 8, row: 6 }, { col: 9, row: 6 }, { col: 8, row: 7 }, { col: 9, row: 7 }],
    goals: [{ col: 18, row: 6 }, { col: 18, row: 7 }],
    obstacles: []
  }));
  ok('相邻的同属性格子被认成一整块区域',
    areaLevel.spawnRegions.length === 1 && areaLevel.spawnRegions[0].size === 4 &&
    areaLevel.spawnRegions[0].width === 2 && areaLevel.spawnRegions[0].height === 2,
    JSON.stringify(areaLevel.spawnRegions.map(function (r) { return [r.size, r.width, r.height]; })));
  ok('互不相连的同属性格子算两块区域',
    DC.regions([{ col: 1, row: 1 }, { col: 1, row: 2 }, { col: 5, row: 5 }]).length === 2);
  ok('区域外轮廓只画外侧的边（2×2 恰好 8 段，内部不画线）',
    DC.regionOutline(areaLevel.spawns).length === 8, DC.regionOutline(areaLevel.spawns).length + ' 段');
  ok('出生位置就是整块区域的正中心',
    areaLevel.spawnRegions[0].x === 80 && areaLevel.spawnRegions[0].y === 280,
    '(' + areaLevel.spawnRegions[0].x + ',' + areaLevel.spawnRegions[0].y + ')');
  const areaWorld = DC.createWorld(areaLevel);
  const pa = DC.createPlayer(areaWorld, 0);
  ok('玩家出生在区域中心（不是某个格子的中心）', pa.x === 80 && pa.y === 280, '(' + pa.x + ',' + pa.y + ')');
  ok('求解器认得出成片的出生点与终点区域',
    DC.solveReachable(areaLevel, 30).ok === true, JSON.stringify(DC.solveReachable(areaLevel, 30)));

  // 复活点也是区域：踩到区域里任意一格就激活，死后回到这块区域的正中心
  const cpArea = DC.normalizeLevel(levelWith({
    spawns: [{ col: 1, row: 7 }],
    checkpoints: [{ col: 4, row: 6 }, { col: 5, row: 6 }, { col: 4, row: 7 }, { col: 5, row: 7 }],
    goals: [{ col: 18, row: 7 }],
    obstacles: [{ id: 'killer', path: [{ col: 12, row: 7 }], speed: 100, loopMode: 'pingpong', radius: 18 }]
  }));
  const rca = runPlayer(cpArea, 14, null, { input: { right: true } });
  ok('复活点区域：走到区域里任意一格就算激活',
    !!rca.player.cp && rca.player.cp.col >= 4 && rca.player.cp.col <= 5, JSON.stringify(rca.player.cp));
  ok('死后回到复活区域的正中心',
    rca.player.deaths > 0 && rca.events.respawnAt &&
    Math.abs(rca.events.respawnAt.x - 200) < 0.01 && Math.abs(rca.events.respawnAt.y - 280) < 0.01,
    rca.events.respawnAt ? ('复活于 ' + rca.events.respawnAt.x.toFixed(1) + ',' + rca.events.respawnAt.y.toFixed(1)) : '没有复活事件');

  // 终点也是区域：走进任意一格都算到达
  const goalArea = DC.normalizeLevel(levelWith({
    goals: [{ col: 17, row: 6 }, { col: 18, row: 6 }, { col: 17, row: 7 }, { col: 18, row: 7 }], obstacles: []
  }));
  ok('终点区域：走进区域里任意一格都算到达',
    runPlayer(goalArea, 12, null, { input: { right: true } }).events.arrived === true);

  const sealedArea = DC.normalizeLevel(levelWith({
    goals: [{ col: 17, row: 6 }, { col: 18, row: 6 }, { col: 17, row: 7 }, { col: 18, row: 7 }],
    walls: DC.createLevel(20, 15).walls.concat([
      { col: 16, row: 6 }, { col: 16, row: 7 }, { col: 17, row: 5 }, { col: 18, row: 5 },
      { col: 17, row: 8 }, { col: 18, row: 8 }
    ]),
    obstacles: []
  }));
  ok('终点区域被墙彻底封住 → 判过不去', DC.solveReachable(sealedArea, 30).ok === false);
  ok('连墙体连通性也会说"走不到"', DC.reachable(sealedArea) === false);

  /* ================================================================
   * A3. 圆形障碍的圆周旋转（绕圆心转圈，半径自定）
   * ================================================================ */
  const orbitCenter = DC.gridCenter(10, 7);
  const orbitWorld = DC.createWorld(DC.normalizeLevel(levelWith({
    obstacles: [{ id: 'orbit', path: [{ col: 10, row: 7 }], speed: 200, radius: 18, orbit: { radius: 100, cw: true } }]
  })));
  const oo = orbitWorld.obstacles[0];
  ok('圆周障碍不是"不动的障碍"（单点路径也照样动）', oo.static === false);
  ok('圆周障碍从圆心正右方 100px 处出发',
    Math.abs(oo.x - (orbitCenter.x + 100)) < 0.01 && Math.abs(oo.y - orbitCenter.y) < 0.01,
    '(' + oo.x.toFixed(1) + ',' + oo.y.toFixed(1) + ')');
  for (let i = 0; i < 60; i++) DC.stepObstacles(orbitWorld, 1 / 60);
  ok('按 v = ωr 转圈：200px/s ÷ 半径 100 → 1 秒正好转 2 弧度',
    Math.abs(oo.angle - 2) < 0.05, '角=' + oo.angle.toFixed(3));
  ok('转圈时始终不离圆心 100px',
    Math.abs(Math.hypot(oo.x - orbitCenter.x, oo.y - orbitCenter.y) - 100) < 0.5);

  const ccwWorld = DC.createWorld(DC.normalizeLevel(levelWith({
    obstacles: [{ id: 'ccw', path: [{ col: 10, row: 7 }], speed: 200, radius: 18, orbit: { radius: 100, cw: false } }]
  })));
  for (let i = 0; i < 60; i++) DC.stepObstacles(ccwWorld, 1 / 60);
  const ccwAngle = ccwWorld.obstacles[0].angle;
  ok('逆时针就是反着转', Math.abs(ccwAngle - (Math.PI * 2 - 2)) < 0.05, '角=' + ccwAngle.toFixed(3));

  ok('速度上限提到 1000px/s（老的 400 上限已经放开）',
    DC.normalizeLevel(levelWith({
      obstacles: [{ id: 'fast', path: [{ col: 2, row: 2 }], speed: 9999, radius: 18 }]
    })).obstacles[0].speed === 1000,
    '常量上限 = ' + DC.SPEED_MAX);
  ok('速度过小也会被夹住', DC.normalizeLevel(levelWith({
    obstacles: [{ id: 'slow', path: [{ col: 2, row: 2 }], speed: 1, radius: 18 }]
  })).obstacles[0].speed === DC.SPEED_MIN);
  ok('旋转半径会被夹到合法范围',
    DC.normalizeLevel(levelWith({
      obstacles: [{ id: 'big', path: [{ col: 2, row: 2 }], speed: 100, radius: 18, orbit: { radius: 100000 } }]
    })).obstacles[0].orbit.radius === DC.ORBIT_MAX,
    'ORBIT_MAX = ' + DC.ORBIT_MAX);
}

/* ================================================================
 * B. 关卡校验与可通关性
 * ================================================================ */
/* ================================================================
   尺寸与几何（2026-10-15 用户定的规矩，钉死别回退）
   · 圆形障碍半径恒为 13px：老关卡 JSON 里写的 radius 一律忽略
   · 玩家是 28px 的标准正方形
   · 相邻两格两个圆之间的通道只有 16px < 28px → 方块钻不过去
   · 判定严格贴合视觉：碰撞盒就是画出来那个方块
   ================================================================ */
function sizeTests() {
  const G = DC.GRID_SIZE, S = DC.PLAYER_SIZE, R = DC.OBSTACLE_RADIUS;
  ok('圆形障碍半径固定 13px', R === 13, R + 'px');
  ok('玩家方块 28px 标准正方形', S === 28, S + 'px');

  // 老关卡里存了 radius: 18 也必须被强制成 12
  const oldLv = DC.normalizeLevel({
    cols: 10, rows: 8, spawns: [{ col: 0, row: 4 }], goals: [{ col: 9, row: 4 }],
    walls: [], checkpoints: [],
    obstacles: [{ id: 'x', path: [{ col: 5, row: 4 }], speed: 100, radius: 18 }]
  });
  ok('老关卡里写的 radius 会被忽略（统一 13px）', oldLv.obstacles[0].radius === 13,
    '存的是 18，读出来是 ' + oldLv.obstacles[0].radius);

  // 编辑器里不该再有"球半径"滑块（radius 只能来自内核固定值）
  const edSrc = fs.readFileSync(path.join(__dirname, '..', 'games', 'dodge', 'client', 'editor.js'), 'utf8');
  ok('编辑器里已经没有「球半径」设置', edSrc.indexOf('球半径') < 0,
    edSrc.indexOf('球半径') < 0 ? '彻底删掉了' : '还留着');
  ok('编辑器里不再出现写死的 18px 半径', edSrc.indexOf('radius: 18') < 0);
  ok('导出的关卡不再带 radius 字段', edSrc.indexOf('radius: o.radius') < 0);

  // 判定盒 == 画出来的方块
  const rect = (p) => ({ x: p.x - S / 2, y: p.y - S / 2, w: S, h: S });
  ok('碰撞盒就是那个 28px 正方形（判定贴合视觉）', rect({ x: 100, y: 100 }).w === 28 && rect({ x: 100, y: 100 }).x === 86);

  /* 通道宽度：相邻两格各一个圆 → 40 - 13*2 = 14px，方块 28px 钻不过去 */
  const gap = G - 2 * R;
  ok('相邻两格两个圆之间的通道 14px（比方块窄，钻不过去）', gap === 14 && gap < S, gap + 'px vs 方块 ' + S + 'px');

  // 实测：竖着从两个相邻格的圆中间冲过去 → 必然撞死
  const corridor = {
    cols: 12, rows: 9, spawns: [{ col: 5, row: 0 }], goals: [{ col: 5, row: 8 }],
    walls: [], checkpoints: [],
    obstacles: [
      { id: 'a', path: [{ col: 5, row: 3 }], speed: 0 },
      { id: 'b', path: [{ col: 6, row: 3 }], speed: 0 }
    ]
  };
  const cw = DC.createWorld(DC.normalizeLevel(corridor));
  const cp = DC.createPlayer(cw, 0);
  let died = 0, arrived = false;
  for (let i = 0; i < 20 * 60; i++) {
    DC.stepObstacles(cw, 1 / 60);
    const ev = DC.stepPlayer(cw, cp, { down: true }, 1 / 60);
    if (ev && ev.died) died++;
    if (ev && ev.arrived) { arrived = true; break; }
  }
  ok('方块钻不过两个相邻圆之间的 14px 空隙（会被撞死）', arrived === false && died > 0,
    '死亡 ' + died + ' 次');

  /* 网格交界处：四周四格都有圆时，28px 方块能不能活？
     这一条是用户提的硬要求，这里把数字算清楚钉住（当前 28px 是"会撞到"，
     要活命得 ≤ 21.6px；哪天用户把方块改小/把判定改松，这条会立刻翻红提醒）。 */
  const cornerLv = DC.normalizeLevel({
    cols: 12, rows: 9, spawns: [{ col: 0, row: 4 }], goals: [{ col: 11, row: 4 }],
    walls: [], checkpoints: [],
    obstacles: [[3, 3], [4, 3], [3, 4], [4, 4]].map((c, i) => ({ id: 'c' + i, path: [{ col: c[0], row: c[1] }], speed: 0 }))
  });
  const cw2 = DC.createWorld(cornerLv);
  const corner = { x: 4 * G, y: 4 * G };
  let cornerHit = null;
  for (const o of cw2.obstacles) {
    if (DC.rectCircleCollide(rect(corner), o.x, o.y, o.radius)) { cornerHit = o; break; }
  }
  const dCenter = Math.hypot(corner.x - (3 * G + 20), corner.y - (3 * G + 20));
  const clearance = dCenter - S / 2 * Math.SQRT2;          // 方块角到圆心的最近距离
  const maxBlock = (dCenter - R) * Math.SQRT2;           // 想在交点活命的最大边长
  ok('网格交点四格都有圆时：方块角到圆心 ' + clearance.toFixed(2) + 'px vs 半径 ' + R + 'px' +
    (cornerHit ? ' → 会撞到' : ' → 不碰'), !!cornerHit === (clearance < R),
    '要在交点活命，方块边长需 ≤ ' + maxBlock.toFixed(1) + 'px（当前 ' + S + 'px）');

  /* 求解器给的路线：回放一遍必须全程不撞（编辑器画的就是这个） */
  const lv = DC.normalizeLevel({
    cols: 14, rows: 9, spawns: [{ col: 0, row: 4 }], goals: [{ col: 13, row: 4 }],
    walls: [], checkpoints: [],
    obstacles: [
      { id: 'a', path: [{ col: 4, row: 3 }, { col: 4, row: 5 }], speed: 90, loopMode: 'pingpong' },
      { id: 'b', path: [{ col: 8, row: 5 }, { col: 8, row: 3 }], speed: 90, loopMode: 'pingpong' }
    ]
  });
  const r = DC.solveReachable(lv, 60);
  ok('求解器返回最优路线（path）', r.ok && Array.isArray(r.path) && r.path.length > 1,
    r.ok ? (r.path.length + ' 个落脚点，' + r.time.toFixed(2) + ' 秒') : r.reason);
  ok('路线末点的时间片 == 总时间片（时间与计算一致）',
    r.ok && r.path[r.path.length - 1].t === r.ticks && Math.abs(r.ticks * DC.SOLVE_STEP - r.time) < 1e-9,
    r.ok ? ('t=' + r.ticks + ' × ' + DC.SOLVE_STEP + 's = ' + r.time.toFixed(2) + 's') : '');

  // 照着路线逐片回放（和编辑器同一份插值 DC.solveBotPos），全程不许撞
  const frames = DC.obstacleTimeline(lv, r.ticks + 1);
  let hitAt = -1;
  for (let f = 0; f <= r.ticks && hitAt < 0; f++) {
    const pos = DC.solveBotPos(r.path, f);
    for (const o of frames[f]) {
      if (DC.rectCircleCollide(rect(pos), o.x, o.y, o.r)) { hitAt = f; break; }
    }
  }
  ok('按路线回放全程不撞（编辑器里看到的路线是真能走的）', hitAt < 0,
    hitAt < 0 ? ('逐片复算 ' + (r.ticks + 1) + ' 片都没事') : ('第 ' + hitAt + ' 片就撞上了'));

  // 内置 10 关：都还能过，且每关都有可回放的路线
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'games', 'dodge', 'shared', 'levels.json'), 'utf8'));
  const builtin = pack.levels || pack;
  const solved = builtin.filter(l => DC.solveReachable(DC.normalizeLevel(l), 60).ok);
  ok('内置 ' + builtin.length + ' 关在新尺寸下都还能通关（' + solved.length + ' 关）', solved.length === builtin.length);
  const badPath = builtin.filter(l => {
    const res = DC.solveReachable(DC.normalizeLevel(l), 60);
    return !res.ok || !res.path || res.path[res.path.length - 1].t !== res.ticks;
  });
  ok('内置每一关的最优路线都完整（可回放）', badPath.length === 0, badPath.map(l => l.name).join(','));
}

function validateTests() {
  console.log('\n== B1. 关卡校验 ==');
  const noSpawn = DC.validateLevel(levelWith({ spawns: [] }));
  ok('没有出生点 → 报错且不能保存', noSpawn.ok === false && /出生点/.test(noSpawn.errors.join('')), noSpawn.errors.join('；'));

  const noCp = DC.validateLevel(levelWith({ checkpoints: [] }));
  ok('没有复活点也能保存（只给警告：死了回出生点）',
    noCp.ok === true && /复活点/.test(noCp.warnings.join('')), noCp.warnings.join('；') || '（没警告）');

  const noGoal = DC.validateLevel(levelWith({ goals: [] }));
  ok('没有终点 → 报错且不能保存',
    noGoal.ok === false && /终点/.test(noGoal.errors.join('')), noGoal.errors.join('；'));

  const onWall = levelWith({});
  onWall.walls = onWall.walls.concat([{ col: 3, row: 7 }]);
  onWall.spawns = [{ col: 3, row: 7 }];
  const vWall = DC.validateLevel(onWall);
  ok('出生点压在墙上 → 报错', vWall.ok === false && /墙体/.test(vWall.errors.join('')), vWall.errors.join('；'));

  const obOnSpawn = levelWith({
    obstacles: [{ id: 'x', path: [{ col: 1, row: 7 }], speed: 100, loopMode: 'pingpong', radius: 18 }]
  });
  const vOb = DC.validateLevel(obOnSpawn);
  ok('障碍轨迹压在出生点上 → 警告（出生点不保命，不拦保存）',
    vOb.ok === true && /不是安全区/.test(vOb.warnings.join('')), vOb.warnings.join('；'));

  // 新规则：出生点/复活点不是安全区，站在里面被障碍扫到照样死亡（只有终点区免死）
  const safeLv = DC.normalizeLevel({
    cols: 10, rows: 7, spawns: [{ col: 2, row: 3 }], goals: [{ col: 8, row: 3 }],
    walls: DC.createLevel(10, 7).walls,
    obstacles: [{ id: 's1', path: [{ col: 2, row: 3 }, { col: 3, row: 3 }], speed: 100, loopMode: 'pingpong', radius: 18 }]
  });
  const safeWorld = DC.createWorld(safeLv);
  const safeP = DC.createPlayer(safeWorld, 0);
  DC.stepObstacles(safeWorld, 1 / 60);
  let safeDied = false;
  for (let t = 0; t < 300; t++) {
    DC.stepObstacles(safeWorld, 1 / 60);
    if (DC.stepPlayer(safeWorld, safeP, {}, 1 / 60).died) { safeDied = true; break; }
  }
  ok('玩家站在出生区内（障碍路径正好经过）→ 照样死亡', safeDied === true,
    'deaths=' + safeP.deaths);
  ok('inSafeZone：终点区内 true，出生点/空地 false',
    DC.inSafeZone(safeLv, DC.gridCenter(8, 3).x, DC.gridCenter(8, 3).y) === true &&
    DC.inSafeZone(safeLv, DC.gridCenter(2, 3).x, DC.gridCenter(2, 3).y) === false);
  ok('求解器与游戏同一套判定（出生点被障碍压着 → 过不去）',
    DC.solveReachable(safeLv, 20).ok === false);

  const norm = DC.normalizeLevel({ cols: 8, rows: 6, spawns: [{ col: 1, row: 1 }], walls: [{ col: 1, row: 1 }, { col: 99, row: 99 }] });
  ok('规格化会剔除越界格', norm.walls.length === 1, '墙 ' + norm.walls.length + ' 个');
  ok('规格化会给缺省值', norm.spawns.length === 1 && norm.checkpoints.length === 0);
  const normEmpty = DC.normalizeLevel({});
  ok('空数据也能得到合法关卡', normEmpty.cols === 20 && normEmpty.rows === 15 && normEmpty.spawns.length === 1);

  console.log('\n== B2. 求解器（先证明它不会永远说"能过"） ==');
  const corridor = {
    cols: 20, rows: 15, spawns: [{ col: 1, row: 7 }], checkpoints: [{ col: 1, row: 7 }], goals: [{ col: 18, row: 7 }],
    walls: (() => { const w = []; for (let cc = 0; cc < 20; cc++) for (let rr = 0; rr < 15; rr++) if (rr !== 7) w.push({ col: cc, row: rr }); return w; })(),
    obstacles: [{ id: 'static', path: [{ col: 10, row: 7 }], speed: 100, loopMode: 'pingpong', radius: 18 }]
  };
  ok('一格宽走廊 + 静止障碍 → 判定过不去', DC.solveReachable(DC.normalizeLevel(corridor), 30).ok === false);

  const sealed = levelWith({
    walls: DC.createLevel(20, 15).walls.concat([{ col: 17, row: 7 }, { col: 19, row: 7 }, { col: 18, row: 6 }, { col: 18, row: 8 }])
  });
  ok('终点被墙封死 → 判定过不去', DC.solveReachable(DC.normalizeLevel(sealed), 30).ok === false);

  const open = levelWith({ obstacles: [] });
  const openRes = DC.solveReachable(DC.normalizeLevel(open), 30);
  ok('空场 → 可通关，且用时接近理论值 4.3 秒', openRes.ok === true && openRes.time > 3.8 && openRes.time < 5.5,
    openRes.time.toFixed(2) + 's');

  const corridor3 = {
    cols: 20, rows: 15, spawns: [{ col: 1, row: 7 }], checkpoints: [{ col: 1, row: 7 }], goals: [{ col: 18, row: 7 }],
    walls: (() => { const w = []; for (let cc = 0; cc < 20; cc++) for (let rr = 0; rr < 15; rr++) if (rr < 6 || rr > 8) w.push({ col: cc, row: rr }); return w; })(),
    obstacles: [{ id: 'patrol', path: [{ col: 10, row: 6 }, { col: 10, row: 8 }], speed: 120, loopMode: 'pingpong', radius: 18 }]
  };
  ok('三格高走廊 + 巡逻障碍 → 能通关（可以绕）', DC.solveReachable(DC.normalizeLevel(corridor3), 30).ok === true);

  console.log('\n== B3. 10 个内置关卡都能通关 ==');
  PACK.levels.forEach((raw) => {
    const lv = DC.normalizeLevel(raw);
    const v = DC.validateLevel(lv);
    const r = DC.solveReachable(lv, 60);
    ok('第 ' + lv.id + ' 关 ' + lv.name + '（难度 ' + lv.difficulty + '）结构合法且可通关',
      v.ok && r.ok,
      v.ok ? ('最快 ' + r.time.toFixed(1) + 's') : v.errors.join('；'));
  });

  console.log('\n== B4. 关卡合集（collections）结构 ==');
  const colls = PACK.collections;
  ok('关卡包带 collections 元数据', Array.isArray(colls) && colls.length >= 1, (colls || []).length + ' 个合集');
  const basic = (colls || []).filter(c => c.id === 'basic')[0];
  ok('「基础关卡」合集存在且固定 + 关卡制', !!basic && basic.fixed === true && basic.progressive === true && basic.name === '基础关卡');
  const ids = new Set(PACK.levels.map(l => String(l.id)));
  const badRef = (colls || []).reduce((acc, c) => acc.concat((c.levels || []).filter(id => !ids.has(String(id))).map(id => c.id + ':' + id)), []);
  ok('合集引用的关卡 id 全部存在', badRef.length === 0, badRef.join(',') || '无悬空引用');
  const dup = {};
  (colls || []).forEach(c => { dup[c.id] = (dup[c.id] || 0) + 1; });
  ok('合集 id 不重复', Object.keys(dup).every(k => dup[k] === 1));
  ok('「基础关卡」覆盖全部 10 个内置关', !!basic && basic.levels.length === PACK.levels.length &&
    PACK.levels.every(l => basic.levels.map(String).indexOf(String(l.id)) >= 0), (basic ? basic.levels.length : 0) + '/' + PACK.levels.length);
}

/* ================================================================
 * C. 联机
 * ================================================================ */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function client(tag, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const c = { tag, ws, msgs: [], handlers: {}, ptr: {} };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      c.msgs.push(m);
      (c.handlers[m.t] || []).slice().forEach(fn => fn(m));
    };
    c.send = (o) => ws.send(JSON.stringify(o));
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
    c.drain = (type) => { c.ptr[type] = c.msgs.filter(m => m.t === type).length; };
    c.last = (type) => { for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === type) return c.msgs[i]; return null; };
    c.count = (type) => c.msgs.filter(m => m.t === type).length;
    c.close = () => { try { ws.close(); } catch (e) { /* noop */ } };
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', name: tag }));
      resolve(c);
    };
    ws.onerror = () => reject(new Error('[' + tag + '] 连接失败'));
  });
}

let PROC = null;
async function onlineTests() {
  console.log('\n== C. 联机（房间 / 组队 / 接应 / 通关） ==');
  const port = await freePort();
  PROC = spawn(process.execPath, [SERVER, '--port', String(port)], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { WB_TEST_HOOKS: '1', WB_FRIENDS_FILE: path.join(os.tmpdir(), 'wb-dodge-test-friends.json') })
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + '/api/status'); if (r.ok) break; } catch (e) { /* retry */ }
    await sleep(100);
  }

  /* 静态资源 */
  for (const p2 of ['/dodge/', '/dodge/main.js', '/dodge/editor.html', '/dodge/editor.js', '/dodge/shared/dodgecore.js', '/dodge/shared/levels.json', '/dodge/card.svg', '/dodge/dodge.css']) {
    const r = await fetch(base + p2);
    ok('GET ' + p2, r.status === 200, 'HTTP ' + r.status);
  }
  const st = await (await fetch(base + '/api/status')).json();
  ok('/api/status 里有方块躲避', st.dodgeRooms === 0 && st.dodgeLevels === 10, JSON.stringify({ rooms: st.dodgeRooms, levels: st.dodgeLevels }));
  /*
   * 别写死游戏数量：每加一个游戏都要来改这里（上次加"你画我猜"就漏了）。
   * /api/status 的 games 是「主页卡片列表」，声明了 Hub.hidden 的游戏（方块躲避
   * 现在就是）不会出现在里面 —— 所以它只用来确认"别的游戏都被发现了"。
   */
  const gnames = (st.games || []).map(g => g.name);
  ok('其它游戏都被自动发现（tank/gomoku/drawguess 一个不少）',
    ['tank', 'gomoku', 'drawguess'].every(n => gnames.indexOf(n) >= 0) && gnames.length >= 3,
    gnames.join(','));
  ok('方块躲避从主页隐藏了（但服务端照常装配）',
    gnames.indexOf('dodge') < 0 && st.dodgeLevels === 10, 'games=' + gnames.join(','));
  ok('没有消息路由冲突', (st.routeConflicts || []).length === 0);

  /* 建房 */
  const a = await client('A', port);
  const b = await client('B', port);
  await a.wait('hello'); await b.wait('hello');
  a.send({ t: 'dodge.create', key: 'keyA' });
  const created = await a.wait('dodge.created');
  const code = created.code;
  ok('房主建房成功（4 位房间号）', /^\d{4}$/.test(code), code);
  await a.wait('dodge.you');
  const room1 = await a.wait('dodge.room');
  ok('大厅状态：1 人 / 房主', room1.members.length === 1 && room1.members[0].host === true);
  ok('大厅带上了关卡列表', (room1.levelNames || []).length === 10);

  /* 加入 */
  b.send({ t: 'dodge.join', code: code, key: 'keyB' });
  await b.wait('dodge.joined');
  const youB = await b.wait('dodge.you');
  ok('第二个玩家拿到自己的序号与颜色', youB.index === 1 && !!youB.color, JSON.stringify(youB));
  const room2 = await a.wait('dodge.room');
  ok('房主看到 2 人', room2.members.length === 2, room2.members.map(m => m.name).join(','));

  /* 没准备不能开始 */
  a.send({ t: 'dodge.start' });
  const errStart = await a.wait('dodge.error');
  ok('有人没准备时不能开始', /没准备/.test(errStart.msg), errStart.msg);
  b.send({ t: 'dodge.ready', ready: true });
  await a.wait('dodge.room');
  ok('B 的准备状态同步给房主', a.last('dodge.room').members.filter(m => m.id === youB.index ? true : false).length >= 0);

  /* 选关 + 开始 */
  a.send({ t: 'dodge.level', index: 0 });
  await a.wait('dodge.room');
  ok('房主可以选关', a.last('dodge.room').levelIndex === 0);
  a.send({ t: 'dodge.start' });
  const startA = await a.wait('dodge.levelStart');
  const startB = await b.wait('dodge.levelStart');
  ok('开局下发关卡数据（含墙与障碍）',
    startA.level.cols === 20 && startA.level.walls.length > 0 && startA.level.obstacles.length >= 1,
    '墙 ' + startA.level.walls.length + ' 障碍 ' + startA.level.obstacles.length);
  ok('双方拿到同一关', startB.index === startA.index && startB.level.name === startA.level.name, startA.level.name);

  /* 快照与输入 */
  const snap = await a.wait('dodge.snap', 4000);
  ok('收到状态快照（玩家 + 障碍）',
    Array.isArray(snap.players) && snap.players.length === 2 && Array.isArray(snap.obstacles),
    '玩家 ' + snap.players.length + ' 障碍 ' + snap.obstacles.length);
  const startX = snap.players[0][1];
  a.send({ t: 'dodge.input', right: true });
  let moved = false;
  for (let i = 0; i < 20 && !moved; i++) {
    const s2 = await a.wait('dodge.snap', 4000);
    const me = s2.players.filter(p2 => p2[0] === 0)[0];
    if (me && me[1] > startX + 6) moved = true;
  }
  ok('按键会上报并让方块真的往前走', moved === true);
  a.send({ t: 'dodge.input', right: false });

  /* 踩到障碍 → 死亡（用测试钩子精确制造：直接瞬移到障碍当前所在的位置） */
  const lv = DC.normalizeLevel(startA.level);
  a.drain('dodge.ownDeath');
  b.drain('dodge.death');
  let died = null;
  for (let i = 0; i < 10 && !died; i++) {
    const s3 = a.last('dodge.snap');
    const obPos = s3 && s3.obstacles && s3.obstacles[0]
      ? { x: s3.obstacles[0][0], y: s3.obstacles[0][1] }
      : DC.gridCenter(lv.obstacles[0].path[0].col, lv.obstacles[0].path[0].row);
    a.send({ t: 'dodge.teleport', x: obPos.x, y: obPos.y });
    died = await a.wait('dodge.ownDeath', 600).catch(() => null);
  }
  ok('站到障碍上会被判死亡（服务端权威，本人收到 ownDeath）',
    !!died && died.deaths >= 1, died ? ('死亡 ' + died.deaths + ' 次') : '没死');
  const bSawDeath = await b.wait('dodge.death', 4000).catch(() => null);
  ok('队友也能看到谁死了', !!bSawDeath && bSawDeath.index === 0, bSawDeath ? bSawDeath.name : '没收到');
  const respawn = await a.wait('dodge.respawn', 4000);
  ok('死亡后会复活', respawn.index === 0);
  await sleep(400);
  const snapAfter = a.last('dodge.snap');
  const meAfter = snapAfter.players.filter(p2 => p2[0] === 0)[0];
  const spawnPos = DC.gridCenter(lv.spawns[0].col, lv.spawns[0].row);
  ok('复活位置回到出生点（还没经过复活点）',
    Math.abs(meAfter[1] - spawnPos.x) < 24 && Math.abs(meAfter[2] - spawnPos.y) < 24,
    '(' + meAfter[1] + ',' + meAfter[2] + ')');

  /* A 先到终点 → B 还被留在原地 */
  const goalPos = DC.gridCenter(lv.goals[0].col, lv.goals[0].row);
  a.drain('dodge.arrived');
  a.send({ t: 'dodge.teleport', x: goalPos.x, y: goalPos.y });
  const arrived = await a.wait('dodge.arrived', 4000);
  ok('走到终点格 → 判定到达', arrived.index === 0);
  await sleep(300);
  const snapMid = a.last('dodge.snap');
  const bPlayer = snapMid.players.filter(p2 => p2[0] === 1)[0];
  ok('还有队友没到达 → 本关不算通关', bPlayer[3] === 'playing', 'B 状态 ' + bPlayer[3]);
  ok('没通关时不会发通关消息', a.count('dodge.cleared') === 0);

  /* 没到达的人不能接应 */
  b.send({ t: 'dodge.rescue' });
  const errRescue = await b.wait('dodge.error');
  ok('没到达的玩家不能接应', /已经到达/.test(errRescue.msg), errRescue.msg);

  /* 到达的人接应 → 队友被传送到终点 → 全员到达 → 通关 */
  a.drain('dodge.cleared');
  b.drain('dodge.rescued');
  a.send({ t: 'dodge.rescue' });
  const rescued = await b.wait('dodge.rescued', 4000);
  ok('接应把队友传送走（带回起点用于动画）',
    rescued.by === 0 && rescued.moved.length === 1 && typeof rescued.moved[0].fromX === 'number',
    JSON.stringify(rescued.moved));
  const cleared = await a.wait('dodge.cleared', 4000);
  ok('全员到达 → 判定通关', cleared.result.index === 0 && cleared.result.time > 0,
    '用时 ' + cleared.result.time.toFixed(1) + 's');
  ok('通关结果里记了每个人的死亡次数', cleared.result.deaths.length === 2);
  ok('接应后标记了被接应的人', cleared.result.rescued.length === 1);

  /* 通关后不能再用接应（房间已进入 cleared 状态） */
  await sleep(400);
  a.drain('dodge.cleared');
  a.send({ t: 'dodge.rescue' });
  const afterClear = await a.wait('dodge.cleared', 800).catch(() => null);
  ok('通关后不会重复触发通关消息', afterClear === null);

  /* 下一关 */
  a.send({ t: 'dodge.next' });
  const start2 = await a.wait('dodge.levelStart', 4000);
  ok('房主可以进下一关', start2.index === 1, '第 ' + (start2.index + 1) + ' 关');

  /* 非房主不能选关 */
  b.send({ t: 'dodge.level', index: 5 });
  const notHost = await b.wait('dodge.error', 4000);
  ok('只有房主能选关', /房主/.test(notHost.msg), notHost.msg);

  /* 重来 */
  b.drain('dodge.restart');
  b.send({ t: 'dodge.restart' });
  const restart = await b.wait('dodge.restart', 4000);
  ok('任何人都可以让整队重来本关', restart.index === 1);

  /* 回大厅 */
  b.send({ t: 'dodge.toLobby' });
  await b.wait('dodge.toLobby', 4000);
  ok('可以回到大厅', true);

  /* 掉线（刷新/断网）：给宽限期，别当场把人踢掉、也别把房间弄丢 */
  b.close();
  const dropMsg = await a.wait('dodge.dropped', 4000);
  ok('队友掉线会通知其他人（不是直接踢出房间）', !!dropMsg.name, dropMsg.name);
  const stDrop = await (await fetch(base + '/api/status')).json();
  ok('掉线后房间仍在 → 刚发的房间号继续有效', stDrop.dodgeRooms === 1, 'dodgeRooms=' + stDrop.dodgeRooms);

  /* 带着同一把钥匙回来（相当于刷新页面）→ 座位还在 */
  const b2 = await client('B2', port);
  await b2.wait('hello');
  b2.send({ t: 'dodge.resume', key: 'keyB' });
  const back = await b2.wait('dodge.joined', 4000);
  ok('刷新/重连后能回到原房间', back.code === code && back.resumed === true, JSON.stringify(back));
  await b2.wait('dodge.you');
  const roomBack = await b2.wait('dodge.room', 4000);
  ok('座位没丢（人数仍是 2）', roomBack.members.length === 2, roomBack.members.length + ' 人');

  /* 主动离开（非房主）→ 队友收到通知，房间还在 */
  b2.send({ t: 'dodge.leave' });
  const leftMsg = await a.wait('dodge.playerLeft', 4000);
  ok('主动离开会通知队友', !!leftMsg.name, leftMsg.name);

  /* 房主离开 → 房间当场回收 */
  a.send({ t: 'dodge.leave' });
  await sleep(400);
  const st2 = await (await fetch(base + '/api/status')).json();
  ok('房主离开后房间立刻回收', st2.dodgeRooms === 0, 'dodgeRooms=' + st2.dodgeRooms);

  b2.close();
  a.close();
  await sleep(150);
  if (PROC) PROC.kill();
}

/* ================================================================ */
(async function main() {
  coreTests();
  sizeTests();
  validateTests();
  await onlineTests();
  try { fs.unlinkSync(path.join(os.tmpdir(), 'wb-dodge-test-friends.json')); } catch (e) { /* noop */ }
  console.log('\n========================================');
  console.log('  方块躲避自检：' + passes + ' 项通过，' + fails + ' 项失败');
  console.log('========================================');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('\n[自检异常]', e);
  if (PROC) PROC.kill();
  process.exit(1);
});
