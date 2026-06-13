/**
 * Direct tests for bot/lib/actions/_helpers.js
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import {
  raceWithTimeout,
  OperationTimeoutError,
  withWallclockCap,
  pathfindWithProgressWatchdog,
  NoProgressError,
  ensureWithinReach,
  pathfindGotoNear,
  timeoutError,
  ACTION_CAPS_MS,
} from '../../lib/actions/_helpers.js';
import { assertContract } from '../_helpers/action-harness.js';

test('raceWithTimeout: resolves when promise wins', async () => {
  const v = await raceWithTimeout(Promise.resolve(42), 500, 'test');
  assert.equal(v, 42);
});

test('raceWithTimeout: throws OperationTimeoutError when slow', async () => {
  await assert.rejects(
    () => raceWithTimeout(new Promise(() => {}), 30, 'slowOp'),
    (err) => err instanceof OperationTimeoutError && err.opName === 'slowOp',
  );
});

test('withWallclockCap: returns OPERATION_TIMEOUT envelope on timeout', async () => {
  const out = await withWallclockCap({
    promise: new Promise(() => {}),
    capMs: 25,
    opName: 'capTest',
    onTimeout: () => {},
  });
  assertContract(out);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'OPERATION_TIMEOUT');
  assert.equal(out.error.retry_safe, true);
});

test('pathfindWithProgressWatchdog: resolves when goto completes quickly', async () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
  };
  const value = await pathfindWithProgressWatchdog({
    bot,
    opName: 'goto',
    capMs: 2000,
    windowMs: 800,
    sampleMs: 50,
    pathfinderGoto: async () => 'done',
  });
  assert.equal(value, 'done');
});

test('pathfindWithProgressWatchdog: rejects with NoProgressError when stalled after motion', async () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
  };
  let moved = false;
  const pathfinderGoto = () => new Promise(() => {
    if (!moved) {
      bot.entity.position = new Vec3(2, 64, 0);
      moved = true;
    }
  });

  await assert.rejects(
    () => pathfindWithProgressWatchdog({
      bot,
      opName: 'goto',
      capMs: 10000,
      windowMs: 100,
      minTotalMovement: 0.5,
      sampleMs: 40,
      pathfinderGoto,
      onStall: () => {},
    }),
    (err) => err instanceof NoProgressError,
  );
});

test('pathfindWithProgressWatchdog: jump jitter does NOT reset the stall window (horizontal-only metric)', async () => {
  // proc-nav-1781014144 regression: the manager-level stuck wiggle issues
  // jumps (~1.25m pure-Y arc). Under the old 3D metric every jump reset
  // the 4s no-progress window, so a wedged bot that kept hopping in place
  // never raised NoProgressError and ran to its wallclock cap instead.
  // With the horizontal-only metric, Y oscillation below 1.5m must NOT
  // count as progress.
  const bot = { entity: { position: new Vec3(0, 64, 0) } };
  let jitter = null;
  const pathfinderGoto = () => new Promise(() => {
    let up = true;
    jitter = setInterval(() => {
      // xz fixed; y hops between 64 and 65.2 (jump-arc apex, < 1.5 gate).
      bot.entity.position = new Vec3(0, up ? 65.2 : 64, 0);
      up = !up;
    }, 15);
  });

  try {
    await assert.rejects(
      () => pathfindWithProgressWatchdog({
        bot,
        opName: 'move',
        capMs: 10000,
        windowMs: 150,
        minDelta: 0.3,
        minTotalMovement: 0.5,
        sampleMs: 25,
        pathfinderGoto,
        onStall: () => {},
      }),
      (err) => err instanceof NoProgressError,
    );
  } finally {
    if (jitter) clearInterval(jitter);
  }
});

test('pathfindWithProgressWatchdog: sustained vertical climb counts as progress (no ladder false-trip)', async () => {
  // The |net dy| >= 1.5 escape hatch: a ladder climb or controlled descent
  // moves the bot vertically without xz progress. That must reset the
  // window (a jump returns to its origin Y; a climb does not).
  const bot = { entity: { position: new Vec3(0, 64, 0) } };
  let climb = null;
  const pathfinderGoto = () => new Promise((resolve) => {
    climb = setInterval(() => {
      // Monotonic climb: +0.4 y per tick, xz fixed.
      const p = bot.entity.position;
      bot.entity.position = new Vec3(p.x, p.y + 0.4, p.z);
    }, 15);
    setTimeout(() => resolve('arrived'), 500);
  });

  try {
    const value = await pathfindWithProgressWatchdog({
      bot,
      opName: 'goto',
      capMs: 10000,
      windowMs: 200,
      minDelta: 0.3,
      minTotalMovement: 0.5,
      sampleMs: 25,
      pathfinderGoto,
      onStall: () => { throw new Error('onStall must not fire during a ladder climb'); },
    });
    assert.equal(value, 'arrived');
  } finally {
    if (climb) clearInterval(climb);
  }
});

test('pathfindWithProgressWatchdog: wallclock cap fires OperationTimeoutError', async () => {
  const bot = { entity: { position: new Vec3(0, 64, 0) } };
  await assert.rejects(
    () => pathfindWithProgressWatchdog({
      bot,
      opName: 'goto',
      capMs: 40,
      pathfinderGoto: () => new Promise(() => {}),
    }),
    (err) => err instanceof OperationTimeoutError,
  );
});

test('ensureWithinReach: already in range → ok true', async () => {
  const bot = {
    entity: { position: new Vec3(10.5, 64, 10.5) },
    pathfinder: { goto: async () => { throw new Error('should not pathfind'); } },
  };
  const goals = { GoalNear: class { constructor() {} } };
  const r = await ensureWithinReach({ bot, goals }, { x: 10, y: 64, z: 10 }, { range: 4.5 });
  assert.equal(r.ok, true);
});

test('ensureWithinReach: pathfind failure → OUT_OF_RANGE', async () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: {
      goto: async () => { throw new Error('no path'); },
      setGoal: () => {},
    },
  };
  const goals = { GoalNear: class { constructor(x, y, z) { this.x = x; } } };
  const r = await ensureWithinReach({ bot, goals }, { x: 100, y: 64, z: 100 }, { capMs: 50 });
  assertContract(r);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OUT_OF_RANGE');
});

// ── ensureWithinReach LOS-stance branch (Pass 2: affordance approach) ──
// Target solid block at (10,64,10); (9,64,10) is a standable neighbor
// (floor at 9,63,10). canSeeBlockFaces passes a Vec3 eye (eyePosition());
// pickLosStandCell passes a plain-object candidate eye — so a stub keyed on
// `from instanceof Vec3` separates "current cell blocked" from "stance cell
// has LOS".
function reachGoals() {
  return {
    GoalNear: class { constructor(x, y, z, r) { this.kind = 'near'; this.x = x; this.y = y; this.z = z; this.r = r; } },
    GoalBlock: class { constructor(x, y, z) { this.kind = 'block'; this.x = x; this.y = y; this.z = z; } },
  };
}
function reachBot({ start, solids = [], onGoto }) {
  const solidSet = new Set(solids);
  const calls = [];
  const bot = {
    entity: { position: new Vec3(start.x, start.y, start.z) },
    blockAt: (p) => (solidSet.has(`${p.x},${p.y},${p.z}`)
      ? { name: 'chest', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }),
    pathfinder: {
      setGoal() {},
      goto: async (goal) => { calls.push(goal); if (onGoto) await onGoto(goal, bot); },
    },
  };
  return { bot, calls };
}
const arrive = (goal, bot) => {
  bot.entity.position = goal.kind === 'block'
    ? new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5)
    : new Vec3(goal.x + 0.5, goal.y, goal.z + 1.5);
};
const SOLIDS = ['10,64,10', '9,63,10'];

test('ensureWithinReach: out of range → picks GoalBlock at the visible adjacent cell', async () => {
  const { bot, calls } = reachBot({ start: { x: 0, y: 64, z: 0 }, solids: SOLIDS, onGoto: arrive });
  const r = await ensureWithinReach({ bot, goals: reachGoals() }, { x: 10, y: 64, z: 10 }, {
    range: 4.5, los: true, hasLineOfSight: () => true, eyePosition: () => new Vec3(0, 65.4, 0),
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, 'exactly one pathfind — the stance, no fallback');
  assert.equal(calls[0].kind, 'block');
  assert.deepEqual([calls[0].x, calls[0].y, calls[0].z], [9, 64, 10]);
});

test('ensureWithinReach: stance pathfind throws → falls back to GoalNear, never regresses', async () => {
  const onGoto = async (goal, bot) => {
    if (goal.kind === 'block') throw new Error('no path to stance');
    arrive(goal, bot);
  };
  const { bot, calls } = reachBot({ start: { x: 0, y: 64, z: 0 }, solids: SOLIDS, onGoto });
  const r = await ensureWithinReach({ bot, goals: reachGoals() }, { x: 10, y: 64, z: 10 }, {
    range: 4.5, los: true, hasLineOfSight: () => true, eyePosition: () => new Vec3(0, 65.4, 0),
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'block');
  assert.equal(calls[1].kind, 'near');
});

test('ensureWithinReach: non-solid target → no stance, single GoalNear', async () => {
  const { bot, calls } = reachBot({ start: { x: 0, y: 64, z: 0 }, solids: ['9,63,10'], onGoto: arrive });
  const r = await ensureWithinReach({ bot, goals: reachGoals() }, { x: 10, y: 64, z: 10 }, {
    range: 4.5, los: true, hasLineOfSight: () => true, eyePosition: () => new Vec3(0, 65.4, 0),
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'near');
});

test('ensureWithinReach: los:false → unchanged GoalNear path even with hasLineOfSight present', async () => {
  const { bot, calls } = reachBot({ start: { x: 0, y: 64, z: 0 }, solids: SOLIDS, onGoto: arrive });
  const r = await ensureWithinReach({ bot, goals: reachGoals() }, { x: 10, y: 64, z: 10 }, {
    range: 4.5, los: false, hasLineOfSight: () => true, eyePosition: () => new Vec3(0, 65.4, 0),
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'near');
});

test('ensureWithinReach: in range + already visible → ok with zero pathfinds', async () => {
  const { bot, calls } = reachBot({
    start: { x: 10.5, y: 64, z: 11.5 }, solids: SOLIDS,
    onGoto: () => { throw new Error('should not pathfind'); },
  });
  const r = await ensureWithinReach({ bot, goals: reachGoals() }, { x: 10, y: 64, z: 10 }, {
    range: 4.5, los: true, hasLineOfSight: () => true, eyePosition: () => new Vec3(10.5, 65.4, 11.5),
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
});

test('ensureWithinReach: in range but blocked → re-stances to a visible cell', async () => {
  const { bot, calls } = reachBot({ start: { x: 10.5, y: 64, z: 11.5 }, solids: SOLIDS, onGoto: arrive });
  const r = await ensureWithinReach({ bot, goals: reachGoals() }, { x: 10, y: 64, z: 10 }, {
    range: 4.5, los: true,
    // Vec3 eye (current cell) → blocked; plain-object candidate eye → has LOS.
    hasLineOfSight: (from) => !(from instanceof Vec3),
    eyePosition: () => new Vec3(10.5, 65.4, 11.5),
  });
  assert.equal(r.ok, true);
  assert.ok(calls.some((g) => g.kind === 'block'), 'a re-stance GoalBlock was attempted');
});

// ── pathfindGotoNear opt-in LOS stance (Pass 3b: dig/place approach) ──
test('pathfindGotoNear: LOS opt-in goes to the GoalBlock stance cell', async () => {
  const { bot, calls } = reachBot({ start: { x: 0, y: 64, z: 0 }, solids: SOLIDS, onGoto: arrive });
  await pathfindGotoNear(bot, reachGoals(), 10, 64, 10, 3, { opName: 'dig', hasLineOfSight: () => true });
  assert.ok(calls.some((g) => g.kind === 'block'), 'stance GoalBlock used');
  assert.ok(!calls.some((g) => g.kind === 'near'), 'stance reached → no GoalNear fallback');
});

test('pathfindGotoNear: no LOS opt-in → plain GoalNear (unchanged for ~50 callers)', async () => {
  const { bot, calls } = reachBot({ start: { x: 0, y: 64, z: 0 }, solids: SOLIDS, onGoto: arrive });
  await pathfindGotoNear(bot, reachGoals(), 10, 64, 10, 3, { opName: 'place' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'near');
});

test('pathfindGotoNear: LOS stance misses range → falls back to GoalNear', async () => {
  // 'block' "succeeds" but doesn't move the bot (stays far); 'near' arrives.
  const onGoto = async (goal, bot) => { if (goal.kind === 'near') arrive(goal, bot); };
  const { bot, calls } = reachBot({ start: { x: 0, y: 64, z: 0 }, solids: SOLIDS, onGoto });
  await pathfindGotoNear(bot, reachGoals(), 10, 64, 10, 3, { opName: 'dig', hasLineOfSight: () => true });
  assert.ok(calls.some((g) => g.kind === 'block'));
  assert.ok(calls.some((g) => g.kind === 'near'), 'fell back to GoalNear');
});

test('goto_near OPERATION_TIMEOUT message cites wallclock cap # spec', () => {
  const r = timeoutError('goto_near', ACTION_CAPS_MS.goto_near, {}, 'hint');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OPERATION_TIMEOUT');
  assert.match(r.error.message, /goto_near exceeded \d+ms wallclock cap/);
  assert.equal(r.error.observed_state.cap_ms, ACTION_CAPS_MS.goto_near);
});

test('assertContract: validate() wired for failure envelopes', () => {
  assertContract({
    ok: false,
    error: {
      code: 'TEST_CODE',
      message: 'test subject failed — try mc goto 0 64 0',
      retry_safe: true,
    },
  });
});
