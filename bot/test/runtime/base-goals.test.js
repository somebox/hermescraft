/**
 * Unit tests for base-goals.js — per-item threshold lookup + low-stock
 * hint composition. Validates against data/base-goals.yaml at the repo
 * root.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { thresholdsFor, evaluateStock, resourceNames } from '../../lib/runtime/base-goals.js';

test('thresholdsFor: known items map to their resource', () => {
  // bread is in the `food` resource; cobblestone is in `stone`; oak_log in `wood`.
  const breadT = thresholdsFor('bread');
  assert.ok(breadT);
  assert.equal(breadT.resource, 'food');
  assert.equal(breadT.target_min, 64);

  const cobbleT = thresholdsFor('cobblestone');
  assert.ok(cobbleT);
  assert.equal(cobbleT.resource, 'stone');

  const woodT = thresholdsFor('oak_log');
  assert.ok(woodT);
  assert.equal(woodT.resource, 'wood');
});

test('thresholdsFor: unknown / falsy returns null', () => {
  assert.equal(thresholdsFor('mystery_block'), null);
  assert.equal(thresholdsFor(''), null);
  assert.equal(thresholdsFor(null), null);
  assert.equal(thresholdsFor(undefined), null);
});

test('evaluateStock: stock above target_ok → no hint', () => {
  const r = evaluateStock('cobblestone', 1000);
  assert.equal(r.below_min, false);
  assert.equal(r.below_ok, false);
  assert.equal(r.hint, null);
  assert.equal(r.resource, 'stone');
});

test('evaluateStock: stock between min and ok → soft hint only', () => {
  // stone: min=512, ok=768
  const r = evaluateStock('cobblestone', 600);
  assert.equal(r.below_min, false);
  assert.equal(r.below_ok, true);
  assert.ok(r.hint);
  assert.match(r.hint, /600\/768/);
  // No [SUPPLY] mention in soft-warning hint (only when below_min)
  assert.doesNotMatch(r.hint, /SUPPLY/);
});

test('evaluateStock: stock below target_min → SUPPLY hint', () => {
  const r = evaluateStock('cobblestone', 100);
  assert.equal(r.below_min, true);
  assert.equal(r.below_ok, true);
  assert.ok(r.hint);
  assert.match(r.hint, /100\/512/);
  assert.match(r.hint, /SUPPLY/);
  assert.match(r.hint, /target_ok 768/);
});

test('evaluateStock: unknown item → all-empty assessment', () => {
  const r = evaluateStock('mystery_block', 0);
  assert.equal(r.below_min, false);
  assert.equal(r.below_ok, false);
  assert.equal(r.resource, null);
  assert.equal(r.target_min, null);
  assert.equal(r.hint, null);
});

test('evaluateStock: floors fractional counts', () => {
  const r = evaluateStock('cobblestone', 100.7);
  assert.match(r.hint, /100\/512/);  // floored to 100
});

test('resourceNames: includes at least the four documented resources', () => {
  const names = resourceNames();
  assert.ok(names.includes('food'));
  assert.ok(names.includes('wood'));
  assert.ok(names.includes('stone'));
  assert.ok(names.includes('coal'));
});
