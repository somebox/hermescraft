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
 * Predicate the BFS uses for graph expansion. Task #66 (B4): allows
 * 'shallow' (1-deep water) in addition to 'navigable' — the boat
 * hitbox doesn't care about water depth, only obstacles at y=water_y.
 * The entry-water lookup and findNearbyNavigableWater still use the
 * stricter 'navigable' check so the bot has safe water to swim in
 * during launch/recovery.
 */
function isSailable(b, x, y, z) {
  const cls = classifyCell(b, x, y, z);
  return cls === 'navigable' || cls === 'shallow';
}

/**
 * A shore cell is DRY land directly adjacent to a water cell — the bot
 * can stand there with feet in AIR (head clearance above, solid block
 * beneath) and step into the water. Foot=air, foot-1=solid non-water,
 * head=air.
 *
 * F27 (task #66, v43): foot must be air. The previous version also
 * accepted foot=water as a "shore" with the comment "foot can be air
 * (the bot stands ON the block below)" — but a water-foot cell IS the
 * bot standing IN the water. circuit-v43 forensics: findEntryShore
 * returned (345, 62, -541) — a 1-deep water cell with dirt below — as
 * the entry shore. The pathfinder dutifully walked the bot to that
 * coord, the bot ended up submerged, F3 caught the cascade, and the
 * agent could never start a journey because the same wet "shore" was
 * picked on every retry. The natural-beach case (sand at water-y level
 * with walkable air ABOVE) is handled by the dy=+1 retry in
 * findEntryShore / findExitShore (F16), not by foot=water — that case
 * fails the first try (foot=sand → not air) and passes the second
 * (foot=air at sy+1).
 */
function isShoreCell(b, x, y, z) {
  const foot = b.blockAt(new Vec3(x, y, z));
  if (!foot) return false;
  // Foot must be air. Water-foot cells are not dry shore — the bot
  // would arrive submerged. See F27 above.
  if (!AIR_NAMES.has(foot.name)) return false;
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
  // Task #66 (B3): collision-aware scoring. The previous version
  // picked the shore closest to target; that often selected exit
  // cells whose exit_water is adjacent to a 1-block obstacle (e.g.
  // (350,62,-535) sat 1 cell from a dirt spike at (350,62,-536) — the
  // boat hitbox clipped the spike at speed and broke). Now we
  // penalise candidates whose exit_water has solid neighbours at
  // y=water_y, so a slightly-farther but clean exit beats a
  // closer-but-obstacle-adjacent one.
  let best = null;
  let bestScore = Infinity;
  for (const c of cells) {
    // Score the exit_water's neighbourhood once per `c` (it doesn't
    // depend on the chosen shore direction).
    let solidNeighborCount = 0;
    for (const [ndx, ndz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nb = b.blockAt(new Vec3(c.x + ndx, c.y, c.z + ndz));
      if (nb && nb.boundingBox === 'block' && !WATER_NAMES.has(nb.name) && !AIR_NAMES.has(nb.name)) {
        solidNeighborCount++;
      }
    }
    // Penalty: each solid neighbour adds 4b of "effective distance".
    // 4b tradeoff means we prefer a clean exit up to 4b farther
    // than a dirty one with a single obstacle adjacent.
    const obstaclePenalty = solidNeighborCount * 4;

    // Probe 4 cardinal land cells adjacent to c. Also check one cell
    // up (sy + 1) — natural beaches have sand AT the water's y level
    // (contains the water) with walkable air ABOVE at sy+1. The cell
    // at the same y as water is rejected by isShoreCell (foot is the
    // solid sand block, not enterable), but the bot's actual standing
    // position is the air block on top.
    //
    // F16 (task #54): mirrors findEntryShore's dual check. Pre-fix,
    // findExitShore rejected every natural beach as "not a shore,"
    // producing TARGET_NOT_REACHABLE_FROM_WATER even when a perfectly
    // walkable beach existed adjacent to the water.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const sx = c.x + dx, sz = c.z + dz;
      const horizToTarget = Math.hypot(sx - target.x, sz - target.z);
      if (horizToTarget > radius) continue;
      for (const dy of [0, 1]) {
        const sy = c.y + dy;
        if (!isShoreCell(b, sx, sy, sz)) continue;
        const d = Math.hypot(sx - target.x, sy - target.y, sz - target.z);
        const score = d + obstaclePenalty;
        if (score < bestScore) {
          bestScore = score;
          best = { shore: { x: sx, y: sy, z: sz }, water: { x: c.x, y: c.y, z: c.z } };
        }
      }
    }
  }
  return best;
}

/**
 * Find a land shore cell adjacent to `water` (used as the entry shore —
 * where the bot stands before boarding).
 */
function findEntryShore(b, water, opts = {}) {
  // F30 (task #66, v45): spiral out from the water cell. Pre-F30 we
  // checked only the 4 immediate cardinal neighbors (with a dy=+1
  // fallback for sloped beaches). circuit-v45 forensics: the BFS's
  // nearestExternalWater pointer landed in a stretch of lake where
  // EVERY cardinal cell was also water (1-deep on sand → no shore by
  // either dy=0 or dy=+1). findEntryShore returned null, sail_to
  // surfaced the raw water coord in the hint, and mc bg_goto refused
  // it as NAV_TARGET_UNSTANDABLE. The actual dry shore was 2-3
  // blocks away — and that's exactly where the bot was already
  // standing. Searching outward by Chebyshev (square-ring) distance
  // up to `maxRadius` finds those near-shores.
  //
  // Order: ring 1 (4 immediate cardinals) checked first to preserve
  // the previous behavior on standard pier/dock geometries. Within
  // each ring, dy=0 cells are tried before dy=+1 (sloped-beach
  // fallback, F16) so dry foot beats sand-foot-walkable-air-above
  // when both exist.
  const maxRadius = Math.max(1, Math.min(8, opts.maxRadius ?? 4));
  for (let r = 1; r <= maxRadius; r++) {
    // Collect cells on the Chebyshev ring at distance r. Cardinal cells
    // first (dx=0 or dz=0 with |dx|+|dz|==r) so they sort to the front.
    const ring = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const isCardinalish = (dx === 0) || (dz === 0);
        ring.push({ dx, dz, prio: isCardinalish ? 0 : 1 });
      }
    }
    ring.sort((a, b2) => a.prio - b2.prio);
    for (const { dx, dz } of ring) {
      const sx = water.x + dx, sz = water.z + dz;
      // Try the water's y first (standard waterfront), then sy+1
      // (sloped beach: sand at water-y with walkable air above).
      for (const dy of [0, 1]) {
        const sy = water.y + dy;
        if (isShoreCell(b, sx, sy, sz)) {
          return { x: sx, y: sy, z: sz };
        }
      }
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
  // F43 (task #66, v55): callers can override MIN_USEFUL_SAIL when the bot
  // is already in water — any sail that ends on a dry shore is useful
  // because the alternative is "stranded swimming." Default 20 keeps the
  // F19 behaviour for dry-land callers (avoid pointless place_boat
  // overhead for 5b crossings).
  const minUsefulSail = opts.min_useful_sail ?? 20;

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
          // F15 (task #52, v37): also require classifyCell === 'navigable'.
          // Pre-fix, a candidate with air above but only 1 deep (no
          // water at y-1) was suggested — the agent bg_goto'd there,
          // sail_to refused as WATER_TOO_SHALLOW, infinite loop.
          // Now we run the full navigability check (water foot, air
          // y+1 + y+2 for rider clearance, water y-1 for boat depth)
          // before accepting any candidate.
          // F48 (task #66, v58): reject candidates whose Y is far from
          // the bot's current Y. circuit-v58 forensics: agent on grass
          // at y=65 was directed to a "Walkable shore at (353, 54, -562)"
          // — an UNDERGROUND CAVE 11 blocks below. The cave's shore
          // technically passes isShoreCell (air-foot above stone), but
          // the bot can't reach it without digging. A 5-block Y delta
          // catches caves and floating mountain lakes; surface fords
          // (boat on a river, river-bank ~2b below bot) still pass.
          const MAX_Y_DELTA = 5;
          const candidates = hits.map((w) => {
            const wx = typeof w.x === 'number' ? w.x : Math.floor(w.x);
            const wy = typeof w.y === 'number' ? w.y : Math.floor(w.y);
            const wz = typeof w.z === 'number' ? w.z : Math.floor(w.z);
            const dxz = Math.hypot(wx - startFx, wz - startFz);
            const dy = Math.abs(wy - startFy);
            const navClass = classifyCell(b, wx, wy, wz);
            return { x: wx, y: wy, z: wz, dxz, dy, navClass };
          }).filter((c) => c.navClass === 'navigable' && c.dy <= MAX_Y_DELTA);
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
    // F21 (task #59, v41): for every candidate water cell, also compute
    // the walkable SHORE STANCE — the dry cell adjacent to the water
    // where the bot will actually stand. Pre-F21 we surfaced the water
    // coord; mc bg_goto refused it as NAV_TARGET_UNSTANDABLE; agent
    // fell back to mc move and overshot into the ocean.
    const nearestShoreStance = nearestWater ? findEntryShore(b, nearestWater) : null;
    return {
      ok: false,
      error: {
        code: anyShallow ? 'WATER_TOO_SHALLOW' : 'NO_WATER_ROUTE',
        message: anyShallow
          ? `Found water within ${entryRadius}b but it's only 1 deep — the boat would ground out. Walk to a deeper shore first.${nearestShoreStance ? ` Walkable shore is at (${nearestShoreStance.x}, ${nearestShoreStance.y}, ${nearestShoreStance.z}).` : nearestWater ? ` Nearest navigable water is ~${nearestWater.distance}b away at (${nearestWater.x}, ${nearestWater.y}, ${nearestWater.z}).` : ''}`
          : `No navigable water cell (water with air above and water below) within ${entryRadius}b of start.${nearestShoreStance ? ` Walkable shore is at (${nearestShoreStance.x}, ${nearestShoreStance.y}, ${nearestShoreStance.z}) (next to water at (${nearestWater.x}, ${nearestWater.y}, ${nearestWater.z})) — mc bg_goto there, then mc sail_to again.` : nearestWater ? ` Nearest water source is ~${nearestWater.distance}b away at (${nearestWater.x}, ${nearestWater.y}, ${nearestWater.z}).` : ''}`,
        observed_state: {
          start,
          entry_search_radius: entryRadius,
          start_cell_classification: startCellClass,
          ...(nearestWater ? { nearest_water_candidate: nearestWater } : {}),
          ...(nearestShoreStance ? { nearest_shore_stance: nearestShoreStance } : {}),
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

  // Task #66 (B3/B4): explore the FULL connected water graph (up to
  // maxExplored=50k). The old "break on first within-radius cell"
  // optimisation stopped exploration ~7-10 cells short of the
  // actual target shore — natural beach approaches often have a
  // 1-deep gap that needs to be traversed before the shore appears.
  // maxExplored already caps unbounded oceans.

  while (queue.length > 0 && explored.length < maxExplored) {
    const cur = queue.shift();
    const curDist = Math.hypot(cur.x - target.x, cur.z - target.z);
    if (curDist < nearestToTarget.dist) {
      nearestToTarget = { cell: cur, dist: curDist };
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, nz = cur.z + dz;
      const k = key(nx, cur.y, nz);
      if (visited.has(k)) continue;
      // Task #66 (B4): allow boat_passable (1-deep over solid floor)
      // cells so the BFS can reach natural beach shores. The boat
      // hitbox doesn't care about water depth — only solid blocks at
      // y=water_y obstruct it (those are caught by isSailable's
      // 'blocked' return).
      if (!isSailable(b, nx, cur.y, nz)) continue;
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
          // F15 (task #52): also require classifyCell === 'navigable'
          // (water foot + air x2 above + water below). A shallow pond
          // wouldn't help Steve sail out of THIS pond either.
          // F48 (task #66, v58): also filter by Y proximity here —
          // same rationale as the NO_WATER_ROUTE branch above.
          const POND_MAX_Y_DELTA = 5;
          const candidates = hits.map((w) => {
            const wx = typeof w.x === 'number' ? w.x : Math.floor(w.x);
            const wy = typeof w.y === 'number' ? w.y : Math.floor(w.y);
            const wz = typeof w.z === 'number' ? w.z : Math.floor(w.z);
            const inThisPond = visitedKeys.has(key(wx, wy, wz));
            const dxz = Math.hypot(wx - startFx, wz - startFz);
            const dy = Math.abs(wy - startFy);
            const navClass = classifyCell(b, wx, wy, wz);
            return { x: wx, y: wy, z: wz, dxz, dy, navClass, inThisPond };
          }).filter((c) => c.navClass === 'navigable' && !c.inThisPond && c.dy <= POND_MAX_Y_DELTA);
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
    // F21 (task #59): same shore-stance treatment for the pond branch.
    const pondNearestShoreStance = nearestExternalWater ? findEntryShore(b, nearestExternalWater) : null;
    return {
      ok: false,
      error: {
        code: 'POND_DISCONNECTED',
        message: `Water near start is a tiny pond (${explored.length} cells reachable). Walk to a real shore first with mc bg_goto.${pondNearestShoreStance ? ` Walkable shore outside this pond is at (${pondNearestShoreStance.x}, ${pondNearestShoreStance.y}, ${pondNearestShoreStance.z}).` : nearestExternalWater ? ` Nearest surface water outside this pond is ~${nearestExternalWater.distance}b away at (${nearestExternalWater.x}, ${nearestExternalWater.y}, ${nearestExternalWater.z}).` : ''}`,
        observed_state: {
          entry_water: entryWater,
          cells_in_pond: explored.length,
          nearest_water_to_target: nearestToTarget.cell,
          distance_short_by: Math.round(nearestToTarget.dist),
          ...(nearestExternalWater ? { nearest_water_candidate: nearestExternalWater } : {}),
          ...(pondNearestShoreStance ? { nearest_shore_stance: pondNearestShoreStance } : {}),
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
  // F19 (task #57, v39): sanity check loosened. Previously refused
  // partial routes that saved <25% of distance — over-strict in
  // practice. Example from v39: bot at (310, -599), target (0, -100),
  // best partial exit at (280, -480) — saves 96b of a 568b trip
  // (17%). That's REAL progress: 96b of sailing means 96b of land the
  // agent doesn't have to traverse, and the agent then has a fresh
  // sail_to from the disembark point.
  //
  // New criterion: refuse only if (a) the partial doesn't make forward
  // progress at all (exit_shore is no closer to target than start), OR
  // (b) the sail itself is too short to be worth the boat-place/mount
  // overhead (< MIN_USEFUL_SAIL blocks).
  const startToTargetHoriz = Math.hypot(start.x - target.x, start.z - target.z);
  const exitToTargetHoriz = Math.hypot(exit.shore.x - target.x, exit.shore.z - target.z);
  const sailDistance = Math.hypot(
    exit.water.x - entryWater.x,
    exit.water.z - entryWater.z,
  );
  const MIN_USEFUL_SAIL = minUsefulSail;
  if (partial && exitToTargetHoriz >= startToTargetHoriz) {
    // Going backward / sideways — boat doesn't help.
    return {
      ok: false,
      error: {
        code: 'TARGET_NOT_REACHABLE_FROM_WATER',
        message: `Water doesn't get you closer to target — best reachable shore is at (${exit.shore.x},${exit.shore.y},${exit.shore.z}), ${Math.round(exitToTargetHoriz)}b from target (you're ${Math.round(startToTargetHoriz)}b away now — the boat trip would NOT advance you). Walk via mc bg_goto instead.`,
        observed_state: {
          start_to_target_horiz: Math.round(startToTargetHoriz),
          best_exit_shore: exit.shore,
          exit_to_target_horiz: Math.round(exitToTargetHoriz),
          sail_distance: Math.round(sailDistance),
          target,
        },
      },
    };
  }
  if (partial && sailDistance < MIN_USEFUL_SAIL) {
    // Sail is so short that the place_boat + board + sail + disembark
    // dance isn't worth it — agent should just walk the whole thing.
    return {
      ok: false,
      error: {
        code: 'TARGET_NOT_REACHABLE_FROM_WATER',
        message: `Water route is only ${Math.round(sailDistance)}b — shorter than the boat-launch overhead. Walk to target via mc bg_goto instead.`,
        observed_state: {
          start_to_target_horiz: Math.round(startToTargetHoriz),
          best_exit_shore: exit.shore,
          exit_to_target_horiz: Math.round(exitToTargetHoriz),
          sail_distance: Math.round(sailDistance),
          target,
        },
      },
    };
  }

  // Find an entry shore — a land cell ADJACENT to entry_water. The
  // bot walks here then place_boat reaches across one block to drop
  // the boat at entry_water. If findEntryShore can't find an adjacent
  // shore, the fallback uses the bot's start position so walk_to_entry
  // becomes a no-op and the mount phase surfaces a clean OUT_OF_RANGE
  // (the agent should have walked closer before calling sail_to).
  //
  // F38 (task #66, v50): maxRadius=1 (cardinals + diagonals only).
  // F30 defaulted findEntryShore to maxRadius=4 for the F21 nearest-
  // shore-stance HINT — there a far-away shore is still useful info.
  // But here, in sail_to's BFS, a far shore means walk_to_entry walks
  // the bot AWAY from entry_water and place_boat then fails
  // OUT_OF_RANGE. circuit-v50 forensics: entry_water=(316,62,-565),
  // entry_shore returned at (312,63,-565) — 4 blocks west. Bot
  // walked there, was 4b from entry_water, place_boat refused.
  const entryShore = findEntryShore(b, entryWater, { maxRadius: 1 })
    || { x: startFx, y: startFy, z: startFz };

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
