import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
  _surfaceYAtForTests as surfaceYAt,
  classifyTerrain,
} from '../lib/shared/scene-landscape.js';

function mockBot(blockAtFn, feetY = 79) {
  return {
    entity: { position: new Vec3(4, feetY + 0.5, 24) },
    blockAt: blockAtFn,
  };
}

test('distant canopy above feet+8 does not set canopyDetected (run-8 prep spawn)', () => {
  const feetY = 79;
  const bot = mockBot((p) => {
    const y = p.y;
    if (y === 79) return { name: 'grass_block' };
    if (y >= 95) return { name: 'oak_leaves' };
    return { name: 'air' };
  }, feetY);

  const detail = surfaceYAt(bot, 4, 24, { feetY, returnDetail: true });
  assert.equal(detail.y, 79);
  assert.equal(detail.canopyDetected, false);

  const kind = classifyTerrain({
    deltas: { N: 0, E: 0, S: 0, W: 0 },
    feetY,
    surfaceY: detail.y,
    canopyDetected: detail.canopyDetected,
    feetBlockName: 'grass_block',
  });
  assert.notEqual(kind.terrain_kind, 'unknown');
});

test('canopy in feet+2..feet+8 still marks canopyDetected', () => {
  const feetY = 79;
  const bot = mockBot((p) => {
    const y = p.y;
    if (y === 79) return { name: 'grass_block' };
    if (y === 85) return { name: 'oak_leaves' };
    return { name: 'air' };
  }, feetY);

  const detail = surfaceYAt(bot, 4, 24, { feetY, returnDetail: true });
  assert.equal(detail.canopyDetected, true);
});
