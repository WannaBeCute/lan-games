/*!
 * 坦克大战渲染层 —— 全部使用基础图形组合（无贴图、无 3D）
 */
(function (root) {
  'use strict';
  var TC = root.TankCore;
  var TILE = TC.TILE, BRICK = TC.BRICK, STEEL = TC.STEEL, WATER = TC.WATER, BUSH = TC.BUSH, BUSH_THIN = TC.BUSH_THIN, GRAZED = TC.GRAZED;

  /* ---------- 颜色工具 ---------- */
  function hex2rgb(h) {
    h = (h || '#888').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbStr(c, a) {
    return a == null ? 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' : 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  function shade(color, k) {
    var c = hex2rgb(color);
    return rgbStr([Math.max(0, Math.min(255, Math.round(c[0] * k))),
      Math.max(0, Math.min(255, Math.round(c[1] * k))),
      Math.max(0, Math.min(255, Math.round(c[2] * k)))]);
  }
  function light(color, k) {
    var c = hex2rgb(color);
    return rgbStr([Math.min(255, Math.round(c[0] + (255 - c[0]) * k)),
      Math.min(255, Math.round(c[1] + (255 - c[1]) * k)),
      Math.min(255, Math.round(c[2] + (255 - c[2]) * k))]);
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------- 地形 ---------- */
  function drawTile(ctx, type, px, py, c, r, time) {
    if (type === BRICK) {
      ctx.fillStyle = '#5c2f22';
      ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = '#b5644a';
      var bw = TILE / 2, bh = TILE / 4;
      for (var i = 0; i < 4; i++) {
        var off = (i % 2) ? bw / 2 : 0;
        for (var j = -1; j < 2; j++) {
          var x = px + j * bw + off;
          var xx = Math.max(px, x + 1.5), ww = Math.min(px + TILE, x + bw - 1.5) - xx;
          if (ww > 0) ctx.fillRect(xx, py + i * bh + 1.5, ww, bh - 3);
        }
      }
    } else if (type === STEEL) {
      ctx.fillStyle = '#4a505d';
      ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = '#98a3b5';
      ctx.fillRect(px + 3, py + 3, TILE - 6, TILE - 6);
      ctx.fillStyle = '#6d7789';
      ctx.fillRect(px + 3, py + 3, TILE - 6, 3);
      ctx.fillRect(px + 3, py + 3, 3, TILE - 6);
      ctx.fillStyle = '#c3ccdb';
      ctx.fillRect(px + 6, py + 6, 5, 5);
      ctx.fillRect(px + TILE - 11, py + TILE - 11, 5, 5);
      ctx.fillRect(px + TILE - 11, py + 6, 5, 5);
      ctx.fillRect(px + 6, py + TILE - 11, 5, 5);
    } else if (type === WATER) {
      ctx.fillStyle = '#123b5e';
      ctx.fillRect(px, py, TILE, TILE);
      ctx.strokeStyle = 'rgba(110,190,255,.55)';
      ctx.lineWidth = 2;
      for (var k = 0; k < 3; k++) {
        var yy = py + 7 + k * 9;
        var ph = Math.sin(time * 2.2 + (c + r) * 0.8 + k) * 3;
        ctx.beginPath();
        ctx.moveTo(px + 3, yy + ph);
        ctx.quadraticCurveTo(px + TILE / 2, yy - 3 + ph, px + TILE - 3, yy + ph);
        ctx.stroke();
      }
    }
  }

  function drawBush(ctx, px, py, c, r) {
    var seed = (c * 73856093) ^ (r * 19349663);
    // 草丛画得比格子略大：整格连坦克一起遮住；但圆形叶团之间会自然留下缝隙，
    // 所以看起来还是一丛丛的草，而不是一堵实心墙
    var over = 7;
    ctx.fillStyle = 'rgba(22,84,48,.95)';
    for (var i = 0; i < 8; i++) {
      var n = Math.abs((seed >> (i * 3)) % 100) / 100;
      var m = Math.abs((seed >> (i * 5)) % 100) / 100;
      var cx = px - over + n * (TILE + over * 2);
      var cy = py - over + m * (TILE + over * 2);
      ctx.beginPath();
      ctx.arc(cx, cy, 9 + n * 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(56,152,88,.8)';
    for (var j = 0; j < 6; j++) {
      var n2 = Math.abs((seed >> (j * 7 + 2)) % 100) / 100;
      var m2 = Math.abs((seed >> (j * 4 + 1)) % 100) / 100;
      ctx.beginPath();
      ctx.arc(px - over + 3 + n2 * (TILE + over * 2 - 6), py - over + 3 + m2 * (TILE + over * 2 - 6), 5 + n2 * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 被打薄/被烧过的草丛：又小又稀，一眼能看出"这里已经藏不住人了" */
  function drawBushThin(ctx, px, py, c, r) {
    var seed = (c * 40503) ^ (r * 12289);
    var over = 3;
    ctx.fillStyle = 'rgba(28,92,54,.5)';
    for (var i = 0; i < 3; i++) {
      var n = Math.abs((seed >> (i * 4)) % 100) / 100;
      var m = Math.abs((seed >> (i * 6 + 1)) % 100) / 100;
      ctx.beginPath();
      ctx.arc(px - over + n * (TILE + over * 2), py - over + m * (TILE + over * 2), 3 + n * 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(70,164,98,.4)';
    for (var j = 0; j < 2; j++) {
      var n2 = Math.abs((seed >> (j * 5 + 3)) % 100) / 100;
      var m2 = Math.abs((seed >> (j * 3 + 2)) % 100) / 100;
      ctx.beginPath();
      ctx.arc(px + 4 + n2 * (TILE - 8), py + 4 + m2 * (TILE - 8), 2 + n2 * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 被子弹轻轻擦过的草丛：比完整草丛稀一点、淡一点，但明显还是"一大丛草" */
  function drawBushGrazed(ctx, px, py, c, r) {
    var seed = (c * 29083) ^ (r * 77137);
    var over = 6;
    ctx.fillStyle = 'rgba(22,84,48,.82)';
    for (var i = 0; i < 6; i++) {
      var n = Math.abs((seed >> (i * 3)) % 100) / 100;
      var m = Math.abs((seed >> (i * 5)) % 100) / 100;
      ctx.beginPath();
      ctx.arc(px - over + n * (TILE + over * 2), py - over + m * (TILE + over * 2), 7 + n * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(56,152,88,.62)';
    for (var j = 0; j < 4; j++) {
      var n2 = Math.abs((seed >> (j * 7 + 2)) % 100) / 100;
      var m2 = Math.abs((seed >> (j * 4 + 1)) % 100) / 100;
      ctx.beginPath();
      ctx.arc(px - over + 3 + n2 * (TILE + over * 2 - 6), py - over + 3 + m2 * (TILE + over * 2 - 6), 4 + n2 * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------- 坦克 ---------- */
  function drawTank(ctx, t, now) {
    // 隐身：alpha 由上层给出（自己 0.32，别人更淡，0 表示完全不画）
    var alpha = t.alpha == null ? 1 : t.alpha;
    if (alpha <= 0.02) return;
    if (!t.alive) {
      // 复活倒计时
      ctx.save();
      ctx.globalAlpha = .75;
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 13, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }
    var color = t.color || '#4c8dff';
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.angle || 0);        // 车体按实际角度旋转，炮管与弹道一致
    ctx.globalAlpha = alpha;

    var half = TC.TANK_R;            // 11
    // 影子
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    roundRect(ctx, -half + 1, -half + 3, half * 2, half * 2, 4);
    ctx.fill();

    // 履带
    ctx.fillStyle = shade(color, 0.42);
    roundRect(ctx, -half, -half, 5, half * 2, 2); ctx.fill();
    roundRect(ctx, half - 5, -half, 5, half * 2, 2); ctx.fill();
    ctx.fillStyle = shade(color, 0.24);
    for (var i = -half + 2; i < half - 2; i += 5) {
      ctx.fillRect(-half + 1, i, 3, 2);
      ctx.fillRect(half - 4, i, 3, 2);
    }

    // 车体
    ctx.fillStyle = color;
    roundRect(ctx, -half + 4, -half + 1, half * 2 - 8, half * 2 - 3, 3);
    ctx.fill();

    // 涂装
    if (t.style === 'stripe') {
      ctx.fillStyle = light(color, .45);
      ctx.fillRect(-half + 5, -7, half * 2 - 10, 2.5);
      ctx.fillRect(-half + 5, -1, half * 2 - 10, 2.5);
      ctx.fillRect(-half + 5, 5, half * 2 - 10, 2.5);
    } else if (t.style === 'camo') {
      ctx.fillStyle = shade(color, .55);
      ctx.beginPath(); ctx.arc(-3, -4, 3.6, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(4, 3, 3.0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(-5, 6, 2.4, 0, 7); ctx.fill();
      ctx.fillStyle = light(color, .35);
      ctx.beginPath(); ctx.arc(4, -6, 2.2, 0, 7); ctx.fill();
    } else if (t.style === 'neon') {
      ctx.strokeStyle = light(color, .75);
      ctx.lineWidth = 1.6;
      ctx.shadowColor = color;
      ctx.shadowBlur = 9;
      roundRect(ctx, -half + 4, -half + 1, half * 2 - 8, half * 2 - 3, 3);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // 炮塔
    ctx.fillStyle = light(color, .22);
    ctx.beginPath(); ctx.arc(0, 0, 5.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = shade(color, .7);
    ctx.beginPath(); ctx.arc(0, 0, 2.6, 0, Math.PI * 2); ctx.fill();

    // 炮管
    ctx.fillStyle = shade(color, .62);
    ctx.fillRect(-2, -half - 4, 4, half + 2);

    // 激光装备时，炮口挂一个发光的激光发射器，一眼能看出"现在打的是激光"
    if (t.laser > 0) {
      var lg = TC.PU_COLOR.laser || '#ff2e88';
      ctx.save();
      ctx.globalAlpha = alpha * (0.7 + 0.3 * Math.sin(now * 12));
      ctx.fillStyle = lg;
      ctx.shadowColor = lg;
      ctx.shadowBlur = 10;
      ctx.fillRect(-3, -half - 8, 6, 6);
      ctx.restore();
    }

    // 无敌/护盾
    if (t.invuln > 0 || t.shield > 0) {
      var pulse = 0.45 + 0.35 * Math.sin(now * 9);
      ctx.strokeStyle = t.shield > 0 ? 'rgba(84,199,236,' + (0.55 + pulse * 0.45) + ')' : 'rgba(255,255,255,' + pulse + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, half + 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // 隐身：虚线圈提示"这辆现在是隐形的"
    if (t.stealth && alpha < 0.9) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = TC.PU_COLOR.stealth || '#9b8cff';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(t.x, t.y, half + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 名字（隐身时不显示，免得靠名牌暴露位置）
    if (t.showName && alpha > 0.9) {
      ctx.save();
      ctx.font = '600 11px "Microsoft YaHei", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      var w = ctx.measureText(t.name).width + 10;
      ctx.fillStyle = t.isMe ? 'rgba(76,141,255,.85)' : 'rgba(0,0,0,.55)';
      roundRect(ctx, t.x - w / 2, t.y - TC.TANK_SIZE - 12, w, 15, 5);
      ctx.fill();
      ctx.fillStyle = t.isMe ? '#fff' : '#cfd8e8';
      ctx.fillText(t.name, t.x, t.y - TC.TANK_SIZE - 1);
      ctx.restore();
    }
  }

  /* ---------- 子弹 / 特殊武器 ---------- */
  function drawBullet(ctx, b) {
    var color = b.power ? '#ffd166' : '#fff3c4';
    ctx.save();
    ctx.shadowColor = b.power ? '#ffb703' : '#fff8d0';
    ctx.shadowBlur = 8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.power ? 4.6 : 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * 道具牌子：不写抽象英文缩写（以前是 SPD/RPD/3X），改成
   * 「一眼看懂的小图形 + 中文名」——闪电=加速、火焰=连发、三叉=三连发、靶心=穿甲弹、盾=护盾、心=加命。
   */
  function drawPowerup(ctx, p, now) {
    var col = TC.PU_COLOR[p.type] || '#fff';
    var bob = Math.sin(now * 3 + p.x * 0.05) * 2;
    ctx.save();
    ctx.translate(p.x, p.y + bob);
    ctx.rotate(Math.sin(now * 1.6) * 0.06);
    ctx.shadowColor = col;
    ctx.shadowBlur = 14;
    ctx.fillStyle = 'rgba(14,18,26,.94)';
    roundRect(ctx, -15, -15, 30, 30, 8);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    roundRect(ctx, -15, -15, 30, 30, 8);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 只有图形，不写任何文字
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '400 20px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji","Segoe UI Symbol",sans-serif';
    ctx.fillText(TC.PU_LABEL[p.type] || '?', 0, 1);
    ctx.restore();
  }

  /* ---------- 特效 ---------- */
  function drawFx(ctx, fx) {
    for (var i = 0; i < fx.length; i++) {
      var f = fx[i];
      var k = f.t / f.life;             // 0 → 1
      var a = 1 - k;
      if (f.kind === 'boom' || f.kind === 'kill') {
        var maxR = f.kind === 'kill' ? 26 : 13;
        ctx.globalAlpha = a;
        ctx.fillStyle = k < 0.4 ? '#fff3b0' : (k < 0.7 ? '#ff9f43' : '#ff4d4d');
        ctx.beginPath(); ctx.arc(f.x, f.y, maxR * (0.35 + k * 0.9), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'spark') {
        ctx.globalAlpha = a;
        ctx.fillStyle = '#cfe6ff';
        ctx.beginPath(); ctx.arc(f.x, f.y, 3 + k * 3, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'ricochet') {
        ctx.globalAlpha = a;
        ctx.strokeStyle = '#cfe6ff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, 3 + k * 9, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'shield') {
        // 护盾被打碎：蓝色六边形冲击环
        ctx.globalAlpha = a * 0.9;
        ctx.strokeStyle = TC.PU_COLOR.shield || '#54c7ec';
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (var s = 0; s <= 6; s++) {
          var ang = s * Math.PI / 3 - Math.PI / 2;
          var rad = 8 + k * 22;
          var vx = f.x + Math.cos(ang) * rad, vy = f.y + Math.sin(ang) * rad;
          if (s === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'laser') {
        // 激光束：外光晕 + 白色亮核 + 命中点，随时间淡出
        var ex = f.x + TC.dirX(f.a) * f.len;
        var ey = f.y + TC.dirY(f.a) * f.len;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.lineCap = 'round';
        ctx.shadowColor = (TC.PU_COLOR && TC.PU_COLOR.laser) || '#ff2e88';
        ctx.shadowBlur = 16;
        ctx.strokeStyle = 'rgba(255,46,136,.6)';
        ctx.lineWidth = 15 * (1 - k * 0.5);
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 6 * (1 - k * 0.4);
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(ex, ey, 5 * (1 - k * 0.7), 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      } else if (f.kind === 'debris') {
        ctx.globalAlpha = a;
        ctx.fillStyle = f.color || '#b5644a';
        ctx.fillRect(f.x + f.vx * k * f.life, f.y + f.vy * k * f.life, 3, 3);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'text') {
        ctx.globalAlpha = a;
        ctx.font = '700 13px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = f.color || '#fff';
        ctx.fillText(f.text, f.x, f.y - k * 26);
        ctx.globalAlpha = 1;
      }
    }
  }

  /* ---------- 主绘制 ---------- */
  function draw(ctx, view) {
    var cols = view.cols, rows = view.rows, tiles = view.tiles;
    var W = cols * TILE, H = rows * TILE;
    var now = view.now || (performance.now() / 1000);

    // 背景
    ctx.fillStyle = '#0a0d13';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.022)';
    for (var gy = 0; gy < rows; gy++) {
      for (var gx = 0; gx < cols; gx++) {
        if ((gx + gy) % 2 === 0) ctx.fillRect(gx * TILE, gy * TILE, TILE, TILE);
      }
    }

    // 地形（树丛单独在最后画）
    var c, r, i, px, py, t;
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        t = tiles[r * cols + c];
        if (t === BUSH || t === 0) continue;
        drawTile(ctx, t, c * TILE, r * TILE, c, r, now);
      }
    }

    // 特殊武器
    for (i = 0; i < view.powerups.length; i++) drawPowerup(ctx, view.powerups[i], now);

    // 坦克
    for (i = 0; i < view.tanks.length; i++) drawTank(ctx, view.tanks[i], now);

    // 子弹
    for (i = 0; i < view.bullets.length; i++) drawBullet(ctx, view.bullets[i]);

    // 树丛（覆盖坦克）
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        var bt2 = tiles[r * cols + c];
        if (bt2 === BUSH) drawBush(ctx, c * TILE, r * TILE, c, r);
        else if (bt2 === GRAZED) drawBushGrazed(ctx, c * TILE, r * TILE, c, r);
        else if (bt2 === BUSH_THIN) drawBushThin(ctx, c * TILE, r * TILE, c, r);
      }
    }

    // 草丛是正常遮挡（草盖住坦克）。但"自己"要是也被盖住就没法操作了，
    // 所以把自己在草丛之上再半透明画一层；别人的车就让草正常盖着。
    for (i = 0; i < view.tanks.length; i++) {
      var tb = view.tanks[i];
      if (!tb.inBush || !tb.alive || !tb.isMe) continue;
      var ghost = {};
      for (var gk in tb) ghost[gk] = tb[gk];
      ghost.alpha = tb.alpha == null ? 0.5 : Math.min(tb.alpha, 0.5);
      drawTank(ctx, ghost, now);
    }

    // 特效
    if (view.fx && view.fx.length) drawFx(ctx, view.fx);

    // 冻结倒计时
    if (view.freeze > 0) {
      ctx.fillStyle = 'rgba(6,9,14,.42)';
      ctx.fillRect(0, 0, W, H);
      var n = Math.ceil(view.freeze);
      ctx.fillStyle = '#fff';
      ctx.font = '800 96px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(now * 4));
      ctx.fillText(n > 3 ? '准备' : String(n), W / 2, H / 2);
      ctx.globalAlpha = 1;
      ctx.font = '600 17px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#9dc0ff';
      ctx.fillText('第 ' + (view.roundIndex || 1) + ' / ' + (view.roundTotal || 1) + ' 局', W / 2, H / 2 + 74);
    }
  }

  root.TankRender = { draw: draw, drawTank: drawTank, shade: shade, light: light, roundRect: roundRect, hex2rgb: hex2rgb };
})(window);
