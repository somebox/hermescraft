/** @size-exempt: shared block/tool classification tables + sweep helpers */
/**
 * Tool selection, guard logic, and dig utilities for mining actions.
 * All functions are stateless — they operate on the bot instance passed in.
 */
import { Vec3 } from 'vec3';
import { getConfig } from '../config/index.js';

export const HARVEST_AXE_PRIORITY = [
  'netherite_axe',
  'diamond_axe',
  'iron_axe',
  'stone_axe',
  'golden_axe',
  'wooden_axe',
];

export const HARVEST_PICK_PRIORITY = [
  'netherite_pickaxe',
  'diamond_pickaxe',
  'iron_pickaxe',
  'stone_pickaxe',
  'golden_pickaxe',
  'wooden_pickaxe',
];

// Shovel speeds up sand/dirt/gravel/etc by ~5×. Required for mixed-terrain
// mining to feel like real-player behavior (task #34.1).
export const HARVEST_SHOVEL_PRIORITY = [
  'netherite_shovel',
  'diamond_shovel',
  'iron_shovel',
  'stone_shovel',
  'golden_shovel',
  'wooden_shovel',
];

export const PROTECTED_DIG_BLOCKS = new Set([
  'oak_planks', 'birch_planks', 'spruce_planks', 'dark_oak_planks', 'jungle_planks', 'acacia_planks',
  'glass', 'glass_pane', 'white_stained_glass', 'white_stained_glass_pane',
  'oak_door', 'birch_door', 'spruce_door', 'dark_oak_door', 'iron_door',
  'oak_fence', 'birch_fence', 'spruce_fence', 'dark_oak_fence',
  'oak_fence_gate', 'birch_fence_gate', 'spruce_fence_gate',
  'oak_stairs', 'birch_stairs', 'spruce_stairs', 'cobblestone_stairs', 'stone_stairs',
  'oak_slab', 'birch_slab', 'spruce_slab', 'cobblestone_slab', 'stone_slab',
  'stone_bricks', 'bricks', 'smooth_stone',
  // crafting_table NOT protected — the bot legitimately needs to relocate
  // its own table when it ends up blocking a shelter wall (G20 v32/v33
  // failure mode). Other utility blocks (furnace, chest, bed) stay
  // protected because losing one to an accidental dig is more painful
  // than a lost table.
  'furnace', 'chest', 'barrel', 'bookshelf',
  'torch', 'wall_torch', 'lantern', 'ladder',
  'bed', 'white_bed', 'red_bed',
]);

/**
 * F45.5: When BOT_ALLOW_DIG_INFRASTRUCTURE=true, downgrade the protected
 * list to only the truly irreplaceable items so the bot can relocate
 * furniture (crafting table / furnace / chest / barrel) that ended up
 * blocking a build. Beds and bookshelves stay protected because they
 * carry expensive durable items (string, books) that bots should not
 * lose to an accidental dig.
 *
 * G21 orchestrator sets this true on body launch. G20 and other tests
 * keep the full protection by default.
 */
const ALWAYS_PROTECTED = new Set([
  'bed', 'white_bed', 'red_bed', 'bookshelf',
]);

// #101: how long a recently-placed block stays exempt from the dig
// protection list. 15 minutes — long enough to cover a "place fences →
// realize pen is too small → tear down and rebuild" loop, short enough
// that the bot doesn't accumulate stale exemptions for blocks the
// player later considers permanent infrastructure.
const RECENT_PLACE_TTL_MS = 15 * 60 * 1000;

/**
 * Checks whether a block name (and optionally its cell + runtime ctx)
 * is on the protected-dig list. When `cell` and `ctx` are provided AND
 * the bot itself placed that block in the last RECENT_PLACE_TTL_MS,
 * the protection is bypassed — the bot is allowed to mine its own
 * recently-placed blocks. This unblocks rebuild flows (e.g. "the pen
 * is too small, chop it down and make it bigger") where the bot would
 * otherwise refuse to break its own fences.
 *
 * Legacy single-arg call (`isDigProtected(name)`) is preserved.
 */
export function isDigProtected(blockName, cell = null, ctx = null) {
  if (!blockName) return false;
  if (getConfig().behaviors.allowDigInfrastructure) {
    if (ALWAYS_PROTECTED.has(blockName)) return true;
    return false;
  }
  if (!PROTECTED_DIG_BLOCKS.has(blockName)) return false;
  // Protected — but check if WE placed it recently.
  if (cell && ctx && Array.isArray(ctx.runtime?.recentPlaces)) {
    const cutoff = Date.now() - RECENT_PLACE_TTL_MS;
    const cx = Math.floor(cell.x), cy = Math.floor(cell.y), cz = Math.floor(cell.z);
    for (const entry of ctx.runtime.recentPlaces) {
      if (entry.ts <= cutoff) continue;
      if (entry.cell.x === cx && entry.cell.y === cy && entry.cell.z === cz) {
        return false;
      }
    }
  }
  return true;
}

/**
 * #101: record a successful place so future digs at the same cell
 * bypass isDigProtected. Caller should invoke this after a confirmed
 * place. Bounded at 64 entries (FIFO drop oldest).
 */
export function recordRecentPlace(ctx, cell, blockName) {
  if (!ctx || !cell || !blockName) return;
  if (!Array.isArray(ctx.runtime?.recentPlaces)) return;
  const cutoff = Date.now() - RECENT_PLACE_TTL_MS;
  // Decay first.
  ctx.runtime.recentPlaces = ctx.runtime.recentPlaces.filter(e => e.ts > cutoff);
  const cx = Math.floor(cell.x), cy = Math.floor(cell.y), cz = Math.floor(cell.z);
  // Refresh timestamp if same cell already present.
  const existing = ctx.runtime.recentPlaces.find(e => e.cell.x === cx && e.cell.y === cy && e.cell.z === cz);
  if (existing) {
    existing.ts = Date.now();
    existing.block = blockName;
    return;
  }
  ctx.runtime.recentPlaces.push({ ts: Date.now(), cell: { x: cx, y: cy, z: cz }, block: blockName });
  if (ctx.runtime.recentPlaces.length > 64) ctx.runtime.recentPlaces.shift();
}

/**
 * F54.1 — detect blocks that support a door or fence_gate directly above.
 * Digging the support drops the door/gate as a loose item entity, which
 * the bot then can't easily recover (mc collect on item entities is fiddly,
 * and the brain typically doesn't realize what happened). Returns the
 * supported block's name + coord, or null when safe.
 *
 * Trapdoors are wall-mounted and don't have a floor support, so we ignore
 * them. Beds also have two halves but losing one is recoverable.
 */
export function getSupportedDoorAbove(b, x, y, z) {
  const above = b.blockAt(new Vec3(x, y + 1, z));
  if (!above) return null;
  const name = above.name;
  if (!name) return null;
  if (name.endsWith('_door') || name.endsWith('_fence_gate')) {
    return { name, x, y: y + 1, z };
  }
  return null;
}

export const DIG_PASSABLE_NAMES = new Set(['air', 'cave_air', 'void_air']);
export const DIG_FLUID_NAMES = new Set(['water', 'lava']);
export const FALLING_BLOCK_NAMES = new Set([
  'sand', 'red_sand', 'gravel', 'anvil', 'chipped_anvil', 'damaged_anvil',
  'concrete_powder', 'white_concrete_powder', 'orange_concrete_powder',
  'magenta_concrete_powder', 'light_blue_concrete_powder', 'yellow_concrete_powder',
  'lime_concrete_powder', 'pink_concrete_powder', 'gray_concrete_powder',
  'light_gray_concrete_powder', 'cyan_concrete_powder', 'purple_concrete_powder',
  'blue_concrete_powder', 'brown_concrete_powder', 'green_concrete_powder',
  'red_concrete_powder', 'black_concrete_powder',
  'pointed_dripstone', 'scaffolding',
]);
const LAVA_NAMES = new Set(['lava', 'flowing_lava']);

/**
 * Check if breaking the block at (x, y, z) would expose adjacent lava.
 * Returns { kind: "lava", at:{x,y,z} } if any face neighbor is lava, else null.
 */
export function checkLavaHazard(b, x, y, z) {
  const offsets = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of offsets) {
    const adj = b.blockAt(new Vec3(x + dx, y + dy, z + dz));
    if (adj && LAVA_NAMES.has(adj.name)) {
      return { kind: 'lava', at: { x: x + dx, y: y + dy, z: z + dz } };
    }
  }
  return null;
}

/**
 * Check if breaking the block at (x, y, z) is the floor block under the bot,
 * which would cause an unintended fall. Returns { kind:"fall", drop } if so.
 */
export function checkFallHazard(b, x, y, z) {
  const me = b.entity.position;
  const myFootBlock = {
    x: Math.floor(me.x),
    y: Math.floor(me.y) - 1,
    z: Math.floor(me.z),
  };
  if (myFootBlock.x !== x || myFootBlock.y !== y || myFootBlock.z !== z) return null;
  // Target IS the block under bot. How far would bot fall?
  let drop = 0;
  for (let dy = 1; dy < 16; dy++) {
    const below = b.blockAt(new Vec3(x, y - dy, z));
    if (below && below.boundingBox === 'block') break;
    drop = dy;
  }
  return { kind: 'fall', drop };
}

/**
 * Check if breaking the block at (x, y, z) would cause a falling-block column
 * above to suffocate the bot. Fires when:
 *   - target is in the bot's vertical column (same x_floor, z_floor)
 *   - target is at or above the bot's head (so falling sand lands on bot)
 *   - block directly above target is a falling block
 * Returns { kind:"suffocate", falling_block, column_height } if so.
 */
export function checkSuffocateHazard(b, x, y, z) {
  const me = b.entity.position;
  const myFootX = Math.floor(me.x);
  const myFootZ = Math.floor(me.z);
  const myFootY = Math.floor(me.y);
  if (myFootX !== x || myFootZ !== z) return null;
  // Target must be at or above bot head Y (foot Y + 1 is head Y for a 2-block-tall mob).
  if (y < myFootY) return null;
  const above = b.blockAt(new Vec3(x, y + 1, z));
  if (!above || !FALLING_BLOCK_NAMES.has(above.name)) return null;
  let h = 1;
  while (h < 16) {
    const stack = b.blockAt(new Vec3(x, y + 1 + h, z));
    if (!stack || !FALLING_BLOCK_NAMES.has(stack.name)) break;
    h++;
  }
  return { kind: 'suffocate', falling_block: above.name, column_height: h };
}

/**
 * Run all dig-time hazard checks. Returns the FIRST hazard found, or null.
 */
export function detectDigHazards(b, x, y, z) {
  return checkLavaHazard(b, x, y, z) || checkFallHazard(b, x, y, z) || checkSuffocateHazard(b, x, y, z);
}

const FLUID_KINDS = {
  water: 'water', flowing_water: 'flowing_water',
  lava:  'lava',  flowing_lava:  'flowing_lava',
};
const FLUID_NEIGHBOR_OFFSETS = [
  [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
];

/**
 * Post-dig breach detection.
 *
 * Read the just-dug cell (and the 6 face neighbours) after a settle period
 * and report whether water/lava has flowed in. Used by `mc dig` (and
 * eventually dig_area/tunnel/collect) to interrupt the implicit "I just
 * created air" assumption and surface a hint to plug the cell.
 *
 * Why a settle: mineflayer's blockAt is current-tick-only. Flowing water
 * arrives at ~5 ticks/cell, lava much slower. ~300 ms catches direct
 * face-neighbour source flow without dragging dig throughput; callers
 * that don't care can pass settleMs:0.
 *
 * Return shape:
 *   null                                        — no breach
 *   { kind, breach_cell, source_cell?, wet_neighbors[], severity }
 *     kind ∈ 'water' | 'flowing_water' | 'lava' | 'flowing_lava'
 *     severity = 'critical' for lava, 'warn' for water
 *     source_cell is one of the 6 neighbours whose block is a SOURCE
 *     (non-flowing) variant — present when we can pinpoint the leak.
 *     Plugging the breach_cell stops the immediate flow into the dug
 *     cell; if source_cell is on a different face the agent may need to
 *     plug there too.
 *
 * @param {object} b mineflayer bot
 * @param {{x:number,y:number,z:number}} pos block coord that was just dug
 * @param {{ settleMs?: number, sleep?: (ms:number)=>Promise<void> }} [opts]
 */
export async function detectPostDigBreach(b, pos, { settleMs = 300, sleep = null } = {}) {
  if (settleMs > 0) {
    const _sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    await _sleep(settleMs);
  }
  const at = (x, y, z) => {
    try { return b.blockAt(new Vec3(x, y, z)); } catch { return null; }
  };
  const here = at(pos.x, pos.y, pos.z);
  // No breach unless the dug cell itself contains a fluid.
  if (!here || !FLUID_KINDS[here.name]) return null;

  // Find a face neighbour that's a source (non-flowing) variant of the
  // same fluid family — that's the leak. mineflayer reports flowing
  // vs source via the block name on 1.13+; older versions used metadata.
  const family = here.name.startsWith('lava') || here.name === 'flowing_lava' ? 'lava' : 'water';
  const sourceName = family === 'lava' ? 'lava' : 'water';
  const flowingName = family === 'lava' ? 'flowing_lava' : 'flowing_water';
  let source_cell = null;
  /** @type {{x:number,y:number,z:number,name:string}[]} */
  const wet_neighbors = [];
  for (const [dx, dy, dz] of FLUID_NEIGHBOR_OFFSETS) {
    const nb = at(pos.x + dx, pos.y + dy, pos.z + dz);
    if (!nb) continue;
    if (nb.name === sourceName || nb.name === flowingName) {
      wet_neighbors.push({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz, name: nb.name });
      if (!source_cell && nb.name === sourceName) {
        source_cell = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
      }
    }
  }
  return {
    kind: here.name,
    breach_cell: { x: pos.x, y: pos.y, z: pos.z },
    source_cell,
    wet_neighbors,
    severity: family === 'lava' ? 'critical' : 'warn',
  };
}

export function isSoftLandscapeBlock(block) {
  if (!block?.name) return false;
  const n = block.name;
  const exact = new Set([
    'grass_block', 'short_grass', 'tall_grass', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'sand', 'red_sand',
    'clay', 'gravel', 'mycelium', 'snow_layer', 'mud', 'moss_block', 'mushroom_stem', 'brown_mushroom_block', 'red_mushroom_block',
    'warped_nylium', 'crimson_nylium', 'warped_roots', 'crimson_roots', 'nether_sprouts',
    'mangrove_roots', 'soul_sand', 'soul_soil',
  ]);
  if (exact.has(n)) return true;
  if (
    /fern|^large_fern|^seagrass|^tall_seagrass|cave_vines|weeping_vines|twisting_vines|vine$|tall_water_seagrass|glow_lichen|small_dripleaf|big_dripleaf|sweet_berry_bush|bamboo|sugar_cane|kelp|cocoa|moss_carpet|spore_blossom|^pumpkin$|^attached_melon_stem|^attached_pumpkin_stem|^melon$|brown_mushroom$|^red_mushroom$|^cactus$|azalea|flowering_azalea|^torchflower$|hanging_roots/i.test(n)
  )
    return true;
  if (/flower|tulip|dandelion|poppy|orchid|allium|cornflower|lily|sunflower|daisy$/i.test(n)) return true;
  if (/_nylium$|_leaves$/.test(n) || /^(flowering_azalea_leaves|azalea_leaves)$/.test(n)) return true;
  return false;
}

export function blockNeedsAxeHarvest(blockName) {
  if (!blockName) return false;
  const n = blockName;
  if (/_log$|_wood$|hyphae$|stem$|bamboo_block$/i.test(n)) return true;
  if (/^stripped_/i.test(n) && /_log$|_wood$|hyphae$|stem$/i.test(n)) return true;
  if (/^crafting_table$|_planks$|bookshelf|jukebox|note_block|daylight_detector$/i.test(n)) return true;
  if (/^melon$|^pumpkin$/i.test(n)) return true;
  return false;
}

export function blockNeedsPickaxeHarvest(blockName) {
  if (!blockName) return false;
  const n = blockName;
  if (/ore$|_ore_|ancient_debris|deepslate|netherrack|obsidian|crying_obsidian|blackstone|basalt|end_stone|amethyst/i.test(n))
    return true;
  if (/(^|_)(stone|cobblestone|andesite|diorite|granite|tuff|calcite)$/i.test(n)) return true;
  if (/^deepslate_/i.test(n)) return true;
  if (/^packed_mud$|^dripstone_block$/i.test(n)) return true;
  return false;
}

// Shovel-preferred blocks. Bare hand drops these correctly, but shovel
// is ~5× faster. Task #34.1: real-player mining behavior needs the
// right tool for each layer of mixed terrain.
export function blockNeedsShovelHarvest(blockName) {
  if (!blockName) return false;
  return /^(sand|red_sand|gravel|dirt|grass_block|grass_path|dirt_path|podzol|coarse_dirt|rooted_dirt|mud|snow|snow_block|snow_layer|clay|mycelium|farmland|soul_sand|soul_soil)$/i.test(blockName);
}

export function isLeavesBlockName(nm) {
  return nm ? /(_leaves$|^azalea_leaves$|^flowering_azalea_leaves$)/.test(nm) : false;
}

/**
 * Blocks that the bot can usefully dig and re-place elsewhere — utility
 * fixtures like crafting tables and storage. Used by `mc place` to hint
 * that a TARGET_OCCUPIED block can be cleared via `mc dig` + re-placed.
 */
export const RELOCATABLE_INFRASTRUCTURE = new Set([
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest', 'barrel',
]);

/**
 * Best-guess of the tool tier needed to dig a block. Returns one of:
 *   'hand'                — soft blocks, plants, etc. (no tool required)
 *   'wooden_pickaxe'      — stone family
 *   'wooden_axe'          — logs / planks / wood
 *   'wooden_shovel'       — sand / dirt / gravel (drop-without-tool is fine but
 *                            shovel is faster)
 *   'iron_pickaxe'        — diamond, emerald, gold ores (requires iron tier)
 *   'diamond_pickaxe'     — obsidian, ancient_debris
 *   'shears'              — wool, leaves (for drops)
 * Coarse — not a full tier table, just enough for a hint.
 */
export function suggestedToolForBlock(blockName) {
  if (!blockName) return 'hand';
  if (blockNeedsAxeHarvest(blockName)) return 'wooden_axe';
  if (/obsidian|crying_obsidian|ancient_debris/i.test(blockName)) return 'diamond_pickaxe';
  if (/(diamond|emerald|gold)_ore|deepslate_(diamond|emerald|gold)_ore/i.test(blockName)) return 'iron_pickaxe';
  if (/(iron|lapis|redstone|copper)_ore|deepslate_(iron|lapis|redstone|copper)_ore/i.test(blockName)) return 'stone_pickaxe';
  if (blockNeedsPickaxeHarvest(blockName)) return 'wooden_pickaxe';
  if (/^(sand|red_sand|gravel|dirt|grass_block|podzol|coarse_dirt|rooted_dirt|mud|snow|snow_block|clay)$/i.test(blockName)) return 'wooden_shovel';
  if (/^(wool|cobweb)$|_wool$|_leaves$/i.test(blockName)) return 'shears';
  return 'hand';
}

export function firstInvItemByPriority(b, names) {
  const items = b.inventory.items();
  for (const nm of names) {
    const it = items.find((i) => i.name === nm);
    if (it) return it;
  }
  return null;
}

export function holdsAwfulBlockForWoodHarvest(itemName) {
  if (!itemName || itemName === 'air') return false;
  if (/_axe$/.test(itemName)) return false;
  if (itemName.includes('pickaxe')) return false;
  if (/sword$/.test(itemName)) return false;
  return /^(cobblestone|stone|andesite|diorite|granite|deepslate|tuff|calcite|blackstone|basalt|netherrack|end_stone|dirt|grass_block|podzol|coarse_dirt|rooted_dirt|mud|sand|red_sand|gravel|clay|.*_planks|glass$|.*_terracotta|.*_concrete|.*_wool|brick[s]?|snow_block|ice|packed_ice|blue_ice)$/i.test(
    itemName,
  );
}

export function effectiveHeldForDig(b) {
  try {
    const slotHeld = /** @type {any} */ (b).heldItem;
    const toolHeld = typeof b.tool?.itemInHand === 'function' ? b.tool.itemInHand() : null;
    if (slotHeld?.name) return slotHeld;
    if (toolHeld?.name) return toolHeld;
    return slotHeld ?? toolHeld ?? null;
  } catch {
    try {
      return /** @type {any} */ (b).heldItem ?? null;
    } catch {
      return null;
    }
  }
}

export function trustDigEstimateForHeld(held, blockName) {
  if (!held?.name || !blockName) return false;
  const h = held.name;
  const n = blockName;
  if (h.includes('pickaxe')) {
    if (n === 'obsidian' || n === 'crying_obsidian')
      return h.includes('diamond') || h.includes('netherite');
    if (n === 'ancient_debris') return h.includes('diamond') || h.includes('netherite');
    if (/ore$/i.test(n) || /_ore_/i.test(n)) return true;
    if (/(stone|cobblestone|granite|andesite|diorite|deepslate|tuff|calcite|dripstone_block|basalt|blackstone|netherrack|end_stone)/i.test(n))
      return true;
  }
  if (/_axe$/.test(h)) {
    if (/_log$|_wood$|hyphae$|stem$/i.test(n) || n === 'bamboo_block' || /^stripped_/i.test(n)) return true;
    if (n === 'crafting_table' || /_planks$/.test(n)) return true;
  }
  return false;
}

export async function preferPracticalDigHand(b, block) {
  if (!isSoftLandscapeBlock(block)) return;
  const hand = b.tool.itemInHand();
  if (!hand) return;
  const n = hand.name;
  if (/shovel|shears|hoe/.test(n)) return;
  if (/pickaxe|axe$|sword|trident|bow|crossbow|bucket|flint_and_steel|compass|spyglass|goat_horn/.test(n)) return;
  const shovel = b.inventory.items().find((i) => i.name.includes('shovel'));
  if (shovel) {
    try { await b.equip(shovel, 'hand'); } catch {}
    return;
  }
  try { await b.unequip('hand'); } catch {}
}

export async function preferHarvestToolForBlock(b, block) {
  if (!block?.name || typeof b.tool?.itemInHand !== 'function') return;
  const nm = block.name;
  const hand = b.tool.itemInHand();
  const hn = hand?.name || '';

  if (blockNeedsAxeHarvest(nm)) {
    if (/_axe$/.test(hn)) return;
    const axe = firstInvItemByPriority(b, HARVEST_AXE_PRIORITY);
    if (axe) {
      try { await b.equip(axe, 'hand'); } catch {}
      return;
    }
    // No axe available — unequip anything that isn't bare hand or a sword
    // (food, blocks, pickaxes, misc items all slow down wood mining)
    if (hn && hn !== 'air' && !/sword$/.test(hn)) {
      try {
        await b.unequip('hand');
      } catch {
        try {
          const qbStart = b.QUICK_BAR_START ?? 36;
          for (let s = 0; s < 9; s++) {
            if (!b.inventory.slots[qbStart + s]) {
              b.setQuickBarSlot(s);
              break;
            }
          }
        } catch {}
      }
    }
    return;
  }

  if (blockNeedsPickaxeHarvest(nm)) {
    if (/pickaxe$/.test(hn)) return;
    const pick = firstInvItemByPriority(b, HARVEST_PICK_PRIORITY);
    if (pick) {
      try { await b.equip(pick, 'hand'); } catch {}
      return;
    }
    try { await b.unequip('hand'); } catch {}
    return;
  }

  // Task #34.1: shovel for dirt/sand/gravel/etc. Bare hand works, but
  // shovel is ~5× faster. circuit-v7 W1 mining used iron_pickaxe on
  // dirt — ~5 min for what a real player does in ~30s.
  if (blockNeedsShovelHarvest(nm)) {
    if (/shovel$/.test(hn)) return;
    const shovel = firstInvItemByPriority(b, HARVEST_SHOVEL_PRIORITY);
    if (shovel) {
      try { await b.equip(shovel, 'hand'); } catch {}
      return;
    }
    // No shovel — bare hand is the right fallback (faster than pickaxe
    // on dirt). Unequip whatever the bot's holding to avoid mining
    // dirt with a pickaxe's slower hand-down.
    if (hn && hn !== 'air' && !/sword$/.test(hn) && !/shovel$/.test(hn)) {
      try { await b.unequip('hand'); } catch {}
    }
  }
}

async function preferShearsForLeaves(b, block) {
  if (!block?.name || !isLeavesBlockName(block.name)) return;
  const shears = b.inventory.items().find((i) => i.name === 'shears');
  if (!shears) return;
  try { await b.equip(shears, 'hand'); } catch {}
}

export function guardSlowDigEstimate(b, block) {
  const t = b.tool;
  if (!block?.name || typeof t?.getDigTime !== 'function' || typeof t.itemInHand !== 'function') return;
  const { behaviors } = getConfig();
  if (behaviors.allowSlowDig) return;
  if (isSoftLandscapeBlock(block)) return;

  const maxTicks = behaviors.slowDigTicksMax;

  const held = effectiveHeldForDig(b);
  const hn = held?.name ?? '';

  if (blockNeedsAxeHarvest(block.name) && hn.includes('pickaxe')) {
    const axe = firstInvItemByPriority(b, HARVEST_AXE_PRIORITY);
    if (axe) {
      throw new Error(`Wrong tool for ${block.name}: use an axe, not a pickaxe. Run: mc equip ${axe.name}`);
    }
    return;
  }
  if (blockNeedsPickaxeHarvest(block.name) && held?.name && /(^|_)axe$/.test(held.name)) {
    const pick = firstInvItemByPriority(b, HARVEST_PICK_PRIORITY);
    throw new Error(
      pick
        ? `Wrong tool for ${block.name}: use a pickaxe, not an axe. Run: mc equip ${pick.name}`
        : `Wrong tool for ${block.name}: need a pickaxe for stone/ore (e.g. mc craft wooden_pickaxe).`,
    );
  }
  if (blockNeedsAxeHarvest(block.name) && hn && holdsAwfulBlockForWoodHarvest(hn)) {
    throw new Error(
      `Wrong hand for ${block.name}: "${hn}" in main hand breaks wood extremely slowly. Run \`mc equip wooden_axe\` (or another axe), or \`mc unequip\` for bare hands — never chop logs while holding cobblestone/stone/planks/etc.`,
    );
  }

  const axeInv = firstInvItemByPriority(b, HARVEST_AXE_PRIORITY);
  if (blockNeedsAxeHarvest(block.name) && !axeInv && (!hn || hn === 'air' || hn.includes('pickaxe') || /sword$/.test(hn))) return;

  if (trustDigEstimateForHeld(held, block.name)) return;

  const ticks = t.getDigTime(block, held);
  if (Number.isFinite(ticks) && ticks < maxTicks) return;

  const secs = Number.isFinite(ticks) ? Math.round((ticks / 20) * 10) / 10 : '∞';
  const nm = block.name;
  const heldLabel = hn || 'empty hand';
  const woodHarvest = blockNeedsAxeHarvest(nm);
  const pickHint =
    /ore$|_ore|deepslate|netherrack|obsidian|blackstone$/i.test(nm) ||
    /(^|_)(stone|cobblestone|andesite|diorite|granite|tuff)$/i.test(nm);
  const hint = woodHarvest
    ? 'Use an axe for wood (`mc craft wooden_axe` then `mc equip wooden_axe`). Bare fist is OK; pickaxes and blocks (cobblestone, planks, …) in main hand are wrong for logs.'
    : pickHint
    ? 'Equip a pickaxe (`mc equip stone_pickaxe` etc.). Or set MC_ALLOW_SLOW_DIG=true to force through.'
    : 'Equip a fitting tool (`mc equip …`), or MC_ALLOW_SLOW_DIG=true.';
  throw new Error(`Refusing to dig ${nm} with "${heldLabel}" (~${secs}s break time ≥ ${maxTicks} ticks). ${hint}`);
}

/**
 * Best available tool for mining + advisory hints.
 * @param {object} b - mineflayer Bot
 * @param {object} block
 * @param {{ force?: boolean }} [opts] If `force` is true, skips the slow-dig
 *   guard so callers (e.g. pillar_step --force when stuck) can bare-hand
 *   slow-dig stone without throwing. Caller is responsible for tolerating
 *   the resulting long b.dig wait.
 */
export async function equipForDig(b, block, opts = {}) {
  /** @type {string[]} */
  const hints = [];
  if (!block?.name) return { hints };

  const nm = block.name;
  const isAxe = blockNeedsAxeHarvest(nm);
  const isPick = blockNeedsPickaxeHarvest(nm);

  await preferHarvestToolForBlock(b, block);

  let hn = b.tool.itemInHand()?.name || '';
  if (isAxe && !/axe$/.test(hn)) {
    hints.push(
      'No axe in inventory — using empty hand on wood (works but slower). For speed: `mc craft wooden_axe` then `mc equip wooden_axe`.',
    );
  }
  if (isPick && !/pickaxe$/.test(hn) && !firstInvItemByPriority(b, HARVEST_PICK_PRIORITY)) {
    hints.push(
      'No pickaxe — empty hand is poor for stone/ore (server may refuse slow digs). `mc craft wooden_pickaxe` then `mc equip wooden_pickaxe`.',
    );
  }

  if (!isAxe && !isPick) {
    if (isLeavesBlockName(nm)) await preferShearsForLeaves(b, block);
    await b.tool.equipForBlock(block);
    if (isLeavesBlockName(nm)) {
      await preferShearsForLeaves(b, block);
      hn = b.tool.itemInHand()?.name || '';
      const haveShears = b.inventory.items().some((i) => i.name === 'shears');
      if (hn !== 'shears' && !haveShears) {
        hints.push(
          'No shears in inventory — leaves break slower and may not drop; use 2 iron: `mc craft shears` then `mc equip shears`.',
        );
      }
    }
  }

  await preferPracticalDigHand(b, block);
  if (!opts.force) guardSlowDigEstimate(b, block);
  return { hints };
}

export function columnTopSolid(b, ix, iz) {
  const lo = typeof b.game?.minY === 'number' ? b.game.minY : -64;
  const hi =
    typeof b.game?.height === 'number' && typeof b.game?.minY === 'number'
      ? b.game.minY + b.game.height - 1
      : 319;
  for (let y = hi; y >= lo; y--) {
    const block = b.blockAt(new Vec3(ix, y, iz));
    if (!block) continue;
    if (DIG_PASSABLE_NAMES.has(block.name)) continue;
    if (DIG_FLUID_NAMES.has(block.name)) continue;
    return { topY: y, blockName: block.name };
  }
  return null;
}

/**
 * Try to step off (sx, y, sz) before mining the stand block.
 * @param {import('mineflayer-pathfinder').goals} goals - pathfinder goals namespace
 */
export async function nudgeOffStandPillar(b, sx, y, sz, goals) {
  const offsets = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [2, 0], [-2, 0], [0, 2], [0, -2],
  ];
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
  for (const [ox, oz] of offsets) {
    const gx = sx + ox;
    const gy = y - 1;
    const gz = sz + oz;
    try {
      await Promise.race([
        b.pathfinder.goto(new goals.GoalNear(gx, gy, gz, 2)),
        timeout,
      ]);
      return true;
    } catch {
      try { b.pathfinder.setGoal(null); } catch {}
    }
  }
  return false;
}
