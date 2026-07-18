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

  // Global cooldown multiplier applied by every cooldown-based weapon.
  // Derived (not stored) from the Sanduhr passive's level so a fresh run
  // (which just empties MG.weapons.owned) automatically resets it — no
  // extra reset hook needed.
  MG.weapons.getCooldownMult = function () {
    const inst = MG.weapons.owned.find((w) => w.def.id === "uhr");
    return inst ? Math.pow(0.9, inst.level) : 1;
  };

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
    type: "weapon",
    describeLevel: describeWhipLevel,
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
            this._cd = WHIP_LEVELS[this.level].cooldown * MG.weapons.getCooldownMult();
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
  // Shared helper: normalize an angle difference into [-PI, PI].
  // ==========================================================================
  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // ==========================================================================
  // Kreiselpeitsche (id 'kreisel') — whip-tips orbit the player continuously
  // and damage anything they touch, gated by a per-enemy hit cooldown
  // (tracked in a WeakMap keyed by enemy object) so a stationary enemy
  // isn't melted every frame.
  // ==========================================================================
  const KREISEL_LEVELS = [
    null,
    { tips: 1, radius: 100, speed: 2.6, dmg: 10 },
    { tips: 2, radius: 100, speed: 2.6, dmg: 10 },  // L2: +1 tip
    { tips: 2, radius: 100, speed: 2.6, dmg: 16 },  // L3: +6 dmg
    { tips: 3, radius: 115, speed: 2.6, dmg: 16 },  // L4: +1 tip, +radius
    { tips: 3, radius: 115, speed: 3.4, dmg: 24 },  // L5: +8 dmg, faster spin
  ];
  const KREISEL_HIT_CD = 0.5;
  const KREISEL_TIP_R = 10;

  function describeKreiselLevel(lvl) {
    const s = KREISEL_LEVELS[lvl];
    return "Kreiselpeitsche Lv" + lvl + ": " + s.tips + " Spitze" + (s.tips > 1 ? "n" : "") +
      ", " + s.dmg + " Schaden, Radius " + s.radius;
  }

  const kreiselDef = {
    id: "kreisel",
    name: "Kreiselpeitsche",
    icon: "🌀",
    desc: "Peitschenspitzen kreisen um dich und verletzen alles, was sie berühren.",
    maxLevel: KREISEL_LEVELS.length - 1,
    type: "weapon",
    describeLevel: describeKreiselLevel,
    create(game) {
      return {
        def: kreiselDef,
        level: 1,
        _angle: 0,
        _lastHit: new WeakMap(),

        update(dt, game) {
          const s = KREISEL_LEVELS[this.level];
          this._angle += s.speed * dt;
          const p = game.player;
          for (let i = 0; i < s.tips; i++) {
            const a = this._angle + (i / s.tips) * Math.PI * 2;
            const tx = p.x + Math.cos(a) * s.radius;
            const ty = p.y + Math.sin(a) * s.radius;
            for (const e of game.enemies) {
              if (e.dead) continue;
              const d = Math.hypot(e.x - tx, e.y - ty);
              if (d <= e.r + KREISEL_TIP_R) {
                const last = this._lastHit.get(e);
                if (last === undefined || game.time - last >= KREISEL_HIT_CD) {
                  this._lastHit.set(e, game.time);
                  game.hitEnemy(e, s.dmg, { fromX: tx, fromY: ty, knockback: 90 });
                }
              }
            }
          }
        },

        draw(ctx, game) {
          const s = KREISEL_LEVELS[this.level];
          const p = game.player;
          const ps = game.worldToScreen(p.x, p.y);
          for (let i = 0; i < s.tips; i++) {
            const a = this._angle + (i / s.tips) * Math.PI * 2;
            const tx = p.x + Math.cos(a) * s.radius;
            const ty = p.y + Math.sin(a) * s.radius;
            const sc = game.worldToScreen(tx, ty);
            ctx.save();
            ctx.strokeStyle = "rgba(255,213,74,0.55)";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(ps.x, ps.y, s.radius, a - 0.6, a);
            ctx.stroke();
            ctx.restore();
            ctx.beginPath();
            ctx.fillStyle = "#ffd54a";
            ctx.arc(sc.x, sc.y, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#7a4a1e";
            ctx.lineWidth = 2;
            ctx.stroke();
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
  // ==========================================================================
  const BLITZ_LEVELS = [
    null,
    { cooldown: 2.0, dmg: 25, range: 350, chains: 0, chainRange: 140 },
    { cooldown: 1.6, dmg: 25, range: 350, chains: 0, chainRange: 140 }, // L2: faster
    { cooldown: 1.6, dmg: 25, range: 350, chains: 2, chainRange: 140 }, // L3: chains
    { cooldown: 1.6, dmg: 35, range: 350, chains: 2, chainRange: 140 }, // L4: +10 dmg
    { cooldown: 1.1, dmg: 35, range: 350, chains: 4, chainRange: 140 }, // L5: faster, more chains
  ];

  function describeBlitzLevel(lvl) {
    const s = BLITZ_LEVELS[lvl];
    const bits = [Math.round(s.dmg) + " Schaden", "Cooldown " + s.cooldown.toFixed(1) + "s"];
    if (s.chains > 0) bits.push("bis zu " + s.chains + " Kettenblitze");
    return "Blitzpeitsche Lv" + lvl + ": " + bits.join(", ");
  }

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
        _bolts: [], // { points:[{x,y}...], life: 1 -> 0 over 0.2s }

        update(dt, game) {
          this._cd -= dt;
          if (this._cd <= 0) {
            this._strike(game);
            this._cd = BLITZ_LEVELS[this.level].cooldown * MG.weapons.getCooldownMult();
          }
          for (let i = this._bolts.length - 1; i >= 0; i--) {
            this._bolts[i].life -= dt / 0.2;
            if (this._bolts[i].life <= 0) this._bolts.splice(i, 1);
          }
        },

        _strike(game) {
          const s = BLITZ_LEVELS[this.level];
          const p = game.player;
          const first = game.nearestEnemy(p.x, p.y, s.range);
          if (!first) return;
          const hitSet = new Set([first]);
          const points = [{ x: p.x, y: p.y }, { x: first.x, y: first.y }];
          game.hitEnemy(first, s.dmg, { fromX: p.x, fromY: p.y, knockback: 120 });
          game.addParticles(first.x, first.y, "#eaffff", 6);
          let prev = first;
          for (let c = 0; c < s.chains; c++) {
            let best = null, bestD = s.chainRange;
            for (const e of game.enemies) {
              if (e.dead || hitSet.has(e)) continue;
              const d = Math.hypot(e.x - prev.x, e.y - prev.y);
              if (d <= bestD) { bestD = d; best = e; }
            }
            if (!best) break;
            hitSet.add(best);
            points.push({ x: best.x, y: best.y });
            game.hitEnemy(best, s.dmg * 0.5, { fromX: prev.x, fromY: prev.y, knockback: 90 });
            game.addParticles(best.x, best.y, "#eaffff", 4);
            prev = best;
          }
          this._bolts.push({ points: this._jagged(points), life: 1 });
          game.sfx.hit();
        },

        _jagged(points) {
          const out = [];
          for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            const segs = 5;
            for (let j = 0; j <= segs; j++) {
              const t = j / segs;
              let x = a.x + (b.x - a.x) * t;
              let y = a.y + (b.y - a.y) * t;
              if (j > 0 && j < segs) {
                const nx = -(b.y - a.y), ny = (b.x - a.x);
                const nlen = Math.hypot(nx, ny) || 1;
                const jag = (Math.random() - 0.5) * 18;
                x += (nx / nlen) * jag;
                y += (ny / nlen) * jag;
              }
              out.push({ x, y });
            }
          }
          return out;
        },

        draw(ctx, game) {
          for (const bolt of this._bolts) {
            ctx.save();
            ctx.globalAlpha = Math.max(0, bolt.life) * 0.9;
            ctx.strokeStyle = "#bfe8ff";
            ctx.lineWidth = 3;
            ctx.shadowColor = "#7ee0ff";
            ctx.shadowBlur = 10;
            ctx.beginPath();
            bolt.points.forEach((pt, i) => {
              const s = game.worldToScreen(pt.x, pt.y);
              if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
            });
            ctx.stroke();
            ctx.restore();
          }
          ctx.globalAlpha = 1;
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
  const FLAMME_CONE_LEN = 190;
  const FLAMME_PATCH_R = 36;
  const FLAMME_TICK = 0.4;

  function describeFlammeLevel(lvl) {
    const s = FLAMME_LEVELS[lvl];
    return "Flammenpeitsche Lv" + lvl + ": " + s.coneDmg + " Kegel-Schaden, " +
      s.patches + " Feuerflecken (" + s.burnDps + " Schaden/s)";
  }

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
        _fx: [], // cone flashes: { angle, life }
        _patches: [], // { x, y, life, maxLife, tick }

        update(dt, game) {
          this._cd -= dt;
          if (this._cd <= 0) {
            this._lash(game);
            this._cd = FLAMME_LEVELS[this.level].cooldown * MG.weapons.getCooldownMult();
          }
          for (let i = this._fx.length - 1; i >= 0; i--) {
            this._fx[i].life -= dt / 0.2;
            if (this._fx[i].life <= 0) this._fx.splice(i, 1);
          }
          for (let i = this._patches.length - 1; i >= 0; i--) {
            const patch = this._patches[i];
            patch.life -= dt;
            patch.tick -= dt;
            if (patch.tick <= 0) {
              patch.tick += FLAMME_TICK;
              const s = FLAMME_LEVELS[this.level];
              for (const e of game.enemiesInRadius(patch.x, patch.y, FLAMME_PATCH_R)) {
                game.hitEnemy(e, s.burnDps * FLAMME_TICK, { fromX: patch.x, fromY: patch.y, knockback: 20 });
              }
            }
            if (patch.life <= 0) this._patches.splice(i, 1);
          }
        },

        _lash(game) {
          const s = FLAMME_LEVELS[this.level];
          const p = game.player;
          let fx = p.facing.x, fy = p.facing.y;
          if (Math.hypot(fx, fy) < 0.01) { fx = 1; fy = 0; }
          const faceAngle = Math.atan2(fy, fx);
          this._fx.push({ angle: faceAngle, life: 1 });
          for (const e of game.enemies) {
            if (e.dead) continue;
            const dx = e.x - p.x, dy = e.y - p.y;
            const dist = Math.hypot(dx, dy);
            if (dist > FLAMME_CONE_LEN + e.r) continue;
            const ang = Math.atan2(dy, dx);
            const diff = Math.abs(angleDiff(ang, faceAngle));
            const pad = Math.atan2(e.r, Math.max(dist, 1));
            if (diff <= FLAMME_CONE_HALF_ANGLE + pad) {
              game.hitEnemy(e, s.coneDmg, { fromX: p.x, fromY: p.y, knockback: 130 });
            }
          }
          for (let i = 0; i < s.patches; i++) {
            const t = (i + 1) / (s.patches + 1);
            const dist = t * FLAMME_CONE_LEN;
            this._patches.push({ x: p.x + fx * dist, y: p.y + fy * dist, life: s.patchLife, tick: FLAMME_TICK });
          }
          game.sfx.crack();
        },

        draw(ctx, game) {
          const s = FLAMME_LEVELS[this.level];
          const p = game.player;
          const ps = game.worldToScreen(p.x, p.y);
          for (const fx of this._fx) {
            ctx.save();
            ctx.translate(ps.x, ps.y);
            ctx.rotate(fx.angle);
            ctx.globalAlpha = Math.max(0, fx.life) * 0.55;
            const grad = ctx.createLinearGradient(0, 0, FLAMME_CONE_LEN, 0);
            grad.addColorStop(0, "rgba(255,180,60,0.9)");
            grad.addColorStop(1, "rgba(255,60,20,0)");
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, FLAMME_CONE_LEN, -FLAMME_CONE_HALF_ANGLE, FLAMME_CONE_HALF_ANGLE);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
          ctx.globalAlpha = 1;
          const t = performance.now() / 120;
          for (const patch of this._patches) {
            const sc = game.worldToScreen(patch.x, patch.y);
            const flick = 0.7 + 0.3 * Math.sin(t + patch.x);
            ctx.save();
            ctx.globalAlpha = Math.min(1, patch.life / s.patchLife) * 0.75;
            const grad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, FLAMME_PATCH_R * flick);
            grad.addColorStop(0, "rgba(255,200,80,0.85)");
            grad.addColorStop(0.6, "rgba(255,90,20,0.55)");
            grad.addColorStop(1, "rgba(255,40,10,0)");
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(sc.x, sc.y, FLAMME_PATCH_R * flick, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
          ctx.globalAlpha = 1;
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
  const SCHLEUDER_SPEED = 420;
  const SCHLEUDER_RANGE = 260;

  function schleuderAngles(count, baseAngle) {
    if (count <= 1) return [baseAngle];
    if (count === 2) return [baseAngle, baseAngle + Math.PI]; // out + straight back
    return [baseAngle - 0.4, baseAngle, baseAngle + 0.4]; // 3-way spread
  }

  function describeSchleuderLevel(lvl) {
    const s = SCHLEUDER_LEVELS[lvl];
    return "Schleuderpeitsche Lv" + lvl + ": " + s.count + " Knoten, " + s.dmg + " Schaden, Cooldown " + s.cooldown.toFixed(1) + "s";
  }

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
        _projs: [], // { x, y, angle, dist, phase, hitOut, hitBack, spin, trail }

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
              pr.y += Math.sin(pr.angle) * SCHLEUDER_SPEED * dt;
              pr.dist += SCHLEUDER_SPEED * dt;
              this._collide(game, pr, pr.hitOut, s.dmg);
              if (pr.dist >= SCHLEUDER_RANGE) pr.phase = "back";
            } else {
              const dx = game.player.x - pr.x, dy = game.player.y - pr.y;
              const d = Math.hypot(dx, dy) || 1;
              pr.x += (dx / d) * SCHLEUDER_SPEED * dt;
              pr.y += (dy / d) * SCHLEUDER_SPEED * dt;
              this._collide(game, pr, pr.hitBack, s.dmg);
              if (d < game.player.r + 8) { this._projs.splice(i, 1); continue; }
            }
            pr.spin += dt * 14;
            pr.trail.push({ x: pr.x, y: pr.y });
            if (pr.trail.length > 6) pr.trail.shift();
          }
        },

        _collide(game, pr, hitSet, dmg) {
          for (const e of game.enemies) {
            if (e.dead || hitSet.has(e)) continue;
            if (Math.hypot(e.x - pr.x, e.y - pr.y) <= e.r + 10) {
              hitSet.add(e);
              game.hitEnemy(e, dmg, { fromX: pr.x, fromY: pr.y, knockback: 110 });
            }
          }
        },

        _throw(game) {
          const s = SCHLEUDER_LEVELS[this.level];
          const p = game.player;
          let fx = p.facing.x, fy = p.facing.y;
          if (Math.hypot(fx, fy) < 0.01) { fx = 1; fy = 0; }
          const baseAngle = Math.atan2(fy, fx);
          for (const a of schleuderAngles(s.count, baseAngle)) {
            this._projs.push({ x: p.x, y: p.y, angle: a, dist: 0, phase: "out", hitOut: new Set(), hitBack: new Set(), spin: 0, trail: [] });
          }
          game.sfx.crack();
        },

        draw(ctx, game) {
          for (const pr of this._projs) {
            for (let i = 0; i < pr.trail.length; i++) {
              const t = pr.trail[i];
              const sc = game.worldToScreen(t.x, t.y);
              ctx.globalAlpha = (i / pr.trail.length) * 0.4;
              ctx.fillStyle = "#ffd54a";
              ctx.beginPath();
              ctx.arc(sc.x, sc.y, 5, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.globalAlpha = 1;
            const sc = game.worldToScreen(pr.x, pr.y);
            ctx.save();
            ctx.translate(sc.x, sc.y);
            ctx.rotate(pr.spin);
            ctx.fillStyle = "#ffd54a";
            ctx.strokeStyle = "#7a4a1e";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-9, 0); ctx.lineTo(9, 0);
            ctx.moveTo(0, -9); ctx.lineTo(0, 9);
            ctx.strokeStyle = "rgba(0,0,0,0.35)";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
          }
        },

        levelUp() { this.level = Math.min(this.level + 1, schleuderDef.maxLevel); },
      };
    },
  };
  MG.weapons.registry.push(schleuderDef);

  // ==========================================================================
  // Frostpeitsche (id 'frost') — periodic nova that damages and slows
  // enemies in radius. The slow itself is implemented via slowUntil /
  // slowFactor fields core.js's updateEnemies() multiplies into movement
  // speed (see core.js — minimal one-line hook, no restructuring).
  // ==========================================================================
  const FROST_LEVELS = [
    null,
    { cooldown: 4.0, radius: 150, dmg: 10, slowFactor: 0.5, slowDur: 2.0 },
    { cooldown: 4.0, radius: 190, dmg: 10, slowFactor: 0.5, slowDur: 2.0 },  // L2: +radius
    { cooldown: 4.0, radius: 190, dmg: 10, slowFactor: 0.35, slowDur: 2.5 }, // L3: 65% slow (35% speed remains), longer duration
    { cooldown: 4.0, radius: 190, dmg: 18, slowFactor: 0.35, slowDur: 2.5 }, // L4: +8 dmg
    { cooldown: 2.8, radius: 230, dmg: 18, slowFactor: 0.35, slowDur: 2.5 }, // L5: faster, +radius
  ];

  function describeFrostLevel(lvl) {
    const s = FROST_LEVELS[lvl];
    return "Frostpeitsche Lv" + lvl + ": " + s.dmg + " Schaden, Radius " + s.radius +
      ", verlangsamt um " + Math.round((1 - s.slowFactor) * 100) + "% für " + s.slowDur + "s";
  }

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
        _rings: [], // { life: 1 -> 0, maxRadius }

        update(dt, game) {
          this._cd -= dt;
          if (this._cd <= 0) {
            this._nova(game);
            this._cd = FROST_LEVELS[this.level].cooldown * MG.weapons.getCooldownMult();
          }
          for (let i = this._rings.length - 1; i >= 0; i--) {
            this._rings[i].life -= dt / 0.5;
            if (this._rings[i].life <= 0) this._rings.splice(i, 1);
          }
        },

        _nova(game) {
          const s = FROST_LEVELS[this.level];
          const p = game.player;
          for (const e of game.enemiesInRadius(p.x, p.y, s.radius)) {
            game.hitEnemy(e, s.dmg, { fromX: p.x, fromY: p.y, knockback: 60 });
            e.slowUntil = game.time + s.slowDur;
            e.slowFactor = s.slowFactor;
          }
          this._rings.push({ life: 1, maxRadius: s.radius });
          game.sfx.hit();
        },

        draw(ctx, game) {
          const p = game.player;
          const ps = game.worldToScreen(p.x, p.y);
          for (const ring of this._rings) {
            const r = ring.maxRadius * (1 - ring.life);
            ctx.save();
            ctx.globalAlpha = Math.max(0, ring.life) * 0.6;
            ctx.strokeStyle = "#9be8ff";
            ctx.lineWidth = 4;
            ctx.shadowColor = "#bfe8ff";
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(ps.x, ps.y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
          ctx.globalAlpha = 1;
        },

        levelUp() { this.level = Math.min(this.level + 1, frostDef.maxLevel); },
      };
    },
  };
  MG.weapons.registry.push(frostDef);

  // ==========================================================================
  // Passive items — no update/draw beyond no-ops; they just mutate player
  // stats on acquire/level-up. They live in the same MG.weapons.owned array
  // and get drawn in the HUD weapon row exactly like weapons.
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
        update() {}, draw() {},
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
        update() {}, draw() {},
        _apply() { game.player.stats.pickupRadius = this._base * (1 + MAGNET_BONUS[this.level]); },
        levelUp() { this.level = Math.min(this.level + 1, magnetDef.maxLevel); this._apply(); },
      };
      inst._apply();
      return inst;
    },
  };
  MG.weapons.registry.push(magnetDef);

  // ---- Markus-Herz: +25 max HP per level and heals 25 HP on every pick ----
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
        update() {}, draw() {},
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
  // reset between runs (see top of file).
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
        update() {}, draw() {},
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
  // than `n` (or empty), it's padded with the flat-heal "Brezel" fallback.
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
