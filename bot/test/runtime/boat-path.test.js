/**
 * Unit tests for boat-path planner.
 *
 * Pure-function tests with a stub bot whose blockAt() reads from a
 * grid of {x,y,z → name}. Cover:
 *   - Clean corridor produces a straight stepped path.
 *   - Obstacle at midpoint → planner shifts perpendicular and rejoins.
 *   - Narrow channel (obstacle within ±max_shift columns) → returns
 *     NARROW_CHANNEL with blockers.
 *   - Boat-footprint collision check: solid block at y=water_y blocks
 *     placement; water below water_y doesn't matter.
 *   - Starting cell that isn't water → NOT_ON_WATER.
 *
 * See bot/lib/runtime/boat-path.js for the planner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planBoatPath,
  checkBoatFootprint,
  isDisposableBlocker,
  BOAT_VERTICAL_OFFSET,
} from '../../lib/runtime/boat-path.js';

/** Build a stub bot whose blockAt reads cell names from a grid map. */
function makeStubBot(blocks) {
  return {
    blockAt({ x, y, z }) {
      const k = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
      const name = blocks[k];
      if (!name) return null;
      const boundingBox = (name === 'water' || name === 'flowing_water'
        || name === 'air' || name === 'cave_air' || name === 'void_air'
        || name === 'seagrass' || name === 'tall_seagrass'
        || name === 'kelp' || name === 'kelp_plant')
        ? 'empty'
        : 'block';
      return { name, boundingBox };
    },
  };
}

/** Fill a rectangular slab with `name`. y is a single layer. */
function fillSlab(blocks, x1, x2, y, z1, z2, name) {
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
    for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
      blocks[`${x},${y},${z}`] = name;
    }
  }
}

test('planBoatPath — clean corridor returns straight stepped path', () => {
  // 10-wide × 20-long water channel at y=62. Boat sails from
  // (5.5, 63.0625, -10.5) to (5.5, 63.0625, 9.5).
  const blocks = {};
  fillSlab(blocks, 0, 10, 62, -15, 15, 'water');
  const bot = makeStubBot(blocks);

  const res = planBoatPath(bot,
    { x: 5.5, y: 63.0625, z: -10.5 },
    { x: 5.5, y: 63.0625, z: 9.5 },
  );

  assert.equal(res.ok, true);
  assert.equal(res.water_y, 62);
  assert.ok(res.path.length >= 10, `expected >=10 steps, got ${res.path.length}`);
  // Every step is at boat_y = water_y + 1.0625.
  for (const step of res.path) {
    assert.equal(step.y, 62 + BOAT_VERTICAL_OFFSET);
    // X stays on the start column (5.5) — clean corridor, no shifts.
    assert.equal(step.x, 5.5);
  }
  // Last step should be near the target.
  const last = res.path[res.path.length - 1];
  assert.ok(Math.abs(last.z - 9.5) < 1.6, `last z=${last.z} not near target z=9.5`);
});

test('planBoatPath — obstacle at midpoint forces perpendicular shift', () => {
  // 5-wide channel; a single solid block at (5, 62, 0) — the boat's
  // straight-line path goes through this. Planner should shift ±1.
  const blocks = {};
  fillSlab(blocks, 3, 7, 62, -10, 10, 'water');
  blocks['5,62,0'] = 'dirt'; // obstacle on the straight line

  const bot = makeStubBot(blocks);
  const res = planBoatPath(bot,
    { x: 5.5, y: 63.0625, z: -8.5 },
    { x: 5.5, y: 63.0625, z: 8.5 },
  );

  assert.equal(res.ok, true);
  // Some step in the path should have shifted off x=5.5 to avoid the
  // dirt block. Either x=4.5 or x=6.5 around z≈0.
  const shifted = res.path.find((s) => Math.abs(s.z) < 2 && s.x !== 5.5);
  assert.ok(shifted, `expected a perpendicular shift near z=0; path: ${JSON.stringify(res.path)}`);
});

test('planBoatPath — narrow channel returns NARROW_CHANNEL with blocker', () => {
  // 3-wide channel: x=4,5,6 water; everything outside is dirt at
  // y=62. A solid block at (5, 62, 0) AND (4, 62, 0) AND (6, 62, 0)
  // — full wall across — blocks all shifts.
  const blocks = {};
  fillSlab(blocks, 4, 6, 62, -10, 10, 'water');
  // Wall at z=0 spans the whole channel.
  blocks['4,62,0'] = 'dirt';
  blocks['5,62,0'] = 'dirt';
  blocks['6,62,0'] = 'dirt';

  const bot = makeStubBot(blocks);
  const res = planBoatPath(bot,
    { x: 5.5, y: 63.0625, z: -8.5 },
    { x: 5.5, y: 63.0625, z: 8.5 },
  );

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'NARROW_CHANNEL');
  assert.ok(res.blockers.length > 0, 'expected blockers array');
  // The blocker should reference one of the dirt cells at z=0.
  assert.equal(res.blockers[0].name, 'dirt');
  assert.equal(res.blockers[0].y, 62);
});

test('planBoatPath — start cell not water returns NOT_ON_WATER', () => {
  const blocks = {};
  fillSlab(blocks, 0, 5, 62, 0, 5, 'water');
  // No water at the starting cell.
  const bot = makeStubBot(blocks);
  const res = planBoatPath(bot,
    { x: 10.5, y: 63.0625, z: 10.5 }, // not in water
    { x: 2.5, y: 63.0625, z: 2.5 },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'NOT_ON_WATER');
});

test('checkBoatFootprint — solid block at water_y collides', () => {
  const blocks = {};
  blocks['5,62,5'] = 'water';
  blocks['6,62,5'] = 'dirt';  // adjacent solid at hitbox range
  blocks['4,62,5'] = 'water';
  blocks['5,62,6'] = 'water';
  blocks['5,62,4'] = 'water';
  const bot = makeStubBot(blocks);

  // Boat centered at 5.9, 5.5 — hitbox reaches into x=6 cell.
  const check = checkBoatFootprint(bot, 5.9, 5.5, 62);
  assert.equal(check.ok, false);
  assert.equal(check.blocker.name, 'dirt');
  assert.equal(check.blocker.x, 6);
});

test('checkBoatFootprint — water cell, no neighbors checked when centered', () => {
  const blocks = {};
  blocks['5,62,5'] = 'water';
  // Don't define neighbors — they return null (unloaded). isSolid
  // returns false for null, so this should still pass.
  const bot = makeStubBot(blocks);

  // Centered exactly at .5/.5 — hitbox half-width 0.7 stays within
  // the primary cell, side checks don't fire.
  const check = checkBoatFootprint(bot, 5.5, 5.5, 62);
  assert.equal(check.ok, true);
});

test('checkBoatFootprint — seagrass at water_y is fine (boundingBox empty)', () => {
  const blocks = {};
  blocks['5,62,5'] = 'water';
  blocks['6,62,5'] = 'seagrass'; // empty boundingBox — not a collision
  const bot = makeStubBot(blocks);

  const check = checkBoatFootprint(bot, 5.9, 5.5, 62);
  assert.equal(check.ok, true);
});

test('isDisposableBlocker — dirt/sand/gravel yes; grass/stone no', () => {
  assert.equal(isDisposableBlocker({ name: 'dirt' }), true);
  assert.equal(isDisposableBlocker({ name: 'sand' }), true);
  assert.equal(isDisposableBlocker({ name: 'gravel' }), true);
  assert.equal(isDisposableBlocker({ name: 'seagrass' }), true);
  assert.equal(isDisposableBlocker({ name: 'grass_block' }), false);
  assert.equal(isDisposableBlocker({ name: 'stone' }), false);
  assert.equal(isDisposableBlocker({ name: 'oak_log' }), false);
  assert.equal(isDisposableBlocker(null), false);
});

test('planBoatPath — single-step trivial trip', () => {
  const blocks = {};
  fillSlab(blocks, 4, 7, 62, 4, 7, 'water');
  const bot = makeStubBot(blocks);
  const res = planBoatPath(bot,
    { x: 5.5, y: 63.0625, z: 5.5 },
    { x: 5.5, y: 63.0625, z: 5.5 },  // identical start/end
  );
  assert.equal(res.ok, true);
  assert.ok(res.path.length >= 1);
});
