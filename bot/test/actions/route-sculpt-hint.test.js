import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findTwoHighLipDig,
  standabilityActionHint,
  resolveRouteSculptHint,
} from '../../lib/actions/movement/route-sculpt-hint.js';

function mockBot(blocks) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt(pos) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      return blocks[key] || { name: 'air', boundingBox: 'empty' };
    },
  };
}

test('standabilityActionHint: suggests goto_near to closest_standable', () => {
  const hint = standabilityActionHint(
    { target_standable: false, closest_standable: { x: 5, y: 64, z: 3, distance: 2 } },
    { x: 10, y: 70, z: 10 },
  );
  assert.match(hint, /mc reachable 10 70 10/);
  assert.match(hint, /mc goto_near 5 64 3 range=1/);
});

test('findTwoHighLipDig: 2-high lip on step_up direction', () => {
  const b = mockBot({
    '1,64,0': { name: 'stone', boundingBox: 'block' },
    '1,65,0': { name: 'stone', boundingBox: 'block' },
    '1,66,0': { name: 'air', boundingBox: 'empty' },
  });
  const ss = {
    classification: 'step_up_only',
    cell: { x: 0, y: 64, z: 0 },
    step_up_dirs: ['E'],
  };
  const lip = findTwoHighLipDig(b, ss);
  assert.deepEqual(lip, { x: 1, y: 65, z: 0 });
});

test('resolveRouteSculptHint: slope_N toward north target suggests build_stairs', () => {
  const b = mockBot({});
  const out = resolveRouteSculptHint({
    bot: b,
    target: { x: 0, y: 64, z: -20 },
    pos: { x: 0, y: 64, z: 0 },
    terrain: { terrain_kind: 'slope_N' },
    standing: { classification: 'open', cell: { x: 0, y: 64, z: 0 }, step_up_dirs: [] },
  });
  assert.equal(out.pattern, 'ramp_build');
  assert.match(out.hint, /mc build_stairs cobblestone north/);
});

test('resolveRouteSculptHint: trapped with lip pattern', () => {
  const b = mockBot({
    '0,64,-1': { name: 'stone', boundingBox: 'block' },
    '0,65,-1': { name: 'stone', boundingBox: 'block' },
    '0,66,-1': { name: 'air', boundingBox: 'empty' },
  });
  const out = resolveRouteSculptHint({
    bot: b,
    target: { x: 0, y: 64, z: -5 },
    pos: { x: 0, y: 64, z: 0 },
    standing: {
      classification: 'trapped',
      cell: { x: 0, y: 64, z: 0 },
      step_up_dirs: ['N'],
    },
  });
  assert.equal(out.pattern, 'lip_dig');
  assert.match(out.hint, /mc dig/);
});

test('resolveRouteSculptHint: cliff_above with large dy may suggest pillar anchor or stairs', () => {
  const b = mockBot({
    '0,69,-2': { name: 'stone', boundingBox: 'block' },
    '0,70,-2': { name: 'air', boundingBox: 'empty' },
    '0,71,-2': { name: 'air', boundingBox: 'empty' },
  });
  const out = resolveRouteSculptHint({
    bot: b,
    target: { x: 0, y: 72, z: 0 },
    pos: { x: 0, y: 64, z: 0 },
    terrain: { terrain_kind: 'cliff_above' },
    standing: { classification: 'open', cell: { x: 0, y: 64, z: 0 }, step_up_dirs: [] },
  });
  assert.ok(['pillar_anchor', 'cliff_build_stairs', 'vertical_detour'].includes(out.pattern));
  assert.ok(out.hint);
});
