import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldDeferReaction } from '../../lib/runtime/reactive.js';

// Phase 0 interim sync-gate: non-life-critical reactions defer while a worker
// command is in flight; life-critical + survival reactions still preempt.

test('does NOT defer when no worker command is in flight', () => {
  assert.equal(shouldDeferReaction({ action: 'flee_step', why: 'no_weapon_distant' }, {}), false);
  assert.equal(
    shouldDeferReaction({ action: 'flee_step', why: 'no_weapon_distant' },
      { syncActionInFlight: false, currentTask: { status: 'idle' } }),
    false,
  );
});

test('defers offensive + distant flee while a SYNC action is in flight', () => {
  const tasks = { syncActionInFlight: true };
  assert.equal(shouldDeferReaction({ action: 'attack_step', why: 'engage' }, tasks), true);
  assert.equal(shouldDeferReaction({ action: 'advance_step', why: 'engage' }, tasks), true);
  assert.equal(shouldDeferReaction({ action: 'flee_step', why: 'no_weapon_distant' }, tasks), true);
  assert.equal(shouldDeferReaction({ action: 'flee_step', why: 'shaky_hp' }, tasks), true);
});

test('defers while a BACKGROUND task is running too', () => {
  const tasks = { currentTask: { status: 'running' } };
  assert.equal(shouldDeferReaction({ action: 'attack_step', why: 'engage' }, tasks), true);
});

test('NEVER defers life-critical flee (creeper_close / critical_hp)', () => {
  const tasks = { syncActionInFlight: true };
  assert.equal(shouldDeferReaction({ action: 'flee_step', why: 'creeper_close' }, tasks), false);
  assert.equal(shouldDeferReaction({ action: 'flee_step', why: 'critical_hp' }, tasks), false);
});

test('NEVER defers survival reactions (escape/swim/disembark) — not in the deferrable set', () => {
  const tasks = { syncActionInFlight: true };
  for (const action of ['escape_lava', 'swim_up', 'auto_escape_water', 'auto_disembark_low_hp']) {
    assert.equal(shouldDeferReaction({ action, why: 'hazard' }, tasks), false, `${action} must preempt`);
  }
});
