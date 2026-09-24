'use strict';
/**
 * 自检脚本： node tools/selftest.js
 * 校验：迷宫地图约束、360° 旋转与弹道、子弹反弹、子弹寿命、子弹会打中自己、
 *       子弹上限、特殊武器、AI 对战稳定性、快照体积。
 */
const path = require('path');
const T = require(path.join(__dirname, '..', 'games/tank/shared/tankcore.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  [通过] ' + name + (extra ? '  ' + extra : ''));
  else { failures++; console.log('  [失败] ' + name + '  ' + (extra || '')); }
}
const R2D = 180 / Math.PI;

/* ================= 1. 随机墙体地图 + 随机出生点 ================= */
console.log('\n== 1. 地图生成（300 张随机图） ==');
let minOpen = 1, maxOpen = 0, belowThird = 0, minIWall = 1, maxIWall = 0, minSpawn = 99, spawnBad = 0, cleanBad = 0;
for (let i = 0; i < 300; i++) {
  const w = T.createWorld({ cols: 25, rows: 19, seed: i * 7919 + 13, tankSlots: 4 });
  const total = w.cols * w.rows;
  let open = 0;
  for (let k = 0; k < total; k++) {
    const t = w.tiles[k];
    if (t !== T.BRICK && t !== T.STEEL && t !== T.WATER) open++;
  }
  const ratio = open / total;
  if (ratio < 1 / 3) belowThird++;
  minOpen = Math.min(minOpen, ratio); maxOpen = Math.max(maxOpen, ratio);

  // 内部墙体占比（墙面要够多，才像迷宫）
  let iTotal = 0, iWall = 0;
  for (let r = 1; r < w.rows - 1; r++) {
    for (let c = 1; c < w.cols - 1; c++) {
      iTotal++;
      const t = w.tiles[r * w.cols + c];
      if (t === T.BRICK || t === T.STEEL || t === T.WATER) iWall++;
    }
  }
  const iw = iWall / iTotal;
  minIWall = Math.min(minIWall, iw); maxIWall = Math.max(maxIWall, iw);

  // 出生点：随机分布、彼此拉开、周围干净
  const sp = w.spawnTiles;
  if (sp.length < 2) spawnBad++;
  let md = 99;
  for (let a = 0; a < sp.length; a++) {
    for (let b = a + 1; b < sp.length; b++) {
      const d = Math.hypot(sp[a][0] - sp[b][0], sp[a][1] - sp[b][1]);
      if (d < md) md = d;
    }
  }
  if (md < T.MIN_SPAWN_DIST) spawnBad++;
  minSpawn = Math.min(minSpawn, md);
  for (const [sc, sr] of sp) {
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      const t = w.tiles[(sr + y) * w.cols + (sc + x)];
      if (t === T.BRICK || t === T.STEEL || t === T.WATER) cleanBad++;
    }
  }
}
check('全部地图可活动面积 ≥ 1/3', belowThird === 0,
  '空地 ' + (minOpen * 100).toFixed(1) + '%~' + (maxOpen * 100).toFixed(1) + '%');
check('墙面足够多（像迷宫的密度）', minIWall >= 0.20 && maxIWall <= 0.45,
  '内部墙体占比 ' + (minIWall * 100).toFixed(1) + '%~' + (maxIWall * 100).toFixed(1) + '%');
check('出生点是随机的且彼此拉开距离', spawnBad === 0,
  '最小间距 ' + minSpawn.toFixed(1) + ' 格（要求 ≥ ' + T.MIN_SPAWN_DIST + '）');
check('出生点周围 3x3 是空地（不会一出生就卡住）', cleanBad === 0);
check('地图尺寸与边界墙', (() => {
  const w = T.createWorld({ cols: 25, rows: 19, seed: 5, tankSlots: 4 });
  return w.cols === 25 && w.rows === 19 && w.tiles[0] === T.STEEL;
})());
check('出生点不是固定四角（每次随机）', (() => {
  const a = T.createWorld({ cols: 25, rows: 19, seed: 11, tankSlots: 4 }).spawnTiles;
  const b = T.createWorld({ cols: 25, rows: 19, seed: 22, tankSlots: 4 }).spawnTiles;
  return JSON.stringify(a) !== JSON.stringify(b);
})());

/* 草丛：成片聚集，坦克可以钻进去藏身 */
{
  let bush = 0, lone = 0, area = 0, maxPatch = 0;
  for (let i = 0; i < 300; i++) {
    const w = T.createWorld({ cols: 25, rows: 19, seed: i * 7919 + 13, tankSlots: 4 });
    // 统计连通块大小
    const seen = new Uint8Array(w.cols * w.rows);
    for (let r = 1; r < w.rows - 1; r++) {
      for (let c = 1; c < w.cols - 1; c++) {
        const i0 = r * w.cols + c;
        if (w.tiles[i0] !== T.BUSH) continue;
        bush++;
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .filter(([dx, dy]) => w.tiles[(r + dy) * w.cols + (c + dx)] === T.BUSH).length;
        if (nb === 0) lone++;
        if (!seen[i0]) {
          let size = 0;
          const stack = [i0];
          seen[i0] = 1;
          while (stack.length) {
            const cur = stack.pop();
            size++;
            const cx = cur % w.cols, cy = (cur - cx) / w.cols;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= w.cols || ny >= w.rows) continue;
              const ni = ny * w.cols + nx;
              if (!seen[ni] && w.tiles[ni] === T.BUSH) { seen[ni] = 1; stack.push(ni); }
            }
          }
          maxPatch = Math.max(maxPatch, size);
        }
      }
    }
    area += (w.cols - 2) * (w.rows - 2);
  }
  const ratio = bush / area;
  check('草丛成片生长且面积够大（可供藏身）', ratio >= 0.10 && lone / bush < 0.35 && maxPatch >= 12,
    '草丛占内部 ' + (ratio * 100).toFixed(1) + '%，孤立格 ' + (lone / bush * 100).toFixed(1) + '%，最大一片 ' + maxPatch + ' 格');
}

/* ================= 2. 旋转与弹道 ================= */
console.log('\n== 2. 360° 旋转与弹道 ==');
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 77, tankSlots: 2, freeze: 0 });
  for (let r = 1; r < 18; r++) for (let c = 1; c < 24; c++) w.tiles[r * 25 + c] = T.EMPTY;  // 清空内部做纯运动测试
  const tk = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 9 });
  tk.invuln = 0; tk.angle = 0;

  const a0 = tk.angle;
  tk.input.left = true;
  for (let s = 0; s < 30; s++) T.stepWorld(w, 1 / 60);      // 0.5s 左转
  T.flushEvents(w);
  const aL = T.norm(tk.angle - a0);
  check('按左转键会逆时针旋转', aL < -0.1, '0.5s 转了 ' + (aL * R2D).toFixed(0) + '°');

  tk.input.left = false; tk.input.right = true;
  const a1 = tk.angle;
  for (let s = 0; s < 30; s++) T.stepWorld(w, 1 / 60);
  T.flushEvents(w);
  const aR = T.norm(tk.angle - a1);
  check('按右转键会顺时针旋转', aR > 0.1, '0.5s 转了 ' + (aR * R2D).toFixed(0) + '°');
  tk.input.right = false;

  // 让车头朝右（π/2），前进应该 x 变大、y 不变
  tk.angle = Math.PI / 2;
  tk.x = 400; tk.y = 304;
  const x0 = tk.x, y0 = tk.y;
  tk.input.up = true;
  for (let s = 0; s < 60; s++) T.stepWorld(w, 1 / 60);
  T.flushEvents(w);
  tk.input.up = false;
  check('前进沿车头方向（可斜向/任意角度）',
    Math.abs(tk.x - x0) > 40 && Math.abs(tk.y - y0) < 2,
    '位移 (' + (tk.x - x0).toFixed(0) + ', ' + (tk.y - y0).toFixed(0) + ')');

  // +45°（约定：0 = 朝上，角度顺时针增大）→ 朝右上
  tk.angle = Math.PI / 4; tk.x = 400; tk.y = 304;
  const x1 = tk.x, y1 = tk.y;
  tk.input.up = true;
  for (let s = 0; s < 60; s++) T.stepWorld(w, 1 / 60);
  T.flushEvents(w);
  tk.input.up = false;
  check('可以沿 45° 斜向移动', tk.x - x1 > 20 && tk.y - y1 < -20,
    '位移 (' + (tk.x - x1).toFixed(0) + ', ' + (tk.y - y1).toFixed(0) + ')');

  // 弹道跟随车头方向
  const before = w.bullets.length;
  tk.angle = Math.PI / 2; tk.x = 400; tk.y = 304; tk.cooldown = 0; tk.input.fire = true;
  T.stepWorld(w, 1 / 60);
  T.flushEvents(w);
  tk.input.fire = false;
  const b = w.bullets[w.bullets.length - 1];
  check('炮弹出口方向 = 车头方向', w.bullets.length > before && Math.abs(T.norm(b.angle - Math.PI / 2)) < 0.01,
    '子弹角度 ' + (b.angle * R2D).toFixed(1) + '°');
}

/* ================= 3. 子弹反弹 + 会打中自己 ================= */
console.log('\n== 3. 子弹反弹 与 自伤 ==');
{
  // 空场地 + 外圈钢墙：朝正前方开一枪，子弹必然原路弹回。
  // 注意：自伤默认是关闭的，这里显式打开来验证"开了自伤就会被自己打死"
  const w = T.createWorld({ cols: 25, rows: 19, seed: 9, tankSlots: 2, freeze: 0, selfDamage: true });
  for (let r = 1; r < 18; r++) for (let c = 1; c < 24; c++) w.tiles[r * 25 + c] = T.EMPTY;
  const tk = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 3 });
  tk.x = 400; tk.y = 304; tk.angle = 0; tk.invuln = 0; tk.lives = 3;
  tk.input.fire = true;
  T.stepWorld(w, 1 / 60);
  T.flushEvents(w);
  tk.input.fire = false;
  const fired = w.bullets.length;
  check('可以发射子弹', fired > 0, fired + ' 发');

  let ricochet = 0, hitSelf = false, age = 0, alive0 = tk.alive;
  for (let s = 0; s < 60 * 3; s++) {
    T.stepWorld(w, 1 / 60);
    for (const e of T.flushEvents(w)) {
      if (e.k === 'ricochet') ricochet++;
      if (e.k === 'kill' && e.suicide) hitSelf = true;
    }
    age += 1 / 60;
    if (hitSelf) break;
  }
  check('子弹撞墙会反弹', ricochet > 0, '共 ' + ricochet + ' 次反弹，用时 ' + age.toFixed(2) + 's');
  check('开启自伤时，弹回来的子弹能打中自己', hitSelf && tk.lives < 3 && !tk.alive,
    '生命 ' + tk.lives + '，坦克存活=' + tk.alive);

  // 默认（房间没开自伤）：同样的场景下自己不会被打伤
  const w2 = T.createWorld({ cols: 25, rows: 19, seed: 9, tankSlots: 2, freeze: 0 });
  for (let r = 1; r < 18; r++) for (let c = 1; c < 24; c++) w2.tiles[r * 25 + c] = T.EMPTY;
  const tk2 = T.addTank(w2, { id: 1, slot: 0, name: 'A', lives: 3 });
  tk2.x = 400; tk2.y = 304; tk2.angle = 0; tk2.invuln = 0; tk2.lives = 3;
  tk2.input.fire = true;
  T.stepWorld(w2, 1 / 60);
  T.flushEvents(w2);
  tk2.input.fire = false;
  let self2 = false, bounces2 = 0;
  for (let s2 = 0; s2 < 60 * 3; s2++) {
    T.stepWorld(w2, 1 / 60);
    for (const e of T.flushEvents(w2)) {
      if (e.k === 'ricochet') bounces2++;
      if (e.k === 'kill' && e.suicide) self2 = true;
    }
  }
  check('默认不自伤：反弹回来也不会伤到自己', !self2 && tk2.alive && tk2.lives === 3 && bounces2 > 0,
    '反弹 ' + bounces2 + ' 次，生命 ' + tk2.lives + '，存活=' + tk2.alive);
}

/* ================= 4. 子弹寿命 ================= */
console.log('\n== 4. 子弹存活时间 ==');
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 33, tankSlots: 2, freeze: 0 });
  for (let r = 1; r < 18; r++) for (let c = 1; c < 24; c++) w.tiles[r * 25 + c] = T.EMPTY;
  const tk = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 999 });
  tk.x = 400; tk.y = 304; tk.angle = Math.PI / 4; tk.invuln = 0; tk.lives = 999;
  tk.input.fire = true;
  T.stepWorld(w, 1 / 60);
  T.flushEvents(w);
  tk.input.fire = false;
  const bid = w.bullets[0] ? w.bullets[0].id : null;

  let existed = 0, gone = false;
  for (let s = 0; s < 60 * 6; s++) {
    T.stepWorld(w, 1 / 60);
    T.flushEvents(w);
    const still = w.bullets.some(b => b.id === bid);
    if (still) existed += 1 / 60; else if (existed > 0) { gone = true; break; }
  }
  check('子弹飞一段时间会自行消失', gone && existed <= T.BULLET_LIFE + 0.05,
    '存活 ' + existed.toFixed(2) + 's（上限 ' + T.BULLET_LIFE + 's）');
}

/* ================= 5. 子弹上限 ================= */
console.log('\n== 5. 子弹上限 ==');
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 7, tankSlots: 2, freeze: 0 });
  for (let r = 1; r < 18; r++) for (let c = 1; c < 24; c++) w.tiles[r * 25 + c] = T.EMPTY;
  const tk = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 999 });
  tk.x = 400; tk.y = 304; tk.angle = 0; tk.invuln = 0; tk.lives = 999;
  let maxMine = 0, shots = 0;
  for (let s = 0; s < 60 * 5; s++) {
    tk.input.fire = true;
    T.stepWorld(w, 1 / 60);
    for (const e of T.flushEvents(w)) if (e.k === 'shoot') shots++;
    let mine = 0;
    for (const b of w.bullets) if (b.owner === 1) mine++;
    maxMine = Math.max(maxMine, mine);
  }
  check('同时在场子弹始终 ≤ 5', maxMine <= 5 && T.MAX_BULLETS === 5, '峰值 ' + maxMine + '，5 秒共开火 ' + shots + ' 次');
}

/* ================= 6. 特殊武器 ================= */
console.log('\n== 6. 特殊武器 ==');
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 99, tankSlots: 2, freeze: 0 });
  T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 99 });
  for (let s = 0; s < 60 * 40; s++) { T.stepWorld(w, 1 / 60); T.flushEvents(w); }
  check('对局进行一段时间后随机生成特殊武器', w.powerups.length > 0,
    '场上 ' + w.powerups.length + ' 个，类型示例 ' + (w.powerups[0] ? w.powerups[0].type : '-'));
}

/* ================= 7. AI 对战稳定性 ================= */
console.log('\n== 7. 机器人对战稳定性（迷宫内 4 个 AI） ==');
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 42, tankSlots: 4 });
  const tanks = [];
  for (let i = 0; i < 4; i++) tanks.push(T.addTank(w, { id: i + 1, slot: i, name: 'P' + i, bot: T.makeBot(2), lives: 3 }));
  let steps = 0, puSeen = 0, shots = 0, ricochets = 0;
  const t0 = Date.now();
  for (let s = 0; s < 60 * 240; s++) {
    T.stepWorld(w, 1 / 60);
    for (const e of T.flushEvents(w)) {
      if (e.k === 'spawn-pu') puSeen++;
      if (e.k === 'shoot') shots++;
      if (e.k === 'ricochet') ricochets++;
    }
    steps++;
    if (T.contenders(w).length <= 1) break;
  }
  check('对局能正常分出胜负', T.contenders(w).length <= 1,
    '用时 ' + (steps / 60).toFixed(1) + 's  CPU ' + (Date.now() - t0) + 'ms');
  console.log('       （共开火 ' + shots + ' 次，其中撞墙反弹 ' + ricochets + ' 次，掉落特殊武器 ' + puSeen + ' 次）');
}

/* ================= 8. 性能与体积 ================= */
console.log('\n== 8. 性能与快照体积 ==');
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 1, tankSlots: 4 });
  for (let i = 0; i < 4; i++) T.addTank(w, { id: i + 1, slot: i, name: 'P' + i, bot: T.makeBot(1), lives: 3 });
  const t0 = Date.now();
  const N = 60 * 30;
  for (let s = 0; s < N; s++) { T.stepWorld(w, 1 / 60); T.flushEvents(w); }
  const ms = Date.now() - t0;
  const simSec = N / 60;
  check('模拟速度远快于实时（留足余量）', ms < simSec * 20,
    simSec + 's 模拟用时 ' + ms + 'ms（约实时 ' + (simSec * 1000 / Math.max(1, ms)).toFixed(0) + ' 倍）');
  const size = Buffer.byteLength(JSON.stringify(T.serialize(w)));
  console.log('       4 坦克快照 JSON 约 ' + size + ' 字节，30Hz 约 ' + (size * 30 / 1024).toFixed(1) + ' KB/s');
}

/* ================= 9. 生命 / 护盾 / 墙体同步 / 速度约束 ================= */
console.log('\n== 9. 一条命 / 护盾挡一发 / 墙体同步 / 速度约束 ==');

/** 造一个空场地（只留外圈钢墙） */
function arena(seed, slots) {
  const w = T.createWorld({ cols: 25, rows: 19, seed, tankSlots: slots || 2, freeze: 0 });
  for (let r = 1; r < 18; r++) for (let c = 1; c < 24; c++) w.tiles[r * 25 + c] = T.EMPTY;
  return w;
}
/** 在任意位置放一颗已激活的子弹（绕过开火间隔与炮口位置，用于精确验证规则） */
function spawnBullet(w, x, y, angle, ownerId) {
  w.bullets.push({
    id: w.nextEntity++, x, y, angle, owner: ownerId,
    power: false, speed: T.BULLET_SPEED, age: 0, bounce: 0, armed: true
  });
}
/** 从 from 处朝 to 打一颗子弹（起点离 owner 足够远，避免立刻打到自己） */
function shootAt(w, from, to, ownerId) {
  spawnBullet(w, from.x, from.y, Math.atan2(to.x - from.x, -(to.y - from.y)), ownerId);
}

// 9.1 默认一条命
{
  const w = arena(3, 2);
  const t = T.addTank(w, { id: 1, slot: 0, name: 'A' });
  check('坦克默认只有一条命（不是三条）', t.lives === 1, 'lives=' + t.lives);
  t.invuln = 0;
  T.damageTank(w, t, 2);
  check('被打中一次即出局（不会复活）', !t.alive && t.lives === 0, 'alive=' + t.alive + ' lives=' + t.lives);
  let revived = false;
  for (let s = 0; s < 60 * 6; s++) { T.stepWorld(w, 1 / 60); T.flushEvents(w); if (t.alive) { revived = true; break; } }
  check('出局后不会自动复活', !revived);
}

// 9.2 护盾只挡一次子弹
{
  const w = arena(4, 2);
  const a = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 5 });
  const b = T.addTank(w, { id: 2, slot: 1, name: 'B', lives: 5 });
  a.x = 300; a.y = 300; a.invuln = 0;
  b.x = 460; b.y = 300; b.invuln = 0;
  b.power.shield = 10;
  shootAt(w, { x: b.x - 60, y: b.y }, b, a.id);
  let shieldBroke = false;
  for (let s = 0; s < 60; s++) {
    T.stepWorld(w, 1 / 60);
    for (const e of T.flushEvents(w)) if (e.k === 'shield') shieldBroke = true;
  }
  check('第一颗子弹被护盾挡下（不掉命）', b.alive && b.lives === 5, '生命 ' + b.lives);
  check('挡下后护盾立即消失', shieldBroke && b.power.shield === 0, 'shield=' + b.power.shield);

  shootAt(w, { x: b.x - 60, y: b.y }, b, a.id);
  for (let s = 0; s < 60; s++) { T.stepWorld(w, 1 / 60); T.flushEvents(w); }
  check('第二颗子弹就打中了（护盾只挡一次）', !b.alive && b.lives === 4, 'alive=' + b.alive + ' 生命 ' + b.lives);
}

// 9.3 打掉的墙要被记下来（否则联机客户端会画着"假墙"）
{
  const w = arena(5, 2);
  w.tiles[5 * 25 + 5] = T.BRICK;
  const tk = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 9 });
  tk.x = 620; tk.y = 500; tk.invuln = 0;          // 坦克放远点，别被自己这颗测试子弹打到
  spawnBullet(w, 5 * 32 + 16, 5 * 32 + 16 + 46, 0, tk.id);   // 从砖块正下方朝上打
  for (let s = 0; s < 60; s++) { T.stepWorld(w, 1 / 60); T.flushEvents(w); }
  const idx = 5 * 25 + 5;
  check('打掉的砖墙在 tileChanges 里有记录', w.tiles[idx] === T.EMPTY && w.tileChanges.indexOf(idx) >= 0,
    'tileChanges=' + JSON.stringify(w.tileChanges));
  const taken = T.flushTiles(w);
  check('flushTiles 能取走并清空变更列表', taken.indexOf(idx) >= 0 && w.tileChanges.length === 0);
}

// 9.3b 各种入射角度/距离都要能打碎砖块（历史上"只弹不碎"就是假墙的来源）
{
  const cx = 5 * 32 + 16, cy = 5 * 32 + 16;
  const idx = 5 * 25 + 5;
  let tried = 0, broke = 0;
  for (const dist of [30, 38, 47, 55, 64, 72]) {
    for (let a = 0; a < 8; a++) {
      const ang = a * Math.PI / 4;
      const w = arena(200 + tried * 7, 2);
      w.tiles[idx] = T.BRICK;
      const tk = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 9 });
      tk.x = 620; tk.y = 500; tk.invuln = 0;
      const sx = cx + Math.sin(ang) * dist, sy = cy - Math.cos(ang) * dist;
      spawnBullet(w, sx, sy, Math.atan2(cx - sx, -(cy - sy)), tk.id);
      tried++;
      for (let s = 0; s < 30; s++) { T.stepWorld(w, 1 / 60); T.flushEvents(w); }
      if (w.tiles[idx] === T.EMPTY) broke++;
    }
  }
  check('任意入射角度/距离都能打碎砖块（不会"只弹不碎"）', broke === tried, broke + '/' + tried);
}

// 9.4 坦克速度必须慢于子弹
{
  check('坦克最大速度（含加速道具）明显小于子弹速度',
    T.MAX_TANK_SPEED < T.BULLET_SPEED * 0.75,
    '坦克 ' + T.MAX_TANK_SPEED.toFixed(0) + ' px/s vs 子弹 ' + T.BULLET_SPEED.toFixed(0) + ' px/s');

  // 实测：开着加速道具全速前进，往前打出的子弹只会越跑越远（1 秒内还没撞到墙反弹）
  const w = arena(6, 1);
  const tk = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 9 });
  tk.x = 70; tk.y = 304; tk.angle = Math.PI / 2;   // 朝 +x，右侧还有 690px 才到墙
  tk.invuln = 0;
  tk.power.speed = 60;
  tk.input.up = true; tk.input.fire = true;
  T.stepWorld(w, 1 / 60);
  T.flushEvents(w);
  const b0 = w.bullets[0];
  let minGap = 999, selfHit = false, grew = true, lastGap = -999;
  for (let s = 0; s < 60; s++) {                   // 1 秒：子弹 298px、坦克 151px，都不该撞墙
    T.stepWorld(w, 1 / 60);
    for (const e of T.flushEvents(w)) if (e.k === 'kill' && e.id === tk.id) selfHit = true;
    if (b0 && w.bullets.indexOf(b0) >= 0) {
      const gap = b0.x - tk.x;
      minGap = Math.min(minGap, gap);
      if (gap < lastGap - 0.01) grew = false;
      lastGap = gap;
    }
    if (selfHit) break;
  }
  check('全速前进时子弹只会越跑越远（不会打死自己）', !selfHit && grew && minGap > 8 && lastGap > 120,
    '1 秒后子弹领先 ' + lastGap.toFixed(1) + 'px，最近 ' + minGap.toFixed(1) + 'px');
}

// 9.5 子弹寿命 5 秒
{
  check('子弹存活时间已调为 5 秒', Math.abs(T.BULLET_LIFE - 5) < 1e-6, T.BULLET_LIFE + 's');
  const w = arena(7, 1);
  const tk = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 9 });
  tk.x = 400; tk.y = 304; tk.angle = Math.PI / 4; tk.invuln = 0;
  tk.input.fire = true;
  T.stepWorld(w, 1 / 60);
  T.flushEvents(w);
  tk.input.fire = false;
  let age = 0;
  while (w.bullets.length && age < 20) { T.stepWorld(w, 1 / 60); T.flushEvents(w); age += 1 / 60; }
  check('子弹约 5 秒后自行消失', age > 4.5 && age <= T.BULLET_LIFE + 0.1, '存活 ' + age.toFixed(2) + 's');
}

/* ================= 10. 激光 与 隐身 ================= */
console.log('\n== 10. 激光与隐身 ==');

// 10.1 激光：贯穿砖墙、打中后面的坦克、路程有上限、不打外圈
{
  const w = arena(31, 2);
  const wallIdx = 4 * 25 + 10;                 // 正前方那格砖
  w.tiles[wallIdx] = T.BRICK;
  const a = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 5 });
  a.x = 10 * 32 + 16 - 96; a.y = 4 * 32 + 16; a.angle = Math.PI / 2; a.invuln = 0;
  const b = T.addTank(w, { id: 2, slot: 1, name: 'B', lives: 5 });
  b.x = 10 * 32 + 16 + 120; b.y = a.y; b.invuln = 0;
  a.power.laser = 30;
  a.input.fire = true;
  T.stepWorld(w, 1 / 60);
  const evs = T.flushEvents(w);
  a.input.fire = false;
  const laserEv = evs.find(e => e.k === 'laser');
  check('激光会产出一条光束事件（客户端据此画路径）', !!laserEv, laserEv ? '长度 ' + laserEv.len + 'px' : '无');
  check('激光贯穿砖墙（砖被打掉）', w.tiles[wallIdx] === T.EMPTY);
  check('激光继续前进并打中后面的坦克', !b.alive && b.lives === 4, 'B alive=' + b.alive);
  check('激光路程有上限', !!laserEv && laserEv.len <= T.LASER_RANGE, '上限 ' + T.LASER_RANGE + 'px');

  // 朝边界打：外圈不可摧毁，否则坦克能开出地图
  const w2 = arena(32, 1);
  const c = T.addTank(w2, { id: 1, slot: 0, name: 'A', lives: 5 });
  c.x = 40; c.y = 304; c.angle = -Math.PI / 2; c.invuln = 0;   // 朝 -x，正对左边界
  c.power.laser = 30;
  c.input.fire = true;
  T.stepWorld(w2, 1 / 60);
  T.flushEvents(w2);
  c.input.fire = false;
  check('激光打不掉地图外圈（坦克不会被放出去）', w2.tiles[10 * 25 + 0] === T.STEEL);
}

// 10.2 隐身：AI 看不见、开火现形、捡别的道具也现形
{
  const w = arena(33, 2);
  const a = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 5 });
  const b = T.addTank(w, { id: 2, slot: 1, name: 'B', lives: 5 });
  a.x = 200; a.y = 300; a.invuln = 0;
  b.x = 400; b.y = 300; b.invuln = 0;
  check('没隐身时能正常发现对手', !!T.nearestEnemy(w, a));
  b.power.stealth = 15;
  check('隐身的坦克不会被找到', T.nearestEnemy(w, a) === null);

  // 开火 → 现形
  b.angle = 0;
  b.input.fire = true;
  T.stepWorld(w, 1 / 60);
  let revealed = T.flushEvents(w).some(e => e.k === 'reveal');
  b.input.fire = false;
  check('隐身中开火会立刻现形', b.power.stealth === 0 && revealed, 'stealth=' + b.power.stealth);

  // 捡到别的道具 → 现形
  b.power.stealth = 15;
  b.cooldown = 9;                                     // 别让它顺手再开一火
  b.x = 400; b.y = 300;
  w.powerups.push({ id: w.nextEntity++, x: b.x, y: b.y, type: 'speed', ttl: 5 });
  T.stepWorld(w, 1 / 60);
  const evs2 = T.flushEvents(w);
  check('隐身中捡到别的道具会立刻现形', b.power.stealth === 0 && evs2.some(e => e.k === 'reveal'),
    'stealth=' + b.power.stealth + ' 事件 ' + evs2.map(e => e.k).join(','));

  // 再捡一个隐身只续时间，不会现形
  b.power.stealth = 3;
  w.powerups.push({ id: w.nextEntity++, x: b.x, y: b.y, type: 'stealth', ttl: 5 });
  T.stepWorld(w, 1 / 60);
  T.flushEvents(w);
  check('再捡一个隐身只是续时间', b.power.stealth > 10, 'stealth=' + b.power.stealth.toFixed(1));

  // 隐身时长 15 秒
  check('隐身持续 20 秒', T.DURATION.stealth === 20, T.DURATION.stealth + 's');
}

// 10.3 隐身只在联机模式出现
{
  const local = T.createWorld({ cols: 25, rows: 19, seed: 4242, tankSlots: 2, freeze: 0 });
  const online = T.createWorld({ cols: 25, rows: 19, seed: 4242, tankSlots: 2, freeze: 0, online: true });
  check('本地对局默认不是联机', local.online === false);
  check('联机对局带 online 标记', online.online === true);
  check('本地道具池不含隐身', T.powerupTypes(local).indexOf('stealth') < 0,
    T.powerupTypes(local).join(','));
  check('本地道具池仍含激光等其余道具',
    ['speed', 'rapid', 'triple', 'power', 'laser', 'shield', 'life'].every(t => T.powerupTypes(local).indexOf(t) >= 0));
  check('联机道具池含隐身', T.powerupTypes(online).indexOf('stealth') >= 0);

  // 真刷几百个：本地一次都不该出现隐身
  let localTypes = {};
  for (let i = 0; i < 400; i++) {
    local.powerups.length = 0;
    const pu = T.spawnPowerup(local);
    if (pu) localTypes[pu.type] = (localTypes[pu.type] || 0) + 1;
  }
  check('本地对局 400 次掉落都没有隐身', !localTypes.stealth, JSON.stringify(localTypes));
  check('本地对局掉落种类齐全（7 种）', Object.keys(localTypes).length === 7, Object.keys(localTypes).join(','));

  let onlineTypes = {};
  for (let i = 0; i < 400; i++) {
    online.powerups.length = 0;
    const pu = T.spawnPowerup(online);
    if (pu) onlineTypes[pu.type] = (onlineTypes[pu.type] || 0) + 1;
  }
  check('联机对局能掉出隐身', (onlineTypes.stealth || 0) > 0, JSON.stringify(onlineTypes));
  check('联机对局掉落 8 种', Object.keys(onlineTypes).length === 8, Object.keys(onlineTypes).join(','));
}

// 10.4 掉落节奏：一袋之内每种道具各出现一次（不会再"玩一局见不到激光"）
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 909, tankSlots: 2, freeze: 0, online: true });
  const pool = T.powerupTypes(w);
  const seen = [];
  for (let i = 0; i < pool.length; i++) seen.push(T.pickPowerupType(w));
  check('一轮之内 8 种道具各掉一次（洗牌袋）',
    pool.every(t => seen.indexOf(t) >= 0) && seen.length === pool.length, seen.join(','));
  check('同一轮内不重复', new Set(seen).size === seen.length, seen.join(','));

  // 实战节奏：100 秒内每种道具都至少出现过一次（一轮 8 个约 40~50 秒）
  const w2 = T.createWorld({ cols: 25, rows: 19, seed: 313, tankSlots: 4, freeze: 0, online: true });
  for (let i = 0; i < 4; i++) T.addTank(w2, { id: 100 + i, slot: i, name: 'B' + i, lives: 5, bot: T.makeBot(1) });
  const got = {};
  let prev = [];
  for (let f = 0; f < 100 * 60; f++) {
    prev = w2.powerups.map(p => p.id);
    T.stepWorld(w2, 1 / 60);
    for (const p of w2.powerups) if (prev.indexOf(p.id) < 0) got[p.type] = (got[p.type] || 0) + 1;
  }
  const missing = T.powerupTypes(w2).filter(t => !got[t]);
  check('100 秒实战内每种道具都出现过', missing.length === 0,
    missing.length ? ('缺 ' + missing.join(',')) : JSON.stringify(got));
  check('100 秒掉落数量足够（≥10 个）', Object.values(got).reduce((a, b) => a + b, 0) >= 10,
    '共 ' + Object.values(got).reduce((a, b) => a + b, 0) + ' 个');
}

// 10.5 房间可配置掉落池：只勾选激光就只掉激光
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 555, tankSlots: 2, freeze: 0, online: true, powerups: ['laser', 'speed'] });
  const pool2 = T.powerupTypes(w);
  check('道具池按房间配置过滤', pool2.length === 2 && pool2.indexOf('laser') >= 0 && pool2.indexOf('speed') >= 0,
    pool2.join(','));
  const seen = {};
  for (let i = 0; i < 100; i++) { w.powerups.length = 0; const p = T.spawnPowerup(w); if (p) seen[p.type] = 1; }
  check('只掉勾选过的道具', !seen.shield && !seen.life && !seen.stealth, Object.keys(seen).join(','));

  // 非法配置不能把池子清空（否则一个道具都不刷）
  const w2 = T.createWorld({ cols: 25, rows: 19, seed: 556, tankSlots: 2, freeze: 0, powerups: ['不存在的道具'] });
  check('非法配置回退为默认道具池', T.powerupTypes(w2).length > 0, T.powerupTypes(w2).join(','));
}

// 10.6 加命道具：+1 命且有上限，绝不是无敌
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 77, tankSlots: 2, freeze: 0 });
  const a = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 1 });
  T.addTank(w, { id: 2, slot: 1, name: 'B', lives: 1 });
  a.invuln = 0;
  T.applyPowerup(w, a, 'life');
  check('捡到加命 = 命数 +1', a.lives === 2, 'lives=' + a.lives);
  check('加命不会给无敌时间', a.invuln === 0 && !(a.power && a.power.shield > 0),
    'invuln=' + a.invuln + ' shield=' + (a.power ? a.power.shield : 0));

  // 连捡 10 个也不会无限叠加（否则就是"打不死"）
  for (let i = 0; i < 10; i++) T.applyPowerup(w, a, 'life');
  check('命数有上限（最多 ' + T.MAX_LIVES + ' 条）', a.lives === T.MAX_LIVES, 'lives=' + a.lives);

  // 命再多也照样会被打死：每挨一发少一条命
  let hits = 0;
  while (a.alive && hits < 20) { a.invuln = 0; a.power.shield = 0; T.damageTank ? T.damageTank(w, a, 2) : null; hits++; }
  check('命数再多也不是无敌（会被打死）', !a.alive && hits <= T.MAX_LIVES + 1,
    '打了 ' + hits + ' 次后 alive=' + a.alive + ' lives=' + a.lives);
}

// 10.7 激光：一次性 + 判定与画出来的光束一致
{
  /** 造一个空场地，A 在左、B 在右，横向偏移 off 像素 */
  function laserArena(off) {
    const w = T.createWorld({ cols: 25, rows: 19, seed: 88, tankSlots: 2, freeze: 0 });
    for (let r = 1; r < 18; r++) for (let c = 1; c < 24; c++) w.tiles[r * 25 + c] = T.EMPTY;
    const a = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 1 });
    const b = T.addTank(w, { id: 2, slot: 1, name: 'B', lives: 1 });
    a.x = 200; a.y = 300; a.invuln = 0; a.cooldown = 0;
    b.x = 380; b.y = 300 + off; b.invuln = 0;
    a.angle = Math.PI / 2;                       // dirX=1 → 朝右
    return { w, a, b };
  }

  let { w, a, b } = laserArena(0);
  a.power.laser = 14;
  T.fireLaser(w, a);
  check('正面激光能打中', !b.alive, 'B alive=' + b.alive);

  ({ w, a, b } = laserArena(T.TANK_R - 3));       // 偏一点（车身之内）也应打中
  a.power.laser = 14;
  T.fireLaser(w, a);
  check('光束压到车身边缘也算命中', !b.alive, '偏移 ' + (T.TANK_R - 3) + 'px，B alive=' + b.alive);

  ({ w, a, b } = laserArena(T.TANK_R + 14));      // 明显偏出光束 → 不该打中
  a.power.laser = 14;
  T.fireLaser(w, a);
  check('偏离光束之外不会误伤', b.alive, '偏移 ' + (T.TANK_R + 14) + 'px，B alive=' + b.alive);

  // 一次性：打完就没了
  ({ w, a, b } = laserArena(0));
  a.power.laser = 14;
  T.fireLaser(w, a);
  check('激光射一次后立刻失效', a.power.laser === 0, 'laser=' + a.power.laser);
  const before = b.deaths;
  a.cooldown = 0;
  T.fire(w, a);                                   // 再开火只能打出普通子弹
  T.flushEvents(w);
  check('激光用完后恢复普通子弹', w.bullets.length > 0 && b.deaths === before,
    '子弹 ' + w.bullets.length + ' 颗');

  // 激光扫草丛：正面那格直接清空，周围一圈被打薄（"大幅度消失"）
  ({ w, a, b } = laserArena(0));
  b.alive = false;
  const bushC = 6, bushR = Math.floor(a.y / T.TILE);       // 就在射线经过的那一行
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) w.tiles[(bushR + oy) * w.cols + (bushC + ox)] = T.BUSH;
  }
  const bushIdx2 = bushR * w.cols + bushC;
  a.power.laser = 14;
  T.fireLaser(w, a);
  const evsBush = T.flushEvents(w).filter(e => e.k === 'brick');
  check('激光把正面的草丛清成空地', w.tiles[bushIdx2] === T.EMPTY, '格子状态 ' + w.tiles[bushIdx2]);
  check('激光烧草丛会产生可同步的地图变更', w.tileChanges.indexOf(bushIdx2) >= 0, '变更条数 ' + w.tileChanges.length);
  check('烧掉的草丛事件里带了 bush 标记', evsBush.some(e => e.bush === true),
    JSON.stringify(evsBush.map(e => !!e.bush)));

  // 周围一圈也要"大幅度消失"：8 个邻居里至少 6 个变成稀疏草丛或被清掉
  let thinned = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oy) continue;
      const nt = w.tiles[(bushR + oy) * w.cols + (bushC + ox)];
      if (nt === T.GRAZED || nt === T.BUSH_THIN || nt === T.EMPTY) thinned++;
    }
  }
  check('激光会把草丛周围一圈也削掉（大幅消失）', thinned >= 6, '邻居削弱 ' + thinned + '/8');
  check('地图变更是 [索引, 新值] 成对下发', w.tileChanges.length % 2 === 0 && w.tileChanges.length >= 2,
    JSON.stringify(w.tileChanges.slice(0, 6)));

  // 光束长度与命中位置一致（不会画到墙里去 / 停在半空）
  ({ w, a, b } = laserArena(0));
  b.alive = false;                                 // 清空目标，只量长度
  a.power.laser = 14;
  T.fireLaser(w, a);
  const evs = T.flushEvents(w).filter(e => e.k === 'laser');
  check('产出一条激光事件（客户端据此画光束）', evs.length === 1, JSON.stringify(evs[0]));
  check('光束起点在炮口、方向就是车头方向',
    evs.length === 1 && Math.abs(evs[0].a - a.angle) < 1e-6 &&
    Math.abs(evs[0].x - (a.x + T.dirX(a.angle) * (T.TANK_R + 1))) < 1e-6,
    evs.length ? ('起点 (' + evs[0].x.toFixed(1) + ',' + evs[0].y.toFixed(1) + ') 角度 ' + evs[0].a.toFixed(3)) : '无');
}

// 10.8 草丛：判定 + 躲在草丛里（联机时服务端据此把别人摘下快照）
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 31, tankSlots: 2, freeze: 0 });
  // 找一格树丛
  let bi = -1;
  for (let i = 0; i < w.tiles.length; i++) if (w.tiles[i] === T.BUSH) { bi = i; break; }
  check('地图上存在树丛', bi >= 0, '树丛格数 ' + w.tiles.filter(t => t === T.BUSH).length);
  const a = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 1 });
  const c = bi % w.cols, r = Math.floor(bi / w.cols);
  a.x = c * T.TILE + T.TILE / 2; a.y = r * T.TILE + T.TILE / 2;
  check('站在草丛格上算躲进草丛', T.inBush(w, a) === true, '格 (' + c + ',' + r + ')=' + w.tiles[bi]);
  a.x += T.TILE * 2;
  a.y = a.y;
  // 找一个不是树丛的空白格
  let empty = -1;
  for (let i = 0; i < w.tiles.length; i++) if (w.tiles[i] === T.EMPTY) { empty = i; break; }
  a.x = (empty % w.cols) * T.TILE + T.TILE / 2;
  a.y = Math.floor(empty / w.cols) * T.TILE + T.TILE / 2;
  check('不在草丛上就不算', T.inBush(w, a) === false);
}

// 10.9 子弹穿过草丛会把它打薄
{
  const w = T.createWorld({ cols: 25, rows: 19, seed: 66, tankSlots: 2, freeze: 0 });
  for (let r = 1; r < 18; r++) for (let c = 1; c < 24; c++) w.tiles[r * 25 + c] = T.EMPTY;
  const a = T.addTank(w, { id: 1, slot: 0, name: 'A', lives: 1 });
  a.x = 200; a.y = 300; a.angle = Math.PI / 2; a.invuln = 0; a.cooldown = 0;
  const bc = 10, br = Math.floor(a.y / T.TILE);          // 正前方那一格
  const bi = br * w.cols + bc;
  w.tiles[bi] = T.BUSH;

  const shootOnce = () => {
    w.bullets.length = 0;
    a.cooldown = 0;
    T.fire(w, a);
    T.flushEvents(w);
    for (let f = 0; f < 45; f++) T.stepWorld(w, 1 / 60);   // 0.75 秒，足够飞过那一格
  };

  shootOnce();
  check('子弹第一发只轻轻擦破草丛（轻擦状态）', w.tiles[bi] === T.GRAZED, '格子状态 ' + w.tiles[bi]);
  shootOnce();
  check('第二发才被削成稀疏草丛', w.tiles[bi] === T.BUSH_THIN, '格子状态 ' + w.tiles[bi]);
  shootOnce();
  check('连穿三发草丛才彻底没了', w.tiles[bi] === T.EMPTY, '格子状态 ' + w.tiles[bi]);

  // 稀疏草丛不再能藏坦克
  const w2 = T.createWorld({ cols: 25, rows: 19, seed: 67, tankSlots: 2, freeze: 0 });
  const t2 = T.addTank(w2, { id: 1, slot: 0, name: 'A', lives: 1 });
  const ci = 5, ri = 5;
  t2.x = ci * T.TILE + T.TILE / 2; t2.y = ri * T.TILE + T.TILE / 2;
  w2.tiles[ri * w2.cols + ci] = T.BUSH;
  check('完整草丛能藏人', T.inBush(w2, t2) === true);
  w2.tiles[ri * w2.cols + ci] = T.GRAZED;
  check('轻擦草丛藏不住人', T.inBush(w2, t2) === false);
  w2.tiles[ri * w2.cols + ci] = T.BUSH_THIN;
  check('稀疏草丛藏不住人', T.inBush(w2, t2) === false);
}

console.log('\n' + (failures === 0 ? '全部通过 ✔' : failures + ' 项失败 ✗'));
process.exit(failures === 0 ? 0 : 1);
