/**
 * Construct session actions (HERMES_CONSTRUCT_CONTEXT).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBlueprintActions } from '../../lib/actions/blueprints/index.js';
import { createConstructActions } from '../../lib/actions/construct/index.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';
import { setConstructContext, buildWorksetIndex } from '../../lib/runtime/construct-context.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = path.join(repoRoot, 'data');

function deps(overrides = {}) {
  const services = createMockServices({
    ensureBot: () => ({
      entity: { position: { x: 0, y: 64, z: 0 } },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    }),
    state: { runtime: { dataDir } },
    ...overrides,
  });
  return {
    ctx: services.state,
    config: services.config,
    ensureBot: services.ensureBot,
  };
}

function constructActions(overrides = {}) {
  const d = deps(overrides);
  const bp = createBlueprintActions(d);
  return { actions: createConstructActions(d, bp), ...d };
}

test('construct begin: PLAN_REVISION_MISMATCH when card revision stale', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const { actions } = constructActions();
    const r = await actions.construct_begin({
      target: 'starter_shelter',
      level: 1,
      plan_revision: 'starter_shelter-v0-stale',
      skip_readiness: true,
      skip_anchor_gate: true,
    });
    assertFailure(r, { code: 'PLAN_REVISION_MISMATCH', retrySafe: false });
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('construct begin: CONSTRUCT_PREP_REQUIRED when L1 site is water', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const { actions } = constructActions({
      ensureBot: () => ({
        entity: { position: { x: 0, y: 64, z: 0 } },
        blockAt: () => ({ name: 'water', boundingBox: 'empty' }),
      }),
    });
    const r = await actions.construct_begin({
      target: 'starter_shelter',
      level: 1,
      skip_anchor_gate: true,
    });
    assertFailure(r, { code: 'CONSTRUCT_PREP_REQUIRED', retrySafe: false });
    assert.equal(r.error.observed_state?.site_readiness?.status, 'prep_required');
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('construct begin: FEATURE_DISABLED when env off', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  delete process.env.HERMES_CONSTRUCT_CONTEXT;
  try {
    const { actions } = constructActions();
    const r = await actions.construct_begin({});
    assertFailure(r, { code: 'FEATURE_DISABLED', retrySafe: false });
    assert.match(r.error.next_action_hint, /blueprint verify/i);
  } finally {
    if (prev !== undefined) process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('construct end: NOT_IN_CONSTRUCT when idle', async () => {
  const { actions } = constructActions();
  const r = await actions.construct_end({});
  assertFailure(r, { code: 'NOT_IN_CONSTRUCT', retrySafe: true });
});

test('construct end: clears session and workset', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const services = createMockServices({
      ensureBot: () => ({
        entity: { position: { x: 0, y: 64, z: 0 } },
        blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
      }),
    });
    const ctx = services.state;
    const bp = createBlueprintActions({ ctx, config: services.config, ensureBot: services.ensureBot });
    const actions = createConstructActions({ ctx, config: services.config, ensureBot: services.ensureBot }, bp);
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'p1',
      mutation_policy: ['missing'],
    });
    ctx.runtime._constructWorkset = buildWorksetIndex([
      { x: 1, y: 64, z: 1, category: 'missing' },
    ]);
    const r = await actions.construct_end({ skip_gates: true, skip_phase_gate: true });
    assert.equal(r.ok, true);
    assert.equal(ctx.runtime.construct_context, null);
    assert.equal(ctx.runtime._constructWorkset, undefined);
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

// Regression (gv2-2026-06-24-6): the registry/dispatcher invokes the top-level
// `construct`/`blueprint` verb DETACHED from its action object, so internal
// op-dispatch via `this.construct_show(...)` / `this.blueprint_verify(...)`
// threw "Cannot read properties of undefined (reading 'construct_show')" the
// moment construct context went live — and the planner abandoned the blueprint
// pipeline. The verbs must dispatch via a closure ref, not `this`.
test('construct verb dispatches when invoked detached (no this binding)', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const { actions } = constructActions();
    const construct = actions.construct; // detach, as the dispatcher does
    let threw = null, res = null;
    try { res = await construct({ op: 'show' }); } catch (e) { threw = e; }
    assert.equal(threw, null, threw && threw.message);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NOT_IN_CONSTRUCT'); // reached the handler, not a crash
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('blueprint verb dispatches when invoked detached (no this binding)', async () => {
  const { actions, ...d } = constructActions();
  const bp = createBlueprintActions(d);
  const blueprint = bp.blueprint; // detach
  let threw = null, res = null;
  try { res = await blueprint({ op: 'verify' }); } catch (e) { threw = e; }
  assert.equal(threw, null, threw && threw.message);
  assert.equal(typeof res.ok, 'boolean'); // structured result, not a TypeError
});
