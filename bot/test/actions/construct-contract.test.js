/**
 * Construct session actions (HERMES_CONSTRUCT_CONTEXT).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlueprintActions } from '../../lib/actions/blueprints/index.js';
import { createConstructActions } from '../../lib/actions/construct/index.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';
import { setConstructContext, buildWorksetIndex } from '../../lib/runtime/construct-context.js';

function deps() {
  const services = createMockServices({
    ensureBot: () => ({
      entity: { position: { x: 0, y: 64, z: 0 } },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    }),
  });
  return {
    ctx: services.state,
    config: services.config,
    ensureBot: services.ensureBot,
  };
}

function constructActions() {
  const d = deps();
  const bp = createBlueprintActions(d);
  return createConstructActions(d, bp);
}

test('construct begin: FEATURE_DISABLED when env off', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  delete process.env.HERMES_CONSTRUCT_CONTEXT;
  try {
    const actions = constructActions();
    const r = await actions.construct_begin({});
    assertFailure(r, { code: 'FEATURE_DISABLED', retrySafe: false });
    assert.match(r.error.next_action_hint, /blueprint verify/i);
  } finally {
    if (prev !== undefined) process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('construct end: NOT_IN_CONSTRUCT when idle', async () => {
  const actions = constructActions();
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
    const r = await actions.construct_end({ skip_gates: true });
    assert.equal(r.ok, true);
    assert.equal(ctx.runtime.construct_context, null);
    assert.equal(ctx.runtime._constructWorkset, undefined);
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});
