/**
 * Unit tests for _nav-helpers.js — focused on findStandableSameXZ (#102
 * Y-grace). The other helpers are exercised indirectly via world-split
 * and movement tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { findStandableSameXZ, targetChunkLoaded } from '../lib/actions/_nav-helpers.js';

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
