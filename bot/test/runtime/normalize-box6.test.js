import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInclusiveBox6, toBlockPos } from '../../lib/runtime/coordinates.js';

describe('normalizeInclusiveBox6', () => {
  it('swaps inverted corners and computes inclusive volume', () => {
    const n = normalizeInclusiveBox6({ x1: 5, y1: 3, z1: 7, x2: 2, y2: 4, z2: 6 });
    assert.deepEqual(n.min, { x: 2, y: 3, z: 6 });
    assert.deepEqual(n.max, { x: 5, y: 4, z: 7 });
    assert.equal(n.volume, 4 * 2 * 2);
    assert.equal(n.x1, 2);
    assert.equal(n.x2, 5);
  });

  it('single-cell box has volume 1', () => {
    const n = normalizeInclusiveBox6({ x1: 1, y1: 64, z1: 1, x2: 1, y2: 64, z2: 1 });
    assert.equal(n.volume, 1);
  });
});

describe('toBlockPos', () => {
  it('accepts triple array and object', () => {
    assert.deepEqual(toBlockPos([10, 64, -3]), { x: 10, y: 64, z: -3 });
    assert.deepEqual(toBlockPos({ x: 10.9, y: 64.1, z: 0 }), { x: 10, y: 64, z: 0 });
  });

  it('returns null for bad input', () => {
    assert.equal(toBlockPos(null), null);
    assert.equal(toBlockPos([1, 2]), null);
    assert.equal(toBlockPos({ x: 1 }), null);
  });
});
