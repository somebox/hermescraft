import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRecipeIngredientName,
  ingredientCountsFromSlots,
} from '../lib/shared/recipe-ingredients.js';

const mcData = {
  items: {
    265: { name: 'iron_ingot' },
    280: { name: 'stick' },
  },
};

test('resolveRecipeIngredientName resolves nested id objects', () => {
  const name = resolveRecipeIngredientName({ id: { id: 265, metadata: null, count: 1 } }, mcData);
  assert.equal(name, 'iron_ingot');
});

test('resolveRecipeIngredientName skips wildcard nested id entries', () => {
  const name = resolveRecipeIngredientName({ id: { id: -1, metadata: null, count: 1 } }, mcData);
  assert.equal(name, null);
});

test('ingredientCountsFromSlots computes readable totals with multiplier', () => {
  const slots = [
    { id: { id: 265, metadata: null, count: 1 } },
    { id: { id: 265, metadata: null, count: 1 } },
    { id: { id: 280, metadata: null, count: 1 } },
    { id: { id: -1, metadata: null, count: 1 } },
  ];
  const counts = ingredientCountsFromSlots(slots, mcData, 2);
  assert.deepEqual(counts, { iron_ingot: 4, stick: 2 });
});

test('resolveRecipeIngredientName does not stringify to [object Object]', () => {
  const weird = { block: { foo: 'bar' } };
  const name = resolveRecipeIngredientName(weird, mcData);
  assert.equal(typeof name, 'string');
  assert.equal(name.includes('[object Object]'), false);
});
