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

import { planWaterRoute, _internals } from '../../lib/runtime/water-route.js';

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

// ─── F21: NO_WATER_ROUTE surfaces walkable shore stance ────────────────

test('planWaterRoute: NO_WATER_ROUTE returns nearest_shore_stance (walkable) alongside nearest_water_candidate', () => {
  // F21 (task #59, v42): pre-fix the body shipped a WATER coord in
  // nearest_water_candidate. mc bg_goto refuses water cells as
  // NAV_TARGET_UNSTANDABLE; the agent fell back to mc move and
  // overshot into open water (v41 postmortem).
  //
  // Fixture: bot in a dry area (no water within the 12b entry radius);
  // far water at (30, 62, 0) is navigable; shore stance at (31, 63, 0)
  // is walkable (stone below, air foot+head). findBlocks returns the
  // far water cell so the body's wide-scan promotes it as the
  // nearest_water_candidate. We assert BOTH coords are present in
  // observed_state, and that the stance is genuinely walkable
  // (different from the water cell).
  const blocks = {};
  // Bot stands on grass at (0, 63, 0) — entire 12b entry radius is dry.
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      blocks[`${dx},62,${dz}`] = 'grass_block';
      blocks[`${dx},63,${dz}`] = 'air';
      blocks[`${dx},64,${dz}`] = 'air';
    }
  }
  // Far water at (30, 62, 0): navigable cell (water foot, air x2 above,
  // water below).
  blocks['30,62,0'] = 'water';
  blocks['30,63,0'] = 'air';
  blocks['30,64,0'] = 'air';
  blocks['30,61,0'] = 'water';
  // Shore stance at (31, ?, 0) — findEntryShore checks dy=0 (sy=water.y)
  // first: foot at (31, 62, 0) must be air|water, head at (31, 63, 0)
  // must be air, below at (31, 61, 0) must be solid non-water.
  blocks['31,61,0'] = 'stone';
  blocks['31,62,0'] = 'air';
  blocks['31,63,0'] = 'air';

  const bot = {
    blockAt({ x, y, z }) {
      const k = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
      const name = blocks[k];
      if (!name) return null;
      const boundingBox = (name === 'water' || name === 'flowing_water' || name === 'air' || name === 'cave_air' || name === 'void_air')
        ? 'empty'
        : 'block';
      return { name, boundingBox };
    },
    // Return the far water cell so the F10 widened-scan promotes it.
    findBlocks() {
      return [{ x: 30, y: 62, z: 0 }];
    },
  };

  const r = planWaterRoute(bot, { x: 0, y: 63, z: 0 }, { x: 100, y: 63, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_WATER_ROUTE');
  // Both candidate (water) and stance (walkable) must be present.
  assert.deepEqual(
    { x: r.error.observed_state.nearest_water_candidate.x, y: r.error.observed_state.nearest_water_candidate.y, z: r.error.observed_state.nearest_water_candidate.z },
    { x: 30, y: 62, z: 0 },
    'nearest_water_candidate should be the far water cell',
  );
  assert.ok(r.error.observed_state.nearest_shore_stance,
    `nearest_shore_stance must be present alongside nearest_water_candidate; got: ${JSON.stringify(r.error.observed_state)}`);
  const stance = r.error.observed_state.nearest_shore_stance;
  // Stance must be the walkable cell (31, 62, 0) — air foot above stone.
  assert.deepEqual({ x: stance.x, y: stance.y, z: stance.z }, { x: 31, y: 62, z: 0 },
    `expected shore stance at (31, 62, 0); got ${JSON.stringify(stance)}`);
  // Critical: stance must NOT equal the water cell — that's the whole
  // point of F21. Pre-fix this assertion would fail because the only
  // coord exposed was the water cell.
  const candidate = r.error.observed_state.nearest_water_candidate;
  assert.notDeepEqual(
    { x: stance.x, y: stance.y, z: stance.z },
    { x: candidate.x, y: candidate.y, z: candidate.z },
    'shore stance MUST differ from water candidate — agent needs a dry cell',
  );
  // Message should mention the walkable shore so the agent can read it
  // straight off the error string.
  assert.ok(r.error.message.includes('Walkable shore'),
    `message should advertise walkable shore; got: ${r.error.message}`);
});

// ─── F27 (task #66, v43): isShoreCell rejects water-foot cells ──────────
//
// circuit-v43 forensics: bot drowned at (345, 62, -541) — a 1-deep water
// tile with dirt below. Pre-F27 `isShoreCell` accepted foot=water (the
// stale "foot can be water" exception), so findEntryShore returned this
// wet cell as the entry shore. The pathfinder walked Steve there, F3
// caught "you're in water," and the same wet shore was picked on every
// retry. Bot could never start a journey.
//
// These tests pin isShoreCell's contract directly via the `_internals`
// export so the regression is locked in regardless of how higher-level
// planner code routes around it.

function makeBlockBot(blocks) {
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

test('isShoreCell: foot=water with solid below is NOT a shore (F27 — was the v43 bug)', () => {
  // Exact geometry from the v43 failure at (345, 62, -541):
  //   foot at y=62: water (1-deep, dirt fills y=61 below)
  //   head at y=63: air
  //   below at y=61: dirt (solid, not water)
  // Pre-F27 this returned true (bot drowned). Post-F27 it must return
  // false — the bot would be submerged here.
  const bot = makeBlockBot({
    '0,61,0': 'dirt',
    '0,62,0': 'water',
    '0,63,0': 'air',
  });
  assert.equal(_internals.isShoreCell(bot, 0, 62, 0), false,
    'F27 regression: a 1-deep water tile on solid ground is NOT a dry shore');
});

test('isShoreCell: standard dry shore (foot=air, below=grass) IS a shore', () => {
  // Sanity: the canonical shore shape — air foot, grass underneath,
  // air above — must still pass.
  const bot = makeBlockBot({
    '0,61,0': 'grass_block',
    '0,62,0': 'air',
    '0,63,0': 'air',
  });
  assert.equal(_internals.isShoreCell(bot, 0, 62, 0), true);
});

test('isShoreCell: natural beach (sand at water-y, air above) — sy=y fails, sy=y+1 passes (F16 still works)', () => {
  // The F16 case: sand block AT the water-y level (so cell at y=62 is
  // sand, not water), with walkable air above at y=63. The bot stands
  // on top of the sand. F27 must not break this — the foot=sand check
  // at sy=62 still fails (sand is solid, not air), and the F16 dy=+1
  // retry at sy=63 still passes.
  const bot = makeBlockBot({
    '0,62,0': 'sand',
    '0,63,0': 'air',
    '0,64,0': 'air',
  });
  // sy=62: foot=sand → fail (not air).
  assert.equal(_internals.isShoreCell(bot, 0, 62, 0), false,
    'foot=sand is not a shore at the same y as water');
  // sy=63: foot=air, head=air at 64, below=sand at 62 (solid not-water) → pass.
  assert.equal(_internals.isShoreCell(bot, 0, 63, 0), true,
    'F16 sloped-beach: shore stance is one above the sand');
});

test('isShoreCell: foot=air but below=water is NOT a shore (would drown when boat unloads)', () => {
  // Mid-lake "floating" cell — air at foot but water directly below
  // means there's no solid ground. Already covered pre-F27 but pin it
  // explicitly so the F27 rewrite doesn't accidentally regress.
  const bot = makeBlockBot({
    '0,61,0': 'water',
    '0,62,0': 'air',
    '0,63,0': 'air',
  });
  assert.equal(_internals.isShoreCell(bot, 0, 62, 0), false);
});

test('isShoreCell: head not clear → NOT a shore', () => {
  // Foot=air, below=stone (good so far), but head=stone (overhead block).
  // Bot can't stand here.
  const bot = makeBlockBot({
    '0,61,0': 'stone',
    '0,62,0': 'air',
    '0,63,0': 'stone',
  });
  assert.equal(_internals.isShoreCell(bot, 0, 62, 0), false);
});

test('findEntryShore: maxRadius=1 returns null when only far shores exist (F38 — v50 OUT_OF_RANGE prevention)', () => {
  // circuit-v50 forensics: BFS picked entry_water=(316,62,-565) for
  // sail_to. findEntryShore (F30 default radius 4) returned a shore
  // 4 blocks away at (312,63,-565). walk_to_entry walked the bot
  // there; place_boat then needed to reach 4 blocks east to the
  // entry_water and refused OUT_OF_RANGE. The bot was BETWEEN
  // entry_shore and entry_water with no path to fix it.
  //
  // F38: for sail_to's internal use, findEntryShore must return
  // ONLY adjacent shores (cardinals + diagonals at ring 1). If no
  // adjacent shore exists, return null so the caller's fallback
  // (bot's start position) kicks in and walk_to_entry becomes a
  // no-op. F30's wider spiral is preserved for the F21 hint callers
  // via opts.maxRadius=4 default.
  const blocks = {};
  // Surround the water cell with water-on-water (no shore at all
  // adjacent in ring 1).
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      blocks[`${dx},61,${dz}`] = 'water';
      blocks[`${dx},62,${dz}`] = 'water';
      blocks[`${dx},63,${dz}`] = 'air';
    }
  }
  // True grass shore 4 blocks east (Chebyshev distance 4).
  blocks['4,61,0'] = 'dirt';
  blocks['4,62,0'] = 'grass_block';
  blocks['4,63,0'] = 'air';
  blocks['4,64,0'] = 'air';
  const bot = makeBlockBot(blocks);
  // Default behaviour (radius 4) still finds the far shore — F30 hint
  // path stays functional.
  const wide = _internals.findEntryShore(bot, { x: 0, y: 62, z: 0 });
  assert.deepEqual(wide, { x: 4, y: 63, z: 0 },
    `F30 hint path: default radius should still find far shore; got ${JSON.stringify(wide)}`);
  // F38: maxRadius=1 returns null when no adjacent shore exists.
  // sail_to's BFS use site passes this option.
  const tight = _internals.findEntryShore(bot, { x: 0, y: 62, z: 0 }, { maxRadius: 1 });
  assert.equal(tight, null,
    `F38 regression: maxRadius=1 must return null when no shore within 1 block; got ${JSON.stringify(tight)}`);
});

test('findEntryShore: spirals outward when no cardinal neighbor is a shore (F30 — v45 lake-edge case)', () => {
  // circuit-v45 forensics: BFS chose water (317, 62, -579) as the
  // nearest external water cell. All 4 cardinal neighbors at y=62 were
  // also water (1-deep on sand). dy=+1 retries failed because the
  // cells two blocks above water still had water-below. Pre-F30
  // findEntryShore returned null and sail_to handed the agent the
  // bare water coord — which mc bg_goto rejected as NAV_TARGET_UNSTANDABLE.
  // The actual dry shore was 2 blocks east at the bot's own position.
  // Post-F30 the spiral finds it.
  //
  // Fixture: water at (0, 62, 0). All 4 cardinals are water-on-sand.
  // The dry shore (grass at y=62, walkable air at y=63) sits at
  // (2, 63, 0) — Chebyshev distance 2 from the water cell.
  const blocks = {
    // Water cell + 1-deep cardinal neighbors with sand below.
    '0,61,0': 'sand', '0,62,0': 'water', '0,63,0': 'air',
    '1,61,0': 'sand', '1,62,0': 'water', '1,63,0': 'air',
    '-1,61,0': 'sand', '-1,62,0': 'water', '-1,63,0': 'air',
    '0,61,1': 'sand', '0,62,1': 'water', '0,63,1': 'air',
    '0,61,-1': 'sand', '0,62,-1': 'water', '0,63,-1': 'air',
    // Dry shore 2 blocks east — grass at y=62, walkable air above.
    '2,61,0': 'dirt',
    '2,62,0': 'grass_block',
    '2,63,0': 'air',
    '2,64,0': 'air',
  };
  const bot = makeBlockBot(blocks);
  const shore = _internals.findEntryShore(bot, { x: 0, y: 62, z: 0 });
  assert.ok(shore, 'F30 regression: findEntryShore should find a shore via spiral');
  // The found cell must be standable (air foot, solid below, air head).
  // The shore at (2, 63, 0) sits on top of the grass block at (2, 62, 0).
  assert.deepEqual(shore, { x: 2, y: 63, z: 0 },
    `expected (2, 63, 0); got ${JSON.stringify(shore)}`);
});

test('findEntryShore: cardinal-neighbor early-return prefers air-foot over water-foot (F27 pre/post pin)', () => {
  // Direct test of findEntryShore: when both a wet "shore" (water-foot
  // with solid below) AND a dry shore exist as cardinal neighbors of
  // an entry_water cell, post-F27 must return the dry one and pre-F27
  // would have returned the wet one. We pin the contract here so the
  // ordering of cardinal directions doesn't ever mask the bug again.
  //
  // Geometry: entry_water at (0, 62, 0). East (1, 62, 0) = 1-deep
  // water with dirt below — the wet "shore" that bit v43. West
  // (-1, 62, 0) = grass_block (foot=grass, walkable at sy+1=63).
  const blocks = {
    // Entry water cell + its required navigability below.
    '0,61,0': 'water',
    '0,62,0': 'water',
    '0,63,0': 'air',
    // East: wet "shore" (1-deep water on dirt).
    '1,61,0': 'dirt',
    '1,62,0': 'water',
    '1,63,0': 'air',
    // West: TRUE grass shore (sy+1 dry-foot pattern).
    '-1,61,0': 'dirt',
    '-1,62,0': 'grass_block',
    '-1,63,0': 'air',
    '-1,64,0': 'air',
  };
  const bot = makeBlockBot(blocks);
  const shore = _internals.findEntryShore(bot, { x: 0, y: 62, z: 0 });
  // Must be the WEST grass shore (-1, 63, 0). Pre-F27 the cardinal
  // iteration order [+x, -x, +z, -z] would have returned the east
  // wet "shore" (1, 62, 0) immediately and never reached west.
  assert.ok(shore, 'findEntryShore should return a dry shore here');
  const footName = blocks[`${shore.x},${shore.y},${shore.z}`];
  assert.notEqual(footName, 'water',
    `F27 regression: findEntryShore returned wet cell (${shore.x},${shore.y},${shore.z})`);
  assert.deepEqual(shore, { x: -1, y: 63, z: 0 },
    `expected the west grass shore at (-1, 63, 0); got ${JSON.stringify(shore)}`);
});

// ─── F16: findExitShore checks sloped beach (y+1) ───────────────────────

test('planWaterRoute: natural beach pattern (sand at water-y) → finds shore at y+1', () => {
  // F16 (task #54): pre-fix, findExitShore rejected this scenario as
  // TARGET_NOT_REACHABLE_FROM_WATER because the only cell adjacent to
  // the water (sand at the water's y level) failed isShoreCell (foot
  // is the solid sand block, not air/water). Real shores have the
  // walkable space ONE ABOVE the sand — findEntryShore already does
  // this dual check; findExitShore now mirrors it.
  const blocks = {};
  // Short water channel from x=0..4 at y=61..62 along z=0.
  for (let x = 0; x <= 4; x++) {
    blocks[`${x},62,0`] = 'water';
    blocks[`${x},61,0`] = 'water';
    blocks[`${x},63,0`] = 'air';
    blocks[`${x},64,0`] = 'air';
  }
  // Entry shore at (0, 62, -1) — standard pattern.
  blocks['0,61,-1'] = 'stone';
  blocks['0,62,-1'] = 'air';
  blocks['0,63,-1'] = 'air';
  blocks['0,64,-1'] = 'air';
  // East end of channel (x=5, z=0): NATURAL BEACH PATTERN — sand at
  // the water's y (contains the channel water), walkable air ABOVE.
  // Pre-F16, findExitShore only checked the water's y (foot=sand →
  // reject) and refused this beach as unreachable.
  blocks['5,61,0'] = 'stone';     // sub-floor under sand
  blocks['5,62,0'] = 'sand';      // beach surface at water-y (contains water at x≤4)
  blocks['5,63,0'] = 'air';       // walkable space ABOVE the sand
  blocks['5,64,0'] = 'air';
  const bot = makeStubBot(blocks);
  // Target sits beyond the beach (x=12) so BFS doesn't early-exit
  // before exploring the channel's east end. The body's findExitShore
  // then finds the beach at (5, 63, 0) as the best within-radius shore.
  // Without F16, the same fixture would fail: (5, 62, 0) is sand
  // (foot=solid → rejected by isShoreCell at sy=c.y) and no other
  // shore exists near target.
  const r = planWaterRoute(bot, { x: 0, y: 63, z: -1 }, { x: 12, y: 63, z: 0 });
  assert.equal(r.ok, true, `expected ok with sloped exit_shore: ${JSON.stringify(r)}`);
  // The exit shore must be at y=63 (one above the sand) — the bot's
  // walkable position. Pre-F16 the BFS rejected the beach entirely.
  assert.equal(r.data.exit_shore.y, 63,
    `expected exit_shore.y=63 (above sand); got ${r.data.exit_shore.y}`);
  assert.equal(r.data.exit_shore.x, 5);
  assert.equal(r.data.exit_shore.z, 0);
});

// ─── task #66 (B3): collision-aware exit_shore scoring ───────────────────

test('planWaterRoute (B3): prefers clean exit_water over one adjacent to a y=water_y obstacle', () => {
  // Two viable exits at equal target-distance, EACH with its own
  // exit_water cell:
  //   - +z exit_water=(10, 62, 1): has dirt at (10, 62, 2) as a
  //     direct neighbour → boat hitbox would clip → B3 penalty.
  //   - -z exit_water=(10, 62, -1): clean neighbourhood.
  // Both shores are equidistant from the target (20, 63, 0). With
  // the obstacle penalty the clean -z exit wins.
  const blocks = {};
  // Large water body (>100 cells so we're past POND_DISCONNECTED):
  // a 12×12 pool around the +z and -z branches at x=10. Water at
  // y=62 and y=61, air above.
  for (let x = 0; x <= 11; x++) {
    for (let z = -6; z <= 6; z++) {
      blocks[`${x},62,${z}`] = 'water';
      blocks[`${x},61,${z}`] = 'water';
      blocks[`${x},63,${z}`] = 'air';
      blocks[`${x},64,${z}`] = 'air';
    }
  }
  // +z exit candidate: dirt at (10, 62, 7) at y=water_y — adjacent
  // to candidate exit_water (10, 62, 6). Shore above the dirt.
  blocks['10,62,7'] = 'dirt';
  blocks['10,63,7'] = 'air';
  blocks['10,64,7'] = 'air';
  blocks['10,61,7'] = 'stone';
  // -z exit candidate: clean stone shore at (10, 62, -7) — solid foot,
  // shore-cell predicate picks dy=+1. exit_water on this side is
  // (10, 62, -6).
  blocks['10,62,-7'] = 'stone';
  blocks['10,63,-7'] = 'air';
  blocks['10,64,-7'] = 'air';
  blocks['10,61,-7'] = 'stone';
  // Entry shore at (-1, 63, 0).
  blocks['-1,62,0'] = 'stone';
  blocks['-1,63,0'] = 'air';
  blocks['-1,64,0'] = 'air';

  const bot = makeStubBot(blocks);
  // Target at (10, 63, 0) (centre of the pool) — both candidate exits
  // are equidistant: +z shore at (10, 63, 7) is 7b away; -z shore
  // at (10, 63, -7) is also 7b away. With B3's obstacle penalty
  // (+z exit_water adjacent to dirt at y=62) the clean -z wins.
  const r = planWaterRoute(bot, { x: -1, y: 63, z: 0 }, { x: 10, y: 63, z: 0 });
  assert.equal(r.ok, true, `expected ok: ${JSON.stringify(r)}`);
  assert.equal(r.data.exit_shore.z, -7,
    `expected exit_shore.z=-7 (clean side); got ${r.data.exit_shore.z}`);
});

// ─── task #66: dense cells_path field exposes the full BFS water-cell chain ───

test('planWaterRoute: data.cells_path contains every BFS cell from entry to exit', () => {
  // Straight channel of 12 water cells; cells_path should have all 12,
  // each cardinal-adjacent to the next.
  const blocks = {};
  for (let z = 0; z <= 11; z++) {
    blocks[`5,62,${z}`] = 'water';
    blocks[`5,61,${z}`] = 'water';
    blocks[`5,63,${z}`] = 'air';
    blocks[`5,64,${z}`] = 'air';
  }
  // Entry shore at (5, 63, -1).
  blocks['5,62,-1'] = 'stone';
  blocks['5,63,-1'] = 'air';
  blocks['5,64,-1'] = 'air';
  // Exit shore at (5, 63, 12).
  blocks['5,62,12'] = 'stone';
  blocks['5,63,12'] = 'air';
  blocks['5,64,12'] = 'air';

  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: 5, y: 63, z: -1 }, { x: 5, y: 63, z: 12 });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.data.cells_path), 'cells_path must be an array');
  assert.ok(r.data.cells_path.length >= 12, `expected >=12 cells, got ${r.data.cells_path.length}`);
  // First cell = entry_water, last cell = exit_water.
  const first = r.data.cells_path[0];
  const last = r.data.cells_path[r.data.cells_path.length - 1];
  assert.deepEqual({ x: first.x, y: first.y, z: first.z }, r.data.entry_water);
  assert.deepEqual({ x: last.x, y: last.y, z: last.z }, r.data.exit_water);
  // Every consecutive pair is cardinal-adjacent at the same y.
  for (let i = 1; i < r.data.cells_path.length; i++) {
    const a = r.data.cells_path[i - 1];
    const b = r.data.cells_path[i];
    assert.equal(a.y, b.y, `cells_path[${i}]: y must match (boat doesn't climb)`);
    const dx = Math.abs(a.x - b.x);
    const dz = Math.abs(a.z - b.z);
    assert.ok(dx + dz === 1, `cells_path[${i}]: must be cardinal-adjacent, got dx=${dx} dz=${dz}`);
  }
});

// ─── task #66 (B4): BFS allows 1-deep shallow water (boat-passable) ──────

test('planWaterRoute (B4): reaches a target shore behind a 1-deep approach', () => {
  // Channel: navigable (2-deep) until z=8, then a 2-cell stretch of
  // 1-deep water (sand floor at y=61) approaching the shore at z=11.
  // Pre-B4, BFS refused to expand into the 1-deep cells → exit_shore
  // null → TARGET_NOT_REACHABLE_FROM_WATER. With B4, BFS expands
  // through the shallow approach and finds the shore.
  const blocks = {};
  for (let z = 0; z <= 8; z++) {
    blocks[`5,62,${z}`] = 'water';
    blocks[`5,61,${z}`] = 'water';
    blocks[`5,63,${z}`] = 'air';
    blocks[`5,64,${z}`] = 'air';
  }
  // 1-deep shallow approach at z=9, 10 (sand floor).
  for (const z of [9, 10]) {
    blocks[`5,62,${z}`] = 'water';
    blocks[`5,61,${z}`] = 'sand';
    blocks[`5,63,${z}`] = 'air';
    blocks[`5,64,${z}`] = 'air';
  }
  // Target shore at (5, 63, 11) above grass.
  blocks['5,62,11'] = 'grass_block';
  blocks['5,63,11'] = 'air';
  blocks['5,64,11'] = 'air';
  // Entry shore at (5, 63, -1).
  blocks['5,62,-1'] = 'stone';
  blocks['5,63,-1'] = 'air';
  blocks['5,64,-1'] = 'air';

  const bot = makeStubBot(blocks);
  const r = planWaterRoute(bot, { x: 5, y: 63, z: -1 }, { x: 5, y: 63, z: 11 });
  assert.equal(r.ok, true, `expected route via 1-deep approach; got ${JSON.stringify(r)}`);
  assert.equal(r.data.exit_shore.z, 11);
  assert.equal(r.data.exit_shore.y, 63);
});
