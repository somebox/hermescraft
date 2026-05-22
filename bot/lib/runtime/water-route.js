/**
 * Water-route BFS planner — foundational utility for mc sail_to.
 *
 * Validates that a continuous, navigable water path exists from a
 * start coord to a target coord. Returns the entry/exit shore cells
 * (where the bot boards/dismounts) plus sparse waypoints for the
 * sail action to use as steering hints.
 *
 * Why this exists: circuit-v15 through v20 surfaced that the existing
 * boat workflow has no concept of a "navigable water route." mc board
 * picks any water within 12 blocks; mc sail tries a straight line with
 * 8-way nudges; mc bg_goto's BOAT_REQUIRED gate only counts water
 * samples on the line — none of them check whether the water actually
 * CONNECTS from current position to target. Steve repeatedly sailed
 * into 5×5 ponds, hit invisible 1-block bridges across water, or got
 * grounded on shallow shore-floor cells. This BFS treats water as a
 * graph and tells the caller whether the journey is real.
 *
 * Navigability per cell (x, y, z):
 *   - blockAt(x, y, z).name === 'water'        — boat's foot cell
 *   - blockAt(x, y+1, z).name === 'air'         — vertical clearance
 *   - blockAt(x, y-1, z).name === 'water'       — 2-block depth so the
 *                                                  boat doesn't ground
 *
 * Edges connect a cell to its 4 horizontal neighbors at the same y.
 * Boats can't climb water steps, so cross-y movement is not allowed.
 *
 * This module is a PURE function over the bot's blockAt — it does not
 * mutate state, doesn't depend on mineflayer beyond the blockAt
 * contract, and is fully unit-testable via the makeMockBot pattern.
 */

import { Vec3 } from 'vec3';

const WATER_NAMES = new Set(['water', 'flowing_water']);
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/** Boat top speed under our sail loop is ~8 b/s on the packet path. */
const BOAT_SPEED_BPS = 8;
/** Fixed overhead per journey: place + mount + disembark + walk legs. */
const JOURNEY_OVERHEAD_S = 30;
/** Tiny puddle threshold — fewer than this many connected cells = pond. */
const POND_CELL_THRESHOLD = 100;
/** Distance below which the caller should use bg_goto instead. */
const ALREADY_AT_TARGET_DISTANCE = 4;
/** Default BFS exploration cap. */
const DEFAULT_MAX_EXPLORED = 50_000;
/** Default radius for entry-water lookup around the start position. */
const DEFAULT_ENTRY_SEARCH_RADIUS = 12;
/** Default radius for exit-shore lookup around the target position. */
const DEFAULT_EXIT_SHORE_RADIUS = 8;
/** Sparse waypoints — one cell per N blocks along the path. */
const WAYPOINT_SPACING = 8;

function key(x, y, z) {
  return `${x},${y},${z}`;
}

function isWater(b, x, y, z) {
  const blk = b.blockAt(new Vec3(x, y, z));
  return !!blk && WATER_NAMES.has(blk.name);
}

function isAir(b, x, y, z) {
  const blk = b.blockAt(new Vec3(x, y, z));
  return !!blk && AIR_NAMES.has(blk.name);
}

/**
 * A cell is navigable if it's water, with TWO blocks of air above (the
 * boat plus the rider's head — rider sits ~1 block above the water
 * surface), and water below.
 *
 * Returns:
 *   'navigable' — usable for boat travel
 *   'shallow'   — water at y but solid below; boat would ground
 *   'blocked'   — non-water at y, or no 2-block clearance above
 *   'unloaded'  — at least one of the four probes returned null
 *
 * circuit-v25: the y+1-only clearance check missed piers/bridges with
 * the deck at y+2 — water was free at the surface, head cell was air,
 * BFS treated the cell as navigable, then the boat physically rammed
 * the deck above. Need to check y+1 AND y+2 are both air.
 */
function classifyCell(b, x, y, z) {
  const foot = b.blockAt(new Vec3(x, y, z));
  if (!foot) return 'unloaded';
  if (!WATER_NAMES.has(foot.name)) return 'blocked';
  const head = b.blockAt(new Vec3(x, y + 1, z));
  if (!head) return 'unloaded';
  if (!AIR_NAMES.has(head.name)) return 'blocked';
  // Rider's head occupies y+2 — pier decks at y+2 above open water at y
  // are a collision the boat can't survive.
  const above = b.blockAt(new Vec3(x, y + 2, z));
  if (!above) return 'unloaded';
  if (!AIR_NAMES.has(above.name)) return 'blocked';
  const below = b.blockAt(new Vec3(x, y - 1, z));
  if (!below) return 'unloaded';
  if (!WATER_NAMES.has(below.name)) return 'shallow';
  return 'navigable';
}

/**
 * A shore cell is land directly adjacent to a water cell — the bot
 * can stand there with feet on solid ground and step into the water.
 * (foot=air OR solid-stand, foot-1=solid block, head=air.)
 */
function isShoreCell(b, x, y, z) {
  const foot = b.blockAt(new Vec3(x, y, z));
  if (!foot) return false;
  // foot can be air (the bot stands ON the block below) — checked below
  if (!AIR_NAMES.has(foot.name) && foot.name !== 'water') {
    // foot block must be enterable (air-ish) — actual stand block is y-1
    return false;
  }
  const head = b.blockAt(new Vec3(x, y + 1, z));
  if (!head || !AIR_NAMES.has(head.name)) return false;
  const below = b.blockAt(new Vec3(x, y - 1, z));
  if (!below) return false;
  // Standing block must be solid and not water.
  if (WATER_NAMES.has(below.name)) return false;
  if (below.boundingBox && below.boundingBox !== 'block') return false;
  return true;
}

/**
 * Find a navigable water cell within `radius` of (sx, sy, sz). Used to
 * pick the entry_water (where boat is placed) when the bot is standing
 * on shore. Spiral by Manhattan distance so we get the nearest first.
 */
function findNearbyNavigableWater(b, sx, sy, sz, radius) {
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        // Try the bot's own y first, then ±1 for shore slopes.
        for (const dy of [0, -1, 1]) {
          const x = sx + dx, y = sy + dy, z = sz + dz;
          if (classifyCell(b, x, y, z) === 'navigable') {
            return { x, y, z };
          }
        }
      }
    }
  }
  return null;
}

/**
 * Find a land shore cell adjacent to ANY of the water cells in `cells`.
 * Returns the shore cell closest to `target`, optionally enforcing a
 * radius cap.
 *
 * @param {object} b — mineflayer bot (for blockAt)
 * @param {Array<{x,y,z}>} cells — explored water cells from BFS
 * @param {{x,y,z}} target — final destination
 * @param {number} radius — only return shores within this horiz distance
 *                          from target. Pass Infinity for "any shore".
 */
function findExitShore(b, cells, target, radius) {
  let best = null;
  let bestDist = Infinity;
  for (const c of cells) {
    // Probe 4 cardinal land cells adjacent to c.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const sx = c.x + dx, sy = c.y, sz = c.z + dz;
      const horizToTarget = Math.hypot(sx - target.x, sz - target.z);
      if (horizToTarget > radius) continue;
      if (!isShoreCell(b, sx, sy, sz)) continue;
      const d = Math.hypot(sx - target.x, sy - target.y, sz - target.z);
      if (d < bestDist) {
        bestDist = d;
        best = { shore: { x: sx, y: sy, z: sz }, water: { x: c.x, y: c.y, z: c.z } };
      }
    }
  }
  return best;
}

/**
 * Find a land shore cell adjacent to `water` (used as the entry shore —
 * where the bot stands before boarding).
 */
function findEntryShore(b, water) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const sx = water.x + dx, sy = water.y, sz = water.z + dz;
    if (isShoreCell(b, sx, sy, sz)) {
      return { x: sx, y: sy, z: sz };
    }
    // Also try one block up — beaches often slope.
    if (isShoreCell(b, sx, sy + 1, sz)) {
      return { x: sx, y: sy + 1, z: sz };
    }
  }
  return null;
}

/**
 * Plan a water route from `start` to `target` using BFS over navigable
 * water cells. See module docstring for full semantics.
 *
 * @param {object} b — mineflayer-style bot exposing blockAt({x,y,z})
 * @param {{x:number,y:number,z:number}} start
 * @param {{x:number,y:number,z:number}} target
 * @param {object} [opts]
 * @returns {object} — see module docstring for envelope shapes
 */
export function planWaterRoute(b, start, target, opts = {}) {
  const maxExplored = opts.max_explored ?? DEFAULT_MAX_EXPLORED;
  const entryRadius = opts.entry_search_radius ?? DEFAULT_ENTRY_SEARCH_RADIUS;
  const exitRadius = opts.exit_shore_radius ?? DEFAULT_EXIT_SHORE_RADIUS;

  // Trivial: caller is already near the target. No journey needed.
  const horizToTarget = Math.hypot(start.x - target.x, start.z - target.z);
  if (horizToTarget < ALREADY_AT_TARGET_DISTANCE) {
    return {
      ok: false,
      error: {
        code: 'ALREADY_AT_TARGET',
        message: `Start is ${horizToTarget.toFixed(1)} blocks from target — no journey needed. Use mc bg_goto for the final approach.`,
        observed_state: { start, target, distance: horizToTarget },
      },
    };
  }

  // Find the entry water cell. If the start is already in water,
  // use that as entry. Otherwise scan nearby for navigable water.
  const startFx = Math.floor(start.x);
  const startFy = Math.floor(start.y);
  const startFz = Math.floor(start.z);
  let entryWater = null;
  const startCellClass = classifyCell(b, startFx, startFy, startFz);
  if (startCellClass === 'navigable') {
    entryWater = { x: startFx, y: startFy, z: startFz };
  } else {
    entryWater = findNearbyNavigableWater(b, startFx, startFy, startFz, entryRadius);
  }
  if (!entryWater) {
    // Check whether we hit shallow vs no water at all.
    const anyShallow = (() => {
      for (let dx = -entryRadius; dx <= entryRadius; dx++) {
        for (let dz = -entryRadius; dz <= entryRadius; dz++) {
          for (const dy of [0, -1, 1]) {
            if (classifyCell(b, startFx + dx, startFy + dy, startFz + dz) === 'shallow') {
              return true;
            }
          }
        }
      }
      return false;
    })();
    // F10 (task #48 — option A): when no navigable water is in the 12b
    // entry-search radius, do a wider mineflayer-native b.findBlocks scan
    // (default 64b) for the NEAREST water source. The agent can then
    // bg_goto directly to that coord without burning an exploration loop.
    // Pre-fix, the agent had no body-supplied "head this way" hint and
    // had to mc map / mc scene / guess intermediate coords.
    // F12 (task #49, v35): the closest water voxel returned by findBlocks
    // can be a cave pool deep below the bot. The agent then bg_goto's
    // there → NAV_TARGET_UNSTANDABLE (can't pathfind down through stone).
    // Filter to SURFACE water only: the cell directly above must be air
    // (water exposed to sky/walkable space), and prefer cells within
    // ±4 Y of the bot. Higher `count` lets us walk the results until
    // we find a navigable one.
    let nearestWater = null;
    try {
      if (typeof b.findBlocks === 'function') {
        const hits = b.findBlocks({
          // Don't filter inside matching — findBlocks calls this per
          // candidate but doesn't always populate blockAt context. Just
          // gather raw water cells and filter below.
          matching: (blk) => blk && (blk.name === 'water' || blk.name === 'flowing_water'),
          maxDistance: 64,
          count: 32,
        });
        if (hits && hits.length > 0) {
          // Score each candidate. Surface water (air above + within
          // ±4 Y of bot) wins decisively. Otherwise prefer cells close
          // to bot's Y to avoid suggesting cave pools.
          const candidates = hits.map((w) => {
            const wx = typeof w.x === 'number' ? w.x : Math.floor(w.x);
            const wy = typeof w.y === 'number' ? w.y : Math.floor(w.y);
            const wz = typeof w.z === 'number' ? w.z : Math.floor(w.z);
            const above = b.blockAt(new Vec3(wx, wy + 1, wz));
            const isSurface = !!(above && AIR_NAMES.has(above.name));
            const dxz = Math.hypot(wx - startFx, wz - startFz);
            const dy = Math.abs(wy - startFy);
            return { x: wx, y: wy, z: wz, dxz, dy, isSurface };
          }).filter((c) => c.isSurface); // drop cave pools entirely
          if (candidates.length > 0) {
            // Sort: closest in XZ first, tiebreaker = smaller |dy|.
            candidates.sort((a, b2) => (a.dxz - b2.dxz) || (a.dy - b2.dy));
            const best = candidates[0];
            nearestWater = {
              x: best.x,
              y: best.y,
              z: best.z,
              distance: Math.round(best.dxz),
            };
          }
        }
      }
    } catch {
      // findBlocks unavailable or threw — fall through with nearestWater=null
    }
    return {
      ok: false,
      error: {
        code: anyShallow ? 'WATER_TOO_SHALLOW' : 'NO_WATER_ROUTE',
        message: anyShallow
          ? `Found water within ${entryRadius}b but it's only 1 deep — the boat would ground out. Walk to a deeper shore first.${nearestWater ? ` Nearest navigable water is ~${nearestWater.distance}b away at (${nearestWater.x}, ${nearestWater.y}, ${nearestWater.z}).` : ''}`
          : `No navigable water cell (water with air above and water below) within ${entryRadius}b of start.${nearestWater ? ` Nearest water source is ~${nearestWater.distance}b away at (${nearestWater.x}, ${nearestWater.y}, ${nearestWater.z}) — walk there with mc bg_goto, then call mc sail_to again.` : ''}`,
        observed_state: {
          start,
          entry_search_radius: entryRadius,
          start_cell_classification: startCellClass,
          ...(nearestWater ? { nearest_water_candidate: nearestWater } : {}),
        },
      },
    };
  }

  // BFS over the water graph.
  const visited = new Set([key(entryWater.x, entryWater.y, entryWater.z)]);
  const parent = new Map();
  const queue = [entryWater];
  const explored = []; // visited cells in BFS order — used for pond detection + exit-shore scan
  explored.push(entryWater);

  // Track the cell closest to the target's horizontal column — that's
  // our best candidate for the exit_water.
  let nearestToTarget = { cell: entryWater, dist: Math.hypot(entryWater.x - target.x, entryWater.z - target.z) };

  while (queue.length > 0 && explored.length < maxExplored) {
    const cur = queue.shift();
    const curDist = Math.hypot(cur.x - target.x, cur.z - target.z);
    if (curDist < nearestToTarget.dist) {
      nearestToTarget = { cell: cur, dist: curDist };
      // Early exit if we're within exit-shore radius of target.
      if (curDist <= exitRadius) {
        // Still keep exploring a bit to find better exit options, but
        // not the whole budget. Break here for simplicity — we'll
        // do exit-shore search across all visited cells.
        break;
      }
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, nz = cur.z + dz;
      const k = key(nx, cur.y, nz);
      if (visited.has(k)) continue;
      if (classifyCell(b, nx, cur.y, nz) !== 'navigable') continue;
      visited.add(k);
      parent.set(k, key(cur.x, cur.y, cur.z));
      const ncell = { x: nx, y: cur.y, z: nz };
      queue.push(ncell);
      explored.push(ncell);
    }
  }

  // If the BFS terminated with very few cells, it's a tiny pond.
  if (explored.length < POND_CELL_THRESHOLD && nearestToTarget.dist > exitRadius) {
    // F13 (task #50, v36): find the nearest surface water cell that
    // is NOT part of this pond, so the agent has a concrete bg_goto
    // coord. Pre-fix the hint was "mc bg_goto <coast coords>" with no
    // actual coord, leaving the agent stuck. Reuse the same surface-
    // water filter as F10/F12 plus the visited-set exclusion.
    const visitedKeys = visited;  // bound from earlier in this function
    let nearestExternalWater = null;
    try {
      if (typeof b.findBlocks === 'function') {
        const hits = b.findBlocks({
          matching: (blk) => blk && (blk.name === 'water' || blk.name === 'flowing_water'),
          maxDistance: 96,
          count: 64,
        });
        if (hits && hits.length > 0) {
          const candidates = hits.map((w) => {
            const wx = typeof w.x === 'number' ? w.x : Math.floor(w.x);
            const wy = typeof w.y === 'number' ? w.y : Math.floor(w.y);
            const wz = typeof w.z === 'number' ? w.z : Math.floor(w.z);
            const above = b.blockAt(new Vec3(wx, wy + 1, wz));
            const isSurface = !!(above && AIR_NAMES.has(above.name));
            const inThisPond = visitedKeys.has(key(wx, wy, wz));
            const dxz = Math.hypot(wx - startFx, wz - startFz);
            const dy = Math.abs(wy - startFy);
            return { x: wx, y: wy, z: wz, dxz, dy, isSurface, inThisPond };
          }).filter((c) => c.isSurface && !c.inThisPond);
          if (candidates.length > 0) {
            candidates.sort((a, b2) => (a.dxz - b2.dxz) || (a.dy - b2.dy));
            const best = candidates[0];
            nearestExternalWater = {
              x: best.x,
              y: best.y,
              z: best.z,
              distance: Math.round(best.dxz),
            };
          }
        }
      }
    } catch {
      // findBlocks unavailable or threw — keep null
    }
    return {
      ok: false,
      error: {
        code: 'POND_DISCONNECTED',
        message: `Water near start is a tiny pond (${explored.length} cells reachable). Walk to a real shore first with mc bg_goto.${nearestExternalWater ? ` Nearest surface water outside this pond is ~${nearestExternalWater.distance}b away at (${nearestExternalWater.x}, ${nearestExternalWater.y}, ${nearestExternalWater.z}).` : ''}`,
        observed_state: {
          entry_water: entryWater,
          cells_in_pond: explored.length,
          nearest_water_to_target: nearestToTarget.cell,
          distance_short_by: Math.round(nearestToTarget.dist),
          ...(nearestExternalWater ? { nearest_water_candidate: nearestExternalWater } : {}),
        },
      },
    };
  }

  // Find the exit shore — a land cell adjacent to the BFS-explored
  // water cells, as close to target as possible.
  // circuit-v24 follow-up: if no shore within the strict radius, fall
  // back to the BEST shore anywhere in the explored water graph.
  // Return success with `partial: true` so the agent gets a usable
  // step: sail to this nearest reachable shore, then mc bg_goto the
  // remaining land segment. Pre-fix Steve hit dead-end refusals and
  // wandered back to base instead of making partial progress.
  let exit = findExitShore(b, explored, target, exitRadius);
  let partial = false;
  if (!exit) {
    exit = findExitShore(b, explored, target, Infinity);
    if (!exit) {
      // Truly no shore anywhere in the BFS-explored cells — open ocean.
      return {
        ok: false,
        error: {
          code: 'TARGET_NOT_REACHABLE_FROM_WATER',
          message: `Water reaches near target (closest cell: ${Math.round(nearestToTarget.dist)}b away) but no walkable shore exists anywhere in the navigable water near you.`,
          observed_state: {
            nearest_water_to_target: nearestToTarget.cell,
            water_cells_explored: explored.length,
            target,
          },
        },
      };
    }
    partial = true;
  }
  // Sanity: if the partial exit shore is barely closer to target than
  // the bot's current position (saves <25% of horizontal distance), it's
  // not worth the boat trip. Refuse so the agent walks instead.
  const startToTargetHoriz = Math.hypot(start.x - target.x, start.z - target.z);
  const exitToTargetHoriz = Math.hypot(exit.shore.x - target.x, exit.shore.z - target.z);
  if (partial && exitToTargetHoriz > startToTargetHoriz * 0.75) {
    return {
      ok: false,
      error: {
        code: 'TARGET_NOT_REACHABLE_FROM_WATER',
        message: `Water doesn't get you meaningfully closer to target — best reachable shore is at (${exit.shore.x},${exit.shore.y},${exit.shore.z}), still ${Math.round(exitToTargetHoriz)}b from target (you're ${Math.round(startToTargetHoriz)}b away now). Walk via mc bg_goto instead.`,
        observed_state: {
          start_to_target_horiz: Math.round(startToTargetHoriz),
          best_exit_shore: exit.shore,
          exit_to_target_horiz: Math.round(exitToTargetHoriz),
          target,
        },
      },
    };
  }

  // Find an entry shore — land cell adjacent to entry_water.
  const entryShore = findEntryShore(b, entryWater) || { x: startFx, y: startFy, z: startFz };

  // Build the water-cell path from entry_water → exit_water by
  // walking the parent map backwards.
  const exitKey = key(exit.water.x, exit.water.y, exit.water.z);
  const path = [];
  let curKey = exitKey;
  while (curKey) {
    const [x, y, z] = curKey.split(',').map(Number);
    path.push({ x, y, z });
    curKey = parent.get(curKey);
  }
  path.reverse();

  // Sparse waypoints: every WAYPOINT_SPACING-th cell along the path.
  // Always include first and last (the entry and exit water cells).
  const waypoints = [];
  for (let i = 0; i < path.length; i += WAYPOINT_SPACING) {
    waypoints.push(path[i]);
  }
  if (waypoints[waypoints.length - 1] !== path[path.length - 1]) {
    waypoints.push(path[path.length - 1]);
  }

  const horizDist = Math.hypot(
    entryWater.x - exit.water.x,
    entryWater.z - exit.water.z,
  );
  const estimatedSeconds = Math.ceil(horizDist / BOAT_SPEED_BPS + JOURNEY_OVERHEAD_S);

  return {
    ok: true,
    data: {
      entry_shore: entryShore,
      entry_water: entryWater,
      exit_water: exit.water,
      exit_shore: exit.shore,
      waypoints,
      horizontal_distance: Math.round(horizDist),
      water_cells_explored: explored.length,
      estimated_seconds: estimatedSeconds,
      // circuit-v24: partial-journey flag. When true, exit_shore is
      // NOT within the strict 8-block radius of the target — the water
      // route gets the bot closer but a land segment remains. The
      // sail_to orchestrator surfaces this in its result so the agent
      // knows to call mc bg_goto for the remaining distance.
      partial: partial,
      walk_remaining_after_water: partial
        ? Math.round(Math.hypot(exit.shore.x - target.x, exit.shore.z - target.z))
        : 0,
    },
  };
}

// Internal helpers exported for unit testing.
export const _internals = {
  classifyCell,
  isShoreCell,
  findNearbyNavigableWater,
  findExitShore,
  findEntryShore,
  WATER_NAMES,
  AIR_NAMES,
  POND_CELL_THRESHOLD,
  ALREADY_AT_TARGET_DISTANCE,
};
