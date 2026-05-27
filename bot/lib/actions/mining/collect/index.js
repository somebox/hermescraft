// @size-exempt: collect coordinator; delegates to discovery/ordering/execute
import { collectDiscoveryPhase } from './discovery.js';
import { collectOrderingPhase } from './ordering.js';
import { executeCollectHarvest } from './execute.js';
import { canSeeBotFacingFace } from '../../_los.js';
import { fail } from '../../../shared/action-contract.js';

/**
 * @typedef {object} CollectContext
 *   The bag of bot + runtime + per-call inputs that every phase reads from.
 *   Phases also receive a separate `phaseInputs` arg carrying the outputs
 *   of earlier phases.
 * @property {import('mineflayer').Bot} b
 * @property {object} ctx                  runtime state (reactive/tasks/world/runtime)
 * @property {object} config               app config (behaviors, etc.)
 * @property {object} goals                mineflayer-pathfinder goals namespace
 * @property {(ms:number)=>Promise<void>} sleep
 * @property {(msg:string)=>void} log
 * @property {string} blockName            requested item/block name
 * @property {object} blockType            mcData entry for blockName
 * @property {number} count                requested count
 * @property {number} batchSize            min(count, 20)
 * @property {boolean} force               --force flag
 * @property {() => Record<string, number>} inventoryAt
 * @property {Record<string, number>} startedInventory
 * @property {number} startedBlockCount
 * @property {(pos: {x:number,y:number,z:number}) => boolean} canSeeMinableFace
 * @property {Function} fairPlayHarvestTrunkCandidates
 * @property {Function} findVisibleBlocksByNameWithPhysicalSweep
 */

export function createCollectHandler(deps) {
  const {
    ctx,
    config,
    ensureBot,
    resolveMiningBlockName,
    goals,
    sleep,
    log,
    hasLineOfSight,
    eyePosition,
    fairPlayHarvestTrunkCandidates,
    findVisibleBlocksByNameWithPhysicalSweep,
  } = deps;

  // Thin closure over the shared `canSeeBotFacingFace` helper so we can
  // pass it to the execute phase as a no-arg-coord function.
  const canSeeMinableFace = (targetPos) =>
    canSeeBotFacingFace(targetPos.x, targetPos.y, targetPos.z, { hasLineOfSight, eyePosition });

  return async function collect({ block, count = 1, force = false }) {
    const b = ensureBot();
    ctx.tasks.cancelRequested = false;
    const blockName = resolveMiningBlockName(block);
    const blockType = ctx.world.mcData.blocksByName[blockName];
    if (!blockType) {
      return fail(
        'UNKNOWN_BLOCK',
        `Unknown block "${blockName}". Check spelling (e.g. oak_log, iron_ore, cobblestone).`,
        { observed_state: { requested_block: blockName }, retry_safe: false },
      );
    }

    const batchSize = Math.min(count, 20);
    const inventoryAt = () =>
      b.inventory.items().reduce((acc, it) => {
        acc[it.name] = (acc[it.name] || 0) + it.count;
        return acc;
      }, /** @type {Record<string, number>} */ ({}));
    const startedInventory = inventoryAt();
    const startedBlockCount = startedInventory[blockName] || 0;

    /** @type {CollectContext} */
    const cctx = {
      b, ctx, config, goals, sleep, log,
      blockName, blockType, count, batchSize, force,
      inventoryAt, startedInventory, startedBlockCount,
      canSeeMinableFace,
      fairPlayHarvestTrunkCandidates,
      findVisibleBlocksByNameWithPhysicalSweep,
    };

    const disc = await collectDiscoveryPhase(cctx);
    if (disc.terminal) return disc.response;

    const { found, resolvedFromSource, acceptedTargetNames, isTrunkHarvest } = disc.value;

    const ord = collectOrderingPhase(cctx, { found, isTrunkHarvest });
    if (!ord.ok) return ord.response;

    const { sorted, stripPlaneFloorY, stripSort, isFlooded } = ord.value;

    return executeCollectHarvest(cctx, {
      found,
      acceptedTargetNames,
      resolvedFromSource,
      isTrunkHarvest,
      sorted,
      stripPlaneFloorY,
      stripSort,
      isFlooded,
    });
  };
}
