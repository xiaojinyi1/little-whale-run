/* ==================================================================
   小鲸鱼快跑 — Little Whale Run
   原生 Canvas 2D 无尽跑酷，玩法对标 Chrome 断网小恐龙。

   代码结构（自上而下）：
   1. CONFIG / 物理与关卡参数
   2. Utils / 颜色、缓动、随机数
   3. Palette / 昼航・深海夜航双色板与 0.5s 插值
   4. Background / 天空、月亮、岛影、海面、水下视差
   5. ParticleSystem / 水花与气泡粒子池
   6. Player / 小鲸鱼的跳跃、下潜、碰撞盒与矢量绘制
   7. Obstacle + ObstacleField / 两类障碍及配置驱动生成
   8. Scoreboard / 距离分、闪烁、localStorage 最高分
   9. Input / 键盘、鼠标、触屏手势
   10. Game / 状态机、rAF + delta time 主循环、HUD
   11. bootstrap
=================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
     1. CONFIG
  ------------------------------------------------------------------ */

  /** 逻辑画布尺寸。所有物理量都以逻辑像素为准，渲染时整体等比缩放。 */
  const VIEW = Object.freeze({ width: 960, height: 540, horizon: 300, groundY: 416 });

  const PHYSICS = Object.freeze({
    gravity: 2260,
    jumpVelocity: -860,
    jumpCutVelocity: -620,
    fastFallGravity: 1120,
    duckGravity: 720,
    maxFallSpeed: 1500,
  });

  const SPEED = Object.freeze({
    base: 360, // 6 px/frame @60fps
    max: 780, // 13 px/frame @60fps
    gainPerPoint: 0.30, // 每 100 分 +30 px/s，即每 100 分 +0.5 px/frame
  });

  const SCORING = Object.freeze({
    pointsPerPixel: 1 / 24, // 距离分：以逻辑像素累计距离换分
    nightCycle: 500,
  });

  const COLLISION_INSET = 3; // AABB 安全内缩：每边 3px
  const THEME_FADE_SECONDS = 0.5;
  const STORAGE_KEY = 'little-whale-run.best.v1';

  /* ------------------------------------------------------------------
     2. Utils
  ------------------------------------------------------------------ */

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (t) => {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  };
  const mod = (n, m) => ((n % m) + m) % m;

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    return (
      '#' +
      ((1 << 24) + (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b))
        .toString(16)
        .slice(1)
    );
  }

  function mixHex(a, b, t) {
    if (t <= 0) return a;
    if (t >= 1) return b;
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    return rgbToHex(
      lerp(ca[0], cb[0], t),
      lerp(ca[1], cb[1], t),
      lerp(ca[2], cb[2], t)
    );
  }

  function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function roundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function formatScore(value) {
    const n = Math.max(0, Math.floor(value));
    return n.toString().padStart(5, '0').slice(-5);
  }

  function drawSpacedText(ctx, text, x, y, spacing, align = 'center') {
    const chars = Array.from(text);
    let width = 0;
    for (let i = 0; i < chars.length; i++) {
      width += ctx.measureText(chars[i]).width + (i < chars.length - 1 ? spacing : 0);
    }
    let cursor = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], cursor, y);
      cursor += ctx.measureText(chars[i]).width + spacing;
    }
    return width;
  }

  /* ------------------------------------------------------------------
     3. Palette
  ------------------------------------------------------------------ */

  const DAY_PALETTE = Object.freeze({
    skyTop: '#c4effa',
    skyMid: '#e8f8fa',
    skyBottom: '#fff2d2',
    sun: '#ffd166',
    sunGlow: '#ffe7a3',
    moon: '#fff6d5',
    cloud: '#ffffff',
    cloudShade: '#d8eef3',
    islandFar: '#acd6d7',
    islandNear: '#7bb7bf',
    horizon: '#8fd2d9',
    farSea: '#58b8c9',
    seaTop: '#2699b0',
    seaMid: '#0a6f8d',
    seaDeep: '#053e5b',
    seaFloor: '#042c44',
    foam: '#f3feff',
    foamSoft: '#c7f2f6',
    rock: '#748b96',
    rockLight: '#a9bcc0',
    rockDark: '#425a65',
    rockWet: '#55717d',
    rockGlow: '#b9eef0',
    whale: '#337fa5',
    whaleDark: '#1b5a7b',
    whaleLight: '#5ca8c3',
    whaleBelly: '#e1f9ff',
    eye: '#062b3d',
    hud: '#083f57',
    hudSoft: '#2a7085',
    panel: '#042f44',
    panelText: '#f2feff',
    accent: '#ffcf5c',
    danger: '#ff6f66',
    star: '#fff5c9',
    letterbox: '#021b29',
    particle: '#ecfdff',
  });

  const NIGHT_PALETTE = Object.freeze({
    skyTop: '#041226',
    skyMid: '#08233d',
    skyBottom: '#123b58',
    sun: '#f4e7b6',
    sunGlow: '#d8e6f5',
    moon: '#fff2c7',
    cloud: '#284b64',
    cloudShade: '#1a3448',
    islandFar: '#173b52',
    islandNear: '#0f2c40',
    horizon: '#1c5068',
    farSea: '#0d3a53',
    seaTop: '#0b3652',
    seaMid: '#06243c',
    seaDeep: '#031626',
    seaFloor: '#020e1a',
    foam: '#91dfe9',
    foamSoft: '#55b7c6',
    rock: '#2b4150',
    rockLight: '#4b6573',
    rockDark: '#101f2b',
    rockWet: '#223946',
    rockGlow: '#62bac8',
    whale: '#4a94ad',
    whaleDark: '#2a647e',
    whaleLight: '#7bc4d6',
    whaleBelly: '#c9f2f6',
    eye: '#04151f',
    hud: '#d9f8ff',
    hudSoft: '#86c8d9',
    panel: '#021522',
    panelText: '#effeff',
    accent: '#ffd97a',
    danger: '#ff7b72',
    star: '#fff2bb',
    letterbox: '#010b14',
    particle: '#c9f5fa',
  });

  class Palette {
    constructor() {
      this.nightTarget = 0;
      this.night = 0;
      this._cacheKey = -1;
      this._cache = DAY_PALETTE;
    }

    setScore(score) {
      this.nightTarget = Math.floor(score / SCORING.nightCycle) % 2;
    }

    reset() {
      this.nightTarget = 0;
      this.night = 0;
      this._cacheKey = -1;
      this._cache = DAY_PALETTE;
    }

    update(dt) {
      if (this.night === this.nightTarget) return false;
      const step = dt / THEME_FADE_SECONDS;
      if (this.night < this.nightTarget) {
        this.night = Math.min(this.nightTarget, this.night + step);
      } else {
        this.night = Math.max(this.nightTarget, this.night - step);
      }
      return true;
    }

    get colors() {
      const key = Math.round(this.night * 100);
      if (key === this._cacheKey) return this._cache;
      this._cacheKey = key;
      if (key <= 0) {
        this._cache = DAY_PALETTE;
      } else if (key >= 100) {
        this._cache = NIGHT_PALETTE;
      } else {
        const t = key / 100;
        const mixed = {};
        for (const name of Object.keys(DAY_PALETTE)) {
          mixed[name] = mixHex(DAY_PALETTE[name], NIGHT_PALETTE[name], t);
        }
        this._cache = mixed;
      }
      return this._cache;
    }
  }

  /* ------------------------------------------------------------------
     4. Background
  ------------------------------------------------------------------ */

  class Background {
    constructor() {
      const rand = mulberry32(20241103);

      this.time = 0;
      this.cloudScroll = 0;
      this.farScroll = 0;
      this.midScroll = 0;
      this.waveScroll = 0;
      this.foregroundScroll = 0;

      this.clouds = Array.from({ length: 8 }, (_, i) => ({
        x: rand() * 1280,
        y: 56 + rand() * 180,
        scale: 0.52 + rand() * 0.8,
        depth: 0.28 + rand() * 0.5,
        alpha: 0.35 + rand() * 0.5,
        phase: rand() * Math.PI * 2,
        id: i,
      }));

      this.stars = Array.from({ length: 74 }, () => ({
        x: rand() * VIEW.width,
        y: 16 + rand() * 245,
        r: 0.55 + rand() * 1.35,
        phase: rand() * Math.PI * 2,
        speed: 0.7 + rand() * 1.7,
      }));

      this.bubbles = Array.from({ length: 22 }, () => ({
        x: rand() * VIEW.width,
        y: VIEW.groundY + 20 + rand() * 105,
        r: 1 + rand() * 2.6,
        speed: 6 + rand() * 15,
        drift: 3 + rand() * 7,
        phase: rand() * Math.PI * 2,
      }));

      this.glints = Array.from({ length: 15 }, (_, i) => ({
        x: (i / 15) * (VIEW.width + 180) + rand() * 80,
        y: VIEW.horizon + 20 + rand() * 72,
        len: 8 + rand() * 30,
        phase: rand() * Math.PI * 2,
      }));

      this.birds = [
        { x: 690, y: 116, scale: 0.72, phase: 0 },
        { x: 790, y: 96, scale: 0.55, phase: 1.9 },
        { x: 875, y: 137, scale: 0.46, phase: 3.4 },
      ];
    }

    reset() {
      this.time = 0;
      this.cloudScroll = 0;
      this.farScroll = 0;
      this.midScroll = 0;
      this.waveScroll = 0;
      this.foregroundScroll = 0;
    }

    update(dt, speed, isNight) {
      const s = Math.max(35, speed);
      this.time += dt;
      this.cloudScroll += (s * 0.018 + 2.2) * dt;
      this.farScroll += s * 0.055 * dt;
      this.midScroll += s * 0.18 * dt;
      this.waveScroll += s * 0.55 * dt;
      this.foregroundScroll += s * 0.8 * dt;

      for (const b of this.bubbles) {
        b.y -= b.speed * dt;
        b.x += Math.sin(this.time * 0.8 + b.phase) * b.drift * dt;
        if (b.y < VIEW.groundY + 6) {
          b.y = 528 + (b.phase % 1) * 12;
          b.x = mod(b.x + 83, VIEW.width + 40);
        }
      }

      if (isNight > 0.65) {
        for (const cloud of this.clouds) {
          cloud.x -= cloud.depth * 2.4 * dt;
        }
      }
    }

    surfaceY(x) {
      const w = this.waveScroll;
      return (
        VIEW.groundY +
        Math.sin((x + w) * 0.018) * 4.2 +
        Math.sin((x + w) * 0.043 + 1.35) * 2.1 +
        Math.sin((x + w) * 0.009 + 0.6) * 3.1
      );
    }

    draw(ctx, colors, night, dt) {
      this.drawSky(ctx, colors);
      this.drawStars(ctx, colors, night);
      this.drawSunAndMoon(ctx, colors, night);
      this.drawClouds(ctx, colors, night);
      this.drawBirds(ctx, colors, night);
      this.drawIslands(ctx, colors, night);
      this.drawFarSea(ctx, colors, night);
      this.drawOcean(ctx, colors, night);
      this.drawForeground(ctx, colors, night);
    }

    drawSky(ctx, colors) {
      const g = ctx.createLinearGradient(0, 0, 0, VIEW.horizon + 90);
      g.addColorStop(0, colors.skyTop);
      g.addColorStop(0.56, colors.skyMid);
      g.addColorStop(1, colors.skyBottom);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VIEW.width, VIEW.horizon + 90);

      // 天顶柔光，给画面一点空气感。
      const glow = ctx.createRadialGradient(480, 20, 10, 480, 20, 460);
      glow.addColorStop(0, rgba(colors.cloud, 0.22));
      glow.addColorStop(1, rgba(colors.cloud, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, VIEW.width, 340);
    }

    drawStars(ctx, colors, night) {
      if (night <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = night;
      for (const s of this.stars) {
        const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.time * s.speed + s.phase));
        ctx.globalAlpha = night * (0.25 + twinkle * 0.75);
        ctx.fillStyle = colors.star;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * (0.7 + twinkle * 0.4), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    drawSunAndMoon(ctx, colors, night) {
      const x = 772;
      const y = 118;

      if (night < 0.995) {
        ctx.save();
        ctx.globalAlpha = 1 - night;
        const halo = ctx.createRadialGradient(x, y, 8, x, y, 92);
        halo.addColorStop(0, rgba(colors.sunGlow, 0.68));
        halo.addColorStop(0.45, rgba(colors.sunGlow, 0.18));
        halo.addColorStop(1, rgba(colors.sunGlow, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, 92, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = colors.sun;
        ctx.beginPath();
        ctx.arc(x, y, 34, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = rgba('#fff8dc', 0.45);
        ctx.beginPath();
        ctx.arc(x - 8, y - 9, 21, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (night > 0.005) {
        ctx.save();
        ctx.globalAlpha = night;
        const halo = ctx.createRadialGradient(x, y, 8, x, y, 104);
        halo.addColorStop(0, rgba(colors.moon, 0.28));
        halo.addColorStop(1, rgba(colors.moon, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, 104, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = colors.moon;
        ctx.beginPath();
        ctx.arc(x, y, 31, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = rgba(colors.skyMid, 0.28);
        ctx.beginPath();
        ctx.arc(x - 10, y - 7, 6, 0, Math.PI * 2);
        ctx.arc(x + 9, y + 8, 4.5, 0, Math.PI * 2);
        ctx.arc(x + 5, y - 13, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    drawClouds(ctx, colors, night) {
      for (const cloud of this.clouds) {
        const x = mod(cloud.x - this.cloudScroll * cloud.depth, 1280) - 150;
        const y = cloud.y + Math.sin(this.time * 0.22 + cloud.phase) * 3;
        const s = cloud.scale;
        const alpha = cloud.alpha * (1 - night * 0.45);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = colors.cloud;
        ctx.beginPath();
        ctx.arc(x, y, 23 * s, Math.PI, Math.PI * 2);
        ctx.arc(x + 26 * s, y - 9 * s, 30 * s, Math.PI, Math.PI * 2);
        ctx.arc(x + 58 * s, y, 21 * s, Math.PI, Math.PI * 2);
        ctx.rect(x - 1, y - 5 * s, 62 * s, 14 * s);
        ctx.fill();

        ctx.globalAlpha = alpha * 0.42;
        ctx.fillStyle = colors.cloudShade;
        ctx.beginPath();
        ctx.ellipse(x + 30 * s, y + 7 * s, 33 * s, 7 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    drawBirds(ctx, colors, night) {
      if (night > 0.7) return;
      ctx.save();
      ctx.globalAlpha = 0.52 * (1 - night);
      ctx.strokeStyle = colors.hudSoft;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      for (const bird of this.birds) {
        const flap = Math.sin(this.time * 2.2 + bird.phase) * 4 * bird.scale;
        const x = bird.x - this.midScroll * 0.07;
        const y = bird.y + Math.sin(this.time * 0.5 + bird.phase) * 3;
        ctx.beginPath();
        ctx.moveTo(x - 9 * bird.scale, y);
        ctx.quadraticCurveTo(x - 4 * bird.scale, y - 4 * bird.scale - flap, x, y);
        ctx.quadraticCurveTo(x + 4 * bird.scale, y - 4 * bird.scale - flap, x + 9 * bird.scale, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawIslands(ctx, colors, night) {
      const drawLayer = (scroll, offset, height, color, detail) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(-40, VIEW.horizon + 2);
        for (let x = -40; x <= VIEW.width + 40; x += 24) {
          const wx = x + scroll + offset;
          const y =
            VIEW.horizon -
            height -
            Math.sin(wx * 0.006) * (height * 0.38) -
            Math.sin(wx * 0.013 + 1.4) * (height * 0.2) -
            Math.sin(wx * 0.031 + 0.6) * (height * 0.06);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(VIEW.width + 40, VIEW.horizon + 2);
        ctx.closePath();
        ctx.fill();

        if (detail) {
          ctx.globalAlpha = 0.22 * (1 - night * 0.5);
          ctx.fillStyle = colors.cloud;
          for (let x = 30; x < VIEW.width; x += 97) {
            const wx = x + scroll + offset;
            const y = VIEW.horizon - height * 0.62 + Math.sin(wx * 0.02) * 5;
            ctx.beginPath();
            ctx.ellipse(x, y, 22, 2, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      };

      drawLayer(this.farScroll, 0, 46, colors.islandFar, false);
      drawLayer(this.farScroll * 1.22 + 240, 0, 34, colors.islandNear, true);

      // 海平线。
      ctx.strokeStyle = rgba(colors.horizon, 0.8);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, VIEW.horizon + 1.5);
      ctx.lineTo(VIEW.width, VIEW.horizon + 1.5);
      ctx.stroke();
    }

    drawFarSea(ctx, colors, night) {
      const g = ctx.createLinearGradient(0, VIEW.horizon, 0, VIEW.groundY + 6);
      g.addColorStop(0, colors.horizon);
      g.addColorStop(0.35, colors.farSea);
      g.addColorStop(1, colors.seaTop);
      ctx.fillStyle = g;
      ctx.fillRect(0, VIEW.horizon + 1, VIEW.width, VIEW.groundY - VIEW.horizon + 4);

      // 海面碎光，随中景缓慢移动。
      ctx.save();
      ctx.lineCap = 'round';
      for (const glint of this.glints) {
        const alpha =
          (0.12 + 0.1 * (0.5 + 0.5 * Math.sin(this.time * 1.3 + glint.phase))) * (1 - night * 0.55);
        ctx.strokeStyle = rgba(colors.foam, alpha);
        ctx.lineWidth = 1.2;
        const x = mod(glint.x - this.midScroll * 0.4, VIEW.width + 120) - 60;
        ctx.beginPath();
        ctx.moveTo(x, glint.y);
        ctx.lineTo(x + glint.len * (0.6 + 0.4 * Math.sin(glint.phase)), glint.y);
        ctx.stroke();
      }
      ctx.restore();

      // 薄雾，避免海平线过硬。
      const haze = ctx.createLinearGradient(0, VIEW.horizon - 16, 0, VIEW.horizon + 30);
      haze.addColorStop(0, rgba(colors.skyBottom, 0));
      haze.addColorStop(0.55, rgba(colors.skyBottom, 0.2));
      haze.addColorStop(1, rgba(colors.skyBottom, 0));
      ctx.fillStyle = haze;
      ctx.fillRect(0, VIEW.horizon - 16, VIEW.width, 46);
    }

    drawOcean(ctx, colors, night) {
      // 用 sin 波叠加构造动态海面；海面自身滚动速度是障碍物的 0.55 倍。
      const topPoints = [];
      for (let x = -24; x <= VIEW.width + 24; x += 12) {
        topPoints.push([x, this.surfaceY(x)]);
      }

      ctx.beginPath();
      ctx.moveTo(topPoints[0][0], topPoints[0][1]);
      for (let i = 1; i < topPoints.length; i++) ctx.lineTo(topPoints[i][0], topPoints[i][1]);
      ctx.lineTo(VIEW.width + 24, VIEW.height + 20);
      ctx.lineTo(-24, VIEW.height + 20);
      ctx.closePath();

      const water = ctx.createLinearGradient(0, VIEW.groundY - 8, 0, VIEW.height);
      water.addColorStop(0, colors.seaTop);
      water.addColorStop(0.22, colors.seaMid);
      water.addColorStop(0.68, colors.seaDeep);
      water.addColorStop(1, colors.seaFloor);
      ctx.fillStyle = water;
      ctx.fill();

      // 水下光柱。
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, VIEW.groundY, VIEW.width, VIEW.height - VIEW.groundY);
      ctx.clip();
      for (let i = 0; i < 5; i++) {
        const x = ((i * 233 + this.midScroll * 0.55) % (VIEW.width + 300)) - 140;
        const ray = ctx.createLinearGradient(x, VIEW.groundY, x + 120, VIEW.height);
        ray.addColorStop(0, rgba(colors.foam, 0.105 * (1 - night * 0.55)));
        ray.addColorStop(1, rgba(colors.foam, 0));
        ctx.fillStyle = ray;
        ctx.beginPath();
        ctx.moveTo(x, VIEW.groundY);
        ctx.lineTo(x + 64, VIEW.groundY);
        ctx.lineTo(x + 190, VIEW.height);
        ctx.lineTo(x + 66, VIEW.height);
        ctx.closePath();
        ctx.fill();
      }

      // 气泡。
      for (const b of this.bubbles) {
        ctx.strokeStyle = rgba(colors.foam, 0.26);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 深水暗纹，强化“海面下是深蓝色水体”的层次。
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = colors.seaFloor;
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const y = VIEW.groundY + 35 + i * 25;
        ctx.beginPath();
        for (let x = -20; x <= VIEW.width + 20; x += 30) {
          const wy = y + Math.sin((x + this.foregroundScroll * 0.2) * 0.012 + i) * 5;
          if (x === -20) ctx.moveTo(x, wy);
          else ctx.lineTo(x, wy);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // 海面主轮廓和第二条亮边。
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgba(colors.foam, 0.92);
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      for (let i = 0; i < topPoints.length; i++) {
        const [x, y] = topPoints[i];
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.strokeStyle = rgba(colors.foamSoft, 0.72);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < topPoints.length; i++) {
        const [x, y] = topPoints[i];
        if (i === 0) ctx.moveTo(x, y + 4.2);
        else ctx.lineTo(x, y + 4.2);
      }
      ctx.stroke();

      // 海面白色碎沫，动态但数量固定。
      ctx.fillStyle = rgba(colors.foam, 0.78);
      for (let i = 0; i < 14; i++) {
        const x = mod(i * 79 - this.waveScroll * 0.7, VIEW.width + 80) - 40;
        const y = this.surfaceY(x) + 3 + (i % 3) * 1.8;
        ctx.beginPath();
        ctx.ellipse(x, y, 5 + (i % 4), 1.1, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    drawForeground(ctx, colors, night) {
      // 近景浪纹：速度比障碍物慢，形成视差。
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const y = 486 + i * 24;
        ctx.strokeStyle = rgba(colors.foamSoft, 0.16 - i * 0.03);
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (let x = -30; x <= VIEW.width + 30; x += 26) {
          const wy =
            y + Math.sin((x + this.foregroundScroll * (0.5 + i * 0.12)) * 0.013 + i * 1.7) * 4;
          if (x === -30) ctx.moveTo(x, wy);
          else ctx.lineTo(x, wy);
        }
        ctx.stroke();
      }

      // 深海剪影海草，只在画面底部露一点。
      ctx.fillStyle = rgba(colors.seaFloor, 0.72);
      for (let i = 0; i < 9; i++) {
        const baseX = mod(i * 127 - this.foregroundScroll * 0.14, VIEW.width + 160) - 80;
        const h = 18 + (i % 4) * 9;
        const sway = Math.sin(this.time * 0.7 + i) * 4;
        ctx.beginPath();
        ctx.moveTo(baseX - 4, VIEW.height + 6);
        ctx.quadraticCurveTo(baseX + sway, VIEW.height - h, baseX + 3, VIEW.height - h - 8);
        ctx.quadraticCurveTo(baseX + 2, VIEW.height - h * 0.5, baseX + 8, VIEW.height + 6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------
     5. ParticleSystem（固定对象池，避免运行时无限分配）
  ------------------------------------------------------------------ */

  class ParticleSystem {
    constructor(capacity = 150) {
      this.pool = Array.from({ length: capacity }, () => ({
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        size: 1,
        gravity: 0,
        drag: 0,
        shade: 0,
      }));
      this.cursor = 0;
    }

    clear() {
      for (const p of this.pool) p.active = false;
    }

    spawn(x, y, vx, vy, life, size, gravity = 900, drag = 0.7, shade = 0) {
      // 环形查找一个空闲粒子；池满时复用最老的槽位。
      let p = null;
      for (let i = 0; i < this.pool.length; i++) {
        const idx = (this.cursor + i) % this.pool.length;
        if (!this.pool[idx].active) {
          p = this.pool[idx];
          this.cursor = (idx + 1) % this.pool.length;
          break;
        }
      }
      if (!p) {
        p = this.pool[this.cursor];
        this.cursor = (this.cursor + 1) % this.pool.length;
      }
      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = vx;
      p.vy = vy;
      p.life = life;
      p.maxLife = life;
      p.size = size;
      p.gravity = gravity;
      p.drag = drag;
      p.shade = shade;
    }

    splash(x, y, power = 1, count = 12) {
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI * (0.12 + Math.random() * 0.76);
        const speed = (45 + Math.random() * 130) * power;
        this.spawn(
          x + (Math.random() - 0.5) * 34,
          y - 2,
          Math.cos(angle) * speed * 0.75 + (Math.random() - 0.5) * 26,
          Math.sin(angle) * speed,
          0.45 + Math.random() * 0.45,
          1.2 + Math.random() * 2.3,
          760,
          0.35,
          Math.random()
        );
      }
    }

    wake(x, y) {
      this.spawn(
        x + (Math.random() - 0.5) * 8,
        y + (Math.random() - 0.5) * 3,
        -30 - Math.random() * 45,
        -8 - Math.random() * 20,
        0.3 + Math.random() * 0.22,
        0.9 + Math.random() * 1.4,
        400,
        0.7,
        Math.random()
      );
    }

    burst(x, y, count = 26, palette = null) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 40 + Math.random() * 190;
        this.spawn(
          x + (Math.random() - 0.5) * 22,
          y + (Math.random() - 0.5) * 14,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed - 65,
          0.5 + Math.random() * 0.75,
          1.4 + Math.random() * 3,
          640,
          0.25,
          Math.random()
        );
      }
      if (palette) this.flash = 0.3;
    }

    update(dt) {
      for (const p of this.pool) {
        if (!p.active) continue;
        p.life -= dt;
        if (p.life <= 0) {
          p.active = false;
          continue;
        }
        p.vx *= Math.pow(p.drag, dt * 60);
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    }

    draw(ctx, colors) {
      for (const p of this.pool) {
        if (!p.active) continue;
        const t = clamp(p.life / p.maxLife, 0, 1);
        ctx.globalAlpha = t * (0.55 + p.shade * 0.4);
        ctx.fillStyle = p.shade > 0.55 ? colors.foamSoft : colors.foam;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.55 + t * 0.45), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  /* ------------------------------------------------------------------
     6. Player
  ------------------------------------------------------------------ */

  class Player {
    constructor(x) {
      this.startX = x;
      this.reset();
    }

    reset() {
      this.x = this.startX;
      this.y = VIEW.groundY;
      this.vy = 0;
      this.onGround = true;
      this.duckAmount = 0;
      this.duckHeld = false;
      this.duckTimer = 0;
      this.time = 0;
      this.runPhase = 0;
      this.blinkTimer = 1.8 + Math.random() * 2.4;
      this.blink = 0;
      this.dead = false;
      this.landFlash = 0;
      this.jumpCount = 0;
    }

    jump() {
      if (!this.onGround || this.dead) return false;
      this.vy = PHYSICS.jumpVelocity;
      this.onGround = false;
      this.jumpCount++;
      this.landFlash = 0;
      return true;
    }

    releaseJump() {
      if (!this.onGround && !this.dead && this.vy < PHYSICS.jumpCutVelocity) {
        this.vy = PHYSICS.jumpCutVelocity;
      }
    }

    startDive() {
      if (this.dead) return;
      this.duckHeld = true;
      this.duckTimer = Math.max(this.duckTimer, 0.34);
    }

    holdDive(held) {
      this.duckHeld = held;
      if (held) this.duckTimer = Math.max(this.duckTimer, 0.18);
    }

    releaseDive() {
      this.duckHeld = false;
      this.duckTimer = Math.max(this.duckTimer, 0.16);
    }

    update(dt, speed, mode) {
      this.time += dt;
      this.runPhase += dt * (4.5 + speed / 95);
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blink = 0.11;
        this.blinkTimer = 2.1 + Math.random() * 3.2;
      }
      if (this.blink > 0) this.blink -= dt;
      if (this.landFlash > 0) this.landFlash -= dt;

      this.duckTimer = Math.max(0, this.duckTimer - dt);
      const wantDuck =
        mode === 'running' && !this.dead && (this.duckHeld || this.duckTimer > 0);
      const targetDuck = wantDuck ? 1 : 0;
      const duckSpeed = wantDuck ? 1 / 0.075 : 1 / 0.14;
      this.duckAmount += clamp(targetDuck - this.duckAmount, -duckSpeed * dt, duckSpeed * dt);

      let landed = false;
      if (mode === 'running' && !this.onGround) {
        let gravity = PHYSICS.gravity;
        if (this.duckHeld) gravity += PHYSICS.duckGravity;
        if (this.vy > 0) gravity += 80; // 轻微增加下落手感
        this.vy = Math.min(PHYSICS.maxFallSpeed, this.vy + gravity * dt);
        this.y += this.vy * dt;

        if (this.y >= VIEW.groundY) {
          this.y = VIEW.groundY;
          this.vy = 0;
          this.onGround = true;
          this.landFlash = 0.22;
          landed = true;
        }
      } else {
        this.y = VIEW.groundY;
      }

      return landed;
    }

    get collisionRect() {
      // 站立时 38px 高，下潜时 20px 高；左右再留出视觉安全边。
      const h = lerp(38, 20, smoothstep(this.duckAmount));
      return {
        x: this.x + 10,
        y: this.y - h - 2,
        w: 54,
        h,
      };
    }

    draw(ctx, colors, mode, speed) {
      const duck = smoothstep(this.duckAmount);
      const scaleY = 1 - duck * 0.42;
      const scaleX = 1 + duck * 0.1;
      const bob =
        this.onGround && mode !== 'gameover'
          ? Math.sin(this.runPhase * 1.9) * (1.25 + Math.min(speed / 600, 0.8))
          : 0;
      const tilt = !this.onGround
        ? clamp(this.vy / 5200, -0.13, 0.2)
        : Math.sin(this.runPhase * 1.9) * 0.008;

      const originY = this.y - 24 + 24 * (1 - scaleY) + bob - 2;
      const originX = this.x + 38;

      // 水下投影。
      const heightAbove = Math.max(0, VIEW.groundY - this.y);
      ctx.save();
      ctx.globalAlpha = 0.18 * (1 - clamp(heightAbove / 230, 0, 0.8));
      ctx.fillStyle = colors.seaFloor;
      ctx.beginPath();
      ctx.ellipse(originX + 2, VIEW.groundY + 7, 40 - heightAbove * 0.04, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(originX, originY);
      ctx.rotate(tilt);
      ctx.scale(scaleX, scaleY);

      const tailWag = Math.sin(this.runPhase * (this.onGround ? 1.7 : 2.8)) * 0.18;
      const finWag = Math.sin(this.runPhase * 2.1 + 1) * 0.12;

      // 尾鳍。
      ctx.save();
      ctx.translate(-25, 1);
      ctx.rotate(tailWag - duck * 0.12);
      ctx.fillStyle = colors.whaleDark;
      ctx.beginPath();
      ctx.moveTo(-1, -2);
      ctx.quadraticCurveTo(-18, -24, -37, -19);
      ctx.quadraticCurveTo(-27, -8, -22, -2);
      ctx.quadraticCurveTo(-31, 4, -29, 16);
      ctx.quadraticCurveTo(-17, 10, -1, 9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = rgba(colors.whaleLight, 0.34);
      ctx.beginPath();
      ctx.moveTo(-9, -3);
      ctx.quadraticCurveTo(-21, -13, -30, -15);
      ctx.quadraticCurveTo(-21, -4, -15, 1);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // 背鳍。
      ctx.save();
      ctx.translate(-1, -27);
      ctx.rotate(finWag * 0.6);
      ctx.fillStyle = colors.whaleDark;
      ctx.beginPath();
      ctx.moveTo(-8, 4);
      ctx.quadraticCurveTo(-2, -16, 8, -16);
      ctx.quadraticCurveTo(10, -5, 9, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // 身体。
      const bodyGradient = ctx.createLinearGradient(0, -32, 0, 22);
      bodyGradient.addColorStop(0, colors.whaleLight);
      bodyGradient.addColorStop(0.45, colors.whale);
      bodyGradient.addColorStop(1, colors.whaleDark);
      ctx.fillStyle = bodyGradient;
      ctx.beginPath();
      ctx.moveTo(-30, -6);
      ctx.bezierCurveTo(-30, -20, -18, -31, 2, -32);
      ctx.bezierCurveTo(20, -32, 35, -24, 39, -12);
      ctx.bezierCurveTo(43, 0, 35, 14, 18, 19);
      ctx.bezierCurveTo(0, 24, -19, 17, -28, 6);
      ctx.bezierCurveTo(-32, 2, -32, -2, -30, -6);
      ctx.closePath();
      ctx.fill();

      // 腹部亮面。
      ctx.save();
      ctx.clip();
      ctx.fillStyle = rgba(colors.whaleBelly, 0.94);
      ctx.beginPath();
      ctx.ellipse(8, 11, 27, 11, -0.1, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.24;
      ctx.strokeStyle = colors.whaleBelly;
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-9 + i * 8, 13);
        ctx.quadraticCurveTo(-4 + i * 8, 19, 4 + i * 8, 18);
        ctx.stroke();
      }
      ctx.restore();

      // 胸鳍。
      ctx.save();
      ctx.translate(5, 7);
      ctx.rotate(0.16 + finWag);
      ctx.fillStyle = colors.whaleDark;
      ctx.beginPath();
      ctx.moveTo(-5, -5);
      ctx.quadraticCurveTo(3, 8, 18, 12);
      ctx.quadraticCurveTo(9, 15, -1, 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // 眼睛。
      if (this.dead) {
        ctx.strokeStyle = colors.eye;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(23, -12);
        ctx.lineTo(30, -5);
        ctx.moveTo(30, -12);
        ctx.lineTo(23, -5);
        ctx.stroke();
      } else {
        const blink = this.blink > 0;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(27, -9, 4.4, blink ? 1.1 : 4.8, 0, 0, Math.PI * 2);
        ctx.fill();
        if (!blink) {
          ctx.fillStyle = colors.eye;
          ctx.beginPath();
          ctx.arc(28.3, -8.4, 2.25, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.beginPath();
          ctx.arc(29.2, -9.4, 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 嘴与鳃线。
      ctx.strokeStyle = rgba(colors.eye, 0.8);
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(29, -1, 6.5, 0.2, 1.05);
      ctx.stroke();
      ctx.strokeStyle = rgba(colors.whaleDark, 0.5);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(18, -13);
      ctx.quadraticCurveTo(20, -8, 18, -3);
      ctx.stroke();

      // 背上的喷水孔 + 空中尾迹水珠。
      ctx.fillStyle = rgba(colors.eye, 0.65);
      ctx.beginPath();
      ctx.ellipse(7, -29, 2.8, 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      if (!this.onGround && this.vy < -60) {
        ctx.fillStyle = rgba(colors.foam, 0.72);
        for (let i = 0; i < 3; i++) {
          const t = (this.time * 2.5 + i * 0.42) % 1;
          ctx.beginPath();
          ctx.arc(7 + Math.sin(i * 2.1 + this.time) * 7, -32 - t * 28, 1.8 * (1 - t) + 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();

      // 落水 / 高速奔跑时的脚边泡沫。
      if (this.onGround && mode === 'running') {
        const wakeAlpha = this.landFlash > 0 ? 0.8 : 0.32;
        ctx.save();
        ctx.globalAlpha = wakeAlpha;
        ctx.strokeStyle = colors.foam;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 2; i++) {
          const r = 17 + i * 8 + Math.sin(this.runPhase * 2 + i) * 2;
          ctx.beginPath();
          ctx.ellipse(this.x + 35 - i * 3, VIEW.groundY + 5, r, 4.5, 0, 0.1, Math.PI - 0.1);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  /* ------------------------------------------------------------------
     7. Obstacles
  ------------------------------------------------------------------ */

  /**
   * 障碍配置。新增障碍只需向这里追加一项：
   * - kind: 'rock' 越障型 / 'overhang' 强制下潜型
   * - parts: 每块岩石相对障碍原点 dx，以及宽高和造型 id
   * - minScore / weight: 出场门槛与随机权重
   */
  const OBSTACLE_TYPES = Object.freeze([
    {
      id: 'rock-single',
      kind: 'rock',
      label: '单块水面岩礁',
      minScore: 0,
      weight: 4,
      parts: [{ dx: 0, w: 30, h: 45, shape: 0 }],
    },
    {
      id: 'rock-double',
      kind: 'rock',
      label: '双块水面岩礁',
      minScore: 55,
      weight: 3,
      parts: [
        { dx: 0, w: 27, h: 38, shape: 1 },
        { dx: 36, w: 32, h: 54, shape: 2 },
      ],
    },
    {
      id: 'rock-triple',
      kind: 'rock',
      label: '三块水面岩礁',
      minScore: 170,
      weight: 2,
      parts: [
        { dx: 0, w: 23, h: 34, shape: 2 },
        { dx: 31, w: 29, h: 50, shape: 0 },
        { dx: 68, w: 25, h: 40, shape: 1 },
      ],
    },
    {
      id: 'overhang-single',
      kind: 'overhang',
      label: '悬浮礁石',
      minScore: 70,
      weight: 2,
      parts: [{ dx: 0, w: 66, h: 188, shape: 3 }],
    },
    {
      id: 'overhang-double',
      kind: 'overhang',
      label: '双层高处岩架',
      minScore: 240,
      weight: 1.2,
      parts: [
        { dx: 0, w: 48, h: 176, shape: 4 },
        { dx: 52, w: 38, h: 165, shape: 3 },
      ],
    },
  ]);

  const OVERHANG_BOTTOM_ABOVE_GROUND = 34; // 岩架下沿离水面 34px，只有下潜（20px 高）能过

  class Obstacle {
    constructor(config, x) {
      this.config = config;
      this.x = x;
      this.time = 0;
      this.passed = false;
      this.parts = config.parts.map((p) => ({ ...p }));
      this.totalWidth =
        Math.max(...this.parts.map((p) => p.dx + p.w)) - Math.min(...this.parts.map((p) => p.dx));
      this.minX = Math.min(...this.parts.map((p) => p.dx));
      this.width = this.totalWidth;
    }

    update(dt, speed) {
      this.x -= speed * dt;
      this.time += dt;
    }

    getRects() {
      const rects = [];
      for (const p of this.parts) {
        let y;
        if (this.config.kind === 'rock') {
          y = VIEW.groundY - p.h;
        } else {
          y = VIEW.groundY - OVERHANG_BOTTOM_ABOVE_GROUND - p.h;
        }
        rects.push({
          x: this.x + p.dx + COLLISION_INSET,
          y: y + COLLISION_INSET,
          w: p.w - COLLISION_INSET * 2,
          h: p.h - COLLISION_INSET * 2,
        });
      }
      return rects;
    }

    draw(ctx, colors) {
      if (this.config.kind === 'rock') this.drawRock(ctx, colors);
      else this.drawOverhang(ctx, colors);
    }

    drawRock(ctx, colors) {
      // 每簇先画底部水花，避免岩石看起来“贴”在水上。
      ctx.save();
      ctx.globalAlpha = 0.62;
      ctx.fillStyle = colors.foam;
      ctx.beginPath();
      ctx.ellipse(this.x + this.width * 0.5, VIEW.groundY + 3, this.width * 0.64 + 8, 4.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = colors.foamSoft;
      ctx.beginPath();
      ctx.ellipse(this.x + this.width * 0.5, VIEW.groundY + 7, this.width * 0.84 + 14, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      for (let i = 0; i < this.parts.length; i++) {
        const p = this.parts[i];
        const x = this.x + p.dx;
        const baseY = VIEW.groundY + 8;

        // 岩石倒影。
        ctx.save();
        ctx.globalAlpha = 0.17;
        ctx.fillStyle = colors.rockDark;
        ctx.beginPath();
        ctx.ellipse(x + p.w * 0.5, VIEW.groundY + 10, p.w * 0.55, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(x, baseY);
        ctx.beginPath();
        const shape = p.shape % 3;
        if (shape === 0) {
          ctx.moveTo(1, 0);
          ctx.lineTo(2, -p.h * 0.34);
          ctx.lineTo(-2, -p.h * 0.65);
          ctx.lineTo(7, -p.h * 0.88);
          ctx.lineTo(14, -p.h);
          ctx.lineTo(21, -p.h * 0.72);
          ctx.lineTo(28, -p.h * 0.48);
          ctx.lineTo(25, -p.h * 0.18);
          ctx.lineTo(p.w - 1, 0);
        } else if (shape === 1) {
          ctx.moveTo(0, 0);
          ctx.lineTo(2, -p.h * 0.25);
          ctx.lineTo(-1, -p.h * 0.52);
          ctx.lineTo(8, -p.h * 0.8);
          ctx.lineTo(17, -p.h);
          ctx.lineTo(24, -p.h * 0.62);
          ctx.lineTo(p.w - 2, -p.h * 0.3);
          ctx.lineTo(p.w, 0);
        } else {
          ctx.moveTo(2, 0);
          ctx.lineTo(-1, -p.h * 0.28);
          ctx.lineTo(5, -p.h * 0.55);
          ctx.lineTo(10, -p.h * 0.88);
          ctx.lineTo(18, -p.h);
          ctx.lineTo(23, -p.h * 0.58);
          ctx.lineTo(p.w - 1, -p.h * 0.26);
          ctx.lineTo(p.w, 0);
        }
        ctx.closePath();
        ctx.fillStyle = colors.rock;
        ctx.fill();

        // 受光面。
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(2, -p.h * 0.34);
        ctx.lineTo(-2, -p.h * 0.65);
        ctx.lineTo(7, -p.h * 0.88);
        ctx.lineTo(14, -p.h);
        ctx.lineTo(13, -p.h * 0.48);
        ctx.lineTo(8, -p.h * 0.13);
        ctx.closePath();
        ctx.fillStyle = rgba(colors.rockLight, 0.84);
        ctx.fill();

        // 背光面。
        ctx.beginPath();
        ctx.moveTo(14, -p.h);
        ctx.lineTo(21, -p.h * 0.72);
        ctx.lineTo(28, -p.h * 0.48);
        ctx.lineTo(25, -p.h * 0.18);
        ctx.lineTo(p.w, 0);
        ctx.lineTo(19, -p.h * 0.25);
        ctx.closePath();
        ctx.fillStyle = rgba(colors.rockDark, 0.9);
        ctx.fill();

        // 湿面高光与苔藓。
        ctx.strokeStyle = rgba(colors.foam, 0.34);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(9, -p.h * 0.74);
        ctx.quadraticCurveTo(13, -p.h * 0.8, 17, -p.h * 0.73);
        ctx.stroke();

        ctx.fillStyle = rgba(colors.rockWet, 0.86);
        ctx.beginPath();
        ctx.ellipse(p.w * 0.46, -p.h * 0.59, p.w * 0.1, 2.4, -0.25, 0, Math.PI * 2);
        ctx.ellipse(p.w * 0.68, -p.h * 0.46, p.w * 0.07, 1.8, 0.3, 0, Math.PI * 2);
        ctx.fill();

        // 岩石根部被海水覆盖的一圈亮边。
        ctx.strokeStyle = rgba(colors.foam, 0.72);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-1, -1);
        ctx.quadraticCurveTo(p.w * 0.32, 2.5, p.w + 1, -1);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawOverhang(ctx, colors) {
      const bottomY = VIEW.groundY - OVERHANG_BOTTOM_ABOVE_GROUND;
      const left = this.x + this.minX - 6;
      const right = this.x + this.width + 6;

      // 悬浮物在水面投下的阴影，提示“这是上方障碍”。
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = colors.seaFloor;
      ctx.beginPath();
      ctx.ellipse(this.x + this.width * 0.5, VIEW.groundY + 4, this.width * 0.7 + 18, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 底部气流/水沫，让下沿的通行缝隙更易读。
      ctx.save();
      ctx.globalAlpha = 0.28 + Math.sin(this.time * 2.1) * 0.04;
      ctx.strokeStyle = colors.foamSoft;
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 3; i++) {
        const y = bottomY + 11 + i * 4;
        ctx.beginPath();
        ctx.moveTo(left + 9 + i * 5, y);
        ctx.quadraticCurveTo((left + right) * 0.5, y + 3, right - 12 - i * 4, y);
        ctx.stroke();
      }
      ctx.restore();

      for (const p of this.parts) {
        const x = this.x + p.dx;
        const topY = bottomY - p.h;
        const shape = p.shape % 2;

        ctx.save();
        ctx.translate(x, topY);

        // 高空岩体。下沿接近水平，碰撞盒和视觉一致。
        ctx.beginPath();
        if (shape === 0) {
          ctx.moveTo(7, 0);
          ctx.lineTo(2, 18);
          ctx.lineTo(-4, p.h * 0.28);
          ctx.lineTo(5, p.h * 0.5);
          ctx.lineTo(1, p.h * 0.72);
          ctx.lineTo(10, p.h * 0.9);
          ctx.lineTo(9, p.h - 5);
          ctx.lineTo(p.w * 0.35, p.h - 1);
          ctx.lineTo(p.w * 0.66, p.h - 7);
          ctx.lineTo(p.w - 5, p.h - 2);
          ctx.lineTo(p.w + 5, p.h * 0.82);
          ctx.lineTo(p.w - 2, p.h * 0.58);
          ctx.lineTo(p.w + 4, p.h * 0.34);
          ctx.lineTo(p.w - 7, p.h * 0.18);
          ctx.lineTo(p.w - 1, 0);
        } else {
          ctx.moveTo(6, 0);
          ctx.lineTo(2, 16);
          ctx.lineTo(7, p.h * 0.32);
          ctx.lineTo(-1, p.h * 0.54);
          ctx.lineTo(8, p.h * 0.75);
          ctx.lineTo(6, p.h - 3);
          ctx.lineTo(p.w * 0.4, p.h - 8);
          ctx.lineTo(p.w * 0.7, p.h - 1);
          ctx.lineTo(p.w - 2, p.h - 5);
          ctx.lineTo(p.w + 4, p.h * 0.7);
          ctx.lineTo(p.w - 3, p.h * 0.46);
          ctx.lineTo(p.w, p.h * 0.2);
          ctx.lineTo(p.w - 5, 0);
        }
        ctx.closePath();
        ctx.fillStyle = colors.rock;
        ctx.fill();

        // 受光边。
        ctx.beginPath();
        ctx.moveTo(7, 0);
        ctx.lineTo(2, 18);
        ctx.lineTo(-4, p.h * 0.28);
        ctx.lineTo(5, p.h * 0.5);
        ctx.lineTo(1, p.h * 0.72);
        ctx.lineTo(10, p.h * 0.9);
        ctx.lineTo(10, p.h * 0.45);
        ctx.lineTo(14, p.h * 0.2);
        ctx.closePath();
        ctx.fillStyle = rgba(colors.rockLight, 0.54);
        ctx.fill();

        // 暗面。
        ctx.beginPath();
        ctx.moveTo(p.w - 1, 0);
        ctx.lineTo(p.w + 4, p.h * 0.34);
        ctx.lineTo(p.w - 2, p.h * 0.58);
        ctx.lineTo(p.w + 5, p.h * 0.82);
        ctx.lineTo(p.w - 5, p.h - 2);
        ctx.lineTo(p.w * 0.66, p.h - 7);
        ctx.lineTo(p.w * 0.78, p.h * 0.32);
        ctx.closePath();
        ctx.fillStyle = rgba(colors.rockDark, 0.8);
        ctx.fill();

        // 下沿的湿亮边 + 垂落水草，明确可通过的缝隙。
        ctx.strokeStyle = rgba(colors.foam, 0.46);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(8, p.h - 4);
        ctx.quadraticCurveTo(p.w * 0.42, p.h + 1, p.w - 6, p.h - 4);
        ctx.stroke();

        ctx.strokeStyle = rgba(colors.rockWet, 0.9);
        ctx.lineWidth = 1.4;
        for (let i = 0; i < 3; i++) {
          const sx = 14 + i * (p.w / 4.2);
          const len = 5 + ((i + this.config.parts.length) % 3) * 4;
          ctx.beginPath();
          ctx.moveTo(sx, p.h - 5);
          ctx.quadraticCurveTo(sx + 2, p.h + len * 0.5, sx - 1, p.h + len);
          ctx.stroke();
        }

        // 顶部悬挂的少量气泡，增加悬浮感。
        ctx.fillStyle = rgba(colors.foam, 0.34);
        for (let i = 0; i < 2; i++) {
          const t = (this.time * 0.7 + i * 0.48) % 1;
          ctx.beginPath();
          ctx.arc(11 + i * 18, p.h * 0.1 + t * 18, 1.5 + t * 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  class ObstacleField {
    constructor() {
      this.obstacles = [];
      this.reset();
    }

    reset() {
      this.obstacles.length = 0;
      this.spawnCount = 0;
      this.spawnTimer = 0.72;
      this.sinceSpawn = 0;
      this.pendingType = null;
    }

    get last() {
      return this.obstacles.length ? this.obstacles[this.obstacles.length - 1] : null;
    }

    minGap(speed) {
      // 原始最小间距随速度提高而缩短；但额外用 0.62s 的反应距离兜底，
      // 保证高速度下仍留给玩家起跳/下潜的时间。
      const raw = Math.max(300, 410 - (speed - SPEED.base) * 0.18);
      return Math.max(raw, speed * 0.62);
    }

    requiredGap(last, next, speed) {
      let gap = this.minGap(speed);

      // 跳过水面岩礁时玩家还在空中，若紧接着就是必须下潜的悬浮岩架，
      // 会出现在落点之前岩架已经贴身、跳也撞潜也来不及的死局。
      // 因此“岩礁 → 悬浮岩架”额外保证 0.95s 的落地缓冲（并留 120px 余量）。
      if (last.config.kind === 'rock' && next.kind === 'overhang') {
        gap = Math.max(gap, speed * 0.95 + 120);
      }
      return gap;
    }

    chooseType(score) {
      const available = OBSTACLE_TYPES.filter((o) => score >= o.minScore);
      // 固定节奏地插入“强制下潜”障碍，避免随机数长时间不出现在玩家面前。
      if (score >= 70 && this.spawnCount % 4 === 3) {
        const overhangs = available.filter((o) => o.kind === 'overhang');
        if (overhangs.length) {
          return overhangs[overhangs.length - 1];
        }
      }
      let total = 0;
      for (const o of available) total += o.weight;
      let r = Math.random() * total;
      for (const o of available) {
        r -= o.weight;
        if (r <= 0) return o;
      }
      return available[0];
    }

    spawn(speed, score, type = this.chooseType(score)) {
      const obstacle = new Obstacle(type, VIEW.width + 46);
      this.obstacles.push(obstacle);
      this.spawnCount++;
      this.sinceSpawn = 0;
      this.pendingType = null;
      void speed;
    }

    update(dt, speed, score) {
      this.sinceSpawn += dt;
      this.spawnTimer -= dt;
      for (let i = 0; i < this.obstacles.length; i++) {
        this.obstacles[i].update(dt, speed);
      }

      // 移除移出左侧的障碍，保持数组长度稳定。
      for (let i = this.obstacles.length - 1; i >= 0; i--) {
        if (this.obstacles[i].x + this.obstacles[i].width < -80) {
          this.obstacles.splice(i, 1);
        }
      }

      if (this.spawnTimer > 0) return;
      const last = this.last;
      if (!last) {
        this.spawn(speed, score);
        return;
      }
      // 只在真正等待间距时锁存下一类型，避免每帧重抽随机数导致类型抖动。
      if (!this.pendingType) this.pendingType = this.chooseType(score);
      const gap = this.requiredGap(last, this.pendingType, speed);
      // 以“上一障碍右沿到新障碍左沿”的实际世界距离为最小间距。
      if (last.x + last.width < VIEW.width - gap) {
        this.spawn(speed, score, this.pendingType);
      }
    }

    collides(rect) {
      for (const obstacle of this.obstacles) {
        for (const hit of obstacle.getRects()) {
          if (
            rect.x < hit.x + hit.w &&
            rect.x + rect.w > hit.x &&
            rect.y < hit.y + hit.h &&
            rect.y + rect.h > hit.y
          ) {
            return true;
          }
        }
      }
      return false;
    }

    draw(ctx, colors) {
      for (const obstacle of this.obstacles) obstacle.draw(ctx, colors);
    }
  }

  /* ------------------------------------------------------------------
     8. Scoreboard
  ------------------------------------------------------------------ */

  class Scoreboard {
    constructor() {
      this.best = this.loadBest();
      this.score = 0;
      this.display = 0;
      this.flashTimer = 0;
      this.lastFlashMark = 0;
      this.newBest = false;
      this.finalScore = 0;
    }

    loadBest() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const value = raw == null ? 0 : Number(raw);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
      } catch (err) {
        // 隐私模式/禁用 localStorage 时游戏仍然可玩，只是不持久化。
        return 0;
      }
    }

    resetRun() {
      this.score = 0;
      this.display = 0;
      this.flashTimer = 0;
      this.lastFlashMark = 0;
      this.newBest = false;
      this.finalScore = 0;
    }

    update(dt, speed) {
      this.score += speed * dt * SCORING.pointsPerPixel;
      this.display = Math.floor(this.score);
      const mark = Math.floor(this.display / 10);
      if (mark > this.lastFlashMark) {
        this.lastFlashMark = mark;
        this.flashTimer = 0.16;
      }
      if (this.flashTimer > 0) this.flashTimer -= dt;
    }

    commit() {
      this.finalScore = Math.floor(this.score);
      if (this.finalScore > this.best) {
        this.best = this.finalScore;
        this.newBest = true;
        try {
          window.localStorage.setItem(STORAGE_KEY, String(this.best));
        } catch (err) {
          // 忽略持久化失败。
        }
      }
      return this.newBest;
    }

    draw(ctx, colors, mode, fontStack) {
      const y = 42;
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.font = `700 15px ${fontStack}`;
      ctx.fillStyle = rgba(colors.hud, 0.66);
      ctx.fillText('HI', VIEW.width - 178, y);

      ctx.font = `800 16px ${fontStack}`;
      ctx.fillStyle = rgba(colors.hud, 0.82);
      ctx.fillText(formatScore(this.best), VIEW.width - 126, y);

      const current = mode === 'gameover' ? this.finalScore : this.display;
      let alpha = 1;
      if (this.flashTimer > 0) {
        alpha = Math.floor(this.flashTimer * 40) % 2 === 0 ? 0.32 : 1;
      }
      ctx.globalAlpha = alpha;
      ctx.font = `800 20px ${fontStack}`;
      ctx.fillStyle = colors.hud;
      ctx.fillText(formatScore(current), VIEW.width - 38, y);
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------
     9. Input
  ------------------------------------------------------------------ */

  class Input {
    constructor(game, canvas, pauseButton) {
      this.game = game;
      this.canvas = canvas;
      this.pauseButton = pauseButton;
      this.pointer = null;
      this.tapTimer = null;
      this.mouseJumping = false;

      this.bindKeyboard();
      this.bindPointer();
      this.bindLifecycle();
    }

    bindKeyboard() {
      window.addEventListener(
        'keydown',
        (e) => {
          const code = e.code;
          if (code === 'Space' || code === 'ArrowUp' || code === 'ArrowDown' || code === 'KeyP') {
            e.preventDefault();
          }
          if (e.repeat) return;

          if (code === 'Space' || code === 'ArrowUp') {
            this.game.primaryAction();
          } else if (code === 'ArrowDown') {
            this.game.secondaryAction();
          } else if (code === 'KeyP' || code === 'Escape') {
            this.game.togglePause();
          }
        },
        { passive: false }
      );

      window.addEventListener('keyup', (e) => {
        if (e.code === 'Space' || e.code === 'ArrowUp') {
          e.preventDefault();
          this.game.releaseJump();
        } else if (e.code === 'ArrowDown') {
          e.preventDefault();
          this.game.releaseDive();
        }
      });

      window.addEventListener('blur', () => this.game.pauseFromFocusLoss());
    }

    bindPointer() {
      const canvas = this.canvas;

      canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      canvas.addEventListener(
        'pointerdown',
        (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.preventDefault();

          this.clearTapTimer();
          const now = performance.now();
          this.pointer = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            type: e.pointerType,
            start: now,
            gesture: null,
          };

          try {
            canvas.setPointerCapture(e.pointerId);
          } catch (err) {
            // 某些浏览器在合成事件里不允许 capture，不影响手势。
          }

          if (this.game.state !== 'running' || this.game.paused) {
            this.game.primaryAction();
            return;
          }

          if (e.pointerType === 'mouse') {
            this.mouseJumping = true;
            this.game.primaryAction();
            return;
          }

          // 触屏：延迟 55ms 判断是轻点还是下滑。
          // 长按会成为更高的跳跃；下滑会在计时器触发前被识别并取消跳跃。
          this.tapTimer = window.setTimeout(() => {
            this.tapTimer = null;
            if (!this.pointer || this.pointer.gesture) return;
            this.game.primaryAction();
          }, 55);
        },
        { passive: false }
      );

      canvas.addEventListener(
        'pointermove',
        (e) => {
          if (!this.pointer || e.pointerId !== this.pointer.id) return;
          e.preventDefault();
          const dy = e.clientY - this.pointer.y;
          const dx = e.clientX - this.pointer.x;
          if (this.pointer.gesture || Math.max(Math.abs(dy), Math.abs(dx)) < 14) return;

          if (dy <= -14 && Math.abs(dy) >= Math.abs(dx) * 0.7) {
            this.pointer.gesture = 'up';
            this.clearTapTimer();
            this.game.primaryAction();
          } else if (dy >= 14 && Math.abs(dy) >= Math.abs(dx) * 0.7) {
            this.pointer.gesture = 'down';
            this.clearTapTimer();
            this.game.secondaryAction();
          }
        },
        { passive: false }
      );

      const finish = (e) => {
        if (!this.pointer || e.pointerId !== this.pointer.id) return;
        e.preventDefault();
        this.clearTapTimer();
        const gesture = this.pointer.gesture;
        const wasRunning = this.game.state === 'running';
        const type = this.pointer.type;

        if (gesture === 'up') {
          this.game.releaseJump();
        } else if (gesture === 'down') {
          this.game.releaseDive();
        } else if (wasRunning && !this.game.paused) {
          // 轻点：开始跳跃并立刻松开，形成小跳。
          this.game.primaryAction();
          this.game.releaseJump();
        }

        if (this.mouseJumping) {
          this.game.releaseJump();
          this.mouseJumping = false;
        }

        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch (err) {
          // 指针已释放。
        }
        this.pointer = null;
        void type;
      };

      canvas.addEventListener('pointerup', finish, { passive: false });
      canvas.addEventListener('pointercancel', finish, { passive: false });

      // 双保险：阻止旧版 iOS 的页面滚动/回弹。
      canvas.addEventListener(
        'touchmove',
        (e) => {
          e.preventDefault();
        },
        { passive: false }
      );

      if (this.pauseButton) {
        this.pauseButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.game.togglePause();
        });
      }
    }

    bindLifecycle() {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.game.pauseFromFocusLoss();
      });
    }

    clearTapTimer() {
      if (this.tapTimer != null) {
        window.clearTimeout(this.tapTimer);
        this.tapTimer = null;
      }
    }
  }

  /* ------------------------------------------------------------------
     10. Game
  ------------------------------------------------------------------ */

  const FONT_STACK = '"Nunito", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';

  class Game {
    constructor(canvas, pauseButton) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.pauseButton = pauseButton;
      this.palette = new Palette();
      this.background = new Background();
      this.particles = new ParticleSystem(150);
      this.player = new Player(118);
      this.obstacles = new ObstacleField();
      this.scoreboard = new Scoreboard();
      this.input = new Input(this, canvas, pauseButton);

      this.state = 'ready';
      this.paused = false;
      this.lastTime = 0;
      this.frameCount = 0;
      this.gameTime = 0;
      this.runTime = 0;
      this.speed = SPEED.base;
      this.distance = 0;
      this.shake = 0;
      this.overAt = 0;
      this.wakeTimer = 0;
      this.themeToast = { text: '', alpha: 0, hold: 0 };
      this.lastThemeTarget = 0;
      this.width = 960;
      this.height = 540;
      this.dpr = 1;
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this._loop = this.loop.bind(this);

      this.resize();
      window.addEventListener('resize', () => this.resize());
      window.addEventListener('orientationchange', () => {
        // orientationchange 触发时可视尺寸可能还没更新，下一帧再量一次。
        window.requestAnimationFrame(() => this.resize());
      });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => this.resize());
      }
      document.addEventListener('fullscreenchange', () => this.resize());

      this.updatePauseButton();
      this.lastTime = performance.now();
      window.requestAnimationFrame(this._loop);
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width || window.innerWidth);
      const cssH = Math.max(1, rect.height || window.innerHeight);
      this.width = cssW;
      this.height = cssH;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const pixelW = Math.round(cssW * this.dpr);
      const pixelH = Math.round(cssH * this.dpr);
      if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
        this.canvas.width = pixelW;
        this.canvas.height = pixelH;
      }
      // contain：保留完整判定区，不裁切左右视野。
      this.scale = Math.min(cssW / VIEW.width, cssH / VIEW.height);
      this.offsetX = (cssW - VIEW.width * this.scale) / 2;
      this.offsetY = (cssH - VIEW.height * this.scale) / 2;
    }

    get isActive() {
      return this.state === 'running' && !this.paused;
    }

    resetRun() {
      this.player.reset();
      this.obstacles.reset();
      this.scoreboard.resetRun();
      this.particles.clear();
      this.background.reset();
      this.palette.reset();
      this.speed = SPEED.base;
      this.distance = 0;
      this.runTime = 0;
      this.gameTime = 0;
      this.frameCount = 0;
      this.shake = 0;
      this.wakeTimer = 0;
      this.overAt = 0;
      this.lastThemeTarget = 0;
      this.themeToast.alpha = 0;
      this.themeToast.hold = 0;
    }

    startRun() {
      this.resetRun();
      this.state = 'running';
      this.paused = false;
      this.lastTime = performance.now();
      this.updatePauseButton();
    }

    restart() {
      this.startRun();
    }

    primaryAction() {
      if (this.paused) {
        this.resume();
        return;
      }
      if (this.state === 'ready') {
        this.startRun();
        if (this.player.jump()) {
          this.particles.splash(this.player.x + 38, VIEW.groundY, 0.75, 7);
        }
        return;
      }
      if (this.state === 'running') {
        if (this.player.jump()) {
          this.particles.splash(this.player.x + 38, VIEW.groundY, 0.75, 7);
        }
        return;
      }
      if (this.state === 'gameover' && performance.now() - this.overAt > 420) {
        this.restart();
      }
    }

    secondaryAction() {
      if (this.paused) {
        this.resume();
        return;
      }
      if (this.state === 'ready') {
        this.startRun();
        this.player.startDive();
        return;
      }
      if (this.state === 'running') {
        this.player.startDive();
      }
    }

    releaseJump() {
      this.player.releaseJump();
    }

    releaseDive() {
      this.player.releaseDive();
    }

    togglePause() {
      if (this.state !== 'running') return;
      if (this.paused) this.resume();
      else this.pause();
    }

    pause() {
      if (this.state !== 'running' || this.paused) return;
      this.paused = true;
      this.updatePauseButton();
    }

    pauseFromFocusLoss() {
      if (this.state === 'running' && !this.paused) this.pause();
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.lastTime = performance.now();
      this.updatePauseButton();
    }

    updatePauseButton() {
      if (!this.pauseButton) return;
      const visible = this.state === 'running';
      this.pauseButton.classList.toggle('is-visible', visible);
      this.pauseButton.classList.toggle('is-paused', this.paused);
      this.pauseButton.setAttribute('aria-label', this.paused ? '继续游戏' : '暂停游戏');
      this.pauseButton.setAttribute('aria-pressed', this.paused ? 'true' : 'false');
    }

    gameOver() {
      if (this.state !== 'running') return;
      this.state = 'gameover';
      this.paused = false;
      this.player.dead = true;
      this.overAt = performance.now();
      this.shake = 9;
      this.scoreboard.commit();
      this.particles.burst(
        this.player.x + 38,
        this.player.y - 24,
        28,
        this.palette.colors
      );
      this.updatePauseButton();
    }

    syncTheme(score) {
      this.palette.setScore(score);
      if (this.palette.nightTarget !== this.lastThemeTarget) {
        this.lastThemeTarget = this.palette.nightTarget;
        this.themeToast.text = this.palette.nightTarget === 1 ? '深海夜航' : '晨光海面';
        this.themeToast.alpha = 1;
        this.themeToast.hold = 1.7;
      }
    }

    update(dt) {
      this.gameTime += dt;
      const colors = this.palette.colors;

      if (this.state === 'running') {
        this.runTime += dt;
        this.speed = Math.min(
          SPEED.max,
          SPEED.base + this.scoreboard.score * SPEED.gainPerPoint
        );
        this.distance += this.speed * dt;
        this.scoreboard.update(dt, this.speed);
        this.syncTheme(this.scoreboard.score);
        this.palette.update(dt);

        const landed = this.player.update(dt, this.speed, 'running');
        if (landed) {
          this.particles.splash(this.player.x + 38, VIEW.groundY, 1.15, 15);
        }

        this.background.update(dt, this.speed, this.palette.night);
        this.obstacles.update(dt, this.speed, this.scoreboard.score);
        this.particles.update(dt);

        // 高速奔跑时持续留下小尾迹，数量由计时器限制。
        if (this.player.onGround) {
          this.wakeTimer -= dt;
          if (this.wakeTimer <= 0) {
            this.wakeTimer = 0.075;
            this.particles.wake(this.player.x + 2, VIEW.groundY + 3);
          }
        }

        if (!this.qaInvincible && this.obstacles.collides(this.player.collisionRect)) {
          this.gameOver();
        }
        void colors;
      } else if (this.state === 'ready') {
        this.background.update(dt, 54, 0);
        this.player.update(dt, 54, 'ready');
        this.particles.update(dt);
        this.palette.update(dt);
      } else if (this.state === 'gameover') {
        this.background.update(dt, 48, this.palette.night);
        this.player.update(dt, 48, 'gameover');
        this.particles.update(dt);
        this.palette.update(dt);
        if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 28);
      }

      if (this.themeToast.alpha > 0) {
        if (this.themeToast.hold > 0) {
          this.themeToast.hold -= dt;
        } else {
          this.themeToast.alpha = Math.max(0, this.themeToast.alpha - dt * 1.4);
        }
      }
    }

    loop(now) {
      const raw = (now - this.lastTime) / 1000;
      this.lastTime = now;
      // 仅对切后台/掉帧做上限保护，不引入固定帧步进；正常 60fps 时 dt≈0.0167。
      const dt = clamp(raw || 0.0166667, 0, 0.05);

      if (!this.paused) this.update(dt);
      this.render(dt);
      this.frameCount += 1;

      window.requestAnimationFrame(this._loop);
    }

    render() {
      const ctx = this.ctx;
      const colors = this.palette.colors;
      const dpr = this.dpr;
      const w = this.width;
      const h = this.height;
      const scale = this.scale;
      const offsetX = this.offsetX;
      const offsetY = this.offsetY;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // 画面留白（超宽/超高屏）用与主题一致的深海底色，避免刺眼黑白边。
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, colors.skyTop);
      bg.addColorStop(0.55, colors.seaTop);
      bg.addColorStop(1, colors.letterbox);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
      const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;

      ctx.save();
      ctx.translate(offsetX + shakeX, offsetY + shakeY);
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.rect(0, 0, VIEW.width, VIEW.height);
      ctx.clip();

      // 世界。
      this.background.draw(ctx, colors, this.palette.night);
      this.obstacles.draw(ctx, colors);

      // 鲸鱼与粒子。
      this.player.draw(ctx, colors, this.state, this.speed);
      this.particles.draw(ctx, colors);

      // 轻微暗角。
      const vignette = ctx.createRadialGradient(
        VIEW.width * 0.5,
        VIEW.height * 0.45,
        VIEW.height * 0.25,
        VIEW.width * 0.5,
        VIEW.height * 0.5,
        VIEW.width * 0.72
      );
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, rgba(colors.letterbox, this.palette.night > 0.5 ? 0.32 : 0.14));
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, VIEW.width, VIEW.height);

      this.scoreboard.draw(ctx, colors, this.state, FONT_STACK);
      this.drawHud(ctx, colors);
      this.drawOverlays(ctx, colors);

      ctx.restore();

      // 有留白时加一条很淡的舞台边，避免画面像被裁切。
      if (offsetX > 1 || offsetY > 1) {
        ctx.strokeStyle = rgba(colors.foam, 0.12);
        ctx.lineWidth = 1;
        ctx.strokeRect(offsetX + 0.5, offsetY + 0.5, VIEW.width * scale - 1, VIEW.height * scale - 1);
      }
    }

    drawHud(ctx, colors) {
      // 极简的模式提示；真实夜航切换由全画面配色完成。
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `700 11px ${FONT_STACK}`;
      ctx.fillStyle = colors.hud;
      const modeText = this.palette.night > 0.5 ? 'NIGHT PASSAGE' : 'SUNLIT SEA';
      drawSpacedText(ctx, modeText, 68, 38, 1.7, 'left');
      ctx.restore();

      if (this.themeToast.alpha > 0) {
        ctx.save();
        ctx.globalAlpha = this.themeToast.alpha;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 13px ${FONT_STACK}`;
        ctx.fillStyle = colors.accent;
        drawSpacedText(ctx, this.themeToast.text, VIEW.width / 2, 92, 3.2, 'center');
        ctx.strokeStyle = rgba(colors.accent, 0.45);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(VIEW.width / 2 - 58, 105);
        ctx.lineTo(VIEW.width / 2 + 58, 105);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawOverlays(ctx, colors) {
      if (this.state === 'ready') {
        this.drawReady(ctx, colors);
      } else if (this.state === 'gameover') {
        this.drawGameOver(ctx, colors);
      }

      if (this.paused) {
        this.drawPaused(ctx, colors);
      }
    }

    drawReady(ctx, colors) {
      const pulse = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(this.gameTime * 2.4));

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // 标题背后的一小片海雾，增加文字可读性。
      const titleGlow = ctx.createRadialGradient(
        VIEW.width / 2,
        130,
        20,
        VIEW.width / 2,
        130,
        270
      );
      titleGlow.addColorStop(0, rgba(colors.skyBottom, 0.52));
      titleGlow.addColorStop(1, rgba(colors.skyBottom, 0));
      ctx.fillStyle = titleGlow;
      ctx.fillRect(160, 30, 640, 220);

      ctx.font = `900 56px ${FONT_STACK}`;
      ctx.fillStyle = colors.hud;
      ctx.globalAlpha = 0.16;
      ctx.fillText('小鲸鱼快跑', VIEW.width / 2 + 2, 132 + 3);
      ctx.globalAlpha = 1;
      ctx.fillText('小鲸鱼快跑', VIEW.width / 2, 132);

      ctx.font = `800 12px ${FONT_STACK}`;
      ctx.fillStyle = rgba(colors.hudSoft, 0.88);
      drawSpacedText(ctx, 'LITTLE WHALE RUN', VIEW.width / 2, 174, 6, 'center');

      // 操作卡片。
      const chips = [
        { key: 'SPACE / ↑ / TAP', label: '跳跃', w: 212 },
        { key: '↓ / SWIPE DOWN', label: '下潜', w: 212 },
        { key: 'P', label: '暂停', w: 118 },
      ];
      let total = chips.reduce((sum, c) => sum + c.w, 0) + 12 * (chips.length - 1);
      let x = (VIEW.width - total) / 2;
      const y = 252;
      ctx.font = `700 10px ${FONT_STACK}`;
      for (const chip of chips) {
        roundedRect(ctx, x, y, chip.w, 38, 11);
        ctx.fillStyle = rgba(colors.panel, 0.12);
        ctx.fill();
        ctx.strokeStyle = rgba(colors.hud, 0.14);
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = rgba(colors.hud, 0.74);
        ctx.font = `700 9px ${FONT_STACK}`;
        ctx.fillText(chip.key, x + 12, y + 14);
        ctx.fillStyle = colors.hud;
        ctx.font = `800 13px ${FONT_STACK}`;
        ctx.fillText(chip.label, x + 12, y + 28);
        x += chip.w + 12;
      }

      // 开始提示。
      ctx.textAlign = 'center';
      ctx.globalAlpha = pulse;
      ctx.font = `800 15px ${FONT_STACK}`;
      ctx.fillStyle = colors.hud;
      ctx.fillText('按空格 / 点击画面开始', VIEW.width / 2, 336);
      ctx.globalAlpha = 1;

      // 三角指示。
      ctx.fillStyle = colors.accent;
      ctx.beginPath();
      ctx.moveTo(VIEW.width / 2 - 92, 326);
      ctx.lineTo(VIEW.width / 2 - 82, 331);
      ctx.lineTo(VIEW.width / 2 - 92, 336);
      ctx.closePath();
      ctx.fill();

      ctx.font = `600 11px ${FONT_STACK}`;
      ctx.fillStyle = rgba(colors.hudSoft, 0.78);
      ctx.fillText('长按跳得更高 · 轻点小跳 · 下潜穿过悬浮岩架', VIEW.width / 2, 362);

      ctx.restore();
    }

    drawPaused(ctx, colors) {
      ctx.save();
      ctx.fillStyle = rgba(colors.letterbox, 0.42);
      ctx.fillRect(0, 0, VIEW.width, VIEW.height);

      const w = 390;
      const h = 166;
      const x = (VIEW.width - w) / 2;
      const y = (VIEW.height - h) / 2;
      roundedRect(ctx, x, y, w, h, 22);
      ctx.fillStyle = rgba(colors.panel, 0.9);
      ctx.fill();
      ctx.strokeStyle = rgba(colors.foam, 0.18);
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.panelText;
      ctx.font = `800 30px ${FONT_STACK}`;
      ctx.fillText('已暂停', VIEW.width / 2, y + 54);
      ctx.font = `600 12px ${FONT_STACK}`;
      ctx.fillStyle = rgba(colors.panelText, 0.68);
      ctx.fillText('按 P 或点击画面继续', VIEW.width / 2, y + 94);
      ctx.fillStyle = rgba(colors.panelText, 0.42);
      ctx.font = `600 10px ${FONT_STACK}`;
      ctx.fillText('窗口失焦会自动暂停', VIEW.width / 2, y + 126);
      ctx.restore();
    }

    drawGameOver(ctx, colors) {
      ctx.save();
      ctx.fillStyle = rgba(colors.letterbox, 0.38);
      ctx.fillRect(0, 0, VIEW.width, VIEW.height);

      const w = 500;
      const h = 252;
      const x = (VIEW.width - w) / 2;
      const y = (VIEW.height - h) / 2;
      roundedRect(ctx, x, y, w, h, 24);
      ctx.fillStyle = rgba(colors.panel, 0.92);
      ctx.fill();
      ctx.strokeStyle = rgba(colors.foam, 0.16);
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.panelText;
      ctx.font = `800 30px ${FONT_STACK}`;
      ctx.fillText('航行结束', VIEW.width / 2, y + 46);

      ctx.font = `700 10px ${FONT_STACK}`;
      ctx.fillStyle = rgba(colors.panelText, 0.54);
      drawSpacedText(ctx, 'VOYAGE OVER', VIEW.width / 2, y + 72, 3.6, 'center');

      const final = formatScore(this.scoreboard.finalScore);
      ctx.font = `900 54px ${FONT_STACK}`;
      ctx.fillStyle = colors.accent;
      ctx.fillText(final, VIEW.width / 2, y + 126);

      ctx.font = `600 12px ${FONT_STACK}`;
      ctx.fillStyle = rgba(colors.panelText, 0.64);
      ctx.fillText('本次航程', VIEW.width / 2, y + 160);

      ctx.fillStyle = rgba(colors.panelText, 0.78);
      ctx.font = `700 12px ${FONT_STACK}`;
      ctx.fillText(`最高纪录  ${formatScore(this.scoreboard.best)}`, VIEW.width / 2, y + 184);

      if (this.scoreboard.newBest) {
        ctx.fillStyle = colors.accent;
        ctx.font = `800 11px ${FONT_STACK}`;
        drawSpacedText(ctx, 'NEW RECORD', VIEW.width / 2, y + 207, 2.4, 'center');
      }

      const showRestart = performance.now() - this.overAt > 420;
      if (showRestart) {
        ctx.globalAlpha = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(this.gameTime * 3.2));
        ctx.fillStyle = colors.panelText;
        ctx.font = `700 13px ${FONT_STACK}`;
        ctx.fillText('按空格 / 点击画面重新开始', VIEW.width / 2, y + 234);
      }
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------
     11. Bootstrap
  ------------------------------------------------------------------ */

  const canvas = document.getElementById('game');
  const pauseButton = document.getElementById('pause-btn');
  if (!canvas || !canvas.getContext) return;

  const game = new Game(canvas, pauseButton);

  const snapshot = () => ({
    state: game.state,
    paused: game.paused,
    score: game.scoreboard.display,
    best: game.scoreboard.best,
    speed: Number(game.speed.toFixed(2)),
    frames: game.frameCount,
    runTime: Number(game.runTime.toFixed(3)),
    obstacles: game.obstacles.obstacles.length,
    obstacleIds: game.obstacles.obstacles.map((o) => o.config.id),
    night: Number(game.palette.night.toFixed(2)),
    player: {
      x: Math.round(game.player.x),
      y: Math.round(game.player.y),
      vy: Math.round(game.player.vy),
      onGround: game.player.onGround,
      duck: Number(game.player.duckAmount.toFixed(2)),
      rect: game.player.collisionRect,
    },
  });

  // 只读快照始终可用；只有在 ?qa=1 时才开放布置障碍等验收辅助方法。
  const qa = new URLSearchParams(window.location.search).has('qa');
  const debugApi = { snapshot };
  if (qa) {
    debugApi.clear = () => {
      game.obstacles.obstacles.length = 0;
      game.obstacles.pendingType = null;
      game.obstacles.spawnTimer = 9999;
    };
    debugApi.spawn = (id, x = 760) => {
      const type = OBSTACLE_TYPES.find((item) => item.id === id);
      if (!type) return false;
      game.obstacles.spawnTimer = 9999;
      game.obstacles.obstacles.push(new Obstacle(type, x));
      return true;
    };
    debugApi.setScore = (value) => {
      const safe = Math.max(0, Math.floor(value));
      game.scoreboard.score = safe;
      game.scoreboard.display = safe;
      game.scoreboard.lastFlashMark = Math.floor(safe / 10);
      game.speed = Math.min(SPEED.max, SPEED.base + safe * SPEED.gainPerPoint);
      game.syncTheme(safe);
      return game.speed;
    };
    debugApi.start = () => {
      game.startRun();
      return game.state;
    };
    debugApi.setInvincible = (value) => {
      game.qaInvincible = Boolean(value);
      return game.qaInvincible;
    };
  }

  // 暴露调试快照，便于验收时在控制台观察状态；不改变游戏流程。
  Object.defineProperty(window, '__whaleGame', {
    value: debugApi,
    writable: false,
  });
})();
