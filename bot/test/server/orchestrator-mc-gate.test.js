import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gateOrchestratorMcAction,
  ORCHESTRATOR_ALLOWED_MC,
} from '../../lib/server/middleware/orchestrator-mc-gate.js';

const STEWARD = { agent: { profile: 'steward' } };
const MASON = { agent: { profile: 'mason' } };

/** Run-8 steward field verbs — must stay denied on orchestrator profile. */
const RUN8_DENIED = [
  'tunnel',
  'level',
  'move',
  'collect',
  'dig',
  'goto_near',
  'pillar_up',
  'escape',
  'place',
  'fill',
  'dig_area',
];

test('gateOrchestratorMcAction allows observe on steward profile', () => {
  assert.equal(gateOrchestratorMcAction(STEWARD, 'observe'), null);
});

for (const verb of RUN8_DENIED) {
  test(`gate denies ${verb} on steward profile`, () => {
    const r = gateOrchestratorMcAction(STEWARD, verb);
    assert.ok(r, `expected deny for ${verb}`);
    assert.equal(r.status, 403);
    assert.match(r.error, new RegExp(`mc ${verb} is denied`));
  });
}

test('gateOrchestratorMcAction allows tunnel on worker profile', () => {
  assert.equal(gateOrchestratorMcAction(MASON, 'tunnel'), null);
});

test('allowlist includes read-only verbs used by hook', () => {
  for (const v of [
    'status',
    'scene',
    'chat',
    'whisper',
    'terrain_top',
    'inventory',
    'chest_search',
    'social',
  ]) {
    assert.ok(ORCHESTRATOR_ALLOWED_MC.has(v), `missing ${v}`);
  }
});
