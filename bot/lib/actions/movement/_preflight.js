/** @size-exempt: preflightNav + enrichment + nav error shaping */
/**
 * Preflight navigation checks, sticky pre-nudge, and shared NAV_* error payloads.
 */

import {
  findClosestStandable,
  findStandableSameXZ,
  standabilityReason,
  standingState,
  isStandableCell,
  computeReachability,
  targetChunkLoaded,
} from '../_nav-helpers.js';
import { DIR_VEC_4 as DIR_VEC } from '../_directions.js';
import { navBlockedNextActionHint, botTrappedNextActionHint } from './nav-hints.js';

// Y-grace: when an agent calls mc move / goto / goto_near with the right
// XZ but a wrong Y (target inside a hill, floating in air), we rescue by
// snapping to the closest standable Y at the same (x,z). ±5 covers the
// common "aimed at a treetop instead of the ground" / "aimed at the
// ground instead of a 3-block ledge" case without silently teleporting
// the agent across major elevation changes.
export const Y_GRACE_MAX_DY = 5;

/**
 * Enrich observed_state with standability diagnostics.
 * Exported for tests that monkey-patch internal flows.
 */
export function enrichWithStand(b, observedState, x, y, z) {
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
}

/**
 * Stuck-cell registry (F57.2). Depends on runtime ctx from createMovementActions.
 */
export function createStuckRegistry(ctx) {
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

  /** Find any recent-stuck cell within `radius` of (tx,ty,tz). */
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

  return { pushStuckCell, recentStuckNear };
}

export function createNavErrors(fmt, enrich) {
  const navBlockedError = (b, pos, x, y, z, dist) => {
    const reach = computeReachability(b, { x, y, z }, 144);
    const hopNote = reach && !reach.walkable_to_target && reach.next_hop_suggestion
      ? ` Try mc goto_near ${reach.next_hop_suggestion.x} ${reach.next_hop_suggestion.y} ${reach.next_hop_suggestion.z} range=1 to route around the obstacle.`
      : ' Try mc through GX GY GZ for a door/gate, or mc tunnel / mc dig_area to clear terrain explicitly.';
    const obs = enrich(b, { current: pos, target: { x, y, z }, distance: Number(dist.toFixed(1)), pathfinder_error: 'gave_up_short_of_target' }, x, y, z);
    if (reach) Object.assign(obs, reach);
    const hint = navBlockedNextActionHint(b, { x, y, z }, pos, {
      inWater: !!b.entity?.isInWater,
      observedState: obs,
    });
    return {
      ok: false,
      error: {
        code: 'NAV_BLOCKED',
        message: `Pathfinder gave up at ${pos.x},${pos.y},${pos.z} — ${dist.toFixed(1)} blocks from target ${fmt(x)},${fmt(y)},${fmt(z)}. The path is blocked.${hopNote}`,
        observed_state: obs,
        next_action_hint: hint,
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
          observed_state: enrich(b, { current: pos, target: { x, y, z }, pathfinder_error: 'timeout' }, x, y, z),
          retry_safe: true,
        },
      };
    }
    if (/no path/i.test(msg)) {
      const reach = computeReachability(b, { x, y, z }, 144);
      const hopNote = reach && !reach.walkable_to_target && reach.next_hop_suggestion
        ? ` Try mc goto_near ${reach.next_hop_suggestion.x} ${reach.next_hop_suggestion.y} ${reach.next_hop_suggestion.z} range=1 to route around the obstacle.`
        : ' Pathfinder is non-destructive — if a door blocks the path use mc through GX GY GZ; if terrain blocks it use mc tunnel or mc dig_area to clear it explicitly.';
      const obs = enrich(b, { current: pos, target: { x, y, z }, pathfinder_error: msg }, x, y, z);
      if (reach) Object.assign(obs, reach);
      const hint = navBlockedNextActionHint(b, { x, y, z }, pos, {
        inWater: !!b.entity?.isInWater,
        observedState: obs,
      });
      return {
        ok: false,
        error: {
          code: 'NAV_BLOCKED',
          message: `No path to ${fmt(x)},${fmt(y)},${fmt(z)} from ${pos.x},${pos.y},${pos.z} — pathfinder searched and found no route.${hopNote}`,
          observed_state: obs,
          next_action_hint: hint,
          retry_safe: false,
        },
      };
    }
    return {
      ok: false,
      error: { code: 'NAV_FAILED', message: `Navigation failed: ${msg}`, observed_state: enrich(b, { current: pos, target: { x, y, z }, pathfinder_error: msg }, x, y, z), retry_safe: false },
    };
  };

  return { navBlockedError, navFailureError };
}

/**
 * F50.2: Pre-flight checks before invoking the pathfinder.
 */
export function createPreflightNav(refuseWaterRouteWithoutBoat, recentStuckNear) {
  return function preflightNav(b, x, y, z, range) {
    const boatRefusal = refuseWaterRouteWithoutBoat(b, x, y, z);
    if (boatRefusal) return boatRefusal;

    let ss;
    try { ss = standingState(b); } catch { return null; }
    if (ss && ss.classification === 'trapped') {
      const tx = Math.floor(Number(x));
      const ty = Math.floor(Number(y));
      const tz = Math.floor(Number(z));
      const observed_state = enrichWithStand(b, {
        your_standing_state: ss,
        target: { x: tx, y: ty, z: tz },
      }, tx, ty, tz);
      return {
        ok: false,
        error: {
          code: 'BOT_TRAPPED',
          message: `Cannot navigate — you are trapped at ${ss.cell.x},${ss.cell.y},${ss.cell.z}. All 4 cardinal dirs blocked at foot or head. Use mc dig <coord> to break out, or mc escape if available.`,
          observed_state,
          next_action_hint: botTrappedNextActionHint(b, { x: tx, y: ty, z: tz }, ss, observed_state),
          retry_safe: false,
        },
      };
    }
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

    const requestedScan = Math.max(1, Math.min(4, Number.isFinite(range) ? range : 1));
    let best;
    try { best = findClosestStandable(b, tx, ty, tz, requestedScan); } catch { return null; }
    if (!best && requestedScan < 4) {
      try { best = findClosestStandable(b, tx, ty, tz, 4); } catch { /* ignore */ }
      if (best) {
        const dxz = Math.hypot(best.x - tx, best.z - tz);
        return {
          retarget: { x: best.x, y: best.y, z: best.z, from: { x: tx, y: ty, z: tz }, distance: Math.round(dxz * 10) / 10 },
        };
      }
    }
    const scan = requestedScan;
    if (!best) {
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
}

const STICKY_CLASSIFICATIONS = new Set(['corner', 'wedge', 'edge', 'three_walled']);

function pickSteppingStone(sNow, tx, ty, tz) {
  if (!sNow || !sNow.open_dirs || !sNow.cell) return null;
  if (sNow.open_dirs.length === 0) return null;
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
  if (candidates.length === 0) return null;
  if (candidates[0].score < 0 && sNow.classification !== 'wedge') return null;
  return candidates[0];
}

/**
 * F51.1: Pre-nudge from sticky starting positions.
 */
export function createPreNudge(goals, raceWithTimeout) {
  return async function preNudgeIfSticky(b, tx, ty, tz) {
    let sNow;
    try { sNow = standingState(b); } catch { return; }
    if (!sNow || !STICKY_CLASSIFICATIONS.has(sNow.classification)) return;
    const stone = pickSteppingStone(sNow, tx, ty, tz);
    if (!stone) return;
    try {
      const goal = new goals.GoalBlock(stone.cell.x, stone.cell.y, stone.cell.z);
      await raceWithTimeout(b.pathfinder.goto(goal), 3000, 'stepping_stone');
    } catch {
      try { b.pathfinder.setGoal(null); } catch {}
    }
  };
}

/** Re-export for goto_near candidate filtering */
export { isStandableCell, standingState, computeReachability };
