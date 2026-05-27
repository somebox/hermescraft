/**
 * Unit tests for _nav-helpers.js — focused on findStandableSameXZ (#102
 * Y-grace). The other helpers are exercised indirectly via world-split
 * and movement tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { findStandableSameXZ, targetChunkLoaded, findAdjustedTarget, standingState } from '../lib/actions/_nav-helpers.js';

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

// ─────────────────────────────────────────────────────────────────────────
// standingState — step_down classification fix.
//
// Bug: a bot on a 1-block bump in flat grass had every cardinal neighbour's
// (feet-1) be air (grass surface sits at feet-2). The old neighborStatus
// returned 'no_support' for all 4 directions → 'on_pillar' classification
// → mc move refused with BOT_ON_PILLAR. Mason hit this 69× across 25
// sessions, 24× at the single spot (436, 67, -619). The recommended
// `mc pillar_down` mines the supporting block — destructive descent for
// what should be a free 1-block step-off.
//
// Fix: neighborStatus probes up to 3 blocks down (pathfinder's default
// maxCumulativeDropDown). Safe drops with a clear fall column return
// 'step_down', exposed as step_down_dirs, and excluded from cliff_dirs.
// ─────────────────────────────────────────────────────────────────────────

// Mock bot. `at(x,y,z) -> name` describes terrain; default is 'air'.
// Bot is centered in the cell at (cell.x, cell.y, cell.z).
function makeStandingMockBot(cell, at = () => 'air') {
  const AIR_LIKE = new Set(['air', 'cave_air', 'void_air']);
  return {
    entity: { position: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 } },
    blockAt(pos) {
      const name = at(pos.x, pos.y, pos.z) || 'air';
      // Anything non-air is treated as a full block for these tests. The
      // production code distinguishes water/lava via boundingBox; tests
      // that care about those set boundingBox explicitly via `at`
      // returning an object.
      if (typeof name === 'object') return name;
      return { name, boundingBox: AIR_LIKE.has(name) ? 'empty' : 'block' };
    },
  };
}

test('standingState: 1-block bump in flat grass → "open", step_down on all 4 sides (not on_pillar)', () => {
  // The Mason regression case. Bot at (5,65,5) standing on a single
  // grass block at (5,64,5). Surrounding terrain is grass at y=63 —
  // a 1-block drop in every cardinal direction.
  const at = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'grass_block';
    if (y === 63) return 'grass_block';
    return 'air';
  };
  const ss = standingState(makeStandingMockBot({ x: 5, y: 65, z: 5 }, at));
  assert.equal(ss.classification, 'open', `expected open, got ${ss.classification}`);
  assert.deepEqual([...ss.cliff_dirs].sort(), [], 'no true cliffs');
  assert.deepEqual([...ss.step_down_dirs].sort(), ['E', 'N', 'S', 'W'], 'all 4 dirs are safe step-downs');
});

test('standingState: true 1×1 pillar (no ground within 3 blocks) → "on_pillar"', () => {
  // Bot at (5,65,5) on a stone block at (5,64,5). NO other ground for
  // many blocks down. This is what on_pillar should fire on.
  const at = (x, y, z) => (x === 5 && y === 64 && z === 5 ? 'stone' : 'air');
  const ss = standingState(makeStandingMockBot({ x: 5, y: 65, z: 5 }, at));
  assert.equal(ss.classification, 'on_pillar');
  assert.deepEqual([...ss.cliff_dirs].sort(), ['E', 'N', 'S', 'W']);
  assert.deepEqual([...ss.step_down_dirs].sort(), []);
});

test('standingState: 2-block drop on all sides → "open" via step_down', () => {
  // Bump at y=64, surrounding ground at y=62 (2-block drop).
  const at = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'stone';
    if (y === 62) return 'stone';
    return 'air';
  };
  const ss = standingState(makeStandingMockBot({ x: 5, y: 65, z: 5 }, at));
  assert.equal(ss.classification, 'open');
  assert.deepEqual([...ss.step_down_dirs].sort(), ['E', 'N', 'S', 'W']);
});

test('standingState: 3-block drop (at pathfinder default cap) → "open" via step_down', () => {
  // Bump at y=64, ground at y=61. by-dy where dy=4 → y=61. Within the
  // dy=2..4 probe range; should classify as step_down.
  const at = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'stone';
    if (y === 61) return 'stone';
    return 'air';
  };
  const ss = standingState(makeStandingMockBot({ x: 5, y: 65, z: 5 }, at));
  assert.equal(ss.classification, 'open');
  assert.deepEqual([...ss.step_down_dirs].sort(), ['E', 'N', 'S', 'W']);
});

test('standingState: 4+ block drop on all sides → "on_pillar" (beyond safe-drop cap)', () => {
  // Bump at y=64, ground at y=60 (4-block drop). Past our probe range.
  const at = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'stone';
    if (y === 60) return 'stone';
    return 'air';
  };
  const ss = standingState(makeStandingMockBot({ x: 5, y: 65, z: 5 }, at));
  assert.equal(ss.classification, 'on_pillar');
  assert.deepEqual([...ss.cliff_dirs].sort(), ['E', 'N', 'S', 'W']);
});

test('standingState: water in the fall column blocks step_down (true cliff)', () => {
  // Bump at y=64, water at y=63, stone at y=62 on the sides. Bot must
  // not classify these as safe step-downs — water changes physics
  // (swimming, not clean drop) and submerged-dig guards trip easily.
  const at = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'stone';
    if (y === 63 && !(x === 5 && z === 5)) return { name: 'water', boundingBox: 'empty' };
    if (y === 62 && !(x === 5 && z === 5)) return 'stone';
    return 'air';
  };
  const ss = standingState(makeStandingMockBot({ x: 5, y: 65, z: 5 }, at));
  assert.equal(ss.classification, 'on_pillar');
  assert.deepEqual([...ss.step_down_dirs].sort(), []);
});

test('standingState: mixed neighbours — 1 wall + 1 open + 2 step_downs → "open"', () => {
  // Bump at (5,64,5). Wall to N at (5,65,4)+(5,66,4). Open to E means
  // grass at the same Y as the bump: grass at (6,64,5). Step-down to
  // S and W (grass surface at y=63).
  const at = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'grass_block';   // bump under bot
    if (x === 5 && (y === 65 || y === 66) && z === 4) return 'stone';  // N wall
    if (x === 6 && y === 64 && z === 5) return 'grass_block';   // E walk-level
    if (y === 63 && (x === 4 || z === 6)) return 'grass_block'; // S/W ground
    return 'air';
  };
  const ss = standingState(makeStandingMockBot({ x: 5, y: 65, z: 5 }, at));
  assert.equal(ss.classification, 'open');
  assert.deepEqual([...ss.blocked_dirs].sort(), ['N']);
  assert.deepEqual([...ss.open_dirs].sort(), ['E']);
  assert.deepEqual([...ss.step_down_dirs].sort(), ['S', 'W']);
  assert.deepEqual([...ss.cliff_dirs].sort(), []);
});

test('standingState: edge classification only for TRUE cliffs (not step_downs)', () => {
  // Bot on grass at y=64 next to a real cliff to N (drop > 3). Other
  // dirs walkable. Pre-fix this would be 'edge' even for a 1-block
  // step-down to the N. Post-fix the N must be a real cliff.
  const at = (x, y, z) => {
    // Ground at y=64 for the bot's cell + S/E/W neighbours
    if (y === 64 && (z >= 5 || x !== 5)) return 'grass_block';
    // North is a true cliff: bot at (5,65,5), N neighbour (5,*,4) is
    // all air down to y=50.
    if (y === 50 && z === 4) return 'stone';
    return 'air';
  };
  const ss = standingState(makeStandingMockBot({ x: 5, y: 65, z: 5 }, at));
  assert.equal(ss.classification, 'edge');
  assert.deepEqual([...ss.cliff_dirs], ['N']);
  assert.deepEqual([...ss.step_down_dirs].sort(), []);
});

test('standingState: 1-block step-down adjacent to a real cliff is still safe — no "edge"', () => {
  // Bot on grass at y=64 (cell 5,65,5). To N a 1-block drop: (5,64,4)
  // is air, landing at (5,63,4)=grass. To E a true cliff: column
  // (6,*,5) is air all the way down. S and W are walk-level (grass at
  // y=64). Pre-fix: cliff_dirs would include N and E → 'edge'. Post-
  // fix: only E counts; N is a step_down.
  const at = (x, y, z) => {
    // Bot's floor + walk-level S/W
    if (y === 64 && z === 5 && (x === 5 || x === 4)) return 'grass_block';
    if (y === 64 && x === 5 && z === 6) return 'grass_block';
    // N step-down landing one block lower
    if (y === 63 && x === 5 && z === 4) return 'grass_block';
    // E column (x=6, z=5) is air all the way down (true cliff).
    return 'air';
  };
  const ss = standingState(makeStandingMockBot({ x: 5, y: 65, z: 5 }, at));
  assert.equal(ss.classification, 'edge', 'one real cliff to E → edge');
  assert.deepEqual([...ss.cliff_dirs], ['E']);
  assert.deepEqual([...ss.step_down_dirs], ['N']);
});
