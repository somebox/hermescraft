// @size-exempt: aggregated block-placement verbs from former lib/actions/building.js
/**
 * createBuildingActions — extracted from former lib/actions/world.js (Phase 4 split).
 */

import { createBuildingPillarPart } from './pillar.js';
import { createBuildingPlaceSinglePart } from './place-single.js';
import { createBuildingPlaceBulkPart } from './place-bulk.js';
import { createBuildingTerrainPart } from './terrain.js';
import { createBuildingRoadPart } from './road.js';

export function createBuildingActions(services) {
  const { state: ctx, config, ensureBot, utils, social, resolver, fairPlay, getActions } = services;
  const { fmt, posObj, sleep, log } = utils;
  const { resolveInventoryItem } = resolver;
  const { rememberSocialEvent, getMyName } = social;

  const pillarPart = createBuildingPillarPart({ ctx, ensureBot, sleep, getActions });
  const placeSinglePart = createBuildingPlaceSinglePart({
    services, ctx, ensureBot, posObj, sleep, fairPlay,
  });
  const placeBulkPart = createBuildingPlaceBulkPart({ ctx, ensureBot, sleep, config });
  const terrainPart = createBuildingTerrainPart({ ctx, ensureBot, sleep, getActions, config });
  const roadPart = createBuildingRoadPart({ ctx, config, ensureBot, getActions });

  return {
    ...pillarPart,
    ...placeSinglePart,
    ...placeBulkPart,
    ...terrainPart,
    ...roadPart,

    /**
     * Highest solid block per vertical column — for pit/site selection without N×find_blocks.
     * Optional `radius`: square (2r+1)² around (x,z), returns max top among sampled columns.
     */
    /**
     * Hazard observation in a radius. Read-only; no movement, no digging.
     * Useful for "look before you mine" — agent runs scout, plans around
     * lava and gravity columns, then issues mc safe_dig calls.
     *
     * Args:
     *   x, y, z   — center; defaults to bot position
     *   radius    — search radius; default 8, capped at 16
     */
  };
}
