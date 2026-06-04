import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  dedupePersonalPois,
  loadSharedPersonalPois,
  personalPoisForSource,
} from '../lib/personal-pois.js';

test('loadSharedPersonalPois reads name-keyed shared file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-poi-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'personal-pois-shared.json'),
    JSON.stringify({
      hill: { x: 10, y: 70, z: 20, kind: 'landmark', last_seen: '2026-01-01T00:00:00Z' },
    }),
  );
  const rows = loadSharedPersonalPois(dir, 'proc-lab');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'hill');
  assert.equal(rows[0].source, 'shared');
});

test('personalPoisForSource merge dedupes live vs shared', () => {
  const live = [
    {
      world: 'proc-lab',
      name: 'a',
      x: 1,
      y: 2,
      z: 3,
      last_seen: '2026-01-01T00:00:00Z',
    },
  ];
  const shared = [
    {
      world: 'proc-lab',
      name: 'a',
      x: 9,
      y: 9,
      z: 9,
      last_seen: '2026-06-01T00:00:00Z',
      source: 'shared',
    },
  ];
  const merged = personalPoisForSource(live, shared, 'merge');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].x, 9);
});

test('personalPoisForSource live-only', () => {
  const live = [{ world: 'w', name: 'b', x: 0, y: 0, z: 0 }];
  assert.equal(personalPoisForSource(live, [], 'live').length, 1);
  assert.equal(personalPoisForSource(live, [], 'shared').length, 0);
});
