/**
 * Compare planned block ids (incl. GrabCraft legacy suffixes) to Mineflayer block.name.
 */

const STRIP_SUFFIX_RE =
  /(_facing_[a-z0-9_]+|_hinge_[a-z0-9_]+|_unpowered(_[a-z0-9_]+)?|_powered(_[a-z0-9_]+)?|_upper|_lower|_head_of_the_bed|_foot_of_the_bed|_normal|_unactive|_active)$/gi;

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

export function isAirBlockName(name) {
  return AIR_NAMES.has(String(name || '').toLowerCase());
}

// Base furniture / utility fixtures — INTENDED interior contents, not structural
// blocks. When a phase slice expects air but one of these is present (e.g. a
// chest/furnace inside the shell), the construct-end phase-clean gate must NOT
// count it as a removable "extra": it is base furniture, usually PROTECTED from
// digging (gv2-2026-06-25-3: walls physically complete but construct end blocked
// on extra=3 = depot chest + furnace + storage chest the builder couldn't dig).
// Structural materials (planks/stairs/slabs/doors/glass) are deliberately NOT here
// — a stray one is scaffolding/junk that should still fail the gate.
const FIXTURE_NAMES = new Set([
  'chest', 'trapped_chest', 'ender_chest',
  'furnace', 'blast_furnace', 'smoker',
  'barrel', 'crafting_table', 'cartography_table', 'smithing_table',
  'fletching_table', 'loom', 'stonecutter', 'grindstone', 'lectern',
  'brewing_stand', 'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil',
  'bell', 'campfire', 'soul_campfire', 'bookshelf', 'jukebox', 'note_block',
  'composter', 'cauldron', 'beehive', 'bee_nest',
]);

export function isFixtureBlockName(name) {
  const n = normalizeBlockId(name);
  if (FIXTURE_NAMES.has(n)) return true;
  if (/_bed$/.test(n) || n === 'bed') return true;
  return false;
}

export function normalizeBlockId(raw) {
  let s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
  s = s.replace(/[^a-z0-9_]/g, '');
  let prev;
  do {
    prev = s;
    s = s.replace(STRIP_SUFFIX_RE, '');
  } while (s !== prev);
  return s || 'unknown';
}

/** @returns {{ match: boolean, planBase: string, worldBase: string, compare_note?: string }} */
export function compareBlocks(planBlockId, worldBlockName) {
  const planBase = normalizeBlockId(planBlockId);
  const worldBase = normalizeBlockId(worldBlockName);
  if (planBase === worldBase) {
    return { match: true, planBase, worldBase };
  }
  if (isAirBlockName(worldBlockName) && planBase === 'air') {
    return { match: true, planBase, worldBase };
  }
  return {
    match: false,
    planBase,
    worldBase,
    compare_note: planBase !== normalizeBlockId(planBlockId) || worldBase !== normalizeBlockId(worldBlockName)
      ? 'state_not_verified_v1'
      : undefined,
  };
}
