import test from 'node:test';
import assert from 'node:assert/strict';

import { runCells, cellId } from '../../../lib/runtime/execution-kernel/index.js';
import {
  buildWorksetIndex,
  createConstructAllowUnit,
  unitAllowedInWorkset,
  parseMutationPolicy,
} from '../../../lib/runtime/construct-context.js';

const cells = [
  { x: 0, y: 64, z: 0, category: 'missing', expected_block: 'cobblestone', phase_id: 'L1' },
  { x: 1, y: 64, z: 0, category: 'wrong', expected_block: 'oak_planks', phase_id: 'L1' },
  { x: 2, y: 64, z: 0, category: 'ok', expected_block: 'cobblestone', phase_id: 'L1' },
  { x: 3, y: 64, z: 0, category: 'extra', expected_block: 'air', phase_id: 'L1' },
];

const units = cells.map((c) => ({
  id: cellId(c.x, c.y, c.z),
  x: c.x,
  y: c.y,
  z: c.z,
  meta: { category: c.category, expected_block: c.expected_block },
}));

test('unitAllowedInWorkset add: missing yes, ok/extra no; wrong with policy', () => {
  const policy = parseMutationPolicy(['missing', 'wrong']);
  const idx = buildWorksetIndex(cells);
  assert.equal(unitAllowedInWorkset(idx.get('0,64,0'), 'add', policy), true);
  assert.equal(unitAllowedInWorkset(idx.get('1,64,0'), 'add', policy), true);
  assert.equal(unitAllowedInWorkset(idx.get('2,64,0'), 'add', policy), false);
  assert.equal(unitAllowedInWorkset(idx.get('3,64,0'), 'add', policy), false);
  assert.equal(unitAllowedInWorkset(undefined, 'add', policy), false);
});

test('unitAllowedInWorkset remove: wrong/extra with policy; missing/ok denied', () => {
  const policy = parseMutationPolicy(['wrong', 'extra']);
  const idx = buildWorksetIndex(cells);
  assert.equal(unitAllowedInWorkset(idx.get('0,64,0'), 'remove', policy), false);
  assert.equal(unitAllowedInWorkset(idx.get('1,64,0'), 'remove', policy), true);
  assert.equal(unitAllowedInWorkset(idx.get('2,64,0'), 'remove', policy), false);
  assert.equal(unitAllowedInWorkset(idx.get('3,64,0'), 'remove', policy), true);
});

test('createConstructAllowUnit + runCells: mixed allow/deny, deterministic cursor', async () => {
  const index = buildWorksetIndex(cells);
  const allowUnit = createConstructAllowUnit(index, {
    motorMode: 'add',
    mutationPolicy: ['missing', 'wrong'],
    phase_id: 'L1',
  });
  const acts = [];
  const { envelope } = await runCells({}, units, {
    allowUnit,
    act: async (u) => {
      acts.push(u.id);
      return { status: 'done' };
    },
  }, { mode: 'add', interUnitDelayMs: 0, sleep: async () => {} });

  assert.deepEqual(acts, ['0,64,0', '1,64,0']);
  assert.equal(envelope.counters.scope_denied, 2);
  assert.equal(envelope.counters.placed, 2);
  assert.equal(envelope.cursor.next_index, 4);
  assert.equal(envelope.construct?.category, 2);
});

test('createConstructAllowUnit remove mode respects extra policy only', async () => {
  const index = buildWorksetIndex(cells);
  const allowUnit = createConstructAllowUnit(index, {
    motorMode: 'remove',
    mutationPolicy: ['extra'],
  });
  const acts = [];
  await runCells({}, units, {
    allowUnit,
    act: async (u) => { acts.push(u.id); return { status: 'done' }; },
  }, { mode: 'remove', interUnitDelayMs: 0, sleep: async () => {} });
  assert.deepEqual(acts, ['3,64,0']);
});
