/**
 * Structured next_action_hint strings for NAV_* envelopes (Phase 7.2).
 */
import { computeReachability, targetChunkLoaded } from '../_nav-helpers.js';
import { escalationHint } from '../../shared/escalation-hint.js';
import { detourHintForDy } from './detour-check.js';
import { resolveRouteSculptHint, standabilityActionHint } from './route-sculpt-hint.js';

const EXIT_SITE_NAMES = new Set(['gate', 'entrance', 'exit']);

/** @param {string} hint */
export function isDestructiveNavHint(hint) {
  if (!hint || typeof hint !== 'string') return false;
  const s = hint.trim();
  if (/^\s*mc\s+(dig_area|tunnel|dig\b|build_stairs)/i.test(s)) return true;
  if (/dig_area|mc tunnel/i.test(s)) return true;
  return false;
}

/**
 * Non-destructive recovery when nav fails inside a protect-intent region.
 * @param {Record<string, unknown> | undefined} obs
 * @param {{ x: number, y: number, z: number }} target
 * @param {number} tx
 * @param {number} ty
 * @param {number} tz
 * @param {number} dy
 */
export function protectRegionNavHint(obs, target, tx, ty, tz, dy) {
  if (obs?.target_standable === true && Math.abs(dy) <= 2) {
    return `mc move ${tx} ${ty} ${tz}  # standable target — exit protect pad on foot before terrain sculpt`;
  }
  const cs = obs?.closest_standable;
  if (cs && Number.isFinite(cs.x) && Number.isFinite(cs.y) && Number.isFinite(cs.z)) {
    return `mc goto_near ${Math.floor(cs.x)} ${Math.floor(cs.y)} ${Math.floor(cs.z)} range=1  # protect region — step to standable cell`;
  }
  if (typeof obs?.region_nav_exit_hint === 'string' && obs.region_nav_exit_hint.length) {
    return obs.region_nav_exit_hint;
  }
  return `mc check dig ${tx} ${ty} ${tz}   # protect region — verify policy, then mc move outside before clearing`;
}

/**
 * @param {import('mineflayer').Bot} b
 * @param {number} tx
 * @param {number} ty
 * @param {number} tz
 * @param {Record<string, unknown>} [observedState]
 */
export function navTargetUnstandableNextActionHint(b, tx, ty, tz, observedState) {
  if (!targetChunkLoaded(b, tx, ty, tz, 5)) {
    return `mc bg_goto ${tx} ${ty} ${tz}  # distant target — chunk may expose standable surface when loaded`;
  }
  const cs = observedState?.closest_standable;
  if (cs && Number.isFinite(cs.x) && Number.isFinite(cs.y) && Number.isFinite(cs.z)) {
    return `mc goto_near ${Math.floor(cs.x)} ${Math.floor(cs.y)} ${Math.floor(cs.z)} range=1`;
  }
  // Inside a protect region the target is protected — never suggest `mc dig` there.
  // Prefer the region exit hint (leave first) or a policy `check` over clearing.
  if (observedState?.nav_in_protect_region === true) {
    return observedState.region_nav_exit_hint
      || `mc check dig ${tx} ${ty} ${tz}   # protect region — verify policy, pick a standable cell or leave before clearing`;
  }
  return `mc reachable ${tx} ${ty} ${tz}; pick a standable destination or mc dig to clear solid blocks at target`;
}

/** @param {{ get?: (id: string) => { id: string, sites?: Record<string, unknown> | unknown[] } | null }} store */
export function regionNavExitHintFromStore(store, regionId) {
  if (!store || !regionId) return null;
  const r = store.get(regionId);
  if (!r) return `mc go_site :${regionId}:`;
  const sites = r.sites || {};
  const names = Array.isArray(sites) ? sites : Object.keys(sites);
  const preferred = names.find((n) => EXIT_SITE_NAMES.has(String(n).toLowerCase()));
  if (preferred) {
    return `mc go_site :${r.id}:/${preferred}   # leave protect region first`;
  }
  return `mc go_site :${r.id}:   # region anchor`;
}

function applyProtectFilter(obs, target, tx, ty, tz, dy, hint) {
  if (!hint) return null;
  if (obs?.nav_in_protect_region === true && isDestructiveNavHint(hint)) {
    return protectRegionNavHint(obs, target, tx, ty, tz, dy);
  }
  return hint;
}

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

  if (obs?.target_standable === true && Math.abs(dy) <= 2) {
    return `mc move ${tx} ${ty} ${tz}  # standable target — try walk/step before dig_area/tunnel clearance`;
  }

  try {
    const reach = computeReachability(b, { x: tx, y: ty, z: tz }, 144);
    if (reach?.next_hop_suggestion) {
      const h = reach.next_hop_suggestion;
      const hop = applyProtectFilter(
        obs,
        target,
        tx,
        ty,
        tz,
        dy,
        `mc goto_near ${h.x} ${h.y} ${h.z} range=1`,
      );
      if (hop) return hop;
    }
    const sculpted = resolveRouteSculptHint({
      bot: b,
      target,
      pos,
      observedState: obs,
      reach,
    });
    const sh = applyProtectFilter(obs, target, tx, ty, tz, dy, sculpted.hint);
    if (sh) return sh;
  } catch { /* reachability / sculpt hints are best-effort */ }

  try {
    const sculpted = resolveRouteSculptHint({ bot: b, target, pos, observedState: obs });
    const sh = applyProtectFilter(obs, target, tx, ty, tz, dy, sculpted.hint);
    if (sh) return sh;
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

  const fallback = `mc dig_area to clear terrain blocking ${tx} ${ty} ${tz}, or mc tunnel — pathfinder will not break blocks`;
  return applyProtectFilter(obs, target, tx, ty, tz, dy, fallback) || fallback;
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
