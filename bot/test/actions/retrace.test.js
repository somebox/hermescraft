import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRetraceStepCell,
  ascentTargetsFromSteps,
} from '../../lib/actions/movement/retrace.js';

function mockBot(blocks) {
  return {
    blockAt(pos) {
      const k = `${pos.x},${pos.y},${pos.z}`;
      return blocks[k] || { name: 'air', boundingBox: 'empty' };
    },
  };
}

test('ascentTargetsFromSteps reverses descent order', () => {
  const steps = [
    { x: 0, y: 65, z: 0 },
    { x: 0, y: 64, z: -1 },
    { x: 0, y: 63, z: -2 },
  ];
  assert.deepEqual(ascentTargetsFromSteps(steps), [
    { x: 0, y: 63, z: -2 },
    { x: 0, y: 64, z: -1 },
    { x: 0, y: 65, z: 0 },
  ]);
});

test('ascentTargetsFromSteps: fewer than 2 steps → empty', () => {
  assert.deepEqual(ascentTargetsFromSteps([{ x: 0, y: 65, z: 0 }]), []);
  assert.deepEqual(ascentTargetsFromSteps(null), []);
});

test('validateRetraceStepCell: clear stair tread', () => {
  const b = mockBot({
    '0,62,-2': { name: 'stone', boundingBox: 'block' },
    '0,63,-2': { name: 'air', boundingBox: 'empty' },
    '0,64,-2': { name: 'air', boundingBox: 'empty' },
  });
  const r = validateRetraceStepCell(b, { x: 0, y: 63, z: -2 });
  assert.equal(r.ok, true);
});

test('validateRetraceStepCell: gap below', () => {
  const b = mockBot({
    '0,62,-2': { name: 'air', boundingBox: 'empty' },
    '0,63,-2': { name: 'air', boundingBox: 'empty' },
    '0,64,-2': { name: 'air', boundingBox: 'empty' },
  });
  const r = validateRetraceStepCell(b, { x: 0, y: 63, z: -2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gap');
});

test('validateRetraceStepCell: obstruction at feet', () => {
  const b = mockBot({
    '0,62,-2': { name: 'stone', boundingBox: 'block' },
    '0,63,-2': { name: 'cobblestone', boundingBox: 'block' },
    '0,64,-2': { name: 'air', boundingBox: 'empty' },
  });
  const r = validateRetraceStepCell(b, { x: 0, y: 63, z: -2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'obstruction');
});
