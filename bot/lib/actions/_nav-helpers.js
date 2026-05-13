/**
 * Navigation helpers — standability checks + nearby-standable search.
 *
 * Motivated by G21 v2 (deepseek-flash post-F47): Mason got stuck for
 * 60+ seconds in a corner-of-wall geometry because `mc goto_near 0 65 12
 * range=1` returned only `OPERATION_TIMEOUT` after 15s — no information
 * about WHY the cell was unreachable or where a nearby standable cell
 * could be found. The bot had no path forward.
 *
 * `findClosestStandable` scans a small region around a target cell and
 * returns the closest cell where the bot can physically stand (foot
 * air, head air, solid ground below). The result is used in two
 * places:
 *   - `mc reachable X Y Z` (new verb): pre-flight check so the brain
 *     can pick a valid stand-spot before committing to a goto.
 *   - `goto`/`goto_near`/`move` error responses (F48 enhancement):
 *     when nav fails, the error carries `closest_standable` in
 *     observed_state so the brain can retry with a working coord
 *     instead of hammering the same dead-end.
 */

import { Vec3 } from 'vec3';

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
const TRAVERSABLE_FOOT = new Set([
  'air', 'cave_air', 'void_air',
  // Replaceable plants don't actually let a bot stand stably, but
  // pathfinder walks through them and they collapse on contact, so
  // they count as valid for our purposes.
  'tall_grass', 'short_grass', 'grass', 'fern', 'snow',
]);

/**
 * Is cell (x, y, z) a valid place for the bot to stand?
 *   - foot cell (x, y, z): air-like or traversable plant
 *   - head cell (x, y+1, z): air-like (1.8-tall bot needs head room)
 *   - below cell (x, y-1, z): solid block (bot needs something to
 *     stand on — pathfinder also accepts climbable like ladders/scaffold
 *     but we keep this strict for the reachability check)
 */
export function isStandableCell(b, x, y, z) {
  const foot = b.blockAt(new Vec3(x, y, z));
  const head = b.blockAt(new Vec3(x, y + 1, z));
  const below = b.blockAt(new Vec3(x, y - 1, z));
  if (!foot || !head || !below) return false;
  if (!TRAVERSABLE_FOOT.has(foot.name)) return false;
  if (!AIR_NAMES.has(head.name)) return false;
  return below.boundingBox === 'block';
}

/**
 * Diagnose why a cell isn't standable. Returns one of:
 *   'ok'              — standable
 *   'head_blocked'    — foot is air but head has a block (most common
 *                       trap: bot is at floor level under a wall)
 *   'foot_blocked'    — foot cell is a solid block
 *   'no_foot_support' — foot+head clear but nothing solid below (drop)
 *   'unknown'         — bot can't see the cell (chunk not loaded)
 */
export function standabilityReason(b, x, y, z) {
  const foot = b.blockAt(new Vec3(x, y, z));
  const head = b.blockAt(new Vec3(x, y + 1, z));
  const below = b.blockAt(new Vec3(x, y - 1, z));
  if (!foot || !head || !below) return 'unknown';
  if (!TRAVERSABLE_FOOT.has(foot.name)) return 'foot_blocked';
  if (!AIR_NAMES.has(head.name)) return 'head_blocked';
  if (below.boundingBox !== 'block') return 'no_foot_support';
  return 'ok';
}

/**
 * Search around (tx, ty, tz) for the closest cell where the bot can
 * stand. maxScan = max Euclidean distance (default 3). Returns
 *   { x, y, z, distance, target_reason }  or  null
 * where target_reason is the standabilityReason() at the target itself
 * — included so the caller can explain WHY the original target was bad.
 *
 * BFS-like: enumerate all cells within Chebyshev distance maxScan,
 * sort by Euclidean distance from the target, return the first
 * standable one. O(N³) but small (N≤7 → ~343 cells worst case).
 */
export function findClosestStandable(b, tx, ty, tz, maxScan = 3) {
  const target_reason = standabilityReason(b, tx, ty, tz);
  if (target_reason === 'ok') {
    return {
      x: tx, y: ty, z: tz, distance: 0, target_reason,
    };
  }
  const candidates = [];
  for (let dx = -maxScan; dx <= maxScan; dx++) {
    for (let dy = -maxScan; dy <= maxScan; dy++) {
      for (let dz = -maxScan; dz <= maxScan; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > maxScan) continue;
        candidates.push({ dx, dy, dz, dist });
      }
    }
  }
  candidates.sort((a, c) => a.dist - c.dist);
  for (const c of candidates) {
    const cx = tx + c.dx, cy = ty + c.dy, cz = tz + c.dz;
    if (isStandableCell(b, cx, cy, cz)) {
      return {
        x: cx, y: cy, z: cz,
        distance: Math.round(c.dist * 100) / 100,
        target_reason,
      };
    }
  }
  return null;
}
