import test from 'node:test';
import assert from 'node:assert/strict';

import { runCells, cellId } from '../../lib/runtime/execution-kernel/index.js';
import {
  buildWorksetIndex,
  getConstructAllowUnitForCtx,
  setConstructContext,
} from '../../lib/runtime/construct-context.js';

test('getConstructAllowUnitForCtx + dig-style remove runCells counts scope_denied', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const ctx = { runtime: {} };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'p1',
      anchor: [0, 64, 0],
      footprint: { local: { x: [0, 2], y: [0, 2], z: [0, 2] } },
      mutation_policy: ['missing', 'wrong'],
    });
    ctx.runtime._constructWorkset = buildWorksetIndex([
      { x: 1, y: 64, z: 1, category: 'wrong' },
      { x: 2, y: 64, z: 2, category: 'missing' },
    ]);
    const units = [
      { x: 1, y: 64, z: 1, id: cellId(1, 64, 1) },
      { x: 2, y: 64, z: 2, id: cellId(2, 64, 2) },
    ];
    const { envelope } = await runCells(ctx, units, {
      ...getConstructAllowUnitForCtx(ctx, 'remove'),
      async act() {
        return { status: 'done' };
      },
    }, { mode: 'remove', shape: 'volume' });
    assert.equal(envelope.counters.scope_denied, 1);
    assert.equal(envelope.cursor.units_done, 2);
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});
