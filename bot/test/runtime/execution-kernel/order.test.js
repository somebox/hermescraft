import test from 'node:test';
import assert from 'node:assert/strict';

import { orderCells, cellId, boustrophedonXZ } from '../../../lib/runtime/execution-kernel/order.js';

function boxCells(x1, x2, y1, y2, z1, z2) {
  const out = [];
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      for (let z = z1; z <= z2; z++) {
        out.push({ x, y, z, id: cellId(x, y, z) });
      }
    }
  }
  return out;
}

test('orderCells remove volume: 3×3×2 visits high Y layers first', () => {
  const cells = boxCells(0, 2, 60, 61, 0, 2);
  const ordered = orderCells(cells, { mode: 'remove', shape: 'volume', botPos: { x: 0, y: 64, z: 0 } });
  assert.equal(ordered[0].y, 61);
  assert.equal(ordered[ordered.length - 1].y, 60);
  const y61 = ordered.filter((c) => c.y === 61);
  assert.equal(y61.length, 9);
});

test('orderCells remove column: 1×1×4 is Y high → low', () => {
  const cells = boxCells(5, 5, 64, 67, 5, 5);
  const ordered = orderCells(cells, { mode: 'remove', shape: 'auto', botPos: { x: 5, y: 70, z: 5 } });
  assert.deepEqual(ordered.map((c) => c.y), [67, 66, 65, 64]);
});

test('orderCells forced column on multi-xz footprint groups by column', () => {
  const cells = [
    { x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 },
    { x: 1, y: 64, z: 0 }, { x: 1, y: 65, z: 0 },
  ];
  const ordered = orderCells(cells, { mode: 'remove', shape: 'column', botPos: { x: 0, y: 70, z: 0 } });
  assert.equal(ordered[0].x, 0);
  assert.equal(ordered[0].y, 65);
  assert.equal(ordered[1].y, 64);
  assert.equal(ordered[2].x, 1);
});

test('orderCells add inverts vertical direction', () => {
  const cells = boxCells(0, 0, 64, 67, 0, 0);
  const ordered = orderCells(cells, { mode: 'add', shape: 'column', botPos: { x: 0, y: 70, z: 0 } });
  assert.deepEqual(ordered.map((c) => c.y), [64, 65, 66, 67]);
});

test('orderCells preserveOrder keeps input sequence', () => {
  const cells = [
    { x: 2, y: 64, z: 2 }, { x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 1 },
  ];
  const ordered = orderCells(cells, { mode: 'remove', preserveOrder: true });
  assert.deepEqual(ordered.map((c) => c.x), [2, 0, 1]);
});

test('orderCells deferIds append foot cell last within pass', () => {
  const cells = boxCells(0, 1, 64, 64, 0, 1);
  const foot = cellId(0, 64, 0);
  const ordered = orderCells(cells, {
    mode: 'remove',
    shape: 'volume',
    botPos: { x: 0.5, y: 65, z: 0.5 },
    deferIds: [foot],
  });
  assert.equal(ordered[ordered.length - 1].id, foot);
});

test('boustrophedonXZ alternates row direction', () => {
  const layer = [];
  for (let x = 0; x <= 2; x++) {
    for (let z = 0; z <= 1; z++) layer.push({ x, y: 64, z });
  }
  const sweep = boustrophedonXZ(layer, 0, 0);
  const z0 = sweep.filter((c) => c.z === 0).map((c) => c.x);
  const z1 = sweep.filter((c) => c.z === 1).map((c) => c.x);
  assert.notDeepEqual(z0, z1);
});
