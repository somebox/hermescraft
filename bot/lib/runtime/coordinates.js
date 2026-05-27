/**
 * Coordinate vocabulary helpers — block_y / surface_y.
 *
 * Convention: see docs/conventions/coordinates.md.
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
