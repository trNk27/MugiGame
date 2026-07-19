// ============================================================================
// Peitsch den Markus: Survivors — 3D CORE ENGINE (three.js, r144, global THREE)
// ----------------------------------------------------------------------------
// Owns: renderer/scene/camera, player, enemies, xp/gems, particles, HUD, sfx,
// the game-state machine, and the main loop. Weapons live in js/weapons.js
// and are driven through the small API documented at the top of that file.
//
// Everything is exposed on the shared global namespace `window.MG` so plain
// <script> tags (no modules) can share state and work under file://.
//
// ---------------------------------------------------------------------------
// COORDINATE SYSTEM
// All gameplay logic lives on the ground plane in XZ (2D x -> x, 2D y -> z).
// Entities carry a small `y` purely for visual placement (bob height, sprite
// billboards, etc.) — collision/hitboxes/AI never read `y`. World "forward /
// up-screen" (W key) is -Z; the camera never rotates.
//
// WORLD_SCALE
// The original 2D game tuned everything in CSS-pixel units (speeds, radii,
// ranges, knockback...). To keep every one of those tuning numbers valid we
// simply convert px -> world units by a single constant, applied at the
// point each px value is turned into a live stat:
//   40 px (2D) == 1 world unit (3D)
// See `MG.WORLD_SCALE` / `MG.px()` below. Pure ratios/multipliers (e.g. the
// "×6" in the gem-magnet speed formula) are NOT distances and are left
// unscaled — only additive lengths/speeds get the conversion.
// ============================================================================
(function () {
  "use strict";

  const MG = (window.MG = window.MG || {});
  // Weapon framework storage lives here so weapons.js (loaded after this
  // file) can push into the registry as soon as it runs.
  MG.weapons = MG.weapons || { registry: [], owned: [] };

  // 40 px (2D) == 1 world unit (3D). Documented once, used everywhere.
  const WORLD_SCALE = 1 / 40;
  MG.WORLD_SCALE = WORLD_SCALE;
  MG.px = function (n) { return n * WORLD_SCALE; }; // convert a 2D px tuning value -> world units
  const FX_Y = 0.05; // small lift above ground for effect meshes, avoids z-fighting
  MG.FX_Y = FX_Y;

  // ---------------------------------------------------------------------
  // Renderer / scene / camera
  // ---------------------------------------------------------------------
  const canvas = document.getElementById("c");
  const wrap = document.getElementById("game-wrap");

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  MG.renderer = renderer; // exposed for QA (renderer.info.memory.*)

  const scene = new THREE.Scene();
  MG.scene = scene;
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.Fog(0x0b0f1a, 14, 46);

  // fxRoot: weapons add their own three.js visual-effect objects here.
  // Cleared (all children removed + geometries/materials disposed, except
  // any geometry/material flagged `.shared = true` which weapons re-use
  // across instances) on every resetGame(). See js/weapons.js header.
  const fxRoot = new THREE.Group();
  scene.add(fxRoot);
  MG.fxRoot = fxRoot;

  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 120);
  const CAM_OFFSET = new THREE.Vector3(0, 13, 11);
  const CAM_LOOK_Y = 1.1;
  const CAM_LERP_RATE = 8; // ~8/s smoothing

  function resize() {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    camera.aspect = W / Math.max(1, H);
    camera.updateProjectionMatrix();
    viewRadiusDirty = true;
  }
  window.addEventListener("resize", resize);

  // ---------------------------------------------------------------------
  // Lighting
  // ---------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0x8fa8ff, 0x11121a, 0.9);
  scene.add(hemi);
  const dirLight = new THREE.DirectionalLight(0xfff2d6, 1.05);
  dirLight.position.set(-6, 10, 4);
  scene.add(dirLight);
  const ambient = new THREE.AmbientLight(0x223047, 0.35);
  scene.add(ambient);

  // ---------------------------------------------------------------------
  // Ground — procedural CanvasTexture, RepeatWrapping, offset scrolls with
  // the player so the pattern stays fixed in world space (infinite feel)
  // while a single large plane always sits centered under the player.
  // ---------------------------------------------------------------------
  const TILE_WORLD = MG.px(80); // one texture tile == 80 old-2D px == 2 world units
  const GROUND_SIZE = 90; // world units; plane always re-centers on the player

  function buildGroundTexture() {
    const cnv = document.createElement("canvas");
    cnv.width = 256; cnv.height = 256;
    const g = cnv.getContext("2d");
    g.fillStyle = "#141b2e";
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = "rgba(255,255,255,0.06)";
    g.lineWidth = 2;
    g.strokeRect(1, 1, 254, 254);
    // sparse deterministic dots
    let seed = 7;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    g.fillStyle = "rgba(255,255,255,0.07)";
    for (let i = 0; i < 10; i++) {
      const x = rnd() * 256, y = rnd() * 256, s = 1.2 + rnd() * 1.6;
      g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
    }
    const tex = new THREE.CanvasTexture(cnv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(GROUND_SIZE / TILE_WORLD, GROUND_SIZE / TILE_WORLD);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }
  const groundTex = buildGroundTexture();
  const groundGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = new THREE.MeshLambertMaterial({ map: groundTex });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  scene.add(groundMesh);

  function updateGround() {
    groundMesh.position.set(player.x, 0, player.z);
    groundTex.offset.set(player.x / TILE_WORLD, player.z / TILE_WORLD);
  }

  // ---------------------------------------------------------------------
  // Scatter decoration (rocks/trees) — deterministic grid hash, purely
  // cosmetic (no collision). Repositioned via two InstancedMeshes whenever
  // the player crosses into a new scatter cell.
  // ---------------------------------------------------------------------
  function hash2(a, b) {
    let x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  const SCATTER_CELL = 5.5;
  const SCATTER_RADIUS_CELLS = 7;
  const MAX_ROCKS = 40, MAX_TREES = 24;
  const rockGeo = new THREE.BoxGeometry(1, 1, 1);
  const treeGeo = new THREE.ConeGeometry(0.45, 1.3, 6);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x2a3350, roughness: 0.9 });
  const treeMat = new THREE.MeshStandardMaterial({ color: 0x342a55, roughness: 0.85 });
  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, MAX_ROCKS);
  const treeMesh = new THREE.InstancedMesh(treeGeo, treeMat, MAX_TREES);
  rockMesh.count = 0; treeMesh.count = 0;
  scene.add(rockMesh, treeMesh);
  const _m4 = new THREE.Matrix4();
  const _quat = new THREE.Quaternion();
  const _scaleV = new THREE.Vector3(1, 1, 1);
  let lastScatterCX = null, lastScatterCZ = null;

  function refreshScatter() {
    const cx = Math.floor(player.x / SCATTER_CELL);
    const cz = Math.floor(player.z / SCATTER_CELL);
    if (cx === lastScatterCX && cz === lastScatterCZ) return;
    lastScatterCX = cx; lastScatterCZ = cz;
    let rockN = 0, treeN = 0;
    for (let dx = -SCATTER_RADIUS_CELLS; dx <= SCATTER_RADIUS_CELLS && (rockN < MAX_ROCKS || treeN < MAX_TREES); dx++) {
      for (let dz = -SCATTER_RADIUS_CELLS; dz <= SCATTER_RADIUS_CELLS; dz++) {
        const gx = cx + dx, gz = cz + dz;
        const h = hash2(gx, gz);
        if (h > 0.22) continue; // sparse
        const isTree = hash2(gx + 91.7, gz - 13.3) > 0.5;
        const jx = (hash2(gx + 3.1, gz) - 0.5) * SCATTER_CELL * 0.7;
        const jz = (hash2(gx, gz + 3.1) - 0.5) * SCATTER_CELL * 0.7;
        const wx = (gx + 0.5) * SCATTER_CELL + jx;
        const wz = (gz + 0.5) * SCATTER_CELL + jz;
        const distToPlayer = Math.hypot(wx - player.x, wz - player.z);
        if (distToPlayer < 2.5) continue; // keep a small deadzone clear right around the player
        if (isTree) {
          if (treeN >= MAX_TREES) continue;
          const s = 0.6 + hash2(gx, gz + 55) * 0.55;
          const yMul = 0.9 + hash2(gx + 1, gz) * 0.3;
          _scaleV.set(s, s * yMul, s);
          _quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(gx, gz + 200) * Math.PI * 2);
          _m4.compose(new THREE.Vector3(wx, (1.3 * _scaleV.y) / 2, wz), _quat, _scaleV);
          treeMesh.setMatrixAt(treeN++, _m4);
        } else {
          if (rockN >= MAX_ROCKS) continue;
          const s = 0.35 + hash2(gx + 2, gz) * 0.55;
          _scaleV.set(s, s, s);
          _quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(gx, gz + 400) * Math.PI * 2);
          _m4.compose(new THREE.Vector3(wx, s / 2, wz), _quat, _scaleV);
          rockMesh.setMatrixAt(rockN++, _m4);
        }
      }
    }
    rockMesh.count = rockN; treeMesh.count = treeN;
    rockMesh.instanceMatrix.needsUpdate = true;
    treeMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------
  // Assets — markus.png is a JPEG-ish cutout on a near-black background
  // (no real alpha channel). Chroma-key the black away once at load (same
  // routine as the 2D game) so it draws as a clean transparent cutout.
  // ---------------------------------------------------------------------
  let markusTexture = null;
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
      markusTexture = new THREE.CanvasTexture(off);
    } catch (e) {
      // Cross-origin / file:// canvas read can fail in some browsers;
      // fall back to the raw (un-keyed) image texture.
      markusTexture = new THREE.Texture(markusRaw);
      markusTexture.needsUpdate = true;
    }
    markusTexture.colorSpace = THREE.SRGBColorSpace || markusTexture.colorSpace;
    markusTexture.needsUpdate = true;
    imgReady = true;
    baseEnemySpriteMat = new THREE.SpriteMaterial({ map: markusTexture, transparent: true, depthWrite: false });
  };
  markusRaw.src = "assets/markus.png";
  let baseEnemySpriteMat = new THREE.SpriteMaterial({ color: 0xcc9977, transparent: true }); // placeholder until image loads

  // ---------------------------------------------------------------------
  // Audio (WebAudio only, synthesized, no files) — unchanged from the 2D
  // game (purely time-domain synthesis, no positions involved).
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
  // Input: keyboard + a simple drag-anywhere virtual joystick for touch.
  // Mapping is identical to the 2D game: dx -> world x, dy(screen "up" is
  // negative) -> world z, i.e. W/up-drag moves -z ("up the screen").
  // ---------------------------------------------------------------------
  const keys = new Set();
  const joystick = { active: false, id: null, baseX: 0, baseY: 0, curX: 0, curY: 0, dx: 0, dy: 0 };
  const JOY_R = 50;
  const joyBaseEl = document.getElementById("joyBase");
  const joyStickEl = document.getElementById("joyStick");

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
    let dx = 0, dz = 0;
    if (joystick.active) {
      dx = joystick.dx; dz = joystick.dy;
    } else {
      if (keys.has("KeyW") || keys.has("ArrowUp")) dz -= 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) dz += 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) dx -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) dx += 1;
    }
    const len = Math.hypot(dx, dz);
    const mag = Math.min(1, len);
    let nx = 0, nz = 0;
    if (len > 0.001) { nx = dx / len; nz = dz / len; }
    return { dirX: nx, dirZ: nz, mag };
  }

  // ---------------------------------------------------------------------
  // Player
  // ---------------------------------------------------------------------
  const player = {
    x: 0, z: 0, r: MG.px(22),
    hp: 100,
    stats: { speed: MG.px(220), maxHp: 130, regen: 0, pickupRadius: MG.px(90) },
    facing: { x: 1, z: 0 },
    invuln: 0,
    bob: 0,
    moving: false,
  };
  MG.player = player;

  // --- player mesh ---
  const playerGroup = new THREE.Group();
  const bodyGroup = new THREE.Group();
  playerGroup.add(bodyGroup);
  const coatMat = new THREE.MeshStandardMaterial({ color: 0x232a3d, roughness: 0.8 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xe8c39e, roughness: 0.7 });
  const handleMat = new THREE.MeshStandardMaterial({ color: 0x7a4a1e, roughness: 0.6 });
  const bodyGeo = new THREE.CapsuleGeometry(0.32, 0.62, 4, 8);
  const bodyMesh = new THREE.Mesh(bodyGeo, coatMat);
  bodyMesh.position.y = 0.32 + 0.31;
  bodyGroup.add(bodyMesh);
  const headGeo = new THREE.SphereGeometry(0.22, 12, 10);
  const headMesh = new THREE.Mesh(headGeo, skinMat);
  headMesh.position.y = 0.32 * 2 + 0.62 + 0.15;
  bodyGroup.add(headMesh);
  const handleGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6);
  const handleMesh = new THREE.Mesh(handleGeo, handleMat);
  handleMesh.position.set(0.3, 0.85, 0.05);
  handleMesh.rotation.z = Math.PI / 2.6;
  bodyGroup.add(handleMesh);
  const shadowGeo = new THREE.CircleGeometry(0.42, 16);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
  const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
  shadowMesh.position.y = 0.01;
  playerGroup.add(shadowMesh);
  scene.add(playerGroup);
  const playerMats = [coatMat, skinMat, handleMat];

  let playerYaw = 0;
  function updatePlayer(dt) {
    const mv = moveVector();
    player.moving = mv.mag > 0.05;
    if (player.moving) {
      player.facing.x = mv.dirX;
      player.facing.z = mv.dirZ;
    }
    player.x += mv.dirX * mv.mag * player.stats.speed * dt;
    player.z += mv.dirZ * mv.mag * player.stats.speed * dt;
    player.bob += dt * (player.moving ? 9 : 2);
    if (player.stats.regen > 0) player.hp = Math.min(player.stats.maxHp, player.hp + player.stats.regen * dt);
    if (player.invuln > 0) player.invuln = Math.max(0, player.invuln - dt);

    // visuals
    const targetYaw = Math.atan2(player.facing.x, player.facing.z);
    let dYaw = targetYaw - playerYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    playerYaw += dYaw * Math.min(1, dt * 10);
    playerGroup.position.set(player.x, 0, player.z);
    playerGroup.rotation.y = playerYaw;
    const bobY = player.moving ? Math.sin(player.bob) * 0.05 : Math.sin(player.bob * 0.3) * 0.015;
    bodyGroup.position.y = bobY;
    const targetLean = player.moving ? -0.13 : 0;
    bodyGroup.rotation.x += (targetLean - bodyGroup.rotation.x) * Math.min(1, dt * 8);
    const blink = player.invuln > 0 && Math.floor(player.invuln * 20) % 2 === 0;
    for (const m of playerMats) {
      m.transparent = blink;
      m.opacity = blink ? 0.35 : 1;
    }
  }

  function handleContactDamage() {
    if (player.invuln > 0) return;
    for (const e of enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - player.x, e.z - player.z);
      if (d < e.r + player.r) {
        player.hp -= e.contactDmg;
        player.invuln = 1.3;
        MG.sfx.hurt();
        addParticles(player.x, player.z, "#ff5c5c", 10);
        if (player.hp <= 0) { player.hp = 0; gameOver(); }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Camera — third-person chase cam, fixed offset, no rotation, smoothed.
  // ---------------------------------------------------------------------
  let cameraInited = false;
  function updateCamera(dt, snap) {
    const desired = new THREE.Vector3(player.x + CAM_OFFSET.x, CAM_OFFSET.y, player.z + CAM_OFFSET.z);
    if (snap || !cameraInited) {
      camera.position.copy(desired);
      cameraInited = true;
    } else {
      const t = 1 - Math.exp(-CAM_LERP_RATE * dt);
      camera.position.lerp(desired, t);
    }
    camera.lookAt(player.x, CAM_LOOK_Y, player.z);
  }

  // Visible-ground FOOTPRINT, used for edge-of-view enemy spawning. The
  // camera never rotates and keeps a fixed offset from the player, so this
  // footprint (a quadrilateral in player-local XZ space) is a constant,
  // recomputed only on resize / first use. A simple circular ring at "the"
  // visible radius doesn't work well here — the ground footprint of a
  // pitched-down camera is a strongly asymmetric trapezoid (near edge just
  // ~13 units out, far corners ~40+), so a uniform-radius ring is either
  // absurdly distant in most directions or on-screen in others. Instead we
  // ray-cast from the player toward each spawn angle and find exactly
  // where that ray exits the trapezoid, giving a snug, direction-aware
  // "just off screen" spawn distance.
  let viewRadiusDirty = true;
  let footprint = null; // [{x,z}, ...] 4 corners, local (relative to player), CCW/CW perimeter order
  const _vNear = new THREE.Vector3(), _vFar = new THREE.Vector3(), _vDir = new THREE.Vector3(), _vHit = new THREE.Vector3();
  function groundHitLocal(nx, ny) {
    _vNear.set(nx, ny, -1).unproject(camera);
    _vFar.set(nx, ny, 1).unproject(camera);
    _vDir.copy(_vFar).sub(_vNear);
    if (Math.abs(_vDir.y) < 1e-6) return null;
    const t = -_vNear.y / _vDir.y;
    if (t < 0) return null;
    _vHit.copy(_vNear).addScaledVector(_vDir, t);
    return { x: _vHit.x - player.x, z: _vHit.z - player.z };
  }
  function computeFootprint() {
    camera.updateMatrixWorld(true);
    // perimeter order: near-left, near-right, far-right, far-left
    const pts = [groundHitLocal(-1, -1), groundHitLocal(1, -1), groundHitLocal(1, 1), groundHitLocal(-1, 1)];
    if (pts.every((p) => p)) footprint = pts;
    viewRadiusDirty = false;
  }
  // Ray (from local origin, direction dx,dz) vs. segment (ax,az)-(bx,bz):
  // returns the ray parameter t (>=0) at the crossing, or null.
  function raySegT(dx, dz, ax, az, bx, bz) {
    const v1x = -ax, v1z = -az;
    const v2x = bx - ax, v2z = bz - az;
    const v3x = -dz, v3z = dx;
    const denom = v2x * v3x + v2z * v3z;
    if (Math.abs(denom) < 1e-9) return null;
    const t = (v2x * v1z - v2z * v1x) / denom;
    const s = (v1x * v3x + v1z * v3z) / denom;
    if (t >= 0 && s >= 0 && s <= 1) return t;
    return null;
  }
  const FALLBACK_SPAWN_R = MG.px(360);
  function spawnBoundaryDistance(theta) {
    if (!footprint) return FALLBACK_SPAWN_R;
    const dx = Math.cos(theta), dz = Math.sin(theta);
    let best = null;
    for (let i = 0; i < footprint.length; i++) {
      const a = footprint[i], b = footprint[(i + 1) % footprint.length];
      const t = raySegT(dx, dz, a.x, a.z, b.x, b.z);
      if (t !== null && (best === null || t < best)) best = t;
    }
    return best === null ? FALLBACK_SPAWN_R : best;
  }

  // ---------------------------------------------------------------------
  // Enemies
  // ---------------------------------------------------------------------
  // Balance note (ported verbatim from 2D): contact damage only ticks once
  // per player.invuln window regardless of how many enemies are touching
  // the player, so tuning stays governed by dmg / invuln, not enemy count.
  const ENEMY_TYPES = {
    normal: { hp: 20, speed: MG.px(70), r: MG.px(26), dmg: 6, xp: 1 },
    flitzer: { hp: 10, speed: MG.px(130), r: MG.px(18), dmg: 5, xp: 1 },
    brocken: { hp: 90, speed: MG.px(40), r: MG.px(44), dmg: 13, xp: 5, tint: true },
  };
  const TINT_COLOR = new THREE.Color(0xdd5c4a);
  const SLOW_COLOR = new THREE.Color(0x8fd7ff);
  const NORMAL_COLOR = new THREE.Color(0xffffff);
  const FLASH_COLOR = new THREE.Color(0xffffff);
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

  function makeEnemySprite() {
    const mat = baseEnemySpriteMat.clone();
    const spr = new THREE.Sprite(mat);
    scene.add(spr);
    return spr;
  }

  function spawnEnemy(type) {
    if (viewRadiusDirty) computeFootprint();
    const t = ENEMY_TYPES[type];
    // Ease-in: spawn at 70% HP, ramping to full over the first 90s so the
    // opening minute stays gentle; the +10%/min growth applies throughout.
    const earlyMul = Math.min(1, 0.7 + 0.3 * (gameTime / 90));
    const hpMul = earlyMul * (1 + 0.1 * (gameTime / 60));
    const a = Math.random() * Math.PI * 2;
    // Just outside the visible ground footprint in this exact direction
    // (see computeFootprint/spawnBoundaryDistance above), plus a flat
    // margin so pop-in is never visible even with camera-lerp slack.
    const ringR = spawnBoundaryDistance(a) * 1.15 + MG.px(60);
    const ex = player.x + Math.cos(a) * ringR;
    const ez = player.z + Math.sin(a) * ringR;
    const sprite = makeEnemySprite();
    const d = t.r * 2;
    sprite.scale.set(d, d, 1);
    sprite.position.set(ex, t.r, ez);
    enemies.push({
      type, x: ex, z: ez, y: t.r,
      hp: t.hp * hpMul, maxHp: t.hp * hpMul,
      speed: t.speed, r: t.r, contactDmg: t.dmg, xp: t.xp,
      wobble: Math.random() * Math.PI * 2,
      hitFlash: 0, knockX: 0, knockZ: 0, dead: false,
      tint: !!t.tint,
      // Slow-effect hook (used by e.g. Frostpeitsche): while gameTime <
      // slowUntil, movement speed is multiplied by slowFactor.
      slowUntil: 0, slowFactor: 1,
      sprite,
    });
  }

  // Reused across frames to avoid a fresh Map + N bucket-array allocations
  // every frame at up to MAX_ENEMIES concurrent enemies (bucket membership
  // itself must still be rebuilt each frame since enemies keep moving
  // between cells, but the Map and its bucket arrays are recycled).
  const sepGrid = new Map();
  const sepBucketPool = [];
  let sepBucketsUsed = 0;
  function separationPass() {
    const cellSize = MG.px(100);
    sepGrid.clear();
    sepBucketsUsed = 0;
    const key = (cx, cz) => cx + "," + cz;
    for (const e of enemies) {
      const cx = Math.floor(e.x / cellSize), cz = Math.floor(e.z / cellSize);
      const k = key(cx, cz);
      let b = sepGrid.get(k);
      if (!b) {
        b = sepBucketPool[sepBucketsUsed];
        if (!b) { b = []; sepBucketPool[sepBucketsUsed] = b; }
        b.length = 0;
        sepBucketsUsed++;
        sepGrid.set(k, b);
      }
      b.push(e);
    }
    for (const e of enemies) {
      const cx = Math.floor(e.x / cellSize), cz = Math.floor(e.z / cellSize);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = sepGrid.get(key(cx + ox, cz + oz));
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === e) continue;
            const dx = e.x - other.x, dz = e.z - other.z;
            const dist = Math.hypot(dx, dz);
            const minDist = e.r + other.r - MG.px(6);
            if (dist > 0 && dist < minDist) {
              const push = (minDist - dist) * 0.5;
              e.x += (dx / dist) * push * 0.5;
              e.z += (dz / dist) * push * 0.5;
            }
          }
        }
      }
    }
  }

  function disposeEnemy(e) {
    scene.remove(e.sprite);
    e.sprite.material.dispose();
  }

  function updateEnemies(dt) {
    const t = performance.now() / 1000;
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.dead) { disposeEnemy(e); enemies.splice(i, 1); continue; }
      const dx = player.x - e.x, dz = player.z - e.z;
      const d = Math.hypot(dx, dz) || 1;
      const slowMul = gameTime < e.slowUntil ? e.slowFactor : 1;
      let vx = (dx / d) * e.speed * slowMul, vz = (dz / d) * e.speed * slowMul;
      vx += e.knockX; vz += e.knockZ;
      const decay = Math.max(0, 1 - dt * 6);
      e.knockX *= decay; e.knockZ *= decay;
      e.x += vx * dt; e.z += vz * dt;
      e.wobble += (1.5 + e.speed * 0.6) * dt;
      if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
    }
    separationPass();
    for (const e of enemies) {
      const bob = Math.sin(e.wobble) * e.r * 0.12;
      e.sprite.position.set(e.x, e.r + bob, e.z);
      e.sprite.material.rotation = Math.sin(e.wobble * 0.7) * 0.18;
      const slowed = gameTime < e.slowUntil;
      const base = slowed ? SLOW_COLOR : (e.tint ? TINT_COLOR : NORMAL_COLOR);
      if (e.hitFlash > 0) {
        e.sprite.material.color.copy(base).lerp(FLASH_COLOR, e.hitFlash * 0.75);
      } else {
        e.sprite.material.color.copy(base);
      }
    }
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
    const fz = opts.fromZ !== undefined ? opts.fromZ : player.z;
    const dx = enemy.x - fx, dz = enemy.z - fz;
    const d = Math.hypot(dx, dz) || 1;
    const kb = opts.knockback !== undefined ? opts.knockback : MG.px(140);
    enemy.knockX = (dx / d) * kb;
    enemy.knockZ = (dz / d) * kb;
    spawnDamageNumber(enemy.x, enemy.r * 2 + 0.2, enemy.z, dmg);
    if (enemy.hp <= 0 && !enemy.dead) {
      enemy.dead = true;
      addParticles(enemy.x, enemy.z, "#ff8a8a", 16);
      spawnGem(enemy.x, enemy.z, enemy.xp);
      killCount++;
    }
  }
  MG.hitEnemy = hitEnemy;

  function enemiesInRadius(x, z, r) {
    const out = [];
    for (const e of enemies) {
      if (e.dead) continue;
      if (Math.hypot(e.x - x, e.z - z) <= r + e.r) out.push(e);
    }
    return out;
  }
  MG.enemiesInRadius = enemiesInRadius;

  function nearestEnemy(x, z, maxDist) {
    let best = null;
    let bestD = maxDist === undefined ? Infinity : maxDist;
    for (const e of enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d <= bestD) { bestD = d; best = e; }
    }
    return best;
  }
  MG.nearestEnemy = nearestEnemy;

  // ---------------------------------------------------------------------
  // Particles (pooled THREE.Points) & floating damage numbers (pooled
  // canvas-texture sprites).
  // ---------------------------------------------------------------------
  const MAX_PARTICLES = 300;
  const particlePool = [];
  const particlePos = new Float32Array(MAX_PARTICLES * 3);
  const particleCol = new Float32Array(MAX_PARTICLES * 3);
  for (let i = 0; i < MAX_PARTICLES; i++) {
    particlePool.push({ active: false, x: 0, y: 0.3, z: 0, vx: 0, vy: 0, vz: 0, life: 0, color: new THREE.Color() });
  }
  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute("position", new THREE.BufferAttribute(particlePos, 3));
  particleGeo.setAttribute("color", new THREE.BufferAttribute(particleCol, 3));
  const particleMat = new THREE.PointsMaterial({
    size: 0.14, vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const particlePoints = new THREE.Points(particleGeo, particleMat);
  scene.add(particlePoints);

  function addParticles(x, z, colorHex, n) {
    const c = new THREE.Color(colorHex);
    let spawned = 0;
    for (let i = 0; i < particlePool.length && spawned < n; i++) {
      const p = particlePool[i];
      if (p.active) continue;
      const a = Math.random() * Math.PI * 2;
      const sp = MG.px(40 + Math.random() * 160);
      p.active = true;
      p.x = x; p.y = 0.3; p.z = z;
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = MG.px(30 + Math.random() * 40);
      p.life = 1;
      p.color.copy(c);
      spawned++;
    }
  }
  MG.addParticles = addParticles;

  function updateParticles(dt) {
    for (let i = 0; i < particlePool.length; i++) {
      const p = particlePool[i];
      const base = i * 3;
      if (!p.active) {
        particleCol[base] = 0; particleCol[base + 1] = 0; particleCol[base + 2] = 0;
        continue;
      }
      const damp = Math.max(0, 1 - dt * 2);
      p.vx *= damp; p.vz *= damp; p.vy -= dt * 1.4;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.life -= dt * 1.8;
      if (p.life <= 0) { p.active = false; particleCol[base] = 0; particleCol[base + 1] = 0; particleCol[base + 2] = 0; continue; }
      particlePos[base] = p.x; particlePos[base + 1] = Math.max(0, p.y); particlePos[base + 2] = p.z;
      const l = Math.max(0, p.life);
      particleCol[base] = p.color.r * l; particleCol[base + 1] = p.color.g * l; particleCol[base + 2] = p.color.b * l;
    }
    particleGeo.attributes.position.needsUpdate = true;
    particleGeo.attributes.color.needsUpdate = true;
  }
  function resetParticles() {
    for (const p of particlePool) p.active = false;
    particleCol.fill(0);
    particleGeo.attributes.color.needsUpdate = true;
  }

  const MAX_DMG_NUMBERS = 80;
  const dmgPool = [];
  function initDamageNumberPool() {
    for (let i = 0; i < MAX_DMG_NUMBERS; i++) {
      const cnv = document.createElement("canvas");
      cnv.width = 64; cnv.height = 32;
      const c2 = cnv.getContext("2d");
      const tex = new THREE.CanvasTexture(cnv);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
      const spr = new THREE.Sprite(mat);
      spr.scale.set(0.9, 0.45, 1);
      spr.visible = false;
      scene.add(spr);
      dmgPool.push({ sprite: spr, canvas: cnv, ctx: c2, tex, active: false, life: 0, y: 0 });
    }
  }
  let dmgCursor = 0;
  function spawnDamageNumber(x, y, z, dmg) {
    const slot = dmgPool[dmgCursor];
    dmgCursor = (dmgCursor + 1) % dmgPool.length;
    slot.active = true; slot.life = 1; slot.y = y;
    const c = slot.ctx;
    c.clearRect(0, 0, 64, 32);
    c.font = "bold 20px 'Trebuchet MS', sans-serif";
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = "#fff2a8";
    c.fillText(Math.round(dmg).toString(), 32, 16);
    slot.tex.needsUpdate = true;
    slot.sprite.visible = true;
    slot.sprite.material.opacity = 1;
    slot.sprite.position.set(x, y, z);
  }
  function updateDamageNumbers(dt) {
    for (const slot of dmgPool) {
      if (!slot.active) continue;
      slot.y += MG.px(40) * dt;
      slot.life -= dt * 1.2;
      slot.sprite.position.y = slot.y;
      slot.sprite.material.opacity = Math.max(0, slot.life);
      if (slot.life <= 0) { slot.active = false; slot.sprite.visible = false; }
    }
  }
  function resetDamageNumbers() {
    for (const slot of dmgPool) { slot.active = false; slot.sprite.visible = false; }
    dmgCursor = 0;
  }

  // ---------------------------------------------------------------------
  // XP gems
  // ---------------------------------------------------------------------
  const gemGeo = new THREE.OctahedronGeometry(1, 0);
  const gemMatCyan = new THREE.MeshStandardMaterial({ color: 0x7ee0ff, emissive: 0x1c6a80, emissiveIntensity: 0.8, roughness: 0.35 });
  const gemMatGold = new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0x8a5a00, emissiveIntensity: 0.8, roughness: 0.35 });
  const gems = [];
  function spawnGem(x, z, value) {
    const big = value >= 5;
    const r = MG.px(big ? 7 : 5);
    const mesh = new THREE.Mesh(gemGeo, big ? gemMatGold : gemMatCyan);
    mesh.scale.set(r, r, r);
    mesh.position.set(x, r + 0.15, z);
    scene.add(mesh);
    gems.push({ x, z, value, r, baseY: r + 0.15, mesh, spin: Math.random() * Math.PI * 2 });
  }
  function updateGems(dt) {
    for (let i = gems.length - 1; i >= 0; i--) {
      const g = gems[i];
      const dx = player.x - g.x, dz = player.z - g.z;
      const d = Math.hypot(dx, dz);
      if (d < player.stats.pickupRadius) {
        const speed = Math.max(MG.px(260), (player.stats.pickupRadius - d) * 6);
        const nd = d || 1;
        g.x += (dx / nd) * speed * dt;
        g.z += (dz / nd) * speed * dt;
      }
      g.spin += dt * 2.4;
      g.mesh.position.set(g.x, g.baseY + Math.sin(g.spin * 1.6) * 0.08, g.z);
      g.mesh.rotation.y = g.spin;
      g.mesh.rotation.x = g.spin * 0.6;
      if (d < MG.px(16)) {
        scene.remove(g.mesh);
        gems.splice(i, 1);
        addXP(g.value);
        MG.sfx.pickup();
        addParticles(g.x, g.z, g.value >= 5 ? "#ffd54a" : "#7ee0ff", 5);
      }
    }
  }
  function resetGems() {
    for (const g of gems) scene.remove(g.mesh);
    gems.length = 0;
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
  // applying two picks in one gesture (see 2D game for full rationale).
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
  // Joystick draw (DOM overlay — the canvas is now a WebGL surface)
  // ---------------------------------------------------------------------
  function drawJoystick() {
    if (!joyBaseEl || !joyStickEl) return;
    const rect = wrap.getBoundingClientRect();
    if (!joystick.active) {
      joyBaseEl.style.display = "none";
      joyStickEl.style.display = "none";
      return;
    }
    const bx = joystick.baseX - rect.left, by = joystick.baseY - rect.top;
    const cx = joystick.curX - rect.left, cy = joystick.curY - rect.top;
    joyBaseEl.style.display = "block";
    joyStickEl.style.display = "block";
    joyBaseEl.style.left = (bx - JOY_R) + "px";
    joyBaseEl.style.top = (by - JOY_R) + "px";
    joyBaseEl.style.width = joyBaseEl.style.height = (JOY_R * 2) + "px";
    joyStickEl.style.left = (cx - 22) + "px";
    joyStickEl.style.top = (cy - 22) + "px";
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

  // Clears fxRoot (weapon visual effects) between runs: disposes every
  // child's geometry + material unless flagged `.shared = true` (weapons
  // that keep one reusable template geometry/material across instances —
  // see js/weapons.js) so restarting never leaks GPU resources.
  function clearFxRoot() {
    for (let i = fxRoot.children.length - 1; i >= 0; i--) {
      const obj = fxRoot.children[i];
      obj.traverse((n) => {
        if (n.geometry && !n.geometry.shared) n.geometry.dispose();
        if (n.material && !n.material.shared) {
          if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose());
          else n.material.dispose();
        }
      });
      fxRoot.remove(obj);
    }
  }

  function resetGame() {
    player.x = 0; player.z = 0;
    player.stats.speed = MG.px(220); player.stats.maxHp = 130; player.stats.regen = 0; player.stats.pickupRadius = MG.px(90);
    player.hp = player.stats.maxHp;
    player.invuln = 0; player.facing.x = 1; player.facing.z = 0; player.bob = 0;
    playerYaw = Math.atan2(player.facing.x, player.facing.z);

    for (const e of enemies) disposeEnemy(e);
    enemies.length = 0;
    resetGems();
    resetParticles();
    resetDamageNumbers();

    for (const w of MG.weapons.owned) { if (typeof w.dispose === "function") w.dispose(MG); }
    clearFxRoot();

    level = 1; xp = 0; xpToNext = xpNeeded(1); levelUpQueue = 0;
    killCount = 0; gameTime = 0; spawnTimer = 1;
    joystick.active = false;
    lastScatterCX = null; lastScatterCZ = null;
    viewRadiusDirty = true;

    MG.weapons.owned.length = 0;
    const startDef = MG.weapons.registry.find((w) => w.id === "klassisch");
    if (startDef) MG.weapons.owned.push(startDef.create(MG));
    lastWeaponSig = "";

    updateCamera(0, true);
    updateGround();
    refreshScatter();
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
    // Defensive net: same as 2D — contact damage already calls gameOver(),
    // this just guarantees the state machine can't get stuck at 0 HP.
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

    updateCamera(dt, false);
    updateGround();
    refreshScatter();
    if (viewRadiusDirty) computeFootprint();
    updateHUD();
  }

  function render() {
    drawJoystick();
    renderer.render(scene, camera);
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

  initDamageNumberPool();
  resize();
  updateCamera(0, true);
  updateGround();
  refreshScatter();
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
    renderer,
  };
})();
