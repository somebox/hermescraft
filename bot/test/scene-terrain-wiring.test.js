/**
 * Production-wiring test for buildLandscapeContext -> classifyTerrain.
 *
 * The classifyTerrain unit fixtures (scene-terrain-kind.test.js) feed feetY
 * and surfaceY on the same plane by hand — they never caught that the live
 * wiring mixed planes. These tests drive the REAL pipeline with mineflayer-
 * realistic geometry: a bot standing on the block at block_y B has
 * pos.y = B + 1 (its feet cell), and blockAt(feet cell) is NOT the ground.
 *
 * History: before the plane fix, flat ground classified as `flat` or
 * `mound_1` depending on ground cover — a passable grass plant in the feet
 * cell happened to read as "the surface" (fvlg=0 → flat), while bare ground
 * scanned through to the supporting block (fvlg=+1 → mound_1). See the
 * Phase 9 postmortems (data/postmortems/establish-2026-06-03-phase9/) and
 * the surface-y-consistency plan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { buildLandscapeContext } from '../lib/shared/scene-landscape.js';

const GROUND_Y = 78; // block_y of the ground; feet cell = 79

function makeBot(blockAtFn, { feetY = GROUND_Y + 1 } = {}) {
  return {
    entity: { position: new Vec3(0.5, feetY, 0.5) },
    blockAt: (p) => blockAtFn(p) || { name: 'air', boundingBox: 'empty', position: p },
    registry: null,
    game: { minY: -64, height: 384 },
    findBlocks: () => [],
  };
}

function flatWorld(groundName = 'grass_block') {
  return (p) => {
    if (p.y <= GROUND_Y) return { name: p.y === GROUND_Y ? groundName : 'stone', boundingBox: 'block', position: p };
    return null;
  };
}

test('wiring: bare flat ground classifies as flat with feet_vs_local_ground=0', () => {
  const bot = makeBot(flatWorld());
  const land = buildLandscapeContext(bot);
  assert.equal(land.feet_vs_local_ground, 0,
    'standing on the local ground block must read as 0 (was +1 before the plane fix)');
  assert.equal(land.terrain_kind, 'flat');
});

test('wiring: plant-covered flat ground classifies identically to bare ground', () => {
  const base = flatWorld();
  const bot = makeBot((p) => {
    // short_grass decoration in every feet-level cell (plains ground cover).
    if (p.y === GROUND_Y + 1) return { name: 'short_grass', boundingBox: 'empty', position: p };
    return base(p);
  });
  const land = buildLandscapeContext(bot);
  assert.equal(land.feet_vs_local_ground, 0);
  assert.equal(land.terrain_kind, 'flat',
    'classification must not depend on ground cover');
});

test('wiring: standing on a placed cobblestone pad classifies as on_structure', () => {
  const bot = makeBot((p) => {
    if (p.y === GROUND_Y) return { name: 'cobblestone', boundingBox: 'block', position: p };
    if (p.y < GROUND_Y) return { name: 'stone', boundingBox: 'block', position: p };
    return null;
  });
  const land = buildLandscapeContext(bot);
  assert.equal(land.terrain_kind, 'on_structure');
  assert.equal(land.feet_vs_local_ground, 0);
});

test('wiring: bot under a solid roof (cave) classifies as underground', () => {
  // Bot stands on stone at y=78 inside a cave; the world surface above the
  // cave roof is at y=90 across the whole area (no cardinal egress).
  const bot = makeBot((p) => {
    if (p.y === 90) return { name: 'grass_block', boundingBox: 'block', position: p };
    if (p.y <= GROUND_Y || (p.y > 82 && p.y < 90)) {
      return { name: 'stone', boundingBox: 'block', position: p };
    }
    return null;
  });
  const land = buildLandscapeContext(bot);
  // Ground scan from above finds the terrain over the roof: fvlg << 0.
  assert.ok(land.feet_vs_local_ground <= -3,
    `expected fvlg <= -3, got ${land.feet_vs_local_ground}`);
  assert.equal(land.terrain_kind, 'underground');
});

test('wiring: cardinal relief deltas are 0 on level ground (feet plane vs feet plane)', () => {
  const bot = makeBot(flatWorld());
  const land = buildLandscapeContext(bot);
  assert.deepEqual(
    { N: land.relief.N, E: land.relief.E, S: land.relief.S, W: land.relief.W },
    { N: 0, E: 0, S: 0, W: 0 },
    'level terrain must report zero deltas (was -1 per cardinal before the plane fix)');
});
