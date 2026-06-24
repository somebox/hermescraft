/**
 * Coordinate vocabulary helpers — block_y / surface_y.
 *
 * Convention: see docs/reference/world-coordinates.md.
 *   block_y   = Y of a solid block (block occupies [block_y, block_y+1])
 *   surface_y = Y where a bot stands on top of that block (= block_y + 1)
 *
 * All Y-using primitives in bot/lib/actions/ should import these helpers
 * instead of computing +/-1 inline. Inputs accept either `y` (=block_y,
 * legacy) or `surface_y`; outputs include both.
 */

/**
 * Convert a block Y to the surface Y a bot would stand on.
 * @param {number} blockY
 * @returns {number}
 */
export function surfaceFromBlock(blockY) {
  return Math.floor(Number(blockY)) + 1;
}

/**
 * Convert a surface Y (where the bot stands) to the block Y supporting it.
 * @param {number} surfaceY
 * @returns {number}
 */
export function blockFromSurface(surfaceY) {
  return Math.floor(Number(surfaceY)) - 1;
}

/**
 * Annotate an object with both block_y and surface_y for a given block_y.
 * Existing fields on `obj` are preserved; pre-existing block_y/surface_y
 * are overwritten with the canonical pair.
 *
 * @template T
 * @param {T} obj
 * @param {number} blockY
 * @returns {T & { block_y: number, surface_y: number }}
 */
export function withYBoth(obj, blockY) {
  const by = Math.floor(Number(blockY));
  return { ...(obj || {}), block_y: by, surface_y: by + 1 };
}

/**
 * Parse Y input from a handler arg object that may carry `y`, `surface_y`,
 * or both. When both are present, `surface_y` wins (the more recent name).
 * When only `y` is present, it is interpreted as `block_y` (legacy).
 *
 * Returns the canonical block_y as a finite integer, or null when neither
 * was supplied and a default is acceptable. Callers that require a Y should
 * throw on null themselves with a primitive-specific error code.
 *
 * @param {{ y?: number|string, surface_y?: number|string } | null | undefined} args
 * @returns {number | null}
 */
export function parseYInput(args) {
  if (!args || typeof args !== 'object') return null;
  const sy = args.surface_y;
  if (sy !== undefined && sy !== null && Number.isFinite(Number(sy))) {
    return Math.floor(Number(sy)) - 1;
  }
  const by = args.y;
  if (by !== undefined && by !== null && Number.isFinite(Number(by))) {
    return Math.floor(Number(by));
  }
  return null;
}

/**
 * Normalize box args that may carry surface_y1/surface_y2 aliases.
 * surface_y1/surface_y2 win over y1/y2 when present and finite.
 *
 * @param {{ y1?: number|string, y2?: number|string, surface_y1?: number|string, surface_y2?: number|string } | null | undefined} args
 * @returns {typeof args}
 */
export function normalizeBoxYArgs(args) {
  if (args == null || typeof args !== 'object') return args;
  const out = { ...args };
  if (out.surface_y1 != null && Number.isFinite(Number(out.surface_y1))) {
    out.y1 = blockFromSurface(Number(out.surface_y1));
  }
  if (out.surface_y2 != null && Number.isFinite(Number(out.surface_y2))) {
    out.y2 = blockFromSurface(Number(out.surface_y2));
  }
  return out;
}

/**
 * Inclusive axis-aligned box from order-independent corners (block coords).
 * @param {{ x1: number, y1: number, z1: number, x2: number, y2: number, z2: number }} box
 * @returns {{ min: { x: number, y: number, z: number }, max: { x: number, y: number, z: number }, volume: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number }}
 */
export function normalizeInclusiveBox6(box) {
  const x1 = Math.floor(Number(box.x1));
  const y1 = Math.floor(Number(box.y1));
  const z1 = Math.floor(Number(box.z1));
  const x2 = Math.floor(Number(box.x2));
  const y2 = Math.floor(Number(box.y2));
  const z2 = Math.floor(Number(box.z2));
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const minZ = Math.min(z1, z2);
  const maxZ = Math.max(z1, z2);
  const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    volume,
    x1: minX,
    y1: minY,
    z1: minZ,
    x2: maxX,
    y2: maxY,
    z2: maxZ,
  };
}

/**
 * @param {number[] | { x?: number, y?: number, z?: number } | null | undefined} anchor
 * @returns {{ x: number, y: number, z: number } | null}
 */
export function toBlockPos(anchor) {
  if (anchor == null) return null;
  if (Array.isArray(anchor)) {
    if (anchor.length < 3) return null;
    const x = Number(anchor[0]);
    const y = Number(anchor[1]);
    const z = Number(anchor[2]);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  }
  if (typeof anchor === 'object') {
    const x = Number(anchor.x);
    const y = Number(anchor.y);
    const z = Number(anchor.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  }
  return null;
}
