import test from 'node:test';
import assert from 'node:assert/strict';
import { blockRef, validateBlockRef } from '../../lib/shared/typed-nouns.js';

test('blockRef builds pos, dist, and bearing from origin', () => {
  const ref = blockRef(
    { name: 'cobblestone', x: 10, y: 64, z: 12 },
    { x: 0, y: 64, z: 0 },
    { reachable: true },
  );
  assert.equal(ref.name, 'cobblestone');
  assert.deepEqual(ref.pos, { x: 10, y: 64, z: 12 });
  assert.equal(typeof ref.dist, 'number');
  assert.equal(ref.bearing, 'southeast');
  assert.equal(ref.reachable, true);
});

test('validateBlockRef accepts a well-formed ref', () => {
  const ref = blockRef({ name: 'dirt', x: 1, y: 2, z: 3 }, { x: 0, y: 2, z: 0 });
  const v = validateBlockRef(ref);
  assert.equal(v.valid, true);
  assert.equal(v.issues.length, 0);
});

test('validateBlockRef rejects missing pos', () => {
  const v = validateBlockRef({ name: 'air' });
  assert.equal(v.valid, false);
  assert.ok(v.issues.some((i) => i.includes('pos')));
});
