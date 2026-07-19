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
    return inst ? Math.pow(0.9, inst.level) : 1;
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
