/** @size-exempt: Layer-2 reactive autopilot kept as single-purpose module (refactor plan) */
/**
 * Reactive layer (Layer 2 per docs/phase-2/reactive-layer.md).
 *
 * Tactical autopilot — NOT a macro dispatcher. Issues per-tick micro-actions
 * so the next tick can re-evaluate. Never invokes long-running macros
 * (mc fight, mc flee 16) because those lock out re-evaluation and tear the
 * bot far from where the agent put it.
 *
 * Per-tick micro-actions (one of):
 *   attack_step  — multi-target swing at every melee-range hostile (skill-
 *                  scaled), then strafe or back-step to break crossfire.
 *   advance_step — bounded forward sprint toward a hostile that's out of
 *                  melee but in sight. Closes on archers and visible threats.
 *   flee_step    — bounded sprint AWAY from threat, ±35° zig-zag, wall-aware.
 *                  Escalates to fully random 360° angles when stuck-pinned.
 *   hold         — no movement (idle, anchor exceeded, or mode=hold).
 *
 * Modes (set via mc mode):
 *   normal — engage when attacked or in melee range; flee creepers / low HP /
 *            ranged threats while weaponless. Stays within ANCHOR_RANGE of
 *            the position the bot held when reactive last went idle.
 *   guard  — engage hostiles in 12-block radius. Larger anchor range.
 *   hold   — no auto-actions. Pure observation.
 *
 * Tunables:
 *   ctx.reactive.combat_skill ∈ [0, 1] — soldier vs farmer. Scales multi-target hit
 *                               probability and tick rate. Set via mc combat_skill.
 *
 * Stuck escalation (shared across all movement steps):
 *   stuckTicks=0  → normal jitter ±35°, 50% back / 25%×2 strafe
 *   stuckTicks=1  → wider angles, strafe-only retreat, longer movement
 *   stuckTicks=2+ → fully random 360° angle (may move toward the enemy);
 *                   plus a jump to dislodge from 1-block lips and mob pins
 *
 * Auto-fired actions are recorded in ctx.reactive.autoActionLog for the agent to read.
 */

import { Vec3 } from 'vec3';

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'drowned', 'husk', 'stray', 'phantom', 'pillager', 'vindicator',
  'blaze', 'wither_skeleton', 'piglin_brute', 'hoglin', 'ghast',
]);

// Mobs that attack from range. Trigger preemptive zig-zag flee when bot is
// weaponless, regardless of damage state — standing still under archer fire
// is the worst possible response.
const RANGED_HOSTILE_NAMES = new Set([
  'skeleton', 'stray', 'pillager', 'witch', 'blaze', 'ghast', 'drowned',
]);

const WEAPON_PATTERN = /(_sword|_axe)$/;
const RECENT_DAMAGE_MS = 2000;
const MELEE_RANGE = 4;
const GUARD_RANGE = 12;
const CREEPER_FLEE_RANGE = 6;
const RANGED_AWARE_RANGE = 16;      // see ranged threats from this far
const SAFE_DISTANCE = 6;            // don't flee past this distance from threat
const LOW_HP_FLEE = 6;
const LOW_HP_DISENGAGE = 8;
const ANCHOR_RANGE_NORMAL = 6;      // don't wander > 6 blocks from anchor in normal
const ANCHOR_RANGE_GUARD = 16;
const TICK_MS = 400;
const BACKSTEP_MS = 120;            // brief retreat after each swing (knockback dance)

export function createReactive(deps) {
  const { ctx, log, ACTIONS, sleep, hasLineOfSight, eyePosition } = deps;

  // Same fair-play LOS guard used by mc attack/mc collect: refuse to
  // swing if a solid block sits between the bot's eye and the target's
  // chest. Critical for reactive: it ticks every 400ms and would
  // otherwise let the bot attack mobs through its own shelter walls.
  // v30/v31 demonstrated the regression — reactive `attack_step` was
  // firing on enderman@1.6m while the bot was fully sealed in a 1-block
  // cobble shelter. Returns true if attack is fair, false if blocked.
  function reactiveCanHit(entity) {
    if (!hasLineOfSight || !eyePosition) return true; // pre-wire safety
    const eye = eyePosition();
    if (!eye || !entity?.position) return true;
    const target = entity.position.offset(0, (entity.height || 1.8) * 0.5, 0);
    // Vertical reach check. Foot-to-foot 3D distance can be ≤4 even
    // when the target is straight overhead (skeleton on shelter roof,
    // spider in a tree, zombie that fell into a pit). The bot's actual
    // swing reach is ~3.5 blocks from EYE to target centre when there's
    // pitch involved. Only applies when there's significant vertical
    // separation — at same level the foot-to-foot MELEE_RANGE governs,
    // and a 3.5m cap silently filters swings at the edge of melee.
    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;
    const eyeDist = Math.hypot(dx, dy, dz);
    const horizDist = Math.hypot(dx, dz);
    if (Math.abs(dy) > 0.8 && eyeDist > 3.5) return false;
    // Also skip if the target is mostly vertical from the bot — even
    // within 3.5m, hitting straight up/down with pitch >65° is finicky
    // and the bot tends to spin in place doing nothing useful.
    if (horizDist < 0.7 && Math.abs(dy) > 1.5) return false;
    return hasLineOfSight(eye, target);
  }

  function isHostile(entity) {
    if (!entity || !entity.position || entity === ctx.world.bot?.entity) return false;
    return HOSTILE_NAMES.has((entity.name || '').toLowerCase());
  }

  function readState() {
    const b = ctx.world.bot;
    if (!b || !b.entity) return null;
    const myPos = b.entity.position;
    const hostiles = Object.values(b.entities)
      .filter(isHostile)
      .map((e) => ({
        entity: e,
        name: e.name,
        position: e.position,
        distance: e.position.distanceTo(myPos),
      }))
      .sort((a, c) => a.distance - c.distance);

    const damageEvent = ctx.death.lastDamageEvent;
    const recentlyDamaged = damageEvent && (Date.now() - damageEvent.ts) < RECENT_DAMAGE_MS;
    const weapon = b.inventory.items().find((i) => WEAPON_PATTERN.test(i.name));
    const armorCount = [5, 6, 7, 8].filter((s) => b.inventory.slots[s]).length;

    // Anchor: where the bot was at the most recent moment Layer 2 was idle.
    // (For now, default to the bot's current position when no anchor set.)
    if (!ctx.reactive.reactiveAnchor) {
      ctx.reactive.reactiveAnchor = { x: myPos.x, y: myPos.y, z: myPos.z };
    }
    const anchor = ctx.reactive.reactiveAnchor;
    const distFromAnchor = Math.sqrt(
      (myPos.x - anchor.x) ** 2 + (myPos.z - anchor.z) ** 2,
    );

    const closestRanged = hostiles.find(
      (h) => RANGED_HOSTILE_NAMES.has((h.name || '').toLowerCase()) && h.distance <= RANGED_AWARE_RANGE,
    ) || null;

    // Environmental hazard scan: read foot / head / immediate-cardinal blocks.
    // mineflayer's b.entity.isInLava / isInWater are reliable flags for the
    // bot's collision box. We additionally peek 1 step in each cardinal
    // direction at foot level so the bot can flee BEFORE stepping into lava.
    let inLava = !!b.entity.isInLava;
    let inWater = !!b.entity.isInWater;
    let onFire = !!b.entity.metadata?.[0] && (b.entity.metadata[0] & 0x01) !== 0;
    const footPos = myPos.floored();
    const lavaNeighbors = [];
    if (typeof b.blockAt === 'function') {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const probe = b.blockAt(footPos.offset(dx, 0, dz));
        if (probe?.name === 'lava') lavaNeighbors.push({ x: footPos.x + dx, y: footPos.y, z: footPos.z + dz });
      }
      // Below-foot lava is the next-step death.
      const below = b.blockAt(footPos.offset(0, -1, 0));
      if (below?.name === 'lava') lavaNeighbors.push({ x: footPos.x, y: footPos.y - 1, z: footPos.z });
    }

    return {
      bot: b,
      myPos,
      anchor,
      distFromAnchor,
      hp: b.health,
      food: b.food,
      recently_damaged: !!recentlyDamaged,
      hostiles,
      closest_hostile: hostiles[0] || null,
      closest_creeper: hostiles.find((h) => h.name === 'creeper') || null,
      closest_ranged: closestRanged,
      weapon: weapon ? weapon.name : null,
      armor_count: armorCount,
      // Environmental hazards
      in_lava: inLava,
      on_fire: onFire,
      lava_neighbors: lavaNeighbors,
      adjacent_lava: lavaNeighbors.length > 0,
      in_water: inWater,
      oxygen: typeof b.oxygenLevel === 'number' ? b.oxygenLevel : 20,
    };
  }

  function decide(state) {
    const mode = ctx.reactive.mode || 'normal';
    if (mode === 'hold') return null;

    const anchorRange = mode === 'guard' ? ANCHOR_RANGE_GUARD : ANCHOR_RANGE_NORMAL;

    // ── Always-on environmental safety (overrides combat, fires in hold mode
    //    too — we never let the bot stand in lava or drown to follow orders).
    //    Lava: PREEMPTIVE — any adjacent lava cell (or in-lava / on-fire)
    //    triggers escape so the bot moves BEFORE taking fire damage, not
    //    after. Submerged + low oxygen → swim up.
    if (state.in_lava || state.adjacent_lava || state.on_fire) {
      const why = state.in_lava ? 'in_lava'
                 : state.on_fire ? 'on_fire'
                 : 'adjacent_lava';
      return { action: 'escape_lava', hazards: state.lava_neighbors, why };
    }
    // Drowning protection. Oxygen ranges 0-20 (one tick = 1 second IRL).
    // Damage starts when oxygen hits -1. At threshold 14 we have ~7s of
    // air left — plenty of time for pathfinder cancel + surface, even
    // accounting for 400ms reactive tick latency. Old threshold of 8
    // was too tight: bot would start taking damage before swim_up
    // could override a pathfinder goal that was driving it deeper.
    if (state.in_water && state.oxygen <= 14) {
      return { action: 'swim_up', oxygen: state.oxygen, why: 'low_oxygen' };
    }

    // Always-on safety: creeper proximity flees regardless of mode.
    if (state.closest_creeper && state.closest_creeper.distance <= CREEPER_FLEE_RANGE) {
      return { action: 'flee_step', threat: state.closest_creeper, why: 'creeper_close' };
    }

    // Always-on safety: very low HP + active damage → bounded flee.
    if (state.hp <= LOW_HP_FLEE && state.recently_damaged && state.closest_hostile) {
      return { action: 'flee_step', threat: state.closest_hostile, why: 'critical_hp' };
    }

    // Preemptive dodge: ranged hostile in sight + no weapon = always flee.
    // Standing still under archer fire is the worst response, so the bot
    // zig-zags continuously even before the first arrow lands.
    if (state.closest_ranged && !state.weapon) {
      return { action: 'flee_step', threat: state.closest_ranged, why: 'ranged_no_weapon' };
    }

    if (!state.closest_hostile) return null;
    const dist = state.closest_hostile.distance;
    const engageRange = mode === 'guard' ? GUARD_RANGE : MELEE_RANGE;
    // Triggered when:
    //   - hostile is in melee/guard range (always engage)
    //   - in normal mode, hostile recently damaged us (return fire)
    //   - armed bot can see a ranged hostile (close on archer / blaze, never
    //     stand still and soak shots)
    const triggered = dist <= engageRange
      || (mode === 'normal' && state.recently_damaged)
      || (state.weapon && state.closest_ranged);
    if (!triggered) return null;

    // No weapon: only flee if the threat is OUTSIDE melee range. At melee
    // range the bot can punch (1 damage per swing) — slow but viable against
    // a single zombie/spider, especially with saturation regen offsetting
    // the hits taken. Ranged-no-weapon was already handled above.
    if (!state.weapon && dist > MELEE_RANGE + 0.5) {
      return { action: 'flee_step', threat: state.closest_hostile, why: 'no_weapon_distant' };
    }
    // Disengage if HP is shaky and we're being hit.
    if (state.hp <= LOW_HP_DISENGAGE && state.recently_damaged) {
      return { action: 'flee_step', threat: state.closest_hostile, why: 'shaky_hp' };
    }

    // Don't chase past anchor range — fall through to no-op so the agent's
    // task footprint is preserved.
    if (state.distFromAnchor > anchorRange) {
      return { action: 'hold', why: 'anchor_limit' };
    }

    // Hostile is in sight but out of melee → advance one bounded step.
    // This is what makes the bot close on a ranged attacker (skeleton) instead
    // of standing still soaking arrows.
    if (dist > MELEE_RANGE + 0.5) {
      return {
        action: 'advance_step',
        target: state.closest_hostile,
        why: state.recently_damaged ? 'close_under_fire' : 'engage_distant',
      };
    }

    // Engage: single-swing attack + backstep dance.
    return {
      action: 'attack_step',
      target: state.closest_hostile,
      why: mode === 'guard' ? 'guard_engage' : 'self_defense',
    };
  }

  /** Multi-target swing: hit hostiles in melee range this tick, then back-step.
   *
   *  combat_skill ∈ [0, 1] (default 0.5) tunes how lethal the bot is per tick:
   *    - At skill 1.0 (soldier): every melee target struck every tick.
   *    - At skill 0.5 (default): closest target always struck; each additional
   *      target gets a fading roll (skill, skill², skill³, …).
   *    - At skill 0.0 (helpless farmer): only the closest target, and only
   *      every other tick (still always responds — never stuck doing nothing).
   *
   *  Single-target focus while N attackers pile on is fatal in multi-mob
   *  encounters; tuning skill lets us model soldier vs farmer characters
   *  without rewriting the engagement logic.
   */
  async function attackStep(state) {
    const b = state.bot;
    const skill = clampSkill(ctx.reactive.combat_skill);
    // Equip best available weapon ONCE for this tick (not per target).
    if (state.weapon && b.heldItem?.name !== state.weapon) {
      const item = b.inventory.items().find((i) => i.name === state.weapon);
      if (item) {
        try { await b.equip(item, 'hand'); } catch {}
      }
    }
    // Hostiles within MELEE_RANGE + small slack, closest first.
    const meleeAll = state.hostiles
      .filter((h) => h.distance <= MELEE_RANGE + 0.5)
      .map((h) => h.entity);
    if (meleeAll.length === 0) return;
    // Closest is always struck. Each additional target rolls against decaying
    // skill thresholds: 2nd needs `skill`, 3rd needs `skill²`, 4th `skill³`.
    // This keeps the curve smooth and lets a half-skill bot reliably handle
    // 2 attackers while a full-skill bot still mops up 6.
    const meleeTargets = [meleeAll[0]];
    let threshold = skill;
    for (let i = 1; i < meleeAll.length; i++) {
      if (Math.random() < threshold) meleeTargets.push(meleeAll[i]);
      threshold *= skill;
    }
    for (const target of meleeTargets) {
      if (!target || !target.isValid) continue;
      // Skip targets blocked by a wall. Without this, a sealed shelter
      // is no defense — reactive will hammer mobs through cobblestone.
      if (!reactiveCanHit(target)) continue;
      try {
        await b.lookAt(target.position.offset(0, (target.height || 1.8) * 0.6, 0), true);
        await b.attack(target);
      } catch {
        /* target moved out of reach — try next */
      }
    }
    // After the volley, mix retreat directions so the bot doesn't get pushed
    // into a corner. Strafing combined with sprint produces a real lateral
    // step (not just a wiggle); settleStuck escalates to a jump if blocked.
    const dir = pickRetreatDir(state);
    // Snapshot — state.myPos is a live mineflayer Vec3 that moves with the
    // bot, so we'd diff zero if we passed it through.
    const startPos = { x: state.myPos.x, z: state.myPos.z };
    try {
      if (dir === 'left' || dir === 'right') {
        b.setControlState('sprint', true);
        b.setControlState(dir, true);
      } else {
        b.setControlState('back', true);
      }
      await sleep(stuckTicks > 0 ? 220 : BACKSTEP_MS);
    } finally {
      b.setControlState('left', false);
      b.setControlState('right', false);
      b.setControlState('back', false);
      b.setControlState('sprint', false);
    }
    await settleStuck(b, startPos, 0.3);
  }

  function pickRetreatDir(state) {
    // Wall-aware retreat: peek at the cell each candidate direction would
    // land in (1.5 blocks out) and reject any blocked direction so we don't
    // back into the corner we're trying to escape. If all three are blocked
    // we still pick 'back' — settleStuck's jump may dislodge a 1-block lip.
    const b = state.bot;
    const yaw = b.entity.yaw;
    // mineflayer convention: forward = (-sin(yaw), -cos(yaw)).
    const dirs = {
      back:  { dx:  Math.sin(yaw), dz:  Math.cos(yaw) },
      left:  { dx: -Math.cos(yaw), dz:  Math.sin(yaw) },
      right: { dx:  Math.cos(yaw), dz: -Math.sin(yaw) },
    };
    const passable = {};
    for (const [name, { dx, dz }] of Object.entries(dirs)) {
      const tx = Math.floor(state.myPos.x + dx * 1.5);
      const ty = Math.floor(state.myPos.y);
      const tz = Math.floor(state.myPos.z + dz * 1.5);
      const feet = b.blockAt(new Vec3(tx, ty, tz));
      const head = b.blockAt(new Vec3(tx, ty + 1, tz));
      passable[name] = (!feet || feet.boundingBox === 'empty')
        && (!head || head.boundingBox === 'empty');
    }

    // Stuck escalation: strafe only — pressing 'back' into a wall just
    // pins the bot harder. Prefer the passable side when only one is open.
    if (stuckTicks >= 1) {
      if (passable.left && !passable.right) return 'left';
      if (passable.right && !passable.left) return 'right';
      return Math.random() < 0.5 ? 'left' : 'right';
    }

    // Normal: weighted random over PASSABLE directions only. Back is
    // double-weighted to keep the ~40% back / 30% / 30% baseline when no
    // wall is in the way.
    const pool = [];
    if (passable.back) pool.push('back', 'back');
    if (passable.left) pool.push('left');
    if (passable.right) pool.push('right');
    if (pool.length === 0) return 'back';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function clampSkill(v) {
    const n = typeof v === 'number' ? v : 0.5;
    if (!Number.isFinite(n)) return 0.5;
    return Math.max(0, Math.min(1, n));
  }

  /** Compare position before/after a movement attempt, increment or decay
   *  the shared stuckTicks counter, and try a jump to dislodge if no
   *  progress was made. Used by every movement step (attack, flee, advance)
   *  so the escalation logic in pickFleeDirection / pickRetreatDir is fed
   *  by every kind of stall, not just one. */
  async function settleStuck(b, startPos, threshold) {
    const endPos = b.entity?.position;
    if (!endPos) return;
    const moved = Math.hypot(endPos.x - startPos.x, endPos.z - startPos.z);
    if (moved < threshold) {
      stuckTicks++;
      try {
        b.setControlState('jump', true);
        await sleep(150);
      } finally {
        b.setControlState('jump', false);
      }
    } else if (stuckTicks > 0) {
      stuckTicks = Math.max(0, stuckTicks - 1);
    }
  }

  /** Bounded micro-advance: equip the weapon and step toward the hostile.
   *  Mirrors fleeStep but in reverse — used to close on a ranged attacker.
   *  Each tick takes ~1.5 blocks of forward sprint, so a skeleton at 10
   *  blocks is reached in ~7 ticks (~3s). No pathfinder, no goto — bounded
   *  per-tick movement so the next tick can re-evaluate. settleStuck
   *  triggers a jump if a barrier blocks the straight line to the target.
   *
   *  When closing on a ranged hostile (skeleton, blaze, ghast), the
   *  forward sprint is combined with a randomly chosen lateral strafe so
   *  the bot zig-zags during approach instead of presenting a straight-
   *  line target for lead-shot arrows. */
  async function advanceStep(state, target) {
    const b = state.bot;
    if (state.weapon && b.heldItem?.name !== state.weapon) {
      const item = b.inventory.items().find((i) => i.name === state.weapon);
      if (item) {
        try { await b.equip(item, 'hand'); } catch {}
      }
    }
    const isRanged = RANGED_HOSTILE_NAMES.has((target.name || '').toLowerCase());
    // Flip lateral each tick so the bot zig-zags during approach. With the
    // ~360ms hold below, that gives a ~720ms cycle (left → right → left …)
    // — long enough for sprint to engage on each side, short enough that
    // skeleton lead-shots can't reliably hit.
    if (isRanged) {
      if (advanceLateralHold <= 0) {
        advanceLateral = advanceLateral === 'left' ? 'right'
                       : advanceLateral === 'right' ? 'left'
                       : (Math.random() < 0.5 ? 'left' : 'right');
        advanceLateralHold = 1;
      }
      advanceLateralHold--;
    } else {
      advanceLateral = null;
      advanceLateralHold = 0;
    }
    const lateral = advanceLateral;
    const startPos = { x: state.myPos.x, z: state.myPos.z };
    try {
      await b.lookAt(target.position.offset(0, (target.height || 1.8) * 0.6, 0), true);
      b.setControlState('forward', true);
      b.setControlState('sprint', true);
      if (lateral) b.setControlState(lateral, true);
      // Hold for nearly the full tick interval — releasing controls before
      // the next tick fires causes the bot to coast/stop in the inter-tick
      // gap, which reads as "pausing between zig-zags" and prevents sprint
      // physics from engaging at all.
      await sleep(360);
    } finally {
      b.setControlState('forward', false);
      b.setControlState('sprint', false);
      if (lateral) b.setControlState(lateral, false);
    }
    await settleStuck(b, startPos, 0.3);
  }

  /** Pick a flee direction away from the threat, biased ±35° for zig-zag,
   *  but rotate further if the chosen direction is blocked by a wall.
   *
   *  Escalation when `stuckTicks` is high (the bot didn't actually move on
   *  recent attempts):
   *    - 0 stuck ticks: prefer "directly away with jitter".
   *    - 1+ stuck ticks: skip the direct-away candidate, force ±60° / ±90°.
   *    - 2+ stuck ticks: try fully random 360° angles. Even moving CLOSER
   *      to the enemy is better than grinding into a wall — a corner-pinned
   *      bot is dead anyway.
   */
  function pickFleeDirection(state, threat, stuckTicks) {
    const b = state.bot;
    const dx = state.myPos.x - threat.position.x;
    const dz = state.myPos.z - threat.position.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const baseX = dx / len;
    const baseZ = dz / len;
    const jitter = (Math.random() - 0.5) * 1.22; // ±35°
    const candidates = stuckTicks >= 2
      // Heavily stuck: 6 random 360° rotations. Anything to break the pin.
      ? Array.from({ length: 6 }, () => Math.random() * Math.PI * 2)
      : stuckTicks === 1
        // Moderately stuck: skip "directly back," try wider angles first.
        ? [Math.PI * 0.6, -Math.PI * 0.6, Math.PI / 2, -Math.PI / 2, Math.PI, jitter]
        // Normal: zig-zag, then escalating dodges.
        : [
            jitter,
            jitter + (Math.random() < 0.5 ? 1.05 : -1.05),
            Math.PI / 2,
            -Math.PI / 2,
          ];
    for (const offset of candidates) {
      const cos = Math.cos(offset);
      const sin = Math.sin(offset);
      const rotX = baseX * cos - baseZ * sin;
      const rotZ = baseX * sin + baseZ * cos;
      const tx = Math.floor(state.myPos.x + rotX * 1.5);
      const tz = Math.floor(state.myPos.z + rotZ * 1.5);
      const ty = Math.floor(state.myPos.y);
      const feet = b.blockAt(new Vec3(tx, ty, tz));
      const head = b.blockAt(new Vec3(tx, ty + 1, tz));
      const passable =
        (!feet || feet.boundingBox === 'empty') &&
        (!head || head.boundingBox === 'empty');
      if (passable) return { rotX, rotZ };
    }
    return { rotX: baseX, rotZ: baseZ };
  }

  /** Bounded micro-flee: step 1-2 blocks AWAY from the threat, no further than
   *  SAFE_DISTANCE. Wall-aware (rotates angle if blocked) and zig-zags so
   *  ranged threats can't lead-shot a stationary target. settleStuck
   *  escalates to fully random angles via pickFleeDirection when the bot
   *  is repeatedly pinned in a corner.
   *
   *  Creeper escapes are direct (no lateral jitter) — the goal is to
   *  maximize distance before fuse expires, and zig-zag would slow the
   *  away-vector. Other threats (skeletons, etc.) keep the zig-zag so
   *  arrows can't lead-shot. Sleep matches the tick interval so the bot
   *  sprints continuously instead of stopping in the inter-tick gap. */
  async function fleeStep(state, threat) {
    const b = state.bot;
    const isRanged = RANGED_HOSTILE_NAMES.has((threat.name || '').toLowerCase());
    const isCreeper = (threat.name || '').toLowerCase() === 'creeper';
    if (!isRanged && threat.distance >= SAFE_DISTANCE) {
      stuckTicks = 0; // moving freely, reset stuck counter
      return;
    }
    const startPos = { x: state.myPos.x, z: state.myPos.z };
    const startDist = threat.distance;
    let rotX, rotZ;
    if (isCreeper) {
      // Hold the chosen direction for 2 ticks so sprint physics engage,
      // but bail out immediately and re-pick if we DIDN'T increase distance
      // last tick — that means we're pushing into a wall or the chosen
      // direction is no longer optimal (creeper moved).
      if (creeperFleeHold > 0 && creeperFleeDir && startDist >= (creeperFleeLastDist ?? 0) - 0.1) {
        rotX = creeperFleeDir.rotX;
        rotZ = creeperFleeDir.rotZ;
        creeperFleeHold--;
      } else {
        const pick = pickMaxDistanceDirection(state, threat);
        rotX = pick.rotX;
        rotZ = pick.rotZ;
        creeperFleeDir = pick;
        creeperFleeHold = 1; // 2 ticks total (this + 1 hold)
      }
      creeperFleeLastDist = startDist;
    } else {
      const pick = pickFleeDirection(state, threat, stuckTicks);
      rotX = pick.rotX;
      rotZ = pick.rotZ;
    }
    const stepX = state.myPos.x + rotX * 2;
    const stepZ = state.myPos.z + rotZ * 2;
    try {
      await b.lookAt(new Vec3(stepX, state.myPos.y + 1.6, stepZ), true);
      b.setControlState('forward', true);
      b.setControlState('sprint', true);
      await sleep(360);
    } finally {
      b.setControlState('forward', false);
      b.setControlState('sprint', false);
    }
    // Creeper flee skips settleStuck: jumping into a wall wastes 150ms and
    // doesn't help. Distance progress is policed by the re-pick guard above.
    if (!isCreeper) {
      await settleStuck(b, startPos, 0.4);
    }
  }

  /** Sample 12 candidate directions around the bot and pick the one whose
   *  2-block projection results in the greatest distance from the threat.
   *  This implements "increase distance, travelling along the wall or in
   *  any direction that works" — when straight-away is blocked, the
   *  perpendicular wall-slide naturally scores highest among passable
   *  options because anything else either re-approaches the threat or is
   *  also blocked. If all candidates are blocked, falls back to a unit
   *  direct-away vector. Used for creeper flee where distance matters
   *  more than dodge unpredictability. */
  function pickMaxDistanceDirection(state, threat) {
    const b = state.bot;
    const myX = state.myPos.x;
    const myZ = state.myPos.z;
    const tx0 = threat.position.x;
    const tz0 = threat.position.z;
    const ty = Math.floor(state.myPos.y);
    const candidates = [];
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * 2 * Math.PI;
      const rotX = Math.cos(angle);
      const rotZ = Math.sin(angle);
      let passable = true;
      // Sample at 1.0, 2.0, 3.0 — every-block coverage catches a wall
      // 1 block away. (Sub-block sample distances like 1.5 floor past a
      // close wall and report the void beyond as passable, which is the
      // bug L3.62 exposed when the bot wouldn't slide along walls.)
      for (const dist of [1.0, 2.0, 3.0]) {
        const px = Math.floor(myX + rotX * dist);
        const pz = Math.floor(myZ + rotZ * dist);
        const feet = b.blockAt(new Vec3(px, ty, pz));
        const head = b.blockAt(new Vec3(px, ty + 1, pz));
        if ((feet && feet.boundingBox !== 'empty') || (head && head.boundingBox !== 'empty')) {
          passable = false;
          break;
        }
      }
      if (!passable) continue;
      const newX = myX + rotX * 2;
      const newZ = myZ + rotZ * 2;
      candidates.push({ rotX, rotZ, dist: Math.hypot(newX - tx0, newZ - tz0) });
    }
    if (candidates.length === 0) {
      const dx = myX - tx0;
      const dz = myZ - tz0;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      return { rotX: dx / len, rotZ: dz / len };
    }
    candidates.sort((a, c) => c.dist - a.dist);
    return { rotX: candidates[0].rotX, rotZ: candidates[0].rotZ };
  }

  let inFlight = false;
  let lastDecisionWhy = null;
  let attackTickGate = 0;       // counts ticks since last attack — used by low-skill throttle
  let stuckTicks = 0;            // count of recent ticks where flee/strafe failed to move
  let advanceLateral = null;     // last chosen lateral strafe during advance ('left'|'right'|null)
  let advanceLateralHold = 0;    // ticks remaining before flipping advanceLateral
  let creeperFleeDir = null;     // last chosen flee vector during creeper escape (held across ticks)
  let creeperFleeHold = 0;       // ticks remaining before re-evaluating creeperFleeDir
  let creeperFleeLastDist = 0;   // distance to creeper at last flee tick — used to detect lack of progress

  async function tick() {
    if (!ctx.world.bot || !ctx.world.botReady || inFlight) return;
    const state = readState();
    if (!state) return;
    const decision = decide(state);

    // Update anchor to "current position" only when we go idle. Doing this
    // means the anchor follows the agent's explicit movements, but it doesn't
    // drift during reactive's own micro-movements.
    if (!decision || decision.action === 'hold') {
      ctx.reactive.reactiveAnchor = { x: state.myPos.x, y: state.myPos.y, z: state.myPos.z };
      lastDecisionWhy = null;
      attackTickGate = 0;
      return;
    }

    // Skill-based attack throttling: a 0.0-skill farmer skips ~2/3 of attack
    // ticks; full-skill soldier never skips. Flee is never throttled — we
    // never want a low-skill bot to *fail to dodge*. The skip is what gives
    // attackStep its multi-target opportunity — at skill 0.5 each attack
    // catches several zombies converging into melee range during the gap.
    if (decision.action === 'attack_step') {
      const skill = clampSkill(ctx.reactive.combat_skill);
      const skipBudget = Math.round((1 - skill) * 2); // 0..2 ticks skipped
      if (attackTickGate < skipBudget) {
        attackTickGate++;
        return;
      }
      attackTickGate = 0;
    }

    // Log on transition (don't spam every tick of an ongoing engagement).
    if (decision.why !== lastDecisionWhy) {
      const skill = clampSkill(ctx.reactive.combat_skill);
      log(
        `[reactive] mode=${ctx.reactive.mode} skill=${skill.toFixed(2)} hp=${state.hp.toFixed(1)} weap=${state.weapon || 'none'} armor=${state.armor_count} hostile=${state.closest_hostile?.name || 'none'}@${state.closest_hostile?.distance?.toFixed(1) || '-'} → ${decision.action} (${decision.why})`,
      );
      pushAutoEvent({
        kind: 'auto_action_started',
        mode: ctx.reactive.mode,
        action: decision.action,
        why: decision.why,
        target: state.closest_hostile?.name,
        hp: state.hp,
      });
      lastDecisionWhy = decision.why;
    }

    inFlight = true;
    try {
      if (decision.action === 'attack_step') {
        await attackStep(state);
      } else if (decision.action === 'flee_step') {
        await fleeStep(state, decision.threat);
      } else if (decision.action === 'advance_step') {
        await advanceStep(state, decision.target.entity);
      } else if (decision.action === 'escape_lava') {
        await escapeLava(state, decision.hazards);
      } else if (decision.action === 'swim_up') {
        await swimUp(state);
      }
    } catch (e) {
      log(`[reactive] ${decision.action} error: ${/** @type {Error} */ (e).message || e}`);
    } finally {
      inFlight = false;
    }
  }

  /**
   * Emergency lava escape. Picks a safety vector AWAY from the centroid of
   * detected lava cells, looks there, and SUSTAINED-sprints for up to 1.5s
   * — long enough to clear 6-8 blocks of distance, well outside any
   * subsequent lava-flow re-engulfment. Bounded so the bot can still
   * re-evaluate, but biased toward "get FAR" not "step back".
   *
   * Re-checks every 200ms during the sprint: if no longer adjacent to lava
   * AND not on fire, break early (don't waste time fleeing a safe zone).
   */
  async function escapeLava(state, lavaHazards) {
    const b = state.bot;
    const startPos = { x: state.myPos.x, z: state.myPos.z };
    // Safety vector: away from average lava position.
    let safeDx = 0, safeDz = 0;
    if (lavaHazards && lavaHazards.length > 0) {
      const cx = lavaHazards.reduce((s, h) => s + h.x + 0.5, 0) / lavaHazards.length;
      const cz = lavaHazards.reduce((s, h) => s + h.z + 0.5, 0) / lavaHazards.length;
      safeDx = state.myPos.x - cx;
      safeDz = state.myPos.z - cz;
      const mag = Math.hypot(safeDx, safeDz);
      if (mag > 0.01) { safeDx /= mag; safeDz /= mag; }
    } else {
      // No lava cells but on_fire — just sprint forward to clear any pursuing
      // flame source. Direction doesn't matter as much; pick the bot's
      // current facing.
      safeDx = -Math.sin(b.entity.yaw);
      safeDz = Math.cos(b.entity.yaw);
    }
    try {
      const lookTarget = state.myPos.offset(safeDx * 8, 0, safeDz * 8);
      await b.lookAt(lookTarget, true);
    } catch { /* best-effort */ }
    try {
      b.setControlState('jump', true);
      b.setControlState('sprint', true);
      b.setControlState('forward', true);
      // Sustained sprint loop: ~1.5s max, breaking early once safe.
      for (let i = 0; i < 7; i++) {
        await sleep(200);
        // Re-read after each tick: safe if not in/adjacent to lava + not on fire.
        const stillBurning = !!b.entity?.metadata?.[0] && (b.entity.metadata[0] & 0x01) !== 0;
        const stillInLava = !!b.entity?.isInLava;
        if (!stillBurning && !stillInLava) {
          // Quick check: any lava block within 1 cardinal? If clear, break.
          const fp = b.entity.position.floored();
          let anyNeighborLava = false;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const probe = b.blockAt(fp.offset(dx, 0, dz));
            if (probe?.name === 'lava') { anyNeighborLava = true; break; }
          }
          if (!anyNeighborLava) break;
        }
      }
    } finally {
      b.setControlState('forward', false);
      b.setControlState('sprint', false);
      b.setControlState('jump', false);
    }
    await settleStuck(b, startPos, 0.3);
  }

  /**
   * Swim up out of water. Cancels any active pathfinder goal first —
   * the most common cause of drowning is pathfinder driving the bot
   * into/through water to reach a target (e.g. an underwater stone
   * the visibility scan saw through the surface). Then holds jump
   * (which acts as swim-up when submerged) for a sustained burst,
   * long enough to break the surface.
   */
  async function swimUp(state) {
    const b = state.bot;
    // Cancel any goal that's driving the bot deeper. Without this, the
    // pathfinder's own control states override our jump/forward and
    // keep walking the bot underwater toward its target.
    try {
      if (b.pathfinder) b.pathfinder.setGoal(null);
    } catch { /* pathfinder not available */ }
    const startPos = { x: state.myPos.x, z: state.myPos.z };
    try {
      b.setControlState('jump', true);
      b.setControlState('forward', true);
      // 800ms (was 300ms) — long enough for ~2 reactive ticks of jump
      // hold to break surface even from 2-3 blocks deep.
      await sleep(800);
    } finally {
      b.setControlState('jump', false);
      b.setControlState('forward', false);
    }
    await settleStuck(b, startPos, 0.1);
  }

  function pushAutoEvent(event) {
    if (!ctx.reactive.autoActionLog) ctx.reactive.autoActionLog = [];
    ctx.reactive.autoActionLog.push({ ...event, ts: Date.now() });
    if (ctx.reactive.autoActionLog.length > 32) ctx.reactive.autoActionLog.shift();
  }

  // Reset closure-local state on every death event so a fresh respawn
  // doesn't carry stale stuckTicks/anchor from the pre-death situation
  // (anchor would point at the death cell, which a respawned bot is
  // typically far from — every subsequent tick would 'hold' until the
  // anchor naturally resets). Also makes deaths visible in the reactive
  // log alongside attack/flee decisions.
  function onDeath() {
    stuckTicks = 0;
    attackTickGate = 0;
    inFlight = false;
    lastDecisionWhy = null;
    advanceLateral = null;
    advanceLateralHold = 0;
    creeperFleeDir = null;
    creeperFleeHold = 0;
    creeperFleeLastDist = 0;
    ctx.reactive.reactiveAnchor = null;
    const n = ctx.death.deathLog?.length ?? '?';
    log(`[reactive] death #${n} — reset stuckTicks/anchor, mode=${ctx.reactive.mode}`);
    pushAutoEvent({ action: 'death_reset', death_number: n });
  }

  return {
    start() {
      if (ctx.reactive._reactiveInterval) clearInterval(ctx.reactive._reactiveInterval);
      if (!ctx.reactive.mode) ctx.reactive.mode = 'normal';
      ctx.reactive.reactiveAnchor = null; // re-set on first tick
      ctx.reactive._reactiveInterval = setInterval(() => {
        tick().catch((e) => log(`[reactive] tick error: ${/** @type {Error} */ (e).message || e}`));
      }, TICK_MS);
      if (ctx.reactive.combat_skill === undefined) ctx.reactive.combat_skill = 0.5;
      // Hook the death event once per bot instance. on() with the same
      // listener twice would double-fire on subsequent deaths.
      const b = ctx.world.bot;
      if (b && !b._reactiveDeathHookInstalled) {
        b.on('death', onDeath);
        b._reactiveDeathHookInstalled = true;
      }
      log(`[reactive] started (mode=${ctx.reactive.mode}, skill=${ctx.reactive.combat_skill}, tick=${TICK_MS}ms, anchor=${ANCHOR_RANGE_NORMAL}/${ANCHOR_RANGE_GUARD})`);
    },
    stop() {
      if (ctx.reactive._reactiveInterval) {
        clearInterval(ctx.reactive._reactiveInterval);
        ctx.reactive._reactiveInterval = null;
      }
    },
  };
}
