/**
 * Structured next_action_hint strings for NAV_* envelopes (Phase 7.2).
 */
import { computeReachability } from '../_nav-helpers.js';
import { escalationHint } from '../../shared/escalation-hint.js';
import { detourHintForDy } from './detour-check.js';
import { resolveRouteSculptHint, standabilityActionHint } from './route-sculpt-hint.js';

/**
 * @param {import('mineflayer').Bot} b
 * @param {{ x: number, y: number, z: number }} target
 * @param {{ x: number, y: number, z: number }} pos
 * @param {{ inWater?: boolean, nearbyDoors?: Array<{ x: number, y: number, z: number }>, observedState?: Record<string, unknown> }} [opts]
 */
export function navBlockedNextActionHint(b, target, pos, opts = {}) {
  const tx = Math.floor(Number(target.x));
  const ty = Math.floor(Number(target.y));
  const tz = Math.floor(Number(target.z));
  const py = Number(pos?.y ?? b?.entity?.position?.y ?? ty);
  const dy = ty - py;
  const obs = opts.observedState;

  if (opts.inWater) return 'mc escape';

  const standHint = standabilityActionHint(obs, target);
  if (standHint) return standHint;

  try {
    const reach = computeReachability(b, { x: tx, y: ty, z: tz }, 144);
    if (reach?.next_hop_suggestion) {
      const h = reach.next_hop_suggestion;
      return `mc goto_near ${h.x} ${h.y} ${h.z} range=1`;
    }
    const sculpted = resolveRouteSculptHint({
      bot: b,
      target,
      pos,
      observedState: obs,
      reach,
    });
    if (sculpted.hint) return sculpted.hint;
  } catch { /* reachability / sculpt hints are best-effort */ }

  try {
    const sculpted = resolveRouteSculptHint({ bot: b, target, pos, observedState: obs });
    if (sculpted.hint) return sculpted.hint;
  } catch { /* ignore */ }

  if (dy < -3) {
    return `mc tunnel ${tx} ${ty} ${tz} down (or mc stair_down) — target is ${Math.abs(Math.round(dy))} blocks below`;
  }
  if (dy > 3) {
    const msg = detourHintForDy(dy);
    if (/stair_up|retrace|waypoint/i.test(msg)) return 'mc stair_up or mc goto with an intermediate waypoint at your current elevation';
    return msg;
  }

  const doors = opts.nearbyDoors;
  if (doors?.length) {
    const d = doors[0];
    return `mc through ${d.x} ${d.y} ${d.z} <far_x> <far_y> <far_z> (door/gate on route)`;
  }

  return `mc dig_area to clear terrain blocking ${tx} ${ty} ${tz}, or mc tunnel — pathfinder will not break blocks`;
}

/**
 * Hint for BOT_TRAPPED preflight (standing state known).
 * @param {import('mineflayer').Bot} b
 * @param {{ x: number, y: number, z: number }} target
 * @param {ReturnType<import('../_nav-helpers.js').standingState>} ss
 * @param {Record<string, unknown>} [observedState]
 */
export function botTrappedNextActionHint(b, target, ss, observedState) {
  const standHint = standabilityActionHint(observedState, target);
  if (standHint) return standHint;
  const sculpted = resolveRouteSculptHint({
    bot: b,
    target,
    pos: b?.entity?.position || { x: 0, y: 0, z: 0 },
    observedState,
    standing: ss,
  });
  if (sculpted.hint) return sculpted.hint;
  const cell = ss?.cell;
  if (cell) {
    return `mc dig <coord> to break out at ${cell.x},${cell.y},${cell.z}, or mc escape`;
  }
  return 'mc escape';
}

/**
 * After the 3rd consecutive failure to the same target, surface a warning before the hard stop at 4.
 *
 * @param {import('../shared/action-contract.js').ActionFail} result
 * @param {string} retryKey
 * @param {Map<string, { count: number, lastReason: string|null }>} counts
 * @param {number} [limit]
 */
/**
 * Map a raw pathfinder failure token to a human-readable reason. Movement
 * verbs record reasons like 'no_progress:4200ms' / 'timeout' / mineflayer's
 * own message strings; agents only ever saw "No path" with no why
 * (proc-nav-1781014144 — opaque failures drove blind identical retries).
 */
export function describePathfinderError(reason) {
  if (!reason) return null;
  const r = String(reason);
  const np = r.match(/^no_progress:(\d+|\?)ms$/);
  if (np) return `pathfinder stalled — the bot moved but stopped making progress after ${np[1]}ms`;
  if (r === 'timeout') return 'pathfinder hit its time cap — there may be no route at all';
  if (/no path/i.test(r)) return 'pathfinder searched and found no route';
  return r;
}

export function withNavRetryWarning(result, retryKey, counts, limit = 4) {
  if (!result || result.ok !== false || !result.error) return result;
  const entry = counts?.get(retryKey);
  if (!entry || entry.count !== 3) return result;
  const error = {
    ...result.error,
    observed_state: {
      ...(result.error.observed_state || {}),
      consecutive_failures: 3,
      retry_limit: limit,
      retry_warning:
        `Same target failed 3 times in a row (hard stop at ${limit}). Change waypoint or use mc advise before retrying this coord.`,
    },
  };
  const suffix = ' (3rd consecutive failure to this target.)';
  if (typeof error.next_action_hint === 'string' && error.next_action_hint.length) {
    error.next_action_hint += suffix;
  } else {
    error.next_action_hint = escalationHint({ reason: 'stuck: 3 failures to same move/goto target' });
  }
  return { ok: false, error };
}
