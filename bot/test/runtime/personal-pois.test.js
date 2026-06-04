/**
 * Personal POI store — per-bot landmarks distinct from fleet marks.
 *
 * Design: docs/features/mapping-experiment.md (TBD); plan in
 * ~/.claude/plans/lets-start-a-plan-async-balloon.md Phase A3.
 *
 * Differs from locations.js: no fleet-prefix overlay (POIs are agent-
 * owned). Shared file is a reconciled UNION written by reconcile-pois.py;
 * private wins for any name the local bot owns. Shared entries fill gaps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPersonalPoiStore, mergePois } from '../../lib/runtime/personal-pois.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'personal-pois-test-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

test('mergePois: private wins for names the local bot owns', () => {
  const priv = {
    spider_hill: { x: 100, y: 70, z: 50, kind: 'hill', agent_owner: 'flint' },
    home_grove: { x: 4, y: 71, z: 24 },
  };
  const shared = {
    spider_hill: { x: 99, y: 71, z: 51, kind: 'peak', agent_owner: 'mason' },
    balder_ruins: { x: -40, y: 68, z: 80, kind: 'ruin', agent_owner: 'gatherer' },
  };
  const merged = mergePois(priv, shared);
  // local copy survives
  assert.equal(merged.spider_hill.x, 100);
  assert.equal(merged.spider_hill.kind, 'hill');
  assert.equal(merged.spider_hill.agent_owner, 'flint');
  assert.equal(merged.spider_hill._source, undefined);
  // shared-only POI fills the gap, tagged with source
  assert.equal(merged.balder_ruins.x, -40);
  assert.equal(merged.balder_ruins._source, 'shared');
  // local-only POI unchanged
  assert.equal(merged.home_grove.x, 4);
  assert.equal(merged.home_grove._source, undefined);
});

test('mergePois: tolerates null/undefined inputs', () => {
  assert.deepEqual(mergePois(null, null), {});
  assert.deepEqual(mergePois(undefined, undefined), {});
  assert.equal(Object.keys(mergePois({ a: { x: 1, y: 64, z: 0 } }, null)).length, 1);
  assert.equal(Object.keys(mergePois(null, { b: { x: 1, y: 64, z: 0 } })).length, 1);
});

test('createPersonalPoiStore.load: shared fills gaps, private wins for shared names', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'personal-pois-flint.json'), {
    spider_hill: { x: 100, y: 70, z: 50, agent_owner: 'flint' },
  });
  writeJson(path.join(dir, 'personal-pois-shared.json'), {
    spider_hill: { x: 99, y: 71, z: 51, agent_owner: 'mason' },
    balder_ruins: { x: -40, y: 68, z: 80, agent_owner: 'gatherer' },
  });
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  const pois = store.load();
  assert.equal(pois.spider_hill.x, 100);
  assert.equal(pois.spider_hill._source, undefined);
  assert.equal(pois.balder_ruins.x, -40);
  assert.equal(pois.balder_ruins._source, 'shared');
});

test('createPersonalPoiStore.load: missing shared file is a clean no-op', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'personal-pois-flint.json'), {
    spider_hill: { x: 100, y: 70, z: 50 },
  });
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  const pois = store.load();
  assert.equal(pois.spider_hill.x, 100);
  assert.equal(pois.spider_hill._source, undefined);
});

test('createPersonalPoiStore.save: strips _source before writing private file', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'personal-pois-shared.json'), {
    balder_ruins: { x: -40, y: 68, z: 80 },
  });
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  const pois = store.load();
  assert.equal(pois.balder_ruins._source, 'shared');
  // Worker writes a new POI; the merged view's _source must not persist.
  store.save({ ...pois, hilltop_west: { x: 50, y: 80, z: 0 } });
  const written = JSON.parse(
    fs.readFileSync(path.join(dir, 'personal-pois-flint.json'), 'utf8'),
  );
  assert.equal('_source' in (written.balder_ruins || {}), false);
  assert.equal(written.hilltop_west.x, 50);
});

test('createPersonalPoiStore.save: writes to PRIVATE file, never to shared', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'personal-pois-shared.json'), {
    balder_ruins: { x: -40, y: 68, z: 80 },
  });
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  store.save({ balder_ruins: { x: 999, y: 999, z: 999 } });
  const privateFile = JSON.parse(
    fs.readFileSync(path.join(dir, 'personal-pois-flint.json'), 'utf8'),
  );
  const sharedFile = JSON.parse(
    fs.readFileSync(path.join(dir, 'personal-pois-shared.json'), 'utf8'),
  );
  assert.equal(privateFile.balder_ruins.x, 999);
  assert.equal(sharedFile.balder_ruins.x, -40);
  // On next load, private now owns the name and wins.
  const merged = store.load();
  assert.equal(merged.balder_ruins.x, 999);
});

test('addPoi: stamps added_at on first write, last_seen on every write', () => {
  const dir = tmpDir();
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  const first = store.addPoi({
    name: 'spider_hill', x: 100, y: 70, z: 50,
    kind: 'hill', note: 'great view',
  });
  assert.ok(first.added_at);
  assert.equal(first.last_seen, first.added_at);
  assert.equal(first.kind, 'hill');
  assert.equal(first.note, 'great view');
  assert.equal(first.agent_owner, 'flint');
  assert.equal(first.torch_missing_since, null);

  // Re-add (upsert) — added_at preserved, last_seen advances, fields merge.
  const second = store.addPoi({
    name: 'spider_hill', x: 101, y: 71, z: 51, note: 'still great',
  });
  assert.equal(second.added_at, first.added_at);
  assert.notEqual(second.last_seen, first.last_seen);
  assert.equal(second.x, 101);
  assert.equal(second.kind, 'hill');  // preserved from existing
  assert.equal(second.note, 'still great');  // updated
});

test('addPoi: rejects missing name or non-finite coords', () => {
  const dir = tmpDir();
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  assert.throws(() => store.addPoi({ x: 0, y: 64, z: 0 }), /name required/);
  assert.throws(() => store.addPoi({ name: 'x', x: NaN, y: 64, z: 0 }), /finite/);
  assert.throws(() => store.addPoi({ name: 'x', x: 0, y: 64 }), /finite/);
});

test('addPoi: strips _source when upserting on top of a shared-overlay entry', () => {
  // If a POI was learned via shared (other bot owns it) and the local agent
  // re-adds it (claiming co-ownership), the resulting private write must
  // not carry the synthetic _source tag.
  const dir = tmpDir();
  writeJson(path.join(dir, 'personal-pois-shared.json'), {
    balder_ruins: { x: -40, y: 68, z: 80, kind: 'ruin' },
  });
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  store.addPoi({ name: 'balder_ruins', x: -40, y: 68, z: 80, note: 'flint visited' });
  const written = JSON.parse(
    fs.readFileSync(path.join(dir, 'personal-pois-flint.json'), 'utf8'),
  );
  assert.equal('_source' in written.balder_ruins, false);
  assert.equal(written.balder_ruins.note, 'flint visited');
});

test('flagTorchMissing: idempotent — preserves first-noticed timestamp', async () => {
  const dir = tmpDir();
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  store.addPoi({ name: 'cairn_n', x: 50, y: 75, z: 100, torch_at: { x: 50, y: 76, z: 100 } });
  store.flagTorchMissing('cairn_n');
  const firstFlag = store.load().cairn_n.torch_missing_since;
  assert.ok(firstFlag);
  // Sleep ~5ms so a fresh timestamp would differ if it overwrote.
  await new Promise((r) => setTimeout(r, 5));
  store.flagTorchMissing('cairn_n');
  const secondFlag = store.load().cairn_n.torch_missing_since;
  assert.equal(secondFlag, firstFlag);  // not overwritten
  // last_torch_check DID advance — the check ran, even though the
  // first-noticed timestamp is the durable one.
  const checks = store.load().cairn_n.last_torch_check;
  assert.ok(checks);
});

test('clearTorchMissing: removes torch_missing_since, updates last_torch_check', () => {
  const dir = tmpDir();
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  store.addPoi({ name: 'cairn_n', x: 50, y: 75, z: 100, torch_at: { x: 50, y: 76, z: 100 } });
  store.flagTorchMissing('cairn_n');
  assert.ok(store.load().cairn_n.torch_missing_since);
  store.clearTorchMissing('cairn_n');
  const after = store.load().cairn_n;
  assert.equal(after.torch_missing_since, null);
  assert.ok(after.last_torch_check);
});

test('flagStale / clearStale work like locations.js', () => {
  const dir = tmpDir();
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  store.addPoi({ name: 'old_camp', x: 30, y: 70, z: 30 });
  store.flagStale('old_camp', 'overgrown');
  const stale = store.load().old_camp;
  assert.equal(stale.stale, true);
  assert.equal(stale.stale_reason, 'overgrown');
  assert.ok(stale.stale_since);
  store.clearStale('old_camp');
  const fresh = store.load().old_camp;
  assert.equal(fresh.stale, false);
  assert.equal('stale_reason' in fresh, false);
});

test('buildPoisList: surfaces source=shared, sorted by name, distance computed', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'personal-pois-flint.json'), {
    home_grove: { x: 4, y: 71, z: 24, kind: 'grove' },
  });
  writeJson(path.join(dir, 'personal-pois-shared.json'), {
    balder_ruins: { x: -40, y: 68, z: 80, kind: 'ruin', agent_owner: 'gatherer' },
  });
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint' });
  const list = store.buildPoisList({ botPos: { x: 0, y: 64, z: 0 } });
  // Sorted alphabetically: balder_ruins, home_grove
  assert.equal(list[0].name, 'balder_ruins');
  assert.equal(list[1].name, 'home_grove');
  assert.equal(list[0].source, 'shared');
  assert.equal(list[1].source, undefined);
  // Distance computed when botPos given
  assert.equal(typeof list[0].distance_m, 'number');
});

test('createPersonalPoiStore: sharedFilePath override honored', () => {
  const dir = tmpDir();
  const altShared = path.join(dir, 'custom-shared.json');
  writeJson(altShared, { balder_ruins: { x: 999, y: 64, z: 999 } });
  const store = createPersonalPoiStore({ dataDir: dir, username: 'flint', sharedFilePath: altShared });
  assert.equal(store.sharedPath, altShared);
  const pois = store.load();
  assert.equal(pois.balder_ruins.x, 999);
});
