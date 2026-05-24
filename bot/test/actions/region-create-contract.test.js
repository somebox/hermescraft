import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionStore } from '../../lib/runtime/regions/index.js';
import { createRegionsMutateActions } from '../../lib/actions/regions/create.js';
import { assertFailure, assertContract } from '../_helpers/action-harness.js';

function makeDeps(store) {
  return {
    ctx: {
      runtime: { regions: store },
      world: { bot: { entity: { position: { x: 5, y: 64, z: 5 } } } },
    },
    ensureBot: () => {},
    posObj: (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }),
  };
}

test('region_create and remove contract codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reg-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  const actions = createRegionsMutateActions(makeDeps(store));

  const created = await actions.region_create({ id: ':test1:', profile: 'mine', r: 8 });
  assertContract(created);
  assert.equal(created.ok, true);
  assert.equal(created.data.region.status, 'unanchored');

  const dup = await actions.region_create({ id: ':test1:', profile: 'mine' });
  assertFailure(dup, { code: 'REGION_EXISTS' });

  const noConfirm = await actions.region_remove({ id: ':test1:' });
  assertFailure(noConfirm, { code: 'MISSING_CONFIRM' });

  const removed = await actions.region_remove({ id: ':test1:', confirm: true });
  assertContract(removed);
  assert.equal(removed.ok, true);

  const missing = await actions.region_remove({ id: ':test1:', confirm: true });
  assertFailure(missing, { code: 'REGION_NOT_FOUND' });
});

test('site_add requires valid ref', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-site-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { radius: 16 },
    status: 'unanchored',
  });
  const actions = createRegionsMutateActions(makeDeps(store));
  const bad = await actions.site_add({ ref: 'nope', x: 1, y: 2, z: 3 });
  assertFailure(bad, { code: 'INVALID_ID' });
  const ok = await actions.site_add({ ref: ':base1:/tower', x: 1, y: 70, z: 0 });
  assert.equal(ok.ok, true);
});

test('region_create accepts intent override (farm + marker)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-intent-ok-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  const actions = createRegionsMutateActions(makeDeps(store));
  const created = await actions.region_create({
    id: ':wheat1:',
    profile: 'farm',
    intent: 'marker',
    r: 6,
    y: '64..72',
  });
  assertContract(created);
  assert.equal(created.ok, true);
  assert.equal(created.data.region.intent, 'marker');
  assert.equal(created.data.region.capabilities.allow_ad_hoc_dig, true);
  assert.equal(created.data.region.capabilities.allow_ad_hoc_place, true);
});
