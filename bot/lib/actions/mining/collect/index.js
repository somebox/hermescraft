// @size-exempt: collect coordinator; delegates to discovery/ordering/execute
import { collectDiscoveryPhase } from './discovery.js';
import { collectOrderingPhase } from './ordering.js';
import { executeCollectHarvest } from './execute.js';
import { canSeeBotFacingFace } from '../../_los.js';
import { fail } from '../../../shared/action-contract.js';
import {
  blockNeedsPickaxeHarvest,
  blockNeedsAxeHarvest,
  firstInvItemByPriority,
  HARVEST_PICK_PRIORITY,
  HARVEST_AXE_PRIORITY,
  suggestedToolForBlock,
} from '../../../runtime/dig-tools.js';
import { sourceBlocksForItem } from './discovery.js';

/**
 * Pre-flight check for the harvest tool needed to drop the requested item.
 * Returns a `fail()` envelope when no suitable tool is in inventory (and
 * either the requested block OR a likely source block needs one), else null.
 *
 * "Suitable" means ANY tier of the appropriate tool family — wooden_pickaxe
 * for stone-family blocks, wooden_axe for logs, etc. Tier-specific checks
 * (iron_pickaxe required for diamond_ore) are NOT enforced here; let
 * equipForDig's runtime guard catch tier mismatches per candidate.
 *
 * Why include source blocks: `mc collect cobblestone` falls back to mining
 * stone when no cobblestone is visible. Stone needs a pickaxe; cobblestone
 * does too. But if the user requested e.g. `mc collect coal`, the source
 * fallback is coal_ore (also pickaxe). Walking the same priority lookup
 * for blockName AND its sources covers both cases.
 */
function checkPreflightTool(b, blockName, mcData) {
  const needs = (name) => {
    if (blockNeedsPickaxeHarvest(name)) return { kind: 'pickaxe', priority: HARVEST_PICK_PRIORITY };
    if (blockNeedsAxeHarvest(name)) return { kind: 'axe', priority: HARVEST_AXE_PRIORITY };
    return null;
  };

  // Build the set of names we care about: the request itself plus likely
  // source blocks. If ANY of them needs a tool we don't have, refuse.
  const namesToCheck = new Set([blockName]);
  for (const src of sourceBlocksForItem(mcData, blockName)) {
    namesToCheck.add(src);
  }

  /** @type {{ name: string, kind: string, priority: string[] } | null} */
  let firstUnmetNeed = null;
  for (const name of namesToCheck) {
    const need = needs(name);
    if (!need) continue;
    const have = firstInvItemByPriority(b, need.priority);
    if (!have) {
      firstUnmetNeed = { name, kind: need.kind, priority: need.priority };
      break;
    }
  }
  if (!firstUnmetNeed) return null;

  const suggested = suggestedToolForBlock(firstUnmetNeed.name);
  return fail(
    'NO_SUITABLE_TOOL',
    `mc collect ${blockName}: need a ${firstUnmetNeed.kind} to drop ${firstUnmetNeed.name} ` +
    `(would mine slowly OR drop nothing with bare hands). Craft or equip a ${firstUnmetNeed.kind} first — ` +
    `e.g. wooden_${firstUnmetNeed.kind}. Pass force=true if you have a sub-optimal tool and accept slow mining.`,
    {
      observed_state: {
        requested_block: blockName,
        unmet_for: firstUnmetNeed.name,
        required_tool_family: firstUnmetNeed.kind,
        suggested_tool: suggested,
      },
      next_action_hint: `mc craft wooden_${firstUnmetNeed.kind}`,
      retry_safe: false,
    },
  );
}

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

    // Pre-flight tool check (genesis run g-2026-05-27-10 #3 "tool-blind"
    // sub-claim). Refuse early if the requested block — OR its likely
    // source block — needs a harvest tool the bot doesn't have. Without
    // this, the bot pathfinds toward the target (potentially digging
    // through dirt to reach buried stone), arrives at the dig step, and
    // only THEN refuses with TOOL_INADEQUATE. We've already burned the
    // path and possibly cut a shaft. Fail before discovery.
    //
    // Force flag bypasses the check (caller knows what they're doing,
    // e.g. they have wood pickaxe and accept slow mining).
    if (!force) {
      const toolFail = checkPreflightTool(b, blockName, ctx.world.mcData);
      if (toolFail) return toolFail;
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
