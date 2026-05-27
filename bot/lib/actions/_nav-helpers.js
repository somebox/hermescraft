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
 * Probe whether the target column appears to be in a loaded chunk.
 *
 * Returns true if at least one block in the column (tx, ty±maxDy, tz)
 * is non-null. False if every probe returns null — i.e. the chunk
 * isn't loaded and the bot has zero information about that XZ.
 *
 * Used by preflightNav to decide: when no standable cell is found AND
 * the chunk is unloaded, BYPASS the NAV_TARGET_UNSTANDABLE error and
 * let pathfinder walk toward the target. Chunks will stream in as the
 * bot approaches; pathfinder's internal validation catches a truly
 * bad target then.
 *
 * Repro context (Round-A expedition test): brain issued `mc bg_goto
 * 1552 64 352` from base at (350, -595). Target ~1500 blocks away,
 * way outside the ~160-block loaded-chunk radius. Preflight refused
 * because no chunks meant `findClosestStandable` and `findStandableSameXZ`
 * both returned null. Without this bypass the brain had no way to start
 * a long-distance walk.
 *
 * @param {object} b   mineflayer bot
 * @param {number} tx  target X (floored)
 * @param {number} ty  target Y (floored)
 * @param {number} tz  target Z (floored)
 * @param {number} maxDy  half-height of the Y probe column
 * @returns {boolean} true iff at least one probe returned a non-null block
 */
export function targetChunkLoaded(b, tx, ty, tz, maxDy = 5) {
  for (let dy = -maxDy; dy <= maxDy; dy++) {
    try {
      if (b.blockAt(new Vec3(tx, ty + dy, tz))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

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
 * The block-index cell containing the bot's feet. Use for "is bot here?"
 * comparisons in actions whose target overlaps the bot's hitbox
 * (e.g. tilling the block underfoot, planting in the bot's foot cell).
 */
export function botFootCell(b) {
  return {
    x: Math.floor(b.entity.position.x),
    y: Math.floor(b.entity.position.y + 0.001),
    z: Math.floor(b.entity.position.z),
  };
}

/**
 * Find a horizontally-adjacent cell where the bot can stand WITHOUT
 * occupying or supporting the column at (x, y, z). Returns
 *   { x, y, z, dx, dz }  for the standable neighbor, or null.
 *
 * Used by till / plant when the target is the bot's standing cell (the
 * native interaction silently no-ops because the bot's hitbox occludes
 * the target face). Caller pathfinds to the returned coord, then retries
 * the action from that side.
 *
 * Order tried: N, E, S, W — first walkable wins. Each direction probes
 * the candidate at the same y first, then y+1 (step up), then y-1 (step
 * down). This handles "bot standing on a partial-height block (farmland,
 * slab) surrounded by full blocks one cell lower" — common in farm
 * plots where the bot tills/plants the cell underfoot.
 */
export function findLateralStepOff(b, x, y, z) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const nz = z + dz;
    for (const dy of [0, 1, -1]) {
      if (isStandableCell(b, nx, y + dy, nz)) {
        return { x: nx, y: y + dy, z: nz, dx, dz, dy };
      }
    }
  }
  return null;
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
/**
 * Y-axis grace search: keep (x, z) fixed and search for the closest
 * standable cell along Y within ±maxDy. Returns
 *   { x, y, z, dy, target_reason }  or  null
 * Used when the agent gave a target with the wrong Y (target inside
 * solid, or floating with no foot support) but the right XZ — typical
 * cause: aiming at a tree-top / hill-side / surface coordinate where
 * the agent guessed Y. Search direction is biased by the target's
 * own standability reason: head_blocked / foot_blocked → search UP
 * first (likely a hill side); no_foot_support → search DOWN first
 * (likely a floating-target estimate). Both directions are explored
 * within maxDy regardless.
 */
export function findStandableSameXZ(b, tx, ty, tz, maxDy = 5) {
  const target_reason = standabilityReason(b, tx, ty, tz);
  if (target_reason === 'ok') {
    return { x: tx, y: ty, z: tz, dy: 0, target_reason };
  }
  if (target_reason === 'unknown') return null;
  const preferDown = (target_reason === 'no_foot_support');
  // Build a candidate list ordered by |dy| ascending, tiebreaking by
  // preferred direction first.
  const candidates = [];
  for (let d = 1; d <= maxDy; d++) {
    if (preferDown) {
      candidates.push(-d);
      candidates.push(d);
    } else {
      candidates.push(d);
      candidates.push(-d);
    }
  }
  for (const dy of candidates) {
    if (isStandableCell(b, tx, ty + dy, tz)) {
      return { x: tx, y: ty + dy, z: tz, dy, target_reason };
    }
  }
  return null;
}

/**
 * Generic "adjust to nearest matching cell" helper (task #7).
 *
 * Many primitives (place_boat, place, till, plant, bucket_*) require an
 * EXACT coord — if the agent guesses wrong by 1-2 blocks, the action
 * errors and the agent thrashes. The fix: actions self-adjust within a
 * small radius and REPORT the adjustment so the agent learns.
 *
 * Returns the original cell when the predicate matches, OR the nearest
 * matching cell within `maxRadius` (Euclidean, spiral-by-distance),
 * OR null if nothing matches in range.
 *
 * Caller decides whether the adjustment is acceptable. The action
 * envelope then includes `data.adjusted_target` so the agent sees what
 * actually happened. Predicate signature:
 *
 *   predicate(b, x, y, z) → boolean
 *
 * Examples of useful predicates (defined inline by each verb):
 *   isWaterCell:   block.name === 'water' || 'flowing_water'
 *   isReplaceable: block is air / water / replaceable plant
 *   isFarmable:    block.name in {dirt, grass_block, farmland}
 *
 * Mirrors findClosestStandable's pattern (spiral by Euclidean distance,
 * sort+break) so the cost characteristics match what callers expect.
 *
 * @param {object} b  mineflayer bot (passed to predicate)
 * @param {(b: object, x: number, y: number, z: number) => boolean} predicate
 * @param {number} tx target X
 * @param {number} ty target Y
 * @param {number} tz target Z
 * @param {number} [maxRadius=3] Euclidean radius cap
 * @returns {{x: number, y: number, z: number, distance: number,
 *           adjusted: boolean, original: {x:number,y:number,z:number}} | null}
 */
export function findAdjustedTarget(b, predicate, tx, ty, tz, maxRadius = 3) {
  // Original first — happiest path.
  try {
    if (predicate(b, tx, ty, tz)) {
      return {
        x: tx, y: ty, z: tz, distance: 0,
        adjusted: false,
        original: { x: tx, y: ty, z: tz },
      };
    }
  } catch { /* predicate may throw on unloaded; treat as miss */ }
  // Spiral search by Euclidean distance. Same neighbour enumeration as
  // findClosestStandable so cost characteristics match.
  const candidates = [];
  const r = Math.max(0, maxRadius | 0);
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > maxRadius) continue;
        candidates.push({ dx, dy, dz, dist });
      }
    }
  }
  candidates.sort((a, c) => a.dist - c.dist);
  for (const c of candidates) {
    const cx = tx + c.dx, cy = ty + c.dy, cz = tz + c.dz;
    let ok = false;
    try { ok = !!predicate(b, cx, cy, cz); } catch { ok = false; }
    if (ok) {
      return {
        x: cx, y: cy, z: cz,
        distance: Math.round(c.dist * 100) / 100,
        adjusted: true,
        original: { x: tx, y: ty, z: tz },
      };
    }
  }
  return null;
}

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

// Cardinal directions in Minecraft coords. North is -Z by convention.
const DIRS = [
  { name: 'N', dx: 0, dz: -1 },
  { name: 'E', dx: 1, dz: 0 },
  { name: 'S', dx: 0, dz: 1 },
  { name: 'W', dx: -1, dz: 0 },
];

/**
 * Why is direction `d` blocked from cell (bx, by, bz)?
 *   - 'open'        — can walk that way at same Y
 *   - 'foot_solid'  — solid block at foot level (wall)
 *   - 'head_solid'  — air at foot but solid at head (low ceiling)
 *   - 'step_down'   — foot+head clear, no support at by-1, BUT solid ground
 *                     within 3 blocks down and the fall column is air.
 *                     Safe to walk that way (no fall damage at drop ≤ 3).
 *   - 'no_support'  — foot+head clear and no safe landing within 3 blocks
 *                     (true cliff, or fall column blocked by water/lava)
 *   - 'unknown'     — chunk not loaded
 *
 * We DON'T consider hop-up here — that's a pathfinder move, not "is this
 * direction immediately walkable". Stair geometry is classified as
 * `foot_solid` because the bot can't walk into a stair side without a
 * jump; the brain still gets the right signal.
 *
 * We DO consider drop-down (step_down) because the old "any air at by-1
 * is a cliff" rule misclassified 1-block bumps in flat terrain as
 * `on_pillar` and made `mc move` refuse with BOT_ON_PILLAR. Observed
 * 2026-05-24..27: mason hit BOT_ON_PILLAR 69× across 25 sessions,
 * 24× at the single spot (436, 67, -619). Pathfinder's default
 * maxCumulativeDropDown is 3, so neighbour drops within that range
 * should look like walkable ground to the preflight, not cliffs.
 */
function neighborStatus(b, bx, by, bz, dx, dz) {
  const fx = bx + dx, fz = bz + dz;
  const foot = b.blockAt(new Vec3(fx, by, fz));
  const head = b.blockAt(new Vec3(fx, by + 1, fz));
  const below = b.blockAt(new Vec3(fx, by - 1, fz));
  if (!foot || !head || !below) return 'unknown';
  if (!TRAVERSABLE_FOOT.has(foot.name)) return 'foot_solid';
  if (!AIR_NAMES.has(head.name)) return 'head_solid';
  if (below.boundingBox === 'block') return 'open';

  // Safe step-down probe. Match pathfinder's default maxCumulativeDropDown
  // (3 blocks; see manager.js MAX_CUMULATIVE_DROP_DOWN_DEFAULT). For each
  // candidate landing depth, every cell the bot falls through must be
  // truly air — water/lava/leaves change physics and aren't a clean drop.
  for (let dy = 2; dy <= 4; dy++) {
    const probe = b.blockAt(new Vec3(fx, by - dy, fz));
    if (!probe) break;                       // unloaded — be conservative
    if (probe.boundingBox !== 'block') continue;
    let fallColumnClear = true;
    for (let pyDown = 1; pyDown <= dy - 1; pyDown++) {
      const through = b.blockAt(new Vec3(fx, by - pyDown, fz));
      if (!through || !AIR_NAMES.has(through.name)) { fallColumnClear = false; break; }
    }
    if (fallColumnClear) return 'step_down';
    break;
  }
  return 'no_support';
}

/**
 * Classify the bot's current standing situation.
 *
 * Returns { position, cell, classification, blocked_dirs, open_dirs,
 *           head_blocked, foot_support, ceiling_within, wedge_offset,
 *           neighbor_status }.
 *
 * Classifications:
 *   'in_air'             — bot not on solid ground (falling / floating)
 *   'trapped'            — all 4 cardinal dirs blocked at foot or head
 *                          AND no step-up escape (true geometric trap)
 *   'step_up_only'       — all 4 cardinal dirs blocked at foot or head,
 *                          BUT at least one direction has a 1-block
 *                          step-up available (head clear, neighbour
 *                          foot solid, neighbour up + neighbour up2
 *                          both air). Pathfinder can jump out — NOT
 *                          actually trapped. Bottom of a stair_down
 *                          staircase is the canonical case.
 *   'enclosure_inside'   — walls visible in all 4 dirs within 4 cells
 *                          AND a ceiling within 4 cells above (we're
 *                          inside a built structure)
 *   'corner'             — 2 perpendicular dirs blocked (N+E, E+S, S+W, W+N)
 *   'alley'              — 2 opposite dirs blocked (N+S or E+W)
 *   'three_walled'       — 3 dirs blocked (one escape)
 *   'edge'               — ≥1 dir has 'no_support' (true cliff — no safe
 *                          landing within 3 blocks). 1–3 block step-downs
 *                          to flat ground are 'open', not 'edge'.
 *   'wedge'              — bot's position is fractionally between two cells
 *   'in_flowing_water'   — foot block is flowing_water; current pushes the
 *                          bot every tick. Special escape needed (sprint
 *                          perpendicular / place block / pillar up).
 *   'in_water'           — foot block is water source (still). Bot can
 *                          stand but pathfinder may struggle.
 *   'open'               — 0–1 dirs blocked, no cliff, on solid ground
 *
 * Order matters: in_air > in_flowing_water > in_water > trapped >
 * step_up_only > enclosure_inside > three_walled > corner > alley >
 * wedge > edge > open.
 */
export function standingState(b) {
  if (!b || !b.entity || !b.entity.position) {
    return { classification: 'unknown', error: 'no_bot' };
  }
  const p = b.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);

  const below = b.blockAt(new Vec3(bx, by - 1, bz));
  const foot = b.blockAt(new Vec3(bx, by, bz));
  const head = b.blockAt(new Vec3(bx, by + 1, bz));
  const foot_support = below ? below.boundingBox === 'block' : null;
  const head_blocked = head ? !AIR_NAMES.has(head.name) : null;
  const foot_in_water = !!foot && (foot.name === 'water' || foot.name === 'flowing_water');
  const foot_in_flowing = !!foot && foot.name === 'flowing_water';
  const head_in_water = !!head && (head.name === 'water' || head.name === 'flowing_water');

  const neighbor_status = {};
  for (const d of DIRS) {
    neighbor_status[d.name] = neighborStatus(b, bx, by, bz, d.dx, d.dz);
  }
  const blocked_dirs = DIRS.filter(d => {
    const s = neighbor_status[d.name];
    return s === 'foot_solid' || s === 'head_solid';
  }).map(d => d.name);
  const open_dirs = DIRS.filter(d => neighbor_status[d.name] === 'open').map(d => d.name);
  const cliff_dirs = DIRS.filter(d => neighbor_status[d.name] === 'no_support').map(d => d.name);
  // Safe drops (1–3 blocks down with clear fall column). Exposed as its
  // own field so the brain can distinguish "walk and drop a bit" from
  // "walk at level". Critically, these do NOT count toward cliff_dirs —
  // an `on_pillar` classification requires real cliffs in all 4 dirs.
  const step_down_dirs = DIRS.filter(d => neighbor_status[d.name] === 'step_down').map(d => d.name);

  // Step-up escape: even with all 4 foot-neighbours solid, the bot can
  // still walk OUT by jump-stepping onto an adjacent block whose top
  // face is at (by + 1). Required conditions per direction:
  //   - bot's own head (bx, by+1, bz) is air (room to jump up)
  //   - neighbour foot (fx, by, fz) is solid (the block we step onto)
  //   - neighbour cell (fx, by+1, fz) is air (target foot)
  //   - neighbour cell (fx, by+2, fz) is air (target head clearance)
  // This is exactly how the bot exits the bottom of a stair_down
  // staircase: the back-direction has a 1-block step-up to the next
  // stair tread.
  const head_air = head && AIR_NAMES.has(head.name);
  const step_up_dirs = [];
  if (head_air) {
    for (const d of DIRS) {
      const fx = bx + d.dx;
      const fz = bz + d.dz;
      const nFoot = b.blockAt(new Vec3(fx, by, fz));
      const nUp = b.blockAt(new Vec3(fx, by + 1, fz));
      const nUp2 = b.blockAt(new Vec3(fx, by + 2, fz));
      if (!nFoot || !nUp || !nUp2) continue;
      const footSolid = !TRAVERSABLE_FOOT.has(nFoot.name);
      const upAir = AIR_NAMES.has(nUp.name);
      const up2Air = AIR_NAMES.has(nUp2.name);
      if (footSolid && upAir && up2Air) {
        step_up_dirs.push(d.name);
      }
    }
  }

  // How close is the nearest solid ceiling above? (caps at 4)
  let ceiling_within = null;
  for (let dy = 1; dy <= 4; dy++) {
    const block = b.blockAt(new Vec3(bx, by + dy, bz));
    if (block && block.boundingBox === 'block') {
      ceiling_within = dy;
      break;
    }
  }

  // Wedge detection: bot's center should be at cell-center ±0.3 (cell
  // centers are at .5). >0.3 from .5 in either X or Z means we're
  // straddling two cells.
  const dxFromCenter = Math.abs((p.x - bx) - 0.5);
  const dzFromCenter = Math.abs((p.z - bz) - 0.5);
  const isWedged = dxFromCenter > 0.3 || dzFromCenter > 0.3;
  const wedge_offset = isWedged ? { dx: Math.round(dxFromCenter * 100) / 100, dz: Math.round(dzFromCenter * 100) / 100 } : null;

  // Enclosure check: walk outward in each cardinal up to 4 cells; if
  // every direction hits a solid block at foot or head level AND there's
  // a ceiling within 4 above, we're inside a built structure.
  let enclosed = true;
  let max_wall_distance = 0;
  for (const d of DIRS) {
    let wallAt = null;
    for (let r = 1; r <= 4; r++) {
      const cx = bx + d.dx * r;
      const cz = bz + d.dz * r;
      const fb = b.blockAt(new Vec3(cx, by, cz));
      const hb = b.blockAt(new Vec3(cx, by + 1, cz));
      if (!fb || !hb) break;
      const fSolid = !TRAVERSABLE_FOOT.has(fb.name);
      const hSolid = !AIR_NAMES.has(hb.name);
      if (fSolid || hSolid) {
        wallAt = r;
        break;
      }
    }
    if (wallAt === null) {
      enclosed = false;
      break;
    }
    if (wallAt > max_wall_distance) max_wall_distance = wallAt;
  }
  const enclosure_inside = enclosed && ceiling_within !== null;

  // Classify by priority order
  let classification;
  if (foot_support === false && !blocked_dirs.length && !foot_in_water) {
    classification = 'in_air';
  } else if (foot_in_flowing) {
    // Foot in flowing water: current pushes the bot every tick. Highest
    // priority after in_air because the bot can't reliably do anything
    // else (mine, place, walk) until clear of the current.
    classification = 'in_flowing_water';
  } else if (foot_in_water) {
    // Foot in source water: bot can stand, but pathfinder swim physics
    // and the SUBMERGED-dig guard create their own issues. Worth
    // classifying separately so mc escape can pick a water strategy.
    classification = 'in_water';
  } else if (blocked_dirs.length === 4 && step_up_dirs.length === 0) {
    classification = 'trapped';
  } else if (blocked_dirs.length === 4 && step_up_dirs.length > 0) {
    // All 4 cardinal foot-neighbours solid BUT at least one direction
    // has a 1-block step-up available — e.g. the bot is at the bottom
    // of a staircase. Pathfinder's jump-move can handle this; do NOT
    // refuse the call as 'trapped'.
    classification = 'step_up_only';
  } else if (enclosure_inside && max_wall_distance > 1) {
    // Inside a built structure (walls all around but not pressed against
    // them). Different from `trapped` — bot has room but no exit visible.
    classification = 'enclosure_inside';
  } else if (blocked_dirs.length === 3) {
    classification = 'three_walled';
  } else if (blocked_dirs.length === 2) {
    // Perpendicular = corner, opposite = alley
    const set = new Set(blocked_dirs);
    if ((set.has('N') && set.has('S')) || (set.has('E') && set.has('W'))) {
      classification = 'alley';
    } else {
      classification = 'corner';
    }
  } else if (isWedged) {
    classification = 'wedge';
  } else if (cliff_dirs.length === 4 && blocked_dirs.length === 0) {
    // #99: bot is standing on a 1×1 column with a TRUE cliff (no landing
    // within 3 blocks) in every cardinal direction. mc move has nowhere
    // walkable to go; callers get this classification + the
    // next_action_hint should suggest `mc pillar_down` to descend or
    // `mc dig` the supporting block to drop one level.
    //
    // Bumps in flat terrain (1-block protrusions with grass 1-3 below)
    // are NOT on_pillar — those neighbours now classify as step_down
    // and are excluded from cliff_dirs, so this branch only fires for
    // real towers/pinnacles.
    classification = 'on_pillar';
  } else if (cliff_dirs.length > 0 && blocked_dirs.length === 0) {
    classification = 'edge';
  } else {
    classification = 'open';
  }

  return {
    position: { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100 },
    cell: { x: bx, y: by, z: bz },
    classification,
    blocked_dirs,
    open_dirs,
    cliff_dirs,
    step_down_dirs,
    step_up_dirs,
    head_blocked,
    foot_support,
    ceiling_within,
    wedge_offset,
    enclosure_inside,
    foot_in_water,
    foot_in_flowing,
    head_in_water,
    neighbor_status,
  };
}

/**
 * Reachability BFS: can the bot walk from its current position to a
 * standable cell adjacent to (target.x, target.y, target.z)?
 *
 * Returns null on any throw. Otherwise:
 *   {
 *     walkable_to_target: boolean,
 *     distance_from_target: number,        // straight-line bot→target
 *     visited_cells: number,               // BFS work done
 *     arrived_cell?: {x,y,z},              // present when walkable: the
 *                                          // BFS cell within 1 of target
 *     next_hop_suggestion?: {x,y,z},       // when not walkable: the best
 *                                          // adjacent or frontier cell
 *   }
 *
 * Used by:
 *   - mc move / mc goto / mc goto_near error responses (existing)
 *   - mc find / mc find_blocks / mc discover result annotation (#92)
 */
export function computeReachability(b, target, maxVisit = 96) {
  try {
    const tx = Math.floor(Number(target.x));
    const ty = Math.floor(Number(target.y));
    const tz = Math.floor(Number(target.z));
    const startCell = {
      x: Math.floor(b.entity.position.x),
      y: Math.floor(b.entity.position.y),
      z: Math.floor(b.entity.position.z),
    };
    const dist3 = (ax, ay, az, bx, by, bz) => Math.sqrt(
      (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2,
    );
    const isWalkable = (cx, cy, cz) => {
      const foot = b.blockAt(new Vec3(cx, cy, cz));
      if (!foot) return false;
      const name = foot.name || '';
      if (/(_door|_fence_gate|_trapdoor)$/.test(name)) return true;
      return isStandableCell(b, cx, cy, cz);
    };
    const isAirAt = (cx, cy, cz) => {
      const blk = b.blockAt(new Vec3(cx, cy, cz));
      return blk ? AIR_NAMES.has(blk.name) : false;
    };
    const canStepUp = (cx, cy, cz, dx, dz) => {
      if (!isAirAt(cx, cy + 1, cz)) return false;
      if (!isWalkable(cx + dx, cy + 1, cz + dz)) return false;
      if (!isAirAt(cx + dx, cy + 2, cz + dz)) return false;
      return true;
    };
    const startKey = `${startCell.x},${startCell.y},${startCell.z}`;
    const visited = new Set([startKey]);
    const queue = [{ ...startCell }];
    let bestCell = startCell;
    let bestDist = dist3(startCell.x, startCell.y, startCell.z, tx, ty, tz);
    let arrived = null;
    let reached = false;
    const NEIGHBORS = [
      [1, 0, 0], [-1, 0, 0],
      [0, 0, 1], [0, 0, -1],
      [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
      [0, 1, 0], [0, -1, 0],
    ];
    const STEP_UP_DIRS = [
      [1, 1, 0], [-1, 1, 0],
      [0, 1, 1], [0, 1, -1],
    ];
    while (queue.length > 0 && visited.size < maxVisit) {
      const cur = queue.shift();
      const d = dist3(cur.x, cur.y, cur.z, tx, ty, tz);
      if (d < bestDist) { bestDist = d; bestCell = cur; }
      if (Math.abs(cur.x - tx) <= 1 && Math.abs(cur.y - ty) <= 1 && Math.abs(cur.z - tz) <= 1) {
        reached = true;
        arrived = { x: cur.x, y: cur.y, z: cur.z };
        break;
      }
      for (const [dxn, dyn, dzn] of NEIGHBORS) {
        const nx = cur.x + dxn, ny = cur.y + dyn, nz = cur.z + dzn;
        const key = `${nx},${ny},${nz}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (!isWalkable(nx, ny, nz)) continue;
        queue.push({ x: nx, y: ny, z: nz });
      }
      for (const [dxn, dyn, dzn] of STEP_UP_DIRS) {
        const nx = cur.x + dxn, ny = cur.y + dyn, nz = cur.z + dzn;
        const key = `${nx},${ny},${nz}`;
        if (visited.has(key)) continue;
        const dx = dxn, dz = dzn;
        if (!canStepUp(cur.x, cur.y, cur.z, dx, dz)) continue;
        visited.add(key);
        queue.push({ x: nx, y: ny, z: nz });
      }
    }
    const startToTarget = dist3(startCell.x, startCell.y, startCell.z, tx, ty, tz);
    const out = {
      distance_from_target: Math.round(startToTarget * 10) / 10,
      walkable_to_target: reached,
      visited_cells: visited.size,
    };
    if (reached && arrived) {
      out.arrived_cell = arrived;
      // next_hop_suggestion is the "where to go next when the target is
      // NOT directly walkable" hint — leave it unset on success. All
      // consumers gate on !walkable_to_target, and the functional contract
      // (test_goto_near_reachability.py) expects it absent on success.
    } else if (!reached) {
      let hop = null;
      const adjCandidates = [];
      for (const [dxn, dyn, dzn] of NEIGHBORS) {
        const cx = tx + dxn, cy = ty + dyn, cz = tz + dzn;
        if (!isWalkable(cx, cy, cz)) continue;
        adjCandidates.push({
          x: cx, y: cy, z: cz,
          dist: dist3(cx, cy, cz, startCell.x, startCell.y, startCell.z),
        });
      }
      adjCandidates.sort((a, c) => a.dist - c.dist);
      if (adjCandidates.length > 0) {
        hop = { x: adjCandidates[0].x, y: adjCandidates[0].y, z: adjCandidates[0].z };
      } else if (bestCell.x !== startCell.x || bestCell.y !== startCell.y || bestCell.z !== startCell.z) {
        hop = bestCell;
      }
      if (hop) out.next_hop_suggestion = hop;
    }
    return out;
  } catch { return null; }
}

/**
 * Enrich a list of block-location results with reachability info.
 *
 * For each location, runs a capped BFS via computeReachability and adds:
 *   - approach_cell: {x,y,z} — the cell the bot would actually walk TO
 *     (the cell adjacent to the block, not the block itself which can't
 *     be stood in). Present whether the target is reachable or not.
 *   - reachable: boolean
 *   - unreachable_reason: 'no_standable_neighbor' | 'bfs_exhausted' |
 *                        'no_path' | null
 *
 * Sorts reachable results first (preserving relative order), unreachable
 * last. The caller can still see all results, but defaults to chasing
 * reachable ones.
 *
 * maxVisit caps work-per-target. 96 is the same default movement.js uses
 * elsewhere. With 10-12 candidates this is ~50-300ms total, vs. the
 * 30+ seconds the agent would spend discovering un-reachability live.
 */
export function annotateReachability(b, locations, maxVisit = 96) {
  if (!Array.isArray(locations) || locations.length === 0) return locations;
  const enriched = locations.map((loc) => {
    const reach = computeReachability(b, { x: loc.x, y: loc.y, z: loc.z }, maxVisit);
    if (!reach) {
      return { ...loc, reachable: null, unreachable_reason: 'unknown' };
    }
    if (reach.walkable_to_target) {
      return {
        ...loc,
        approach_cell: reach.arrived_cell || null,
        reachable: true,
      };
    }
    let reason;
    if (!reach.next_hop_suggestion) {
      reason = 'no_standable_neighbor';
    } else if (reach.visited_cells >= maxVisit) {
      reason = 'bfs_exhausted';
    } else {
      reason = 'no_path';
    }
    return {
      ...loc,
      approach_cell: reach.next_hop_suggestion || null,
      reachable: false,
      unreachable_reason: reason,
    };
  });
  enriched.sort((a, c) => {
    const ar = a.reachable === true ? 0 : 1;
    const cr = c.reachable === true ? 0 : 1;
    return ar - cr;
  });
  return enriched;
}
