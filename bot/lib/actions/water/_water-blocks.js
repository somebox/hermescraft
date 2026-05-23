/** Shared boat predicates (Phase 4a split from water.js) */
export const BOAT_NAMES = new Set([
  'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
  'acacia_boat', 'dark_oak_boat', 'cherry_boat', 'mangrove_boat',
  'bamboo_raft', 'pale_oak_boat',
]);

// Boat entity detector. Paper 1.21+ sometimes delivers boat entities with
// e.name=null but e.type='oak_boat' (vs. the mob-style entities where
// e.name is populated). Checking both fields covers both flavours;
// circuit-v5 (2026-05-21) hit this exact case — server confirmed a boat
// summon but our entity-name-only filter dropped it, so place_boat
// reported PLACE_FAILED even though the boat was visible 1.7 blocks away.
export function isBoatEntity(e) {
  if (!e) return false;
  const n = e.name || '';
  const t = e.type || '';
  if (n.endsWith('_boat') || n === 'boat' || n === 'bamboo_raft') return true;
  if (t.endsWith('_boat') || t === 'boat' || t === 'bamboo_raft') return true;
  if (BOAT_NAMES.has(n) || BOAT_NAMES.has(t)) return true;
  return false;
}
