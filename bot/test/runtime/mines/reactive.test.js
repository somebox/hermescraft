import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMineStore } from '../../../lib/runtime/mines/index.js';
import { dangerFamily, resolveDangerMine, recordBreachDanger } from '../../../lib/runtime/mines/reactive.js';

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-mine-react-'));
  return createMineStore({ dataDir: dir, world: 'w' });
}

const lavaBreach = { kind: 'lava', breach_cell: { x: 6, y: 11, z: 8 }, severity: 'critical' };
const waterBreach = { kind: 'flowing_water', breach_cell: { x: 3, y: 12, z: 4 }, severity: 'warn' };

test('dangerFamily maps lava variants to lava, everything else to water', () => {
  assert.equal(dangerFamily('lava'), 'lava');
  assert.equal(dangerFamily('flowing_lava'), 'lava');
  assert.equal(dangerFamily('water'), 'water');
  assert.equal(dangerFamily('flowing_water'), 'water');
});

test('resolveDangerMine prefers a task_context worksite that names a known mine', () => {
  const s = store();
  s.open({ id: 'iron_north', entrance: [0, 60, 0] });
  s.open({ id: 'coal_west', entrance: [3, 60, 3] }); // closer, but worksite wins
  const id = resolveDangerMine(s, { worksiteRegion: ':iron_north:', pos: { x: 4, y: 12, z: 4 } });
  assert.equal(id, 'iron_north');
});

test('resolveDangerMine falls back to nearest entrance when worksite is unknown', () => {
  const s = store();
  s.open({ id: 'near', entrance: [0, 60, 0] });
  s.open({ id: 'far', entrance: [500, 60, 0] });
  const id = resolveDangerMine(s, { worksiteRegion: 'not_a_mine', pos: { x: 5, y: 58, z: 0 } });
  assert.equal(id, 'near');
});

test('resolveDangerMine returns null when nothing is in range', () => {
  const s = store();
  s.open({ id: 'far', entrance: [500, 60, 0] });
  assert.equal(resolveDangerMine(s, { pos: { x: 0, y: 60, z: 0 }, maxDist: 48 }), null);
});

test('recordBreachDanger writes a sealed water danger to the bound mine', () => {
  const s = store();
  s.open({ id: 'm1', entrance: [0, 60, 0] });
  const r = recordBreachDanger(s, waterBreach, { pos: { x: 2, y: 12, z: 4 }, sealed: true, by: 'Tester' });
  assert.equal(r.mineId, 'm1');
  assert.equal(r.point.kind, 'danger');
  assert.equal(r.point.hazard, 'water');
  assert.equal(r.point.sealed, true);
  assert.deepEqual(r.point.pos, { x: 3, y: 12, z: 4 });
  assert.equal(s.get('m1').points.length, 1);
});

test('recordBreachDanger records lava unsealed (retreat-first, no plug)', () => {
  const s = store();
  s.open({ id: 'm1', entrance: [0, 60, 0] });
  const r = recordBreachDanger(s, lavaBreach, { pos: { x: 5, y: 11, z: 8 }, sealed: false });
  assert.equal(r.point.hazard, 'lava');
  assert.equal(r.point.sealed, false);
});

test('recordBreachDanger re-firing on the same cell updates in place (no duplicates)', () => {
  const s = store();
  s.open({ id: 'm1', entrance: [0, 60, 0] });
  recordBreachDanger(s, lavaBreach, { pos: { x: 5, y: 11, z: 8 }, sealed: false });
  const second = recordBreachDanger(s, lavaBreach, { pos: { x: 5, y: 11, z: 8 }, sealed: true });
  assert.equal(s.get('m1').points.length, 1);
  assert.equal(second.point.sealed, true);
});

test('recordBreachDanger never throws and reports why nothing was recorded', () => {
  const s = store();
  assert.deepEqual(recordBreachDanger(null, waterBreach, {}), { mineId: null, reason: 'no_store' });
  assert.equal(recordBreachDanger(s, waterBreach, { pos: { x: 0, y: 60, z: 0 } }).reason, 'no_mine_in_range');
  assert.equal(recordBreachDanger(s, { kind: 'water' }, {}).reason, 'no_breach_cell');
});
