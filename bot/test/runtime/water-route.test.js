/**
 * Unit tests for water-route BFS planner.
 *
 * Pure-function tests — no live bot required. Mocks blockAt over a
 * key-indexed grid. Tests lock in:
 *
 *   - Continuous navigable channel → returns route
 *   - 5×5 disconnected pond → POND_DISCONNECTED
 *   - Shallow water (no y-1 water) → WATER_TOO_SHALLOW
 *   - Already at target (<4b) → ALREADY_AT_TARGET
 *   - No water at all near start → NO_WATER_ROUTE
 *   - 1-block bridge (solid block over water at Y) → routes around it
 *   - Waypoint spacing — ~1 per 8 blocks
 *
 * See bot/lib/runtime/water-route.js for the planner itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { planWaterRoute } from '../../lib/runtime/water-route.js';

/**
 * Build a stub bot whose blockAt() looks up cells from a {x,y,z → name}
 * map. Anything not in the map returns null (unloaded chunk semantics).
 * The block returned exposes `name` and `boundingBox`; the planner
 * doesn't need anything else.
 */
function makeStubBot(blocks) {
  return {
    blockAt({ x, y, z }) {
      const k = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
      const name = blocks[k];
      if (!name) return null;
      const boundingBox = (name === 'water' || name === 'flowing_water' || name === 'air' || name === 'cave_air' || name === 'void_air')
        ? 'empty'
        : 'block';
      return { name, boundingBox };
    },
  };
}

/**
 * Build a channel of navigable water along the X axis from x0..x1
 * at y=62. Includes:
 *   - y=62 water (foot)
 *   - y=63 air (clearance)
 *   - y=61 water (depth — boat doesn't ground)
 *   - shores at z=-1 and z=1 (stone, with air above and a stone block
 *     below) so the planner can find entry/exit shores.
 */
function makeChannel(x0, x1, y = 62) {
  const blocks = {};
  for (let x = x0; x <= x1; x++) {
    blocks[`${x},${y},0`] = 'water';
    blocks[`${x},${y + 1},0`] = 'air';
    blocks[`${x},${y + 2},0`] = 'air';  // 2-block rider clearance
    blocks[`${x},${y - 1},0`] = 'water';
    // Shore cells at z=-1 and z=1: stone block at y-1, air above.
    for (const sz of [-1, 1]) {
      blocks[`${x},${y - 1},${sz}`] = 'stone';
      blocks[`${x},${y},${sz}`] = 'air';
      blocks[`${x},${y + 1},${sz}`] = 'air';
      blocks[`${x},${y + 2},${sz}`] = 'air';
    }
  }
  return blocks;
}

// ─── Happy path ──────────────────────────────────────────────────────────

test('planWaterRoute: navigable channel returns route with entry, exit, waypoints', () => {
  const blocks = makeChannel(0, 100);
  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: 0, y: 63, z: -1 }, { x: 100, y: 63, z: -1 });
  assert.equal(r.ok, true, `expected ok: ${JSON.stringify(r)}`);
  assert.ok(r.data.entry_water, 'entry_water present');
  assert.ok(r.data.exit_water, 'exit_water present');
  assert.ok(r.data.entry_shore, 'entry_shore present');
  assert.ok(r.data.exit_shore, 'exit_shore present');
  assert.ok(r.data.waypoints.length >= 6,
    `expected ≥6 waypoints for a 100b channel, got ${r.data.waypoints.length}`);
  // Entry water should be near start; exit water should be near target.
  assert.ok(r.data.entry_water.x <= 12, `entry too far from start: ${r.data.entry_water.x}`);
  assert.ok(r.data.exit_water.x >= 88, `exit too far from target: ${r.data.exit_water.x}`);
  // Horizontal distance should reflect actual water-cell-count traversed.
  assert.ok(r.data.horizontal_distance > 80,
    `horizontal_distance should be ~100; got ${r.data.horizontal_distance}`);
  assert.ok(r.data.estimated_seconds > 30, 'estimated_seconds should be > overhead');
});

test('planWaterRoute: bot already in water uses current cell as entry', () => {
  const blocks = makeChannel(0, 50);
  const bot = makeStubBot(blocks);
  // Bot at (10, 62, 0) — IN the channel water.
  const r = planWaterRoute(bot, { x: 10, y: 62, z: 0 }, { x: 50, y: 63, z: -1 });
  assert.equal(r.ok, true);
  assert.equal(r.data.entry_water.x, 10);
  assert.equal(r.data.entry_water.z, 0);
});

// ─── Pond refusal ────────────────────────────────────────────────────────

test('planWaterRoute: tiny 5×5 pond → POND_DISCONNECTED', () => {
  const blocks = {};
  // 5×5 pond at y=62, with y=63+y=64 air and y=61 water (depth ok).
  // Target is 100 blocks away — clearly unreachable from the pond.
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      blocks[`${x},62,${z}`] = 'water';
      blocks[`${x},63,${z}`] = 'air';
      blocks[`${x},64,${z}`] = 'air';
      blocks[`${x},61,${z}`] = 'water';
    }
  }
  // Shore cell at (-1, 62, 0) — bot stands here.
  blocks['-1,61,0'] = 'stone';
  blocks['-1,62,0'] = 'air';
  blocks['-1,63,0'] = 'air';
  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: -1, y: 63, z: 0 }, { x: 100, y: 63, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'POND_DISCONNECTED');
  assert.match(r.error.message, /tiny pond|cells reachable/i);
  assert.ok(r.error.observed_state.cells_in_pond < 50);
});

// ─── Shallow water ───────────────────────────────────────────────────────

test('planWaterRoute: shallow water (no y-1 water) → WATER_TOO_SHALLOW', () => {
  const blocks = {};
  // Water at (5, 62, 0) but sand at (5, 61, 0) — boat would ground.
  blocks['5,62,0'] = 'water';
  blocks['5,63,0'] = 'air';
  blocks['5,61,0'] = 'sand';
  // Surround with more shallow water so the planner doesn't bail on
  // "no water at all" — we want it to see shallow water specifically.
  for (let x = 4; x <= 8; x++) {
    for (let z = -1; z <= 1; z++) {
      blocks[`${x},62,${z}`] = 'water';
      blocks[`${x},63,${z}`] = 'air';
      blocks[`${x},64,${z}`] = 'air';
      blocks[`${x},61,${z}`] = 'sand';
    }
  }
  // Shore cell at (3, 63, 0) — bot stands here.
  blocks['3,62,0'] = 'stone';
  blocks['3,63,0'] = 'air';
  blocks['3,64,0'] = 'air';
  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: 3, y: 63, z: 0 }, { x: 100, y: 63, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'WATER_TOO_SHALLOW');
  assert.match(r.error.message, /shallow|ground/i);
});

// ─── No water at all ─────────────────────────────────────────────────────

test('planWaterRoute: no water in entry radius → NO_WATER_ROUTE', () => {
  const blocks = {};
  // Bot on land in a dry area — no water cells anywhere.
  blocks['0,62,0'] = 'grass_block';
  blocks['0,63,0'] = 'air';
  blocks['0,64,0'] = 'air';
  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: 0, y: 63, z: 0 }, { x: 100, y: 63, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_WATER_ROUTE');
});

// ─── Already at target ───────────────────────────────────────────────────

test('planWaterRoute: target within 4b → ALREADY_AT_TARGET', () => {
  const blocks = {};
  blocks['0,62,0'] = 'grass_block';
  blocks['0,63,0'] = 'air';
  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: 0, y: 63, z: 0 }, { x: 2, y: 63, z: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ALREADY_AT_TARGET');
});

// ─── Routes around a 1-block bridge ──────────────────────────────────────

test('planWaterRoute: 1-block bridge across channel — BFS routes around it', () => {
  // Build a 2-wide channel from x=0..50 with water at z=0 and z=1.
  // Place a single 1-block bridge (oak_planks) at (25, 62, 0) blocking
  // the z=0 lane. BFS should route via z=1.
  const blocks = {};
  for (let x = 0; x <= 50; x++) {
    for (const z of [0, 1]) {
      blocks[`${x},62,${z}`] = 'water';
      blocks[`${x},63,${z}`] = 'air';
      blocks[`${x},64,${z}`] = 'air';
      blocks[`${x},61,${z}`] = 'water';
    }
    blocks[`${x},61,-1`] = 'stone';
    blocks[`${x},62,-1`] = 'air';
    blocks[`${x},63,-1`] = 'air';
    blocks[`${x},64,-1`] = 'air';
    blocks[`${x},61,2`] = 'stone';
    blocks[`${x},62,2`] = 'air';
    blocks[`${x},63,2`] = 'air';
    blocks[`${x},64,2`] = 'air';
  }
  // Bridge: solid block at (25, 62, 0). The cell becomes unnavigable.
  blocks['25,62,0'] = 'oak_planks';
  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: -1, y: 63, z: 0 }, { x: 50, y: 63, z: 0 });
  assert.equal(r.ok, true, `expected ok with detour: ${JSON.stringify(r)}`);
  // The path should NOT include the bridge cell (25, 62, 0).
  const passesBridgeCell = r.data.waypoints.some(w => w.x === 25 && w.z === 0);
  assert.equal(passesBridgeCell, false,
    `route should bypass the bridge cell, but waypoints include it: ${JSON.stringify(r.data.waypoints)}`);
});

// ─── Elevated pier at y+2 ────────────────────────────────────────────────

test('planWaterRoute: elevated pier at y+2 across channel — BFS routes around it', () => {
  // Regression: circuit-v25 saw Steve sail head-first into a long pier
  // whose deck was at y+2 above open water at y. The y+1-only clearance
  // check let those cells pass; rider's head collided with the deck.
  //
  // 2-wide channel from x=0..50 at z=0 and z=1. A pier deck spans the
  // z=0 lane at y=64 (i.e. y+2 above the water surface): solid oak_planks
  // at (25, 64, 0). Cells under the pier still have water at y=62 and
  // air at y=63, so the old check thought they were navigable. New check
  // also requires air at y=64. BFS must route through z=1.
  const blocks = {};
  for (let x = 0; x <= 50; x++) {
    for (const z of [0, 1]) {
      blocks[`${x},62,${z}`] = 'water';
      blocks[`${x},63,${z}`] = 'air';
      blocks[`${x},64,${z}`] = 'air';
      blocks[`${x},61,${z}`] = 'water';
    }
    blocks[`${x},61,-1`] = 'stone';
    blocks[`${x},62,-1`] = 'air';
    blocks[`${x},63,-1`] = 'air';
    blocks[`${x},64,-1`] = 'air';
    blocks[`${x},61,2`] = 'stone';
    blocks[`${x},62,2`] = 'air';
    blocks[`${x},63,2`] = 'air';
    blocks[`${x},64,2`] = 'air';
  }
  // Pier deck at y=64 (head height for the rider) at (25, 64, 0).
  blocks['25,64,0'] = 'oak_planks';
  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: -1, y: 63, z: 0 }, { x: 50, y: 63, z: 0 });
  assert.equal(r.ok, true, `expected ok with detour: ${JSON.stringify(r)}`);
  // The route should bypass the cell beneath the pier deck — even though
  // the water at y=62 is open, the rider's head would clip the deck.
  const passesUnderPier = r.data.waypoints.some(w => w.x === 25 && w.z === 0);
  assert.equal(passesUnderPier, false,
    `route should detour around the elevated pier, but waypoints include it: ${JSON.stringify(r.data.waypoints)}`);
});

// ─── Waypoint spacing ────────────────────────────────────────────────────

test('planWaterRoute: waypoints spaced ~8 blocks apart along the path', () => {
  const blocks = makeChannel(0, 80);
  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: 0, y: 63, z: -1 }, { x: 80, y: 63, z: -1 });
  assert.equal(r.ok, true);
  const wp = r.data.waypoints;
  assert.ok(wp.length >= 8, `expected ≥8 waypoints across 80b, got ${wp.length}`);
  // Consecutive waypoints should be within ~10 blocks of each other.
  for (let i = 1; i < wp.length; i++) {
    const d = Math.hypot(wp[i].x - wp[i - 1].x, wp[i].z - wp[i - 1].z);
    assert.ok(d <= 10,
      `waypoint gap too large at index ${i}: ${d}b (expected ≤10). Waypoints: ${JSON.stringify(wp)}`);
  }
});
