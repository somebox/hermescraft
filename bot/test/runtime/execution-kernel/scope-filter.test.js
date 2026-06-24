import test from 'node:test';
import assert from 'node:assert/strict';

import { runCells } from '../../../lib/runtime/execution-kernel/run.js';

const units = [
  { id: 'a', x: 0, y: 0, z: 0 },
  { id: 'b', x: 1, y: 0, z: 0 },
  { id: 'c', x: 2, y: 0, z: 0 },
];

test('scope filter: denied units advance cursor deterministically', async () => {
  const acts = [];
  const { envelope } = await runCells({}, units, {
    allowUnit: async (u) => u.id !== 'b',
    act: async (u) => { acts.push(u.id); return { status: 'done' }; },
  }, { interUnitDelayMs: 0, sleep: async () => {} });
  assert.deepEqual(acts, ['a', 'c']);
  assert.equal(envelope.counters.scope_denied, 1);
  assert.equal(envelope.cursor.next_index, 3);
  assert.equal(envelope.resume.plan_hash.length, 16);
});
