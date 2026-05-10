/**
 * Reactive layer (Layer 2 per docs/phase-2-architecture.md §16).
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
 *   ctx.combat_skill ∈ [0, 1] — soldier vs farmer. Scales multi-target hit
 *                               probability and tick rate. Set via mc combat_skill.
 *
 * Stuck escalation (shared across all movement steps):
 *   stuckTicks=0  → normal jitter ±35°, 50% back / 25%×2 strafe
 *   stuckTicks=1  → wider angles, strafe-only retreat, longer movement
 *   stuckTicks=2+ → fully random 360° angle (may move toward the enemy);
 *                   plus a jump to dislodge from 1-block lips and mob pins
 *
 * Auto-fired actions are recorded in ctx.autoActionLog for the agent to read.
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
  const { ctx, log, ACTIONS, sleep } = deps;

  function isHostile(entity) {
    if (!entity || !entity.position || entity === ctx.bot?.entity) return false;
    return HOSTILE_NAMES.has((entity.name || '').toLowerCase());
  }

  function readState() {
    const b = ctx.bot;
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

    const damageEvent = ctx.lastDamageEvent;
    const recentlyDamaged = damageEvent && (Date.now() - damageEvent.ts) < RECENT_DAMAGE_MS;
    const weapon = b.inventory.items().find((i) => WEAPON_PATTERN.test(i.name));
    const armorCount = [5, 6, 7, 8].filter((s) => b.inventory.slots[s]).length;

    // Anchor: where the bot was at the most recent moment Layer 2 was idle.
    // (For now, default to the bot's current position when no anchor set.)
    if (!ctx.reactiveAnchor) {
      ctx.reactiveAnchor = { x: myPos.x, y: myPos.y, z: myPos.z };
    }
    const anchor = ctx.reactiveAnchor;
    const distFromAnchor = Math.sqrt(
      (myPos.x - anchor.x) ** 2 + (myPos.z - anchor.z) ** 2,
    );

    const closestRanged = hostiles.find(
      (h) => RANGED_HOSTILE_NAMES.has((h.name || '').toLowerCase()) && h.distance <= RANGED_AWARE_RANGE,
    ) || null;

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
    };
  }

  function decide(state) {
    const mode = ctx.mode || 'normal';
    if (mode === 'hold') return null;

    const anchorRange = mode === 'guard' ? ANCHOR_RANGE_GUARD : ANCHOR_RANGE_NORMAL;

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

    // No weapon → bounded flee instead of fight.
    if (!state.weapon) {
      return { action: 'flee_step', threat: state.closest_hostile, why: 'no_weapon' };
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
    const skill = clampSkill(ctx.combat_skill);
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
    const dir = pickRetreatDir();
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

  function pickRetreatDir() {
    // Heavier strafe bias when stuck — corner-pinned bot gets out via the
    // sides, not by pressing harder against the wall behind it.
    const r = Math.random();
    if (stuckTicks >= 1) return r < 0.5 ? 'left' : 'right';
    if (r < 0.4) return 'back';
    return r < 0.7 ? 'left' : 'right';
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
   *  triggers a jump if a barrier blocks the straight line to the target. */
  async function advanceStep(state, target) {
    const b = state.bot;
    if (state.weapon && b.heldItem?.name !== state.weapon) {
      const item = b.inventory.items().find((i) => i.name === state.weapon);
      if (item) {
        try { await b.equip(item, 'hand'); } catch {}
      }
    }
    const startPos = { x: state.myPos.x, z: state.myPos.z };
    try {
      await b.lookAt(target.position.offset(0, (target.height || 1.8) * 0.6, 0), true);
      b.setControlState('sprint', true);
      b.setControlState('forward', true);
      await sleep(220);
    } finally {
      b.setControlState('forward', false);
      b.setControlState('sprint', false);
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
   *  is repeatedly pinned in a corner. */
  async function fleeStep(state, threat) {
    const b = state.bot;
    const isRanged = RANGED_HOSTILE_NAMES.has((threat.name || '').toLowerCase());
    if (!isRanged && threat.distance >= SAFE_DISTANCE) {
      stuckTicks = 0; // moving freely, reset stuck counter
      return;
    }
    const startPos = { x: state.myPos.x, z: state.myPos.z };
    const { rotX, rotZ } = pickFleeDirection(state, threat, stuckTicks);
    const stepX = state.myPos.x + rotX * 2;
    const stepZ = state.myPos.z + rotZ * 2;
    try {
      await b.lookAt(new Vec3(stepX, state.myPos.y + 1.6, stepZ), true);
      b.setControlState('sprint', true);
      b.setControlState('forward', true);
      await sleep(260);
    } finally {
      b.setControlState('forward', false);
      b.setControlState('sprint', false);
    }
    await settleStuck(b, startPos, 0.4);
  }

  let inFlight = false;
  let lastDecisionWhy = null;
  let attackTickGate = 0; // counts ticks since last attack — used by low-skill throttle
  let stuckTicks = 0;     // count of recent ticks where flee/strafe failed to move

  async function tick() {
    if (!ctx.bot || !ctx.botReady || inFlight) return;
    const state = readState();
    if (!state) return;
    const decision = decide(state);

    // Update anchor to "current position" only when we go idle. Doing this
    // means the anchor follows the agent's explicit movements, but it doesn't
    // drift during reactive's own micro-movements.
    if (!decision || decision.action === 'hold') {
      ctx.reactiveAnchor = { x: state.myPos.x, y: state.myPos.y, z: state.myPos.z };
      lastDecisionWhy = null;
      attackTickGate = 0;
      return;
    }

    // Skill-based attack throttling: a 0.0-skill farmer skips ~2/3 of attack
    // ticks; full-skill soldier never skips. Flee is never throttled — we
    // never want a low-skill bot to *fail to dodge*.
    if (decision.action === 'attack_step') {
      const skill = clampSkill(ctx.combat_skill);
      // Guarantee at least 1 swing per ~3 ticks even at skill 0; otherwise
      // skill scales linearly between minSkip and 0 skipped ticks.
      const skipBudget = Math.round((1 - skill) * 2); // 0..2 ticks skipped
      if (attackTickGate < skipBudget) {
        attackTickGate++;
        return;
      }
      attackTickGate = 0;
    }

    // Log on transition (don't spam every tick of an ongoing engagement).
    if (decision.why !== lastDecisionWhy) {
      const skill = clampSkill(ctx.combat_skill);
      log(
        `[reactive] mode=${ctx.mode} skill=${skill.toFixed(2)} hp=${state.hp.toFixed(1)} weap=${state.weapon || 'none'} armor=${state.armor_count} hostile=${state.closest_hostile?.name || 'none'}@${state.closest_hostile?.distance?.toFixed(1) || '-'} → ${decision.action} (${decision.why})`,
      );
      pushAutoEvent({
        kind: 'auto_action_started',
        mode: ctx.mode,
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
      }
    } catch (e) {
      log(`[reactive] ${decision.action} error: ${/** @type {Error} */ (e).message || e}`);
    } finally {
      inFlight = false;
    }
  }

  function pushAutoEvent(event) {
    if (!ctx.autoActionLog) ctx.autoActionLog = [];
    ctx.autoActionLog.push({ ...event, ts: Date.now() });
    if (ctx.autoActionLog.length > 32) ctx.autoActionLog.shift();
  }

  return {
    start() {
      if (ctx._reactiveInterval) clearInterval(ctx._reactiveInterval);
      if (!ctx.mode) ctx.mode = 'normal';
      ctx.reactiveAnchor = null; // re-set on first tick
      ctx._reactiveInterval = setInterval(() => {
        tick().catch((e) => log(`[reactive] tick error: ${/** @type {Error} */ (e).message || e}`));
      }, TICK_MS);
      if (ctx.combat_skill === undefined) ctx.combat_skill = 0.5;
      log(`[reactive] started (mode=${ctx.mode}, skill=${ctx.combat_skill}, tick=${TICK_MS}ms, anchor=${ANCHOR_RANGE_NORMAL}/${ANCHOR_RANGE_GUARD})`);
    },
    stop() {
      if (ctx._reactiveInterval) {
        clearInterval(ctx._reactiveInterval);
        ctx._reactiveInterval = null;
      }
    },
  };
}
