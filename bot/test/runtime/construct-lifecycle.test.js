import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shouldAutoBeginConstruct,
  constructFieldsForTaskContext,
  autoClearConstructOnCardChange,
  clearConstructSession,
  attachConstructMotorEnvelope,
  constructCompletionBlockedReason,
  normalizeSessionPhase,
  phaseVerifyArgs,
  getConstructPhaseClosure,
  recordConstructPhaseClosed,
} from '../../lib/runtime/construct-lifecycle.js';
import { evaluatePhaseClean } from '../../lib/runtime/construct-end-gates.js';
import { loadPlanJson, enrichPlan } from '../../lib/runtime/blueprints/loader.js';
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

test('normalizeSessionPhase: gv2 L1_slab + level 1 stores slice not bare string', () => {
  const phase = normalizeSessionPhase({ phase: 'L1_slab', level: 1 }, {});
  assert.equal(phase.id, 'L1_slab');
  assert.equal(phase.level, 1);
  assert.equal(typeof phase, 'object');
  assert.equal(phaseVerifyArgs(phase).level, 1);
});

test('normalizeSessionPhase: L3_walls + range 2..4', () => {
  const phase = normalizeSessionPhase({ phase: 'L3_walls', range: '2..4' }, {});
  assert.equal(phase.id, 'L3_walls');
  assert.equal(phaseVerifyArgs(phase).range, '2..4');
});

test('evaluatePhaseClean: string phase label does not apply level slice', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const dataDir = path.join(repoRoot, 'data');
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  assert.equal(loaded.ok, true);
  const plan = loaded.plan;
  const anchor = plan.anchor?.coords || [0, 64, 0];
  const enriched = enrichPlan(plan);
  const ctxPlan = { ...enriched, anchor, planId: plan.plan_id };
  const getAir = () => 'air';
  const levelSlice = evaluatePhaseClean(ctxPlan, getAir, { level: 1 });
  const stringLabel = evaluatePhaseClean(ctxPlan, getAir, 'L1_slab');
  assert.equal(levelSlice.clean, false);
  assert.equal(stringLabel.clean, false);
  assert.notEqual(levelSlice.verify.summary.missing, stringLabel.verify.summary.missing);
});

test('recordConstructPhaseClosed survives task_context reference on runtime', () => {
  const ctx = {
    runtime: {
      taskContext: { card_id: 't_abc', card_kind: 'CONSTRUCT' },
    },
  };
  recordConstructPhaseClosed(ctx, {
    plan_id: 'starter_shelter',
    card_id: 't_abc',
    phase: { id: 'L1_slab', level: 1 },
  });
  const closure = getConstructPhaseClosure(ctx);
  assert.equal(closure?.card_id, 't_abc');
  assert.equal(closure?.phase_key, 'L1_slab');
});

test('normalizeSessionPhase: gv2 string phase + range wins over full-plan verify', () => {
  const phase = normalizeSessionPhase(
    { phase: 'L3_walls', range: '2..4' },
    { phase: 'L3_walls', range: '2..4' },
  );
  assert.equal(phase.id, 'L3_walls');
  assert.deepEqual(phase.range, [2, 4]);
  assert.deepEqual(phaseVerifyArgs(phase), { range: '2..4' });
  const legacy = normalizeSessionPhase({ phase: 'L1_slab', level: 1 }, {});
  assert.equal(legacy.level, 1);
  assert.equal(legacy.id, 'L1_slab');
});
