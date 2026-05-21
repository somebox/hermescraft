/**
 * Unit tests for _nav-helpers.js — focused on findStandableSameXZ (#102
 * Y-grace). The other helpers are exercised indirectly via world-split
 * and movement tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { findStandableSameXZ, targetChunkLoaded, findAdjustedTarget } from '../lib/actions/_nav-helpers.js';

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

// ─────────────────────────────────────────────────────────────────────────
// targetChunkLoaded — used by preflightNav to decide whether to bypass
// the NAV_TARGET_UNSTANDABLE error for long-distance targets in unloaded
// chunks. Round-A expedition test: brain issued mc bg_goto 1552 64 352
// from base at (350, -595). The target is ~1500 blocks away — outside
// the bot's ~160-block loaded-chunk radius. Without bypass, preflight
// always refused. Now: if every block-probe in the target column returns
// null, we know the chunk's unloaded and pathfinder should run anyway.
// ─────────────────────────────────────────────────────────────────────────

test('targetChunkLoaded returns true when target column has a non-null block', () => {
  const b = makeMockBot({ groundY: 63 });
  assert.equal(targetChunkLoaded(b, 10, 64, 5, 5), true);
});

test('targetChunkLoaded returns false when all probes return null (unloaded chunk)', () => {
  // Simulate an unloaded chunk: blockAt returns null for any Vec3.
  const b = { blockAt: () => null };
  assert.equal(targetChunkLoaded(b, 1552, 64, 352, 5), false);
});

test('targetChunkLoaded returns true if even ONE probe in the column is non-null', () => {
  // Realistic edge: bot has rendered the surface y=64 block at the
  // chunk-load boundary but Y=-3 below is still null. One hit is enough.
  let calls = 0;
  const b = {
    blockAt: (pos) => {
      calls++;
      return pos.y === 64 ? { name: 'grass_block', boundingBox: 'block' } : null;
    },
  };
  assert.equal(targetChunkLoaded(b, 0, 64, 0, 5), true);
  // Should short-circuit: doesn't probe all 11 cells once it finds one.
  assert.ok(calls < 11, `expected short-circuit, got ${calls} probes`);
});

test('targetChunkLoaded is defensive against blockAt throwing', () => {
  const b = {
    blockAt: () => { throw new Error('mineflayer internal: chunk pending'); },
  };
  // Throwing for every probe means we never saw a block — same as null.
  assert.equal(targetChunkLoaded(b, 0, 64, 0, 5), false);
});

test('targetChunkLoaded respects maxDy bound', () => {
  // Only Y=70 has a block. With maxDy=2 (probes Y=62-66), nothing found.
  // With maxDy=10 (probes Y=54-74), the y=70 block IS in range.
  const b = {
    blockAt: (pos) => (pos.y === 70 ? { name: 'stone', boundingBox: 'block' } : null),
  };
  assert.equal(targetChunkLoaded(b, 0, 64, 0, 2), false);
  assert.equal(targetChunkLoaded(b, 0, 64, 0, 10), true);
});

// ─────────────────────────────────────────────────────────────────────────
// findAdjustedTarget — generic "find nearest cell matching predicate"
// helper that primitives (place_boat, place, till, plant, bucket_*) use
// to accept "approximately right" coords. See task #7.
// ─────────────────────────────────────────────────────────────────────────

test('findAdjustedTarget: returns original (distance=0, adjusted=false) when predicate matches', () => {
  // Predicate matches immediately at the target — happy path.
  const isWater = (_b, x, y, z) => x === 10 && y === 64 && z === 5;
  const r = findAdjustedTarget(null, isWater, 10, 64, 5);
  assert.equal(r.adjusted, false);
  assert.equal(r.distance, 0);
  assert.deepEqual({ x: r.x, y: r.y, z: r.z }, { x: 10, y: 64, z: 5 });
  assert.deepEqual(r.original, { x: 10, y: 64, z: 5 });
});

test('findAdjustedTarget: returns nearest match within radius (adjusted=true)', () => {
  // Predicate matches at (1, 0, 0) — distance 1 from (0, 0, 0).
  const matches = (_b, x, y, z) => x === 1 && y === 0 && z === 0;
  const r = findAdjustedTarget(null, matches, 0, 0, 0);
  assert.equal(r.adjusted, true);
  assert.equal(r.distance, 1);
  assert.deepEqual({ x: r.x, y: r.y, z: r.z }, { x: 1, y: 0, z: 0 });
  assert.deepEqual(r.original, { x: 0, y: 0, z: 0 });
});

test('findAdjustedTarget: spiral order — picks closest match', () => {
  // Two matches: (3, 0, 0) (distance 3) and (1, 0, 0) (distance 1).
  // Helper must return the closer one.
  const matches = (_b, x, y, z) => (x === 1 && y === 0 && z === 0)
                                || (x === 3 && y === 0 && z === 0);
  const r = findAdjustedTarget(null, matches, 0, 0, 0);
  assert.deepEqual({ x: r.x, y: r.y, z: r.z }, { x: 1, y: 0, z: 0 });
  assert.equal(r.distance, 1);
});

test('findAdjustedTarget: returns null past radius', () => {
  // Match exists at (5, 0, 0) but maxRadius=3 means we can't reach it.
  const matches = (_b, x, _y, _z) => x === 5;
  const r = findAdjustedTarget(null, matches, 0, 0, 0, 3);
  assert.equal(r, null);
});

test('findAdjustedTarget: defensive — predicate throws → treats as miss', () => {
  // Predicate throws on every call — should not crash, just return null
  // (no match anywhere).
  const throwy = () => { throw new Error('mocked blockAt failure'); };
  const r = findAdjustedTarget(null, throwy, 0, 0, 0);
  assert.equal(r, null);
});

test('findAdjustedTarget: respects custom maxRadius', () => {
  // Match at distance 2: in range with maxRadius=2, out with maxRadius=1.
  const matches = (_b, x, _y, _z) => x === 2;
  assert.ok(findAdjustedTarget(null, matches, 0, 0, 0, 2) !== null);
  assert.equal(findAdjustedTarget(null, matches, 0, 0, 0, 1), null);
});

test('findAdjustedTarget: tie-break is deterministic across nearby same-distance cells', () => {
  // Multiple matches at distance 1 ({+X}, {-X}, {+Y}, {-Y}, {+Z}, {-Z}).
  // Result must be deterministic — same call twice gives same answer.
  const matches = (_b, x, y, z) => Math.abs(x) + Math.abs(y) + Math.abs(z) === 1;
  const r1 = findAdjustedTarget(null, matches, 0, 0, 0);
  const r2 = findAdjustedTarget(null, matches, 0, 0, 0);
  assert.deepEqual({ x: r1.x, y: r1.y, z: r1.z }, { x: r2.x, y: r2.y, z: r2.z });
});

test('findAdjustedTarget: coerces non-int radius safely', () => {
  // Defensive: maxRadius=1.7 → floors to 1; negative → 0 (returns null
  // unless predicate matches at the target).
  const matches = () => false;
  assert.equal(findAdjustedTarget(null, matches, 0, 0, 0, -5), null);
  assert.equal(findAdjustedTarget(null, matches, 0, 0, 0, 0), null);
});
