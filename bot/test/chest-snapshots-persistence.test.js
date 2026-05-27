/**
 * Tests for chest-snapshot persistence helpers.
 *
 * Mirrors the goalsStore persistence pattern: load on startup, save after
 * every chest interaction. These tests exercise the engine.js helpers
 * directly (server.js wires them via ctx.goals.chestSnapshots).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  chestSnapshotsFileForUser,
  loadChestSnapshots,
  saveChestSnapshots,
} from '../lib/goals/engine.js';

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chest-snap-test-'));
  return path.join(dir, name);
}

test('chestSnapshotsFileForUser slugs the username and uses data dir', () => {
  const p = chestSnapshotsFileForUser('HermesBot');
  assert.match(p, /chest-snapshots-hermesbot\.json$/);
  // Bad characters are replaced with underscores.
  const p2 = chestSnapshotsFileForUser('Weird Name!');
  assert.match(p2, /chest-snapshots-weird_name_\.json$/);
});

test('saveChestSnapshots then loadChestSnapshots round-trips an example map', () => {
  const file = tmpFile('chest-snapshots-test.json');
  const snapshots = {
    'storage_room': {
      at: '2026-05-26T12:00:00.000Z',
      position: { x: 10, y: 64, z: -5 },
      total: 5,
      items: [
        { name: 'oak_log', count: 3 },
        { name: 'cobblestone', count: 2 },
      ],
    },
    '12,64,30': {
      at: '2026-05-26T12:01:00.000Z',
      position: { x: 12, y: 64, z: 30 },
      total: 1,
      items: [{ name: 'iron_ingot', count: 1 }],
    },
  };

  saveChestSnapshots(file, snapshots);
  assert.ok(fs.existsSync(file), 'file should exist after save');

  const loaded = loadChestSnapshots(file);
  assert.deepEqual(loaded, snapshots);
});

test('loadChestSnapshots on a missing file returns {} without throwing', () => {
  const file = path.join(os.tmpdir(), 'definitely-does-not-exist-' + Date.now() + '.json');
  const loaded = loadChestSnapshots(file);
  assert.deepEqual(loaded, {});
});

test('loadChestSnapshots on corrupted JSON returns {} without throwing', () => {
  const file = tmpFile('corrupted.json');
  fs.writeFileSync(file, '{ this is { not valid json');
  const loaded = loadChestSnapshots(file);
  assert.deepEqual(loaded, {});
});

test('loadChestSnapshots on JSON-but-wrong-shape returns {} (array)', () => {
  const file = tmpFile('array.json');
  fs.writeFileSync(file, JSON.stringify([1, 2, 3]));
  const loaded = loadChestSnapshots(file);
  assert.deepEqual(loaded, {});
});

test('loadChestSnapshots tolerates partial entries (missing fields filled in)', () => {
  const file = tmpFile('partial.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      good: {
        at: '2026-01-01T00:00:00.000Z',
        position: { x: 1, y: 2, z: 3 },
        total: 1,
        items: [{ name: 'stick', count: 1 }],
      },
      missing_items: { at: '2026-01-01T00:00:00.000Z', position: { x: 0, y: 0, z: 0 } },
      not_an_object: 42,
    }),
  );
  const loaded = loadChestSnapshots(file);
  assert.equal(loaded.good.items.length, 1);
  assert.deepEqual(loaded.missing_items.items, []);
  assert.equal(loaded.missing_items.total, 0);
  assert.equal(loaded.not_an_object, undefined);
});

test('saveChestSnapshots writes atomically (no .tmp file remains, final file present)', () => {
  const file = tmpFile('atomic.json');
  const tmp = `${file}.tmp`;

  saveChestSnapshots(file, { mark: { at: 'x', position: { x: 0, y: 0, z: 0 }, total: 0, items: [] } });

  assert.ok(fs.existsSync(file), 'final file should exist');
  assert.ok(!fs.existsSync(tmp), '.tmp file should be renamed away');
});

test('saveChestSnapshots overwrites prior contents (last write wins)', () => {
  const file = tmpFile('overwrite.json');
  saveChestSnapshots(file, { a: { at: 't1', position: { x: 0, y: 0, z: 0 }, total: 0, items: [] } });
  saveChestSnapshots(file, { b: { at: 't2', position: { x: 1, y: 1, z: 1 }, total: 1, items: [{ name: 'dirt', count: 1 }] } });
  const loaded = loadChestSnapshots(file);
  assert.equal(loaded.a, undefined);
  assert.equal(loaded.b.items[0].name, 'dirt');
});

test('saveChestSnapshots creates parent dir if missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chest-snap-mkdir-'));
  const nested = path.join(root, 'nested', 'deeper', 'snaps.json');
  saveChestSnapshots(nested, {});
  assert.ok(fs.existsSync(nested), 'nested file should exist after mkdir -p');
});

test('saveChestSnapshots writes 2-space pretty JSON (human-inspectable)', () => {
  const file = tmpFile('pretty.json');
  saveChestSnapshots(file, { m: { at: 't', position: { x: 0, y: 0, z: 0 }, total: 0, items: [] } });
  const raw = fs.readFileSync(file, 'utf8');
  // 2-space indent puts a newline + two spaces before the first key.
  assert.match(raw, /\n  "m":/);
});
