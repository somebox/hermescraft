import test from 'node:test';
import assert from 'node:assert/strict';

import { orderColumnsBoustrophedon, orderCells, cellId } from '../../lib/runtime/execution-kernel/order.js';

test('level column visit order: boustrophedon over 2×2 footprint', () => {
  const cols = [
    { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 1 },
  ];
  const ordered = orderColumnsBoustrophedon(cols, { x: 0.5, z: 0.5 });
  assert.equal(ordered.length, 4);
  assert.deepEqual(ordered[0], { x: 0, z: 0 });
});

test('level dig-above stack: orderCells column mode is Y descending', () => {
  const stack = [
    { x: 3, y: 64, z: 3 },
    { x: 3, y: 65, z: 3 },
    { x: 3, y: 66, z: 3 },
  ];
  const ordered = orderCells(
    stack.map((c) => ({ ...c, id: cellId(c.x, c.y, c.z) })),
    { mode: 'remove', shape: 'column', botPos: { x: 3, y: 70, z: 3 } },
  );
  assert.deepEqual(ordered.map((c) => c.y), [66, 65, 64]);
});
