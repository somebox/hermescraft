import test from 'node:test';
import assert from 'node:assert/strict';
import { canSeeBlockFaces, standardBlockFacePoints } from '../../lib/actions/_los.js';

test('standardBlockFacePoints returns seven samples', () => {
  const pts = standardBlockFacePoints(1, 64, 2);
  assert.equal(pts.length, 7);
});

test('canSeeBlockFaces skips when fairPlay false', () => {
  assert.equal(canSeeBlockFaces(null, 0, 0, 0, { fairPlay: false }), true);
});

test('canSeeBlockFaces uses hasLineOfSight', () => {
  let calls = 0;
  const ok = canSeeBlockFaces(
    {},
    5, 64, 5,
    {
      fairPlay: true,
      eyePosition: () => ({ x: 4, y: 65, z: 5 }),
      hasLineOfSight: () => { calls++; return true; },
    },
  );
  assert.equal(ok, true);
  assert.ok(calls >= 1);
});

test('canSeeBlockFaces false when all faces blocked', () => {
  const ok = canSeeBlockFaces(
    {},
    0, 64, 0,
    {
      fairPlay: true,
      eyePosition: () => ({ x: 0, y: 65, z: 0 }),
      hasLineOfSight: () => false,
    },
  );
  assert.equal(ok, false);
});
