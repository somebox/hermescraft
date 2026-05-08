/**
 * Tool selection, guard logic, and dig utilities for mining actions.
 * All functions are stateless — they operate on the bot instance passed in.
 */
import { Vec3 } from 'vec3';

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

export const PROTECTED_DIG_BLOCKS = new Set([
  'oak_planks', 'birch_planks', 'spruce_planks', 'dark_oak_planks', 'jungle_planks', 'acacia_planks',
  'glass', 'glass_pane', 'white_stained_glass', 'white_stained_glass_pane',
  'oak_door', 'birch_door', 'spruce_door', 'dark_oak_door', 'iron_door',
  'oak_fence', 'birch_fence', 'spruce_fence', 'dark_oak_fence',
  'oak_fence_gate', 'birch_fence_gate', 'spruce_fence_gate',
  'oak_stairs', 'birch_stairs', 'spruce_stairs', 'cobblestone_stairs', 'stone_stairs',
  'oak_slab', 'birch_slab', 'spruce_slab', 'cobblestone_slab', 'stone_slab',
  'stone_bricks', 'bricks', 'smooth_stone',
  'crafting_table', 'furnace', 'chest', 'barrel', 'bookshelf',
  'torch', 'wall_torch', 'lantern', 'ladder',
  'bed', 'white_bed', 'red_bed',
]);

export const DIG_PASSABLE_NAMES = new Set(['air', 'cave_air', 'void_air']);
export const DIG_FLUID_NAMES = new Set(['water', 'lava']);

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

export function isLeavesBlockName(nm) {
  return nm ? /(_leaves$|^azalea_leaves$|^flowering_azalea_leaves$)/.test(nm) : false;
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
  if (process.env.MC_ALLOW_SLOW_DIG === 'true') return;
  if (isSoftLandscapeBlock(block)) return;

  let maxTicks = Number(process.env.MC_SLOW_DIG_TICKS_MAX);
  if (!Number.isFinite(maxTicks) || maxTicks < 40) maxTicks = 280;

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
 */
export async function equipForDig(b, block) {
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
  guardSlowDigEstimate(b, block);
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
