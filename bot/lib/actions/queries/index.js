// @size-exempt: split from former queries.js — read-only world queries (Phase 4)
import pathfinderPkg from 'mineflayer-pathfinder';
import { createEscapeQueries } from './escape/action.js';
import { createFindQueries } from './find.js';
import { createInspectQueries } from './inspect.js';
import { createRegionQueries } from './region.js';
import { createScoutQueries } from './scout.js';
import { createStandingQueries } from './standing.js';

const { goals } = pathfinderPkg;

/**
 * createQueriesActions — extracted from former lib/actions/world.js (Phase 4 split).
 */
export function createQueriesActions(services) {
  const { state: ctx, ensureBot, utils, fairPlay, getActions } = services;
  const { posObj } = utils;

  return {
    ...createScoutQueries({ ctx, ensureBot, fairPlay }),
    ...createRegionQueries({ ensureBot, posObj, goals }),
    ...createStandingQueries({ ensureBot }),
    ...createEscapeQueries({ ctx, ensureBot, getActions, utils, goals }),
    ...createFindQueries({ ctx, ensureBot }),
    ...createInspectQueries({ ctx, ensureBot }),
  };
}
