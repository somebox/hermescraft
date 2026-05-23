/** @size-exempt: goto / goto_near / move share pathfinder + stall recovery */
/**
 * Movement action handlers: goto, goto_near, follow, look, stop, move.
 */
import { Vec3 } from 'vec3';
import { raceWithTimeout, timeoutError, OperationTimeoutError, NoProgressError, pathfindWithProgressWatchdog, ACTION_CAPS_MS } from './_helpers.js';
import { findClosestStandable, findStandableSameXZ, standabilityReason, standingState, isStandableCell, computeReachability, targetChunkLoaded } from './_nav-helpers.js';
import { probeRouteAlongLine, probeRouteCorridor } from '../server/route-probe.js';

// Task #21 — force the strategic decision. When the agent calls mc move /
// bg_goto over a long distance, sample the route. If it crosses meaningful
// water and the bot has a boat in inventory, REFUSE and tell the agent to
// place_boat + board + sail. circuit-v5 saw Steve walk into a lake 5x in
// a row instead of using either of his two oak_boats.
const LONG_DISTANCE_THRESHOLD = 100;
const WATER_REFUSAL_THRESHOLD = 6; // of 30 samples (corridor)
// F40 (task #66, v55): probe a 20b-wide corridor (centre + ±10b perpendicular
// offsets, 10 samples each = 30 total) instead of a single straight line.
// circuit-v54 forensics: the straight-line probe from base→W1 had 0/30 water
// samples (line runs SW through dry forest), but the pathfinder detoured NW
// into marshland and stranded Steve in 1-deep water. The corridor probe
// catches water on either side of the straight line — typical detour radius.
const CORRIDOR_OFFSET = 10;
const CORRIDOR_SAMPLES_PER_LANE = 10;
const BOAT_INV_NAMES = new Set([
  'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
  'acacia_boat', 'dark_oak_boat', 'cherry_boat', 'mangrove_boat',
  'bamboo_raft', 'pale_oak_boat',
]);

/**
 * Decide whether to refuse a long-distance navigation that crosses too
 * much water. Pure function — takes a bot-like object and a target.
 * Returns either an envelope (ok:false) to be returned by preflightNav,
 * or null to let the rest of preflight run.
 *
 * Exported so unit tests can exercise the decision logic without booting
 * the rest of createMovementActions.
 */
export function refuseWaterRouteWithoutBoat(b, x, y, z, {
  longDistanceThreshold = LONG_DISTANCE_THRESHOLD,
  waterRefusalThreshold = WATER_REFUSAL_THRESHOLD,
  samples = 30,
} = {}) {
  try {
    const me = b?.entity?.position;
    if (!me) return null;
    const tx = Number(x), ty = Number(y), tz = Number(z);
    if (![tx, ty, tz].every(Number.isFinite)) return null;
    const dist = Math.hypot(me.x - tx, me.y - ty, me.z - tz);
    if (dist < longDistanceThreshold) return null;
    // F40: corridor probe. 3 parallel lines × 10 samples = 30 total samples
    // covering a 20b-wide corridor. The pathfinder typically detours within
    // this width when avoiding obstacles, so water it would encounter on a
    // detour gets sampled too. Keep the original 30-sample threshold so
    // legitimate dry-corridor trips still pass.
    const probe = probeRouteCorridor(
      b,
      { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) },
      { x: Math.floor(tx), y: Math.floor(ty), z: Math.floor(tz) },
      CORRIDOR_SAMPLES_PER_LANE,
      CORRIDOR_OFFSET,
    );
    const counts = probe?.counts || {};
    const waterCount = Number(counts.water || 0);
    if (waterCount < waterRefusalThreshold) return null;
    const boat = (b.inventory?.items?.() || []).find((i) => BOAT_INV_NAMES.has(i.name));
    const samplesArr = probe?.samples || [];
    const firstWater = samplesArr.find((s) => s.classification === 'water');
    // Find the LAST land/wall sample before the first water — that's the
    // shore-stance coord. Pointing the agent at an actual dry shore cell
    // and letting `mc board` (no-args) handle the boat placement is far
    // more reliable than guessing a place_boat coord deep in the lake.
    // circuit-v5d showed the route_probe's ~25-block sample spacing put
    // every "water" sample well past any adjacent shore, so place_boat
    // hits returned NO_STANCE every time.
    let shoreStance = null;
    for (let i = 1; i < samplesArr.length; i++) {
      const s = samplesArr[i];
      const prev = samplesArr[i - 1];
      if (s.classification === 'water' && (prev.classification === 'land' || prev.classification === 'wall')) {
        shoreStance = prev;
        break;
      }
    }
    if (boat) {
      // v27: route the agent at the gated ferry primitive — mc board /
      // mc sail are deprecated and refuse direct calls. mc sail_to runs
      // the BFS plan + walk_to_entry + mount + sail + disembark + walk_to_target
      // end-to-end and is the only supported boat verb.
      const hint = `mc sail_to ${Math.floor(tx)} ${Math.floor(ty)} ${Math.floor(tz)}`;
      return {
        ok: false,
        error: {
          code: 'BOAT_REQUIRED',
          message: `Route to ${Math.floor(tx)},${Math.floor(ty)},${Math.floor(tz)} crosses ${waterCount}/${probe.sample_count} water samples — refusing to walk. You're holding ${boat.name}. Call \`mc sail_to ${Math.floor(tx)} ${Math.floor(ty)} ${Math.floor(tz)}\` — the ferry primitive plans the route, places the boat, sails, and disembarks at the destination shore. Don't try mc board / mc sail directly; they're gated.`,
          observed_state: {
            route_preview: {
              counts,
              sample_count: probe.sample_count,
              first_water: firstWater ? { x: firstWater.x, y: firstWater.y, z: firstWater.z } : null,
              shore_stance: shoreStance ? { x: shoreStance.x, y: shoreStance.y + 1, z: shoreStance.z } : null,
            },
            distance: Math.round(dist),
            boat_in_inventory: boat.name,
            target: { x: Math.floor(tx), y: Math.floor(ty), z: Math.floor(tz) },
          },
          next_action_hint: hint,
          retry_safe: false,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'WATER_ROUTE_NEEDS_BOAT',
        message: `Route to ${Math.floor(tx)},${Math.floor(ty)},${Math.floor(tz)} crosses ${waterCount}/${probe.sample_count} water samples and you have no boat. Craft one with \`mc craft oak_boat\` (needs 5 oak_planks), then call \`mc sail_to ${Math.floor(tx)} ${Math.floor(ty)} ${Math.floor(tz)}\`. Don't try to swim — you'll drown.`,
        observed_state: {
          route_preview: { counts, sample_count: probe.sample_count },
          distance: Math.round(dist),
          target: { x: Math.floor(tx), y: Math.floor(ty), z: Math.floor(tz) },
        },
        next_action_hint: `mc craft oak_boat`,
        retry_safe: false,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'ROUTE_PROBE_FAILED',
        message: `Route probe to ${Math.floor(Number(x))},${Math.floor(Number(y))},${Math.floor(Number(z))} failed (${err?.message || err}) — retry mc goto or use mc sail_to if crossing water.`,
        observed_state: {
          target: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) },
          probe_error: String(err?.message || err),
        },
        next_action_hint: `mc goto ${Math.floor(Number(x))} ${Math.floor(Number(y))} ${Math.floor(Number(z))}`,
        retry_safe: true,
      },
    };
  }
}

// Y-grace: when an agent calls mc move / goto / goto_near with the right
// XZ but a wrong Y (target inside a hill, floating in air), we rescue by
// snapping to the closest standable Y at the same (x,z). ±5 covers the
// common "aimed at a treetop instead of the ground" / "aimed at the
// ground instead of a 3-block ledge" case without silently teleporting
// the agent across major elevation changes.
const Y_GRACE_MAX_DY = 5;

export function createMovementActions({ ctx, ensureBot, goals, fmt, posObj, ACTIONS, hasLineOfSight, eyePosition }) {
  // task #44 (F7, v31): per-target retry tracking for goto. Closure-scoped
  // Map<"verb@x,y,z", { count, lastReason }> that mirrors F6's
  // sailToRetryCounts. After GOTO_RETRY_LIMIT failures to the same floored
  // target, goto refuses with NAV_RETRY_LOOP. v31 forensics: the agent
  // alternated mc bg_goto ↔ mc sail_to on an unreachable peninsula tip
  // and burned ~12 calls (BOAT_REQUIRED → mc sail_to refusal →
  // BOAT_REQUIRED → ...) with no escalation signal. This break the loop
  // by giving the agent a definitive "this target isn't working" signal
  // after 4 attempts.
  /** @type {Map<string, { count: number, lastReason: string|null }>} */
  const gotoRetryCounts = new Map();
  const GOTO_RETRY_LIMIT = 4;
  const gotoRetryKey = (verb, x, y, z) =>
    `${verb}@${Math.floor(Number(x))},${Math.floor(Number(y))},${Math.floor(Number(z))}`;

  // F51.2: mark a movement failure so the position-dependent verb guard
  // can short-circuit dependent commands until the bot acknowledges.
  const recordMoveFailure = (verb, x, y, z, actualPos, reason) => {
    if (!ctx) return;
    ctx.runtime.lastMoveFailed = {
      ts: Date.now(),
      intended_target: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) },
      actual_pos: actualPos ? { x: Math.round(actualPos.x * 10) / 10, y: Math.round(actualPos.y * 10) / 10, z: Math.round(actualPos.z * 10) / 10 } : null,
      reason,
      verb,
    };
    // task #44 (F7): also increment per-target retry count. NAV_RETRY_LOOP
    // is the loop-detector return code itself — don't count it (would
    // re-trigger immediately on the next call).
    if (reason && reason !== 'NAV_RETRY_LOOP') {
      const k = gotoRetryKey(verb, x, y, z);
      const prior = gotoRetryCounts.get(k) || { count: 0, lastReason: null };
      gotoRetryCounts.set(k, { count: prior.count + 1, lastReason: reason });
    }
  };
  // task #44 (F7): clear the per-target retry count for a specific
  // target. Called from goto's success paths so a one-off failure
  // followed by a success doesn't poison the next attempt.
  const clearGotoRetry = (verb, x, y, z) => {
    gotoRetryCounts.delete(gotoRetryKey(verb, x, y, z));
  };
  // Clear the failure flag — called on successful moves.
  // F57.2: on success, also expire any stuck-cell entries near the bot's
  // current position. A successful pathfind that crossed (or skirted) a
  // previously-stuck cell is good evidence that the route is workable
  // again; keep the rest of the registry for unrelated regions.
  const clearMoveFailure = () => {
    if (!ctx) return;
    ctx.runtime.lastMoveFailed = null;
    if (!Array.isArray(ctx.runtime.recentStuckCells) || ctx.runtime.recentStuckCells.length === 0) return;
    try {
      const p = ctx.world.bot?.entity?.position;
      if (!p) return;
      ctx.runtime.recentStuckCells = ctx.runtime.recentStuckCells.filter(e => {
        const dx = e.cell.x - p.x;
        const dy = e.cell.y - p.y;
        const dz = e.cell.z - p.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) > 2.5;
      });
    } catch { /* never let cleanup break success */ }
  };
  // F48: When a nav verb fails, scan a small region around the target
  // for a standable cell and include it in observed_state. Mason in
  // G21 v2 sat through three 15s OPERATION_TIMEOUTs at the same
  // (0,65,12) because every adjacent cell had a wall block at head
  // height — but the error gave him no signal about (0,65,13) being
  // 1 block away and valid. With the closest_standable hint the brain
  // can immediately retry with a working target instead of looping.
  //
  // F50.6: also include `your_standing_state` so the brain sees its
  // own corner/trapped classification on every movement failure.
  const enrichWithStand = (b, observedState, x, y, z) => {
    try {
      const tx = Math.floor(Number(x));
      const ty = Math.floor(Number(y));
      const tz = Math.floor(Number(z));
      const reason = standabilityReason(b, tx, ty, tz);
      const best = findClosestStandable(b, tx, ty, tz, 3);
      observedState.target_standable = (reason === 'ok');
      observedState.target_reason = reason;
      observedState.closest_standable = best
        ? { x: best.x, y: best.y, z: best.z, distance: best.distance }
        : null;
      const ss = standingState(b);
      observedState.your_standing_state = {
        classification: ss.classification,
        blocked_dirs: ss.blocked_dirs,
        open_dirs: ss.open_dirs,
      };
    } catch { /* never let diagnostic enrichment break the error path */ }
    return observedState;
  };

  // F57.2: stuck-cell registry helpers. After a NoProgressError (or
  // after `mc escape` runs), the cell where the bot stalled gets pushed
  // here so future pathfinds toward the same region can short-circuit
  // instead of repeating the same failed attempt. 90s TTL.
  const RECENT_STUCK_TTL_MS = 90_000;
  const pushStuckCell = (cell, source) => {
    if (!ctx || !cell) return;
    if (!Array.isArray(ctx.runtime.recentStuckCells)) ctx.runtime.recentStuckCells = [];
    const cutoff = Date.now() - RECENT_STUCK_TTL_MS;
    ctx.runtime.recentStuckCells = ctx.runtime.recentStuckCells.filter(e => e.ts > cutoff);
    const cx = Math.floor(Number(cell.x));
    const cy = Math.floor(Number(cell.y));
    const cz = Math.floor(Number(cell.z));
    const existing = ctx.runtime.recentStuckCells.find(e => e.cell.x === cx && e.cell.y === cy && e.cell.z === cz);
    if (existing) {
      existing.ts = Date.now();
      existing.hit_count += 1;
    } else {
      ctx.runtime.recentStuckCells.push({ ts: Date.now(), cell: { x: cx, y: cy, z: cz }, source, hit_count: 1 });
      if (ctx.runtime.recentStuckCells.length > 12) ctx.runtime.recentStuckCells.shift();
    }
  };
  // F74: computeReachability is imported from _nav-helpers.js — same
  // helper is used by mc find / mc find_blocks (task #92) to annotate
  // search results with reachability + approach_cell.

  // Find any recent-stuck cell within `radius` of (tx,ty,tz). Used by
  // the pre-pathfind blackball check. Returns the entry or null.
  const recentStuckNear = (tx, ty, tz, radius = 1) => {
    if (!ctx || !Array.isArray(ctx.runtime.recentStuckCells) || ctx.runtime.recentStuckCells.length === 0) return null;
    const cutoff = Date.now() - RECENT_STUCK_TTL_MS;
    let best = null;
    for (const e of ctx.runtime.recentStuckCells) {
      if (e.ts <= cutoff) continue;
      const dx = e.cell.x - tx;
      const dy = e.cell.y - ty;
      const dz = e.cell.z - tz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= radius && (!best || e.hit_count > best.hit_count)) best = e;
    }
    return best;
  };

  // F50.2: Pre-flight checks before invoking the pathfinder. Catches
  // doomed calls in <5ms (one classify + one closest-standable scan)
  // instead of paying the 5-15s wallclock cap to discover the same
  // thing. Returns null if the call should proceed; otherwise an
  // error response ready to be returned to the caller.
  //
  // Reasons we short-circuit:
  //   1. BOT_TRAPPED — bot has all 4 cardinal dirs blocked at foot or
  //      head level. With parkour disabled (F49) pathfinder cannot
  //      escape; brain must dig/escape first.
  //   2. NAV_TARGET_UNSTANDABLE — no standable cell exists within
  //      `range` of the target (target is in solid rock / floating).
  //      No path possible regardless of where bot is.
  //   3. F57.2 NAV_RECURRING_STUCK — target is within 1 block of a cell
  //      where the bot stalled twice or more in the last 90s. Refuse the
  //      attempt and direct the brain to mc dig or alternative route.
  const preflightNav = (b, x, y, z, range) => {
    // Task #21 — refuse long-distance walks across water when a boat is
    // available. Cheap short-circuit for the most common Steve-walks-into-
    // a-lake failure mode.
    const boatRefusal = refuseWaterRouteWithoutBoat(b, x, y, z);
    if (boatRefusal) return boatRefusal;

    let ss;
    try { ss = standingState(b); } catch { return null; }
    if (ss && ss.classification === 'trapped') {
      const tx = Math.floor(Number(x));
      const ty = Math.floor(Number(y));
      const tz = Math.floor(Number(z));
      return {
        ok: false,
        error: {
          code: 'BOT_TRAPPED',
          message: `Cannot navigate — you are trapped at ${ss.cell.x},${ss.cell.y},${ss.cell.z}. All 4 cardinal dirs blocked at foot or head. Use mc dig <coord> to break out, or mc escape if available.`,
          observed_state: {
            your_standing_state: ss,
            target: { x: tx, y: ty, z: tz },
          },
          retry_safe: false,
        },
      };
    }
    // #99: on_pillar — bot is on a 1×1 column with cliffs in every
    // cardinal direction. mc move's pathfinder has nowhere to go from
    // here. Surface the specific recovery: pillar_down. Refuse early
    // to save pathfinder thrash.
    if (ss && ss.classification === 'on_pillar') {
      const tx = Math.floor(Number(x));
      const ty = Math.floor(Number(y));
      const tz = Math.floor(Number(z));
      return {
        ok: false,
        error: {
          code: 'BOT_ON_PILLAR',
          message: `You're on top of a 1×1 column at ${ss.cell.x},${ss.cell.y},${ss.cell.z} — every cardinal direction is a cliff. Call \`mc pillar_down\` to descend (mines the block underfoot, drops 1, repeats until you reach ground). Then retry the navigation.`,
          observed_state: {
            your_standing_state: ss,
            target: { x: tx, y: ty, z: tz },
          },
          next_action_hint: `mc pillar_down ${Math.max(4, Math.min(16, ss.cell.y - Math.floor(Number(y))))}`,
          retry_safe: false,
        },
      };
    }
    const tx = Math.floor(Number(x));
    const ty = Math.floor(Number(y));
    const tz = Math.floor(Number(z));
    // F57.2 blackball: if the brain is sending the bot back to a place
    // it just stalled in (hit_count >= 2), refuse early.
    const stuck = recentStuckNear(tx, ty, tz, 1);
    if (stuck && stuck.hit_count >= 2) {
      const ageS = Math.round((Date.now() - stuck.ts) / 100) / 10;
      return {
        ok: false,
        error: {
          code: 'NAV_RECURRING_STUCK',
          message: `Refusing to pathfind to ${tx},${ty},${tz} — the bot has stalled near ${stuck.cell.x},${stuck.cell.y},${stuck.cell.z} ${stuck.hit_count}× in the last ${ageS}s. The route is trapping you. Options: (a) mc dig at the blocking cell — run mc inspect to identify it; (b) approach from a different side via mc go_mark; (c) call mc status to clear this flag if you've moved.`,
          observed_state: {
            target: { x: tx, y: ty, z: tz },
            recurring_cell: stuck.cell,
            hit_count: stuck.hit_count,
            source: stuck.source,
            age_s: ageS,
            your_standing_state: ss ? {
              classification: ss.classification,
              blocked_dirs: ss.blocked_dirs,
              open_dirs: ss.open_dirs,
            } : null,
          },
          next_action_hint: `mc inspect ${stuck.cell.x} ${stuck.cell.y} ${stuck.cell.z}`,
          retry_safe: false,
        },
      };
    }
    // F47 (task #66, v57): lenient target adjustment. When the exact
    // target coord is unstandable (e.g. agent passes a water cell or
    // a foliage cell), look for the closest STANDABLE cell within
    // ~4 blocks and transparently retarget there. The agent's natural
    // workflow is "tell the bot to go to roughly (X,Y,Z)" — refusing
    // because the exact cell isn't standable wastes a turn (the v57
    // log showed mc move 363 64 -542 → NAV_TARGET_UNSTANDABLE when the
    // shore was 3 blocks away). When a retarget is applied, success
    // response surfaces it in data.target_adjusted so the agent
    // learns what we did.
    //
    // The caller passes `range` (default 1 for goto, sometimes
    // larger). We widen ONLY when retargeting is the goal: if no
    // standable cell exists at the original (range=1) AND no Y-grace
    // helps, expand to scan=4 before refusing.
    const requestedScan = Math.max(1, Math.min(4, Number.isFinite(range) ? range : 1));
    let best;
    try { best = findClosestStandable(b, tx, ty, tz, requestedScan); } catch { return null; }
    if (!best && requestedScan < 4) {
      // Widen to radius 4 specifically to find a retarget candidate.
      try { best = findClosestStandable(b, tx, ty, tz, 4); } catch { /* ignore */ }
      if (best) {
        // Use the widened cell as a retarget. Stash dist for the
        // success annotation so the agent sees how far we adjusted.
        const dxz = Math.hypot(best.x - tx, best.z - tz);
        return {
          retarget: { x: best.x, y: best.y, z: best.z, from: { x: tx, y: ty, z: tz }, distance: Math.round(dxz * 10) / 10 },
        };
      }
    }
    const scan = requestedScan;
    if (!best) {
      // Y-grace: before refusing, try a same-XZ vertical rescue. If the
      // agent picked the right column but the wrong Y (target inside a
      // hill, or floating in air), redirect to the nearest standable Y
      // at this (x,z). The caller swaps Y and annotates the success
      // response with y_adjusted so the brain learns what we did.
      let vert;
      try { vert = findStandableSameXZ(b, tx, ty, tz, Y_GRACE_MAX_DY); } catch { vert = null; }
      if (vert && vert.dy !== 0) {
        return {
          y_adjusted: {
            from: ty,
            to: vert.y,
            dy: vert.dy,
            reason: vert.target_reason,
            x: tx,
            z: tz,
          },
        };
      }
      // Long-distance nav: when the target chunk is not loaded, blockAt
      // returns null for everything we probed and the standability check
      // is meaningless. Trust the brain; let pathfinder walk toward the
      // target and chunks will stream in as the bot approaches. The
      // pathfinder's own internal validation will catch a truly bad
      // target once the chunks load. See targetChunkLoaded() in _nav-
      // helpers.js for the exact probe.
      if (!targetChunkLoaded(b, tx, ty, tz, Y_GRACE_MAX_DY)) {
        return null;
      }
      return {
        ok: false,
        error: {
          code: 'NAV_TARGET_UNSTANDABLE',
          message: `No standable cell within ${scan} of ${tx},${ty},${tz}, and no standable Y within ±${Y_GRACE_MAX_DY} at the same (x,z). Target area is solid or floating. Pick a different destination, or mc dig to clear blocks first.`,
          observed_state: {
            target: { x: tx, y: ty, z: tz },
            scan_range: scan,
            y_grace_searched: Y_GRACE_MAX_DY,
            your_standing_state: ss ? {
              classification: ss.classification,
              blocked_dirs: ss.blocked_dirs,
              open_dirs: ss.open_dirs,
            } : null,
          },
          retry_safe: false,
        },
      };
    }
    return null;
  };

  // F51.1: Pre-nudge from sticky starting positions. When the bot is in
  // a corner/wedge/edge/three_walled state, pathfinder often hangs or
  // chooses bad routes because the search space is asymmetric. This
  // function attempts a tiny pre-move to an open cardinal neighbor in
  // the rough direction of the target, BEFORE the main pathfind.
  // Silent — caller doesn't annotate. If pre-nudge fails, main pathfind
  // proceeds anyway (worst case we waste 3s + try the original plan).
  const DIR_VEC = {
    N: { dx: 0, dz: -1 },
    E: { dx: 1, dz: 0 },
    S: { dx: 0, dz: 1 },
    W: { dx: -1, dz: 0 },
  };
  const STICKY_CLASSIFICATIONS = new Set(['corner', 'wedge', 'edge', 'three_walled']);
  const pickSteppingStone = (sNow, tx, ty, tz) => {
    if (!sNow || !sNow.open_dirs || !sNow.cell) return null;
    if (sNow.open_dirs.length === 0) return null;
    // Direction from bot toward target on XZ plane (ignore Y — pre-nudge
    // doesn't try to fix elevation issues).
    const cx = sNow.cell.x, cz = sNow.cell.z;
    const dxToT = Math.sign(tx - cx);
    const dzToT = Math.sign(tz - cz);
    const candidates = [];
    for (const dirName of sNow.open_dirs) {
      const v = DIR_VEC[dirName];
      if (!v) continue;
      const dotProd = (v.dx * dxToT) + (v.dz * dzToT);
      candidates.push({
        cell: { x: cx + v.dx, y: sNow.cell.y, z: cz + v.dz },
        score: dotProd,
        dir: dirName,
      });
    }
    candidates.sort((a, c) => c.score - a.score);
    // Only return if best score is non-negative — don't move AWAY from target.
    // For wedge specifically (sNow.cell is already the bot's cell), score=0
    // is still useful: any cardinal step away from the wedge edge helps.
    if (candidates.length === 0) return null;
    if (candidates[0].score < 0 && sNow.classification !== 'wedge') return null;
    return candidates[0];
  };
  const preNudgeIfSticky = async (b, tx, ty, tz) => {
    let sNow;
    try { sNow = standingState(b); } catch { return; }
    if (!sNow || !STICKY_CLASSIFICATIONS.has(sNow.classification)) return;
    const stone = pickSteppingStone(sNow, tx, ty, tz);
    if (!stone) return;
    try {
      const goal = new goals.GoalBlock(stone.cell.x, stone.cell.y, stone.cell.z);
      await raceWithTimeout(b.pathfinder.goto(goal), 3000, 'stepping_stone');
    } catch {
      // Pre-nudge failed (timeout or no path). That's fine — continue
      // with the main pathfind. The brain doesn't see this attempt;
      // worst case we paid 3s and the main pathfind still happens.
      try { b.pathfinder.setGoal(null); } catch {}
    }
  };

  // Pathfinder is read-only (no canDig, no scaffolding). When it can't find
  // a path, it returns "No path to the goal!" — that's the agent's signal
  // that the route is blocked and intentional action is needed (mc through
  // for a door, mc tunnel/dig_area to clear terrain). These helpers shape
  // those failures into a consistent action-contract response.
  const navBlockedError = (b, pos, x, y, z, dist) => {
    // F74: reachability hint on NAV_BLOCKED. When pathfinder gives up
    // (no-path), the brain has no waypoint. BFS over walkable cells
    // surfaces a next-hop that IS routable, or confirms unreachable.
    const reach = computeReachability(b, { x, y, z }, 144);
    const hopNote = reach && !reach.walkable_to_target && reach.next_hop_suggestion
      ? ` Try mc goto_near ${reach.next_hop_suggestion.x} ${reach.next_hop_suggestion.y} ${reach.next_hop_suggestion.z} range=1 to route around the obstacle.`
      : ' Try mc through GX GY GZ for a door/gate, or mc tunnel / mc dig_area to clear terrain explicitly.';
    const obs = enrichWithStand(b, { current: pos, target: { x, y, z }, distance: Number(dist.toFixed(1)) }, x, y, z);
    if (reach) Object.assign(obs, reach);
    return {
      ok: false,
      error: {
        code: 'NAV_BLOCKED',
        message: `Pathfinder gave up at ${pos.x},${pos.y},${pos.z} — ${dist.toFixed(1)} blocks from target ${fmt(x)},${fmt(y)},${fmt(z)}. The path is blocked.${hopNote}`,
        observed_state: obs,
        retry_safe: false,
      },
    };
  };
  const navFailureError = (b, pos, x, y, z, msg) => {
    if (msg === 'timeout') {
      return {
        ok: false,
        error: {
          code: 'NAV_TIMEOUT',
          message: `Walked toward ${fmt(x)},${fmt(y)},${fmt(z)} for 15s, now at ${pos.x},${pos.y},${pos.z}. Use mc bg_goto for long distances or mc through for doors.`,
          observed_state: enrichWithStand(b, { current: pos, target: { x, y, z } }, x, y, z),
          retry_safe: true,
        },
      };
    }
    if (/no path/i.test(msg)) {
      // F74: reachability hint when pathfinder reports no path.
      const reach = computeReachability(b, { x, y, z }, 144);
      const hopNote = reach && !reach.walkable_to_target && reach.next_hop_suggestion
        ? ` Try mc goto_near ${reach.next_hop_suggestion.x} ${reach.next_hop_suggestion.y} ${reach.next_hop_suggestion.z} range=1 to route around the obstacle.`
        : ' Pathfinder is non-destructive — if a door blocks the path use mc through GX GY GZ; if terrain blocks it use mc tunnel or mc dig_area to clear it explicitly.';
      const obs = enrichWithStand(b, { current: pos, target: { x, y, z } }, x, y, z);
      if (reach) Object.assign(obs, reach);
      return {
        ok: false,
        error: {
          code: 'NAV_BLOCKED',
          message: `No path to ${fmt(x)},${fmt(y)},${fmt(z)} from ${pos.x},${pos.y},${pos.z}.${hopNote}`,
          observed_state: obs,
          retry_safe: false,
        },
      };
    }
    return {
      ok: false,
      error: { code: 'NAV_FAILED', message: `Navigation failed: ${msg}`, observed_state: enrichWithStand(b, { current: pos, target: { x, y, z } }, x, y, z), retry_safe: false },
    };
  };

  return {
    async goto({ x, y, z }) {
      const b = ensureBot();
      // task #44 (F7): retry-loop guard. If the same target has failed
      // GOTO_RETRY_LIMIT times in a row, return NAV_RETRY_LOOP with
      // mc advise hint instead of attempting another call that will
      // almost certainly fail the same way. Resets on success or when
      // the agent picks a different target.
      const retryKey = gotoRetryKey('goto', x, y, z);
      const priorRetry = gotoRetryCounts.get(retryKey);
      if (priorRetry && priorRetry.count >= GOTO_RETRY_LIMIT) {
        return {
          ok: false,
          error: {
            code: 'NAV_RETRY_LOOP',
            message: `${priorRetry.count} consecutive mc bg_goto / mc goto calls to (${Math.floor(Number(x))}, ${Math.floor(Number(y))}, ${Math.floor(Number(z))}) have failed (last reason: ${priorRetry.lastReason}). Pick a different target — try an adjacent waypoint, mc advise, or look around with mc scene to reassess. Retrying the same coord will not work.`,
            observed_state: {
              retry_count: priorRetry.count,
              last_reason: priorRetry.lastReason,
              target: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) },
            },
            next_action_hint: 'mc advise --reason="bg_goto stuck retrying"',
            retry_safe: false,
          },
        };
      }
      // F50.2: bot-trapped + target-unstandable pre-flight.
      const pre = preflightNav(b, x, y, z, 1);
      if (pre && (pre.error || pre.ok === false)) {
        recordMoveFailure('goto', x, y, z, posObj(), pre.error?.code || 'preflight');
        return pre;
      }
      // #102 Y-grace: preflight may have rescued a wrong-Y target by
      // snapping (x,z) to the closest standable Y. Swap y and remember
      // the original so the success response can report it.
      let yAdjusted = null;
      if (pre && pre.y_adjusted) {
        yAdjusted = pre.y_adjusted;
        y = pre.y_adjusted.to;
      }
      // F47 (task #66, v57): lenient retarget when the original cell
      // is unstandable but a nearby cell is. Same pattern as y_adjusted.
      let targetAdjusted = null;
      if (pre && pre.retarget) {
        targetAdjusted = pre.retarget;
        x = pre.retarget.x;
        y = pre.retarget.y;
        z = pre.retarget.z;
      }
      // F51.1: silent pre-nudge from sticky start position.
      await preNudgeIfSticky(b, Math.floor(x), Math.floor(y), Math.floor(z));
      // Pre-check: GoalBlock requires the bot to stand AT (x,y,z). If the
      // target tile or the head tile above it is a solid block, GoalBlock
      // is impossible by construction (you can't occupy a solid cell).
      // Common case: agent calls `mc goto 1 65 1` to reach a crafting
      // table at (1,65,1) — pathfinder spends 15s before giving up.
      // Catch it early with an actionable hint pointing at goto_near.
      let tx = Math.floor(x), ty = Math.floor(y), tz = Math.floor(z);
      const blockAtTarget = b.blockAt(new Vec3(tx, ty, tz));
      const blockAtHead = b.blockAt(new Vec3(tx, ty + 1, tz));
      const isSolid = (blk) => blk && blk.name !== 'air' && blk.name !== 'cave_air'
        && blk.name !== 'void_air' && blk.boundingBox === 'block';
      if (isSolid(blockAtTarget) || isSolid(blockAtHead)) {
        // #102 Y-grace: same-XZ vertical rescue before refusing.
        // Common case: agent aims at the top of a hill but their Y is
        // 2 blocks inside it. Snap to nearest standable Y at (tx,tz).
        let vert;
        try { vert = findStandableSameXZ(b, tx, ty, tz, Y_GRACE_MAX_DY); } catch { vert = null; }
        if (vert && vert.dy !== 0) {
          yAdjusted = { from: ty, to: vert.y, dy: vert.dy, reason: vert.target_reason, x: tx, z: tz };
          y = vert.y;
          ty = vert.y;
        } else {
          const blocker = isSolid(blockAtTarget) ? blockAtTarget : blockAtHead;
          const pos = posObj();
          return {
            ok: false,
            error: {
              code: 'NAV_TARGET_OCCUPIED',
              message: `Target ${tx},${ty},${tz} is inside a solid block (${blocker.name}), and no standable Y within ±${Y_GRACE_MAX_DY} at this (x,z). Use \`mc goto_near ${tx} ${ty} ${tz}\` to reach an adjacent walkable tile instead.`,
              observed_state: enrichWithStand(b, { target: { x: tx, y: ty, z: tz }, blocker: blocker.name, current: pos, y_grace_searched: Y_GRACE_MAX_DY }, tx, ty, tz),
              retry_safe: false,
            },
          };
        }
      }
      const goal = new goals.GoalBlock(tx, ty, tz);
      try {
        await pathfindWithProgressWatchdog({
          bot: b,
          pathfinderGoto: () => b.pathfinder.goto(goal),
          onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
          opName: 'goto',
          capMs: ACTION_CAPS_MS.goto,
        });
        const pos = posObj();
        const dist = Math.hypot(pos.x - x, pos.y - y, pos.z - z);
        if (dist > 2) {
          recordMoveFailure('goto', x, y, z, pos, 'pathfinder_gave_up');
          return navBlockedError(b, pos, x, y, z, dist);
        }
        clearMoveFailure();
        clearGotoRetry('goto', x, y, z); // F7: success — reset retry count
        if (targetAdjusted) {
          return {
            result: `Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)} (target adjusted ${targetAdjusted.distance}b from requested ${targetAdjusted.from.x},${targetAdjusted.from.y},${targetAdjusted.from.z} — original was unstandable)`,
            observed_state: { target_adjusted: targetAdjusted },
          };
        }
        if (yAdjusted) {
          return {
            result: `Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)} (y adjusted from ${yAdjusted.from} to ${yAdjusted.to}, Δ=${yAdjusted.dy >= 0 ? '+' : ''}${yAdjusted.dy} — original Y was ${yAdjusted.reason})`,
            observed_state: { y_adjusted: yAdjusted },
          };
        }
        return { result: `Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)}` };
      } catch (e) {
        try { b.pathfinder.setGoal(null); } catch {}
        if (e instanceof NoProgressError) {
          recordMoveFailure('goto', x, y, z, posObj(), 'no_progress');
          pushStuckCell(e.info?.stalled_position, 'no_progress');
          // F74: reachability hint on stall. Widened cap (144) since the
          // brain has no other clue where to route next.
          const reach = computeReachability(b, { x, y, z }, 144);
          const hopNote = reach && !reach.walkable_to_target && reach.next_hop_suggestion
            ? ` Try mc goto_near ${reach.next_hop_suggestion.x} ${reach.next_hop_suggestion.y} ${reach.next_hop_suggestion.z} range=1 to route around the obstacle.`
            : ' Try mc escape, mc dig at the blocker, or pick a different target.';
          const obs = enrichWithStand(b, { target: { x, y, z }, current: posObj(), ...e.info }, x, y, z);
          if (reach) Object.assign(obs, reach);
          return {
            ok: false,
            error: {
              code: 'NAV_NO_PROGRESS',
              message: `Pathfinder stalled — bot stopped moving for ${e.info?.no_progress_for_ms}ms while heading to ${fmt(x)},${fmt(y)},${fmt(z)}. Often means a 1-block lip, a wedged corner, or a sealed route.${hopNote}`,
              observed_state: obs,
              retry_safe: false,
            },
          };
        }
        if (e instanceof OperationTimeoutError) {
          recordMoveFailure('goto', x, y, z, posObj(), 'wallclock_timeout');
          return timeoutError('goto', ACTION_CAPS_MS.goto,
            enrichWithStand(b, { target: { x, y, z }, current: posObj() }, x, y, z),
            `Pathfinder didn't finish in time. If observed_state.closest_standable is set, retry mc goto there instead.`);
        }
        const pos = posObj();
        recordMoveFailure('goto', x, y, z, pos, 'pathfinder_error');
        return navFailureError(b, pos, x, y, z, e?.message || String(e));
      }
    },

    async goto_near({ x, y, z, range = 2, los = undefined }) {
      const b = ensureBot();
      // F50.2: pre-flight checks (bot-trapped, target-unstandable).
      const pre = preflightNav(b, x, y, z, range);
      if (pre && (pre.error || pre.ok === false)) {
        recordMoveFailure('goto_near', x, y, z, posObj(), pre.error?.code || 'preflight');
        return pre;
      }
      // #102 Y-grace
      let yAdjusted = null;
      if (pre && pre.y_adjusted) {
        yAdjusted = pre.y_adjusted;
        y = pre.y_adjusted.to;
      }
      // F51.1: silent pre-nudge from sticky start position.
      await preNudgeIfSticky(b, Math.floor(x), Math.floor(y), Math.floor(z));
      const tx = Math.floor(x), ty = Math.floor(y), tz = Math.floor(z);

      // F71: LOS-aware landing for solid targets. Plain GoalNear can land
      // the bot 'within range' but on the wrong side of a wall — distance
      // 2.0 with a cobble wall in between still counts as success, then
      // the follow-up dig/place/interact trips its LOS guard. When the
      // target cell is a solid block, pick the closest standable cell
      // *within range* that has LOS to at least one face of the target,
      // and pathfind exactly there. Opt out via `los=false` for callers
      // that explicitly want raw "be near this air cell" behavior.
      let goal = new goals.GoalNear(tx, ty, tz, range);
      let losPicked = null;
      if (los !== false && typeof hasLineOfSight === 'function') {
        const targetBlock = b.blockAt(new Vec3(tx, ty, tz));
        const targetIsSolid = !!(targetBlock
          && targetBlock.boundingBox === 'block'
          && targetBlock.name !== 'air'
          && targetBlock.name !== 'cave_air');
        if (targetIsSolid) {
          const cBx = tx + 0.5, cBy = ty + 0.5, cBz = tz + 0.5;
          const faces = [
            { x: cBx, y: cBy, z: cBz - 0.48 },
            { x: cBx, y: cBy, z: cBz + 0.48 },
            { x: cBx - 0.48, y: cBy, z: cBz },
            { x: cBx + 0.48, y: cBy, z: cBz },
            { x: cBx, y: cBy - 0.48, z: cBz },
            { x: cBx, y: cBy + 0.48, z: cBz },
            { x: cBx, y: cBy, z: cBz },
          ];
          const cands = [];
          const R = Math.max(1, Math.floor(range));
          for (let dx = -R; dx <= R; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dz = -R; dz <= R; dz++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d > range) continue;
                const cx = tx + dx, cy = ty + dy, cz = tz + dz;
                if (!isStandableCell(b, cx, cy, cz)) continue;
                // Hypothetical eye position at this candidate cell.
                // Use the same height scaling as eyePosition() (1.377m).
                const candEye = { x: cx + 0.5, y: cy + 1.377, z: cz + 0.5 };
                if (faces.some((p) => hasLineOfSight(candEye, p))) {
                  cands.push({ cx, cy, cz, d });
                }
              }
            }
          }
          if (cands.length > 0) {
            cands.sort((a, c) => a.d - c.d);
            losPicked = cands[0];
            goal = new goals.GoalBlock(losPicked.cx, losPicked.cy, losPicked.cz);
          }
        }
      }
      try {
        await pathfindWithProgressWatchdog({
          bot: b,
          pathfinderGoto: () => b.pathfinder.goto(goal),
          onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
          opName: 'goto_near',
          capMs: ACTION_CAPS_MS.goto_near,
        });
        const pos = posObj();
        const dist = Math.hypot(pos.x - x, pos.y - y, pos.z - z);
        if (dist > range + 1.5) {
          recordMoveFailure('goto_near', x, y, z, pos, 'pathfinder_gave_up');
          return navBlockedError(b, pos, x, y, z, dist);
        }
        clearMoveFailure();
        // F50.5: landing-state check. GoalNear lands the bot at SOME cell
        // within `range` of target, often a fractional position next to a
        // wall (Mason in G21 v2 routinely ended up in wedge/corner). If
        // the landing is suboptimal, scan for a cleaner cell still in
        // range and report it via observed_state.suggested_correction.
        // We don't auto-move — silent corrections would drift the brain's
        // model of position. Brain can mc move <suggested> if it wants.
        let landingInfo;
        try {
          const ss = standingState(b);
          const ugly = ['corner', 'wedge', 'edge', 'three_walled'];
          if (ugly.includes(ss.classification)) {
            // Find candidate cells around target within range
            let suggested = null;
            const candidates = [];
            for (let dx = -range; dx <= range; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -range; dz <= range; dz++) {
                  if (dx === 0 && dy === 0 && dz === 0) continue;
                  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                  if (dist > range) continue;
                  candidates.push({ cx: tx + dx, cy: ty + dy, cz: tz + dz, dist });
                }
              }
            }
            candidates.sort((a, c) => a.dist - c.dist);
            // Score: walk classifier across each candidate; pick first
            // 'open' or 'alley'. Avoid re-classifying via setting bot
            // position — instead infer from neighbor block state.
            const myCellX = ss.cell.x, myCellY = ss.cell.y, myCellZ = ss.cell.z;
            for (const c of candidates) {
              if (c.cx === myCellX && c.cy === myCellY && c.cz === myCellZ) continue;
              if (!isStandableCell(b, c.cx, c.cy, c.cz)) continue;
              // Quick proxy: count blocked dirs at this candidate
              const checks = [
                b.blockAt(new Vec3(c.cx + 1, c.cy, c.cz)),
                b.blockAt(new Vec3(c.cx - 1, c.cy, c.cz)),
                b.blockAt(new Vec3(c.cx, c.cy, c.cz + 1)),
                b.blockAt(new Vec3(c.cx, c.cy, c.cz - 1)),
              ];
              const blocked = checks.filter(blk => blk && blk.boundingBox === 'block').length;
              if (blocked <= 1) {
                suggested = { x: c.cx, y: c.cy, z: c.cz, blocked_neighbors: blocked, distance_from_target: Number(c.dist.toFixed(2)) };
                break;
              }
            }
            landingInfo = {
              landed_in: ss.classification,
              landing_position: ss.position,
              suggested_correction: suggested,
            };
          }
        } catch { /* never let landing inspection break success */ }
        // F73: graph-reachability check. GoalNear succeeds at any cell
        // within `range` euclidean blocks — but pathfinder stops at the
        // first one it finds, which is often on the WRONG side of a
        // wall. Surface walkable_to_target / next_hop_suggestion so the
        // brain can route around the wall instead of looping mc dig.
        // F74: helper is shared with the stall handler below.
        const reachability = computeReachability(b, { x: tx, y: ty, z: tz }, 96);

        const yAdjNote = yAdjusted
          ? ` (y adjusted from ${yAdjusted.from} to ${yAdjusted.to}, Δ=${yAdjusted.dy >= 0 ? '+' : ''}${yAdjusted.dy} — original Y was ${yAdjusted.reason})`
          : '';
        if (landingInfo) {
          const note = landingInfo.suggested_correction
            ? ` (landed in ${landingInfo.landed_in} — observed_state.suggested_correction shows a cleaner cell within range)`
            : ` (landed in ${landingInfo.landed_in} — no cleaner cell within range)`;
          if (losPicked) {
            landingInfo.los_cell_picked = { x: losPicked.cx, y: losPicked.cy, z: losPicked.cz };
          }
          if (reachability) Object.assign(landingInfo, reachability);
          if (yAdjusted) landingInfo.y_adjusted = yAdjusted;
          const reachNote = reachability && !reachability.walkable_to_target && reachability.next_hop_suggestion
            ? ` — can't reach target from here; try mc goto_near ${reachability.next_hop_suggestion.x} ${reachability.next_hop_suggestion.y} ${reachability.next_hop_suggestion.z} range=1`
            : '';
          return {
            result: `Arrived near ${fmt(x)}, ${fmt(y)}, ${fmt(z)}${yAdjNote}${note}${reachNote}`,
            observed_state: landingInfo,
          };
        }
        if (losPicked) {
          const obs = { los_cell_picked: { x: losPicked.cx, y: losPicked.cy, z: losPicked.cz } };
          if (reachability) Object.assign(obs, reachability);
          if (yAdjusted) obs.y_adjusted = yAdjusted;
          const reachNote = reachability && !reachability.walkable_to_target && reachability.next_hop_suggestion
            ? ` — can't reach target from here; try mc goto_near ${reachability.next_hop_suggestion.x} ${reachability.next_hop_suggestion.y} ${reachability.next_hop_suggestion.z} range=1`
            : '';
          return {
            result: `Arrived at LOS cell ${losPicked.cx}, ${losPicked.cy}, ${losPicked.cz} (clear sight to target ${fmt(x)}, ${fmt(y)}, ${fmt(z)})${yAdjNote}${reachNote}`,
            observed_state: obs,
          };
        }
        const reachNote = reachability && !reachability.walkable_to_target && reachability.next_hop_suggestion
          ? ` — can't reach target from here; try mc goto_near ${reachability.next_hop_suggestion.x} ${reachability.next_hop_suggestion.y} ${reachability.next_hop_suggestion.z} range=1`
          : '';
        const obs = reachability ? { ...reachability } : {};
        if (yAdjusted) obs.y_adjusted = yAdjusted;
        return {
          result: `Arrived near ${fmt(x)}, ${fmt(y)}, ${fmt(z)}${yAdjNote}${reachNote}`,
          ...(Object.keys(obs).length ? { observed_state: obs } : {}),
        };
      } catch (e) {
        try { b.pathfinder.setGoal(null); } catch {}
        if (e instanceof NoProgressError) {
          recordMoveFailure('goto_near', x, y, z, posObj(), 'no_progress');
          pushStuckCell(e.info?.stalled_position, 'no_progress');
          // F74: reachability hint on stall. Widened cap (144) since the
          // brain has no other clue where to route next.
          const reach = computeReachability(b, { x, y, z }, 144);
          const hopNote = reach && !reach.walkable_to_target && reach.next_hop_suggestion
            ? ` Try mc goto_near ${reach.next_hop_suggestion.x} ${reach.next_hop_suggestion.y} ${reach.next_hop_suggestion.z} range=1 to route around the obstacle.`
            : ' Try mc escape, mc dig at the blocker, or use mc goto_near with different coords.';
          const obs = enrichWithStand(b, { target: { x, y, z }, range, current: posObj(), ...e.info }, x, y, z);
          if (reach) Object.assign(obs, reach);
          return {
            ok: false,
            error: {
              code: 'NAV_NO_PROGRESS',
              message: `Pathfinder stalled — bot stopped moving for ${e.info?.no_progress_for_ms}ms while heading to ${fmt(x)},${fmt(y)},${fmt(z)} (range ${range}). Likely a 1-block lip, wedge, or sealed route.${hopNote}`,
              observed_state: obs,
              retry_safe: false,
            },
          };
        }
        if (e instanceof OperationTimeoutError) {
          recordMoveFailure('goto_near', x, y, z, posObj(), 'wallclock_timeout');
          return timeoutError('goto_near', ACTION_CAPS_MS.goto_near,
            enrichWithStand(b, { target: { x, y, z }, current: posObj(), range }, x, y, z),
            `Pathfinder didn't finish in time. If observed_state.closest_standable is set, retry mc goto_near with those coords.`);
        }
        const pos = posObj();
        recordMoveFailure('goto_near', x, y, z, pos, 'pathfinder_error');
        return navFailureError(b, pos, x, y, z, e?.message || String(e));
      }
    },

    async follow({ player }) {
      const b = ensureBot();
      const entity = Object.values(b.entities).find(e =>
        e !== b.entity && (
          (e.username || '').toLowerCase() === player.toLowerCase() ||
          (e.name || '').toLowerCase() === player.toLowerCase()
        )
      );
      if (!entity) throw new Error(`Player/entity "${player}" not found nearby.`);
      b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
      return { result: `Following ${player}. Use /action/stop to stop.` };
    },

    async look({ x, y, z }) {
      const b = ensureBot();
      await b.lookAt(new Vec3(x, y, z));
      return { result: `Looking at ${x}, ${y}, ${z}` };
    },

    async stop() {
      const b = ensureBot();
      b.pathfinder.setGoal(null);
      try { b.stopDigging(); } catch {}
      if (b.pvp) try { b.pvp.stop(); } catch {}
      // Signal long-running sync actions (e.g. mc collect) to bail out at
      // their next iteration. They poll ctx.tasks.cancelRequested and
      // reset it on entry, so leaving this true between stop and the next
      // collect is fine — collect will clear it.
      ctx.tasks.cancelRequested = true;
      return { result: 'Stopped all actions.' };
    },

    /**
     * F32 (task #66, v45): `mc jump` — brief jump primitive. Useful for
     * surfacing the head when standing in 1-block water, stepping onto a
     * single-block ledge, or knocking a falling sand block. circuit-v45
     * showed the agent inventing `mc jump` and getting "unknown command"
     * — it's a natural primitive and the agent shouldn't have to chain
     * mc escape just to surface.
     *
     * Holds jump for `hold_ms` (default 400ms — long enough for one
     * jump-arc, short enough that the agent can chain other commands
     * right after). Returns the bot's position before and after so the
     * agent can detect whether the jump achieved anything.
     */
    async jump({ hold_ms } = {}) {
      const b = ensureBot();
      const holdMs = Math.max(100, Math.min(2000, parseInt(String(hold_ms ?? 400), 10) || 400));
      const before = posObj();
      try {
        b.setControlState('jump', true);
        await new Promise((r) => setTimeout(r, holdMs));
      } finally {
        try { b.setControlState('jump', false); } catch {}
      }
      const after = posObj();
      const dy = Math.round((after.y - before.y) * 10) / 10;
      return {
        ok: true,
        command: 'jump',
        data: { before, after, dy },
        result: `Jumped${dy > 0 ? ` (Δy=+${dy})` : dy < 0 ? ` (Δy=${dy}, ended lower — probably fell)` : ' (no vertical change)'}.`,
      };
    },

    /**
     * Smart non-destructive navigation. Like mc goto, but on NAV_BLOCKED
     * automatically detects a door/gate between the bot and the target,
     * opens it via mc through (which closes it behind), and recurses from
     * the new position. Up to max_doors legs (default 5).
     *
     * Args:
     *   x, y, z              — destination
     *   max_doors            — optional, default 5, capped at 10
     *   door: {x,y,z}        — optional explicit override; use this door first
     */
    async move({ x, y, z, max_doors, door }) {
      const b = ensureBot();
      if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
        return { ok: false, error: { code: 'INVALID_COORD', message: 'mc move requires numeric x, y, z', retry_safe: false } };
      }
      // F24 (task #62, v42): retry-loop guard for mc move. Mirrors F7's
      // guard on `goto`. v25-v41 postmortem: when the agent's bg_goto
      // got refused, it fell back to chaining `mc move 348 64 -570,
      // -590, -610, ...` — pathfinding independently each time, walking
      // past the shore into open water. `recordMoveFailure('move',...)`
      // was already incrementing the per-target counter, but the guard
      // only ran on the `goto` entry point. Adding the same check here
      // gives a definitive stop after 4 failed mc move calls to the
      // same coord.
      const moveRetryKey = gotoRetryKey('move', x, y, z);
      const movePriorRetry = gotoRetryCounts.get(moveRetryKey);
      if (movePriorRetry && movePriorRetry.count >= GOTO_RETRY_LIMIT) {
        return {
          ok: false,
          error: {
            code: 'NAV_RETRY_LOOP',
            message: `${movePriorRetry.count} consecutive mc move calls to (${Math.floor(Number(x))}, ${Math.floor(Number(y))}, ${Math.floor(Number(z))}) have failed (last reason: ${movePriorRetry.lastReason}). Pick a different target — try an adjacent waypoint, mc advise, or mc scene to reassess. Retrying the same coord will not work.`,
            observed_state: {
              retry_count: movePriorRetry.count,
              last_reason: movePriorRetry.lastReason,
              target: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) },
            },
            next_action_hint: 'mc advise --reason="mc move stuck retrying"',
            retry_safe: false,
          },
        };
      }
      // F50.2: pre-flight (bot-trapped, target-unstandable). mc move uses
      // pathfinder for each leg, so the same protections apply.
      const pre = preflightNav(b, x, y, z, 1);
      if (pre && (pre.error || pre.ok === false)) {
        recordMoveFailure('move', x, y, z, posObj(), pre.error?.code || 'preflight');
        return pre;
      }
      // #102 Y-grace
      let yAdjusted = null;
      if (pre && pre.y_adjusted) {
        yAdjusted = pre.y_adjusted;
        y = pre.y_adjusted.to;
      }
      // F47 (task #66, v57): lenient retarget. mirrors goto's path —
      // see preflightNav. mc move 363 64 -542 to a water cell with
      // shore 3b away now lands at the shore instead of refusing.
      let targetAdjusted = null;
      if (pre && pre.retarget) {
        targetAdjusted = pre.retarget;
        x = pre.retarget.x;
        y = pre.retarget.y;
        z = pre.retarget.z;
      }
      // F51.1: silent pre-nudge from sticky start position.
      await preNudgeIfSticky(b, Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
      const target = { x: Number(x), y: Number(y), z: Number(z) };
      const maxDoors = Math.min(Math.max(parseInt(String(max_doors ?? 5), 10) || 5, 1), 10);

      // Find passable doors (wooden _door + *_fence_gate; skip iron_door and trapdoors).
      const isPassable = (name) =>
        (/(_door|_fence_gate)$/.test(name)) && !name.startsWith('iron_') && !name.endsWith('_trapdoor');

      // #91: door scan defaults to 32m. When that finds nothing AND the
      // pathfinder thinks the target is unreachable, the caller retries
      // with maxDistance=64 (see line ~810). This rescues the "approaching
      // base from far away" case where Steve pathfinds to within ~35m of
      // the house but the door scan can't see the door 3m past its radius.
      const findBestDoor = (maxDistance = 32) => {
        const me = b.entity.position;
        const targetVec = new Vec3(target.x, target.y, target.z);
        const myDist = me.distanceTo(targetVec);
        const positions = b.findBlocks({
          matching: (block) => isPassable(block.name),
          maxDistance,
          count: 30,
        });
        let best = null;
        let bestScore = Infinity;
        for (const dPos of positions) {
          const dBlock = b.blockAt(dPos);
          if (!dBlock) continue;
          // Skip upper halves of doors so we don't pick the same door twice.
          const props = (typeof dBlock.getProperties === 'function') ? dBlock.getProperties() : {};
          if (props.half === 'upper') continue;
          // Compute far_side (toward target) and near_side (away from target)
          // along the dominant axis between door and target.
          const ddx = target.x - dPos.x;
          const ddz = target.z - dPos.z;
          let farSide, nearSide;
          if (Math.abs(ddx) >= Math.abs(ddz)) {
            const dir = Math.sign(ddx || 1);
            farSide = new Vec3(dPos.x + dir * 2, target.y, dPos.z);
            nearSide = new Vec3(dPos.x - dir * 2, target.y, dPos.z);
          } else {
            const dir = Math.sign(ddz || 1);
            farSide = new Vec3(dPos.x, target.y, dPos.z + dir * 2);
            nearSide = new Vec3(dPos.x, target.y, dPos.z - dir * 2);
          }
          // Far side must be strictly closer to target than the bot currently is.
          const farDist = farSide.distanceTo(targetVec);
          if (farDist >= myDist - 0.5) continue;
          // Score by dist(bot, near_side) — closest reachable door wins.
          // In multi-door buildings this picks the door in the bot's current
          // room first; later legs pick deeper doors as bot advances.
          const nearDist = me.distanceTo(nearSide);
          if (nearDist < bestScore) {
            bestScore = nearDist;
            best = { pos: dPos, block: dBlock.name, near_side: nearSide, far_side: farSide, near_dist: nearDist, far_dist: farDist };
          }
        }
        return best;
      };

      const nearbyDoorList = (maxDistance = 32) =>
        b.findBlocks({
          matching: (block) => isPassable(block.name),
          maxDistance,
          count: 8,
        }).map((p) => {
          const blk = b.blockAt(p);
          const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
          return { x: p.x, y: p.y, z: p.z, block: blk?.name || 'unknown', open: props.open === 'true' || props.open === true };
        }).filter((d) => {
          const blk = b.blockAt(new Vec3(d.x, d.y, d.z));
          const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
          return props.half !== 'upper';
        });

      const doors_used = [];
      let lastPathfinderError = null;

      for (let leg = 1; leg <= maxDoors + 1; leg++) {
        // Try direct pathfinder.goto.
        const goal = new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
        try {
          await pathfindWithProgressWatchdog({
            bot: b,
            pathfinderGoto: () => b.pathfinder.goto(goal),
            onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
            opName: 'move',
            capMs: ACTION_CAPS_MS.move,
          });
        } catch (e) {
          if (e instanceof NoProgressError) {
            lastPathfinderError = `no_progress:${e.info?.no_progress_for_ms || '?'}ms`;
            pushStuckCell(e.info?.stalled_position, 'no_progress');
          } else if (e instanceof OperationTimeoutError) lastPathfinderError = 'timeout';
          else lastPathfinderError = e?.message || String(e);
          try { b.pathfinder.setGoal(null); } catch {}
        }

        const pos = posObj();
        const dist = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);
        if (dist <= 2) {
          clearMoveFailure();
          clearGotoRetry('move', target.x, target.y, target.z); // F24: success — reset retry count
          // High-level contract (task #19): if the bot completed the move but
          // is standing in water, auto-escape before returning so the agent
          // doesn't have to chain `mc escape` after every water-adjacent
          // bg_goto. Report the actual end position via adjusted_target.
          let autoEscape = null;
          if (b.entity?.isInWater) {
            try {
              const esc = await ACTIONS.escape({});
              const endPos = posObj();
              autoEscape = {
                ok: !!esc?.ok,
                from: pos,
                to: endPos,
                ...(esc?.data ? { details: esc.data } : {}),
              };
            } catch (e) {
              autoEscape = { ok: false, from: pos, to: posObj(), error: e?.message || String(e) };
            }
          }
          const finalPos = autoEscape ? autoEscape.to : pos;
          const yAdjNote = yAdjusted
            ? ` (y adjusted from ${yAdjusted.from} to ${yAdjusted.to}, Δ=${yAdjusted.dy >= 0 ? '+' : ''}${yAdjusted.dy} — original Y was ${yAdjusted.reason})`
            : '';
          const escapeNote = autoEscape
            ? ` (auto-escaped from water to ${finalPos.x.toFixed(1)},${finalPos.y.toFixed(1)},${finalPos.z.toFixed(1)})`
            : '';
          return {
            ok: true,
            data: {
              doors_used,
              legs: leg,
              end_position: finalPos,
              ...(yAdjusted ? { y_adjusted: yAdjusted } : {}),
              ...(targetAdjusted ? { target_adjusted: targetAdjusted } : {}),
              ...(autoEscape ? { auto_escape: autoEscape, adjusted_target: { x: Math.floor(finalPos.x), y: Math.floor(finalPos.y), z: Math.floor(finalPos.z), original: { x: target.x, y: target.y, z: target.z } } } : {}),
            },
            result: `Arrived at ${fmt(target.x)}, ${fmt(target.y)}, ${fmt(target.z)}${doors_used.length ? ` via ${doors_used.length} door${doors_used.length > 1 ? 's' : ''}` : ''}${yAdjNote}${escapeNote}`,
          };
        }

        // Pick a door to traverse.
        let chosen;
        if (leg === 1 && door && Number.isFinite(Number(door.x)) && Number.isFinite(Number(door.y)) && Number.isFinite(Number(door.z))) {
          const dPos = new Vec3(Number(door.x), Number(door.y), Number(door.z));
          const dBlock = b.blockAt(dPos);
          if (!dBlock || !isPassable(dBlock.name)) {
            return {
              ok: false,
              error: {
                code: 'NAV_BLOCKED',
                message: `--door at ${door.x},${door.y},${door.z} is not a passable door/gate (block: ${dBlock?.name || 'unknown'})`,
                observed_state: { current: pos, target, doors_used, requested_door: door },
                retry_safe: false,
              },
            };
          }
          const ddx = target.x - dPos.x;
          const ddz = target.z - dPos.z;
          const farSide = (Math.abs(ddx) >= Math.abs(ddz))
            ? new Vec3(dPos.x + Math.sign(ddx || 1) * 2, target.y, dPos.z)
            : new Vec3(dPos.x, target.y, dPos.z + Math.sign(ddz || 1) * 2);
          chosen = { pos: dPos, block: dBlock.name, far_side: farSide };
        } else {
          // #91: try 32m first (fast path). If no candidate found and
          // the target is genuinely further out, expand to 64m before
          // giving up. The expanded search costs ~8× more blocks but
          // only fires on actual misses, so the steady-state cost is
          // the same as before.
          chosen = findBestDoor(32);
          if (!chosen) chosen = findBestDoor(64);
        }

        if (!chosen) {
          recordMoveFailure('move', target.x, target.y, target.z, pos, lastPathfinderError || 'no_door');
          // For the error report, prefer the broader 64m list — if we
          // couldn't pick a door at 32 but found one at 64, the agent
          // still wants to see the wider context.
          const doorList = (() => {
            const near = nearbyDoorList(32);
            return near.length > 0 ? near : nearbyDoorList(64);
          })();
          // #85: when nav fails AND the bot is currently in water,
          // suggest `mc escape` — it has a dedicated water-escape strategy
          // that knows how to swim to shore. Otherwise the agent loops
          // mc move targeting the same un-reachable shoreline coord.
          const botInWater = !!b.entity.isInWater;
          let extraHint = ' Use mc tunnel or mc dig_area to clear terrain explicitly.';
          if (botInWater) {
            extraHint = ' You are in water — call `mc escape` to swim to the nearest shore before retrying navigation.';
          }
          return {
            ok: false,
            error: {
              code: 'NAV_BLOCKED',
              message: `No path to ${fmt(target.x)},${fmt(target.y)},${fmt(target.z)} from ${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} and no door/gate between to use.${extraHint}`,
              observed_state: enrichWithStand(b, { current: pos, target, doors_used, nearby_doors: doorList, pathfinder_error: lastPathfinderError, in_water: botInWater }, target.x, target.y, target.z),
              retry_safe: false,
            },
          };
        }

        // Traverse via mc through (opens + walks + closes).
        const through = await ACTIONS.through({
          gx: chosen.pos.x, gy: chosen.pos.y, gz: chosen.pos.z,
          dx: chosen.far_side.x, dy: chosen.far_side.y, dz: chosen.far_side.z,
        });

        if (!through.ok) {
          return {
            ok: false,
            error: {
              code: 'NAV_BLOCKED',
              message: `Could not traverse ${chosen.block} at ${chosen.pos.x},${chosen.pos.y},${chosen.pos.z}: ${through.error?.message || 'through failed'}`,
              observed_state: enrichWithStand(b, { current: posObj(), target, doors_used, failed_door: { x: chosen.pos.x, y: chosen.pos.y, z: chosen.pos.z, block: chosen.block }, through_error: through.error }, target.x, target.y, target.z),
              retry_safe: through.error?.retry_safe ?? false,
            },
          };
        }

        doors_used.push({
          x: chosen.pos.x, y: chosen.pos.y, z: chosen.pos.z,
          block: chosen.block,
          closed: through.data?.closed ?? false,
        });
      }

      return {
        ok: false,
        error: {
          code: 'TOO_MANY_DOORS',
          message: `Used max ${maxDoors} doors without reaching ${fmt(target.x)},${fmt(target.y)},${fmt(target.z)}. Building may have a routing loop or be too complex; try mc move --door X Y Z to pick a specific door.`,
          observed_state: enrichWithStand(b, { doors_used, target, current: posObj() }, target.x, target.y, target.z),
          retry_safe: false,
        },
      };
    },
  };
}
