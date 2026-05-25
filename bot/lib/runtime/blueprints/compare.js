/**
 * Compare planned block ids (incl. GrabCraft legacy suffixes) to Mineflayer block.name.
 */

const STRIP_SUFFIX_RE =
  /(_facing_[a-z0-9_]+|_hinge_[a-z0-9_]+|_unpowered(_[a-z0-9_]+)?|_powered(_[a-z0-9_]+)?|_upper|_lower|_head_of_the_bed|_foot_of_the_bed|_normal|_unactive|_active)$/gi;

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

export function isAirBlockName(name) {
  return AIR_NAMES.has(String(name || '').toLowerCase());
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
