/** @size-exempt: fishing + boats + buckets (Phase 4 absorbed bucket_*) */
/**
 * Water-related verbs (Sprint 10): mc fish / place_boat / board / disembark.
 */

import { Vec3 } from 'vec3';
import { executeServerCommand, paperMcpConfig } from '../../runtime/paper-mcp.js';
import { findAdjustedTarget } from '../_nav-helpers.js';
import { pathfindWithProgressWatchdog, ACTION_CAPS_MS } from '../_helpers.js';
import { planWaterRoute } from '../../runtime/water-route.js';
import { planBoatPath, executeBoatPath, bestEffortSail } from '../../runtime/boat-path.js';

import { BOAT_NAMES } from './_water-blocks.js';

import { createFishHandlers } from './fishing.js';
import { createPlaceBoatHandlers } from './place-boat.js';
import { createBoardHandlers } from './board.js';
import { createSailLegHandlers } from './sail-leg.js';
import { createDisembarkHandlers } from './disembark.js';
import { createBucketHandlers } from './buckets.js';

import { createSailToImpl } from './sail-to/orchestrate.js';
import { createSailToOuterWrapper } from './sail-to/wrapper.js';

export function createWaterActions(deps) {
  const {
    ctx, ensureBot, goals, sleep, log, getMyName, ACTIONS, posObj,
  } = deps;

  /** task #43 retry map — keyed by sail_to target coords. */
  /** @type {Map<string, { count: number, lastErrorCode: string|null, lastNearestWater: {x:number,y:number,z:number}|null, lastShoreStance?: {x:number,y:number,z:number}|null, lastFailurePos: {x:number,y:number,z:number}|null }>} */
  const sailToRetryCounts = new Map();
  const SAIL_TO_RETRY_LIMIT = 4;
  const RETRY_RESET_DISTANCE = 12;

  const fishPart = createFishHandlers({ ensureBot, goals, sleep, log });
  const placeBoatPart = createPlaceBoatHandlers({ ensureBot, goals, ACTIONS, log, sleep, getMyName });
  const boardPart = createBoardHandlers({ ensureBot, goals, ACTIONS, log, sleep, getMyName });
  const sailLegPart = createSailLegHandlers({ ensureBot, sleep, log, ACTIONS });
  const disembarkPart = createDisembarkHandlers({ ensureBot, ACTIONS, sleep, log, getMyName });
  const bucketPart = createBucketHandlers({ ensureBot, goals, sleep, log, getMyName, posObj });

  const sailBindings = {
    ctx,
    ensureBot,
    ACTIONS,
    goals,
    sleep,
    log,
    getMyName,
    sailToRetryCounts,
    SAIL_TO_RETRY_LIMIT,
    RETRY_RESET_DISTANCE,
    BOAT_NAMES,
    Vec3,
    planWaterRoute,
    pathfindWithProgressWatchdog,
    ACTION_CAPS_MS,
    findAdjustedTarget,
    executeServerCommand,
    paperMcpConfig,
    planBoatPath,
    executeBoatPath,
    bestEffortSail,
  };

  const _sailImpl = createSailToImpl(sailBindings);

  const sail_to = createSailToOuterWrapper(
    { ctx, ensureBot, sailToRetryCounts },
    () => _sailImpl,
  );

  return {
    ...fishPart,
    ...placeBoatPart,
    ...boardPart,
    ...sailLegPart,

    sail_to,
    _sailToImpl: _sailImpl,

    ...disembarkPart,
    ...bucketPart,
  };
}
