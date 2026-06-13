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

/**
 * Build a GoalBlock to the nearest LOS stance cell beside a solid target, or
 * null when there's no such cell (or LOS is unavailable). The caller pathfinds
 * to it. Shared by the approach helpers so the GoalBlock construction lives in
 * one place.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ GoalBlock: new (x:number,y:number,z:number)=>object }} goals
 * @param {{ tx:number, ty:number, tz:number, range:number }} target
 * @param {(from:object,to:object)=>boolean} [hasLineOfSight]
 * @returns {object | null}
 */
export function losStanceGoal(bot, goals, { tx, ty, tz, range }, hasLineOfSight) {
  if (typeof hasLineOfSight !== 'function') return null;
  const pick = pickLosStandCell(bot, { tx, ty, tz, range }, { hasLineOfSight });
  return pick ? new goals.GoalBlock(pick.cx, pick.cy, pick.cz) : null;
}

/**
 * Walk to a LOS stance cell beside a solid target. Returns true only if the
 * bot ended within `range` of the target via the stance; false when there's no
 * stance cell, the pathfind failed, or it didn't land in range — in which case
 * the caller should fall back to its normal GoalNear approach (robustness over
 * precision: never regress reachability).
 *
 * `runGoto(goal, capMs)` is caller-injected and returns true|false (it must
 * swallow errors + clear the goal on failure) — so each caller keeps its own
 * cap mechanism (raceWithTimeout vs the progress watchdog).
 *
 * @param {{
 *   bot: import('mineflayer').Bot,
 *   goals: object,
 *   tx:number, ty:number, tz:number, range:number,
 *   hasLineOfSight?: (from:object,to:object)=>boolean,
 *   capMs:number,
 *   runGoto: (goal:object, capMs:number)=>Promise<boolean>,
 * }} args
 * @returns {Promise<boolean>}
 */
export async function tryLosStance({ bot, goals, tx, ty, tz, range, hasLineOfSight, capMs, runGoto }) {
  const goal = losStanceGoal(bot, goals, { tx, ty, tz, range }, hasLineOfSight);
  if (!goal) return false;
  const ok = await runGoto(goal, capMs);
  if (!ok) return false;
  const ddx = bot.entity.position.x - (tx + 0.5);
  const ddy = bot.entity.position.y - (ty + 0.5);
  const ddz = bot.entity.position.z - (tz + 0.5);
  return Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) <= range;
}
