import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpatial } from '../lib/spatial.js';

test('getCardinal maps deltas to compass labels (MC +X east, +Z south)', () => {
  const spatial = createSpatial({
    ensureBot: () => {
      throw new Error('ensureBot should not run in this unit test');
    },
    fmt: (v) => v,
    posObj: () => ({ x: 0, y: 0, z: 0 }),
  });
  assert.equal(spatial.getCardinal(0, -1), 'N');
  assert.equal(spatial.getCardinal(1, 0), 'E');
  assert.equal(spatial.getCardinal(0, 1), 'S');
  assert.equal(spatial.getCardinal(-1, 0), 'W');
});
