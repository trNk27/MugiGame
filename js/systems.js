// ============================================================================
// Peitsch den Markus: Survivors — CHESTS & FOOD (3D, brand-new systems)
// ----------------------------------------------------------------------------
// Built entirely on top of the MG API exposed by js/core.js and
// js/weapons.js. Loaded after both. Hooked into the main loop via a handful
// of small duck-typed calls in core.js (search core.js for "MG.chests" /
// "MG.food" to find all four call sites: update() twice per frame,
// resetGame() twice, and one inside hitEnemy()'s death branch).
//
// Unlike js/weapons.js (which ports 2D px-tuned stats via MG.px()), every
// spatial number in this file is a *brand-new* value already expressed in
// world units directly (the task spec itself gives them in "units", e.g.
// "8-14 units from the player") — so none of it goes through MG.px().
// ============================================================================
(function () {
  "use strict";

  const MG = window.MG;

  // ---------------------------------------------------------------------
  // Small DOM toast (chest reward banner) + world-space floating text
  // (food pickup feedback, "+30 HP" etc.) — cheap ad-hoc sprites, not
  // pooled since both are low-frequency events.
  // ---------------------------------------------------------------------
  const toastEl = document.createElement("div");
  toastEl.id = "mgToast";
  Object.assign(toastEl.style, {
    position: "absolute", top: "72px", left: "50%",
    transform: "translateX(-50%) translateY(-8px)",
    padding: "10px 22px", background: "rgba(10,10,18,0.82)",
    border: "1px solid rgba(255,213,74,0.6)", borderRadius: "10px",
    color: "#ffd54a", fontFamily: "'Trebuchet MS', sans-serif",
    fontWeight: "bold", fontSize: "15px", zIndex: "6", pointerEvents: "none",
    opacity: "0", transition: "opacity 0.25s ease, transform 0.25s ease",
    whiteSpace: "nowrap", textShadow: "0 2px 6px rgba(0,0,0,0.8)",
  });
  const gameWrapEl = document.getElementById("game-wrap") || document.body;
  gameWrapEl.appendChild(toastEl);
  let toastTimer = null;
  function showToast(text) {
    toastEl.textContent = text;
    toastEl.style.opacity = "1";
    toastEl.style.transform = "translateX(-50%) translateY(0)";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translateX(-50%) translateY(-8px)";
    }, 1800);
  }

  const floaters = [];
  function spawnFloatText(x, z, text, color) {
    const cnv = document.createElement("canvas");
    cnv.width = 200; cnv.height = 44;
    const c2 = cnv.getContext("2d");
    c2.font = "bold 26px 'Trebuchet MS', sans-serif";
    c2.textAlign = "center"; c2.textBaseline = "middle";
    c2.fillStyle = color || "#9dffb0";
    c2.fillText(text, 100, 22);
    const tex = new THREE.CanvasTexture(cnv);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(1.8, 0.4, 1);
    spr.position.set(x, 1.3, z);
    MG.scene.add(spr);
    floaters.push({ sprite: spr, tex, mat, life: 1, y: 1.3 });
  }
  function updateFloaters(dt) {
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.y += MG.px(50) * dt;
      f.life -= dt * 0.8;
      f.sprite.position.y = f.y;
      f.mat.opacity = Math.max(0, f.life);
      if (f.life <= 0) {
        MG.scene.remove(f.sprite);
        f.tex.dispose(); f.mat.dispose();
        floaters.splice(i, 1);
      }
    }
  }
  function resetFloaters() {
    for (const f of floaters) { MG.scene.remove(f.sprite); f.tex.dispose(); f.mat.dispose(); }
    floaters.length = 0;
  }

  // =========================================================================
  // Chests (Truhen)
  // =========================================================================
  const CHEST_MIN_INTERVAL = 45, CHEST_MAX_INTERVAL = 70;
  const CHEST_MAX_ALIVE = 2;
  const CHEST_SPAWN_MIN_DIST = 8, CHEST_SPAWN_MAX_DIST = 14;
  const CHEST_OPEN_PAD = 0.6;
  const CHEST_LID_OPEN_TIME = 0.35;
  const CHEST_SINK_TIME = 0.6;

  const chestBodyGeo = new THREE.BoxGeometry(0.9, 0.55, 0.6);
  const chestLidGeo = new THREE.BoxGeometry(0.96, 0.22, 0.66);
  const chestBodyMat = new THREE.MeshStandardMaterial({ color: 0x6b4a26, roughness: 0.75 });
  const chestLidMat = new THREE.MeshStandardMaterial({ color: 0x7d5830, roughness: 0.7 });
  const chestTrimGeo = new THREE.EdgesGeometry(chestBodyGeo);
  const chestTrimMat = new THREE.LineBasicMaterial({ color: 0xffd54a });

  const chests = [];
  function nextChestDelay() { return CHEST_MIN_INTERVAL + Math.random() * (CHEST_MAX_INTERVAL - CHEST_MIN_INTERVAL); }
  let chestSpawnTimer = nextChestDelay();

  function buildChestParts() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(chestBodyGeo, chestBodyMat);
    body.position.y = 0.275;
    group.add(body);
    const trim = new THREE.LineSegments(chestTrimGeo, chestTrimMat);
    trim.position.copy(body.position);
    group.add(trim);
    const lidGroup = new THREE.Group();
    lidGroup.position.set(0, 0.55, -0.3);
    const lid = new THREE.Mesh(chestLidGeo, chestLidMat);
    lid.position.set(0, 0.11, 0.3);
    lidGroup.add(lid);
    group.add(lidGroup);
    const light = new THREE.PointLight(0xffd54a, 0.5, 3);
    light.position.y = 0.7;
    group.add(light);
    return { group, lidGroup, light };
  }

  function spawnChest(px, pz) {
    const a = Math.random() * Math.PI * 2;
    const d = CHEST_SPAWN_MIN_DIST + Math.random() * (CHEST_SPAWN_MAX_DIST - CHEST_SPAWN_MIN_DIST);
    spawnChestAt(px + Math.cos(a) * d, pz + Math.sin(a) * d);
  }
  // Exact-position variant — used for boss drops (core.js death branch).
  function spawnChestAt(x, z) {
    const parts = buildChestParts();
    parts.group.position.set(x, 0, z);
    MG.scene.add(parts.group);
    chests.push({
      x, z, group: parts.group, lidGroup: parts.lidGroup, light: parts.light,
      state: "idle", t: Math.random() * Math.PI * 2, openT: 0, sinkT: 0,
      glintTimer: 1 + Math.random() * 2,
    });
  }

  function rollChestReward(x, z) {
    const upgradeable = MG.weapons.owned.filter((w) => w.level < w.def.maxLevel);
    let roll = Math.random();
    if (roll < 0.6 && upgradeable.length === 0) roll = 0.9; // nothing to upgrade -> fall back to jackpot
    if (roll < 0.6) {
      const inst = upgradeable[Math.floor(Math.random() * upgradeable.length)];
      inst.levelUp();
      showToast(inst.def.icon + " " + inst.def.name + " Lv " + inst.level + "!");
    } else if (roll < 0.85) {
      spawnFoodBurst(x, z, 1.5);
      showToast("📦 Ein Snack fällt heraus!");
    } else {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        MG.spawnGem(x + Math.cos(a) * 0.6, z + Math.sin(a) * 0.6, 5);
      }
      showToast("💰 XP-Jackpot!");
    }
  }

  function openChest(chest) {
    chest.state = "opening";
    chest.openT = 0;
    MG.sfx.levelup();
    MG.addParticles(chest.x, chest.z, "#ffd54a", 24);
    rollChestReward(chest.x, chest.z);
  }

  function disposeChest(c) {
    MG.scene.remove(c.group);
    // Geometries/materials are module-level templates reused by every chest
    // instance for the whole page session — nothing per-instance to free.
    // The PointLight owns no GPU resource either.
  }

  function updateChests(dt) {
    const p = MG.player;
    chestSpawnTimer -= dt;
    if (chestSpawnTimer <= 0 && chests.length < CHEST_MAX_ALIVE) {
      spawnChest(p.x, p.z);
      chestSpawnTimer = nextChestDelay();
    }
    for (let i = chests.length - 1; i >= 0; i--) {
      const c = chests[i];
      c.t += dt;
      if (c.state === "idle") {
        c.group.position.y = 0.05 + Math.sin(c.t * 1.6) * 0.05;
        c.glintTimer -= dt;
        if (c.glintTimer <= 0) {
          MG.addParticles(c.x, c.z, "#ffe38a", 3);
          c.glintTimer = 1.5 + Math.random() * 2.5;
        }
        if (Math.hypot(p.x - c.x, p.z - c.z) < p.r + CHEST_OPEN_PAD) openChest(c);
      } else if (c.state === "opening") {
        c.openT += dt;
        const t = Math.min(1, c.openT / CHEST_LID_OPEN_TIME);
        c.lidGroup.rotation.x = -t * 2.1;
        if (t >= 1) c.state = "sinking";
      } else if (c.state === "sinking") {
        c.sinkT += dt;
        const t = Math.min(1, c.sinkT / CHEST_SINK_TIME);
        c.group.position.y = 0.05 - t * 0.6;
        c.group.scale.setScalar(Math.max(0.001, 1 - t));
        c.light.intensity = 0.5 * (1 - t);
        if (t >= 1) { disposeChest(c); chests.splice(i, 1); }
      }
    }
  }

  function resetChests() {
    for (const c of chests) disposeChest(c);
    chests.length = 0;
    chestSpawnTimer = nextChestDelay();
  }

  // =========================================================================
  // Food (Essen)
  // =========================================================================
  const FOOD_TYPES = [
    { id: "brezel", icon: "🥨", weight: 0.50, heal: 30, label: "+30 HP" },
    { id: "schnitzel", icon: "🥩", weight: 0.25, heal: 60, label: "+60 HP" },
    { id: "mass", icon: "🍺", weight: 0.15, berserk: 8, label: "Berserk! 8s" },
    { id: "kaesebrot", icon: "🧀", weight: 0.10, heal: 20, maxHpBonus: 10, label: "+10 max HP, +20 HP" },
  ];
  const FOOD_MAX_ALIVE = 5;
  const FOOD_LIFETIME = 45;
  const FOOD_BLINK_START = 5;
  const FOOD_PICKUP_PAD = 0.5;
  const FOOD_DEATH_DROP_CHANCE = 0.04;
  const FOOD_POP_TIME = 0.25;

  function pickFoodType() {
    let r = Math.random(), acc = 0;
    for (const t of FOOD_TYPES) { acc += t.weight; if (r <= acc) return t; }
    return FOOD_TYPES[0];
  }
  function foodTypeById(id) {
    return FOOD_TYPES.find((t) => t.id === id) || pickFoodType();
  }

  const foodTexCache = {};
  function foodTexture(icon) {
    if (foodTexCache[icon]) return foodTexCache[icon];
    const cnv = document.createElement("canvas");
    cnv.width = 64; cnv.height = 64;
    const c2 = cnv.getContext("2d");
    c2.font = "48px sans-serif";
    c2.textAlign = "center"; c2.textBaseline = "middle";
    c2.fillText(icon, 32, 36);
    const tex = new THREE.CanvasTexture(cnv);
    foodTexCache[icon] = tex; // small fixed set of icons, kept for the page's lifetime
    return tex;
  }

  const foodItems = [];
  function spawnFood(x, z, type) {
    const t = type || pickFoodType();
    const mat = new THREE.SpriteMaterial({ map: foodTexture(t.icon), transparent: true, depthTest: false });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(0.01, 0.01, 1);
    spr.position.set(x, 0.5, z);
    MG.scene.add(spr);
    foodItems.push({ x, z, type: t, sprite: spr, mat, age: 0, popT: 0 });
  }
  function spawnFoodBurst(x, z, dist) {
    if (foodItems.length >= FOOD_MAX_ALIVE) return;
    const a = Math.random() * Math.PI * 2;
    spawnFood(x + Math.cos(a) * dist, z + Math.sin(a) * dist);
  }
  function onEnemyDeath(x, z) {
    if (foodItems.length >= FOOD_MAX_ALIVE) return;
    if (Math.random() < FOOD_DEATH_DROP_CHANCE) spawnFood(x, z);
  }

  let berserkUntil = 0;
  let berserkParticleTimer = 0;

  function applyFoodEffect(t) {
    const p = MG.player;
    if (t.maxHpBonus) p.stats.maxHp += t.maxHpBonus;
    if (t.heal) p.hp = Math.min(p.stats.maxHp, p.hp + t.heal);
    if (t.berserk) berserkUntil = MG.time + t.berserk;
    spawnFloatText(p.x, p.z, t.label, t.berserk ? "#ffd54a" : "#9dffb0");
    MG.sfx.pickup();
    MG.addParticles(p.x, p.z, t.berserk ? "#ffd54a" : "#9dffb0", 10);
  }

  function disposeFood(f) {
    MG.scene.remove(f.sprite);
    f.mat.dispose(); // per-instance SpriteMaterial; the cached texture is reused, not disposed here
  }

  function updateFood(dt) {
    const p = MG.player;
    if (MG.time < berserkUntil) {
      berserkParticleTimer -= dt;
      if (berserkParticleTimer <= 0) {
        MG.addParticles(p.x, p.z, "#ffd54a", 2);
        berserkParticleTimer = 0.12;
      }
    }
    for (let i = foodItems.length - 1; i >= 0; i--) {
      const f = foodItems[i];
      f.age += dt;
      f.popT = Math.min(1, f.popT + dt / FOOD_POP_TIME);
      const bob = Math.sin(f.age * 3) * 0.06;
      f.sprite.position.set(f.x, 0.45 + bob, f.z);
      const scale = 0.5 * f.popT;
      f.sprite.scale.set(scale, scale, 1);
      const remain = FOOD_LIFETIME - f.age;
      f.mat.opacity = remain <= FOOD_BLINK_START ? (Math.floor(f.age * 8) % 2 === 0 ? 1 : 0.15) : 1;
      if (remain <= 0) { disposeFood(f); foodItems.splice(i, 1); continue; }
      if (Math.hypot(p.x - f.x, p.z - f.z) < p.r + FOOD_PICKUP_PAD) {
        applyFoodEffect(f.type);
        disposeFood(f);
        foodItems.splice(i, 1);
      }
    }
    updateFloaters(dt);
  }

  function resetFood() {
    for (const f of foodItems) disposeFood(f);
    foodItems.length = 0;
    berserkUntil = 0;
    berserkParticleTimer = 0;
    resetFloaters();
  }

  // =========================================================================
  // Shrines (Schreine) — permanent upgrades for the run
  // -------------------------------------------------------------------------
  // A rare obelisk pickup (first at 60s, then every 100-140s, max 1 alive,
  // never despawns) that grants one random PERMANENT buff for the rest of
  // the run by mutating the player's multiplier stats:
  //   dmgMult  — applied inside core.js hitEnemy() (all weapon damage)
  //   xpMult   — applied inside core.js addXP()
  //   cdMult   — applied inside weapons.js getCooldownMult()
  //   speed / maxHp — direct stat bumps
  // Shrines are shown on the minimap (⭐) and clamped to its rim when far.
  // =========================================================================
  const SHRINE_FIRST_AT = 60;
  const SHRINE_MIN_INTERVAL = 100, SHRINE_MAX_INTERVAL = 140;
  const SHRINE_MAX_ALIVE = 1;
  const SHRINE_SPAWN_MIN_DIST = 12, SHRINE_SPAWN_MAX_DIST = 20;
  const SHRINE_PICKUP_PAD = 0.7;
  const SHRINE_SINK_TIME = 0.6;

  const SHRINE_BUFFS = [
    { icon: "💪", label: "+15% Schaden", apply(p) { p.stats.dmgMult *= 1.15; } },
    { icon: "👟", label: "+10% Tempo", apply(p) { p.stats.speed *= 1.10; } },
    { icon: "❤️", label: "+20 max HP", apply(p) { p.stats.maxHp += 20; p.hp = Math.min(p.stats.maxHp, p.hp + 20); } },
    { icon: "✨", label: "+15% XP", apply(p) { p.stats.xpMult *= 1.15; } },
    { icon: "⚡", label: "-8% Abklingzeit", apply(p) { p.stats.cdMult *= 0.92; } },
  ];

  const shrinePillarGeo = new THREE.BoxGeometry(0.34, 1.4, 0.34);
  const shrineBaseGeo = new THREE.BoxGeometry(0.7, 0.18, 0.7);
  const shrineGemGeo = new THREE.IcosahedronGeometry(0.2, 0);
  const shrineStoneMat = new THREE.MeshStandardMaterial({ color: 0x9a9d99, roughness: 0.85 });
  const shrineGemMat = new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0xcc8800, emissiveIntensity: 1.2, roughness: 0.4 });

  const shrines = [];
  function nextShrineDelay() { return SHRINE_MIN_INTERVAL + Math.random() * (SHRINE_MAX_INTERVAL - SHRINE_MIN_INTERVAL); }
  let shrineSpawnAt = SHRINE_FIRST_AT;

  function spawnShrine(px, pz) {
    const a = Math.random() * Math.PI * 2;
    const d = SHRINE_SPAWN_MIN_DIST + Math.random() * (SHRINE_SPAWN_MAX_DIST - SHRINE_SPAWN_MIN_DIST);
    const x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
    const group = new THREE.Group();
    const base = new THREE.Mesh(shrineBaseGeo, shrineStoneMat);
    base.position.y = 0.09;
    group.add(base);
    const pillar = new THREE.Mesh(shrinePillarGeo, shrineStoneMat);
    pillar.position.y = 0.7 + 0.18;
    group.add(pillar);
    const gem = new THREE.Mesh(shrineGemGeo, shrineGemMat);
    gem.position.y = 1.75;
    group.add(gem);
    const light = new THREE.PointLight(0xffd54a, 0.7, 4);
    light.position.y = 1.8;
    group.add(light);
    group.position.set(x, 0, z);
    MG.scene.add(group);
    shrines.push({ x, z, group, gem, light, t: Math.random() * Math.PI * 2, state: "idle", sinkT: 0, glintTimer: 1 });
  }

  function collectShrine(s) {
    s.state = "sinking";
    const buff = SHRINE_BUFFS[Math.floor(Math.random() * SHRINE_BUFFS.length)];
    buff.apply(MG.player);
    MG.sfx.levelup();
    MG.addParticles(s.x, s.z, "#ffd54a", 26);
    showToast("⛩️ Schrein: " + buff.icon + " " + buff.label + " (permanent)");
    spawnFloatText(s.x, s.z, buff.label, "#ffd54a");
  }

  function disposeShrine(s) {
    MG.scene.remove(s.group);
    // Geometries/materials are shared module-level templates; nothing
    // per-instance to free (PointLight owns no GPU resource).
  }

  function updateShrines(dt) {
    const p = MG.player;
    if (MG.time >= shrineSpawnAt && shrines.length < SHRINE_MAX_ALIVE) {
      spawnShrine(p.x, p.z);
      shrineSpawnAt = MG.time + nextShrineDelay();
    }
    for (let i = shrines.length - 1; i >= 0; i--) {
      const s = shrines[i];
      s.t += dt;
      if (s.state === "idle") {
        s.gem.position.y = 1.75 + Math.sin(s.t * 2) * 0.08;
        s.gem.rotation.y += dt * 1.4;
        s.light.intensity = 0.55 + Math.sin(s.t * 2.6) * 0.25;
        s.glintTimer -= dt;
        if (s.glintTimer <= 0) {
          MG.addParticles(s.x, s.z, "#ffe38a", 2);
          s.glintTimer = 1.2 + Math.random() * 1.6;
        }
        if (Math.hypot(p.x - s.x, p.z - s.z) < p.r + SHRINE_PICKUP_PAD) collectShrine(s);
      } else {
        s.sinkT += dt;
        const t = Math.min(1, s.sinkT / SHRINE_SINK_TIME);
        s.group.position.y = -t * 1.9;
        s.light.intensity = 0.7 * (1 - t);
        if (t >= 1) { disposeShrine(s); shrines.splice(i, 1); }
      }
    }
  }

  function resetShrines() {
    for (const s of shrines) disposeShrine(s);
    shrines.length = 0;
    shrineSpawnAt = SHRINE_FIRST_AT;
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  MG.chests = {
    update: updateChests,
    reset: resetChests,
    get list() { return chests; },
    // QA/test seam: force a chest to spawn near the player right now,
    // bypassing the timer (still respects CHEST_MAX_ALIVE).
    spawnNow() { if (chests.length < CHEST_MAX_ALIVE) spawnChest(MG.player.x, MG.player.z); },
    // Exact-position spawn (boss drops). Deliberately ignores
    // CHEST_MAX_ALIVE: a boss kill always pays out.
    spawnAt(x, z) { spawnChestAt(x, z); },
  };

  MG.shrines = {
    update: updateShrines,
    reset: resetShrines,
    get list() { return shrines; },
    // QA/test seam: force a shrine near the player, bypassing the timer.
    spawnNow() { if (shrines.length < SHRINE_MAX_ALIVE) spawnShrine(MG.player.x, MG.player.z); },
  };

  MG.food = {
    update: updateFood,
    reset: resetFood,
    onEnemyDeath,
    cooldownMult() { return MG.time < berserkUntil ? 0.6 : 1; },
    get berserkUntil() { return berserkUntil; },
    get list() { return foodItems; },
    // QA/test seam: force-spawn a specific (or random) food type at a spot.
    spawnAt(x, z, id) { spawnFood(x, z, id ? foodTypeById(id) : undefined); },
  };
})();
