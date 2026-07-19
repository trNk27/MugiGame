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
  // Daytime sky: a vertical-gradient background texture (screen-space —
  // fine with the fixed-rotation chase camera) whose horizon color matches
  // the fog color, so the green ground fades naturally into the sky.
  const SKY_HORIZON = "#cfe3f2";
  function buildSkyTexture() {
    const cnv = document.createElement("canvas");
    cnv.width = 2; cnv.height = 256;
    const g = cnv.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#3f86d4");
    grad.addColorStop(0.55, "#8fbde8");
    grad.addColorStop(1, SKY_HORIZON);
    g.fillStyle = grad;
    g.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(cnv);
    return tex;
  }
  scene.background = buildSkyTexture();
  scene.fog = new THREE.Fog(0xcfe3f2, 15, 40);

  // Drifting billboard clouds high above the play plane. Kept in a ring
  // around the player (offsets follow the player, so they never run out)
  // with a slow eastward drift that wraps.
  function buildCloudTexture() {
    const cnv = document.createElement("canvas");
    cnv.width = 128; cnv.height = 64;
    const g = cnv.getContext("2d");
    let seed = 11;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    for (let i = 0; i < 7; i++) {
      const x = 20 + rnd() * 88, y = 22 + rnd() * 20, r = 10 + rnd() * 16;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(255,255,255,0.85)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    return new THREE.CanvasTexture(cnv);
  }
  const cloudTex = buildCloudTexture();
  const clouds = [];
  const CLOUD_COUNT = 7, CLOUD_RANGE = 55;
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const mat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.55 + Math.random() * 0.25, depthWrite: false, fog: false });
    const spr = new THREE.Sprite(mat);
    const w = 10 + Math.random() * 10;
    spr.scale.set(w, w * 0.45, 1);
    scene.add(spr);
    clouds.push({
      spr,
      ox: (Math.random() * 2 - 1) * CLOUD_RANGE,
      oz: (Math.random() * 2 - 1) * CLOUD_RANGE,
      y: 15 + Math.random() * 9,
      drift: 0.25 + Math.random() * 0.35,
    });
  }
  function updateClouds(dt, px, pz) {
    for (const c of clouds) {
      c.ox += c.drift * dt;
      if (c.ox > CLOUD_RANGE) c.ox = -CLOUD_RANGE;
      c.spr.position.set(px + c.ox, c.y, pz + c.oz);
    }
  }

  // fxRoot: weapons add their own three.js visual-effect objects here.
  // Cleared (all children removed + geometries/materials disposed, except
  // any geometry/material flagged `.shared = true` which weapons re-use
  // across instances) on every resetGame(). See js/weapons.js header.
  const fxRoot = new THREE.Group();
  scene.add(fxRoot);
  MG.fxRoot = fxRoot;

  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 120);
  const CAM_OFFSET = new THREE.Vector3(0, 10, 13);
  const CAM_LOOK_Y = 2.0;
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
  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x55744a, 0.85);
  scene.add(hemi);
  const dirLight = new THREE.DirectionalLight(0xfff6e0, 1.05);
  dirLight.position.set(-6, 10, 4);
  scene.add(dirLight);
  const ambient = new THREE.AmbientLight(0x8a97a8, 0.16);
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
    g.fillStyle = "#3f6b35";
    g.fillRect(0, 0, 256, 256);
    // soft deterministic color mottling (darker/lighter grass blotches) so
    // the meadow reads less flat; kept low-alpha so it never competes with
    // gameplay readability (enemies/particles/gems stay high-contrast).
    let seed = 3;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    for (let i = 0; i < 9; i++) {
      const x = rnd() * 256, y = rnd() * 256, r = 26 + rnd() * 46;
      const dark = rnd() > 0.5;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, dark ? "rgba(30,58,26,0.18)" : "rgba(150,190,105,0.10)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // whisper-faint tile edge: kept only as a motion cue while running
    g.strokeStyle = "rgba(255,255,255,0.03)";
    g.lineWidth = 2;
    g.strokeRect(1, 1, 254, 254);
    // sparse deterministic dots (tiny flowers / light speckles)
    seed = 7;
    for (let i = 0; i < 12; i++) {
      const x = rnd() * 256, y = rnd() * 256, s = 1.2 + rnd() * 1.6;
      g.fillStyle = rnd() > 0.75 ? "rgba(240,235,170,0.25)" : "rgba(215,240,170,0.10)";
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
    // The plane is built with rotateX(-Math.PI/2), which maps the
    // texture's V axis to world -Z (V increases as Z decreases). The U
    // axis is untouched and maps directly to world X. So the V-axis
    // offset needs a sign flip to keep the pattern fixed in world space
    // as the player (and the re-centered plane) moves — without it the
    // ground visibly scrolls backwards on the Z axis only.
    groundTex.offset.set(player.x / TILE_WORLD, -player.z / TILE_WORLD);
  }

  // ---------------------------------------------------------------------
  // Scatter decoration (grass / rocks / trees / structures) — deterministic
  // grid hash, purely cosmetic (no collision, no gameplay interaction).
  // Everything is repositioned whenever the player crosses into a new
  // coarse scatter cell (see refreshScatter's early-return below), so the
  // rebuild work inside that function does NOT run every frame — it's safe
  // for it to allocate (matches the original rock/tree code's style, which
  // already allocated a fresh Vector3 per instance in this same path).
  // ---------------------------------------------------------------------
  function hash2(a, b) {
    let x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  // small per-cell PRNG helper for structure part variation (salt just
  // shifts which "channel" of the hash we read for a given cell)
  function rh(gx, gz, salt) { return hash2(gx + salt * 17.3, gz - salt * 11.9); }

  // Merge several primitive geometries (each already placed by its own
  // local matrix) into one non-indexed BufferGeometry with baked per-part
  // vertex colors, so a whole multi-primitive shape (a tree canopy, a
  // ruin, a hut...) costs a single draw call instead of one per part.
  function mergeParts(parts) {
    let total = 0;
    const chunks = parts.map((p) => {
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
      g.applyMatrix4(p.matrix);
      total += g.attributes.position.count;
      return g;
    });
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    let offset = 0;
    chunks.forEach((g, i) => {
      const cnt = g.attributes.position.count;
      positions.set(g.attributes.position.array, offset * 3);
      normals.set(g.attributes.normal.array, offset * 3);
      const c = parts[i].color;
      for (let v = 0; v < cnt; v++) {
        colors[(offset + v) * 3] = c.r;
        colors[(offset + v) * 3 + 1] = c.g;
        colors[(offset + v) * 3 + 2] = c.b;
      }
      offset += cnt;
      g.dispose();
    });
    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return merged;
  }
  function partMatrix(x, y, z, rx, ry, rz, sx, sy, sz) {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz)
    );
  }
  const WHITE = new THREE.Color(1, 1, 1);

  // Shared "unit" primitives (centered, radius/size 1) reused as building
  // blocks for trees and structures via mergeParts/partMatrix above.
  const boxUnit = new THREE.BoxGeometry(1, 1, 1);
  const coneUnit = new THREE.ConeGeometry(1, 1, 7);
  const pyramidUnit = new THREE.ConeGeometry(1, 1, 4);
  const icoUnit = new THREE.IcosahedronGeometry(1, 0);
  const taperUnit = new THREE.CylinderGeometry(0.65, 1, 1, 7);

  const _m4 = new THREE.Matrix4();
  const _quat = new THREE.Quaternion();
  const _scaleV = new THREE.Vector3(1, 1, 1);
  const _axisY = new THREE.Vector3(0, 1, 0);
  let lastScatterCX = null, lastScatterCZ = null;

  // --- rocks (unchanged shape, box InstancedMesh) ---
  const SCATTER_CELL = 5.5;
  const SCATTER_RADIUS_CELLS = 7;
  const MAX_ROCKS = 40;
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6e736f, roughness: 0.9 });
  const rockMesh = new THREE.InstancedMesh(boxUnit, rockMat, MAX_ROCKS);
  rockMesh.count = 0;
  scene.add(rockMesh);

  // --- trees: one shared trunk InstancedMesh + one InstancedMesh per
  // canopy variant (fir / deciduous / dead-branch), each canopy variant's
  // geometry itself a merged multi-primitive template built once below. ---
  const MAX_TRUNK = 54, MAX_FIR = 20, MAX_DECID = 20, MAX_DEAD = 16;
  const trunkGeo = new THREE.CylinderGeometry(0.07, 0.1, 1, 6);
  trunkGeo.translate(0, 0.5, 0); // pivot at base
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3628, roughness: 0.9 });
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, MAX_TRUNK);
  const canopyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const firCanopyGeo = mergeParts([
    { geo: coneUnit, matrix: partMatrix(0, 0.45, 0, 0, 0, 0, 0.5, 0.9, 0.5), color: WHITE },
    { geo: coneUnit, matrix: partMatrix(0, 0.85, 0, 0, 0, 0, 0.35, 0.65, 0.35), color: WHITE },
  ]);
  const decidCanopyGeo = mergeParts([
    { geo: icoUnit, matrix: partMatrix(0, 0.5, 0, 0, 0, 0, 0.55, 0.5, 0.55), color: WHITE },
    { geo: icoUnit, matrix: partMatrix(0.2, 0.65, 0.05, 0, 0, 0, 0.35, 0.32, 0.35), color: WHITE },
  ]);
  const deadCanopyGeo = mergeParts([
    { geo: boxUnit, matrix: partMatrix(0.15, 0.5, 0, 0, 0, 0.9, 0.5, 0.05, 0.05), color: WHITE },
    { geo: boxUnit, matrix: partMatrix(-0.15, 0.35, 0.1, 0, 0, -0.8, 0.4, 0.05, 0.05), color: WHITE },
    { geo: boxUnit, matrix: partMatrix(0, 0.7, -0.1, 0.6, 0, 0.2, 0.3, 0.05, 0.05), color: WHITE },
  ]);
  const firMesh = new THREE.InstancedMesh(firCanopyGeo, canopyMat, MAX_FIR);
  const decidMesh = new THREE.InstancedMesh(decidCanopyGeo, canopyMat, MAX_DECID);
  const deadMesh = new THREE.InstancedMesh(deadCanopyGeo, canopyMat, MAX_DEAD);
  trunkMesh.count = 0; firMesh.count = 0; decidMesh.count = 0; deadMesh.count = 0;
  scene.add(trunkMesh, firMesh, decidMesh, deadMesh);

  // --- grass: one InstancedMesh of crossed-quad tufts ---
  const MAX_GRASS = 560;
  const grassGeo = mergeParts([
    { geo: (() => { const p = new THREE.PlaneGeometry(0.55, 1); p.translate(0, 0.5, 0); return p; })(), matrix: new THREE.Matrix4(), color: WHITE },
    { geo: (() => { const p = new THREE.PlaneGeometry(0.55, 1); p.translate(0, 0.5, 0); p.rotateY(Math.PI / 2); return p; })(), matrix: new THREE.Matrix4(), color: WHITE },
  ]);
  const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  const grassMesh = new THREE.InstancedMesh(grassGeo, grassMat, MAX_GRASS);
  grassMesh.count = 0;
  scene.add(grassMesh);
  // 2-3 "hero" tufts nearest the player get a cheap per-frame lean each
  // frame; every other instance is placed once and stays fully static.
  const HERO_GRASS_N = 3;
  let heroGrass = [];
  const _heroEuler = new THREE.Euler();
  const _heroPos = new THREE.Vector3();
  function updateGrassSway(t) {
    if (!heroGrass.length) return;
    for (let i = 0; i < heroGrass.length; i++) {
      const hg = heroGrass[i];
      const wob = Math.sin(t * 2.2 + hg.idx) * 0.18;
      _heroEuler.set(hg.lean, hg.rotY + wob * 0.3, hg.lean * 0.4 + wob);
      _quat.setFromEuler(_heroEuler);
      _scaleV.set(hg.s, hg.s, hg.s);
      _heroPos.set(hg.x, 0, hg.z);
      _m4.compose(_heroPos, _quat, _scaleV);
      grassMesh.setMatrixAt(hg.idx, _m4);
    }
    grassMesh.instanceMatrix.needsUpdate = true;
  }

  // --- structures: a small pool of Groups (rare, ~1 per 2-3 screens),
  // each a single merged-geometry "body" mesh (+ an optional emissive
  // window accent for huts). Deterministic per cell like everything else,
  // reused by key so the same world cell always yields the same building
  // without a geometry rebuild once it's already resident in the pool. ---
  const structMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
  function buildRuins(gx, gz) {
    const stone = new THREE.Color(0x9a9d99);
    const parts = [];
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rh(gx, gz, i) * 0.6;
      const rad = 1.6 + rh(gx, gz, i + 50) * 0.3;
      const px = Math.cos(a) * rad, pz = Math.sin(a) * rad;
      const fallen = rh(gx, gz, i + 90) > 0.8;
      const h = 0.9 + rh(gx, gz, i + 10) * 0.9;
      const tilt = (rh(gx, gz, i + 20) - 0.5) * 0.35;
      const c = stone.clone().offsetHSL(0, 0, (rh(gx, gz, i + 30) - 0.5) * 0.08);
      if (fallen) {
        parts.push({ geo: boxUnit, matrix: partMatrix(px, 0.16, pz, 0.05, a, Math.PI / 2 + tilt, 0.32, 0.32, h * 0.8), color: c });
      } else {
        parts.push({ geo: boxUnit, matrix: partMatrix(px, h / 2, pz, tilt, a * 0.3, tilt * 0.6, 0.34, h, 0.34), color: c });
      }
    }
    return mergeParts(parts);
  }
  function buildHut(gx, gz) {
    const wall = new THREE.Color(0xbfae8f);
    const roof = new THREE.Color(0x8a4f3a);
    const door = new THREE.Color(0x5c422e);
    return mergeParts([
      { geo: boxUnit, matrix: partMatrix(0, 0.55, 0, 0, 0, 0, 1.6, 1.1, 1.4), color: wall },
      { geo: pyramidUnit, matrix: partMatrix(0, 1.35, 0, 0, Math.PI / 4, 0, 1.35, 0.9, 1.35), color: roof },
      { geo: boxUnit, matrix: partMatrix(-0.35, 0.35, 0.71, 0, 0, 0, 0.4, 0.7, 0.06), color: door },
    ]);
  }
  function buildTower(gx, gz) {
    const stone = new THREE.Color(0x87908f);
    const parts = [];
    let y = 0, ox = 0, oz = 0;
    for (let i = 0; i < 3; i++) {
      const h = 1.05 - i * 0.25;
      const rad = 0.62 - i * 0.14;
      const tiltX = (rh(gx, gz, i + 5) - 0.5) * 0.1 * i;
      const tiltZ = (rh(gx, gz, i + 15) - 0.5) * 0.1 * i;
      ox += (rh(gx, gz, i + 25) - 0.5) * 0.18;
      oz += (rh(gx, gz, i + 35) - 0.5) * 0.18;
      const c = stone.clone().offsetHSL(0, 0, (rh(gx, gz, i + 45) - 0.5) * 0.06);
      parts.push({ geo: taperUnit, matrix: partMatrix(ox, y + h / 2, oz, tiltX, 0, tiltZ, rad, h, rad), color: c });
      y += h * 0.95;
    }
    for (let i = 0; i < 2; i++) {
      const a = rh(gx, gz, i + 60) * Math.PI * 2;
      const rr = 0.8 + rh(gx, gz, i + 70) * 0.4;
      parts.push({ geo: boxUnit, matrix: partMatrix(Math.cos(a) * rr, 0.15, Math.sin(a) * rr, rh(gx, gz, i + 80), rh(gx, gz, i + 81) * Math.PI, rh(gx, gz, i + 82), 0.4, 0.3, 0.4), color: stone });
    }
    return mergeParts(parts);
  }
  function buildFence(gx, gz) {
    const wood = new THREE.Color(0x8a6a45);
    const parts = [];
    const n = 5, spacing = 0.85, gapAt = 2;
    for (let i = 0; i < n; i++) {
      if (i === gapAt) continue;
      const px = (i - (n - 1) / 2) * spacing;
      const wob = (rh(gx, gz, i + 5) - 0.5) * 0.15;
      const c = wood.clone().offsetHSL(0, 0, (rh(gx, gz, i + 15) - 0.5) * 0.08);
      parts.push({ geo: boxUnit, matrix: partMatrix(px, 0.4, 0, wob * 0.3, 0, wob, 0.1, 0.8, 0.1), color: c });
    }
    parts.push({ geo: boxUnit, matrix: partMatrix(-spacing, 0.55, 0, 0, 0, 0, spacing * 2.1, 0.08, 0.06), color: wood });
    parts.push({ geo: boxUnit, matrix: partMatrix(spacing, 0.55, 0, 0, 0, 0, spacing * 2.1, 0.08, 0.06), color: wood });
    return mergeParts(parts);
  }
  const STRUCT_BUILDERS = [buildRuins, buildHut, buildTower, buildFence];
  const MAX_STRUCTURES = 6;
  const windowGeo = new THREE.PlaneGeometry(0.5, 0.4);
  const windowMat = new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0xffb300, emissiveIntensity: 1.4, roughness: 0.5, side: THREE.DoubleSide });
  const structPool = [];
  for (let i = 0; i < MAX_STRUCTURES; i++) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BufferGeometry(), structMat);
    const accent = new THREE.Mesh(windowGeo, windowMat);
    accent.visible = false;
    group.add(body, accent);
    group.visible = false;
    scene.add(group);
    structPool.push({ key: null, type: -1, group, body, accent, d: Infinity });
  }
  const MAX_STRUCT_LIGHTS = 2;
  const structLights = [];
  for (let i = 0; i < MAX_STRUCT_LIGHTS; i++) {
    const pl = new THREE.PointLight(0xffcf70, 0, 6, 2);
    scene.add(pl);
    structLights.push(pl);
  }
  const STRUCT_CELL = 20;
  const STRUCT_RADIUS_CELLS = 3;

  function refreshScatter() {
    const cx = Math.floor(player.x / SCATTER_CELL);
    const cz = Math.floor(player.z / SCATTER_CELL);
    if (cx === lastScatterCX && cz === lastScatterCZ) return;
    lastScatterCX = cx; lastScatterCZ = cz;

    // ---- rocks + trees (fir / deciduous / dead variants) ----
    let rockN = 0, trunkN = 0, firN = 0, decidN = 0, deadN = 0;
    for (let dx = -SCATTER_RADIUS_CELLS; dx <= SCATTER_RADIUS_CELLS; dx++) {
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
          const vsel = hash2(gx + 200, gz + 200);
          const variant = vsel < 0.4 ? 0 : vsel < 0.75 ? 1 : 2; // fir / deciduous / dead
          const s = 0.85 + hash2(gx, gz + 55) * 0.6;
          const rot = hash2(gx, gz + 300) * Math.PI * 2;
          _quat.setFromAxisAngle(_axisY, rot);
          const trunkH = variant === 2 ? 1.9 * s : 1.15 * s;
          const trunkR = variant === 2 ? 0.55 : 1;
          if (trunkN < MAX_TRUNK) {
            _scaleV.set(0.9 * trunkR, trunkH, 0.9 * trunkR);
            _m4.compose(new THREE.Vector3(wx, 0, wz), _quat, _scaleV);
            trunkMesh.setMatrixAt(trunkN++, _m4);
          }
          const canopyColor = new THREE.Color().setHSL(
            0.26 + hash2(gx + 9, gz + 9) * 0.1,
            0.38 + hash2(gx + 8, gz + 8) * 0.16,
            0.22 + hash2(gx + 7, gz + 7) * 0.1
          );
          const canH = 1.1 * s;
          _scaleV.set(canH, canH, canH);
          _m4.compose(new THREE.Vector3(wx, trunkH * 0.92, wz), _quat, _scaleV);
          if (variant === 0 && firN < MAX_FIR) { firMesh.setMatrixAt(firN, _m4); firMesh.setColorAt(firN, canopyColor); firN++; }
          else if (variant === 1 && decidN < MAX_DECID) { decidMesh.setMatrixAt(decidN, _m4); decidMesh.setColorAt(decidN, canopyColor); decidN++; }
          else if (variant === 2 && deadN < MAX_DEAD) { deadMesh.setMatrixAt(deadN, _m4); deadMesh.setColorAt(deadN, canopyColor.offsetHSL(0, 0, -0.05)); deadN++; }
        } else {
          if (rockN >= MAX_ROCKS) continue;
          const s = 0.35 + hash2(gx + 2, gz) * 0.55;
          _scaleV.set(s, s, s);
          _quat.setFromAxisAngle(_axisY, hash2(gx, gz + 400) * Math.PI * 2);
          _m4.compose(new THREE.Vector3(wx, s / 2, wz), _quat, _scaleV);
          rockMesh.setMatrixAt(rockN++, _m4);
        }
      }
    }
    rockMesh.count = rockN;
    trunkMesh.count = trunkN;
    firMesh.count = firN; decidMesh.count = decidN; deadMesh.count = deadN;
    rockMesh.instanceMatrix.needsUpdate = true;
    trunkMesh.instanceMatrix.needsUpdate = true;
    firMesh.instanceMatrix.needsUpdate = true;
    decidMesh.instanceMatrix.needsUpdate = true;
    deadMesh.instanceMatrix.needsUpdate = true;
    if (firMesh.instanceColor) firMesh.instanceColor.needsUpdate = true;
    if (decidMesh.instanceColor) decidMesh.instanceColor.needsUpdate = true;
    if (deadMesh.instanceColor) deadMesh.instanceColor.needsUpdate = true;

    // ---- grass ----
    const GRASS_CELL = 1.25;
    const GRASS_RADIUS_CELLS = 12;
    const gcx = Math.floor(player.x / GRASS_CELL);
    const gcz = Math.floor(player.z / GRASS_CELL);
    let grassN = 0;
    heroGrass = [];
    for (let dx = -GRASS_RADIUS_CELLS; dx <= GRASS_RADIUS_CELLS && grassN < MAX_GRASS; dx++) {
      for (let dz = -GRASS_RADIUS_CELLS; dz <= GRASS_RADIUS_CELLS && grassN < MAX_GRASS; dz++) {
        const gx = gcx + dx, gz = gcz + dz;
        if (hash2(gx + 1000, gz + 1000) > 0.8) continue;
        const jx = (hash2(gx + 1300, gz) - 0.5) * GRASS_CELL * 0.8;
        const jz = (hash2(gx, gz + 1300) - 0.5) * GRASS_CELL * 0.8;
        const wx = (gx + 0.5) * GRASS_CELL + jx;
        const wz = (gz + 0.5) * GRASS_CELL + jz;
        const d = Math.hypot(wx - player.x, wz - player.z);
        if (d < 1.6) continue; // deadzone right under the player
        const s = 0.15 + hash2(gx + 1400, gz) * 0.25;
        const rotY = hash2(gx, gz + 1500) * Math.PI * 2;
        const lean = (hash2(gx + 1600, gz) - 0.5) * 0.5;
        _quat.setFromEuler(new THREE.Euler(lean, rotY, lean * 0.4));
        _scaleV.set(s, s, s);
        _m4.compose(new THREE.Vector3(wx, 0, wz), _quat, _scaleV);
        grassMesh.setMatrixAt(grassN, _m4);
        const t = hash2(gx + 1700, gz);
        const col = new THREE.Color(0x3f7a34).lerp(new THREE.Color(0x6fae4e), t);
        grassMesh.setColorAt(grassN, col);
        if (d < 9 && heroGrass.length < HERO_GRASS_N) heroGrass.push({ idx: grassN, x: wx, z: wz, rotY, lean, s });
        grassN++;
      }
    }
    grassMesh.count = grassN;
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;

    // ---- structures (sparse, pooled Groups, deterministic per cell) ----
    const scx = Math.floor(player.x / STRUCT_CELL);
    const scz = Math.floor(player.z / STRUCT_CELL);
    const candidates = [];
    for (let dx = -STRUCT_RADIUS_CELLS; dx <= STRUCT_RADIUS_CELLS; dx++) {
      for (let dz = -STRUCT_RADIUS_CELLS; dz <= STRUCT_RADIUS_CELLS; dz++) {
        const gx = scx + dx, gz = scz + dz;
        if (hash2(gx + 9000, gz + 9000) > 0.16) continue;
        const jx = (hash2(gx + 9100, gz) - 0.5) * STRUCT_CELL * 0.5;
        const jz = (hash2(gx, gz + 9100) - 0.5) * STRUCT_CELL * 0.5;
        const wx = (gx + 0.5) * STRUCT_CELL + jx;
        const wz = (gz + 0.5) * STRUCT_CELL + jz;
        const d = Math.hypot(wx - player.x, wz - player.z);
        if (d < 6) continue; // generous deadzone so nothing looms over the player
        const type = Math.min(3, Math.floor(hash2(gx + 9200, gz + 9200) * 4));
        candidates.push({ key: gx + "," + gz, gx, gz, wx, wz, type, d });
      }
    }
    // Prefer the nearest structures when more candidates fall in range than
    // the pool can hold (49-cell scan at ~0.16 hit rate can exceed
    // MAX_STRUCTURES) — otherwise scan order alone could bump a close
    // structure in favor of a farther, less relevant one.
    candidates.sort((a, b) => a.d - b.d);
    if (candidates.length > MAX_STRUCTURES) candidates.length = MAX_STRUCTURES;
    const usedSlots = new Set();
    for (const cand of candidates) {
      let slotIdx = structPool.findIndex((s) => s.key === cand.key);
      if (slotIdx === -1) slotIdx = structPool.findIndex((s, i) => !usedSlots.has(i) && s.key === null);
      if (slotIdx === -1) {
        for (let i = 0; i < structPool.length; i++) { if (!usedSlots.has(i)) { slotIdx = i; break; } }
      }
      if (slotIdx === -1) continue;
      usedSlots.add(slotIdx);
      const slot = structPool[slotIdx];
      if (slot.key !== cand.key) {
        slot.key = cand.key;
        slot.type = cand.type;
        slot.body.geometry.dispose();
        slot.body.geometry = STRUCT_BUILDERS[cand.type](cand.gx, cand.gz);
        slot.accent.visible = cand.type === 1;
        if (cand.type === 1) slot.accent.position.set(0.35, 0.55, 0.72);
      }
      slot.group.position.set(cand.wx, 0, cand.wz);
      slot.group.rotation.y = hash2(cand.gx + 9300, cand.gz + 9300) * Math.PI * 2;
      slot.group.visible = true;
      slot.d = cand.d;
    }
    for (let i = 0; i < structPool.length; i++) {
      if (!usedSlots.has(i)) { structPool[i].group.visible = false; structPool[i].key = null; }
    }
    // At most MAX_STRUCT_LIGHTS real point lights alive at once, globally —
    // assign them to the nearest active hut windows for an extra glow-pool
    // on the ground; the window's own emissive material always reads even
    // without a light.
    const litCandidates = structPool.filter((s) => s.group.visible && s.type === 1).sort((a, b) => a.d - b.d);
    for (let i = 0; i < structLights.length; i++) {
      const s = litCandidates[i];
      if (s) {
        structLights[i].position.set(s.group.position.x + 0.35, 0.75, s.group.position.z + 0.72);
        structLights[i].intensity = 0.9;
      } else {
        structLights[i].intensity = 0;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Assets — markus.png is a JPEG-ish cutout on a near-black background
  // (no real alpha channel). Chroma-key the black away once at load (same
  // routine as the 2D game) so it draws as a clean transparent cutout.
  // ---------------------------------------------------------------------
  // loadCutoutCanvas is the shared primitive: it resolves the chroma-keyed
  // <canvas> itself (plus the raw <img>, as a fallback source) so callers
  // can either wrap it straight into a texture (loadCutoutTexture) or
  // composite it together with another face (the doppel/riese amalgam
  // texture below).
  function loadCutoutCanvas(src, onDone, onError) {
    const raw = new Image();
    raw.onload = () => {
      let off = null;
      try {
        off = document.createElement("canvas");
        off.width = raw.width;
        off.height = raw.height;
        const octx = off.getContext("2d");
        octx.drawImage(raw, 0, 0);
        const imgData = octx.getImageData(0, 0, off.width, off.height);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const maxc = Math.max(r, g, b);
          if (maxc < 28) d[i + 3] = 0;
          else if (maxc < 60) d[i + 3] = Math.round(((maxc - 28) / (60 - 28)) * 255);
        }
        octx.putImageData(imgData, 0, 0);
      } catch (e) {
        // Cross-origin / file:// canvas read can fail in some browsers;
        // signal "no usable canvas" so callers fall back to the raw image.
        off = null;
      }
      onDone(off, raw);
    };
    if (onError) raw.onerror = onError;
    raw.src = src;
  }
  function loadCutoutTexture(src, onDone, onError) {
    loadCutoutCanvas(src, (off, raw) => {
      let tex;
      if (off) {
        tex = new THREE.CanvasTexture(off);
      } else {
        tex = new THREE.Texture(raw);
        tex.needsUpdate = true;
      }
      tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
      tex.needsUpdate = true;
      onDone(tex);
    }, onError);
  }

  let baseEnemySpriteMat = new THREE.SpriteMaterial({ color: 0xcc9977, transparent: true }); // placeholder until image loads
  // Second enemy face (assets/markus2.png). Optional: if the file is
  // missing, markus2SpriteMat stays null and the enemy types that want it
  // fall back to the first face plus their distinguishing tint color.
  let markus2SpriteMat = null;
  // Composite "amalgam" texture (id 'doppel'/'riese' enemies): built once,
  // lazily, as soon as both face cutouts have resolved (markus2.png being
  // present or not) — see buildAmalgamTexture below. Until it's ready,
  // makeEnemySprite() falls back to the plain first face so an amalgam
  // enemy can never render with a null material even in a pathological
  // "amalgam type force-spawned before assets finished loading" case.
  let amalgamSpriteMat = null;
  let faceCanvas1 = null, faceCanvas2 = null, face2Settled = false;
  function buildAmalgamTexture() {
    if (amalgamSpriteMat || !faceCanvas1 || !face2Settled) return;
    const SIZE = 160;
    // ~35% overlap: two square face boxes of side FACE anchored at opposite
    // corners overlap by (2*FACE - SIZE) in each axis; solving
    // (2*FACE - SIZE) / FACE = 0.35 gives FACE ≈ SIZE / 1.65.
    const FACE = SIZE / 1.65;
    const cnv = document.createElement("canvas");
    cnv.width = SIZE; cnv.height = SIZE;
    const g = cnv.getContext("2d");
    // Second head: markus2's face if it loaded, else a horizontally
    // mirrored copy of the first face so the two heads still read as
    // visually distinct.
    let src2 = faceCanvas2;
    if (!src2) {
      const mirrored = document.createElement("canvas");
      mirrored.width = faceCanvas1.width;
      mirrored.height = faceCanvas1.height;
      const mctx = mirrored.getContext("2d");
      mctx.translate(mirrored.width, 0);
      mctx.scale(-1, 1);
      mctx.drawImage(faceCanvas1, 0, 0);
      src2 = mirrored;
    }
    // face 1: bottom-left. face 2: top-right, overlapping the first.
    g.drawImage(faceCanvas1, 0, SIZE - FACE, FACE, FACE);
    g.drawImage(src2, SIZE - FACE, 0, FACE, FACE);
    const tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
    tex.needsUpdate = true;
    amalgamSpriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  }
  loadCutoutCanvas("assets/markus.png", (off, raw) => {
    faceCanvas1 = off;
    const tex = off ? new THREE.CanvasTexture(off) : (() => { const t = new THREE.Texture(raw); t.needsUpdate = true; return t; })();
    tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
    tex.needsUpdate = true;
    baseEnemySpriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    buildAmalgamTexture();
  });
  loadCutoutCanvas("assets/markus2.png", (off, raw) => {
    faceCanvas2 = off;
    face2Settled = true;
    if (off) {
      const tex = new THREE.CanvasTexture(off);
      tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
      tex.needsUpdate = true;
      markus2SpriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    }
    buildAmalgamTexture();
  }, () => { markus2SpriteMat = null; face2Settled = true; buildAmalgamTexture(); });

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
    stats: { speed: MG.px(220), maxHp: 130, regen: 0, pickupRadius: MG.px(90), dmgMult: 1, xpMult: 1, cdMult: 1 },
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
      if (e.contactDmg <= 0) continue; // e.g. Goldener Markus (dmg 0): harmless, no invuln/hurt
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
  const FOOTPRINT_MAX_R = 18; // world units; top frustum corners graze the
  // horizon since the camera tilted up for the sky, so their ground hits
  // land absurdly far away — clamp them and let fog cover the spawn pop-in.
  function computeFootprint() {
    camera.updateMatrixWorld(true);
    // perimeter order: near-left, near-right, far-right, far-left
    const pts = [groundHitLocal(-1, -1), groundHitLocal(1, -1), groundHitLocal(1, 1), groundHitLocal(-1, 1)];
    if (pts.every((p) => p)) {
      for (const p of pts) {
        const len = Math.hypot(p.x, p.z);
        if (len > FOOTPRINT_MAX_R) { p.x *= FOOTPRINT_MAX_R / len; p.z *= FOOTPRINT_MAX_R / len; }
      }
      footprint = pts;
    }
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
  // `img2: true` types prefer the second face (assets/markus2.png) and fall
  // back to the first face if that file is missing; `amalgam: true` types
  // instead use the composite two-face texture (amalgamSpriteMat, built
  // once above) regardless of img2. `tint` (a hex color) is always applied
  // so the type stays distinguishable either way.
  // `splitsInto` (array of type ids) spawns one of each listed type on
  // death, at the corpse, spread in random directions; `boss: true` types
  // are scheduled separately (never in the regular rotation), get a ground
  // ring marker, and drop a chest + gem jackpot.
  const ENEMY_TYPES = {
    normal: { hp: 20, speed: MG.px(70), r: MG.px(26), dmg: 6, xp: 1 },
    flitzer: { hp: 10, speed: MG.px(130), r: MG.px(18), dmg: 5, xp: 1 },
    brocken: { hp: 90, speed: MG.px(40), r: MG.px(44), dmg: 13, xp: 5, tint: 0xdd5c4a },
    wueterich: { hp: 45, speed: MG.px(95), r: MG.px(30), dmg: 10, xp: 3, img2: true, tint: 0xffb46a },
    teiler: { hp: 40, speed: MG.px(55), r: MG.px(38), dmg: 8, xp: 3, img2: true, tint: 0xa5e08a, splitsInto: ["mini", "mini"] },
    mini: { hp: 8, speed: MG.px(150), r: MG.px(14), dmg: 4, xp: 1, img2: true, tint: 0xa5e08a },
    boss: { hp: 650, speed: MG.px(50), r: MG.px(72), dmg: 25, xp: 25, img2: true, boss: true },
    // Amalgam enemies (composite two-headed texture) — see buildAmalgamTexture.
    doppel: { hp: 130, speed: MG.px(65), r: MG.px(48), dmg: 14, xp: 6, amalgam: true, splitsInto: ["normal", "wueterich"] },
    riese: { hp: 350, speed: MG.px(35), r: MG.px(90), dmg: 30, xp: 12, amalgam: true, tint: 0x9a86b8, splitsInto: ["wueterich", "wueterich", "wueterich"] },
    // Goldener Markus — rare harmless "fleeing" pickup enemy, not part of
    // the regular pickEnemyType rotation (spawned on its own timer, see
    // updateGoldenMarkus below).
    gold: { hp: 60, speed: MG.px(160), r: MG.px(26), dmg: 0, xp: 0, tint: 0xffd700, flees: true, lifetime: 12 },
  };
  const SLOW_COLOR = new THREE.Color(0x8fd7ff);
  const FLASH_COLOR = new THREE.Color(0xffffff);
  const MAX_ENEMIES = 350;
  const enemies = [];
  MG.enemies = enemies;
  let spawnTimer = 1;

  // Boss schedule: first boss at 120s, then every 90s; each subsequent
  // boss gets +50% base HP on top of the normal time scaling.
  const BOSS_FIRST_AT = 120, BOSS_INTERVAL = 90;
  let nextBossAt = BOSS_FIRST_AT;
  let bossCount = 0;

  // Goldener Markus schedule: first eligible at 45s, then every 60-90s
  // (randomized per gap), max 1 alive at once. Ignores MAX_ENEMIES like
  // the boss schedule — it's a single harmless bonus enemy, never a
  // meaningful load contributor.
  const GOLD_FIRST_AT = 45;
  let nextGoldAt = GOLD_FIRST_AT;
  function updateGoldenMarkus() {
    if (gameTime < nextGoldAt) return;
    if (enemies.some((e) => !e.dead && e.type === "gold")) return;
    spawnEnemy("gold");
    nextGoldAt = gameTime + 60 + Math.random() * 30;
  }

  function spawnInterval() {
    return Math.max(0.15, 1.1 - gameTime * 0.005);
  }
  // Mix weights below are exact percentages per phase (comments give the
  // n/f/b/w/t/d/r split so the cumulative thresholds stay auditable). The
  // 'doppel'/'riese' ENEMY_TYPES entries are eligible from 4:30 / 6:00
  // respectively (never spawn earlier than that anywhere in the game), but
  // the weighted mix below — as specified — only actually starts rolling
  // them from 5:30 / 7:00, i.e. strictly inside their eligible window.
  function pickEnemyType() {
    const t = gameTime;
    const r = Math.random();
    if (t < 45) return "normal";
    if (t < 90) return r < 0.7 ? "normal" : "flitzer";
    if (t < 150) {
      if (r < 0.5) return "normal";
      if (r < 0.8) return "flitzer";
      return "brocken";
    }
    if (t < 240) {
      if (r < 0.4) return "normal";
      if (r < 0.65) return "flitzer";
      if (r < 0.85) return "brocken";
      return "wueterich";
    }
    if (t < 330) { // n30/f20/b17/w16/teiler17
      if (r < 0.30) return "normal";
      if (r < 0.50) return "flitzer";
      if (r < 0.67) return "brocken";
      if (r < 0.83) return "wueterich";
      return "teiler";
    }
    if (t < 420) { // n22/f16/b15/w15/t12/doppel20
      if (r < 0.22) return "normal";
      if (r < 0.38) return "flitzer";
      if (r < 0.53) return "brocken";
      if (r < 0.68) return "wueterich";
      if (r < 0.80) return "teiler";
      return "doppel";
    }
    // n15/f12/b13/w13/t12/d20/riese15
    if (r < 0.15) return "normal";
    if (r < 0.27) return "flitzer";
    if (r < 0.40) return "brocken";
    if (r < 0.53) return "wueterich";
    if (r < 0.65) return "teiler";
    if (r < 0.85) return "doppel";
    return "riese";
  }

  function makeEnemySprite(t) {
    const tmpl = t.amalgam && amalgamSpriteMat ? amalgamSpriteMat : (t.img2 && markus2SpriteMat ? markus2SpriteMat : baseEnemySpriteMat);
    const mat = tmpl.clone();
    const spr = new THREE.Sprite(mat);
    scene.add(spr);
    return spr;
  }

  // Faint red ground ring under bosses so they read as set-piece threats.
  const bossRingGeo = new THREE.RingGeometry(0.82, 1, 40);
  bossRingGeo.rotateX(-Math.PI / 2);
  const bossRingMatTemplate = new THREE.MeshBasicMaterial({ color: 0xff4a3a, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });

  function spawnEnemy(type) {
    const a = Math.random() * Math.PI * 2;
    spawnEnemyAt(type, null, null, a);
  }
  // Position override (ex/ez non-null) is used for splits (teiler death)
  // and test seams; otherwise the enemy spawns just outside the visible
  // ground footprint in direction `a`.
  function spawnEnemyAt(type, exOverride, ezOverride, a) {
    if (viewRadiusDirty) computeFootprint();
    const t = ENEMY_TYPES[type];
    // Ease-in: spawn at 70% HP, ramping to full over the first 90s so the
    // opening minute stays gentle; the +10%/min growth applies throughout.
    // Bosses skip the early ramp (they can't appear that early anyway) and
    // instead grow +50% per boss already beaten.
    const earlyMul = t.boss ? 1 : Math.min(1, 0.7 + 0.3 * (gameTime / 90));
    let hpMul = earlyMul * (1 + 0.12 * (gameTime / 60));
    if (t.boss) hpMul *= 1 + 0.5 * bossCount;
    let ex = exOverride, ez = ezOverride;
    if (ex === null || ex === undefined) {
      if (a === undefined) a = Math.random() * Math.PI * 2;
      // Just outside the visible ground footprint in this exact direction
      // (see computeFootprint/spawnBoundaryDistance above), plus a flat
      // margin so pop-in is never visible even with camera-lerp slack.
      const ringR = spawnBoundaryDistance(a) * 1.15 + MG.px(60);
      ex = player.x + Math.cos(a) * ringR;
      ez = player.z + Math.sin(a) * ringR;
    }
    const sprite = makeEnemySprite(t);
    const d = t.r * 2;
    sprite.scale.set(d, d, 1);
    sprite.position.set(ex, t.r, ez);
    let ringMesh = null;
    if (t.boss) {
      ringMesh = new THREE.Mesh(bossRingGeo, bossRingMatTemplate.clone());
      const rr = t.r * 1.4;
      ringMesh.scale.set(rr, 1, rr);
      ringMesh.position.set(ex, FX_Y, ez);
      scene.add(ringMesh);
    }
    const baseColor = new THREE.Color(
      t.tint !== undefined ? t.tint :
      (t.amalgam && !amalgamSpriteMat) ? 0xffb46a : // fallback-texture distinguisher (composite not built yet)
      (t.img2 && !markus2SpriteMat) ? 0x9ab0ff : // fallback-face distinguisher
      0xffffff
    );
    if (t.boss && !markus2SpriteMat) baseColor.setHex(0xff8a70);
    enemies.push({
      type, x: ex, z: ez, y: t.r,
      hp: t.hp * hpMul, maxHp: t.hp * hpMul,
      speed: t.speed, r: t.r, contactDmg: t.dmg, xp: t.xp,
      wobble: Math.random() * Math.PI * 2,
      hitFlash: 0, knockX: 0, knockZ: 0, dead: false,
      baseColor,
      boss: !!t.boss, splitsInto: t.splitsInto || null, ringMesh,
      // Goldener Markus (id 'gold'): flees instead of chasing, and
      // despawns cleanly after `lifetime` seconds if never caught.
      flees: !!t.flees, lifetime: t.lifetime || 0, age: 0,
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
    if (e.ringMesh) {
      scene.remove(e.ringMesh);
      e.ringMesh.material.dispose();
      e.ringMesh = null;
    }
  }

  function updateEnemies(dt) {
    const t = performance.now() / 1000;
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.dead) { disposeEnemy(e); enemies.splice(i, 1); continue; }
      // Goldener Markus (and any future lifetime-limited enemy): despawn
      // cleanly on expiry — a particle puff only, no hitEnemy/kill/gem.
      if (e.lifetime > 0) {
        e.age += dt;
        if (e.age >= e.lifetime) {
          addParticles(e.x, e.z, "#ffd54a", 20);
          disposeEnemy(e);
          enemies.splice(i, 1);
          continue;
        }
      }
      const dx = player.x - e.x, dz = player.z - e.z;
      const d = Math.hypot(dx, dz) || 1;
      const slowMul = gameTime < e.slowUntil ? e.slowFactor : 1;
      // `flees` types (Goldener Markus) run away from the player instead
      // of chasing — same steering math, chase vector inverted.
      const dirMul = e.flees ? -1 : 1;
      let vx = dirMul * (dx / d) * e.speed * slowMul, vz = dirMul * (dz / d) * e.speed * slowMul;
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
      const base = slowed ? SLOW_COLOR : e.baseColor;
      if (e.hitFlash > 0) {
        e.sprite.material.color.copy(base).lerp(FLASH_COLOR, e.hitFlash * 0.75);
      } else {
        e.sprite.material.color.copy(base);
      }
      if (e.ringMesh) {
        e.ringMesh.position.set(e.x, FX_Y, e.z);
        e.ringMesh.material.opacity = 0.4 + Math.sin(e.wobble * 1.4) * 0.15;
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
    // Shrine buffs ("permanente Upgrades", js/systems.js) raise dmgMult for
    // the rest of the run; every weapon's damage funnels through here, so
    // this one line is the whole implementation.
    dmg = Math.max(1, Math.round(dmg * (player.stats.dmgMult || 1)));
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
      killCount++;
      // Goldener Markus: a dedicated, generous reward instead of the
      // regular death path (its own xp/tint would otherwise drop a
      // near-worthless 0-value gem).
      if (enemy.type === "gold") {
        addParticles(enemy.x, enemy.z, "#ffd54a", 40);
        for (let g = 0; g < 8; g++) {
          const ga = (g / 8) * Math.PI * 2;
          spawnGem(enemy.x + Math.cos(ga) * 1.0, enemy.z + Math.sin(ga) * 1.0, 5); // value >=5 -> gold gem material
        }
        if (MG.food && typeof MG.food.spawnAt === "function") MG.food.spawnAt(enemy.x, enemy.z);
        MG.sfx.levelup();
        return;
      }
      addParticles(enemy.x, enemy.z, "#ff8a8a", 16);
      spawnGem(enemy.x, enemy.z, enemy.xp);
      // Splits into every listed child type (teiler -> 2x mini, doppel ->
      // normal+wueterich, riese -> 3x wueterich, ...), placed spread around
      // where it fell.
      if (enemy.splitsInto && enemy.splitsInto.length) {
        for (const childType of enemy.splitsInto) {
          const sa = Math.random() * Math.PI * 2;
          spawnEnemyAt(childType, enemy.x + Math.cos(sa) * enemy.r * 0.8, enemy.z + Math.sin(sa) * enemy.r * 0.8);
        }
      }
      // Boss rewards: a chest right where it fell + a ring of gold gems.
      if (enemy.boss) {
        addParticles(enemy.x, enemy.z, "#ffd54a", 40);
        for (let g = 0; g < 5; g++) {
          const ga = (g / 5) * Math.PI * 2;
          spawnGem(enemy.x + Math.cos(ga) * 1.2, enemy.z + Math.sin(ga) * 1.2, 5);
        }
        if (MG.chests && typeof MG.chests.spawnAt === "function") MG.chests.spawnAt(enemy.x, enemy.z);
        MG.sfx.levelup();
      }
      // Food drop hook (js/systems.js). Duck-typed: core.js has zero hard
      // dependency on that file being loaded.
      if (MG.food && typeof MG.food.onEnemyDeath === "function") MG.food.onEnemyDeath(enemy.x, enemy.z);
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
  MG.spawnGem = spawnGem; // exposed for js/systems.js (chest XP-jackpot reward)
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
    // Shrine XP buff ("permanente Upgrades") — applied at the single entry
    // point every XP source funnels through.
    xp += Math.max(1, Math.round(n * (player.stats.xpMult || 1)));
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
  const slotBarEl = document.getElementById("slotBar");
  const MAX_WEAPON_SLOTS = 4, MAX_PASSIVE_SLOTS = 4;
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
      slotBarEl.innerHTML = "";
      const weaponInsts = MG.weapons.owned.filter((w) => w.def.type !== "passive");
      const passiveInsts = MG.weapons.owned.filter((w) => w.def.type === "passive");
      appendSlotGroup(weaponInsts, MAX_WEAPON_SLOTS, "");
      const gap = document.createElement("div");
      gap.className = "slotGap";
      slotBarEl.appendChild(gap);
      appendSlotGroup(passiveInsts, MAX_PASSIVE_SLOTS, " passive-slot");
    }
    drawMinimap();
  }
  // Renders `count` boxes into #slotBar for one group (weapons or
  // passives): filled slots (icon + level badge) for owned instances
  // left-to-right, then dimmed/dashed empty slots for the remaining cap.
  function appendSlotGroup(insts, count, extraClass) {
    for (let i = 0; i < count; i++) {
      const div = document.createElement("div");
      const w = insts[i];
      if (w) {
        div.className = "weapon-icon" + extraClass;
        div.innerHTML = w.def.icon + '<span class="lvl">' + w.level + "</span>";
      } else {
        div.className = "weapon-icon empty-slot" + extraClass;
      }
      slotBarEl.appendChild(div);
    }
  }

  // ---------------------------------------------------------------------
  // Minimap — 2D canvas overlay. Shows the horde as faint dots, and the
  // things worth walking toward as icons: bosses (💀), shrines/permanent
  // upgrades (⭐, js/systems.js), chests (🧰) and food (🥨). Targets beyond
  // the map's world range are clamped to the rim so you always know which
  // direction to run.
  // ---------------------------------------------------------------------
  const minimapCanvas = document.getElementById("minimap");
  const minimapCtx = minimapCanvas ? minimapCanvas.getContext("2d") : null;
  const MINIMAP_RANGE = 30; // world units from player to map edge

  function minimapPlot(ctx, half, wx, wz, clampToRim) {
    let dx = (wx - player.x) / MINIMAP_RANGE;
    let dz = (wz - player.z) / MINIMAP_RANGE;
    const len = Math.hypot(dx, dz);
    let rimmed = false;
    if (len > 1) {
      if (!clampToRim) return null;
      dx /= len; dz /= len;
      rimmed = true;
    }
    return { x: half + dx * (half - 10), y: half + dz * (half - 10), rimmed };
  }

  function drawMinimap() {
    if (!minimapCtx) return;
    const ctx = minimapCtx;
    const size = minimapCanvas.width;
    const half = size / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 2, 0, Math.PI * 2);
    ctx.clip();
    // faint range ring
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(half, half, (half - 10) * 0.5, 0, Math.PI * 2); ctx.stroke();
    // horde: faint dots (regular), bosses + Goldener Markus drawn after as icons
    for (const e of enemies) {
      if (e.dead || e.boss || e.type === "gold") continue;
      const p = minimapPlot(ctx, half, e.x, e.z, false);
      if (!p) continue;
      ctx.fillStyle = "rgba(255,90,80,0.55)";
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // chests + food (duck-typed; js/systems.js)
    if (MG.chests && MG.chests.list) {
      ctx.font = "11px sans-serif";
      for (const c of MG.chests.list) {
        const p = minimapPlot(ctx, half, c.x, c.z, true);
        if (p) { ctx.globalAlpha = p.rimmed ? 0.65 : 1; ctx.fillText("🧰", p.x, p.y); }
      }
    }
    if (MG.food && MG.food.list) {
      ctx.font = "10px sans-serif";
      for (const f of MG.food.list) {
        const p = minimapPlot(ctx, half, f.x, f.z, false);
        if (p) { ctx.globalAlpha = 1; ctx.fillText(f.type && f.type.icon ? f.type.icon : "🥨", p.x, p.y); }
      }
    }
    // shrines (permanent upgrades)
    if (MG.shrines && MG.shrines.list) {
      ctx.font = "13px sans-serif";
      for (const s of MG.shrines.list) {
        const p = minimapPlot(ctx, half, s.x, s.z, true);
        if (p) { ctx.globalAlpha = p.rimmed ? 0.75 : 1; ctx.fillText("⭐", p.x, p.y); }
      }
    }
    // bosses on top
    ctx.font = "13px sans-serif";
    for (const e of enemies) {
      if (e.dead || !e.boss) continue;
      const p = minimapPlot(ctx, half, e.x, e.z, true);
      if (p) { ctx.globalAlpha = p.rimmed ? 0.8 : 1; ctx.fillText("💀", p.x, p.y); }
    }
    // Goldener Markus — rim-clamped like bosses so it's always chaseable.
    ctx.font = "13px sans-serif";
    for (const e of enemies) {
      if (e.dead || e.type !== "gold") continue;
      const p = minimapPlot(ctx, half, e.x, e.z, true);
      if (p) { ctx.globalAlpha = p.rimmed ? 0.8 : 1; ctx.fillText("🌟", p.x, p.y); }
    }
    ctx.globalAlpha = 1;
    // player arrow (facing direction) at center
    const ang = Math.atan2(player.facing.z, player.facing.x);
    ctx.translate(half, half);
    ctx.rotate(ang);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(7, 0); ctx.lineTo(-5, 4.6); ctx.lineTo(-2.5, 0); ctx.lineTo(-5, -4.6);
    ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.restore();
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
    player.stats.dmgMult = 1; player.stats.xpMult = 1; player.stats.cdMult = 1;
    player.hp = player.stats.maxHp;
    player.invuln = 0; player.facing.x = 1; player.facing.z = 0; player.bob = 0;
    playerYaw = Math.atan2(player.facing.x, player.facing.z);

    for (const e of enemies) disposeEnemy(e);
    enemies.length = 0;
    resetGems();
    resetParticles();
    resetDamageNumbers();
    if (MG.chests && typeof MG.chests.reset === "function") MG.chests.reset();
    if (MG.food && typeof MG.food.reset === "function") MG.food.reset();
    if (MG.shrines && typeof MG.shrines.reset === "function") MG.shrines.reset();

    for (const w of MG.weapons.owned) { if (typeof w.dispose === "function") w.dispose(MG); }
    clearFxRoot();

    level = 1; xp = 0; xpToNext = xpNeeded(1); levelUpQueue = 0;
    killCount = 0; gameTime = 0; spawnTimer = 1;
    nextBossAt = BOSS_FIRST_AT; bossCount = 0;
    nextGoldAt = GOLD_FIRST_AT;
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
    // Boss schedule runs independently of the regular spawn rotation (and
    // ignores MAX_ENEMIES — a boss is always allowed in).
    if (gameTime >= nextBossAt) {
      spawnEnemy("boss");
      bossCount++;
      nextBossAt += BOSS_INTERVAL;
    }
    updateGoldenMarkus();
    updateEnemies(dt);
    updateGems(dt);
    // Chests / food (js/systems.js). Duck-typed hooks so core.js has zero
    // hard dependency on that file being loaded.
    if (MG.chests && typeof MG.chests.update === "function") MG.chests.update(dt);
    if (MG.food && typeof MG.food.update === "function") MG.food.update(dt);
    if (MG.shrines && typeof MG.shrines.update === "function") MG.shrines.update(dt);

    for (const w of MG.weapons.owned) w.update(dt, MG);

    updateParticles(dt);
    updateDamageNumbers(dt);

    updateCamera(dt, false);
    updateGround();
    updateClouds(dt, player.x, player.z);
    refreshScatter();
    updateGrassSway(gameTime);
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
  updateClouds(0, 0, 0);
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
    get chests() { return MG.chests; },
    get food() { return MG.food; },
    get shrines() { return MG.shrines; },
    // QA seam: force-spawn any ENEMY_TYPES key (e.g. "boss", "teiler"),
    // optionally at an exact position.
    spawnEnemy(type, x, z) { spawnEnemyAt(type, x !== undefined ? x : null, z !== undefined ? z : null); },
  };
})();
