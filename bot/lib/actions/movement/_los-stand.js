import { Vec3 } from 'vec3';
import { isStandableCell } from '../_nav-helpers.js';
import { FAIR_PLAY } from '../../runtime/fair-play-constants.js';

/**
 * Pick the closest standable cell with clear line-of-sight to a face of the
 * solid target block — the "stand beside it, where you can see it" stance
 * (e.g. chest-adjacent). Extracted verbatim from goto_near so a future
 * intent-based `approach` verb (Pass 2) can swap the internals.
 *
 * Returns `{ cx, cy, cz, d }` (the chosen cell + its Euclidean distance from
 * the target) or `null` — null when the target isn't a solid block, when LOS
 * is unavailable, or when no LOS-clear standable cell exists within `range`.
 * The caller owns turning a pick into a `GoalBlock`.
 *
 * Precondition: the `targetIsSolid` gate lives here — callers must not run
 * LOS stand-selection on non-solid (air) targets, which would change the
 * GoalNear-vs-GoalBlock choice.
 *
 * Uses the fair-play sensor eye (`FAIRPLAY_EYE_HEIGHT_DEFAULT`, a
 * default-height literal — see fair-play charter asymmetry #1) and the
 * injected fair-play `hasLineOfSight`, so the stance it picks passes the
 * same LOS gate the interaction handlers enforce at act-time.
 *
 * @param {import('mineflayer').Bot} b
 * @param {{ tx:number, ty:number, tz:number, range:number }} target floored target coords + radius
 * @param {{ hasLineOfSight?: (from:object,to:object)=>boolean }} deps
 * @returns {{ cx:number, cy:number, cz:number, d:number } | null}
 */
export function pickLosStandCell(b, { tx, ty, tz, range }, { hasLineOfSight } = {}) {
  if (typeof hasLineOfSight !== 'function') return null;
  const targetBlock = b.blockAt(new Vec3(tx, ty, tz));
  const targetIsSolid = !!(targetBlock
    && targetBlock.boundingBox === 'block'
    && targetBlock.name !== 'air'
    && targetBlock.name !== 'cave_air');
  if (!targetIsSolid) return null;

  const cBx = tx + 0.5, cBy = ty + 0.5, cBz = tz + 0.5;
  const faces = [
    { x: cBx, y: cBy, z: cBz - 0.48 },
    { x: cBx, y: cBy, z: cBz + 0.48 },
    { x: cBx - 0.48, y: cBy, z: cBz },
    { x: cBx + 0.48, y: cBy, z: cBz },
    { x: cBx, y: cBy - 0.48, z: cBz },
    { x: cBx, y: cBy + 0.48, z: cBz },
    { x: cBx, y: cBy, z: cBz },
  ];
  const cands = [];
  const R = Math.max(1, Math.floor(range));
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > range) continue;
        const cx = tx + dx, cy = ty + dy, cz = tz + dz;
        if (!isStandableCell(b, cx, cy, cz)) continue;
        const candEye = { x: cx + 0.5, y: cy + FAIR_PLAY.FAIRPLAY_EYE_HEIGHT_DEFAULT, z: cz + 0.5 };
        if (faces.some((p) => hasLineOfSight(candEye, p))) {
          cands.push({ cx, cy, cz, d });
        }
      }
    }
  }
  if (cands.length === 0) return null;
  cands.sort((a, c) => a.d - c.d);
  return cands[0];
}
