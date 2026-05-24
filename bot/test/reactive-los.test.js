/**
 * Reactive flee — line-of-sight / present-danger gating.
 *
 * Bug history (2026-05-24):
 *   1. Steward stuck at Y=50 in a dark cave, zombie ~5.4 blocks THROUGH
 *      the cave wall, `flee_step (ranged_no_weapon)` fired every 30s for
 *      4+ minutes because `closest_ranged` was LOS-blind. → Fixed by
 *      gating critical_hp + ranged_no_weapon via `isPresentDanger`.
 *   2. Mason bamboo run: creeper ~5.5 blocks THROUGH a cave wall west
 *      of the farm door, `flee_step (creeper_close)` fired every tick
 *      and killed all goto/move/through with NAV_FAILED. → Fixed by
 *      two-tier creeper gating: LOS-blind only at ≤3 blocks (blast
 *      range), LOS-required at 3–6 blocks (`shouldFleeCreeper`).
 *
 * Both fixes preserve the "active damage" override — a hidden mob that
 * IS landing hits still counts as present, so the bot still flees from
 * skeletons firing through gaps etc.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPresentDanger, shouldFleeCreeper } from '../lib/runtime/reactive.js';

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

// ─── shouldFleeCreeper: two-tier creeper gating ──────────────────────────
// Mason bamboo-blocker matrix. Creeper at various distances, visible or
// hidden, with/without recent damage. Constants in reactive.js:
//   CREEPER_BLAST_RANGE = 3
//   CREEPER_FLEE_RANGE  = 6

const noDamage = { recently_damaged: false };
const withDamage = { recently_damaged: true };

test('shouldFleeCreeper: point-blank (≤3) visible → flee', () => {
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 2.5, visible: true }), true);
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 3.0, visible: true }), true);
});

test('shouldFleeCreeper: point-blank (≤3) hidden → still flee (LOS-blind safety)', () => {
  // Even through a wall a 2-block creeper is too close to wait for LOS
  // confirmation — fuse + explosion radius can damage us before the
  // next 400ms reactive tick.
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 1.5, visible: false }), true);
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 3.0, visible: false }), true);
});

test('shouldFleeCreeper: mid-range (3<d≤6) visible → flee', () => {
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 4.0, visible: true }), true);
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 5.7, visible: true }), true);
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 6.0, visible: true }), true);
});

test('shouldFleeCreeper: mid-range (3<d≤6) hidden, no damage → DO NOT flee (Mason bamboo case)', () => {
  // This is the regression: creeper@5.7 in cave behind wall fired
  // flee_step every tick and killed navigation. With the fix it must
  // return false so the pathfinder can run.
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 3.1, visible: false }), false);
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 5.3, visible: false }), false);
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 5.7, visible: false }), false);
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 6.0, visible: false }), false);
});

test('shouldFleeCreeper: mid-range hidden BUT recently damaged → flee', () => {
  // Damage proves the creeper can reach us through whatever cover
  // exists (rare for creepers, but trust the signal).
  assert.equal(shouldFleeCreeper(withDamage, { name: 'creeper', distance: 4.0, visible: false }), true);
  assert.equal(shouldFleeCreeper(withDamage, { name: 'creeper', distance: 6.0, visible: false }), true);
});

test('shouldFleeCreeper: outside flee range (>6) → never flee', () => {
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 6.1, visible: true }), false);
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', distance: 10, visible: true }), false);
  assert.equal(shouldFleeCreeper(withDamage, { name: 'creeper', distance: 7, visible: true }), false);
});

test('shouldFleeCreeper: null/undefined creeper → no flee', () => {
  assert.equal(shouldFleeCreeper(noDamage, null), false);
  assert.equal(shouldFleeCreeper(noDamage, undefined), false);
});

test('shouldFleeCreeper: creeper without distance field → no flee (defensive)', () => {
  assert.equal(shouldFleeCreeper(noDamage, { name: 'creeper', visible: true }), false);
});
