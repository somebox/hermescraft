/**
 * Phase 1 foundation tests: action contract + services container + mock parity.
 *
 * If a new top-level service is added (or removed), the mock-parity assertion
 * forces the mock to update. If the contract gains a field, validate() should
 * reject results that don't include it. Both directions are forcing functions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ok, fail, validate } from '../lib/shared/action-contract.js';
import { createServices, SERVICES_KEYS, SERVICE_BUNDLE_KEYS } from '../lib/server/services.js';
import { createMockServices } from '../lib/server/mock-services.js';

// ── Action contract ──────────────────────────────────────────────────────

test('ok() returns { ok: true } with optional data/result and extras', () => {
  assert.deepEqual(ok(), { ok: true });
  assert.deepEqual(ok({ result: 'done' }), { ok: true, result: 'done' });
  assert.deepEqual(
    ok({ data: { crafted_count: 3 }, result: 'Crafted 3 sticks' }),
    { ok: true, data: { crafted_count: 3 }, result: 'Crafted 3 sticks' },
  );
  // Extras spread through (e.g. partial_failure, state-shaped fields).
  const r = ok({ data: { x: 1 }, partial_failure: true });
  assert.equal(r.ok, true);
  assert.equal(r.partial_failure, true);
});

test('fail() returns { ok: false, error: {...} } with required fields', () => {
  const r = fail('OUT_OF_RANGE', 'too far');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OUT_OF_RANGE');
  assert.equal(r.error.message, 'too far');
  assert.equal(r.error.retry_safe, false);
  assert.equal(r.error.observed_state, undefined);
  assert.equal(r.error.next_action_hint, undefined);
});

test('fail() preserves observed_state / next_action_hint / retry_safe when given', () => {
  const r = fail('MISSING_INGREDIENTS', 'need 2 sticks', {
    observed_state: { have: 1, need: 2 },
    next_action_hint: 'mc collect oak_log 1',
    retry_safe: true,
  });
  assert.equal(r.error.retry_safe, true);
  assert.deepEqual(r.error.observed_state, { have: 1, need: 2 });
  assert.equal(r.error.next_action_hint, 'mc collect oak_log 1');
});

test('validate() accepts well-formed success and failure', () => {
  assert.deepEqual(validate(ok({ result: 'done' })), { valid: true, issues: [] });
  assert.deepEqual(
    validate(fail('NO_RECIPE', 'no recipe for nether_star')),
    { valid: true, issues: [] },
  );
});

test('validate() rejects malformed results with descriptive issues', () => {
  // Not an object.
  assert.equal(validate(null).valid, false);
  assert.equal(validate('done').valid, false);

  // ok=false but no error.
  let v = validate({ ok: false });
  assert.equal(v.valid, false);
  assert.match(v.issues.join('\n'), /error must be an object/);

  // error.code not screaming-snake.
  v = validate({ ok: false, error: { code: 'out_of_range', message: 'm', retry_safe: false } });
  assert.equal(v.valid, false);
  assert.match(v.issues.join('\n'), /SCREAMING_SNAKE_CASE/);

  // retry_safe missing.
  v = validate({ ok: false, error: { code: 'OK_CODE', message: 'm' } });
  assert.equal(v.valid, false);
  assert.match(v.issues.join('\n'), /retry_safe must be a boolean/);

  // ok=true with error present.
  v = validate({ ok: true, error: { code: 'X', message: 'y', retry_safe: false } });
  assert.equal(v.valid, false);
  assert.match(v.issues.join('\n'), /error must be absent when ok=true/);

  // ok=true with non-string result.
  v = validate({ ok: true, result: 42 });
  assert.equal(v.valid, false);
  assert.match(v.issues.join('\n'), /result.result must be a string/);
});

// ── Services container ───────────────────────────────────────────────────

function minimalRealServicesInput() {
  const stubFn = () => undefined;
  return {
    config: {},
    state: {},
    ensureBot: stubFn,
    resolver: {
      resolveInventoryItem: stubFn,
      resolveCraftTarget: stubFn,
      resolveBlockQuery: stubFn,
    },
    fairPlay: {},
    spatial: {},
    locations: {},
    social: {
      rememberSocialEvent: stubFn,
      getMyName: stubFn,
      getNearbyPlayerNames: stubFn,
    },
    utils: {
      fmt: stubFn,
      posObj: stubFn,
      sleep: stubFn,
      log: stubFn,
      itemStr: stubFn,
    },
    getActions: () => ({}),
  };
}

test('createServices() exposes all SERVICES_KEYS', () => {
  const s = createServices(minimalRealServicesInput());
  for (const k of SERVICES_KEYS) {
    assert.ok(k in s, `services missing key: ${k}`);
  }
});

test('createServices().getActions() returns the late-bound ACTIONS map', () => {
  const ref = { value: { craft: 'STUB' } };
  const s = createServices({ ...minimalRealServicesInput(), getActions: () => ref.value });
  assert.deepEqual(s.getActions(), { craft: 'STUB' });
  ref.value = { craft: 'STUB', pickup: 'STUB2' };
  assert.deepEqual(s.getActions(), { craft: 'STUB', pickup: 'STUB2' });
});

test('createServices().getActions() defaults to {} when not supplied', () => {
  const input = minimalRealServicesInput();
  delete input.getActions;
  const s = createServices(input);
  assert.deepEqual(s.getActions(), {});
});

// ── Mock parity ──────────────────────────────────────────────────────────

test('createMockServices() top-level keys match SERVICES_KEYS bidirectionally', () => {
  const mock = createMockServices();
  const real = createServices(minimalRealServicesInput());
  const mockKeys = Object.keys(mock).sort();
  const realKeys = Object.keys(real).sort();
  assert.deepEqual(
    mockKeys, realKeys,
    `mock keys ${JSON.stringify(mockKeys)} differ from real ${JSON.stringify(realKeys)}`,
  );
  // Also assert SERVICES_KEYS matches both directions (no drift in the
  // declared list).
  assert.deepEqual([...SERVICES_KEYS].sort(), realKeys);
});

test('createMockServices() per-bundle keys match SERVICE_BUNDLE_KEYS', () => {
  const mock = createMockServices();
  for (const [bundle, expectedKeys] of Object.entries(SERVICE_BUNDLE_KEYS)) {
    const actual = Object.keys(mock[bundle]).sort();
    const expected = [...expectedKeys].sort();
    assert.deepEqual(actual, expected, `bundle ${bundle} key mismatch`);
  }
});

test('createMockServices() function-typed fields are callable stubs', () => {
  const mock = createMockServices();
  // ensureBot is the only stub that intentionally throws.
  assert.throws(() => mock.ensureBot(), /not connected/);
  // utils / social / resolver / spatial / fairPlay are no-ops or return safe defaults.
  assert.doesNotThrow(() => mock.utils.log('hello'));
  assert.equal(mock.social.getMyName(), 'MockBot');
  assert.deepEqual(mock.social.getNearbyPlayerNames(), []);
  assert.equal(mock.fairPlay.hasLineOfSight(), true);
  assert.deepEqual(mock.fairPlay.filterEntitiesFairPlay([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(mock.getActions(), {});
});

test('createMockServices(overrides) deep-merges at leaf granularity', () => {
  // Override a single state field — others retain createBotState defaults.
  const mock = createMockServices({ state: { world: { botReady: true } } });
  assert.equal(mock.state.world.botReady, true);
  // chatLog is still the default empty array from createBotState.
  assert.ok(Array.isArray(mock.state.social.chatLog));
  assert.equal(mock.state.social.chatLog.length, 0);

  // Override a util — others remain.
  let sleeps = 0;
  const mock2 = createMockServices({ utils: { sleep: async () => { sleeps += 1; } } });
  assert.equal(typeof mock2.utils.fmt, 'function');
  assert.equal(typeof mock2.utils.posObj, 'function');
  mock2.utils.sleep();
  assert.equal(sleeps, 1);

  // Override getActions — function-typed top-level field replaces wholesale.
  const mock3 = createMockServices({ getActions: () => ({ pickup: 'PICKUP' }) });
  assert.deepEqual(mock3.getActions(), { pickup: 'PICKUP' });
});

test('createMockServices() default state matches createBotState shape', async () => {
  // Smoke-test that the mock state has the same top-level keys as the real
  // bot state. If state.js gains a field, the mock picks it up automatically
  // because we delegate to createBotState.
  const { createBotState } = await import('../lib/server/state.js');
  const real = createBotState({ behaviors: { fairPlay: true } });
  const mock = createMockServices();
  const realKeys = Object.keys(real).sort();
  const mockKeys = Object.keys(mock.state).sort();
  assert.deepEqual(mockKeys, realKeys);
});
