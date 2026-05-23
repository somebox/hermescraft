// @size-exempt: mining actions facade and timeout wrappers
import {
  raceWithTimeout,
  timeoutError,
  OperationTimeoutError,
  ACTION_CAPS_MS,
} from '../_helpers.js';
import { createCollectHandler } from './collect/index.js';
import { createDigHandlers } from './dig.js';
import { createPickupHandler } from './pickup.js';
import { createScoutHandlers } from './scout.js';
import { createSocialHandlers } from './social.js';

export function createMiningActions(deps) {
  const {
    ensureBot,
    posObj,
  } = deps;

  const pickup = createPickupHandler(deps);
  const scout = createScoutHandlers(deps);
  const social = createSocialHandlers(deps);

  const { dig: digCore, createSafeDig } = createDigHandlers(deps);

  const handlers = {
    collect: createCollectHandler(deps),
    dig: digCore,
    pickup,
    find_blocks: scout.find_blocks,
    find_entities: scout.find_entities,
    ...social,
    safe_dig: null,
  };

  handlers.safe_dig = createSafeDig((a) => handlers.dig(a));

  const _origCollect = handlers.collect;
  handlers.collect = async function collectWrapped(args) {
    try {
      return await raceWithTimeout(_origCollect(args), ACTION_CAPS_MS.collect, 'collect');
    } catch (err) {
      if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
        const b = ensureBot();
        try { b.pathfinder.setGoal(null); } catch { /* ignore */ }
        try { b.stopDigging(); } catch { /* ignore */ }
        return timeoutError('collect', ACTION_CAPS_MS.collect, {
          requested_block: args?.block,
          requested_count: args?.count,
          bot_position: posObj(b.entity.position),
        }, 'Collect was canceled. Inventory may be partially updated; check with mc inventory.');
      }
      throw err;
    }
  };

  const _origDig = handlers.dig;
  handlers.dig = async function digWrapped(args) {
    try {
      return await raceWithTimeout(_origDig(args), ACTION_CAPS_MS.dig, 'dig');
    } catch (err) {
      if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
        const b = ensureBot();
        try { b.pathfinder.setGoal(null); } catch { /* ignore */ }
        try { b.stopDigging(); } catch { /* ignore */ }
        return timeoutError('dig', ACTION_CAPS_MS.dig, {
          requested_coord: { x: args?.x, y: args?.y, z: args?.z },
          bot_position: posObj(b.entity.position),
        }, 'Dig was canceled.');
      }
      throw err;
    }
  };

  return handlers;
}
