/**
 * Phase 8 Change B regression: `mc move` defaults to a 2-block arrival
 * tolerance when the target is >20 blocks away AND the caller didn't
 * pass `near` AND didn't opt into `strict` mode.
 *
 * Run-4 postmortem (2026-06-03) finding: `mc move` strict cell-match
 * dominates friction (108/231 errors, ~47%). Operator observation:
 * "bg_goto and goto_mark seem to be actually useful" — those verbs are
 * lenient by default; mc move was the outlier. Workers mark a chest at
 * its solid coord then `mc move` to that coord fails "No standable
 * cell" because the cell IS the chest (Pattern A).
 *
 * Verified surfaces:
 *   - preflight radius (the standable-cell search tolerance)
 *   - goal type (GoalNear when lenient, GoalBlock when strict)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createMove } from '../../lib/actions/movement/move.js';

function makeInstrumentedDeps({ bot, ctx, locations = {} }) {
  /** captures across the move call */
  const cap = {
    preRadii: [],     // radii preflightNav was called with
    goalKinds: [],    // 'GoalBlock' | 'GoalNear' (with range)
  };

  class GoalBlock {
    constructor(x, y, z) { this.x = x; this.y = y; this.z = z; cap.goalKinds.push('GoalBlock'); }
  }
  class GoalNear {
    constructor(x, y, z, r) {
      this.x = x; this.y = y; this.z = z; this.range = r;
      cap.goalKinds.push(`GoalNear(${r})`);
    }
  }

  const deps = {
    ctx,
    ensureBot: () => bot,
    goals: { GoalBlock, GoalNear },
    gotoRetryKey: (verb, x, y, z) => `${verb}@${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`,
    gotoRetryCounts: new Map(),
    GOTO_RETRY_LIMIT: 4,
    ACTIONS: {
      through: async () => ({ ok: true, data: { closed: false } }),
      escape: async () => ({ ok: true }),
    },
    recordMoveFailure: () => {},
    clearMoveFailure: () => {},
    clearGotoRetry: () => {},
    pushStuckCell: () => {},
    preflightNav: (b, x, y, z, radius) => {
      cap.preRadii.push(radius);
      return null;
    },
    preNudgeIfSticky: async () => {},
    fmt: (n) => String(Math.round(Number(n))),
    posObj: () => ({
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z,
    }),
    loadLocations: () => locations,
    config: { behaviors: {} },
    services: {},
  };
  return { deps, cap };
}

function makeBotAt(x, y, z) {
  return {
    entity: { position: new Vec3(x + 0.5, y, z + 0.5), isInWater: false },
    pathfinder: {
      movements: {},
      // Pretend pathfinder always succeeds so the function reaches the
      // dist-check at line 365. With `pos` matching the start, dist will
      // be 0 for short-range tests and ~target_distance for long-range
      // tests; we don't need it to "succeed" to verify radius/goal.
      getPathTo: () => ({ status: 'success', path: [] }),
      goto: async () => {},
      setGoal: () => {},
    },
    findBlocks: () => [],
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
  };
}

test('short-range move (≤ 20 blocks) uses GoalBlock and preflight radius 1', async () => {
  const bot = makeBotAt(0, 64, 0);
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const { deps, cap } = makeInstrumentedDeps({ bot, ctx });
  const move = createMove(deps);

  await move({ x: 10, y: 64, z: 10 });

  assert.equal(cap.preRadii[0], 1, 'short-range preflight should use radius 1');
  assert.ok(cap.goalKinds.includes('GoalBlock'),
    `expected GoalBlock for short-range strict mode, saw: ${cap.goalKinds.join(', ')}`);
  assert.ok(!cap.goalKinds.some((k) => k.startsWith('GoalNear')),
    'short-range should not use GoalNear');
});

test('long-range move (>20 blocks) defaults to GoalNear(2) and preflight radius 2', async () => {
  const bot = makeBotAt(0, 64, 0);
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const { deps, cap } = makeInstrumentedDeps({ bot, ctx });
  const move = createMove(deps);

  // Target 30 blocks away → triggers lenient default
  await move({ x: 30, y: 64, z: 0 });

  assert.equal(cap.preRadii[0], 2, 'long-range preflight should use radius 2');
  assert.ok(cap.goalKinds.some((k) => k === 'GoalNear(2)'),
    `expected GoalNear(2) for long-range lenient mode, saw: ${cap.goalKinds.join(', ')}`);
});

test('long-range move with explicit strict=true stays in GoalBlock/radius 1', async () => {
  const bot = makeBotAt(0, 64, 0);
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const { deps, cap } = makeInstrumentedDeps({ bot, ctx });
  const move = createMove(deps);

  await move({ x: 30, y: 64, z: 0, strict: true });

  assert.equal(cap.preRadii[0], 1, 'strict mode should use radius 1 even on long-range');
  assert.ok(cap.goalKinds.includes('GoalBlock'),
    `expected GoalBlock when strict=true, saw: ${cap.goalKinds.join(', ')}`);
});

test('explicit near=5 overrides the default (long-range)', async () => {
  const bot = makeBotAt(0, 64, 0);
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const { deps, cap } = makeInstrumentedDeps({ bot, ctx });
  const move = createMove(deps);

  await move({ x: 30, y: 64, z: 0, near: 5 });

  assert.equal(cap.preRadii[0], 5, 'explicit near=5 should pass through');
  assert.ok(cap.goalKinds.some((k) => k === 'GoalNear(5)'),
    `expected GoalNear(5) when near=5, saw: ${cap.goalKinds.join(', ')}`);
});

test('explicit near=3 on short-range also overrides the default strict', async () => {
  const bot = makeBotAt(0, 64, 0);
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const { deps, cap } = makeInstrumentedDeps({ bot, ctx });
  const move = createMove(deps);

  await move({ x: 5, y: 64, z: 5, near: 3 });

  assert.equal(cap.preRadii[0], 3, 'explicit near=3 on short-range should pass through');
  assert.ok(cap.goalKinds.some((k) => k === 'GoalNear(3)'),
    `expected GoalNear(3), saw: ${cap.goalKinds.join(', ')}`);
});

test('exactly 20 blocks does NOT trigger lenient default (boundary)', async () => {
  const bot = makeBotAt(0, 64, 0);
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const { deps, cap } = makeInstrumentedDeps({ bot, ctx });
  const move = createMove(deps);

  // Exactly 20 (4²+0+0+0 actually doesn't reach 20; use 20.0 exactly)
  // sqrt(400) = 20 — boundary case
  await move({ x: 20, y: 64, z: 0 });

  assert.equal(cap.preRadii[0], 1, 'distance == 20 should be strict (boundary inclusive)');
  assert.ok(cap.goalKinds.includes('GoalBlock'),
    `expected GoalBlock at boundary distance 20, saw: ${cap.goalKinds.join(', ')}`);
});

test('21 blocks triggers lenient default', async () => {
  const bot = makeBotAt(0, 64, 0);
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const { deps, cap } = makeInstrumentedDeps({ bot, ctx });
  const move = createMove(deps);

  await move({ x: 21, y: 64, z: 0 });

  assert.equal(cap.preRadii[0], 2, 'distance == 21 should trigger lenient');
  assert.ok(cap.goalKinds.some((k) => k === 'GoalNear(2)'),
    `expected GoalNear(2) at distance 21, saw: ${cap.goalKinds.join(', ')}`);
});
