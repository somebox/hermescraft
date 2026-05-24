import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionStore } from '../../lib/runtime/regions/index.js';
import { createRegionsCheckActions } from '../../lib/actions/regions/check.js';
import { createDigHandlers } from '../../lib/actions/mining/dig.js';
import { makeMockBot, assertContract } from '../_helpers/action-harness.js';

test('check dig is side-effect free and matches resolver', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reg-prot-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
  });
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const bot = makeMockBot({
    blockAt: () => ({ name: 'cobblestone', boundingBox: 'block' }),
  });
  const check = createRegionsCheckActions({
    ctx,
    config: { behaviors: { regionsEnabled: true } },
    ensureBot: () => bot,
  });
  const preview = await check.check({ verb: 'dig', x: 0, y: 64, z: 0 });
  assertContract(preview);
  assert.equal(preview.data.dry_run, true);
  assert.equal(preview.data.region_decision.decision, 'deny');
  assert.equal(ctx.runtime.recentDigFailures.length, 0);
});

test('mc dig matches check parity inside protect region', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reg-prot2-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
  });
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const bot = makeMockBot({
    position: { x: 5, y: 64, z: 5 },
    blockAt: () => ({ name: 'cobblestone', boundingBox: 'block' }),
  });
  const config = { behaviors: { regionsEnabled: true, allowSlowDig: true } };
  const check = createRegionsCheckActions({ ctx, config, ensureBot: () => bot });
  const digHandlers = createDigHandlers({
    ctx,
    config,
    ensureBot: () => bot,
    goals: {},
    posObj: (p) => p,
    sleep: async () => {},
    hasLineOfSight: () => true,
    eyePosition: () => ({ x: 0, y: 0, z: 0 }),
  });
  const prev = await check.check({ verb: 'dig', x: 0, y: 64, z: 0 });
  const dig = await digHandlers.dig({ x: 0, y: 64, z: 0 });
  assert.equal(dig.ok, false);
  assert.equal(dig.error.code, 'REGION_PROTECTED');
  assert.equal(prev.data.region_decision.winning_region.id, dig.error.observed_state.region_decision.winning_region.id);
});

test('REGION_PROTECTED hint prefers gate site when declared', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reg-hint-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
    sites: { tower: { x: 1, y: 80, z: 0 }, gate: { x: 5, y: 64, z: 5 } },
  });
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const bot = makeMockBot({
    blockAt: () => ({ name: 'cobblestone', boundingBox: 'block' }),
  });
  const config = { behaviors: { regionsEnabled: true, allowSlowDig: true } };
  const digHandlers = createDigHandlers({
    ctx,
    config,
    ensureBot: () => bot,
    goals: {},
    posObj: (p) => p,
    sleep: async () => {},
    hasLineOfSight: () => true,
    eyePosition: () => ({ x: 0, y: 0, z: 0 }),
  });
  const dig = await digHandlers.dig({ x: 0, y: 64, z: 0 });
  assert.equal(dig.error.code, 'REGION_PROTECTED');
  assert.match(dig.error.next_action_hint, /mc go_site :base1:\/gate/);
  assert.equal(dig.error.observed_state.exit_hint_kind, 'site');
});

test('REGION_PROTECTED hint uses anchor when region has no sites', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reg-hint2-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
  });
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const bot = makeMockBot({
    blockAt: () => ({ name: 'cobblestone', boundingBox: 'block' }),
  });
  const config = { behaviors: { regionsEnabled: true, allowSlowDig: true } };
  const digHandlers = createDigHandlers({
    ctx,
    config,
    ensureBot: () => bot,
    goals: {},
    posObj: (p) => p,
    sleep: async () => {},
    hasLineOfSight: () => true,
    eyePosition: () => ({ x: 0, y: 0, z: 0 }),
  });
  const dig = await digHandlers.dig({ x: 0, y: 64, z: 0 });
  assert.match(dig.error.next_action_hint, /mc go_site :base1:/);
  assert.equal(dig.error.observed_state.exit_hint_kind, 'anchor');
});
