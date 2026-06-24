import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockMatchesConstructExpected,
  expandExpectedBlocks,
  buildWorksetIndex,
  evaluateConstructMutation,
  setConstructContext,
} from '../../lib/runtime/construct-context.js';

test('expandExpectedBlocks includes plan substitutions', () => {
  const allowed = expandExpectedBlocks('oak_planks', {
    oak_planks: ['spruce_planks', 'birch_planks'],
  });
  assert.ok(allowed.has('oak_planks'));
  assert.ok(allowed.has('spruce_planks'));
  assert.ok(allowed.has('birch_planks'));
  assert.equal(allowed.size, 3);
});

test('blockMatchesConstructExpected accepts substitute block names', () => {
  const subs = { cobblestone: ['stone', 'oak_planks'] };
  assert.equal(blockMatchesConstructExpected('stone', 'cobblestone', subs), true);
  assert.equal(blockMatchesConstructExpected('dirt', 'cobblestone', subs), false);
});

test('evaluateConstructMutation: substitute block passes CONSTRUCT_WRONG_BLOCK gate', () => {
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
      substitutions: { oak_planks: ['spruce_planks'] },
    });
    ctx.runtime._constructWorkset = buildWorksetIndex([
      { x: 11, y: 64, z: 11, category: 'missing', expected_block: 'oak_planks' },
    ]);
    assert.equal(
      evaluateConstructMutation(ctx, 11, 64, 11, 'add', { blockName: 'spruce_planks' }),
      null,
    );
    const bad = evaluateConstructMutation(ctx, 11, 64, 11, 'add', { blockName: 'glass' });
    assert.equal(bad?.error?.code, 'CONSTRUCT_WRONG_BLOCK');
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});
