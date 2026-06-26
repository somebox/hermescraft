/**
 * S0.2 — gv2 card-shaped begin args vs stored session.phase (post-normalizeSessionPhase).
 * Regression input for runtime lane S2.1–S2.3.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSessionPhase,
  phaseFromBeginBody,
  phaseVerifyArgs,
  resolvePhaseKey,
} from '../../lib/runtime/construct-lifecycle.js';

test('phaseFromBeginBody prefers level/range slice selectors', () => {
  assert.deepEqual(phaseFromBeginBody({ level: 1 }), { level: 1 });
  assert.deepEqual(phaseFromBeginBody({ range: '2..4' }), { range: [2, 4] });
});

test('normalizeSessionPhase: gv2 L1 label + level → structured phase', () => {
  const phase = normalizeSessionPhase({ phase: 'L1_slab', level: 1 }, {});
  assert.equal(phase.id, 'L1_slab');
  assert.equal(phase.level, 1);
  assert.equal(resolvePhaseKey(phase), 'L1_slab');
  assert.deepEqual(phaseVerifyArgs(phase), { level: 1 });
});

test('normalizeSessionPhase: gv2 L3 label + range → verify/end slice not full plan', () => {
  const phase = normalizeSessionPhase({ phase: 'L3_walls', range: '2..4' }, {});
  assert.equal(phase.id, 'L3_walls');
  assert.deepEqual(phase.range, [2, 4]);
  assert.deepEqual(phaseVerifyArgs(phase), { range: '2..4' });
});

test('legacy bug class: bare string phase without level/range is not a verify slice', () => {
  const legacy = 'L3_walls';
  assert.equal(resolvePhaseKey(legacy), null);
  assert.deepEqual(phaseVerifyArgs(legacy), {});
});
