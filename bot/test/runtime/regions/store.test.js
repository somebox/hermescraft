import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionStore, normalizeId } from '../../../lib/runtime/regions/index.js';

test('createRegionStore persists and lists regions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-regions-'));
  const store = createRegionStore({ dataDir: dir, world: 'testworld' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'unanchored',
    anchor: { x: 10, y: 64, z: -5 },
    shape: { kind: 'column', radius: 8 },
    sites: { tower: { x: 12, y: 70, z: -5 } },
  });
  const again = createRegionStore({ dataDir: dir, world: 'testworld' });
  const row = again.get('base1');
  assert.ok(row);
  assert.equal(row.status, 'unanchored');
  assert.equal(normalizeId(':base1:'), 'base1');
  const at = again.at(10, 64, -5);
  assert.equal(at.length, 1);
  assert.equal(at[0].id, 'base1');
  again.removeById('base1');
  assert.equal(again.get('base1'), null);
});

test('reload() picks up file edits made after store creation', () => {
  // 2026-05-27: file edits to regions-world.json weren't reaching live
  // bots because the in-memory cache loaded once at createRegionStore()
  // time. The reload() method re-reads the JSON + re-applies profile
  // normalization so operators can edit-and-reload instead of restarting.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-regions-reload-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({ id: 'hut1', profile: 'base', intent: 'protect', anchor: { x: 0, y: 64, z: 0 }, shape: { kind: 'column', radius: 5 } });
  assert.equal(store.get('hut1').capabilities.allow_ad_hoc_dig, false);

  // Operator hand-edits the file: add capability_overrides loosening hut1.
  const filePath = path.join(dir, 'regions-w.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const idx = raw.regions.findIndex((r) => r.id === 'hut1');
  raw.regions[idx].capability_overrides = { allow_ad_hoc_dig: true, allow_ad_hoc_place: true };
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));

  // Cache still has the old values until reload is called:
  assert.equal(store.get('hut1').capabilities.allow_ad_hoc_dig, false);

  store.reload();
  // Now the override is applied:
  assert.equal(store.get('hut1').capabilities.allow_ad_hoc_dig, true);
  assert.equal(store.get('hut1').capabilities.allow_ad_hoc_place, true);
  // Other defaults still hold:
  assert.equal(store.get('hut1').capabilities.allow_guided_edit, true);
  assert.equal(store.get('hut1').intent, 'protect');
});
