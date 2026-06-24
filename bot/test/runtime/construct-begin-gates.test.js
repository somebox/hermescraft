import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkPlanRevisionGate,
  checkConstructSiteBindingGate,
  readPlanRevision,
  effectivePlanRevision,
} from '../../lib/runtime/construct-begin-gates.js';

test('readPlanRevision reads plan.revision field', () => {
  assert.equal(readPlanRevision({ revision: 'starter_shelter-v1' }), 'starter_shelter-v1');
  assert.equal(readPlanRevision({ plan_id: 'x' }), null);
});

test('checkPlanRevisionGate fails on mismatch when card expects revision', () => {
  const ctxPlan = { planId: 'starter_shelter', plan: { revision: 'starter_shelter-v1' } };
  const r = checkPlanRevisionGate({ plan_revision: 'old-rev' }, ctxPlan, { runtime: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PLAN_REVISION_MISMATCH');
  const ok = checkPlanRevisionGate({ plan_revision: 'starter_shelter-v1' }, ctxPlan, { runtime: {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.plan_revision, 'starter_shelter-v1');
});

test('checkPlanRevisionGate passes when card omits plan_revision', () => {
  const ctxPlan = { planId: 'p1', plan: {} };
  const r = checkPlanRevisionGate({}, ctxPlan, { runtime: {} });
  assert.equal(r.ok, true);
  assert.equal(r.plan_revision, 'p1');
});

test('checkConstructSiteBindingGate: PLAN_SITE_MISMATCH on worksite plan drift', () => {
  const ctxPlan = {
    planId: 'starter_shelter',
    plan: { plan_id: 'starter_shelter', anchor: { coords: [0, 64, 0] } },
    region: null,
  };
  const regions = [{
    id: 'base',
    plan: 'other_plan',
    anchor: { x: 0, y: 64, z: 0 },
    profile: 'base',
    status: 'active',
    shape: { kind: 'column', radius: 8 },
  }];
  const r = checkConstructSiteBindingGate(ctxPlan, {
    worksite_region: 'base',
    regions,
    card_plan_id: 'starter_shelter',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PLAN_SITE_MISMATCH');
});

test('checkConstructSiteBindingGate: ANCHOR_DRIFT when region sign moved', () => {
  const ctxPlan = {
    planId: 'starter_shelter',
    plan: {
      plan_id: 'starter_shelter',
      anchor: {
        coords: [0, 64, 0],
        marker: { coords: [3, 64, -1] },
      },
    },
    region: {
      id: 'base',
      plan: 'starter_shelter',
      anchor: { x: 20, y: 64, z: 20 },
    },
  };
  const r = checkConstructSiteBindingGate(ctxPlan, { worksite_region: 'base', regions: [ctxPlan.region] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ANCHOR_DRIFT');
});

test('effectivePlanRevision prefers explicit revision', () => {
  assert.equal(
    effectivePlanRevision({ planId: 'starter_shelter', plan: { revision: 'v2' } }),
    'v2',
  );
});
