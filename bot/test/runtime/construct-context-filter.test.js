import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorksetIndex,
  evaluateConstructMutation,
  setConstructContext,
} from '../../lib/runtime/construct-context.js';

test('evaluateConstructMutation: outside footprint is unfiltered', () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const ctx = { runtime: {} };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'p1',
      anchor: [10, 64, 10],
      footprint: { local: { x: [0, 2], y: [0, 2], z: [0, 2] } },
      mutation_policy: ['missing', 'wrong'],
    });
    ctx.runtime._constructWorkset = buildWorksetIndex([
      { x: 11, y: 64, z: 11, category: 'missing' },
    ]);
    assert.equal(evaluateConstructMutation(ctx, 99, 64, 99, 'add'), null);
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('evaluateConstructMutation: deny place on ok cell inside footprint', () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const ctx = { runtime: {} };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'p1',
      anchor: [10, 64, 10],
      footprint: { local: { x: [0, 2], y: [0, 2], z: [0, 2] } },
      mutation_policy: ['missing', 'wrong'],
    });
    ctx.runtime._constructWorkset = buildWorksetIndex([]);
    const r = evaluateConstructMutation(ctx, 10, 64, 10, 'add', { blockName: 'oak_planks' });
    assert.equal(r?.error?.code, 'CONSTRUCT_ALREADY_OK');
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('evaluateConstructMutation: CONSTRUCT_NOT_STARTED inside footprint without session', () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const ctx = {
      runtime: {
        taskContext: {
          card_id: 't1',
          card_kind: 'CONSTRUCT',
          construct_plan: {
            plan_id: 'p1',
            anchor: [10, 64, 10],
            footprint: { local: { x: [0, 2], y: [0, 2], z: [0, 2] } },
          },
        },
      },
    };
    const r = evaluateConstructMutation(ctx, 10, 64, 10, 'add', { blockName: 'stone' });
    assert.equal(r?.error?.code, 'CONSTRUCT_NOT_STARTED');
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('evaluateConstructMutation: allow place on missing with block match', () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const ctx = { runtime: {} };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'p1',
      anchor: [10, 64, 10],
      footprint: { local: { x: [0, 2], y: [0, 2], z: [0, 2] } },
      mutation_policy: ['missing', 'wrong'],
    });
    ctx.runtime._constructWorkset = buildWorksetIndex([
      { x: 11, y: 64, z: 11, category: 'missing', expected_block: 'oak_planks' },
    ]);
    assert.equal(evaluateConstructMutation(ctx, 11, 64, 11, 'add', { blockName: 'oak_planks' }), null);
    const bad = evaluateConstructMutation(ctx, 11, 64, 11, 'add', { blockName: 'birch_planks' });
    assert.equal(bad?.error?.code, 'CONSTRUCT_WRONG_BLOCK');
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('evaluateConstructMutation: dig denies ok cell, allows wrong when in policy', () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const ctx = { runtime: {} };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'p1',
      anchor: [10, 64, 10],
      footprint: { local: { x: [0, 2], y: [0, 2], z: [0, 2] } },
      mutation_policy: ['wrong', 'extra'],
    });
    ctx.runtime._constructWorkset = buildWorksetIndex([
      { x: 11, y: 64, z: 11, category: 'wrong' },
    ]);
    assert.equal(evaluateConstructMutation(ctx, 11, 64, 11, 'remove'), null);
    const denyOk = evaluateConstructMutation(ctx, 10, 64, 10, 'remove');
    assert.equal(denyOk?.error?.code, 'CONSTRUCT_ALREADY_OK');
    const denyMissing = evaluateConstructMutation(ctx, 12, 64, 12, 'remove');
    assert.equal(denyMissing?.error?.code, 'CONSTRUCT_ALREADY_OK');
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});
