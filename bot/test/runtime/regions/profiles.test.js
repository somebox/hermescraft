import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProfile, isProtectedInRegion, isToleratedBreak, getDefaultIntentForProfile } from '../../../lib/runtime/regions/profiles.js';

test('applyProfile sets mine intent to resource', () => {
  const r = applyProfile({ id: 'm1', profile: 'mine' });
  assert.equal(r.intent, 'resource');
  assert.equal(r.capabilities.overrides_global_denylist, true);
});

test('farm tolerates wheat', () => {
  const r = applyProfile({ id: 'f1', profile: 'farm', intent: 'protect' });
  assert.ok(isToleratedBreak('wheat', r));
  assert.ok(isProtectedInRegion('oak_fence', r));
});

test('getDefaultIntentForProfile', () => {
  assert.equal(getDefaultIntentForProfile('base'), 'protect');
  assert.equal(getDefaultIntentForProfile('mine'), 'resource');
});
