// 全景天空球贴图（等距柱状 / equirectangular 投影），用于 Three.js 球体内表面(BackSide)贴图。
// 约定：x: 0→width 对应方位角 0°→360°（整幅环绕一周）；y: 0→height 对应天顶 +90°→天底 -90°，地平线在 y = height/2。
// 关键：正北 N 固定在方位角 0°，即画布正中 x = width/2（用于校准朝向）。
// 因此 x = 0 与 x = width 为同一方位角（180°/正南），所有横向元素都必须做环绕，保证左右无缝。

const TAU = Math.PI * 2;

// 8 个方位地标：方位角 0/45/.../315 各一个，形状、颜色、高度均不同，便于判断朝向。
const LANDMARKS = [
  { label: 'N',  az: 0,   shape: 'spire',   color: '#63d8dc', hi: 0.34 },
  { label: 'NE', az: 45,  shape: 'arch',    color: '#d97ad9', hi: 0.22 },
  { label: 'E',  az: 90,  shape: 'block',   color: '#f0913e', hi: 0.26 },
  { label: 'SE', az: 135, shape: 'pyramid', color: '#7ec850', hi: 0.24 },
  { label: 'S',  az: 180, shape: 'obelisk', color: '#f4dc5a', hi: 0.30 },
  { label: 'SW', az: 225, shape: 'orb',     color: '#5a9df0', hi: 0.20 },
  { label: 'W',  az: 270, shape: 'column',  color: '#ef5f5f', hi: 0.27 },
  { label: 'NW', az: 315, shape: 'dome',    color: '#4fd0a8', hi: 0.18 },
];

// 各主题配色。sky: 天顶→地平线 4 个渐变色；ground: 地平线→天底 3 个渐变色。
const THEMES = {
  dusk: {
    sky: ['#1a1740', '#4a3a63', '#c65a37', '#ffb16b'],
    sun: { az: 205, alt: 0.10, core: '#ffe6b0', glow: '#ff8a4a', coreAlpha: 0.95, glowAlpha: 0.85, coreRf: 0.020, glowRf: 0.22 },
    moon: null,
    stars: 0,
    nebula: false, nebulaColors: [], nebulaCount: 0, milkyWay: false,
    cloudColor: '#ff9d6b', cloudAlpha: 0.50, cloudCount: 11,
    ridgeFar: '#3b2a52', ridgeNear: '#241832',
    ground: ['#7a3a2a', '#4a2020', '#1c0e12'],
    groundAccent: '#c0673f', groundSpeck: '#e8b07a',
    grid: '#ffd9b0', gridAlpha: 0.15,
  },
  day: {
    sky: ['#2b6fd0', '#6fb2e6', '#b9dcf2', '#e6f5fc'],
    sun: { az: 200, alt: 0.60, core: '#fffbe8', glow: '#ffe9a8', coreAlpha: 0.95, glowAlpha: 0.55, coreRf: 0.016, glowRf: 0.16 },
    moon: null,
    stars: 0,
    nebula: false, nebulaColors: [], nebulaCount: 0, milkyWay: false,
    cloudColor: '#ffffff', cloudAlpha: 0.50, cloudCount: 13,
    ridgeFar: '#88a6c4', ridgeNear: '#5d7c9e',
    ground: ['#87996a', '#5f6f49', '#3a462e'],
    groundAccent: '#a9b57e', groundSpeck: '#cdd6a3',
    grid: '#f2f7d8', gridAlpha: 0.12,
  },
  night: {
    sky: ['#03040a', '#0a1024', '#12224a', '#1b2f5e'],
    sun: null,
    moon: { az: 40, alt: 0.55, core: '#eef2f8', glow: '#cdd8f0', glowAlpha: 0.50, coreRf: 0.022, glowRf: 0.11 },
    stars: 900,
    nebula: false, nebulaColors: [], nebulaCount: 0, milkyWay: false,
    cloudColor: '#37476b', cloudAlpha: 0.40, cloudCount: 8,
    ridgeFar: '#101a2e', ridgeNear: '#080e1c',
    ground: ['#1b2740', '#0e1626', '#05080f'],
    groundAccent: '#2e4661', groundSpeck: '#8fa8c8',
    grid: '#9fb4d8', gridAlpha: 0.10,
  },
  space: {
    sky: ['#000000', '#020208', '#080a24', '#12123f'],
    sun: null,
    moon: { az: 40, alt: 0.50, core: '#e8eef8', glow: '#b0c0e8', glowAlpha: 0.45, coreRf: 0.020, glowRf: 0.10 },
    stars: 1400,
    nebula: true, nebulaColors: ['#7b5cff', '#ff5c9e', '#4fd0ff', '#b06bff', '#ff8a5c'], nebulaCount: 6, milkyWay: true,
    cloudColor: '#4a3f75', cloudAlpha: 0.26, cloudCount: 3,
    ridgeFar: '#0a0a1c', ridgeNear: '#04040e',
    ground: ['#0a0a18', '#050510', '#010104'],
    groundAccent: '#1a1a3a', groundSpeck: '#7f8fd8',
    grid: '#8fa0d8', gridAlpha: 0.10,
  },
};

/* ------------------------------------------------------------------ 基础工具 */

// 确定性伪随机数（mulberry32）：同一 seed 得到同一张图，可复现。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

function wrapX(x, width) {
  const m = x % width;
  return m < 0 ? m + width : m;
}

// 方位角(deg) → 画布 x。N(0°) 落在 x = width/2（正中），整幅环绕一周。
function azimuthToX(deg, width) {
  return wrapX(width / 2 + (deg / 360) * width, width);
}

// 环绕绘制：把同一元素同时画在 x、x-width、x+width，保证跨越左右边缘时无缝。
function drawAtAllWraps(x, w, fn) {
  fn(x);
  fn(x - w);
  fn(x + w);
}

/* ------------------------------------------------------------------ 背景分层 */

function drawSky(ctx, w, h, pal) {
  const hy = h / 2;
  const g = ctx.createLinearGradient(0, 0, 0, hy);
  g.addColorStop(0, pal.sky[0]);
  g.addColorStop(0.55, pal.sky[1]);
  g.addColorStop(0.85, pal.sky[2]);
  g.addColorStop(1, pal.sky[3]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, hy);
}

function drawSun(ctx, w, h, hy, s) {
  const x = azimuthToX(s.az, w);
  const y = hy - hy * s.alt;
  const coreR = h * s.coreRf;
  const glowR = h * s.glowRf;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // 光晕可能跨越左右边缘（如黄昏太阳方位角落在接缝附近），因此同时画三份副本。
  drawAtAllWraps(x, w, (cx) => {
    const g = ctx.createRadialGradient(cx, y, coreR * 0.3, cx, y, glowR);
    g.addColorStop(0, hexToRgba(s.glow, s.glowAlpha));
    g.addColorStop(0.35, hexToRgba(s.glow, s.glowAlpha * 0.35));
    g.addColorStop(1, hexToRgba(s.glow, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, y, glowR, 0, TAU);
    ctx.fill();
    ctx.fillStyle = hexToRgba(s.core, s.coreAlpha);
    ctx.beginPath();
    ctx.arc(cx, y, coreR, 0, TAU);
    ctx.fill();
  });
  ctx.restore();
}

function drawMoon(ctx, w, h, hy, m) {
  const x = azimuthToX(m.az, w);
  const y = hy - hy * m.alt;
  const coreR = h * m.coreRf;
  const glowR = h * m.glowRf;
  const craters = [[0.3, -0.2, 0.22], [-0.35, 0.1, 0.16], [0.1, 0.4, 0.12], [-0.1, -0.45, 0.1]];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  drawAtAllWraps(x, w, (cx) => {
    const g = ctx.createRadialGradient(cx, y, coreR * 0.5, cx, y, glowR);
    g.addColorStop(0, hexToRgba(m.glow, m.glowAlpha));
    g.addColorStop(1, hexToRgba(m.glow, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, y, glowR, 0, TAU);
    ctx.fill();
  });
  ctx.restore();
  ctx.save();
  drawAtAllWraps(x, w, (cx) => {
    ctx.fillStyle = hexToRgba(m.core, 1);
    ctx.beginPath();
    ctx.arc(cx, y, coreR, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(160,175,200,0.45)';
    for (const c of craters) {
      ctx.beginPath();
      ctx.arc(cx + c[0] * coreR, y + c[1] * coreR, coreR * c[2], 0, TAU);
      ctx.fill();
    }
  });
  ctx.restore();
}

function drawCelestial(ctx, w, h, pal) {
  const hy = h / 2;
  if (pal.sun) drawSun(ctx, w, h, hy, pal.sun);
  if (pal.moon) drawMoon(ctx, w, h, hy, pal.moon);
}

function drawStars(ctx, w, h, rnd, count) {
  const maxY = (h / 2) * 0.99;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    const x = rnd() * w;
    const y = rnd() * maxY;
    const s = 0.5 + rnd() * 1.8;
    const a = 0.25 + rnd() * 0.7;
    const t = rnd();
    const col = t < 0.15 ? '#cfe0ff' : t < 0.3 ? '#ffe6d0' : '#ffffff';
    ctx.fillStyle = hexToRgba(col, a);
    ctx.fillRect(x, y, s, s);
    if (x < s) ctx.fillRect(x + w, y, s, s);
    else if (x > w - s) ctx.fillRect(x - w, y, s, s);
  }
  const bright = Math.min(16, Math.floor(count / 40));
  for (let i = 0; i < bright; i++) {
    const x = rnd() * w;
    const y = rnd() * maxY;
    const r = 2 + rnd() * 4;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.4, 'rgba(200,220,255,0.35)');
    g.addColorStop(1, 'rgba(180,200,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 3, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawNebula(ctx, w, h, pal, rnd) {
  const hy = h / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < pal.nebulaCount; i++) {
    const nx = rnd() * w;
    const ny = hy * (0.1 + rnd() * 0.7);
    const rad = h * (0.12 + rnd() * 0.22);
    const col = pal.nebulaColors[(rnd() * pal.nebulaColors.length) | 0];
    const a = 0.10 + rnd() * 0.12;
    drawAtAllWraps(nx, w, (cx) => {
      const g = ctx.createRadialGradient(cx, ny, 0, cx, ny, rad);
      g.addColorStop(0, hexToRgba(col, a));
      g.addColorStop(0.5, hexToRgba(col, a * 0.4));
      g.addColorStop(1, hexToRgba(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, ny, rad, 0, TAU);
      ctx.fill();
    });
  }
  ctx.restore();
}

function drawMilkyWay(ctx, w, h, pal, rnd) {
  const hy = h / 2;
  // 银河带的中心线：整数倍频正弦合成 ⇒ x=0 与 x=w 处等高，天然无缝。
  const center = (x) => hy * 0.55 - hy * 0.28 * Math.sin((x / w) * TAU + 0.7) - hy * 0.10 * Math.sin((x / w) * TAU * 2 + 2.1);
  const half = (x) => h * 0.045 * (0.75 + 0.35 * Math.sin((x / w) * TAU * 3 + 1.2));
  const step = Math.max(4, w / 512);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.beginPath();
  let first = true;
  for (let x = 0; x <= w; x += step) {
    const yy = center(x) - half(x);
    if (first) { ctx.moveTo(x, yy); first = false; } else { ctx.lineTo(x, yy); }
  }
  for (let x = w; x >= 0; x -= step) ctx.lineTo(x, center(x) + half(x));
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, hy);
  g.addColorStop(0, hexToRgba('#aab4e8', 0.10));
  g.addColorStop(0.5, hexToRgba('#cdd4ff', 0.16));
  g.addColorStop(1, hexToRgba('#8890c8', 0.06));
  ctx.fillStyle = g;
  ctx.fill();
  const blobs = 42;
  for (let i = 0; i < blobs; i++) {
    const x = rnd() * w;
    const yy = center(x) + (rnd() - 0.5) * half(x) * 2.0;
    const rr = h * (0.01 + rnd() * 0.03);
    const a = 0.05 + rnd() * 0.08;
    drawAtAllWraps(x, w, (cx) => {
      const bg = ctx.createRadialGradient(cx, yy, 0, cx, yy, rr);
      bg.addColorStop(0, hexToRgba('#ffffff', a));
      bg.addColorStop(1, hexToRgba('#ffffff', 0));
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(cx, yy, rr, 0, TAU);
      ctx.fill();
    });
  }
  ctx.restore();
}

function drawClouds(ctx, w, h, pal, rnd) {
  const hy = h / 2;
  for (let i = 0; i < pal.cloudCount; i++) {
    const cx = rnd() * w;
    const cy = hy * (0.22 + rnd() * 0.5);
    const cw = w * (0.06 + rnd() * 0.10);
    const ch = hy * (0.02 + rnd() * 0.035);
    const lobes = 5 + ((rnd() * 4) | 0);
    // 所有随机量在环绕前算好，三份副本只在 cx 上平移，保证左右一致。
    drawAtAllWraps(cx, w, (ccx) => {
      for (let p = 0; p < 3; p++) {
        const grow = 1 + p * 0.25;
        const a = pal.cloudAlpha * (0.5 - p * 0.13);
        ctx.fillStyle = hexToRgba(pal.cloudColor, Math.max(0, a));
        for (let l = 0; l < lobes; l++) {
          const lx = ccx + (l - (lobes - 1) / 2) * (cw / lobes) * 1.4;
          const ly = cy + Math.sin(l * 1.7 + i) * ch * 0.5;
          const rw = cw * (0.4 + ((l * 37 + i * 13) % 7) / 10) * grow;
          const rh = ch * (0.7 + ((l * 17 + i * 7) % 5) / 10) * grow;
          ctx.beginPath();
          ctx.ellipse(lx, ly, rw * 0.5, rh * 0.5, 0, 0, TAU);
          ctx.fill();
        }
      }
    });
  }
}

function drawGround(ctx, w, h, pal) {
  const hy = h / 2;
  const g = ctx.createLinearGradient(0, hy, 0, h);
  g.addColorStop(0, pal.ground[0]);
  g.addColorStop(0.4, pal.ground[1]);
  g.addColorStop(1, pal.ground[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, hy, w, h - hy);
  // 地平线霞光（横向均匀 ⇒ 无缝）
  const hz = ctx.createLinearGradient(0, hy - hy * 0.05, 0, hy + hy * 0.06);
  hz.addColorStop(0, hexToRgba(pal.sky[3], 0));
  hz.addColorStop(0.5, hexToRgba(pal.sky[3], 0.5));
  hz.addColorStop(1, hexToRgba(pal.sky[3], 0));
  ctx.fillStyle = hz;
  ctx.fillRect(0, hy - hy * 0.05, w, hy * 0.11);
}

function drawGroundDetail(ctx, w, h, pal, rnd) {
  const hy = h / 2;
  const lw = Math.max(1, h / 700);
  ctx.save();

  // 1) 放射状“道路”：恒定方位角在等距柱状投影下就是竖直线，从地平线向天底方向辐射；
  //    地标方位（每 45°，即 i%3===0）的道路更宽更亮。
  const roadGrad = ctx.createLinearGradient(0, hy, 0, h);
  roadGrad.addColorStop(0, hexToRgba(pal.grid, 0));
  roadGrad.addColorStop(0.45, hexToRgba(pal.grid, pal.gridAlpha * 0.7));
  roadGrad.addColorStop(1, hexToRgba(pal.grid, pal.gridAlpha));
  const spokes = 24;
  for (let i = 0; i < spokes; i++) {
    const deg = (360 / spokes) * i;
    const x = azimuthToX(deg, w);
    const wide = i % 3 === 0 ? lw * 1.8 : lw;
    ctx.fillStyle = roadGrad;
    drawAtAllWraps(x, w, (cx) => ctx.fillRect(cx - wide / 2, hy, wide, h - hy));
  }

  // 2) 等深“环线”：y 到地平线的距离按非线性分布 ⇒ 越靠近地平线越密，视觉上才像平面。
  const rings = 26;
  for (let k = 1; k <= rings; k++) {
    const t = k / rings; // 0=地平线, 1=天底
    const y = hy + (h - hy) * Math.pow(t, 2.3);
    const a = pal.gridAlpha * (0.25 + 0.75 * t);
    ctx.fillStyle = hexToRgba(pal.grid, a);
    ctx.fillRect(0, y - lw / 2, w, lw);
  }

  // 3) 天底附近的反光/纹理暗示（横向渐变 ⇒ 无缝）。
  const ng = ctx.createLinearGradient(0, h * 0.7, 0, h);
  ng.addColorStop(0, hexToRgba(pal.groundAccent, 0));
  ng.addColorStop(1, hexToRgba(pal.groundAccent, 0.35));
  ctx.fillStyle = ng;
  ctx.fillRect(0, h * 0.7, w, h * 0.3);

  // 4) 近地细颗粒（小方块，靠近边缘处补画环绕副本）。
  const speck = 360;
  for (let i = 0; i < speck; i++) {
    const x = rnd() * w;
    const y = h * (0.6 + rnd() * 0.38);
    const s = Math.max(1, (h / 900) * (0.5 + rnd() * 1.6));
    const a = 0.04 + rnd() * 0.08;
    ctx.fillStyle = hexToRgba(pal.groundSpeck, a);
    ctx.fillRect(x, y, s, s);
    if (x < s) ctx.fillRect(x + w, y, s, s);
    else if (x > w - s) ctx.fillRect(x - w, y, s, s);
  }

  ctx.restore();
}

// 单层山脊：用整数倍频正弦合成轮廓，x=0 与 x=w 处等高 ⇒ 左右无缝。
function drawRidgeLayer(ctx, w, h, color, terms, phases, baseAmp, scale) {
  const hy = h / 2;
  const yAt = (x) => {
    let s = 0;
    for (let k = 0; k < terms.length; k++) {
      s += terms[k][1] * Math.sin((x / w) * TAU * terms[k][0] + phases[k]);
    }
    const up = (baseAmp + Math.max(0, s)) * scale;
    return hy * (1 - up);
  };
  ctx.beginPath();
  ctx.moveTo(0, yAt(0));
  const step = Math.max(2, w / 1024);
  for (let x = step; x < w; x += step) ctx.lineTo(x, yAt(x));
  ctx.lineTo(w, yAt(w));
  ctx.lineTo(w, hy + 3);
  ctx.lineTo(0, hy + 3);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawRidge(ctx, w, h, pal, rnd) {
  const p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU;
  drawRidgeLayer(ctx, w, h, pal.ridgeFar, [[1, 0.05], [3, 0.03], [5, 0.018]], [p1, p2, p3], 0.02, 1.25);
  const q1 = rnd() * TAU, q2 = rnd() * TAU, q3 = rnd() * TAU;
  drawRidgeLayer(ctx, w, h, pal.ridgeNear, [[2, 0.06], [4, 0.035], [7, 0.022]], [q1, q2, q3], 0.03, 1.9);
}

/* ------------------------------------------------------------------ 地标与标签 */

function drawLandmarkShape(ctx, shape, x, baseY, bw, topY, color) {
  const hgt = baseY - topY;
  const hw = bw / 2;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, bw * 0.05);
  ctx.lineJoin = 'round';

  switch (shape) {
    case 'spire': {
      ctx.fillRect(x - hw * 1.1, baseY - hgt * 0.16, hw * 2.2, hgt * 0.16);
      ctx.beginPath();
      ctx.moveTo(x - hw * 0.5, baseY - hgt * 0.14);
      ctx.lineTo(x, topY);
      ctx.lineTo(x + hw * 0.5, baseY - hgt * 0.14);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'arch': {
      const legW = bw * 0.26;
      const legTop = baseY - hgt * 0.72;
      ctx.fillRect(x - hw, legTop, legW, baseY - legTop);
      ctx.fillRect(x + hw - legW, legTop, legW, baseY - legTop);
      ctx.beginPath();
      ctx.arc(x, legTop, hw, Math.PI, 0, false);
      ctx.arc(x, legTop, hw - legW, 0, Math.PI, true);
      ctx.closePath();
      ctx.fill('evenodd');
      break;
    }
    case 'block': {
      const cw = bw * 1.2;
      const chh = hgt * 0.82;
      const dx = bw * 0.4;
      const dy = bw * 0.4;
      const ft = baseY - chh;
      ctx.fillStyle = shade(color, 1.25);
      ctx.beginPath();
      ctx.moveTo(x - cw / 2, ft);
      ctx.lineTo(x - cw / 2 + dx, ft - dy);
      ctx.lineTo(x + cw / 2 + dx, ft - dy);
      ctx.lineTo(x + cw / 2, ft);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade(color, 0.7);
      ctx.beginPath();
      ctx.moveTo(x + cw / 2, ft);
      ctx.lineTo(x + cw / 2 + dx, ft - dy);
      ctx.lineTo(x + cw / 2 + dx, baseY - dy);
      ctx.lineTo(x + cw / 2, baseY);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillRect(x - cw / 2, ft, cw, chh);
      ctx.strokeRect(x - cw / 2, ft, cw, chh);
      break;
    }
    case 'pyramid': {
      const tiers = 4;
      for (let t = 0; t < tiers; t++) {
        const tw = bw * 1.3 * (1 - (t / tiers) * 0.72);
        const th = hgt / tiers;
        const y = baseY - (t + 1) * th;
        ctx.fillStyle = shade(color, 1 - t * 0.06);
        ctx.fillRect(x - tw / 2, y, tw, th);
      }
      break;
    }
    case 'obelisk': {
      const sw = bw * 0.55;
      const sh = hgt * 0.82;
      ctx.fillRect(x - sw / 2, baseY - sh, sw, sh);
      ctx.beginPath();
      ctx.moveTo(x - sw / 2, baseY - sh);
      ctx.lineTo(x, topY);
      ctx.lineTo(x + sw / 2, baseY - sh);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'orb': {
      const orbR = Math.min(bw * 0.62, hgt * 0.32);
      const poleTop = baseY - hgt + orbR * 2;
      ctx.fillRect(x - bw * 0.1, poleTop, bw * 0.2, baseY - poleTop);
      ctx.beginPath();
      ctx.arc(x, poleTop, orbR, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = shade(color, 1.35);
      ctx.beginPath();
      ctx.arc(x - orbR * 0.3, poleTop - orbR * 0.35, orbR * 0.35, 0, TAU);
      ctx.fill();
      break;
    }
    case 'column': {
      const shaftW = bw * 0.5;
      const capW = bw * 1.0;
      const capH = hgt * 0.14;
      ctx.fillRect(x - capW / 2, baseY - hgt, capW, capH);
      ctx.fillRect(x - shaftW / 2, baseY - hgt + capH, shaftW, hgt - capH * 2);
      ctx.fillRect(x - capW / 2, baseY - capH, capW, capH);
      break;
    }
    case 'dome': {
      const baseW2 = bw * 1.3;
      const baseH = hgt * 0.34;
      ctx.fillRect(x - baseW2 / 2, baseY - baseH, baseW2, baseH);
      ctx.beginPath();
      ctx.arc(x, baseY - baseH, baseW2 / 2, Math.PI, 0, false);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, baseY - baseH - baseW2 / 2, bw * 0.12, 0, TAU);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

function drawAzimuthLabel(ctx, text, x, y, size) {
  ctx.save();
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, size * 0.22);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = 'rgba(15,16,24,0.98)';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawLandmarks(ctx, w, h) {
  const hy = h / 2;
  const bw = w * 0.018;
  const labelSize = Math.round(h / 48);
  for (const lm of LANDMARKS) {
    const x = azimuthToX(lm.az, w);
    const topY = hy - hy * lm.hi;
    drawAtAllWraps(x, w, (cx) => {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.ellipse(cx, hy, bw * 1.1, bw * 0.22, 0, 0, TAU);
      ctx.fill();
      drawLandmarkShape(ctx, lm.shape, cx, hy, bw, topY, lm.color);
      // 方位标签画在地标正下方：白色描边 + 深色填充，字号随 height 缩放。
      drawAzimuthLabel(ctx, lm.label, cx, hy + hy * 0.16, labelSize);
    });
  }
}

/* ------------------------------------------------------------------ 渲染入口 */

function render(ctx, w, h, pal, rnd) {
  drawSky(ctx, w, h, pal);
  drawCelestial(ctx, w, h, pal);
  if (pal.nebula) drawNebula(ctx, w, h, pal, rnd);
  if (pal.milkyWay) drawMilkyWay(ctx, w, h, pal, rnd);
  if (pal.stars > 0) drawStars(ctx, w, h, rnd, pal.stars);
  if (pal.cloudCount > 0) drawClouds(ctx, w, h, pal, rnd);
  drawGround(ctx, w, h, pal);
  drawGroundDetail(ctx, w, h, pal, rnd);
  drawRidge(ctx, w, h, pal, rnd);
  drawLandmarks(ctx, w, h);
}

export function createPanoramaCanvas(opts = {}) {
  const width = Math.max(1, Math.floor(opts.width === undefined ? 4096 : opts.width));
  const height = Math.max(1, Math.floor(opts.height === undefined ? 2048 : opts.height));
  const seed = opts.seed === undefined ? 20261024 : opts.seed;
  const themeName = opts.theme === undefined ? 'dusk' : opts.theme;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const rnd = mulberry32(seed >>> 0);
  const pal = THEMES[themeName] || THEMES.dusk;

  render(ctx, width, height, pal, rnd);
  return canvas;
}

export function createPanoramaDataURL(opts = {}) {
  const canvas = createPanoramaCanvas(opts);
  return canvas.toDataURL('image/png');
}