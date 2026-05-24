/**
 * Reactive flee — line-of-sight / present-danger gating.
 *
 * Bug history (2026-05-24): Steward was stuck at Y=50 in a dark cave
 * with a zombie ~5.4 blocks away THROUGH the cave wall. The reactive
 * layer fired `flee_step (ranged_no_weapon)` every 30s for 4+ minutes
 * because `closest_ranged` was LOS-blind. The agent couldn't make
 * strategic progress and HP drained 20→10 from sporadic damage when
 * the zombie did find a path.
 *
 * Fix: gate the `critical_hp` and `ranged_no_weapon` flee branches with
 * `isPresentDanger(state, threat)` — a non-creeper threat is only
 * "present" if visible (LOS) OR currently damaging us. A hostile through
 * a wall not currently landing hits = let the agent decide.
 *
 * Creeper proximity (CREEPER_FLEE_RANGE) is intentionally LOS-blind —
 * creepers detonate through cover faster than the agent loop reacts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPresentDanger } from '../lib/runtime/reactive.js';

// Minimal threat fixtures matching collectState()'s hostile shape:
//   { entity, name, position, distance, visible }
const visibleZombie = { name: 'zombie', distance: 5.4, visible: true };
const hiddenZombie = { name: 'zombie', distance: 5.4, visible: false };
const visibleSkeleton = { name: 'skeleton', distance: 10, visible: true };
const hiddenSkeleton = { name: 'skeleton', distance: 10, visible: false };

test('isPresentDanger: visible threat is always a present danger', () => {
  assert.equal(isPresentDanger({ recently_damaged: false }, visibleZombie), true);
  assert.equal(isPresentDanger({ recently_damaged: false }, visibleSkeleton), true);
});

test('isPresentDanger: hidden threat with no recent damage is NOT a present danger', () => {
  // This is the Steward cave case — zombie through the wall, no damage
  // currently landing → bot should not interrupt strategic thinking.
  assert.equal(isPresentDanger({ recently_damaged: false }, hiddenZombie), false);
  assert.equal(isPresentDanger({ recently_damaged: false }, hiddenSkeleton), false);
});

test('isPresentDanger: hidden threat WITH recent damage IS a present danger', () => {
  // Skeleton firing arrows through a gap, drowned hitting from underwater —
  // we can't see them but they ARE reaching us. Trust the damage signal.
  assert.equal(isPresentDanger({ recently_damaged: true }, hiddenSkeleton), true);
  assert.equal(isPresentDanger({ recently_damaged: true }, hiddenZombie), true);
});

test('isPresentDanger: null/undefined threat is never a present danger', () => {
  assert.equal(isPresentDanger({ recently_damaged: true }, null), false);
  assert.equal(isPresentDanger({ recently_damaged: true }, undefined), false);
});

test('isPresentDanger: empty state object handled gracefully', () => {
  // Defensive: state may be malformed in test harness or under partial
  // collectState() failures. Shouldn't throw.
  assert.equal(isPresentDanger({}, visibleZombie), true);   // visible always wins
  assert.equal(isPresentDanger({}, hiddenZombie), false);   // no damage info → not present
  assert.equal(isPresentDanger(null, visibleZombie), true); // null state but visible threat
  assert.equal(isPresentDanger(null, hiddenZombie), false);
});

test('isPresentDanger: visibility is a hard signal — recent damage does not override invisibility check polarity', () => {
  // Both signals positive → present.
  assert.equal(isPresentDanger({ recently_damaged: true }, visibleZombie), true);
});

test('isPresentDanger: explicit visible=undefined treated as not visible', () => {
  // collectState() sets visible from a raycast; if the raycast helper
  // throws or returns undefined we default to "not visible" to avoid
  // false positives.
  const ambiguous = { name: 'zombie', distance: 5, visible: undefined };
  assert.equal(isPresentDanger({ recently_damaged: false }, ambiguous), false);
  assert.equal(isPresentDanger({ recently_damaged: true }, ambiguous), true);
});
