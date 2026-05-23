// @size-exempt: collect coordinator; delegates to discovery/ordering/execute
import { collectDiscoveryPhase } from './discovery.js';
import { collectOrderingPhase } from './ordering.js';
import { executeCollectHarvest } from './execute.js';

export function createCollectHandler(deps) {
  const {
    ctx,
    ensureBot,
    resolveMiningBlockName,
    goals,
    sleep,
    log,
    hasLineOfSight,
    eyePosition,
  } = deps;

  // Raycast from bot eye to a point just OUTSIDE the target block on the
  // bot-facing face. Returns true if the ray reaches that face with no
  // intervening solid block. Aims at the nearest face center pulled back
  // by 0.02 so the endpoint sits in air, not inside the target — avoids
  // false negatives where the ray ends inside its own target block.
  function canSeeMinableFace(targetPos) {
    if (!hasLineOfSight || !eyePosition) return true; // pre-wire safety
    const eye = eyePosition();
    if (!eye) return true;
    const cx = targetPos.x + 0.5;
    const cy = targetPos.y + 0.5;
    const cz = targetPos.z + 0.5;
    const dx = eye.x - cx;
    const dy = eye.y - cy;
    const dz = eye.z - cz;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const adz = Math.abs(dz);
    const candidates = [];
    if (adx > 0.001) candidates.push({ x: cx + Math.sign(dx) * 0.48, y: cy, z: cz });
    if (ady > 0.001) candidates.push({ x: cx, y: cy + Math.sign(dy) * 0.48, z: cz });
    if (adz > 0.001) candidates.push({ x: cx, y: cy, z: cz + Math.sign(dz) * 0.48 });
    for (const f of candidates) {
      if (hasLineOfSight(eye, f)) return true;
    }
    return false;
  }

  return async function collect({ block, count = 1 }) {
    const b = ensureBot();
    ctx.tasks.cancelRequested = false;
    const blockName = resolveMiningBlockName(block);
    const blockType = ctx.world.mcData.blocksByName[blockName];
    if (!blockType) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_BLOCK',
          message: `Unknown block "${blockName}". Check spelling (e.g. oak_log, iron_ore, cobblestone).`,
          observed_state: { requested_block: blockName },
          retry_safe: false,
        },
      };
    }

    const batchSize = Math.min(count, 20);
    const inventoryAt = () =>
      b.inventory.items().reduce((acc, it) => {
        acc[it.name] = (acc[it.name] || 0) + it.count;
        return acc;
      }, /** @type {Record<string, number>} */ ({}));
    const startedInventory = inventoryAt();
    const startedBlockCount = startedInventory[blockName] || 0;

    const disc = await collectDiscoveryPhase(deps, {
      b,
      blockName,
      blockType,
      batchSize,
      count,
      inventoryAt,
      startedInventory,
      startedBlockCount,
    });
    if (disc.terminal) return disc.response;

    const {
      found,
      resolvedFromSource,
      acceptedTargetNames,
      isTrunkHarvest,
    } = disc.value;

    const ord = collectOrderingPhase({
      b,
      blockName,
      count,
      found,
      isTrunkHarvest,
    });
    if (!ord.ok) return ord.response;

    const { sorted, stripPlaneFloorY, stripSort, isFlooded } = ord.value;

    return executeCollectHarvest({
      b,
      ctx,
      goals,
      sleep,
      log,
      blockName,
      count,
      batchSize,
      found,
      acceptedTargetNames,
      resolvedFromSource,
      isTrunkHarvest,
      sorted,
      stripPlaneFloorY,
      stripSort,
      isFlooded,
      inventoryAt,
      startedInventory,
      startedBlockCount,
      canSeeMinableFace,
    });
  };
}
