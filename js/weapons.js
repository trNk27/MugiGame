// ============================================================================
// Peitsch den Markus: Survivors — WEAPON FRAMEWORK
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
//                              === 'playing'
//     draw(ctx, game),         called every render frame, AFTER enemies
//                              are drawn (so effects render on top of them)
//     levelUp(),               bump level (clamp to def.maxLevel) and make
//                              the instance re-read its own per-level
//                              stat table on the next update/draw
//   }
//   Instances own all of their private state — cooldown timers, active
//   projectiles, visual-effect lists, etc. Core never reaches into an
//   instance's internals.
//
// ---- Registries --------------------------------------------------------
//
//   MG.weapons.registry : Array<WeaponDef>
//     All weapons that exist in the game, whether owned yet or not.
//
//   MG.weapons.owned : Array<WeaponInstance>
//     Weapons the player currently has equipped. core.js calls
//     update()/draw() on every entry each frame. The starting weapon
//     ('klassisch') is auto-created into this array by core.js's
//     resetGame() when a run begins.
//
// ---- The `game` object ---------------------------------------------------
//
// core.js passes its MG namespace itself as `game` into create/update/draw.
// It exposes:
//
//   game.player                 { x, y, r, hp, invuln,
//                                  stats: { speed, maxHp, regen, pickupRadius },
//                                  facing: { x, y } }   // unit vector, last nonzero move dir
//   game.enemies                live Array<enemy>; each enemy has at least
//                                { x, y, r, hp, maxHp, dead }
//   game.time                   seconds of survival time elapsed this run
//   game.hitEnemy(enemy, dmg, opts)
//                                applies damage, hit-flash, knockback,
//                                floating damage number, and handles death
//                                (particles + XP gem drop + kill count).
//                                opts: { fromX, fromY, knockback } — fromX/Y
//                                is the source point knockback pushes away
//                                from (defaults to player position);
//                                knockback is a px/s impulse magnitude
//                                (default 140).
//   game.enemiesInRadius(x,y,r) -> Array<enemy>  (alive enemies only)
//   game.nearestEnemy(x,y,maxDist) -> enemy | null
//   game.addParticles(x,y,color,n)
//   game.sfx.crack() / .hit() / .pickup() / .levelup() / .hurt()
//   game.worldToScreen(x,y) -> {x,y}   world coords -> canvas pixel coords
//                                (camera-relative; use this in draw())
//
// ============================================================================

(function () {
  "use strict";

  const MG = (window.MG = window.MG || {});
  MG.weapons = MG.weapons || { registry: [], owned: [] };

  // ==========================================================================
  // Reference weapon: Klassische Peitsche (id 'klassisch')
  // Auto-acquired at game start. Cracks on the facing side every `cooldown`
  // seconds, hitting everything inside a `w` x `h` world-px rectangle that
  // starts at the player and extends forward along the facing direction.
  //
  // All per-level numbers live in one data table (WHIP_LEVELS) — nothing
  // about levels is hardcoded inline in the update/strike/draw logic.
  // ==========================================================================

  // L3 scales area by exactly 1.3x while keeping the 160:70 aspect ratio.
  const WHIP_AREA_SCALE = Math.sqrt(1.3);

  const WHIP_LEVELS = [
    null, // levels are 1-indexed to match WeaponInstance.level
    { cooldown: 1.1, dmg: 15, w: 160, h: 70, sides: 1 },
    { cooldown: 1.1, dmg: 25, w: 160, h: 70, sides: 1 },                                       // L2: +10 dmg
    { cooldown: 1.1, dmg: 25, w: 160 * WHIP_AREA_SCALE, h: 70 * WHIP_AREA_SCALE, sides: 1 },    // L3: area x1.3
    { cooldown: 1.1, dmg: 25, w: 160 * WHIP_AREA_SCALE, h: 70 * WHIP_AREA_SCALE, sides: 2 },    // L4: also cracks opposite side
    { cooldown: 1.1, dmg: 40, w: 160 * WHIP_AREA_SCALE, h: 70 * WHIP_AREA_SCALE, sides: 2 },    // L5: +15 dmg
  ];

  function describeWhipLevel(lvl) {
    const s = WHIP_LEVELS[lvl];
    const bits = [Math.round(s.dmg) + " Schaden"];
    if (s.sides >= 2) bits.push("trifft beide Seiten");
    return "Peitsche Lv" + lvl + ": " + bits.join(", ");
  }

  const whipDef = {
    id: "klassisch",
    name: "Klassische Peitsche",
    icon: "🪢",
    desc: "Peitscht automatisch nach vorn.",
    maxLevel: WHIP_LEVELS.length - 1,
    create(game) {
      return {
        def: whipDef,
        level: 1,
        _cd: 0,
        _fx: [], // active visual slashes: { angle, life } — life 1 -> 0 over 0.15s

        update(dt, game) {
          this._cd -= dt;
          if (this._cd <= 0) {
            this._crack(game);
            this._cd = WHIP_LEVELS[this.level].cooldown;
          }
          for (let i = this._fx.length - 1; i >= 0; i--) {
            this._fx[i].life -= dt / 0.15;
            if (this._fx[i].life <= 0) this._fx.splice(i, 1);
          }
        },

        _crack(game) {
          const stats = WHIP_LEVELS[this.level];
          const p = game.player;
          let fx = p.facing.x, fy = p.facing.y;
          if (Math.hypot(fx, fy) < 0.01) { fx = 1; fy = 0; } // default: face right
          const angle = Math.atan2(fy, fx);
          this._strike(game, p.x, p.y, angle, stats);
          game.sfx.crack();
          if (stats.sides >= 2) this._strike(game, p.x, p.y, angle + Math.PI, stats);
        },

        // Rectangular hitbox check: rotate each enemy into the strike's
        // local space (x = forward along facing, y = perpendicular), then
        // test against [0,w] x [-h/2,h/2], padded by the enemy radius.
        _strike(game, px, py, angle, stats) {
          this._fx.push({ angle, life: 1 });
          const cos = Math.cos(angle), sin = Math.sin(angle);
          for (const e of game.enemies) {
            if (e.dead) continue;
            const dx = e.x - px, dy = e.y - py;
            const lx = dx * cos + dy * sin;
            const ly = -dx * sin + dy * cos;
            if (lx >= -e.r && lx <= stats.w + e.r && ly >= -stats.h / 2 - e.r && ly <= stats.h / 2 + e.r) {
              game.hitEnemy(e, stats.dmg, { fromX: px, fromY: py, knockback: 160 });
            }
          }
        },

        draw(ctx, game) {
          if (this._fx.length === 0) return;
          const p = game.player;
          const s = game.worldToScreen(p.x, p.y);
          const stats = WHIP_LEVELS[this.level];
          const halfAngle = Math.atan2(stats.h / 2, stats.w) * 1.1;
          for (const fx of this._fx) {
            ctx.save();
            ctx.translate(s.x, s.y);
            ctx.rotate(fx.angle);
            ctx.globalAlpha = Math.max(0, fx.life) * 0.85;
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(0, 0, stats.w * 0.55, -halfAngle, halfAngle);
            ctx.stroke();
            ctx.restore();
          }
          ctx.globalAlpha = 1;
        },

        levelUp() {
          this.level = Math.min(this.level + 1, whipDef.maxLevel);
        },
      };
    },
  };

  MG.weapons.registry.push(whipDef);

  // ==========================================================================
  // getLevelUpOptions(n) — level-up card pool.
  //
  // *** THIS IS THE FUNCTION AGENT 2 SHOULD EXTEND/REPLACE. *** It currently
  // only knows about the classic whip; add more weapon defs above (or in a
  // new file loaded after this one) and offer them here, e.g. an unowned
  // weapon as a "new weapon" card, or the next level of an owned one.
  //
  // Contract: returns up to `n` options, each
  //   { icon, name, desc, apply() }
  // `apply()` is called once, synchronously, when the player picks the
  // card; it should mutate weapon/player state directly (see examples).
  // If there aren't enough real upgrades available, pad with the flat-heal
  // fallback so the level-up screen always has `n` cards.
  // ==========================================================================
  MG.weapons.getLevelUpOptions = function (n) {
    const options = [];

    const whipInst = MG.weapons.owned.find((w) => w.def.id === "klassisch");
    if (whipInst && whipInst.level < whipInst.def.maxLevel) {
      const nextLvl = whipInst.level + 1;
      options.push({
        icon: whipInst.def.icon,
        name: whipInst.def.name + " Lv" + nextLvl,
        desc: describeWhipLevel(nextLvl),
        apply() { whipInst.levelUp(); },
      });
    }

    // Fallback filler: always available, keeps the level-up screen full.
    while (options.length < n) {
      options.push({
        icon: "🥨",
        name: "Brezel",
        desc: "+30 HP",
        apply() {
          MG.player.hp = Math.min(MG.player.stats.maxHp, MG.player.hp + 30);
        },
      });
    }

    return options.slice(0, n);
  };
})();
