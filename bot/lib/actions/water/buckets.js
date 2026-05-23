import { Vec3 } from 'vec3';
import { findAdjustedTarget } from '../_nav-helpers.js';
import { REPLACEABLE } from '../_block-sets.js';
import { executeServerCommand, paperMcpConfig } from '../../runtime/paper-mcp.js';
import { pathfindGotoNear, ACTION_CAPS_MS } from '../_helpers.js';
import { fail } from './_contract.js';

export function createBucketHandlers({ ensureBot, goals, sleep, log, getMyName, posObj }) {

  async function bucket_fill({ x, y, z }) {
  const b = ensureBot();
  const inventoryAt = () =>
    b.inventory.items().reduce((acc, it) => { acc[it.name] = (acc[it.name] || 0) + it.count; return acc; }, /** @type {Record<string, number>} */ ({}));

  const empty = b.inventory.items().find((i) => i.name === 'bucket');
  if (!empty) {
    const buckets = b.inventory.items().filter((i) => /bucket$/.test(i.name)).map((i) => `${i.name}x${i.count}`);
            return fail('MISSING_BUCKET', 'No empty bucket in inventory. Craft one (3 iron_ingot).', {
          observed_state: { inventory_buckets: buckets },
          retry_safe: false,
        });
  }

  const isLiquidSource = (bot, px, py, pz) => {
    const blk = bot?.blockAt && bot.blockAt(new Vec3(px, py, pz));
    if (!blk) return false;
    if (blk.name !== 'water' && blk.name !== 'lava') return false;
    const lvl = Number(blk.getProperties?.()?.level ?? 0);
    return lvl === 0;
  };

  const targetPos = new Vec3(x, y, z);
  let target = b.blockAt(targetPos);
  let adjustedTarget = null;

  // Self-adjust: if the requested cell isn't a liquid source, search within
  // 3 blocks for the nearest source and use that instead.
  if (!target || !isLiquidSource(b, x, y, z)) {
    const adj = findAdjustedTarget(b, isLiquidSource, x, y, z, 3);
    if (adj && adj.adjusted) {
      targetPos.x = adj.x; targetPos.y = adj.y; targetPos.z = adj.z;
      target = b.blockAt(targetPos);
      adjustedTarget = { x: adj.x, y: adj.y, z: adj.z, distance: adj.distance, original: adj.original };
    }
  }

  if (!target || (target.name !== 'water' && target.name !== 'lava')) {
            return fail('NOT_A_LIQUID', `Block at (${x}, ${y}, ${z}) is ${target?.name ?? 'unloaded'}, not water/lava.`, {
          observed_state: { target_block: target?.name ?? null, requested_coord: { x, y, z } },
          retry_safe: false,
        });
  }

  const rawLevel = target.getProperties?.()?.level;
  const level = Number(rawLevel ?? 0);
  if (level !== 0) {
            return fail('NOT_A_SOURCE', `${target.name} at (${x}, ${y}, ${z}) is flowing (level=${level}), not a source. Buckets only fill from source blocks.`, {
          observed_state: { target_block: target.name, level },
          retry_safe: false,
        });
  }

  if (b.entity.position.distanceTo(targetPos) > 4.5) {
    try {
      await pathfindGotoNear(b, goals, targetPos.x, targetPos.y, targetPos.z, 3, { opName: 'bucket_fill', capMs: ACTION_CAPS_MS.reach });
    } catch {
              return fail('OUT_OF_RANGE', `Target at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) is ${Math.round(b.entity.position.distanceTo(targetPos) * 10) / 10} blocks away and pathfind failed.`, {
          observed_state: { distance: b.entity.position.distanceTo(targetPos), bot_position: posObj(b.entity.position) },
          retry_safe: false,
        });
    }
  }

  try { await b.equip(empty, 'hand'); } catch (err) {
            return fail('INTERRUPTED', `equip bucket failed: ${/** @type {Error} */ (err).message}`, { retry_safe: true });
  }

  const liquidName = target.name === 'water' ? 'water_bucket' : 'lava_bucket';
  const before = inventoryAt();
  // Try native mineflayer first; falls through to PaperMCP server-side
  // if the inventory delta is zero. On Paper 1.21+, both use_item and
  // use_item_on packets silently no-op for bucket fill against fluid
  // blocks (same class of bug as the 3x3 craft delta=0 issue); the
  // PaperMCP fallback is the reliable path.
  try {
    await b.lookAt(target.position.offset(0.5, 0.5, 0.5), true);
    await sleep(100);
    await b.activateItem();
    await sleep(400);
    try { b.deactivateItem(); } catch { /* ignore */ }
  } catch { /* fall through to PaperMCP */ }
  let after = inventoryAt();
  let gained = (after[liquidName] || 0) - (before[liquidName] || 0);
  let fallback = null;
  if (gained < 1) {
    const pmcp = paperMcpConfig();
    const username = getMyName?.();
    if (pmcp && username) {
      log(`[bucket_fill] native no-op for ${liquidName} — using PaperMCP fallback`);
      const r1 = await executeServerCommand(pmcp, `clear ${username} minecraft:bucket 1`);
      const r2 = await executeServerCommand(pmcp, `give ${username} minecraft:${liquidName} 1`);
      const r3 = await executeServerCommand(pmcp, `setblock ${targetPos.x} ${targetPos.y} ${targetPos.z} minecraft:air`);
      if (r1.ok && r2.ok && r3.ok) {
        for (let i = 0; i < 8; i++) {
          await sleep(120);
          after = inventoryAt();
          if ((after[liquidName] || 0) - (before[liquidName] || 0) >= 1) break;
        }
        gained = (after[liquidName] || 0) - (before[liquidName] || 0);
        fallback = 'papermcp_server_side';
      } else if (log) {
        log(`[bucket_fill] PaperMCP fallback failed: clear=${r1.error} give=${r2.error} setblock=${r3.error}`);
      }
    }
  }
  if (gained < 1) {
            return fail('UNCHANGED', `bucket_fill did not produce a ${liquidName}.`, {
          observed_state: { started_inventory: before, ended_inventory: after, target_block: target.name, fallback_attempted: !!paperMcpConfig() },
          retry_safe: true,
        });
  }
  return {
    ok: true,
    data: {
      filled: liquidName,
      source_coord: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      started_inventory: before,
      ended_inventory: after,
      ...(fallback ? { fallback } : {}),
      ...(adjustedTarget ? { adjusted_target: adjustedTarget } : {}),
    },
    result: fallback
      ? `Filled ${liquidName} from ${target.name} at ${targetPos.x},${targetPos.y},${targetPos.z} (server-side fallback).`
      : `Filled ${liquidName} from ${target.name} at ${targetPos.x},${targetPos.y},${targetPos.z}.`,
  };
}

/**
 * Empty a filled water/lava bucket into a replaceable cell at (x,y,z).
 * Bucket placement is "right-click on a face of a solid neighbor" semantically;
 * the liquid appears in the empty cell on that face.
 * ── Phase-2 action contract (Sprint 7) ──
 *   MISSING_BUCKET   no water_bucket / lava_bucket in inventory
 *   BLOCKED          target cell isn't replaceable, OR no solid neighbor to anchor placement
 *   OUT_OF_RANGE     bot couldn't reach within 4.5 blocks
 *   UNCHANGED        server rejected — destination block didn't change
 */
  async function bucket_empty({ x, y, z }) {
  const b = ensureBot();
  const inventoryAt = () =>
    b.inventory.items().reduce((acc, it) => { acc[it.name] = (acc[it.name] || 0) + it.count; return acc; }, /** @type {Record<string, number>} */ ({}));

  const filled = b.inventory.items().find((i) => i.name === 'water_bucket' || i.name === 'lava_bucket');
  if (!filled) {
            return fail('MISSING_BUCKET', 'No water_bucket or lava_bucket in inventory. Use mc bucket_fill first.', {
          observed_state: { inventory_buckets: b.inventory.items().filter((i) => /bucket$/.test(i.name)).map((i) => i.name) },
          retry_safe: false,
        });
  }
  const liquid = filled.name === 'water_bucket' ? 'water' : 'lava';

  const targetPos = new Vec3(x, y, z);
  const oppositeLiquid = liquid === 'water' ? 'lava' : 'water';

  const ANCHOR_OFFSETS = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  const findAnchor = (px, py, pz) => {
    for (const [dx, dy, dz] of ANCHOR_OFFSETS) {
      const nb = b.blockAt(new Vec3(px + dx, py + dy, pz + dz));
      if (nb && (nb.boundingBox === 'block' || nb.name === 'water' || nb.name === 'lava')) {
        return { refBlock: nb, refOffset: [dx, dy, dz] };
      }
    }
    return null;
  };

  const isPourable = (bot, px, py, pz) => {
    const blk = bot?.blockAt && bot.blockAt(new Vec3(px, py, pz));
    const acceptable = !blk || REPLACEABLE.has(blk.name) || blk.name === oppositeLiquid;
    if (!acceptable) return false;
    return !!findAnchor(px, py, pz);
  };

  let existing = b.blockAt(targetPos);
  let adjustedTarget = null;

  const targetPourable = (() => {
    if (existing && !REPLACEABLE.has(existing.name) && existing.name !== oppositeLiquid) return false;
    return !!findAnchor(targetPos.x, targetPos.y, targetPos.z);
  })();

  if (!targetPourable) {
    const adj = findAdjustedTarget(b, isPourable, x, y, z, 3);
    if (adj && adj.adjusted) {
      targetPos.x = adj.x; targetPos.y = adj.y; targetPos.z = adj.z;
      existing = b.blockAt(targetPos);
      adjustedTarget = { x: adj.x, y: adj.y, z: adj.z, distance: adj.distance, original: adj.original };
    }
  }

  if (existing && !REPLACEABLE.has(existing.name) && existing.name !== oppositeLiquid) {
            return fail('BLOCKED', `Target (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) is ${existing.name}, not replaceable. Dig it first.`, {
          observed_state: { target_block: existing.name, requested_coord: { x, y, z } },
          next_action_hint: `mc dig ${targetPos.x} ${targetPos.y} ${targetPos.z}`,
          retry_safe: false,
        });
  }

  const anchor = findAnchor(targetPos.x, targetPos.y, targetPos.z);
  if (!anchor) {
            return fail('BLOCKED', `Target (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) has no solid or fluid neighbor — bucket placement needs a face to click on.`, {
          observed_state: { requested_coord: { x, y, z } },
          retry_safe: false,
        });
  }
  const { refBlock, refOffset } = anchor;

  if (b.entity.position.distanceTo(targetPos) > 4.5) {
    try {
      await pathfindGotoNear(b, goals, targetPos.x, targetPos.y, targetPos.z, 3, { opName: 'bucket_fill', capMs: ACTION_CAPS_MS.reach });
    } catch {
              return fail('OUT_OF_RANGE', `Target at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) is ${Math.round(b.entity.position.distanceTo(targetPos) * 10) / 10} blocks away and pathfind failed.`, {
          observed_state: { distance: b.entity.position.distanceTo(targetPos), bot_position: posObj(b.entity.position) },
          retry_safe: false,
        });
    }
  }

  try { await b.equip(filled, 'hand'); } catch (err) {
            return fail('INTERRUPTED', `equip ${filled.name} failed: ${/** @type {Error} */ (err).message}`, { retry_safe: true });
  }

  const before = inventoryAt();
  // Try native first; fall through to PaperMCP if no inventory delta.
  // Same Paper 1.21+ quirk as bucket_fill — use_item_on against a solid
  // face holding a water/lava bucket silently no-ops.
  const faceVec = new Vec3(-refOffset[0], -refOffset[1], -refOffset[2]);
  try {
    await b.lookAt(refBlock.position.offset(0.5, 0.5, 0.5), true);
    await sleep(100);
    await b.activateBlock(refBlock, faceVec);
    await sleep(400);
  } catch { /* fall through to PaperMCP */ }
  let placed = b.blockAt(targetPos);
  let after = inventoryAt();
  let fallback = null;
  const bucketGone = (before[filled.name] || 0) - (after[filled.name] || 0) >= 1;
  if (!bucketGone) {
    const pmcp = paperMcpConfig();
    const username = getMyName?.();
    if (pmcp && username) {
      log(`[bucket_empty] native no-op — using PaperMCP fallback`);
      // If pouring onto the opposite liquid, simulate the MC reaction:
      //   water-on-lava → obsidian (source-source meeting)
      //   lava-on-water → stone
      let placedBlock = liquid;
      if (existing && existing.name === oppositeLiquid) {
        placedBlock = liquid === 'water' ? 'obsidian' : 'stone';
      }
      const r1 = await executeServerCommand(pmcp, `clear ${username} minecraft:${filled.name} 1`);
      const r2 = await executeServerCommand(pmcp, `give ${username} minecraft:bucket 1`);
      const r3 = await executeServerCommand(pmcp, `setblock ${targetPos.x} ${targetPos.y} ${targetPos.z} minecraft:${placedBlock}`);
      if (r1.ok && r2.ok && r3.ok) {
        for (let i = 0; i < 8; i++) {
          await sleep(120);
          after = inventoryAt();
          placed = b.blockAt(targetPos);
          if ((after.bucket || 0) > (before.bucket || 0) && placed?.name) break;
        }
        fallback = 'papermcp_server_side';
      } else if (log) {
        log(`[bucket_empty] PaperMCP fallback failed: clear=${r1.error} give=${r2.error} setblock=${r3.error}`);
      }
    }
  }
  // Lava + water reactions can convert the target to stone/cobble/obsidian.
  const liquidReacted = placed && /^(stone|cobblestone|obsidian)$/.test(placed.name);
  const ok = placed && (placed.name === liquid || liquidReacted);
  if (!ok) {
            return fail('UNCHANGED', `bucket_empty did not place ${liquid} at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}); block is ${placed?.name ?? 'unloaded'}.`, {
          observed_state: { target_block_after: placed?.name ?? null, started_inventory: before, ended_inventory: after, fallback_attempted: !!paperMcpConfig() },
          retry_safe: true,
        });
  }
  return {
    ok: true,
    data: {
      emptied: filled.name,
      placed_block: placed.name,
      target_coord: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      reacted: liquidReacted ? placed.name : null,
      started_inventory: before,
      ended_inventory: after,
      ...(fallback ? { fallback } : {}),
      ...(adjustedTarget ? { adjusted_target: adjustedTarget } : {}),
    },
    result: liquidReacted
      ? `Emptied ${filled.name} — water/lava reaction produced ${placed.name} at ${targetPos.x},${targetPos.y},${targetPos.z}${fallback ? ' (server-side fallback)' : ''}.`
      : `Emptied ${filled.name} — ${liquid} placed at ${targetPos.x},${targetPos.y},${targetPos.z}${fallback ? ' (server-side fallback)' : ''}.`,
  };

}

  return { bucket_fill, bucket_empty };
}
