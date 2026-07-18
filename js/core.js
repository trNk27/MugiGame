// ============================================================================
// Peitsch den Markus: Survivors — CORE ENGINE
// ----------------------------------------------------------------------------
// Owns: canvas/camera, player, enemies, xp/gems, particles, HUD, sfx, the
// game-state machine, and the main loop. Weapons live in js/weapons.js and
// are driven through the small API documented at the top of that file.
//
// Everything is exposed on the shared global namespace `window.MG` so plain
// <script> tags (no modules) can share state and work under file://.
// ============================================================================
(function () {
  "use strict";

  const MG = (window.MG = window.MG || {});
  // Weapon framework storage lives here so weapons.js (loaded after this
  // file) can push into the registry as soon as it runs.
  MG.weapons = MG.weapons || { registry: [], owned: [] };

  // ---------------------------------------------------------------------
  // Canvas / resize
  // ---------------------------------------------------------------------
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const wrap = document.getElementById("game-wrap");

  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  // ---------------------------------------------------------------------
  // Assets — markus.png is a JPEG-ish cutout on a near-black background
  // (no real alpha channel). Chroma-key the black away once at load so it
  // draws as a clean transparent cutout everywhere else in the game.
  // ---------------------------------------------------------------------
  let markusImg = null;
  let imgReady = false;
  const markusRaw = new Image();
  markusRaw.onload = () => {
    try {
      const off = document.createElement("canvas");
      off.width = markusRaw.width;
      off.height = markusRaw.height;
      const octx = off.getContext("2d");
      octx.drawImage(markusRaw, 0, 0);
      const imgData = octx.getImageData(0, 0, off.width, off.height);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const maxc = Math.max(r, g, b);
        if (maxc < 28) d[i + 3] = 0;
        else if (maxc < 60) d[i + 3] = Math.round(((maxc - 28) / (60 - 28)) * 255);
      }
      octx.putImageData(imgData, 0, 0);
      markusImg = off;
      imgReady = true;
    } catch (e) {
      // Cross-origin / file:// canvas read can fail in some browsers;
      // fall back to drawing the raw image (still looks fine on a dark bg).
      markusImg = markusRaw;
      imgReady = true;
    }
  };
  markusRaw.src = "assets/markus.png";

  // ---------------------------------------------------------------------
  // Audio (WebAudio only, synthesized, no files)
  // ---------------------------------------------------------------------
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }

  function sfxCrack() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const dur = 0.14;
    const buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * dur), audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const p = i / data.length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - p, 3);
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = "highpass"; bp.frequency.value = 1200;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(g).connect(audioCtx.destination);
    src.start(t);
    const osc = audioCtx.createOscillator();
    const og = audioCtx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.1);
    og.gain.setValueAtTime(0.12, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    osc.connect(og).connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.12);
  }
  function sfxHit() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.12);
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.15);
  }
  function sfxPickup() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(500, t);
    osc.frequency.exponentialRampToValueAtTime(1200, t + 0.09);
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.11);
  }
  function sfxLevelup() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((f, i) => {
      const st = t + i * 0.09;
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(f, st);
      g.gain.setValueAtTime(0.001, st);
      g.gain.linearRampToValueAtTime(0.22, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, st + 0.22);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(st); osc.stop(st + 0.24);
    });
  }
  function sfxHurt() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.25);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.27);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.28);
  }
  function sfxGameover() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 1.1);
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 1.12);
  }
  MG.sfx = { crack: sfxCrack, hit: sfxHit, pickup: sfxPickup, levelup: sfxLevelup, hurt: sfxHurt, gameover: sfxGameover };

  // ---------------------------------------------------------------------
  // Input: keyboard + a simple drag-anywhere virtual joystick for touch
  // ---------------------------------------------------------------------
  const keys = new Set();
  const joystick = { active: false, id: null, baseX: 0, baseY: 0, curX: 0, curY: 0, dx: 0, dy: 0 };
  const JOY_R = 50;

  function touchStart(e) {
    ensureAudio();
    if (state !== "playing") return;
    const t = e.changedTouches[0];
    joystick.active = true;
    joystick.id = t.identifier;
    joystick.baseX = t.clientX; joystick.baseY = t.clientY;
    joystick.curX = t.clientX; joystick.curY = t.clientY;
    joystick.dx = 0; joystick.dy = 0;
  }
  function touchMove(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joystick.id) {
        let dx = t.clientX - joystick.baseX, dy = t.clientY - joystick.baseY;
        const d = Math.hypot(dx, dy);
        if (d > JOY_R) { dx = (dx / d) * JOY_R; dy = (dy / d) * JOY_R; }
        joystick.curX = joystick.baseX + dx; joystick.curY = joystick.baseY + dy;
        joystick.dx = dx / JOY_R; joystick.dy = dy / JOY_R;
      }
    }
  }
  function touchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joystick.id) { joystick.active = false; joystick.dx = 0; joystick.dy = 0; }
    }
  }
  canvas.addEventListener("touchstart", (e) => { e.preventDefault(); touchStart(e); }, { passive: false });
  canvas.addEventListener("touchmove", (e) => { e.preventDefault(); touchMove(e); }, { passive: false });
  canvas.addEventListener("touchend", (e) => { e.preventDefault(); touchEnd(e); }, { passive: false });
  canvas.addEventListener("touchcancel", (e) => { e.preventDefault(); touchEnd(e); }, { passive: false });
  canvas.addEventListener("mousedown", () => ensureAudio());

  function moveVector() {
    let dx = 0, dy = 0;
    if (joystick.active) {
      dx = joystick.dx; dy = joystick.dy;
    } else {
      if (keys.has("KeyW") || keys.has("ArrowUp")) dy -= 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) dy += 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) dx -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) dx += 1;
    }
    const mag = Math.min(1, Math.hypot(dx, dy));
    let nx = 0, ny = 0;
    const len = Math.hypot(dx, dy);
    if (len > 0.001) { nx = dx / len; ny = dy / len; }
    return { dirX: nx, dirY: ny, mag };
  }

  // ---------------------------------------------------------------------
  // World / camera
  // ---------------------------------------------------------------------
  const camera = { x: 0, y: 0 };
  MG.camera = camera;
  function worldToScreen(x, y) { return { x: x - camera.x + W / 2, y: y - camera.y + H / 2 }; }
  MG.worldToScreen = worldToScreen;

  function hash2(a, b) {
    let x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function drawBackground() {
    const grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.85);
    grad.addColorStop(0, "#141b2e");
    grad.addColorStop(1, "#05060a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // grid, offset by camera so movement reads clearly
    const grid = 80;
    const offX = ((camera.x - W / 2) % grid + grid) % grid;
    const offY = ((camera.y - H / 2) % grid + grid) % grid;
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -offX; x < W; x += grid) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = -offY; y < H; y += grid) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();

    // sparse dim dots, deterministic per world cell so they don't swim
    const cell = 160;
    const startX = Math.floor((camera.x - W / 2) / cell) - 1;
    const endX = Math.floor((camera.x + W / 2) / cell) + 1;
    const startY = Math.floor((camera.y - H / 2) / cell) - 1;
    const endY = Math.floor((camera.y + H / 2) / cell) + 1;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    for (let cx = startX; cx <= endX; cx++) {
      for (let cy = startY; cy <= endY; cy++) {
        const h = hash2(cx, cy);
        if (h < 0.3) {
          const wx = cx * cell + h * cell;
          const wy = cy * cell + hash2(cy, cx) * cell;
          const s = worldToScreen(wx, wy);
          ctx.beginPath(); ctx.arc(s.x, s.y, 1.4, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Player
  // ---------------------------------------------------------------------
  const player = {
    x: 0, y: 0, r: 22,
    hp: 100,
    stats: { speed: 220, maxHp: 100, regen: 0, pickupRadius: 90 },
    facing: { x: 1, y: 0 },
    invuln: 0,
    bob: 0,
    moving: false,
  };
  MG.player = player;

  function updatePlayer(dt) {
    const mv = moveVector();
    player.moving = mv.mag > 0.05;
    if (player.moving) {
      player.facing.x = mv.dirX;
      player.facing.y = mv.dirY;
    }
    player.x += mv.dirX * mv.mag * player.stats.speed * dt;
    player.y += mv.dirY * mv.mag * player.stats.speed * dt;
    player.bob += dt * (player.moving ? 9 : 2);
    if (player.stats.regen > 0) player.hp = Math.min(player.stats.maxHp, player.hp + player.stats.regen * dt);
    if (player.invuln > 0) player.invuln = Math.max(0, player.invuln - dt);
  }

  function handleContactDamage() {
    if (player.invuln > 0) return;
    for (const e of enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - player.x, e.y - player.y);
      if (d < e.r + player.r) {
        player.hp -= e.contactDmg;
        player.invuln = 1.3; // widened alongside the ENEMY_TYPES dmg tuning above
        MG.sfx.hurt();
        addParticles(player.x, player.y, "#ff5c5c", 10);
        if (player.hp <= 0) { player.hp = 0; gameOver(); }
        break;
      }
    }
  }

  function drawPlayer() {
    const s = worldToScreen(player.x, player.y);
    const bobY = player.moving ? Math.sin(player.bob) * 3 : Math.sin(player.bob * 0.3) * 1;
    ctx.save();
    ctx.translate(s.x, s.y + bobY);
    const flip = player.facing.x < 0 ? -1 : 1;
    ctx.scale(flip, 1);
    if (player.invuln > 0 && Math.floor(player.invuln * 20) % 2 === 0) ctx.globalAlpha = 0.35;
    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath(); ctx.ellipse(0, 20, 15, 6, 0, 0, Math.PI * 2); ctx.fill();
    // coat
    ctx.fillStyle = "#232a3d";
    ctx.beginPath();
    ctx.moveTo(-12, 20);
    ctx.lineTo(-14, -3);
    ctx.quadraticCurveTo(0, -13, 14, -3);
    ctx.lineTo(12, 20);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#161b29"; ctx.lineWidth = 1.5; ctx.stroke();
    // head
    ctx.fillStyle = "#e8c39e";
    ctx.beginPath(); ctx.arc(0, -19, 9, 0, Math.PI * 2); ctx.fill();
    // whip handle
    ctx.strokeStyle = "#7a4a1e"; ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(10, 4); ctx.lineTo(21, 11); ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // Enemies
  // ---------------------------------------------------------------------
  // Balance note: contact damage only ever ticks once per player.invuln
  // window (see handleContactDamage below) regardless of how many enemies
  // are touching the player, so a fully idle/stationary player's time-to-
  // death is essentially travel-time-to-first-contact + maxHp / (dmg /
  // invuln). The original dmg values (10/8/20) killed an idle player in
  // ~16s, well under the intended "not within ~30s" floor — tuned down
  // here; this barely affects a moving/kiting player, since they take
  // contact hits far less often to begin with.
  const ENEMY_TYPES = {
    normal: { hp: 20, speed: 70, r: 26, dmg: 6, xp: 1 },
    flitzer: { hp: 10, speed: 130, r: 18, dmg: 5, xp: 1 },
    brocken: { hp: 90, speed: 40, r: 44, dmg: 13, xp: 5, tint: true },
  };
  const MAX_ENEMIES = 250;
  const enemies = [];
  MG.enemies = enemies;
  let spawnTimer = 1;

  function spawnInterval() {
    return Math.max(0.25, 1.2 - gameTime * 0.004);
  }
  function pickEnemyType() {
    const t = gameTime;
    const r = Math.random();
    if (t < 45) return "normal";
    if (t < 90) return r < 0.7 ? "normal" : "flitzer";
    if (r < 0.5) return "normal";
    if (r < 0.8) return "flitzer";
    return "brocken";
  }
  function spawnEnemy(type) {
    const t = ENEMY_TYPES[type];
    const hpMul = 1 + 0.1 * (gameTime / 60);
    const margin = 80;
    const halfW = W / 2 + margin, halfH = H / 2 + margin;
    const edge = Math.floor(Math.random() * 4);
    let ex, ey;
    if (edge === 0) { ex = camera.x + (Math.random() * 2 - 1) * halfW; ey = camera.y - halfH; }
    else if (edge === 1) { ex = camera.x + (Math.random() * 2 - 1) * halfW; ey = camera.y + halfH; }
    else if (edge === 2) { ex = camera.x - halfW; ey = camera.y + (Math.random() * 2 - 1) * halfH; }
    else { ex = camera.x + halfW; ey = camera.y + (Math.random() * 2 - 1) * halfH; }
    enemies.push({
      type, x: ex, y: ey,
      hp: t.hp * hpMul, maxHp: t.hp * hpMul,
      speed: t.speed, r: t.r, contactDmg: t.dmg, xp: t.xp,
      angle: Math.random() * Math.PI * 2,
      hitFlash: 0, knockX: 0, knockY: 0, dead: false,
      tint: !!t.tint,
      // Slow-effect hook (used by e.g. Frostpeitsche): while gameTime <
      // slowUntil, movement speed is multiplied by slowFactor.
      slowUntil: 0, slowFactor: 1,
    });
  }

  function separationPass() {
    const cellSize = 100;
    const grid = new Map();
    const key = (cx, cy) => cx + "," + cy;
    for (const e of enemies) {
      const cx = Math.floor(e.x / cellSize), cy = Math.floor(e.y / cellSize);
      const k = key(cx, cy);
      let b = grid.get(k);
      if (!b) { b = []; grid.set(k, b); }
      b.push(e);
    }
    for (const e of enemies) {
      const cx = Math.floor(e.x / cellSize), cy = Math.floor(e.y / cellSize);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = grid.get(key(cx + ox, cy + oy));
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === e) continue;
            const dx = e.x - other.x, dy = e.y - other.y;
            const dist = Math.hypot(dx, dy);
            const minDist = e.r + other.r - 6;
            if (dist > 0 && dist < minDist) {
              const push = (minDist - dist) * 0.5;
              e.x += (dx / dist) * push * 0.5;
              e.y += (dy / dist) * push * 0.5;
            }
          }
        }
      }
    }
  }

  function updateEnemies(dt) {
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.dead) { enemies.splice(i, 1); continue; }
      const dx = player.x - e.x, dy = player.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const slowMul = gameTime < e.slowUntil ? e.slowFactor : 1;
      let vx = (dx / d) * e.speed * slowMul, vy = (dy / d) * e.speed * slowMul;
      vx += e.knockX; vy += e.knockY;
      const decay = Math.max(0, 1 - dt * 6);
      e.knockX *= decay; e.knockY *= decay;
      e.x += vx * dt; e.y += vy * dt;
      e.angle += (1.5 + e.speed * 0.015) * dt;
      if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
    }
    separationPass();
  }

  function drawEnemy(e) {
    const s = worldToScreen(e.x, e.y);
    if (s.x < -100 || s.x > W + 100 || s.y < -100 || s.y > H + 100) return;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(e.angle);
    const d = e.r * 2;
    if (imgReady) {
      const slowed = gameTime < e.slowUntil;
      if (slowed) ctx.filter = "brightness(1.05) sepia(1) saturate(4) hue-rotate(150deg)";
      else if (e.tint) ctx.filter = "brightness(0.8) sepia(1) saturate(5) hue-rotate(-45deg)";
      ctx.drawImage(markusImg, -e.r, -e.r, d, d);
      ctx.filter = "none";
      if (e.hitFlash > 0) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = e.hitFlash * 0.7;
        ctx.drawImage(markusImg, -e.r, -e.r, d, d);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
    } else {
      ctx.fillStyle = e.tint ? "#a05050" : "#cc9977";
      ctx.beginPath(); ctx.arc(0, 0, e.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // Damage / hit resolution — the core weapon-facing API
  // ---------------------------------------------------------------------
  let killCount = 0;
  function hitEnemy(enemy, dmg, opts) {
    opts = opts || {};
    if (!enemy || enemy.dead) return;
    enemy.hp -= dmg;
    enemy.hitFlash = 1;
    const fx = opts.fromX !== undefined ? opts.fromX : player.x;
    const fy = opts.fromY !== undefined ? opts.fromY : player.y;
    const dx = enemy.x - fx, dy = enemy.y - fy;
    const d = Math.hypot(dx, dy) || 1;
    const kb = opts.knockback !== undefined ? opts.knockback : 140;
    enemy.knockX = (dx / d) * kb;
    enemy.knockY = (dy / d) * kb;
    spawnDamageNumber(enemy.x, enemy.y - enemy.r, dmg);
    if (enemy.hp <= 0 && !enemy.dead) {
      enemy.dead = true;
      addParticles(enemy.x, enemy.y, "#ff8a8a", 16);
      spawnGem(enemy.x, enemy.y, enemy.xp);
      killCount++;
    }
  }
  MG.hitEnemy = hitEnemy;

  function enemiesInRadius(x, y, r) {
    const out = [];
    for (const e of enemies) {
      if (e.dead) continue;
      if (Math.hypot(e.x - x, e.y - y) <= r + e.r) out.push(e);
    }
    return out;
  }
  MG.enemiesInRadius = enemiesInRadius;

  function nearestEnemy(x, y, maxDist) {
    let best = null;
    let bestD = maxDist === undefined ? Infinity : maxDist;
    for (const e of enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d <= bestD) { bestD = d; best = e; }
    }
    return best;
  }
  MG.nearestEnemy = nearestEnemy;

  // ---------------------------------------------------------------------
  // Particles & floating damage numbers
  // ---------------------------------------------------------------------
  const MAX_PARTICLES = 300;
  const MAX_DMG_NUMBERS = 80;
  const particles = [];
  const damageNumbers = [];

  function addParticles(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      if (particles.length >= MAX_PARTICLES) break;
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 160;
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color, size: 2 + Math.random() * 3 });
    }
  }
  MG.addParticles = addParticles;

  function spawnDamageNumber(x, y, dmg) {
    if (damageNumbers.length >= MAX_DMG_NUMBERS) damageNumbers.shift();
    damageNumbers.push({ x, y, text: Math.round(dmg).toString(), life: 1 });
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const damp = Math.max(0, 1 - dt * 2);
      p.vx *= damp; p.vy *= damp;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.life -= dt * 1.8;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }
  function updateDamageNumbers(dt) {
    for (let i = damageNumbers.length - 1; i >= 0; i--) {
      const dn = damageNumbers[i];
      dn.y -= 40 * dt;
      dn.life -= dt * 1.2;
      if (dn.life <= 0) damageNumbers.splice(i, 1);
    }
  }
  function drawParticles() {
    for (const p of particles) {
      const s = worldToScreen(p.x, p.y);
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(s.x, s.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function drawDamageNumbers() {
    ctx.font = "bold 13px 'Trebuchet MS', sans-serif";
    ctx.textAlign = "center";
    for (const dn of damageNumbers) {
      const s = worldToScreen(dn.x, dn.y);
      ctx.globalAlpha = Math.max(0, dn.life);
      ctx.fillStyle = "#fff2a8";
      ctx.fillText(dn.text, s.x, s.y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------
  // XP gems
  // ---------------------------------------------------------------------
  const gems = [];
  function spawnGem(x, y, value) {
    gems.push({ x, y, value, r: value >= 5 ? 7 : 5 });
  }
  function updateGems(dt) {
    for (let i = gems.length - 1; i >= 0; i--) {
      const g = gems[i];
      const dx = player.x - g.x, dy = player.y - g.y;
      const d = Math.hypot(dx, dy);
      if (d < player.stats.pickupRadius) {
        const speed = Math.max(260, (player.stats.pickupRadius - d) * 6);
        const nd = d || 1;
        g.x += (dx / nd) * speed * dt;
        g.y += (dy / nd) * speed * dt;
      }
      if (d < 16) {
        gems.splice(i, 1);
        addXP(g.value);
        MG.sfx.pickup();
        addParticles(g.x, g.y, g.value >= 5 ? "#ffd54a" : "#7ee0ff", 5);
      }
    }
  }
  function drawGems() {
    const t = performance.now() / 300;
    for (const g of gems) {
      const s = worldToScreen(g.x, g.y);
      if (s.x < -30 || s.x > W + 30 || s.y < -30 || s.y > H + 30) continue;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(Math.PI / 4);
      const glow = 0.6 + 0.4 * Math.sin(t + g.x);
      ctx.fillStyle = g.value >= 5 ? "#ffd54a" : "#7ee0ff";
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 8 * glow;
      ctx.fillRect(-g.r, -g.r, g.r * 2, g.r * 2);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------
  // XP / leveling
  // ---------------------------------------------------------------------
  function xpNeeded(lv) { return Math.round(5 * Math.pow(lv, 1.35)); }
  let level = 1, xp = 0, xpToNext = xpNeeded(1);
  let levelUpQueue = 0;
  let currentLevelUpOptions = [];

  function addXP(n) {
    xp += n;
    while (xp >= xpToNext) {
      xp -= xpToNext;
      level++;
      xpToNext = xpNeeded(level);
      levelUpQueue++;
    }
    if (levelUpQueue > 0 && state === "playing") triggerLevelUp();
  }

  function triggerLevelUp() {
    state = "levelup";
    showLevelUpOverlay();
  }
  function showLevelUpOverlay() {
    currentLevelUpOptions = MG.weapons.getLevelUpOptions(3);
    cardRowEl.innerHTML = "";
    currentLevelUpOptions.forEach((opt, idx) => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        '<div class="icon">' + opt.icon + '</div>' +
        '<div class="name">' + opt.name + '</div>' +
        '<div class="desc">' + opt.desc + '</div>';
      card.addEventListener("click", () => pickCard(idx));
      cardRowEl.appendChild(card);
    });
    levelupOverlay.classList.remove("hidden");
  }
  // Guards against a rapid double-click (or double keypress) silently
  // applying two picks in one gesture: when multiple level-ups are queued,
  // picking one re-renders a fresh card set at the same screen position, so
  // a second click that lands microseconds later would otherwise land on
  // (and apply) the new card underneath it. A short debounce blocks that
  // without getting in the way of deliberate, separately-read picks.
  let lastPickAt = -Infinity;
  const PICK_DEBOUNCE_MS = 300;
  function pickCard(idx) {
    if (state !== "levelup") return;
    const now = performance.now();
    if (now - lastPickAt < PICK_DEBOUNCE_MS) return;
    lastPickAt = now;
    const opt = currentLevelUpOptions[idx];
    if (!opt) return;
    opt.apply();
    MG.sfx.levelup();
    levelUpQueue = Math.max(0, levelUpQueue - 1);
    if (levelUpQueue > 0) {
      showLevelUpOverlay();
    } else {
      levelupOverlay.classList.add("hidden");
      state = "playing";
    }
  }

  // ---------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------
  const xpBarFill = document.getElementById("xpBarFill");
  const levelLabel = document.getElementById("levelLabel");
  const timerEl = document.getElementById("timer");
  const hpBarFill = document.getElementById("hpBarFill");
  const hpLabel = document.getElementById("hpLabel");
  const killCounterEl = document.getElementById("killCounter");
  const weaponRowEl = document.getElementById("weaponRow");
  const cardRowEl = document.getElementById("cardRow");

  let lastWeaponSig = "";
  function updateHUD() {
    const pct = Math.max(0, Math.min(100, (xp / xpToNext) * 100));
    xpBarFill.style.width = pct + "%";
    levelLabel.textContent = "Lv " + level;
    const mm = String(Math.floor(gameTime / 60)).padStart(2, "0");
    const ss = String(Math.floor(gameTime % 60)).padStart(2, "0");
    timerEl.textContent = mm + ":" + ss;
    const hpPct = Math.max(0, Math.min(100, (player.hp / player.stats.maxHp) * 100));
    hpBarFill.style.width = hpPct + "%";
    hpLabel.textContent = "HP " + Math.max(0, Math.round(player.hp)) + "/" + player.stats.maxHp;
    killCounterEl.textContent = "☠ " + killCount;

    const sig = MG.weapons.owned.map((w) => w.def.id + w.level).join(",");
    if (sig !== lastWeaponSig) {
      lastWeaponSig = sig;
      weaponRowEl.innerHTML = "";
      for (const w of MG.weapons.owned) {
        const div = document.createElement("div");
        div.className = "weapon-icon";
        div.innerHTML = w.def.icon + '<span class="lvl">' + w.level + "</span>";
        weaponRowEl.appendChild(div);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Joystick draw
  // ---------------------------------------------------------------------
  function drawJoystick() {
    const rect = canvas.getBoundingClientRect();
    const bx = joystick.baseX - rect.left, by = joystick.baseY - rect.top;
    const cx = joystick.curX - rect.left, cy = joystick.curY - rect.top;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = "#ffd54a"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(bx, by, JOY_R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(255,213,74,0.35)";
    ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // State machine + main loop
  // ---------------------------------------------------------------------
  let state = "start"; // start | playing | levelup | paused | gameover
  let gameTime = 0;
  let lastT = 0;

  const startOverlay = document.getElementById("startOverlay");
  const gameoverOverlay = document.getElementById("gameoverOverlay");
  const levelupOverlay = document.getElementById("levelupOverlay");
  const pauseOverlay = document.getElementById("pauseOverlay");
  const goStatsEl = document.getElementById("goStats");
  const goBestEl = document.getElementById("goBest");

  function formatTime(t) {
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(Math.floor(t % 60)).padStart(2, "0");
    return mm + ":" + ss;
  }
  function getBest() { try { return +localStorage.getItem("markus_surv_best") || 0; } catch (e) { return 0; } }
  function setBest(v) { try { localStorage.setItem("markus_surv_best", v); } catch (e) { } }

  function resetGame() {
    player.x = 0; player.y = 0;
    player.stats.speed = 220; player.stats.maxHp = 100; player.stats.regen = 0; player.stats.pickupRadius = 90;
    player.hp = player.stats.maxHp;
    player.invuln = 0; player.facing.x = 1; player.facing.y = 0; player.bob = 0;
    enemies.length = 0; gems.length = 0; particles.length = 0; damageNumbers.length = 0;
    level = 1; xp = 0; xpToNext = xpNeeded(1); levelUpQueue = 0;
    killCount = 0; gameTime = 0; spawnTimer = 1;
    camera.x = 0; camera.y = 0;
    joystick.active = false;

    MG.weapons.owned.length = 0;
    const startDef = MG.weapons.registry.find((w) => w.id === "klassisch");
    if (startDef) MG.weapons.owned.push(startDef.create(MG));
    lastWeaponSig = "";
    updateHUD();
  }

  function startGame() {
    ensureAudio();
    resetGame();
    state = "playing";
    startOverlay.classList.add("hidden");
    gameoverOverlay.classList.add("hidden");
    levelupOverlay.classList.add("hidden");
    pauseOverlay.classList.add("hidden");
  }
  function gameOver() {
    state = "gameover";
    MG.sfx.gameover();
    const best = getBest();
    if (gameTime > best) setBest(gameTime);
    goStatsEl.textContent = "Überlebt: " + formatTime(gameTime) + "  •  Level " + level + "  •  Kills " + killCount;
    goBestEl.textContent = "Beste Zeit: " + formatTime(Math.max(gameTime, best));
    gameoverOverlay.classList.remove("hidden");
  }
  function pauseGame() {
    if (state !== "playing") return;
    state = "paused";
    pauseOverlay.classList.remove("hidden");
  }
  function resumeGame() {
    if (state !== "paused") return;
    state = "playing";
    pauseOverlay.classList.add("hidden");
  }

  document.getElementById("startBtn").addEventListener("click", startGame);
  document.getElementById("retryBtn").addEventListener("click", startGame);
  pauseOverlay.addEventListener("click", resumeGame);

  window.addEventListener("keydown", (e) => {
    ensureAudio();
    if (state === "paused") { resumeGame(); return; }
    if (state === "start" && (e.code === "Enter" || e.code === "Space")) { e.preventDefault(); startGame(); return; }
    if (state === "gameover" && (e.code === "Enter" || e.code === "Space")) { e.preventDefault(); startGame(); return; }
    if (state === "levelup") {
      if (e.code === "Digit1" || e.code === "Numpad1") pickCard(0);
      if (e.code === "Digit2" || e.code === "Numpad2") pickCard(1);
      if (e.code === "Digit3" || e.code === "Numpad3") pickCard(2);
      return;
    }
    if (state === "playing" && e.code === "Escape") { pauseGame(); return; }
    keys.add(e.code);
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));

  function update(dt) {
    if (state !== "playing") return;
    gameTime += dt;
    MG.time = gameTime;

    updatePlayer(dt);
    handleContactDamage();
    // Defensive net: contact damage is currently the only way HP drops, and
    // it already calls gameOver() itself. This guard just makes sure the
    // state machine can never get stuck "playing" at 0 HP if a future
    // damage source (regen underflow, a new hazard, etc.) skips that path.
    if (state === "playing" && player.hp <= 0) { player.hp = 0; gameOver(); return; }

    spawnTimer -= dt;
    if (spawnTimer <= 0 && enemies.length < MAX_ENEMIES) {
      spawnEnemy(pickEnemyType());
      spawnTimer = spawnInterval();
    }
    updateEnemies(dt);
    updateGems(dt);

    for (const w of MG.weapons.owned) w.update(dt, MG);

    updateParticles(dt);
    updateDamageNumbers(dt);

    camera.x = player.x; camera.y = player.y;
    updateHUD();
  }

  function render() {
    drawBackground();
    drawGems();
    for (const e of enemies) drawEnemy(e);
    for (const w of MG.weapons.owned) w.draw(ctx, MG);
    drawPlayer();
    drawParticles();
    drawDamageNumbers();
    if (joystick.active) drawJoystick();
  }

  function frame(t) {
    if (!lastT) lastT = t;
    let dt = (t - lastT) / 1000;
    lastT = t;
    if (dt > 0.05) dt = 0.05;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------------
  // QA / debug hook
  // ---------------------------------------------------------------------
  window.__game = {
    get state() { return state; },
    get player() { return player; },
    get enemies() { return enemies; },
    weapons: MG.weapons,
    gainXP(n) { addXP(n); },
    get time() { return gameTime; },
  };
})();
