import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { collectOrderingPhase } from '../../lib/actions/mining/collect/ordering.js';

test('collect trunk ordering: column top-down within cluster', () => {
  const bot = {
    entity: { position: new Vec3(0.5, 70, 0.5) },
    blockAt: () => ({ name: 'air' }),
  };
  const found = [
    new Vec3(1, 64, 1),
    new Vec3(1, 66, 1),
    new Vec3(1, 65, 1),
  ];
  const r = collectOrderingPhase(
    { b: bot, blockName: 'oak_log', count: 8 },
    { found, isTrunkHarvest: true },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.sorted.map((p) => p.y), [66, 65, 64]);
});
