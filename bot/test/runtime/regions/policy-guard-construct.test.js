import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRegionResolveArgs } from '../../../lib/runtime/regions/policy-guard.js';
import { setConstructContext } from '../../../lib/runtime/construct-context.js';

test('buildRegionResolveArgs: construct session enables guided region resolve', () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const ctx = {
      runtime: {
        taskContext: { worksite_region: 'base', expires_at: Date.now() + 60_000 },
      },
    };
    const idle = buildRegionResolveArgs(ctx);
    assert.equal(idle.guided, false);
    assert.equal(idle.ad_hoc, true);

    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'starter_shelter',
      mutation_policy: ['missing'],
    });
    const active = buildRegionResolveArgs(ctx);
    assert.equal(active.guided, true);
    assert.equal(active.ad_hoc, false);
    assert.equal(active.task_worksite, 'base');
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('buildRegionResolveArgs: explicit guided:true still works without construct', () => {
  const ctx = { runtime: { taskContext: null } };
  const args = buildRegionResolveArgs(ctx, { guided: true });
  assert.equal(args.guided, true);
  assert.equal(args.ad_hoc, false);
});
