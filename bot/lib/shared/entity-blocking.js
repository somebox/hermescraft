/**
 * Entities that share a block cell but do not prevent placement on the server.
 * Used by mc place pre-flight, mc inspect occupancy, combat target pick, and
 * observation feeds so agents are not told a cell is "occupied" by a drop.
 */

export const NON_BLOCKING_ENTITY_NAMES = new Set([
  'item', 'experience_orb', 'xp_orb', 'arrow', 'spectral_arrow', 'trident',
  'snowball', 'egg', 'ender_pearl', 'eye_of_ender', 'fishing_bobber',
  'firework_rocket', 'small_fireball', 'fireball', 'llama_spit',
  'shulker_bullet', 'thrown_potion', 'area_effect_cloud',
  'painting', 'item_frame', 'glow_item_frame', 'leash_knot',
]);

/**
 * @param {{ name?: string|null }|null|undefined} entity
 */
export function isNonBlockingEntity(entity) {
  if (!entity) return false;
  const name = String(entity.name || '').toLowerCase();
  return name.length > 0 && NON_BLOCKING_ENTITY_NAMES.has(name);
}

/**
 * @param {{ position?: { x: number, y: number, z: number } }} entity
 * @param {number} ix floor cell x
 * @param {number} iy floor cell y
 * @param {number} iz floor cell z
 */
export function entityOccupiesCell(entity, ix, iy, iz) {
  if (!entity?.position) return false;
  const ex = Math.floor(entity.position.x);
  const ey = Math.floor(entity.position.y);
  const ez = Math.floor(entity.position.z);
  if (ex !== ix || ez !== iz) return false;
  return ey === iy || ey + 1 === iy;
}

/**
 * Entities in a cell that would block placement (players, mobs, boats, etc.).
 *
 * @param {Record<string, any>|null|undefined} entitiesMap mineflayer b.entities
 * @param {number} ix
 * @param {number} iy
 * @param {number} iz
 * @param {{ exclude?: any }} [opts] bot entity to skip
 * @returns {any[]}
 */
export function entitiesAtBlockingCell(entitiesMap, ix, iy, iz, opts = {}) {
  const exclude = opts.exclude;
  const out = [];
  for (const e of Object.values(entitiesMap || {})) {
    if (!e?.position) continue;
    if (exclude && e === exclude) continue;
    if (isNonBlockingEntity(e)) continue;
    if (!entityOccupiesCell(e, ix, iy, iz)) continue;
    out.push(e);
  }
  return out;
}

/**
 * @param {any[]} entities
 * @returns {any[]}
 */
export function filterPlacementBlockingEntities(entities) {
  return (entities || []).filter((e) => e && !isNonBlockingEntity(e));
}
