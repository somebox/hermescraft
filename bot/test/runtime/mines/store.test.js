import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMineStore, normalizeMineId, POINT_KINDS } from '../../../lib/runtime/mines/index.js';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hc-mines-${tag}-`));
}

test('open() registers a mine and persists across cold load', () => {
  const dir = tmpDir('open');
  const store = createMineStore({ dataDir: dir, world: 'testworld' });
  store.open({ id: 'iron_north', entrance: [368, 57, -590], dir: 'north', target_y: 12, resource: 'iron_ore' });

  const fresh = createMineStore({ dataDir: dir, world: 'testworld' });
  const m = fresh.get('iron_north');
  assert.ok(m);
  assert.equal(m.status, 'active');
  assert.equal(m.resource, 'iron_ore');
  assert.equal(m.target_y, 12);
  assert.equal(m.entrances.length, 1);
  assert.deepEqual(m.entrances[0].pos, { x: 368, y: 57, z: -590 });
  assert.equal(m.entrances[0].dir, 'north');
});

test('open() is idempotent on id and dedupes entrances by position', () => {
  const dir = tmpDir('idem');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  store.open({ id: 'm1', entrance: [0, 60, 0], dir: 'north' });
  store.open({ id: 'm1', entrance: [0, 60, 0], dir: 'north' }); // same pos → no dup
  store.open({ id: 'm1', entrance: [10, 60, 10], dir: 'south' }); // second route to surface
  const m = store.get('m1');
  assert.equal(m.entrances.length, 2);
});

test('normalizeMineId strips colons and snake-cases', () => {
  assert.equal(normalizeMineId(':Iron-North:'), 'iron_north');
  assert.equal(normalizeMineId('coal mine 2'), 'coal_mine_2');
});

test('addPoint stores each annotated kind with kind-specific fields', () => {
  const dir = tmpDir('points');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  store.open({ id: 'm1', entrance: [0, 60, 0] });

  const landing = store.addPoint('m1', { kind: 'landing', pos: [0, 12, 0] });
  assert.equal(landing.id, 'p1');
  assert.equal(landing.status, 'active');

  const ore = store.addPoint('m1', { kind: 'ore', pos: [4, 12, 2], resource: 'iron_ore', qty_estimate: 8 });
  assert.equal(ore.status, 'open');
  assert.equal(ore.resource, 'iron_ore');
  assert.equal(ore.qty_estimate, 8);

  const frontier = store.addPoint('m1', { kind: 'frontier', pos: [0, 12, 30], dir: 'north', target_y: 10 });
  assert.equal(frontier.status, 'open');
  assert.equal(frontier.dir, 'north');
  assert.equal(frontier.target_y, 10);

  const danger = store.addPoint('m1', { kind: 'danger', pos: [6, 11, 8], hazard: 'lava', sealed: true });
  assert.equal(danger.hazard, 'lava');
  assert.equal(danger.sealed, true);

  const fresh = createMineStore({ dataDir: dir, world: 'w' });
  assert.equal(fresh.get('m1').points.length, 4);
});

test('addPoint dedupes by (kind, pos) — reactive danger fires repeatedly on one cell', () => {
  const dir = tmpDir('dedupe');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  store.open({ id: 'm1', entrance: [0, 60, 0] });
  const first = store.addPoint('m1', { kind: 'danger', pos: [6, 11, 8], hazard: 'lava', sealed: false });
  const second = store.addPoint('m1', { kind: 'danger', pos: [6, 11, 8], hazard: 'lava', sealed: true });
  assert.equal(first.id, second.id); // same record updated in place
  assert.equal(store.get('m1').points.length, 1);
  assert.equal(store.get('m1').points[0].sealed, true);
  // A danger of a different kind at the same cell is distinct.
  store.addPoint('m1', { kind: 'ore', pos: [6, 11, 8], resource: 'iron_ore' });
  assert.equal(store.get('m1').points.length, 2);
});

test('addPoint rejects unknown kinds', () => {
  const dir = tmpDir('badkind');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  store.open({ id: 'm1', entrance: [0, 60, 0] });
  assert.throws(() => store.addPoint('m1', { kind: 'wormhole', pos: [0, 0, 0] }), /unknown point kind/);
  assert.ok(POINT_KINDS.has('frontier'));
});

test('addPoint returns null for an unknown mine', () => {
  const dir = tmpDir('nomine');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  assert.equal(store.addPoint('ghost', { kind: 'landing', pos: [0, 0, 0] }), null);
});

test('updatePoint patches a point and keeps identity fields immutable', () => {
  const dir = tmpDir('update');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  store.open({ id: 'm1', entrance: [0, 60, 0] });
  const ore = store.addPoint('m1', { kind: 'ore', pos: [4, 12, 2], resource: 'iron_ore', qty_estimate: 8 });
  const patched = store.updatePoint('m1', ore.id, { status: 'extracted', qty_estimate: 0, kind: 'danger' });
  assert.equal(patched.status, 'extracted');
  assert.equal(patched.qty_estimate, 0);
  assert.equal(patched.kind, 'ore'); // kind is immutable
});

test('setStatus transitions a mine and rejects unknown statuses', () => {
  const dir = tmpDir('status');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  store.open({ id: 'm1', entrance: [0, 60, 0] });
  assert.equal(store.setStatus('m1', 'exhausted').status, 'exhausted');
  assert.throws(() => store.setStatus('m1', 'on_fire'), /unknown mine status/);
});

test('nearestEntrance binds a position to the closest mine within range', () => {
  const dir = tmpDir('nearest');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  store.open({ id: 'near', entrance: [0, 60, 0] });
  store.open({ id: 'far', entrance: [500, 60, 500] });
  const hit = store.nearestEntrance([3, 58, 4], 64);
  assert.equal(hit.mineId, 'near');
  assert.ok(hit.distance <= 64);
  assert.equal(store.nearestEntrance([1000, 60, 1000], 64), null);
});

test('listForApi sorts by entrance distance and counts points by kind', () => {
  const dir = tmpDir('api');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  store.open({ id: 'far', entrance: [200, 60, 0] });
  store.open({ id: 'near', entrance: [5, 60, 0] });
  store.addPoint('near', { kind: 'ore', pos: [6, 12, 0] });
  store.addPoint('near', { kind: 'ore', pos: [7, 12, 0] });
  store.addPoint('near', { kind: 'frontier', pos: [8, 12, 0], dir: 'east', target_y: 12 });
  const rows = store.listForApi({ botPos: { x: 0, y: 64, z: 0 } });
  assert.equal(rows[0].id, 'near');
  assert.equal(rows[0].point_counts.ore, 2);
  assert.equal(rows[0].point_counts.frontier, 1);
});

test('reload() picks up file edits made after store creation', () => {
  const dir = tmpDir('reload');
  const store = createMineStore({ dataDir: dir, world: 'w' });
  store.open({ id: 'm1', entrance: [0, 60, 0] });
  const filePath = path.join(dir, 'mines-w.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.mines[0].status = 'abandoned';
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  assert.equal(store.get('m1').status, 'active'); // cache stale until reload
  store.reload();
  assert.equal(store.get('m1').status, 'abandoned');
});
