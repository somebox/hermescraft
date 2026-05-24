import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionStore, normalizeSitesForStorage } from '../../../lib/runtime/regions/index.js';

test('normalizeSitesForStorage coerces array sites to object map', () => {
  const out = normalizeSitesForStorage([
    { name: 'gate', x: 1, y: 64, z: 2 },
    { name: 'tower', x: 3, y: 80, z: 4 },
  ]);
  assert.deepEqual(out, {
    gate: { x: 1, y: 64, z: 2 },
    tower: { x: 3, y: 80, z: 4 },
  });
});

test('createRegionStore upsert persists normalized sites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-sites-norm-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { radius: 8 },
    sites: [{ name: 'chest', x: 5, y: 64, z: 5 }],
  });
  const row = store.get('base1');
  assert.deepEqual(row.sites, { chest: { x: 5, y: 64, z: 5 } });
});
