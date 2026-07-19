// ============================================================================
// Peitsch den Markus: Survivors — WEAPON FRAMEWORK (3D / three.js)
// ----------------------------------------------------------------------------
// This is the API a second agent will build new weapons against. Keep it
// small; add new weapons by pushing a WeaponDef into MG.weapons.registry
// (see the "Klassische Peitsche" below for a full worked example) and, if
// it should be choosable on level-up, wiring it into getLevelUpOptions()
// at the bottom of this file.
//
// ---- Types -----------------------------------------------------------------
//
//   WeaponDef = {
//     id: string,              unique id, e.g. 'klassisch'
//     name: string,            display name (German)
//     icon: string,            single emoji — used in the HUD row and on
//                              level-up cards
//     desc: string,            one-line description for level-up cards
//     maxLevel: number,
//     create(game): WeaponInstance
//                              factory. Called once when the weapon is
//                              (re)acquired at game start / on pick.
//   }
//
//   WeaponInstance = {
//     def: WeaponDef,
//     level: number,           starts at 1
//     update(dt, game),        called every simulation frame while state
//                              === 'playing'. This is ALSO where the
//                              instance must create/update/animate any
//                              three.js objects it wants visible — there is
//                              no separate draw() call in the 3D engine.
//                              Add objects to `game.fxRoot` (see below).
//     levelUp(),               bump level (clamp to def.maxLevel) and make
//                              the instance re-read its own per-level stat
//                              table on the next update()
//     dispose(game),           OPTIONAL. Called once by core.js right
//                              before a run resets (before fxRoot itself is
//                              cleared). Use it to drop references (e.g.
//                              WeakMaps) or do any cleanup beyond what
//                              fxRoot's automatic geometry/material
//                              disposal already covers (see fxRoot below).
//                              Not required if the instance owns nothing
//                              outside fxRoot.
//   }
//   Instances own all of their private state — cooldown timers, active
//   projectiles/effect meshes, etc. Core never reaches into an instance's
//   internals.
//
// ---- Registries --------------------------------------------------------
//
//   MG.weapons.registry : Array<WeaponDef>
//     All weapons that exist in the game, whether owned yet or not.
//
//   MG.weapons.owned : Array<WeaponInstance>
//     Weapons the player currently has equipped. core.js calls update() on
//     every entry each simulation frame. The starting weapon ('klassisch')
//     is auto-created into this array by core.js's resetGame() when a run
//     begins.
//
// ---- The `game` object (== the MG namespace) ------------------------------
//
// core.js passes its MG namespace itself as `game` into create()/update().
// It exposes:
//
//   game.WORLD_SCALE            2D-px -> world-unit ratio (40 px == 1 unit).
//   game.px(n)                  convenience: n(px, as tuned in the original
//                                2D game) -> world units. Use this when
//                                porting/writing any SPATIAL stat (radius,
//                                range, speed, knockback, w/h...) so the
//                                original 2D tuning numbers stay legible
//                                and the math stays consistent. Do NOT
//                                scale pure multipliers/ratios (e.g. a "x6"
//                                factor) or non-spatial stats (damage, HP,
//                                XP, cooldown seconds) — see js/core.js's
//                                header comment for the full rationale.
//   game.FX_Y                   small world-Y lift (0.05) effect meshes
//                                should sit at, to avoid z-fighting with
//                                the ground plane.
//   game.scene                  THREE.Scene — avoid adding directly to
//                                this; prefer game.fxRoot (below) so your
//                                objects get cleaned up automatically.
//   game.fxRoot                 THREE.Group, already in the scene. Add any
//                                three.js Object3D your weapon creates
//                                (meshes, sprites, groups...) here. On every
//                                resetGame(), core.js walks fxRoot, disposes
//                                every child's geometry + material, and
//                                empties the group — so a weapon that just
//                                adds plain THREE.Mesh objects here needs NO
//                                manual cleanup at all.
//                                If you want a persistent geometry/material
//                                that's reused across many effect instances
//                                (to avoid per-frame allocation) instead of
//                                one-object-per-effect, set `.shared = true`
//                                on that geometry/material — fxRoot's
//                                automatic disposal SKIPS anything flagged
//                                `.shared`, so you own its lifecycle. Free
//                                it yourself in your instance's optional
//                                dispose(game) hook if it was created fresh
//                                in create() (module-level shared templates
//                                that live for the whole page session don't
//                                need freeing at all).
//   game.player                 { x, z, r, hp, invuln,
//                                  stats: { speed, maxHp, regen, pickupRadius },
//                                  facing: { x, z } }   // unit vector, last nonzero move dir
//   game.enemies                live Array<enemy>; each enemy has at least
//                                { x, z, r, hp, maxHp, dead }
//   game.time                   seconds of survival time elapsed this run
//   game.hitEnemy(enemy, dmg, opts)
//                                applies damage, hit-flash, knockback,
//                                floating damage number, and handles death
//                                (particles + XP gem drop + kill count).
//                                opts: { fromX, fromZ, knockback } — fromX/Z
//                                is the source point knockback pushes away
//                                from (defaults to player position);
//                                knockback is a world-units/s impulse
//                                magnitude (default game.px(140)).
//   game.enemiesInRadius(x,z,r) -> Array<enemy>  (alive enemies only)
//   game.nearestEnemy(x,z,maxDist) -> enemy | null
//   game.addParticles(x,z,colorHex,n)
//   game.sfx.crack() / .hit() / .pickup() / .levelup() / .hurt()
//
// ============================================================================

(function () {
  "use strict";

  const MG = (window.MG = window.MG || {});
  MG.weapons = MG.weapons || { registry: [], owned: [] };

  // Global cooldown multiplier applied by every cooldown-based weapon.
  // Derived (not stored) from the Sanduhr passive's level so a fresh run
  // (which just empties MG.weapons.owned) automatically resets it — no
  // extra reset hook needed. (Sanduhr itself is re-added by agent 2.)
  MG.weapons.getCooldownMult = function () {
    const inst = MG.weapons.owned.find((w) => w.def.id === "uhr");
    let mult = inst ? Math.pow(0.9, inst.level) : 1;
    // Berserk food buff (Part 3, js/systems.js) stacks multiplicatively on
    // top of Sanduhr. Duck-typed so weapons.js has zero hard dependency on
    // systems.js being loaded.
    if (MG.food && typeof MG.food.cooldownMult === "function") mult *= MG.food.cooldownMult();
    return mult;
  };

  // ==========================================================================
  // Reference weapon: Klassische Peitsche (id 'klassisch')
  // Auto-acquired at game start. Cracks on the facing side every `cooldown`
  // seconds, hitting everything inside a `w` x `h` world-unit rectangle on
  // the XZ ground plane that starts at the player and extends forward
  // along the facing direction.
  //
  // All per-level numbers live in one data table (WHIP_LEVELS) — nothing
  // about levels is hardcoded inline in the update/strike logic. Spatial
  // stats (w, h) are converted from the original 2D px tuning via
  // MG.px(); damage/cooldown/sides are not spatial and stay as-is.
  // ==========================================================================

  // L3 scales area by exactly 1.3x while keeping the 160:70 aspect ratio.
  const WHIP_AREA_SCALE = Math.sqrt(1.3);

  const WHIP_LEVELS = [
    null, // levels are 1-indexed to match WeaponInstance.level
    { cooldown: 1.1, dmg: 15, w: MG.px(160), h: MG.px(70), sides: 1 },
    { cooldown: 1.1, dmg: 25, w: MG.px(160), h: MG.px(70), sides: 1 },                                             // L2: +10 dmg
    { cooldown: 1.1, dmg: 25, w: MG.px(160 * WHIP_AREA_SCALE), h: MG.px(70 * WHIP_AREA_SCALE), sides: 1 },         // L3: area x1.3
    { cooldown: 1.1, dmg: 25, w: MG.px(160 * WHIP_AREA_SCALE), h: MG.px(70 * WHIP_AREA_SCALE), sides: 2 },         // L4: also cracks opposite side
    { cooldown: 1.1, dmg: 40, w: MG.px(160 * WHIP_AREA_SCALE), h: MG.px(70 * WHIP_AREA_SCALE), sides: 2 },         // L5: +15 dmg
  ];

  function describeWhipLevel(lvl) {
    const s = WHIP_LEVELS[lvl];
    const bits = [Math.round(s.dmg) + " Schaden"];
    if (s.sides >= 2) bits.push("trifft beide Seiten");
    return "Peitsche Lv" + lvl + ": " + bits.join(", ");
  }

  const WHIP_FX_LIFE = 0.15; // seconds
  const whipSlashMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
  });

  const whipDef = {
    id: "klassisch",
    name: "Klassische Peitsche",
    icon: "🪢",
    desc: "Peitscht automatisch nach vorn.",
    maxLevel: WHIP_LEVELS.length - 1,
    type: "weapon",
    describeLevel: describeWhipLevel,
    create(game) {
      return {
        def: whipDef,
        level: 1,
        _cd: 0,
        _fx: [], // active visual slashes: { group, mat, life: 1 -> 0 over WHIP_FX_LIFE }

        update(dt, game) {
          this._cd -= dt;
          if (this._cd <= 0) {
            this._crack(game);
            this._cd = WHIP_LEVELS[this.level].cooldown * MG.weapons.getCooldownMult();
          }
          for (let i = this._fx.length - 1; i >= 0; i--) {
            const fx = this._fx[i];
            fx.life -= dt / WHIP_FX_LIFE;
            if (fx.life <= 0) {
              game.fxRoot.remove(fx.group);
              fx.geo.dispose();
              fx.mat.dispose();
              this._fx.splice(i, 1);
            } else {
              fx.mat.opacity = Math.max(0, fx.life) * 0.85;
            }
          }
        },

        _crack(game) {
          const stats = WHIP_LEVELS[this.level];
          const p = game.player;
          let fx = p.facing.x, fz = p.facing.z;
          if (Math.hypot(fx, fz) < 0.01) { fx = 1; fz = 0; } // default: face +x
          const angle = Math.atan2(fz, fx);
          this._strike(game, p.x, p.z, angle, stats);
          game.sfx.crack();
          if (stats.sides >= 2) this._strike(game, p.x, p.z, angle + Math.PI, stats);
        },

        // Rectangular hitbox check on the XZ plane: rotate each enemy into
        // the strike's local space (fwd = forward along facing, side =
        // perpendicular), then test against [0,w] x [-h/2,h/2], padded by
        // the enemy radius.
        _strike(game, px, pz, angle, stats) {
          this._spawnSlashFx(game, px, pz, angle, stats);
          const cos = Math.cos(angle), sin = Math.sin(angle);
          for (const e of game.enemies) {
            if (e.dead) continue;
            const dx = e.x - px, dz = e.z - pz;
            const fwd = dx * cos + dz * sin;
            const side = -dx * sin + dz * cos;
            if (fwd >= -e.r && fwd <= stats.w + e.r && side >= -stats.h / 2 - e.r && side <= stats.h / 2 + e.r) {
              game.hitEnemy(e, stats.dmg, { fromX: px, fromZ: pz, knockback: MG.px(160) });
            }
          }
        },

        // Visual: a thin partial-ring arc that scales with the hitbox and
        // fades out over WHIP_FX_LIFE. Built fresh per crack (cheap, low
        // frequency) and disposed either when its fade finishes or when
        // fxRoot is cleared on reset — never leaked.
        _spawnSlashFx(game, px, pz, angle, stats) {
          const halfAngle = Math.atan2(stats.h / 2, stats.w) * 1.1;
          const outerR = stats.w * 0.6;
          const innerR = outerR * 0.82;
          const geo = new THREE.RingGeometry(innerR, outerR, 24, 1, -halfAngle, halfAngle * 2);
          const mat = whipSlashMat.clone();
          const mesh = new THREE.Mesh(geo, mat);
          mesh.rotation.x = -Math.PI / 2; // lay flat; local +X (theta=0) stays the group's forward axis
          const group = new THREE.Group();
          group.position.set(px, game.FX_Y, pz);
          group.rotation.y = angle;
          group.add(mesh);
          game.fxRoot.add(group);
          this._fx.push({ group, geo, mat, life: 1 });
        },

        levelUp() {
          this.level = Math.min(this.level + 1, whipDef.maxLevel);
        },

        dispose(game) {
          for (const fx of this._fx) {
            game.fxRoot.remove(fx.group);
            fx.geo.dispose();
            fx.mat.dispose();
          }
          this._fx.length = 0;
        },
      };
    },
  };

  MG.weapons.registry.push(whipDef);

  // ==========================================================================
  // Shared helper: normalize an angle difference into [-PI, PI].
  // ==========================================================================
  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // ==========================================================================
  // Kreiselpeitsche (id 'kreisel') — whip-knot tips orbit the player and
  // damage anything they touch, gated by a per-enemy hit cooldown (WeakMap)
  // so a stationary enemy isn't melted every frame.
  //
  // Visual: persistent gold knot meshes (pre-built once, up to the max tip
  // count) + 2 trailing fainter copies per tip computed purely from the
  // current orbit angle (motion is a pure circle, so no position-history
  // bookkeeping is needed for the trail).
  // ==========================================================================
  const KREISEL_LEVELS = [
    null,
    { tips: 1, radius: MG.px(100), speed: 2.6, dmg: 10 },
    { tips: 2, radius: MG.px(100), speed: 2.6, dmg: 10 },  // L2: +1 tip
    { tips: 2, radius: MG.px(100), speed: 2.6, dmg: 16 },  // L3: +6 dmg
    { tips: 3, radius: MG.px(115), speed: 2.6, dmg: 16 },  // L4: +1 tip, +radius
    { tips: 3, radius: MG.px(115), speed: 3.4, dmg: 24 },  // L5: +8 dmg, faster spin
  ];
  const KREISEL_HIT_CD = 0.5;
  const KREISEL_TIP_R = MG.px(10);
  const KREISEL_MAX_TIPS = 3;

  function describeKreiselLevel(lvl) {
    const s = KREISEL_LEVELS[lvl];
    return "Kreiselpeitsche Lv" + lvl + ": " + s.tips + " Spitze" + (s.tips > 1 ? "n" : "") + ", " + s.dmg + " Schaden";
  }

  const kreiselKnotGeo = new THREE.SphereGeometry(1, 10, 8);
  kreiselKnotGeo.shared = true;
  const kreiselKnotMat = new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0x7a4a1e, emissiveIntensity: 0.6, roughness: 0.4 });
  kreiselKnotMat.shared = true;
  const kreiselTrailMats = [0.4, 0.22].map((op) => {
    const m = new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: op, depthWrite: false });
    m.shared = true;
    return m;
  });

  const kreiselDef = {
    id: "kreisel",
    name: "Kreiselpeitsche",
    icon: "🌀",
    desc: "Peitschenspitzen kreisen um dich und verletzen alles, was sie berühren.",
    maxLevel: KREISEL_LEVELS.length - 1,
    type: "weapon",
    describeLevel: describeKreiselLevel,
    create(game) {
      const root = new THREE.Group();
      const tipObjs = [];
      for (let i = 0; i < KREISEL_MAX_TIPS; i++) {
        const knot = new THREE.Mesh(kreiselKnotGeo, kreiselKnotMat);
        knot.scale.setScalar(KREISEL_TIP_R);
        root.add(knot);
        const trails = kreiselTrailMats.map((m) => {
          const t = new THREE.Mesh(kreiselKnotGeo, m);
          t.scale.setScalar(KREISEL_TIP_R * 0.7);
          root.add(t);
          return t;
        });
        tipObjs.push({ knot, trails });
      }
      game.fxRoot.add(root);
      return {
        def: kreiselDef,
        level: 1,
        _angle: 0,
        _lastHit: new WeakMap(),
        _root: root,
        _tipObjs: tipObjs,

        update(dt, game) {
          const s = KREISEL_LEVELS[this.level];
          this._angle += s.speed * dt;
          const p = game.player;
          this._root.position.set(p.x, game.FX_Y, p.z);
          for (let i = 0; i < KREISEL_MAX_TIPS; i++) {
            const obj = this._tipObjs[i];
            const active = i < s.tips;
            obj.knot.visible = active;
            obj.trails.forEach((t) => (t.visible = active));
            if (!active) continue;
            const a = this._angle + (i / s.tips) * Math.PI * 2;
            const tx = Math.cos(a) * s.radius, tz = Math.sin(a) * s.radius;
            obj.knot.position.set(tx, 0, tz);
            obj.trails.forEach((t, k) => {
              const ta = a - (k + 1) * 0.2;
              t.position.set(Math.cos(ta) * s.radius, 0, Math.sin(ta) * s.radius);
            });
            const wx = p.x + tx, wz = p.z + tz;
            for (const e of game.enemies) {
              if (e.dead) continue;
              const d = Math.hypot(e.x - wx, e.z - wz);
              if (d <= e.r + KREISEL_TIP_R) {
                const last = this._lastHit.get(e);
                if (last === undefined || game.time - last >= KREISEL_HIT_CD) {
                  this._lastHit.set(e, game.time);
                  game.hitEnemy(e, s.dmg, { fromX: wx, fromZ: wz, knockback: MG.px(90) });
                }
              }
            }
          }
        },

        levelUp() { this.level = Math.min(this.level + 1, kreiselDef.maxLevel); },
      };
    },
  };
  MG.weapons.registry.push(kreiselDef);

  // ==========================================================================
  // Blitzpeitsche (id 'blitz') — periodic lightning strike on the nearest
  // enemy, optionally chaining to nearby additional victims at half damage.
  // Visual: a jagged 3D polyline (THREE.Line, fresh geometry per strike)
  // from just above the player down to each victim in turn, fading fast.
  // ==========================================================================
  const BLITZ_LEVELS = [
    null,
    { cooldown: 2.0, dmg: 25, range: MG.px(350), chains: 0, chainRange: MG.px(140) },
    { cooldown: 1.6, dmg: 25, range: MG.px(350), chains: 0, chainRange: MG.px(140) }, // L2: faster
    { cooldown: 1.6, dmg: 25, range: MG.px(350), chains: 2, chainRange: MG.px(140) }, // L3: chains
    { cooldown: 1.6, dmg: 35, range: MG.px(350), chains: 2, chainRange: MG.px(140) }, // L4: +10 dmg
    { cooldown: 1.1, dmg: 35, range: MG.px(350), chains: 4, chainRange: MG.px(140) }, // L5: faster, more chains
  ];

  function describeBlitzLevel(lvl) {
    const s = BLITZ_LEVELS[lvl];
    const bits = [Math.round(s.dmg) + " Schaden", "Cooldown " + s.cooldown.toFixed(1) + "s"];
    if (s.chains > 0) bits.push("bis zu " + s.chains + " Kettenblitze");
    return "Blitzpeitsche Lv" + lvl + ": " + bits.join(", ");
  }

  const BLITZ_FX_LIFE = 0.2;
  const blitzMatTemplate = new THREE.LineBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });

  const blitzDef = {
    id: "blitz",
    name: "Blitzpeitsche",
    icon: "⚡",
    desc: "Entfesselt in Abständen einen Blitzschlag auf den nächsten Feind.",
    maxLevel: BLITZ_LEVELS.length - 1,
    type: "weapon",
    describeLevel: describeBlitzLevel,
    create(game) {
      return {
        def: blitzDef,
        level: 1,
        _cd: 0.3,
        _bolts: [], // { line, geo, mat, life: 1 -> 0 over BLITZ_FX_LIFE }

        update(dt, game) {
          this._cd -= dt;
          if (this._cd <= 0) {
            this._strike(game);
            this._cd = BLITZ_LEVELS[this.level].cooldown * MG.weapons.getCooldownMult();
          }
          for (let i = this._bolts.length - 1; i >= 0; i--) {
            const b = this._bolts[i];
            b.life -= dt / BLITZ_FX_LIFE;
            if (b.life <= 0) {
              game.fxRoot.remove(b.line);
              b.geo.dispose();
              b.mat.dispose();
              this._bolts.splice(i, 1);
            } else {
              b.mat.opacity = Math.max(0, b.life) * 0.9;
            }
          }
        },

        _strike(game) {
          const s = BLITZ_LEVELS[this.level];
          const p = game.player;
          const first = game.nearestEnemy(p.x, p.z, s.range);
          if (!first) return;
          const hitSet = new Set([first]);
          const points = [{ x: p.x, z: p.z }, { x: first.x, z: first.z }];
          game.hitEnemy(first, s.dmg, { fromX: p.x, fromZ: p.z, knockback: MG.px(120) });
          game.addParticles(first.x, first.z, "#eaffff", 6);
          let prev = first;
          for (let c = 0; c < s.chains; c++) {
            let best = null, bestD = s.chainRange;
            for (const e of game.enemies) {
              if (e.dead || hitSet.has(e)) continue;
              const d = Math.hypot(e.x - prev.x, e.z - prev.z);
              if (d <= bestD) { bestD = d; best = e; }
            }
            if (!best) break;
            hitSet.add(best);
            points.push({ x: best.x, z: best.z });
            game.hitEnemy(best, s.dmg * 0.5, { fromX: prev.x, fromZ: prev.z, knockback: MG.px(90) });
            game.addParticles(best.x, best.z, "#eaffff", 4);
            prev = best;
          }
          this._spawnBolt(game, points);
          game.sfx.hit();
        },

        // Builds a jittered polyline through `points` (player -> victim ->
        // chained victims), dipping from a small height above the player
        // down to the ground at the first victim and staying grounded for
        // any further chain segments.
        _spawnBolt(game, points) {
          const verts = [];
          const topY = 1.7;
          for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            const ay = i === 0 ? topY : MG.FX_Y;
            const by = MG.FX_Y;
            const segs = 5;
            for (let j = 0; j <= segs; j++) {
              const t = j / segs;
              let x = a.x + (b.x - a.x) * t;
              let z = a.z + (b.z - a.z) * t;
              let y = ay + (by - ay) * t;
              if (j > 0 && j < segs) {
                const nx = -(b.z - a.z), nz = (b.x - a.x);
                const nlen = Math.hypot(nx, nz) || 1;
                const jag = (Math.random() - 0.5) * MG.px(18);
                x += (nx / nlen) * jag;
                z += (nz / nlen) * jag;
                y += (Math.random() - 0.5) * 0.15;
              }
              verts.push(x, y, z);
            }
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
          const mat = blitzMatTemplate.clone();
          const line = new THREE.Line(geo, mat);
          game.fxRoot.add(line);
          this._bolts.push({ line, geo, mat, life: 1 });
        },

        levelUp() { this.level = Math.min(this.level + 1, blitzDef.maxLevel); },
      };
    },
  };
  MG.weapons.registry.push(blitzDef);

  // ==========================================================================
  // Flammenpeitsche (id 'flamme') — periodic cone lash plus burning ground
  // patches dropped along the cone's center line.
  // ==========================================================================
  const FLAMME_LEVELS = [
    null,
    { cooldown: 2.5, coneDmg: 12, patches: 3, patchLife: 3, burnDps: 8 },
    { cooldown: 2.5, coneDmg: 12, patches: 3, patchLife: 5, burnDps: 8 },  // L2: longer-lived patches
    { cooldown: 2.5, coneDmg: 20, patches: 3, patchLife: 5, burnDps: 8 },  // L3: +8 cone dmg
    { cooldown: 2.5, coneDmg: 20, patches: 5, patchLife: 5, burnDps: 14 }, // L4: +2 patches, +burn
    { cooldown: 1.7, coneDmg: 20, patches: 5, patchLife: 5, burnDps: 14 }, // L5: faster
  ];
  const FLAMME_CONE_HALF_ANGLE = (35 * Math.PI) / 180;
  const FLAMME_CONE_LEN = MG.px(190);
  const FLAMME_PATCH_R = MG.px(36);
  const FLAMME_TICK = 0.4;

  function describeFlammeLevel(lvl) {
    const s = FLAMME_LEVELS[lvl];
    return "Flammenpeitsche Lv" + lvl + ": " + s.coneDmg + " Kegel-Schaden, " + s.patches + " Feuerflecken (" + s.burnDps + " Schaden/s)";
  }

  // Circle-sector geometry laid flat (local +X == theta=0, matches the
  // group.rotation.y = angle convention used by klassisch's slash fx above).
  const flammeConeGeo = new THREE.CircleGeometry(1, 24, -FLAMME_CONE_HALF_ANGLE, FLAMME_CONE_HALF_ANGLE * 2);
  flammeConeGeo.rotateX(-Math.PI / 2);
  flammeConeGeo.shared = true;
  const flammeConeMatTemplate = new THREE.MeshBasicMaterial({ color: 0xff8a30, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  const flammePatchGeo = new THREE.CircleGeometry(1, 20);
  flammePatchGeo.rotateX(-Math.PI / 2);
  flammePatchGeo.shared = true;
  const flammePatchMatTemplate = new THREE.MeshBasicMaterial({ color: 0xff6a20, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });

  const flammeDef = {
    id: "flamme",
    name: "Flammenpeitsche",
    icon: "🔥",
    desc: "Peitscht einen brennenden Kegel und hinterlässt Feuerflecken am Boden.",
    maxLevel: FLAMME_LEVELS.length - 1,
    type: "weapon",
    describeLevel: describeFlammeLevel,
    create(game) {
      return {
        def: flammeDef,
        level: 1,
        _cd: 0.6,
        _fx: [], // cone flashes: { group, mat, life: 1 -> 0 over 0.2s }
        _patches: [], // { x, z, life, maxLife/tick, mesh, mat }

        update(dt, game) {
          this._cd -= dt;
          if (this._cd <= 0) {
            this._lash(game);
            this._cd = FLAMME_LEVELS[this.level].cooldown * MG.weapons.getCooldownMult();
          }
          for (let i = this._fx.length - 1; i >= 0; i--) {
            const fx = this._fx[i];
            fx.life -= dt / 0.2;
            if (fx.life <= 0) {
              game.fxRoot.remove(fx.group);
              fx.mat.dispose();
              this._fx.splice(i, 1);
            } else {
              fx.mat.opacity = Math.max(0, fx.life) * 0.6;
            }
          }
          const s = FLAMME_LEVELS[this.level];
          for (let i = this._patches.length - 1; i >= 0; i--) {
            const patch = this._patches[i];
            patch.life -= dt;
            patch.tick -= dt;
            if (patch.tick <= 0) {
              patch.tick += FLAMME_TICK;
              for (const e of game.enemiesInRadius(patch.x, patch.z, FLAMME_PATCH_R)) {
                game.hitEnemy(e, s.burnDps * FLAMME_TICK, { fromX: patch.x, fromZ: patch.z, knockback: MG.px(20) });
              }
              game.addParticles(patch.x, patch.z, "#ffaa33", 2);
            }
            if (patch.life <= 0) {
              game.fxRoot.remove(patch.mesh);
              patch.mat.dispose();
              this._patches.splice(i, 1);
              continue;
            }
            patch.mat.opacity = Math.min(1, patch.life / s.patchLife) * (0.5 + 0.25 * Math.sin(game.time * 9 + patch.x));
          }
        },

        _lash(game) {
          const s = FLAMME_LEVELS[this.level];
          const p = game.player;
          let fx = p.facing.x, fz = p.facing.z;
          if (Math.hypot(fx, fz) < 0.01) { fx = 1; fz = 0; }
          const faceAngle = Math.atan2(fz, fx);
          this._spawnConeFx(game, p, faceAngle);
          for (const e of game.enemies) {
            if (e.dead) continue;
            const dx = e.x - p.x, dz = e.z - p.z;
            const dist = Math.hypot(dx, dz);
            if (dist > FLAMME_CONE_LEN + e.r) continue;
            const ang = Math.atan2(dz, dx);
            const diff = Math.abs(angleDiff(ang, faceAngle));
            const pad = Math.atan2(e.r, Math.max(dist, 1));
            if (diff <= FLAMME_CONE_HALF_ANGLE + pad) {
              game.hitEnemy(e, s.coneDmg, { fromX: p.x, fromZ: p.z, knockback: MG.px(130) });
            }
          }
          for (let i = 0; i < s.patches; i++) {
            const t = (i + 1) / (s.patches + 1);
            const dist = t * FLAMME_CONE_LEN;
            this._spawnPatch(game, p.x + fx * dist, p.z + fz * dist, s);
          }
          game.sfx.crack();
        },

        _spawnConeFx(game, p, angle) {
          const mat = flammeConeMatTemplate.clone();
          const mesh = new THREE.Mesh(flammeConeGeo, mat);
          mesh.scale.set(FLAMME_CONE_LEN, 1, FLAMME_CONE_LEN);
          const group = new THREE.Group();
          group.position.set(p.x, game.FX_Y, p.z);
          group.rotation.y = angle;
          group.add(mesh);
          game.fxRoot.add(group);
          this._fx.push({ group, mat, life: 1 });
        },

        _spawnPatch(game, x, z, s) {
          const mat = flammePatchMatTemplate.clone();
          const mesh = new THREE.Mesh(flammePatchGeo, mat);
          mesh.scale.set(FLAMME_PATCH_R, FLAMME_PATCH_R, FLAMME_PATCH_R);
          mesh.position.set(x, game.FX_Y, z);
          game.fxRoot.add(mesh);
          this._patches.push({ x, z, life: s.patchLife, tick: FLAMME_TICK, mesh, mat });
        },

        levelUp() { this.level = Math.min(this.level + 1, flammeDef.maxLevel); },
      };
    },
  };
  MG.weapons.registry.push(flammeDef);

  // ==========================================================================
  // Schleuderpeitsche (id 'schleuder') — throws spinning whip-knot
  // projectile(s) that fly out then boomerang back to the player, piercing
  // (hitting each enemy at most once outbound, once on return).
  // ==========================================================================
  const SCHLEUDER_LEVELS = [
    null,
    { cooldown: 1.8, count: 1, dmg: 18 },
    { cooldown: 1.8, count: 2, dmg: 18 }, // L2: 2nd knot thrown backwards
    { cooldown: 1.8, count: 2, dmg: 28 }, // L3: +10 dmg
    { cooldown: 1.2, count: 2, dmg: 28 }, // L4: faster
    { cooldown: 1.2, count: 3, dmg: 36 }, // L5: 3 knots spread, +8 dmg
  ];
  const SCHLEUDER_SPEED = MG.px(420);
  const SCHLEUDER_RANGE = MG.px(260);
  const SCHLEUDER_HIT_R = MG.px(10);

  function schleuderAngles(count, baseAngle) {
    if (count <= 1) return [baseAngle];
    if (count === 2) return [baseAngle, baseAngle + Math.PI]; // out + straight back
    return [baseAngle - 0.4, baseAngle, baseAngle + 0.4]; // 3-way spread
  }

  function describeSchleuderLevel(lvl) {
    const s = SCHLEUDER_LEVELS[lvl];
    return "Schleuderpeitsche Lv" + lvl + ": " + s.count + " Knoten, " + s.dmg + " Schaden, Cooldown " + s.cooldown.toFixed(1) + "s";
  }

  const schleuderKnotGeo = new THREE.TorusGeometry(1, 0.4, 6, 10);
  schleuderKnotGeo.shared = true;
  const schleuderKnotMat = new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0x7a4a1e, emissiveIntensity: 0.5, roughness: 0.4 });
  schleuderKnotMat.shared = true;
  const schleuderTrailGeo = new THREE.SphereGeometry(1, 8, 6);
  schleuderTrailGeo.shared = true;
  const schleuderTrailMats = [0.35, 0.22, 0.1].map((op) => {
    const m = new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: op, depthWrite: false });
    m.shared = true;
    return m;
  });

  const schleuderDef = {
    id: "schleuder",
    name: "Schleuderpeitsche",
    icon: "🪃",
    desc: "Schleudert spinnende Peitschenknoten, die zurückkehren.",
    maxLevel: SCHLEUDER_LEVELS.length - 1,
    type: "weapon",
    describeLevel: describeSchleuderLevel,
    create(game) {
      return {
        def: schleuderDef,
        level: 1,
        _cd: 0.4,
        _projs: [], // { x, z, angle, dist, phase, hitOut, hitBack, spin, group, knot, trailMeshes, hist }

        update(dt, game) {
          this._cd -= dt;
          if (this._cd <= 0) {
            this._throw(game);
            this._cd = SCHLEUDER_LEVELS[this.level].cooldown * MG.weapons.getCooldownMult();
          }
          const s = SCHLEUDER_LEVELS[this.level];
          for (let i = this._projs.length - 1; i >= 0; i--) {
            const pr = this._projs[i];
            if (pr.phase === "out") {
              pr.x += Math.cos(pr.angle) * SCHLEUDER_SPEED * dt;
              pr.z += Math.sin(pr.angle) * SCHLEUDER_SPEED * dt;
              pr.dist += SCHLEUDER_SPEED * dt;
              this._collide(game, pr, pr.hitOut, s.dmg);
              if (pr.dist >= SCHLEUDER_RANGE) pr.phase = "back";
            } else {
              const dx = game.player.x - pr.x, dz = game.player.z - pr.z;
              const d = Math.hypot(dx, dz) || 1;
              pr.x += (dx / d) * SCHLEUDER_SPEED * dt;
              pr.z += (dz / d) * SCHLEUDER_SPEED * dt;
              this._collide(game, pr, pr.hitBack, s.dmg);
              if (d < game.player.r + MG.px(8)) {
                game.fxRoot.remove(pr.group);
                pr.trailMeshes.forEach((tm) => game.fxRoot.remove(tm));
                this._projs.splice(i, 1);
                continue;
              }
            }
            pr.spin += dt * 14;
            pr.hist.push({ x: pr.x, z: pr.z });
            if (pr.hist.length > 8) pr.hist.shift();
            pr.group.position.set(pr.x, game.FX_Y + 0.3, pr.z);
            pr.knot.rotation.set(pr.spin, pr.spin * 0.6, 0);
            pr.trailMeshes.forEach((tm, k) => {
              const idx = pr.hist.length - 1 - (k + 1) * 2;
              if (idx >= 0) {
                tm.visible = true;
                tm.position.set(pr.hist[idx].x, game.FX_Y + 0.25, pr.hist[idx].z);
              } else {
                tm.visible = false;
              }
            });
          }
        },

        _collide(game, pr, hitSet, dmg) {
          for (const e of game.enemies) {
            if (e.dead || hitSet.has(e)) continue;
            if (Math.hypot(e.x - pr.x, e.z - pr.z) <= e.r + SCHLEUDER_HIT_R) {
              hitSet.add(e);
              game.hitEnemy(e, dmg, { fromX: pr.x, fromZ: pr.z, knockback: MG.px(110) });
            }
          }
        },

        _throw(game) {
          const s = SCHLEUDER_LEVELS[this.level];
          const p = game.player;
          let fx = p.facing.x, fz = p.facing.z;
          if (Math.hypot(fx, fz) < 0.01) { fx = 1; fz = 0; }
          const baseAngle = Math.atan2(fz, fx);
          for (const a of schleuderAngles(s.count, baseAngle)) {
            const group = new THREE.Group();
            const knot = new THREE.Mesh(schleuderKnotGeo, schleuderKnotMat);
            knot.scale.setScalar(SCHLEUDER_HIT_R);
            group.add(knot);
            game.fxRoot.add(group);
            const trailMeshes = schleuderTrailMats.map((m, k) => {
              const tm = new THREE.Mesh(schleuderTrailGeo, m);
              tm.scale.setScalar(SCHLEUDER_HIT_R * (0.75 - k * 0.15));
              tm.visible = false;
              game.fxRoot.add(tm);
              return tm;
            });
            this._projs.push({
              x: p.x, z: p.z, angle: a, dist: 0, phase: "out",
              hitOut: new Set(), hitBack: new Set(), spin: 0,
              group, knot, trailMeshes, hist: [],
            });
          }
          game.sfx.crack();
        },

        levelUp() { this.level = Math.min(this.level + 1, schleuderDef.maxLevel); },
      };
    },
  };
  MG.weapons.registry.push(schleuderDef);

  // ==========================================================================
  // Frostpeitsche (id 'frost') — periodic nova that damages and slows
  // enemies in radius. The slow is applied via slowUntil/slowFactor fields
  // that core.js's updateEnemies() already reads (movement-speed multiplier
  // + a blue sprite tint) — no core.js change needed for the slow itself.
  // ==========================================================================
  const FROST_LEVELS = [
    null,
    { cooldown: 4.0, radius: MG.px(150), dmg: 10, slowFactor: 0.5, slowDur: 2.0 },
    { cooldown: 4.0, radius: MG.px(190), dmg: 10, slowFactor: 0.5, slowDur: 2.0 },  // L2: +radius
    { cooldown: 4.0, radius: MG.px(190), dmg: 10, slowFactor: 0.35, slowDur: 2.5 }, // L3: stronger/longer slow
    { cooldown: 4.0, radius: MG.px(190), dmg: 18, slowFactor: 0.35, slowDur: 2.5 }, // L4: +8 dmg
    { cooldown: 2.8, radius: MG.px(230), dmg: 18, slowFactor: 0.35, slowDur: 2.5 }, // L5: faster, +radius
  ];

  function describeFrostLevel(lvl) {
    const s = FROST_LEVELS[lvl];
    return "Frostpeitsche Lv" + lvl + ": " + s.dmg + " Schaden, verlangsamt um " + Math.round((1 - s.slowFactor) * 100) + "% für " + s.slowDur + "s";
  }

  const frostRingGeo = new THREE.RingGeometry(0.9, 1, 32);
  frostRingGeo.rotateX(-Math.PI / 2);
  frostRingGeo.shared = true;
  const frostRingMatTemplate = new THREE.MeshBasicMaterial({ color: 0x9be8ff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });

  const frostDef = {
    id: "frost",
    name: "Frostpeitsche",
    icon: "❄️",
    desc: "Entfesselt eine Frost-Nova, die Feinde verletzt und verlangsamt.",
    maxLevel: FROST_LEVELS.length - 1,
    type: "weapon",
    describeLevel: describeFrostLevel,
    create(game) {
      return {
        def: frostDef,
        level: 1,
        _cd: 1.0,
        _rings: [], // { mesh, mat, life: 1 -> 0 over 0.5s, maxRadius }

        update(dt, game) {
          this._cd -= dt;
          if (this._cd <= 0) {
            this._nova(game);
            this._cd = FROST_LEVELS[this.level].cooldown * MG.weapons.getCooldownMult();
          }
          for (let i = this._rings.length - 1; i >= 0; i--) {
            const r = this._rings[i];
            r.life -= dt / 0.5;
            if (r.life <= 0) {
              game.fxRoot.remove(r.mesh);
              r.mat.dispose();
              this._rings.splice(i, 1);
              continue;
            }
            const cur = Math.max(0.01, r.maxRadius * (1 - r.life));
            r.mesh.scale.set(cur, cur, cur);
            r.mat.opacity = Math.max(0, r.life) * 0.7;
          }
        },

        _nova(game) {
          const s = FROST_LEVELS[this.level];
          const p = game.player;
          for (const e of game.enemiesInRadius(p.x, p.z, s.radius)) {
            game.hitEnemy(e, s.dmg, { fromX: p.x, fromZ: p.z, knockback: MG.px(60) });
            e.slowUntil = game.time + s.slowDur;
            e.slowFactor = s.slowFactor;
          }
          const mat = frostRingMatTemplate.clone();
          const mesh = new THREE.Mesh(frostRingGeo, mat);
          mesh.position.set(p.x, game.FX_Y, p.z);
          mesh.scale.set(0.01, 0.01, 0.01);
          game.fxRoot.add(mesh);
          this._rings.push({ mesh, mat, life: 1, maxRadius: s.radius });
          game.sfx.hit();
        },

        levelUp() { this.level = Math.min(this.level + 1, frostDef.maxLevel); },
      };
    },
  };
  MG.weapons.registry.push(frostDef);

  // ==========================================================================
  // Passive items — no visuals; they just mutate player stats on
  // acquire/level-up. They live in the same MG.weapons.owned array and are
  // drawn in the HUD weapon row exactly like weapons.
  // ==========================================================================

  // ---- Stiefel: +12% move speed per level (cumulative, off a captured base) ----
  const STIEFEL_BONUS = [null, 0.12, 0.24, 0.36];
  const stiefelDef = {
    id: "stiefel",
    name: "Stiefel",
    icon: "👢",
    desc: "+12% Lauftempo pro Stufe.",
    maxLevel: STIEFEL_BONUS.length - 1,
    type: "passive",
    describeLevel(lvl) { return "Stiefel Lv" + lvl + ": +" + Math.round(STIEFEL_BONUS[lvl] * 100) + "% Lauftempo (gesamt)"; },
    create(game) {
      const inst = {
        def: stiefelDef,
        level: 1,
        _base: game.player.stats.speed,
        update() {},
        _apply() { game.player.stats.speed = this._base * (1 + STIEFEL_BONUS[this.level]); },
        levelUp() { this.level = Math.min(this.level + 1, stiefelDef.maxLevel); this._apply(); },
      };
      inst._apply();
      return inst;
    },
  };
  MG.weapons.registry.push(stiefelDef);

  // ---- Magnetring: +45% pickup radius per level (cumulative) ----
  const MAGNET_BONUS = [null, 0.45, 0.90, 1.35];
  const magnetDef = {
    id: "magnet",
    name: "Magnetring",
    icon: "🧲",
    desc: "+45% Aufsammelradius pro Stufe.",
    maxLevel: MAGNET_BONUS.length - 1,
    type: "passive",
    describeLevel(lvl) { return "Magnetring Lv" + lvl + ": +" + Math.round(MAGNET_BONUS[lvl] * 100) + "% Aufsammelradius (gesamt)"; },
    create(game) {
      const inst = {
        def: magnetDef,
        level: 1,
        _base: game.player.stats.pickupRadius,
        update() {},
        _apply() { game.player.stats.pickupRadius = this._base * (1 + MAGNET_BONUS[this.level]); },
        levelUp() { this.level = Math.min(this.level + 1, magnetDef.maxLevel); this._apply(); },
      };
      inst._apply();
      return inst;
    },
  };
  MG.weapons.registry.push(magnetDef);

  // ---- Markus-Herz: +25 max HP per level, heals 25 HP on every pick ----
  const HERZ_PER_LEVEL = 25;
  const herzDef = {
    id: "herz",
    name: "Markus-Herz",
    icon: "❤️",
    desc: "+25 max. HP pro Stufe, heilt sofort 25 HP.",
    maxLevel: 3,
    type: "passive",
    describeLevel(lvl) { return "Markus-Herz Lv" + lvl + ": +" + (HERZ_PER_LEVEL * lvl) + " max. HP (gesamt), heilt 25 HP"; },
    create(game) {
      const inst = {
        def: herzDef,
        level: 1,
        _base: game.player.stats.maxHp,
        update() {},
        _grow() {
          game.player.stats.maxHp = this._base + HERZ_PER_LEVEL * this.level;
          game.player.hp = Math.min(game.player.stats.maxHp, game.player.hp + HERZ_PER_LEVEL);
        },
        levelUp() { this.level = Math.min(this.level + 1, herzDef.maxLevel); this._grow(); },
      };
      inst._grow();
      return inst;
    },
  };
  MG.weapons.registry.push(herzDef);

  // ---- Sanduhr: all weapon cooldowns ×0.9 per level (multiplicative) ----
  // Implemented purely by MG.weapons.getCooldownMult() reading this
  // instance's level off MG.weapons.owned — no separate global state to
  // reset between runs.
  const uhrDef = {
    id: "uhr",
    name: "Sanduhr",
    icon: "⏳",
    desc: "Alle Waffen-Cooldowns ×0.9 pro Stufe.",
    maxLevel: 3,
    type: "passive",
    describeLevel(lvl) { return "Sanduhr Lv" + lvl + ": Cooldowns ×" + Math.pow(0.9, lvl).toFixed(2); },
    create(game) {
      return {
        def: uhrDef,
        level: 1,
        update() {},
        levelUp() { this.level = Math.min(this.level + 1, uhrDef.maxLevel); },
      };
    },
  };
  MG.weapons.registry.push(uhrDef);

  // ==========================================================================
  // getLevelUpOptions(n) — level-up card pool.
  //
  // Contract: returns exactly `n` options, each
  //   { icon, name, desc, apply() }
  // `apply()` is called once, synchronously, when the player picks the
  // card; it should mutate weapon/player state directly.
  //
  // Pool construction, each run:
  //   (a) an upgrade card for every owned, non-maxed weapon/passive
  //   (b) a "new weapon" card for every unowned weapon, but only while the
  //       player owns fewer than 4 weapons
  //   (c) a "new passive" card for every unowned passive, but only while
  //       the player owns fewer than 3 passives
  // `n` distinct candidates are drawn uniformly at random from that pool
  // (never the same candidate twice in one draw). If the pool is smaller
  // than `n` (or empty — e.g. this trimmed-down build only ships one
  // weapon and no passives yet), it's padded with the flat-heal "Brezel"
  // fallback so the level-up screen always has n choosable cards.
  // ==========================================================================
  function healFallback() {
    return {
      icon: "🥨",
      name: "Brezel",
      desc: "+30 HP",
      apply() {
        MG.player.hp = Math.min(MG.player.stats.maxHp, MG.player.hp + 30);
      },
    };
  }

  MG.weapons.getLevelUpOptions = function (n) {
    const owned = MG.weapons.owned;
    const ownedWeaponCount = owned.filter((w) => w.def.type !== "passive").length;
    const ownedPassiveCount = owned.filter((w) => w.def.type === "passive").length;
    const pool = [];

    // (a) upgrades for owned, non-maxed weapons/passives
    for (const inst of owned) {
      if (inst.level < inst.def.maxLevel) {
        const nextLvl = inst.level + 1;
        pool.push({
          icon: inst.def.icon,
          name: inst.def.name + " Lv" + nextLvl,
          desc: inst.def.describeLevel ? inst.def.describeLevel(nextLvl) : (inst.def.name + " verbessert sich."),
          apply() { inst.levelUp(); },
        });
      }
    }

    // (b) new weapons (cap: 4 owned weapons)
    if (ownedWeaponCount < 4) {
      for (const def of MG.weapons.registry) {
        if (def.type === "passive") continue;
        if (owned.some((w) => w.def.id === def.id)) continue;
        pool.push({
          icon: def.icon,
          name: def.name,
          desc: def.desc,
          apply() { MG.weapons.owned.push(def.create(MG)); },
        });
      }
    }

    // (c) new passives (cap: 3 owned passives)
    if (ownedPassiveCount < 3) {
      for (const def of MG.weapons.registry) {
        if (def.type !== "passive") continue;
        if (owned.some((w) => w.def.id === def.id)) continue;
        pool.push({
          icon: def.icon,
          name: def.name,
          desc: def.desc,
          apply() { MG.weapons.owned.push(def.create(MG)); },
        });
      }
    }

    // Uniform random draw of up to n distinct candidates (Fisher-Yates).
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    const options = pool.slice(0, n);

    while (options.length < n) options.push(healFallback());

    return options;
  };
})();
