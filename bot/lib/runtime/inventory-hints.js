/**
 * Inventory-aware pre-emptive hints for perception/search verbs.
 *
 * Solves two symmetric problems observed in agent logs:
 *
 *   A. Agent searches for a block they can't actually mine.
 *      `mc nearby cobblestone` → "Found 10 cobblestone, 8 reachable" → agent
 *      walks 20m → `mc collect cobblestone` → "Refusing to dig with empty hand".
 *      The hint that they lack a pickaxe arrives ~30s too late.
 *
 *   B. Agent searches chests for a tool they already have.
 *      `mc chest_search wooden_pickaxe` → finds one in chest_misc → agent
 *      walks to chest_misc → withdraws a duplicate → realizes the pickaxe
 *      was already in their main inventory.
 *
 * Both cases waste cycles AND iteration budget on a chain that the bot could
 * have short-circuited if the scan/search had been inventory-aware up front.
 *
 * Two exports:
 *   - toolReadiness(b, blockName) → category, have_tool, hint   (scan-side)
 *   - inventoryHas(b, itemName)   → count, slots                (chest-side)
 *
 * Both are pure-ish: they read mineflayer bot state but do not mutate. Safe
 * to call from any action handler.
 */

import {
  HARVEST_AXE_PRIORITY,
  HARVEST_PICK_PRIORITY,
  HARVEST_SHOVEL_PRIORITY,
  blockNeedsAxeHarvest,
  blockNeedsPickaxeHarvest,
  blockNeedsShovelHarvest,
  firstInvItemByPriority,
} from './dig-tools.js';

/**
 * Tool-readiness summary for a block the agent is considering mining.
 *
 * @param {object} b mineflayer Bot
 * @param {string} blockName e.g. "cobblestone", "oak_log", "dirt"
 * @returns {{tool_needed: 'axe'|'pickaxe'|'shovel'|null, have_tool: boolean,
 *            best_available: string|null, hint: string|null} | null}
 *   - tool_needed: which category the block normally needs
 *   - have_tool:   is there at least one of that category in inventory
 *   - best_available: name of the best-tier matching tool (or null)
 *   - hint: short string ready to append to a result message, or null if
 *           no action is needed (already have tool, OR bare hand works
 *           fine for the block type)
 *
 * Returns null when the bot or block is unknown (caller should ignore).
 */
export function toolReadiness(b, blockName) {
  if (!b || !blockName) return null;

  if (blockNeedsAxeHarvest(blockName)) {
    const tool = firstInvItemByPriority(b, HARVEST_AXE_PRIORITY);
    return {
      tool_needed: 'axe',
      have_tool: !!tool,
      best_available: tool?.name || null,
      hint: tool ? null : `no axe in inventory — mc craft wooden_axe before harvesting ${blockName}`,
    };
  }

  if (blockNeedsPickaxeHarvest(blockName)) {
    const tool = firstInvItemByPriority(b, HARVEST_PICK_PRIORITY);
    return {
      tool_needed: 'pickaxe',
      have_tool: !!tool,
      best_available: tool?.name || null,
      // Stronger wording on pickaxe — server's slow-dig refusal hits this
      // category routinely (44 of 1,519 mc-action failures last session).
      hint: tool
        ? null
        : `no pickaxe in inventory — mc craft wooden_pickaxe before mining ${blockName} (server refuses slow bare-hand digs)`,
    };
  }

  if (blockNeedsShovelHarvest(blockName)) {
    const tool = firstInvItemByPriority(b, HARVEST_SHOVEL_PRIORITY);
    return {
      tool_needed: 'shovel',
      have_tool: !!tool,
      best_available: tool?.name || null,
      // Bare hand WORKS for dirt/sand/gravel — shovel is ~5× faster but
      // optional. Don't add a hint; the agent will succeed either way.
      hint: null,
    };
  }

  // No special tool needed (plants, leaves, snow, wool, …). Treat as
  // ready by default — bare hand works.
  return { tool_needed: null, have_tool: true, best_available: null, hint: null };
}

/**
 * Count occurrences of an item across the bot's main inventory + hotbar.
 * Used by chest_search and similar lookup verbs to pre-empt a wasted
 * walk-to-chest when the bot already carries what it would withdraw.
 *
 * @param {object} b mineflayer Bot
 * @param {string} itemName exact item name (e.g. "wooden_pickaxe"); case-insensitive
 * @returns {{count: number, slots: Array<{slot: number, count: number}>}}
 *   - count: total across all matching slots (0 if not found / bot missing)
 *   - slots: per-slot detail; empty array when count=0
 *
 * Substring matching is NOT supported. Pass an exact Minecraft item name.
 */
export function inventoryHas(b, itemName) {
  if (!b?.inventory?.items || !itemName) return { count: 0, slots: [] };
  const target = String(itemName).toLowerCase();
  const slots = [];
  let count = 0;
  for (const item of b.inventory.items()) {
    if (item?.name === target) {
      count += item.count;
      slots.push({ slot: item.slot, count: item.count });
    }
  }
  return { count, slots };
}

/**
 * Aggregate tool readiness across the blocks visible in an `mc scene` /scene
 * response. Returns up to two short lists:
 *
 *   tools_missing[] — tool categories the agent needs for visible blocks
 *                     but doesn't carry. Each entry: { category, blocks,
 *                     total_count, hint }
 *   tools_ready[]   — categories where the agent has a tool AND there are
 *                     visible blocks of that category. Useful for "yes
 *                     you can act on this scene".
 *
 * Blocks that don't need a tool (plants, leaves, snow) or where bare hand
 * works fine (dirt/sand/gravel — shovel is optimization-only) do NOT
 * surface here. The agent sees only actionable signal.
 *
 * @param {object} b mineflayer Bot
 * @param {Array<{name: string, count: number}>} visibleBlocks
 *   The `visible_blocks` array from buildSceneSummary — each entry has
 *   `name` and `count` (other fields ignored).
 * @returns {{tools_missing: Array<object>, tools_ready: Array<object>}}
 *   Both arrays empty when there's nothing to flag (scene has no
 *   tool-needing blocks, OR the agent has every tool already).
 */
export function sceneToolNeeds(b, visibleBlocks) {
  const empty = { tools_missing: [], tools_ready: [] };
  if (!b || !Array.isArray(visibleBlocks) || visibleBlocks.length === 0) return empty;

  // category → { blocks: Map<name, count>, hint, best_available }
  const byCategory = new Map();
  for (const vb of visibleBlocks) {
    if (!vb?.name) continue;
    const r = toolReadiness(b, vb.name);
    if (!r || r.tool_needed === null) continue;
    // Skip shovel — bare hand mines dirt/sand/gravel fine; no actionable hint.
    if (r.tool_needed === 'shovel' && !r.hint) {
      // Still record under tools_ready if the bot has a shovel — but tools_ready
      // entries are only emitted with at least one visible block of the
      // category, so this is a no-op when the bot has no shovel.
    }
    const slot = byCategory.get(r.tool_needed) || {
      category: r.tool_needed,
      have_tool: r.have_tool,
      best_available: r.best_available,
      hint: r.hint,
      blocks: new Map(),
    };
    slot.blocks.set(vb.name, (slot.blocks.get(vb.name) || 0) + (vb.count || 1));
    byCategory.set(r.tool_needed, slot);
  }

  const tools_missing = [];
  const tools_ready = [];
  for (const slot of byCategory.values()) {
    const blocks = [...slot.blocks.entries()].map(([name, count]) => ({ name, count }));
    const total_count = blocks.reduce((s, b) => s + b.count, 0);
    const entry = { category: slot.category, blocks, total_count };
    if (slot.have_tool) {
      tools_ready.push({ ...entry, best_available: slot.best_available });
    } else if (slot.hint) {
      tools_missing.push({ ...entry, hint: slot.hint });
    }
  }
  return { tools_missing, tools_ready };
}
