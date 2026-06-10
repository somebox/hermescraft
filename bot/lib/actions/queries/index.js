// @size-exempt: split from former queries.js — read-only world queries (Phase 4)
import pathfinderPkg from 'mineflayer-pathfinder';
import { createEscapeQueries } from './escape/action.js';
import { createFindQueries } from './find.js';
import { createInspectQueries } from './inspect.js';
import { createRegionQueries } from './region.js';
import { createScoutQueries } from './scout.js';
import { createSignsQueries } from './signs.js';
import { createStandingQueries } from './standing.js';

const { goals } = pathfinderPkg;

/**
 * createQueriesActions — extracted from former lib/actions/world.js (Phase 4 split).
 */
export function createQueriesActions(services) {
  const { state: ctx, ensureBot, utils, fairPlay, getActions, personalPois, locations } = services;
  const { posObj } = utils;
  const loadPersonalPois = personalPois?.load ? () => personalPois.load() : null;

  return {
    ...createScoutQueries({ ctx, ensureBot, fairPlay }),
    ...createRegionQueries({ ensureBot, posObj, goals }),
    ...createStandingQueries({ ensureBot }),
    ...createEscapeQueries({ ctx, ensureBot, getActions, utils, goals }),
    ...createFindQueries({ ctx, ensureBot }),
    ...createInspectQueries({ ctx, ensureBot, locations }),
    ...createSignsQueries({ ensureBot, loadPersonalPois }),
  };
}
