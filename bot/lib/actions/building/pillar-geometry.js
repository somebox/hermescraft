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
 */

import { Vec3 } from 'vec3';

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/**
 * Y-walk-down to find the block the bot is currently standing on.
 *
 * Walks from floor(footY - 0.001) downward up to `maxDown` cells, returning
 * the first block whose boundingBox === 'block'. The -0.001 nudge handles
 * the case where the bot's foot Y is exactly an integer (e.g. y=64.0 means
 * standing on top of the block at y=63 — feetY should resolve to 63, not 64).
 *
 * Returns null if no block within range. The caller can fall back to
 * lateral references or fail.
 *
 * @param {{x: number, y: number, z: number}} footPos  bot.entity.position
 * @param {(pos: import('vec3').Vec3) => { boundingBox?: string, position?: {x:number,y:number,z:number} } | null} blockAt
 * @param {number} [maxDown=1]  How many cells below feetY to also probe.
 *   Default 1 covers the standard "feet on full block" + "feet on slab top"
 *   shapes without diving into shaft geometry.
 */
export function findStandingBlockCell(footPos, blockAt, maxDown = 1) {
  const ix = Math.floor(footPos.x);
  const iz = Math.floor(footPos.z);
  const feetY = Math.floor(footPos.y - 0.001);
  for (let dy = 0; dy <= maxDown; dy++) {
    const y = feetY - dy;
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
