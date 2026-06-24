import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldAutoBeginConstruct,
  constructFieldsForTaskContext,
  autoClearConstructOnCardChange,
  clearConstructSession,
  attachConstructMotorEnvelope,
  constructCompletionBlockedReason,
} from '../../lib/runtime/construct-lifecycle.js';
import { setConstructContext } from '../../lib/runtime/construct-context.js';

test('constructFieldsForTaskContext infers CONSTRUCT when plan+level present', () => {
  const f = constructFieldsForTaskContext({ plan: 'hut1-guard-tower', level: 2 }, 'hut1');
  assert.equal(f.card_kind, 'CONSTRUCT');
  assert.equal(f.plan, 'hut1-guard-tower');
  assert.equal(f.level, 2);
});

test('shouldAutoBeginConstruct requires flag, kind, and phase hint', () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const tc = { card_kind: 'CONSTRUCT', plan: 'p1', level: 1, worksite_region: 'hut1' };
    assert.equal(shouldAutoBeginConstruct(tc, {}), true);
    assert.equal(shouldAutoBeginConstruct({ ...tc, card_kind: 'MINE' }, {}), false);
    assert.equal(shouldAutoBeginConstruct({ card_kind: 'CONSTRUCT', plan: 'p1' }, {}), false);
    assert.equal(shouldAutoBeginConstruct(tc, { construct_auto_begin: false }), false);
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('attachConstructMotorEnvelope adds guided_edit_progress when session active', () => {
  const ctx = { runtime: {} };
  setConstructContext(ctx, {
    kind: 'construct',
    plan_id: 'starter_shelter',
    mutation_policy: ['missing'],
    progress: { ok: 2, missing: 5, wrong: 0, extra: 0 },
    workset_size: 5,
    materials_for_phase: [{ name: 'cobblestone', count: 49 }],
    phase: { id: 'L1_slab' },
  });
  const data = attachConstructMotorEnvelope(ctx, { placed_block: 'cobblestone' });
  assert.equal(data.placed_block, 'cobblestone');
  assert.equal(data.construct_context.plan_id, 'starter_shelter');
  assert.ok(data.guided_edit_progress);
  assert.equal(data.guided_edit_progress.materials_needed[0]?.name, 'cobblestone');
  clearConstructSession(ctx);
});

test('constructCompletionBlockedReason when session active', () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const ctx = { runtime: {} };
    assert.equal(constructCompletionBlockedReason(ctx), null);
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'starter_shelter',
      mutation_policy: ['missing'],
    });
    const block = constructCompletionBlockedReason(ctx);
    assert.equal(block?.code, 'CONSTRUCT_SESSION_ACTIVE');
    clearConstructSession(ctx);
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('autoClearConstructOnCardChange clears session when card_id differs', () => {
  const ctx = { runtime: {} };
  setConstructContext(ctx, {
    kind: 'construct',
    plan_id: 'p1',
    card_id: 't_old',
    mutation_policy: ['missing'],
  });
  autoClearConstructOnCardChange(ctx, 't_new');
  assert.equal(ctx.runtime.construct_context, null);
  clearConstructSession(ctx);
});
