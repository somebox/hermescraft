/**
 * Unit tests for _nav-helpers.js — focused on findStandableSameXZ (#102
 * Y-grace). The other helpers are exercised indirectly via world-split
 * and movement tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { findStandableSameXZ } from '../lib/actions/_nav-helpers.js';

// Minimal mock bot exposing blockAt(Vec3). Block model: a 1×W×Z slab of
// stone at y=63 with air everywhere else. The cell (0, 64, 0) is
// therefore standable (foot=air, head=air, below=stone). Y=70 is in
// open air with no support; Y=63 is inside the slab.
function makeMockBot({ groundY = 63, ceilingY = null } = {}) {
  return {
    blockAt(pos) {
      const { x: _x, y, z: _z } = pos;
      // Solid slab at groundY.
      if (y === groundY) return { name: 'stone', boundingBox: 'block' };
      if (ceilingY !== null && y === ceilingY) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
}

test('findStandableSameXZ returns dy=0 when target is already standable', () => {
  const b = makeMockBot({ groundY: 63 });
  const r = findStandableSameXZ(b, 10, 64, 5, 5);
  assert.equal(r?.dy, 0);
  assert.equal(r?.y, 64);
  assert.equal(r?.target_reason, 'ok');
});

test('findStandableSameXZ rescues a target floating in open air by searching DOWN', () => {
  const b = makeMockBot({ groundY: 63 });
  // Target at y=70 has foot air, head air, but below is air too — floating.
  const r = findStandableSameXZ(b, 10, 70, 5, 8);
  assert.ok(r, 'expected a rescue');
  assert.equal(r.y, 64, 'should snap down to ground at y=64');
  assert.equal(r.dy, -6);
  assert.equal(r.target_reason, 'no_foot_support');
});

test('findStandableSameXZ rescues a target buried in solid by searching UP', () => {
  const b = makeMockBot({ groundY: 63 });
  // Target at y=63 is inside the stone slab; rescue should go up to y=64.
  const r = findStandableSameXZ(b, 10, 63, 5, 5);
  assert.ok(r, 'expected a rescue');
  assert.equal(r.y, 64);
  assert.equal(r.dy, 1);
  assert.equal(r.target_reason, 'foot_blocked');
});

test('findStandableSameXZ returns null when no standable Y exists within maxDy', () => {
  // Bot with no ground at all (all air). Nothing to stand on.
  const b = { blockAt: () => ({ name: 'air', boundingBox: 'empty' }) };
  const r = findStandableSameXZ(b, 0, 64, 0, 5);
  assert.equal(r, null);
});

test('findStandableSameXZ respects maxDy bound (does not search beyond)', () => {
  const b = makeMockBot({ groundY: 50 });
  // Ground at y=50, head_blocked target at y=70 — needs dy=-19, but
  // maxDy=5 should refuse the rescue.
  const r = findStandableSameXZ(b, 0, 70, 0, 5);
  assert.equal(r, null);
});
