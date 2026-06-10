import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
  _groundBlockYAtForTests as groundBlockYAt,
  classifyTerrain,
} from '../lib/shared/scene-landscape.js';

// Realistic geometry: feet cell = feetY, supporting ground block at feetY-1.
function mockBot(blockAtFn, feetY = 79) {
  return {
    entity: { position: new Vec3(4, feetY, 24) },
    blockAt: blockAtFn,
  };
}

test('distant canopy above feet+8 does not set canopyDetected (run-8 prep spawn)', () => {
  const feetY = 79;
  const bot = mockBot((p) => {
    const y = p.y;
    if (y === 78) return { name: 'grass_block', boundingBox: 'block' };
    if (y >= 95) return { name: 'oak_leaves', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  }, feetY);

  const detail = groundBlockYAt(bot, 4, 24, { feetY, returnDetail: true });
  assert.equal(detail.y, 78, 'ground block is the block under the feet cell');
  assert.equal(detail.canopyDetected, false);

  const kind = classifyTerrain({
    deltas: { N: 0, E: 0, S: 0, W: 0 },
    feetY,
    surfaceY: detail.y + 1, // feet plane, as buildLandscapeContext wires it
    canopyDetected: detail.canopyDetected,
    feetBlockName: 'grass_block',
  });
  assert.notEqual(kind.terrain_kind, 'unknown');
  assert.equal(kind.terrain_kind, 'flat');
});

test('canopy in feet+2..feet+8 still marks canopyDetected', () => {
  const feetY = 79;
  const bot = mockBot((p) => {
    const y = p.y;
    if (y === 78) return { name: 'grass_block', boundingBox: 'block' };
    if (y === 85) return { name: 'oak_leaves', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  }, feetY);

  const detail = groundBlockYAt(bot, 4, 24, { feetY, returnDetail: true });
  assert.equal(detail.canopyDetected, true);
});

test('ground cover (short_grass) is skipped — ground is the supporting block, not the plant', () => {
  const feetY = 79;
  const bot = mockBot((p) => {
    const y = p.y;
    if (y === 78) return { name: 'grass_block', boundingBox: 'block' };
    if (y === 79) return { name: 'short_grass', boundingBox: 'empty' };
    return { name: 'air', boundingBox: 'empty' };
  }, feetY);

  const detail = groundBlockYAt(bot, 4, 24, { feetY, returnDetail: true });
  assert.equal(detail.y, 78, 'plant in the feet cell must not register as ground');
});

test('snow_layer is cover, not ground', () => {
  const feetY = 79;
  const bot = mockBot((p) => {
    const y = p.y;
    if (y === 78) return { name: 'grass_block', boundingBox: 'block' };
    if (y === 79) return { name: 'snow', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  }, feetY);

  const detail = groundBlockYAt(bot, 4, 24, { feetY, returnDetail: true });
  assert.equal(detail.y, 78);
});
