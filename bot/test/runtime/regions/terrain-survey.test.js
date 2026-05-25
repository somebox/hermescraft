import test from 'node:test';
import assert from 'node:assert/strict';
import {
  columnsInRect,
  columnsInRegionDisc,
  summarizePlotTerrain,
} from '../../../lib/runtime/regions/terrain-survey.js';

test('columnsInRect: inclusive 2x2', () => {
  const c = columnsInRect(0, 0, 1, 1);
  assert.equal(c.length, 4);
});

test('summarizePlotTerrain: flat tillable plot passes', () => {
  const columns = [
    { x: 365, z: -567, topY: 65, blockName: 'grass_block', belowName: 'dirt' },
    { x: 366, z: -567, topY: 65, blockName: 'grass_block', belowName: 'dirt' },
  ];
  const s = summarizePlotTerrain(columns, { expectY: 65, flatMaxDelta: 1 });
  assert.equal(s.ok, true);
  assert.equal(s.delta_y, 0);
});

test('summarizePlotTerrain: expect-y mismatch fails spec', () => {
  const columns = [
    { x: 365, z: -567, topY: 63, blockName: 'grass_block', belowName: 'dirt' },
    { x: 366, z: -567, topY: 65, blockName: 'grass_block', belowName: 'dirt' },
  ];
  const s = summarizePlotTerrain(columns, { expectY: 65, flatMaxDelta: 1 });
  assert.equal(s.ok, false);
  assert.ok(s.issues.some((i) => i.code === 'terrain_flatness' || i.code === 'terrain_expect_y'));
});

test('summarizePlotTerrain: floating surface fails prep', () => {
  const columns = [
    { x: 365, z: -567, topY: 65, blockName: 'grass_block', belowName: 'air' },
  ];
  const s = summarizePlotTerrain(columns, { expectY: 65 });
  assert.equal(s.ok, false);
  assert.ok(s.issues.some((i) => i.code === 'terrain_floating'));
});

test('summarizePlotTerrain: worksite coverage outside fails', () => {
  const columns = [
    { x: 365, z: -567, topY: 65, blockName: 'grass_block', belowName: 'dirt' },
    { x: 370, z: -567, topY: 65, blockName: 'grass_block', belowName: 'dirt' },
  ];
  const coverage = [
    { x: 365, z: -567, inside: true },
    { x: 370, z: -567, inside: false },
  ];
  const s = summarizePlotTerrain(columns, {
    expectY: 65,
    worksiteCoverage: coverage,
    worksiteCoverageMinPct: 100,
  });
  assert.equal(s.ok, false);
  assert.ok(s.issues.some((i) => i.code === 'worksite_coverage'));
  assert.match(s.next_action_hint || '', /task_spec_invalid:worksite_coverage/);
});

test('columnsInRegionDisc: radius 1 has 5 cells', () => {
  const cols = columnsInRegionDisc({ x: 0, y: 64, z: 0 }, { kind: 'column', radius: 1 });
  assert.equal(cols.length, 5);
});
