/**
 * Direct tests for bot/lib/actions/_helpers.js
 * ADR: docs/design/action-contract.md
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
