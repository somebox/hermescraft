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
