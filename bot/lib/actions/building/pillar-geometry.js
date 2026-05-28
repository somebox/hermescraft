/**
 * Pure Y-math primitives for pillar_step / pillar_down.
 *
 * The full pillar handlers are mineflayer-heavy (jump physics, placeBlock,
 * controlState, ground polling) — covered by functional tests against a
 * real body. These primitives extract the COORDINATE arithmetic so it's
 * testable in isolation. If a bug surfaces in the "off-by-one Y" family,
 * the failure is more likely to be in this geometry layer than in the
 * physics layer; unit-testing it cheaply catches a real class of bugs.
 *
 * Background: genesis run g-2026-05-27-10 reported pillar_up/pillar_down
 * "off-by-one Y" symptoms. The slab case (bot standing on a half-block
 * with bot.position.y at the slab's top face = cell.y + 0.5) is the
 * primary suspect — the floor-rounding semantics of feetY differ from
 * the actual physical Y delta after a place + jump.
 *
 * ─ Y CONVENTION (read this before changing anything in this module) ────
 *
 * `bot.entity.position.y` is the bot's FOOT Y (continuous fractional).
 * For a bot standing on top of a block at cell.y=63:
 *   - foot Y = 64.0 (or 64.0001 due to physics noise — usually exactly 64)
 *   - `feetCellY(foot)` returns 64 — the cell the bot OCCUPIES
 *   - `blockUnderFeetCellY(foot)` returns 63 — the block the bot STANDS ON
 *
 * On a slab top (slab fills bottom half of cell.y=64; top face at y=64.5):
 *   - foot Y = 64.5
 *   - `feetCellY(foot)` returns 64 — the slab's cell
 *   - `blockUnderFeetCellY(foot)` returns 64 — same cell (the slab itself)
 *
 * Two helpers, named, used consistently. The `±0.001` epsilon handles the
 * exact-integer-Y edge case (foot Y = 64.0 → -0.001 → 63.999 → floor 63;
 * +0.001 → 64.001 → floor 64). Diverging conventions caused subtle bugs
 * across pillar.js / excavation.js / _nav-helpers.js — using these named
 * helpers eliminates the choice at every call site.
 */

import { Vec3 } from 'vec3';

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/**
 * The Y of the cell the bot OCCUPIES — its foot cell. Use this when you
 * need the index of the cell the bot is currently INSIDE (e.g., to find
 * the headroom cell at feetCellY+1, or the air-foot-cell predicate for
 * `reachedSurface`).
 *
 * For integer foot Y (standing on a full block top), returns floor(y).
 * For slab top (foot Y = 64.5), returns 64 (the slab's cell).
 *
 * @param {{y: number}} footPos
 * @returns {number}
 */
export function feetCellY(footPos) {
  return Math.floor(footPos.y + 0.001);
}

/**
 * The Y of the block the bot STANDS ON — typically feetCellY - 1 (the
 * block below the foot cell), but for partial-block stands (slab, stairs)
 * it equals feetCellY because the bot IS on the slab cell.
 *
 * Use this when you need the index of the block whose top face the bot is
 * resting on (e.g., the placement reference for pillar_step, or the dig
 * target for pillar_down's "block under feet").
 *
 * For integer foot Y (standing on full block top), returns floor(y - 0.001) = floor(y) - 1.
 * For slab top (foot Y = 64.5), returns 64 (the slab itself).
 *
 * @param {{y: number}} footPos
 * @returns {number}
 */
export function blockUnderFeetCellY(footPos) {
  return Math.floor(footPos.y - 0.001);
}

/**
 * Y-walk-down to find the block the bot is currently standing on.
 *
 * Walks from `blockUnderFeetCellY(footPos)` downward up to `maxDown` cells,
 * returning the first block whose boundingBox === 'block'. The starting Y
 * is the "block under feet" convention (see module docstring).
 *
 * Returns null if no block within range. The caller can fall back to
 * lateral references or fail.
 *
 * @param {{x: number, y: number, z: number}} footPos  bot.entity.position
 * @param {(pos: import('vec3').Vec3) => { boundingBox?: string, position?: {x:number,y:number,z:number} } | null} blockAt
 * @param {number} [maxDown=1]  How many cells below the start Y to also probe.
 *   Default 1 covers the standard "feet on full block" + "feet on slab top"
 *   shapes without diving into shaft geometry.
 */
export function findStandingBlockCell(footPos, blockAt, maxDown = 1) {
  const ix = Math.floor(footPos.x);
  const iz = Math.floor(footPos.z);
  const startY = blockUnderFeetCellY(footPos);
  for (let dy = 0; dy <= maxDown; dy++) {
    const y = startY - dy;
    const blk = blockAt(new Vec3(ix, y, iz));
    if (blk && blk.boundingBox === 'block') return blk;
  }
  return null;
}

/**
 * The cell where the next pillar_step block goes: one Y above the standing
 * block. Returns `{ x, y, z }` (NOT a Vec3 — callers wrap if needed).
 *
 * @param {{position: {x:number,y:number,z:number}}} standingBlock
 */
export function computePillarTargetCell(standingBlock) {
  return {
    x: standingBlock.position.x,
    y: standingBlock.position.y + 1,
    z: standingBlock.position.z,
  };
}

/**
 * The expected bot foot Y AFTER a pillar_step landed on a freshly-placed
 * block. The new block fills cell `targetY`, and the bot stands on its
 * top face → foot Y = targetY + 1.
 *
 * @param {{y: number}} targetCell
 */
export function expectedFootYAfterPillarStep(targetCell) {
  return targetCell.y + 1;
}

/**
 * pillar_down: the cell the bot should dig next, directly under the foot
 * block (foot block = floor(y); dig cell = floor(y) - 1).
 *
 * @param {{x:number,y:number,z:number}} footPos
 */
export function nextPillarDownCell(footPos) {
  return {
    x: Math.floor(footPos.x),
    y: Math.floor(footPos.y) - 1,
    z: Math.floor(footPos.z),
  };
}

/**
 * True when a block's NAME indicates a partial-height shape (slab, stairs,
 * carpet, snow layer, etc.) — anything whose top face is NOT at the cell's
 * full +1.0 Y boundary. Pillar_step from such a block produces an
 * off-by-one in floor-Y reporting: bot foot is at slab.y + 0.5 (or similar
 * fraction); after one jump-and-place the foot lands at place.y + 1.0;
 * the floor-Y delta is 2 for placed=1.
 *
 * Used by pillar_step's pre-flight guard to refuse starts that would
 * misreport. Force flag lets power-users override.
 *
 * Conservative list — only includes shapes we're confident about. Adding
 * a name here is one-line; removing requires verifying the floor-Y math
 * works out.
 */
const PARTIAL_BLOCK_RE = /(^|_)(slab|stairs|carpet|snow_layer|trapdoor|fence_gate)$/i;

export function isPartialBlockShape(blockName) {
  if (!blockName) return false;
  return PARTIAL_BLOCK_RE.test(blockName);
}

/**
 * pillar_down's "reached surface" predicate. After a dig, if 3+ of the 4
 * cardinal neighbours at the bot's new foot level have a solid floor AND
 * the foot cell itself is air, the bot has landed on real ground.
 *
 * Caveat: this reads `footPos.y` AS-IS. If the bot is mid-fall (foot Y
 * between two blocks), `Math.floor` gives the wrong layer. Callers must
 * sleep long enough for the fall to settle before calling.
 *
 * @param {{x:number,y:number,z:number}} footPos
 * @param {(pos: import('vec3').Vec3) => { boundingBox?: string, name?: string } | null} blockAt
 */
export function reachedSurface(footPos, blockAt) {
  const fx = Math.floor(footPos.x);
  const fy = Math.floor(footPos.y);
  const fz = Math.floor(footPos.z);
  const isAirLike = (blk) => blk && AIR_NAMES.has(blk.name);
  let solidNeighbors = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighborFloor = blockAt(new Vec3(fx + dx, fy - 1, fz + dz));
    const neighborFoot = blockAt(new Vec3(fx + dx, fy, fz + dz));
    if (neighborFloor && neighborFloor.boundingBox === 'block' && isAirLike(neighborFoot)) {
      solidNeighbors++;
    }
  }
  return solidNeighbors >= 3;
}
