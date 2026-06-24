import test from 'node:test';
import assert from 'node:assert/strict';

import { runCells } from '../../../lib/runtime/execution-kernel/run.js';

const units = [
  { id: '0,0,0', x: 0, y: 0, z: 0 },
  { id: '1,0,0', x: 1, y: 0, z: 0 },
  { id: '2,0,0', x: 2, y: 0, z: 0 },
];

test('runCells completes and advances cursor', async () => {
  const acts = [];
  const { envelope, stopReason } = await runCells({}, units, {
    act: async (u) => { acts.push(u.id); return { status: 'done' }; },
  }, { mode: 'remove', shape: 'volume', interUnitDelayMs: 0, sleep: async () => {} });
  assert.equal(stopReason, 'complete');
  assert.equal(envelope.ok, true);
  assert.equal(envelope.cursor.next_index, 3);
  assert.equal(envelope.cursor.units_done, 3);
  assert.deepEqual(acts, ['0,0,0', '1,0,0', '2,0,0']);
});

test('runCells cancelRequested → CANCELLED partial', async () => {
  const ctx = { tasks: { cancelRequested: true } };
  const { envelope, stopReason } = await runCells(ctx, units, {
    act: async () => ({ status: 'done' }),
  }, { interUnitDelayMs: 0, sleep: async () => {} });
  assert.equal(stopReason, 'cancelled');
  assert.equal(envelope.error?.code, 'CANCELLED');
  assert.equal(envelope.partial, true);
  assert.equal(envelope.cursor.next_index, 0);
});

test('runCells deadline stops with partial envelope', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { envelope, stopReason } = await runCells({}, units, {
    act: async () => {
      t.mock.timers.tick(50);
      return { status: 'done' };
    },
  }, { deadlineMs: 40, interUnitDelayMs: 0, sleep: async () => {} });
  assert.equal(stopReason, 'deadline');
  assert.equal(envelope.partial, true);
  assert.equal(envelope.cursor.next_index, 1);
});

test('runCells failFastOnTool → TOOL_MISSING', async () => {
  const { envelope, stopReason } = await runCells({}, units, {
    act: async () => { throw new Error('no pickaxe in inventory'); },
  }, { failFastOnTool: true, interUnitDelayMs: 0, sleep: async () => {} });
  assert.equal(stopReason, 'tool_missing');
  assert.equal(envelope.error?.code, 'TOOL_MISSING');
});

test('runCells skip vs failed counters', async () => {
  const { envelope } = await runCells({}, units, {
    shouldSkip: async (u) => u.id === '0,0,0',
    act: async (u) => (u.id === '1,0,0'
      ? { status: 'failed' }
      : { status: 'done' }),
  }, { interUnitDelayMs: 0, sleep: async () => {} });
  assert.equal(envelope.counters.skipped, 1);
  assert.equal(envelope.counters.failed, 1);
  assert.equal(envelope.counters.dug, 1);
  assert.equal(envelope.cursor.next_index, 3);
});

test('runCells allowUnit deny advances cursor without act', async () => {
  const acts = [];
  const { envelope } = await runCells({}, units, {
    allowUnit: async (u) => u.id !== '1,0,0',
    act: async (u) => { acts.push(u.id); return { status: 'done' }; },
  }, { interUnitDelayMs: 0, sleep: async () => {} });
  assert.equal(envelope.counters.scope_denied, 1);
  assert.equal(acts.length, 2);
  assert.equal(envelope.cursor.next_index, 3);
});

test('runCells aggregates unit.meta into envelope.construct', async () => {
  const { envelope } = await runCells({}, [
    { id: '0,0,0', x: 0, y: 0, z: 0, meta: { category: 'missing' } },
    { id: '1,0,0', x: 1, y: 0, z: 0, meta: { category: 'missing' } },
  ], {
    act: async () => ({ status: 'done' }),
  }, { mode: 'add', interUnitDelayMs: 0, sleep: async () => {} });
  assert.equal(envelope.construct?.category, 2);
  assert.equal(envelope.counters.placed, 2);
});

test('runCells mirrors cursor into currentTask.progress', async () => {
  const ctx = {
    tasks: {
      currentTask: {
        status: 'running',
        progress: { phase: 'dig' },
      },
    },
  };
  await runCells(ctx, units, {
    act: async () => ({ status: 'done' }),
  }, { interUnitDelayMs: 0, sleep: async () => {} });
  assert.equal(ctx.tasks.currentTask.progress.phase, 'dig');
  assert.equal(ctx.tasks.currentTask.progress.bulk_motor.cursor.units_done, 3);
  assert.equal(ctx.tasks.currentTask.progress.bulk_motor.stop_reason, 'complete');
  assert.ok(ctx.tasks.currentTask.progress.bulk_motor.plan_hash);
});
