/** @size-exempt: goto / goto_near / move share pathfinder + stall recovery */
/**
 * Movement action handlers: goto, goto_near, follow, look, stop, move.
 */
import { raceWithTimeout } from '../_helpers.js';

import { refuseWaterRouteWithoutBoat } from './water-refusal.js';
import {
  enrichWithStand,
  createStuckRegistry,
  createPreflightNav,
  createPreNudge,
  createNavErrors,
} from './_preflight.js';
import { createGoto } from './goto.js';
import { createGotoNear } from './goto-near.js';
import { createMove } from './move.js';
import { createFollow } from './follow.js';
import { createLook } from './look.js';
import { createJump } from './jump.js';
import { createStop } from './stop.js';
import { createGoSite } from './go_site.js';

export { refuseWaterRouteWithoutBoat };

export function createMovementActions({
  ctx,
  ensureBot,
  goals,
  fmt,
  posObj,
  ACTIONS,
  hasLineOfSight,
  eyePosition,
  loadLocations,
}) {

  /** @type {Map<string, { count: number, lastReason: string|null }>} */
  const gotoRetryCounts = new Map();
  const GOTO_RETRY_LIMIT = 4;
  const gotoRetryKey = (verb, x, y, z) =>
    `${verb}@${Math.floor(Number(x))},${Math.floor(Number(y))},${Math.floor(Number(z))}`;

  const recordMoveFailure = (verb, x, y, z, actualPos, reason) => {
    if (!ctx) return;
    ctx.runtime.lastMoveFailed = {
      ts: Date.now(),
      intended_target: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) },
      actual_pos: actualPos ? { x: Math.round(actualPos.x * 10) / 10, y: Math.round(actualPos.y * 10) / 10, z: Math.round(actualPos.z * 10) / 10 } : null,
      reason,
      verb,
    };
    if (reason && reason !== 'NAV_RETRY_LOOP') {
      const k = gotoRetryKey(verb, x, y, z);
      const prior = gotoRetryCounts.get(k) || { count: 0, lastReason: null };
      gotoRetryCounts.set(k, { count: prior.count + 1, lastReason: reason });
    }
  };

  const clearGotoRetry = (verb, x, y, z) => {
    gotoRetryCounts.delete(gotoRetryKey(verb, x, y, z));
  };

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

  const { pushStuckCell, recentStuckNear } = createStuckRegistry(ctx);
  const preflightNav = createPreflightNav(refuseWaterRouteWithoutBoat, recentStuckNear);
  const preNudgeIfSticky = createPreNudge(goals, raceWithTimeout);
  const { navBlockedError, navFailureError } = createNavErrors(fmt, enrichWithStand);

  const deps = {
    ctx,
    ensureBot,
    goals,
    fmt,
    posObj,
    ACTIONS,
    hasLineOfSight,
    loadLocations,
    gotoRetryCounts,
    GOTO_RETRY_LIMIT,
    gotoRetryKey,
    recordMoveFailure,
    clearGotoRetry,
    clearMoveFailure,
    enrichWithStand,
    pushStuckCell,
    preflightNav,
    preNudgeIfSticky,
    navBlockedError,
    navFailureError,
  };

  const gotoFn = createGoto(deps);

  return {
    goto: gotoFn,
    goto_near: createGotoNear(deps),
    go_site: createGoSite({ ...deps, goto: gotoFn }),
    follow: createFollow(deps),
    look: createLook(deps),
    stop: createStop(deps),
    jump: createJump(deps),
    move: createMove(deps),
  };
}
