/**
 * Boat-path planner + tp-step driver.
 *
 * Replaces the native/packet/probe steering soup in sail() with a
 * deterministic, collision-checked path computed UP FRONT.
 *
 * Why this exists: circuit-v59 forensics — the boat died after ~1.5b
 * of motion against a y=62 dirt spike adjacent to BFS-picked
 * exit_water=(350,62,-535). Probe-2 packet steering in sail() had no
 * collision check and tp'd the boat into the obstacle. Live T1
 * (2026-05-23) confirmed boat physics are fine in clean corridors;
 * the failure mode is purely "steering shoves boat into a y=62
 * block." Precomputing a safe path + driving it via the existing
 * collision-aware tp-step eliminates the entire failure class.
 *
 * Boat collision footprint (Minecraft 1.21 oak_boat):
 *   - boat center sits at water_cell.y + 1.0625 (BOAT_VERTICAL_OFFSET)
 *   - hitbox half-width ~0.7 in x/z
 *   - hitbox bottom at center.y - 0.28 — DIPS INTO the cell below
 *     the center cell. So a solid block at y=water_y (one below the
 *     boat-center cell) within 0.7 of the boat center IS a collision.
 *
 * The planner walks a Bresenham-like line in x/z, checks each step's
 * collision footprint against blockAt, and shifts ±1/±2 perpendicular
 * when blocked. If no corridor exists within the shift budget the
 * planner returns `NARROW_CHANNEL` with the offending cells in
 * `blockers[]` so the caller can decide whether to clear them.
 */

import { Vec3 } from 'vec3';

const WATER_NAMES = new Set(['water', 'flowing_water']);
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/** Boat sits this much above the water-cell origin. */
export const BOAT_VERTICAL_OFFSET = 1.0625;
/** Boat hitbox half-width in x/z (boat is ~1.375b wide). */
export const BOAT_HALF_WIDTH = 0.7;
/** Default per-step distance (blocks). Matches sail()'s old tp-step cadence. */
const DEFAULT_STEP_SIZE = 1.5;
/** Max perpendicular shift the planner will try to route around a blocker. */
const DEFAULT_MAX_PERPENDICULAR_SHIFT = 2;
/** Sleep between tp-steps (ms). ~190ms = ~8 b/s with 1.5b steps. */
const TP_STEP_INTERVAL_MS = 190;

/** Blocks the planner is willing to flag as "disposable" (task #22). */
export const DISPOSABLE_BLOCK_NAMES = new Set([
  'dirt', 'coarse_dirt', 'rooted_dirt',
  'sand', 'red_sand',
  'gravel',
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant',
]);

function isSolid(block) {
  if (!block) return false;
  if (AIR_NAMES.has(block.name) || WATER_NAMES.has(block.name)) return false;
  // Some blocks have boundingBox==='empty' (grass plants, redstone, etc.) —
  // those don't collide with a boat. Only count true 'block' bounding boxes.
  return block.boundingBox === 'block';
}

function isWater(block) {
  return !!block && WATER_NAMES.has(block.name);
}

/**
 * Check whether the boat can sit centered at (cx, cz) on the water
 * surface above water-cell-y `wy`. Returns:
 *   { ok: true } — clear
 *   { ok: false, blocker: {x,y,z,name} } — a solid cell collides with hitbox
 */
export function checkBoatFootprint(b, cx, cz, wy) {
  // Primary cell (boat center): must be water — the boat needs to float.
  const px = Math.floor(cx);
  const pz = Math.floor(cz);
  const primary = b.blockAt(new Vec3(px, wy, pz));
  if (!isWater(primary)) {
    return { ok: false, blocker: { x: px, y: wy, z: pz, name: primary?.name ?? 'unknown' } };
  }
  // Side cells the hitbox can overlap when the boat is centered at
  // (cx, cz). With half-width 0.7 the hitbox extends into adjacent
  // cells if the center isn't perfectly cell-aligned. We probe the
  // four cardinal neighbors at the same y; any solid one is a hit.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    // Only check the side if the hitbox actually reaches into that
    // neighbor cell. With cx snapped to .5 the hitbox stays inside
    // the primary cell; with fractional cx the test still triggers.
    const cellBoundary = (dx === 1) ? Math.floor(cx) + 1
                       : (dx === -1) ? Math.floor(cx)
                       : (dz === 1) ? Math.floor(cz) + 1
                       : Math.floor(cz);
    const center = (dx !== 0) ? cx : cz;
    const distToBoundary = Math.abs(cellBoundary - center);
    if (distToBoundary >= BOAT_HALF_WIDTH) continue; // hitbox doesn't reach
    const nx = px + dx;
    const nz = pz + dz;
    const side = b.blockAt(new Vec3(nx, wy, nz));
    if (isSolid(side)) {
      return { ok: false, blocker: { x: nx, y: wy, z: nz, name: side.name } };
    }
  }
  return { ok: true };
}

/**
 * Plan a collision-safe boat path from `from` to `to` along the water
 * surface. Returns:
 *   { ok: true, path: [{x,y,z}, ...], blockers: [] }
 *   { ok: false, reason: 'NARROW_CHANNEL', blockers: [{x,y,z,name}, ...], partial_path }
 *   { ok: false, reason: 'NOT_ON_WATER', ... }
 *
 * `from` and `to` are boat-position coords (x.5, water_y + 1.0625, z.5).
 * The path is a list of boat positions; the caller drives the boat
 * through each via executeBoatPath.
 */
export function planBoatPath(b, from, to, opts = {}) {
  const stepSize = opts.step_size ?? DEFAULT_STEP_SIZE;
  const maxShift = opts.max_perpendicular_shift ?? DEFAULT_MAX_PERPENDICULAR_SHIFT;

  // Derive water-cell y from the boat's y. The boat sits ON water, so
  // somewhere at or just below floor(boat.y) is the water cell. Live
  // forensics show position.y can drift between water_y+1 (boat just
  // placed) and water_y+0.75 (mid-mount transient) — `floor(from.y) - 1`
  // breaks on the latter. Instead, scan a few candidate water-y values
  // around floor(boat.y) and pick the first one that is actually water
  // at the boat's current x/z. Caller can override via opts.water_y.
  const fx = Math.floor(from.x);
  const fz = Math.floor(from.z);
  let waterY = opts.water_y;
  if (waterY === undefined) {
    const baseY = Math.floor(from.y);
    // Try in order: baseY (boat-y cell), baseY-1 (one below), baseY+1
    // (one above, e.g. if boat just popped up onto the surface).
    for (const dy of [0, -1, 1]) {
      const candidateY = baseY + dy;
      const blk = b.blockAt(new Vec3(fx, candidateY, fz));
      if (blk && WATER_NAMES.has(blk.name)) {
        waterY = candidateY;
        break;
      }
    }
    // No water at the boat's column — leave waterY undefined; the
    // checkBoatFootprint below will return NOT_ON_WATER cleanly.
    if (waterY === undefined) waterY = baseY - 1; // best-effort, will fail
  }
  const boatY = waterY + BOAT_VERTICAL_OFFSET;

  // Validate the starting cell.
  const startCheck = checkBoatFootprint(b, from.x, from.z, waterY);
  if (!startCheck.ok) {
    return {
      ok: false,
      reason: 'NOT_ON_WATER',
      blockers: [startCheck.blocker],
      partial_path: [],
      message: `Boat starting cell at (${Math.floor(from.x)}, ${waterY}, ${Math.floor(from.z)}) is not safe water (found ${startCheck.blocker.name}).`,
    };
  }

  const totalDx = to.x - from.x;
  const totalDz = to.z - from.z;
  const totalDist = Math.hypot(totalDx, totalDz);

  if (totalDist < 0.5) {
    return { ok: true, path: [{ x: from.x, y: boatY, z: from.z }], blockers: [], water_y: waterY };
  }

  const dirX = totalDx / totalDist;
  const dirZ = totalDz / totalDist;
  // Perpendicular unit vector (rotate +90°): (-dirZ, dirX)
  const perpX = -dirZ;
  const perpZ = dirX;

  // Snap to cell center so collision check is deterministic.
  const snap = (v) => Math.floor(v) + 0.5;

  const path = [];
  const blockers = [];

  let curX = from.x;
  let curZ = from.z;
  let traveled = 0;

  // Safety cap to prevent runaway loops on pathologically long routes.
  const maxIterations = Math.ceil(totalDist / Math.max(0.5, stepSize)) + 8;
  let iter = 0;

  while (traveled + 0.01 < totalDist && iter < maxIterations) {
    iter++;
    const remaining = totalDist - traveled;
    const stepDist = Math.min(stepSize, remaining);

    // Target step along the original direction (Bresenham-ish).
    const targetX = curX + dirX * stepDist;
    const targetZ = curZ + dirZ * stepDist;

    // Candidate ordering: straight line, then ±1, ±2 perpendicular.
    const candidates = [{ shift: 0, x: snap(targetX), z: snap(targetZ) }];
    for (let s = 1; s <= maxShift; s++) {
      candidates.push({ shift: +s, x: snap(targetX + perpX * s), z: snap(targetZ + perpZ * s) });
      candidates.push({ shift: -s, x: snap(targetX - perpX * s), z: snap(targetZ - perpZ * s) });
    }

    let chosen = null;
    let firstBlocker = null;
    for (const c of candidates) {
      const check = checkBoatFootprint(b, c.x, c.z, waterY);
      if (check.ok) { chosen = c; break; }
      if (!firstBlocker) firstBlocker = check.blocker;
    }

    if (!chosen) {
      if (firstBlocker) blockers.push(firstBlocker);
      return {
        ok: false,
        reason: 'NARROW_CHANNEL',
        blockers,
        partial_path: path,
        water_y: waterY,
        message: `Boat path blocked near (${Math.floor(targetX)}, ${waterY}, ${Math.floor(targetZ)}); no clear corridor within ±${maxShift} perpendicular.`,
      };
    }

    path.push({ x: chosen.x, y: boatY, z: chosen.z });
    // Track actual progress along the original direction so the loop
    // terminates even when shifts bend the path off-axis.
    const progressX = chosen.x - curX;
    const progressZ = chosen.z - curZ;
    const projection = progressX * dirX + progressZ * dirZ;
    traveled += Math.max(0.1, projection);
    curX = chosen.x;
    curZ = chosen.z;
  }

  return { ok: true, path, blockers: [], water_y: waterY };
}

/** Per-tick step size when packet-steering (matches vanilla ~8 b/s). */
const PACKET_STEP_PER_TICK = 0.4;
/** Tick interval in ms (matches MC's 20 t/s = 50ms physics). */
const PACKET_TICK_MS = 50;
/** Distance below which we consider a waypoint "reached" and move on. */
const WAYPOINT_ARRIVAL_THRESH = 0.6;
/** Max ticks to spend on a single waypoint before declaring stall. */
const PER_WAYPOINT_TICK_BUDGET = 60; // ~3s

/**
 * Drive the boat through `path` via packet `vehicle_move` + rider
 * `player_input` — the same mechanism vanilla clients use. Natural
 * boat physics, server validates collision. Since the path was
 * precomputed by planBoatPath to avoid all y=water_y obstacles, the
 * server should accept every position we send.
 *
 * For each waypoint:
 *   1. b.look() toward the waypoint (yaw the boat faces).
 *   2. Repeatedly send (vehicle_move, player_input forward=1) in small
 *      increments toward the waypoint, until the boat arrives.
 *   3. Verify the boat entity still exists each tick.
 *
 * PaperMCP is still used as a fallback if vehicle_move steering isn't
 * propelling (e.g. mineflayer's _client.write not available).
 *
 * Returns:
 *   { ok: true, final: {x,y,z}, steps: N, mechanism: 'packet'|'tp' }
 *   { ok: false, broke_at: {x,y,z}, after_steps: N, error: 'BOAT_LOST'|'TP_FAILED'|'STALLED' }
 */
export async function executeBoatPath(b, path, opts = {}) {
  const { executeServerCommand, paperMcpConfig, sleep, log } = opts;
  if (!path || path.length === 0) {
    return { ok: true, final: null, steps: 0, mechanism: 'noop' };
  }

  const safeMoveVehicle = (left, forward) => {
    try { if (typeof b.moveVehicle === 'function') b.moveVehicle(left, forward); } catch {}
  };
  const safeVehicleMove = (nx, ny, nz, yawRad) => {
    try {
      if (b._client && typeof b._client.write === 'function') {
        b._client.write('vehicle_move', {
          x: nx, y: ny, z: nz,
          yaw: yawRad * 180 / Math.PI,
          pitch: 0,
        });
        // Keep mineflayer's local state in sync with what we told the
        // server (mineflayer's onVehicleMove handler isn't always called
        // by Paper 1.21+, so position drifts otherwise).
        if (b.entity && b.entity.position) {
          b.entity.position.x = nx;
          b.entity.position.y = ny;
          b.entity.position.z = nz;
        }
        if (b.vehicle && b.vehicle.position) {
          b.vehicle.position.x = nx;
          b.vehicle.position.y = ny;
          b.vehicle.position.z = nz;
        }
        return true;
      }
    } catch {}
    return false;
  };

  let lastPos = null;
  let mechanism = 'packet';
  for (let i = 0; i < path.length; i++) {
    const wp = path[i];

    // Boat-alive check BEFORE moving.
    if (!b.vehicle || !b.entities[b.vehicle.id]) {
      return { ok: false, error: 'BOAT_LOST', broke_at: lastPos, after_steps: i, mechanism };
    }

    // Face the waypoint once at the start of the leg.
    const here0 = b.entities[b.vehicle.id].position;
    const dx0 = wp.x - here0.x;
    const dz0 = wp.z - here0.z;
    if (Math.hypot(dx0, dz0) > 0.05) {
      const yaw = Math.atan2(-dx0, dz0);
      try { await b.look(yaw, 0, true); } catch { /* non-fatal */ }
    }

    // Step the boat toward the waypoint in PACKET_STEP_PER_TICK
    // increments. Each tick we (a) probe the live boat position,
    // (b) compute a step vector toward wp, (c) emit a vehicle_move
    // packet at the new position + a forward player_input to mark
    // the rider as "W held". Server validates the move against
    // water physics — since the path is precomputed safe, it accepts.
    let ticks = 0;
    let stalled = false;
    let lastDist = Math.hypot(dx0, dz0);
    while (ticks < PER_WAYPOINT_TICK_BUDGET) {
      if (!b.vehicle || !b.entities[b.vehicle.id]) {
        return { ok: false, error: 'BOAT_LOST', broke_at: lastPos, after_steps: i, mechanism };
      }
      const live = b.entities[b.vehicle.id].position;
      const dx = wp.x - live.x;
      const dz = wp.z - live.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= WAYPOINT_ARRIVAL_THRESH) break;
      const norm = dist || 1;
      const nx = live.x + (dx / norm) * PACKET_STEP_PER_TICK;
      const ny = live.y;
      const nz = live.z + (dz / norm) * PACKET_STEP_PER_TICK;
      const yaw = Math.atan2(-dx, dz);
      const sent = safeVehicleMove(nx, ny, nz, yaw);
      safeMoveVehicle(0, 1); // player_input "W held"
      if (!sent) {
        // _client.write unavailable — bail to PaperMCP tp fallback for
        // the remaining path.
        mechanism = 'tp_fallback';
        break;
      }
      await sleep(PACKET_TICK_MS);
      ticks++;
      // Stall detection: if 10 ticks have passed and we haven't gained
      // 0.2b on the target, treat as stalled. This catches the case
      // where the server is silently rejecting our packets.
      if (ticks % 10 === 0) {
        if (lastDist - dist < 0.2) {
          stalled = true;
          break;
        }
        lastDist = dist;
      }
    }
    // Stop propulsion at the leg boundary.
    safeMoveVehicle(0, 0);

    if (mechanism === 'tp_fallback') {
      // Drop into PaperMCP tp for this and remaining waypoints.
      const pmcp = typeof paperMcpConfig === 'function' ? paperMcpConfig() : paperMcpConfig;
      if (!pmcp) {
        return { ok: false, error: 'NO_PAPERMCP', broke_at: lastPos, after_steps: i, mechanism };
      }
      if (!b.vehicle || !b.entities[b.vehicle.id]) {
        return { ok: false, error: 'BOAT_LOST', broke_at: lastPos, after_steps: i, mechanism };
      }
      const here = b.entities[b.vehicle.id].position;
      const bx = Math.floor(here.x);
      const by = Math.floor(here.y);
      const bz = Math.floor(here.z);
      const cmd = `execute positioned ${bx} ${by} ${bz} run tp @e[type=oak_boat,distance=..2,limit=1] ${wp.x.toFixed(3)} ${wp.y.toFixed(3)} ${wp.z.toFixed(3)}`;
      const r = await executeServerCommand(pmcp, cmd).catch(() => ({ ok: false }));
      if (!r || !r.ok) {
        if (log) log(`[boat-path] tp fallback step failed at step ${i + 1}/${path.length}`);
        return { ok: false, error: 'TP_FAILED', broke_at: lastPos ?? { x: here.x, y: here.y, z: here.z }, after_steps: i, mechanism };
      }
      if (b.entity && b.entity.position) {
        b.entity.position.x = wp.x;
        b.entity.position.y = wp.y;
        b.entity.position.z = wp.z;
      }
      if (b.vehicle && b.vehicle.position) {
        b.vehicle.position.x = wp.x;
        b.vehicle.position.y = wp.y;
        b.vehicle.position.z = wp.z;
      }
      await sleep(TP_STEP_INTERVAL_MS);
    } else if (stalled) {
      if (log) log(`[boat-path] packet steering stalled at waypoint ${i + 1}/${path.length}`);
      return { ok: false, error: 'STALLED', broke_at: lastPos, after_steps: i, mechanism };
    }

    lastPos = wp;
  }

  // Final boat-alive check.
  if (!b.vehicle || !b.entities[b.vehicle.id]) {
    return { ok: false, error: 'BOAT_LOST', broke_at: lastPos, after_steps: path.length, mechanism };
  }
  return { ok: true, final: lastPos, steps: path.length, mechanism };
}

/**
 * Decide whether a blocker cell is safe to clear automatically. The
 * planner's caller can use this to filter blockers before invoking
 * the bot's dig() — we never want to mine grass blocks (someone's
 * lawn), stone (might be cave roof), or ores.
 */
export function isDisposableBlocker(blocker) {
  return !!blocker && DISPOSABLE_BLOCK_NAMES.has(blocker.name);
}

/**
 * Best-effort sail toward `target` when planBoatPath couldn't find a
 * precomputable path. Sends packet vehicle_move + player_input forward
 * each tick, but FIRST probes the next cell for a solid block — if
 * the next step would clip an obstacle, halt rather than crash the
 * boat. Continues until target is reached, stall, or boat dies.
 *
 * This is the safety net for complex terrain where the BFS waypoints
 * thread through narrow corridors that planBoatPath rejects as
 * NARROW_CHANNEL. The boat moves slower and may stall against a wall,
 * but the precomputed-path's strict "must shift to a safe lane" rule
 * doesn't apply — natural physics handles drift around obstacles.
 *
 * Returns the same shape as executeBoatPath.
 */
export async function bestEffortSail(b, target, opts = {}) {
  const { sleep, log } = opts;
  if (!b.vehicle || !b.entities[b.vehicle.id]) {
    return { ok: false, error: 'BOAT_LOST', broke_at: null, after_steps: 0, mechanism: 'best_effort' };
  }

  const safeMoveVehicle = (left, forward) => {
    try { if (typeof b.moveVehicle === 'function') b.moveVehicle(left, forward); } catch {}
  };
  const safeVehicleMove = (nx, ny, nz, yawRad) => {
    try {
      if (b._client && typeof b._client.write === 'function') {
        b._client.write('vehicle_move', { x: nx, y: ny, z: nz, yaw: yawRad * 180 / Math.PI, pitch: 0 });
        if (b.entity && b.entity.position) { b.entity.position.x = nx; b.entity.position.y = ny; b.entity.position.z = nz; }
        if (b.vehicle && b.vehicle.position) { b.vehicle.position.x = nx; b.vehicle.position.y = ny; b.vehicle.position.z = nz; }
        return true;
      }
    } catch {}
    return false;
  };

  const ARRIVAL_THRESH = 1.5; // best-effort uses looser arrival
  const STEP_SIZE = 0.4;
  const TICK_MS = 50;
  const MAX_TICKS = 1200;       // ~60s wallclock
  const STALL_WINDOW = 20;      // ticks without progress
  const STALL_GAIN = 0.4;        // need at least this much closer per STALL_WINDOW

  let ticks = 0;
  let lastDist = null;
  let stallCounter = 0;
  let startPos = b.entities[b.vehicle.id].position.clone();

  while (ticks < MAX_TICKS) {
    if (!b.vehicle || !b.entities[b.vehicle.id]) {
      return { ok: false, error: 'BOAT_LOST', broke_at: startPos, after_steps: ticks, mechanism: 'best_effort' };
    }
    const live = b.entities[b.vehicle.id].position;
    const dx = target.x - live.x;
    const dz = target.z - live.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= ARRIVAL_THRESH) {
      safeMoveVehicle(0, 0);
      return { ok: true, final: { x: live.x, y: live.y, z: live.z }, steps: ticks, mechanism: 'best_effort' };
    }
    const norm = dist || 1;
    const nx = live.x + (dx / norm) * STEP_SIZE;
    const ny = live.y;
    const nz = live.z + (dz / norm) * STEP_SIZE;

    // Collision probe: if the next cell is solid at boat-y (or one
    // below where the hitbox dips), don't push the boat into it.
    const probeY = Math.floor(live.y); // boat-y cell
    const probeYBelow = probeY - 1;    // hitbox-dip cell
    let blocked = false;
    let blocker = null;
    try {
      const ahead = b.blockAt(new Vec3(Math.floor(nx), probeY, Math.floor(nz)));
      const aheadBelow = b.blockAt(new Vec3(Math.floor(nx), probeYBelow, Math.floor(nz)));
      const solid = (blk) => blk && !AIR_NAMES.has(blk.name) && !WATER_NAMES.has(blk.name) && blk.boundingBox === 'block';
      if (solid(ahead)) { blocked = true; blocker = { x: Math.floor(nx), y: probeY, z: Math.floor(nz), name: ahead.name }; }
      else if (solid(aheadBelow)) { blocked = true; blocker = { x: Math.floor(nx), y: probeYBelow, z: Math.floor(nz), name: aheadBelow.name }; }
    } catch { /* probe failed (unloaded chunk) — fall through and try */ }

    if (blocked) {
      // Refuse this step. Try a small perpendicular nudge (±1) before
      // declaring stall — vanilla boats slip around small obstructions.
      const perpX = -dz / norm;
      const perpZ = dx / norm;
      let nudged = false;
      for (const side of [1, -1]) {
        const tx = live.x + perpX * side * STEP_SIZE;
        const tz = live.z + perpZ * side * STEP_SIZE;
        try {
          const blk = b.blockAt(new Vec3(Math.floor(tx), probeY, Math.floor(tz)));
          const blkBelow = b.blockAt(new Vec3(Math.floor(tx), probeYBelow, Math.floor(tz)));
          const isSolid = (x) => x && !AIR_NAMES.has(x.name) && !WATER_NAMES.has(x.name) && x.boundingBox === 'block';
          if (!isSolid(blk) && !isSolid(blkBelow)) {
            const yaw = Math.atan2(-(perpX * side), perpZ * side);
            safeVehicleMove(tx, ny, tz, yaw);
            safeMoveVehicle(0, 1);
            nudged = true;
            break;
          }
        } catch {}
      }
      if (!nudged) {
        // Truly walled — declare stall.
        safeMoveVehicle(0, 0);
        if (log) log(`[boat-path best_effort] blocked by ${blocker?.name} at ${blocker?.x},${blocker?.y},${blocker?.z}; halting`);
        return { ok: false, error: 'STALLED', broke_at: { x: live.x, y: live.y, z: live.z }, blocker, after_steps: ticks, mechanism: 'best_effort' };
      }
    } else {
      const yaw = Math.atan2(-dx, dz);
      const sent = safeVehicleMove(nx, ny, nz, yaw);
      safeMoveVehicle(0, 1);
      if (!sent) {
        return { ok: false, error: 'NO_PACKET_WRITE', broke_at: { x: live.x, y: live.y, z: live.z }, after_steps: ticks, mechanism: 'best_effort' };
      }
    }

    await sleep(TICK_MS);
    ticks++;

    // Stall detection.
    if (lastDist === null) {
      lastDist = dist;
    } else if (ticks % STALL_WINDOW === 0) {
      const gain = lastDist - dist;
      if (gain < STALL_GAIN) {
        safeMoveVehicle(0, 0);
        if (log) log(`[boat-path best_effort] stalled (gained ${gain.toFixed(2)}b in ${STALL_WINDOW} ticks); halting`);
        return { ok: false, error: 'STALLED', broke_at: { x: live.x, y: live.y, z: live.z }, after_steps: ticks, mechanism: 'best_effort' };
      }
      lastDist = dist;
    }
  }

  safeMoveVehicle(0, 0);
  return { ok: false, error: 'TIMEOUT', broke_at: { x: b.entities[b.vehicle?.id]?.position?.x ?? 0, y: 0, z: b.entities[b.vehicle?.id]?.position?.z ?? 0 }, after_steps: ticks, mechanism: 'best_effort' };
}
