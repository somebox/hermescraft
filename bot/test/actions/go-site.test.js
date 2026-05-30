import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoSite } from '../../lib/actions/movement/go_site.js';
import { createRegionStore } from '../../lib/runtime/regions/index.js';
import { ok } from '../../lib/shared/action-contract.js';

function makeGoSite({ regions, locations = {}, gotoCalls = [] }) {
  const goto = async (args) => {
    gotoCalls.push(args);
    return ok({ result: 'nav', data: { x: args.x, y: args.y, z: args.z } });
  };
  const go_site = createGoSite({
    ctx: { runtime: { regions } },
    loadLocations: () => locations,
    goto,
  });
  return { go_site, gotoCalls };
}

test('go_site resolves :base1:/tower to site coords', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-go-site-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
    sites: { tower: { x: 10, y: 80, z: 5 } },
  });
  const { go_site, gotoCalls } = makeGoSite({ regions: store });
  const r = await go_site({ ref: ':base1:/tower' });
  assert.equal(r.ok, true);
  assert.deepEqual(gotoCalls[0], { x: 10, y: 80, z: 5 });
});

test('go_site resolves bare :base1: to region anchor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-go-site-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    anchor: { x: 3, y: 64, z: 7 },
    shape: { kind: 'column', radius: 8 },
  });
  const { go_site, gotoCalls } = makeGoSite({ regions: store });
  const r = await go_site({ ref: ':base1:' });
  assert.equal(r.ok, true);
  assert.deepEqual(gotoCalls[0], { x: 3, y: 64, z: 7 });
});

test('go_site INVALID_REF for unknown region site', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-go-site-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 8 },
  });
  const { go_site } = makeGoSite({ regions: store });
  const r = await go_site({ ref: ':base1:/missing' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_REF');
});

test('go_site INVALID_REF for :bogus:', async () => {
  const { go_site } = makeGoSite({ regions: null, locations: {} });
  const r = await go_site({ ref: ':bogus:' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_REF');
});

test('go_site uses navigateToTarget when navMoveResolve is on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-go-site-nav-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 8 },
    sites: { tower: { x: 10, y: 80, z: 5 } },
  });
  const gotoCalls = [];
  const facadeCalls = [];
  const goto = async (args) => {
    gotoCalls.push(args);
    return ok({ result: 'nav', data: { x: args.x, y: args.y, z: args.z } });
  };
  const navigateToTarget = async (args) => {
    facadeCalls.push(args);
    return ok({ result: 'facade', data: { x: args.x, y: args.y, z: args.z } });
  };
  const go_site = createGoSite({
    ctx: { runtime: { regions: store } },
    loadLocations: () => ({}),
    goto,
    navigateToTarget,
    config: { behaviors: { navMoveResolve: true } },
  });
  const r = await go_site({ ref: ':base1:/tower' });
  assert.equal(r.ok, true);
  assert.equal(facadeCalls.length, 1);
  assert.deepEqual(facadeCalls[0], { x: 10, y: 80, z: 5 });
  assert.equal(gotoCalls.length, 0);
});
