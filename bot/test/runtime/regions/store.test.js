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
