/**
 * Shared block/entity name sets for action handlers.
 * Phase 1 refactor — consumers adopt in Phase 5 dedupe pass.
 */

export const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

export const WATER_NAMES = new Set(['water', 'flowing_water']);

export const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air',
  'water', 'lava', 'bubble_column',
  'tall_grass', 'short_grass', 'grass', 'fern', 'large_fern',
  'vine', 'snow', 'snow_layer', 'fire', 'soul_fire',
  'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass',
  'dead_bush',
]);

export const PILLAR_BLOCKS = [
  'dirt', 'cobblestone', 'stone', 'netherrack', 'sand', 'gravel',
  'oak_planks', 'spruce_planks', 'birch_planks', 'deepslate',
];

/** Blocks place() accepts by name pattern (building.place). */
export const PLACEABLE_RE = /^[a-z0-9_]+$/;

export const BOAT_ITEM_NAMES = new Set([
  'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
  'acacia_boat', 'dark_oak_boat', 'cherry_boat', 'mangrove_boat',
  'bamboo_raft', 'pale_oak_boat',
]);

/** @deprecated use BOAT_ITEM_NAMES — alias for migration */
export const BOAT_NAMES = BOAT_ITEM_NAMES;

export const BOAT_ENTITY_RE = /(_boat$|^boat$|^bamboo_raft$)/;

export const FISH_ROD_NAMES = ['fishing_rod'];

export const FISH_LOOT = [
  'cod', 'salmon', 'pufferfish', 'tropical_fish',
  'bowl', 'leather', 'leather_boots', 'rotten_flesh', 'stick',
  'string', 'water_bottle', 'bone', 'ink_sac', 'tripwire_hook',
  'enchanted_book', 'name_tag', 'nautilus_shell', 'saddle',
  'fishing_rod', 'bow', 'lily_pad',
];

export function isAirBlock(blk) {
  return blk && AIR_NAMES.has(blk.name);
}

export function isWaterBlock(blk) {
  return blk && WATER_NAMES.has(blk.name);
}

export function isReplaceableBlock(blk) {
  return !blk || REPLACEABLE.has(blk.name);
}

export function isBoatEntity(e) {
  if (!e) return false;
  const n = e.name || '';
  const t = e.type || '';
  if (n.endsWith('_boat') || n === 'boat' || n === 'bamboo_raft') return true;
  if (t.endsWith('_boat') || t === 'boat' || t === 'bamboo_raft') return true;
  if (BOAT_ITEM_NAMES.has(n) || BOAT_ITEM_NAMES.has(t)) return true;
  return false;
}
