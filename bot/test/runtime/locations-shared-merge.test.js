/**
 * Read-merge for fleet-prefix marks via data/locations-base.json.
 *
 * Design lives in docs/features/landfolk-plugin.md → Glossary →
 * "Fleet-prefix mark". Shared file wins for chest_, base_, lt_ marks; private
 * entries with those names are proposal-only and shadowed on read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createLocationsStore,
  isFleetMark,
  mergeMarks,
  FLEET_MARK_PREFIXES,
} from '../../lib/runtime/locations.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'locations-merge-test-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

test('isFleetMark detects every configured prefix', () => {
  assert.equal(isFleetMark('chest_food'), true);
  assert.equal(isFleetMark('base_anchor'), true);
  assert.equal(isFleetMark('lt_mine_north'), true);
  assert.equal(isFleetMark('hut1_site'), false);
  assert.equal(isFleetMark('death_4'), false);
  assert.equal(isFleetMark(''), false);
  assert.equal(isFleetMark(null), false);
  assert.equal(isFleetMark(undefined), false);
});

test('FLEET_MARK_PREFIXES is the documented set', () => {
  // If you add a new prefix, update the Glossary entry in
  // docs/features/landfolk-plugin.md → Fleet-prefix mark.
  assert.deepEqual([...FLEET_MARK_PREFIXES].sort(), ['base_', 'chest_', 'lt_']);
});

test('mergeMarks: shared wins for fleet-prefix names, source tag added', () => {
  const priv = {
    chest_food: { x: 361, y: 65, z: -583, note: 'worker proposal' },
    home: { x: 0, y: 64, z: 0, note: 'spawn' },
  };
  const shared = {
    chest_food: { x: 369, y: 66, z: -593, note: 'steward canonical' },
    chest_wood: { x: 406, y: 65, z: -614 },
  };
  const merged = mergeMarks(priv, shared);
  assert.equal(merged.chest_food.x, 369);
  assert.equal(merged.chest_food.note, 'steward canonical');
  assert.equal(merged.chest_food._source, 'shared');
  assert.equal(merged.chest_wood.x, 406);
  assert.equal(merged.home.x, 0);
  assert.equal(merged.home._source, undefined);
});

test('mergeMarks: private wins for non-fleet names when both present (private not shadowed)', () => {
  // Defensive: if the reconciler ever writes a non-fleet-prefix entry to
  // shared, it should not override a private value with the same name.
  const priv = { home: { x: 100, y: 64, z: 100 } };
  const shared = { home: { x: 0, y: 64, z: 0 } };
  const merged = mergeMarks(priv, shared);
  assert.equal(merged.home.x, 100);
});

test('mergeMarks: tolerates null/undefined inputs', () => {
  assert.deepEqual(mergeMarks(null, null), {});
  assert.deepEqual(mergeMarks(undefined, undefined), {});
  assert.equal(Object.keys(mergeMarks({ a: { x: 1 } }, null)).length, 1);
  assert.equal(Object.keys(mergeMarks(null, { chest_x: { x: 1 } })).length, 1);
});

test('createLocationsStore.load: shared file overrides private fleet marks', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'locations-mason.json'), {
    chest_food: { x: 361, y: 65, z: -583 },
    home: { x: 0, y: 64, z: 0 },
  });
  writeJson(path.join(dir, 'locations-base.json'), {
    chest_food: { x: 369, y: 66, z: -593 },
  });
  const store = createLocationsStore({ dataDir: dir, username: 'mason' });
  const locs = store.load();
  assert.equal(locs.chest_food.x, 369);
  assert.equal(locs.chest_food._source, 'shared');
  assert.equal(locs.home.x, 0);
  assert.equal(locs.home._source, undefined);
});

test('createLocationsStore.load: missing shared file is a clean no-op', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'locations-mason.json'), {
    chest_food: { x: 361, y: 65, z: -583 },
  });
  // No locations-base.json — private should be the result, untagged.
  const store = createLocationsStore({ dataDir: dir, username: 'mason' });
  const locs = store.load();
  assert.equal(locs.chest_food.x, 361);
  assert.equal(locs.chest_food._source, undefined);
});

test('createLocationsStore.save: strips _source before writing private file', () => {
  // After load() tags merged entries with _source:'shared', a follow-up
  // edit-and-save must not persist that synthetic field into private —
  // otherwise it would leak into other bots' merges on the next read.
  const dir = tmpDir();
  writeJson(path.join(dir, 'locations-base.json'), {
    chest_food: { x: 369, y: 66, z: -593 },
  });
  const store = createLocationsStore({ dataDir: dir, username: 'mason' });
  const locs = store.load();
  assert.equal(locs.chest_food._source, 'shared');
  store.save({ ...locs, home: { x: 0, y: 64, z: 0 } });
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'locations-mason.json'), 'utf8'));
  assert.equal(written.chest_food.x, 369);
  assert.equal('_source' in written.chest_food, false);
  assert.equal(written.home.x, 0);
});

test('createLocationsStore.save: writes to PRIVATE file, never to shared', () => {
  // Hard invariant — workers must not be able to write to locations-base.json.
  const dir = tmpDir();
  writeJson(path.join(dir, 'locations-base.json'), {
    chest_food: { x: 369, y: 66, z: -593 },
  });
  const store = createLocationsStore({ dataDir: dir, username: 'mason' });
  // Worker tries to overwrite chest_food locally.
  store.save({ chest_food: { x: 100, y: 100, z: 100 } });
  const privateFile = JSON.parse(fs.readFileSync(path.join(dir, 'locations-mason.json'), 'utf8'));
  const sharedFile = JSON.parse(fs.readFileSync(path.join(dir, 'locations-base.json'), 'utf8'));
  assert.equal(privateFile.chest_food.x, 100); // private was updated
  assert.equal(sharedFile.chest_food.x, 369);  // shared is untouched
  // And on next load(), shared still wins despite the private write.
  const merged = store.load();
  assert.equal(merged.chest_food.x, 369);
});

test('createLocationsStore.buildMarksList: surfaces source=shared on merged entries', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'locations-mason.json'), {
    home: { x: 0, y: 64, z: 0 },
  });
  writeJson(path.join(dir, 'locations-base.json'), {
    chest_food: { x: 369, y: 66, z: -593, note: 'steward canonical' },
  });
  const store = createLocationsStore({ dataDir: dir, username: 'mason' });
  const list = store.buildMarksList({ botPos: null, chestSnapshots: {} });
  const food = list.find((m) => m.name === 'chest_food');
  const home = list.find((m) => m.name === 'home');
  assert.equal(food.source, 'shared');
  assert.equal(food.note, 'steward canonical');
  assert.equal(home.source, undefined);
});

test('createLocationsStore: sharedFilePath override is honored', () => {
  const dir = tmpDir();
  const altShared = path.join(dir, 'custom-shared.json');
  writeJson(altShared, { chest_food: { x: 999, y: 64, z: 999 } });
  const store = createLocationsStore({ dataDir: dir, username: 'mason', sharedFilePath: altShared });
  assert.equal(store.sharedPath, altShared);
  const locs = store.load();
  assert.equal(locs.chest_food.x, 999);
});
