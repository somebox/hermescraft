import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionStore } from '../../lib/runtime/regions/index.js';
import { createRegionsCheckActions } from '../../lib/actions/regions/check.js';
import { createDigHandlers } from '../../lib/actions/mining/dig.js';
import { makeMockBot, assertContract } from '../_helpers/action-harness.js';

function setupProtectRegion(dir, id = 'hut3') {
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id,
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
  });
  return store;
}

function digHarness(ctx, config, bot) {
  return createDigHandlers({
    ctx,
    config,
    ensureBot: () => bot,
    goals: {},
    posObj: (p) => p,
    sleep: async () => {},
    hasLineOfSight: () => true,
    eyePosition: () => ({ x: 0, y: 0, z: 0 }),
  });
}

test('worksite grant allows dig inside protect region; clear restores deny', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-tctx-'));
  const store = setupProtectRegion(dir);
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const bot = makeMockBot({
    blockAt: () => ({ name: 'cobblestone', boundingBox: 'block', position: { x: 0, y: 64, z: 0 } }),
    extra: {
      dig: async () => {},
      tool: { itemInHand: () => null },
    },
  });
  bot.entity.position.distanceTo = () => 1.5;
  const config = { behaviors: { regionsEnabled: true, allowSlowDig: true } };
  const check = createRegionsCheckActions({ ctx, config, ensureBot: () => bot });
  const dig = digHarness(ctx, config, bot);

  ctx.runtime.taskContext = {
    card_id: 't_abc',
    worksite_region: 'hut3',
    expires_at: Date.now() + 60_000,
    source: 'test',
  };
  const prevAllow = await check.region_check({ verb: 'dig', x: 0, y: 64, z: 0 });
  assert.equal(prevAllow.data.region_decision.reason, 'WORKSITE_GRANT');
  const digAllow = await dig.dig({ x: 0, y: 64, z: 0 });
  assert.equal(digAllow.ok, true);

  ctx.runtime.taskContext = null;
  const prevDeny = await check.region_check({ verb: 'dig', x: 0, y: 64, z: 0 });
  assert.equal(prevDeny.data.region_decision.reason, 'REGION_PROTECTED');
  const digDeny = await dig.dig({ x: 0, y: 64, z: 0 });
  assert.equal(digDeny.ok, false);
  assert.equal(digDeny.error.code, 'REGION_PROTECTED');
});

test('worksite grant denies dig of structural blocks (planks/logs/fences)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-tctx-struct-'));
  const store = setupProtectRegion(dir);
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const bot = makeMockBot({
    blockAt: () => ({ name: 'oak_planks', boundingBox: 'block', position: { x: 0, y: 64, z: 0 } }),
    extra: {
      dig: async () => {},
      tool: { itemInHand: () => null },
    },
  });
  bot.entity.position.distanceTo = () => 1.5;
  const config = { behaviors: { regionsEnabled: true, allowSlowDig: true } };
  const check = createRegionsCheckActions({ ctx, config, ensureBot: () => bot });
  const dig = digHarness(ctx, config, bot);

  ctx.runtime.taskContext = {
    card_id: 't_struct',
    worksite_region: 'hut3',
    expires_at: Date.now() + 60_000,
    source: 'test',
  };
  const checkResult = await check.region_check({ verb: 'dig', x: 0, y: 64, z: 0 });
  assert.equal(checkResult.data.region_decision.reason, 'REGION_STRUCTURAL_BLOCK');
  const digResult = await dig.dig({ x: 0, y: 64, z: 0 });
  assert.equal(digResult.ok, false);
  assert.equal(digResult.error.code, 'REGION_STRUCTURAL_BLOCK');
});

test('expired task context behaves like no worksite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-tctx-exp-'));
  const store = setupProtectRegion(dir);
  const ctx = {
    runtime: {
      regions: store,
      recentDigFailures: [],
      taskContext: {
        card_id: 't_abc',
        worksite_region: 'hut3',
        expires_at: Date.now() - 1000,
        source: 'test',
      },
    },
  };
  const bot = makeMockBot({
    blockAt: () => ({ name: 'cobblestone', boundingBox: 'block' }),
  });
  const config = { behaviors: { regionsEnabled: true } };
  const check = createRegionsCheckActions({ ctx, config, ensureBot: () => bot });
  const r = await check.region_check({ verb: 'dig', x: 0, y: 64, z: 0 });
  assertContract(r);
  assert.equal(r.data.worksite, null);
  assert.equal(r.data.region_decision.reason, 'REGION_PROTECTED');
});

test('check reports ENFORCEMENT_DISABLED when regions disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-tctx-off-'));
  const store = setupProtectRegion(dir);
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const bot = makeMockBot({
    blockAt: () => ({ name: 'dirt', boundingBox: 'block' }),
  });
  const check = createRegionsCheckActions({
    ctx,
    config: { behaviors: { regionsEnabled: false } },
    ensureBot: () => bot,
  });
  const r = await check.region_check({ verb: 'dig', x: 0, y: 64, z: 0 });
  assert.equal(r.data.region_decision.reason, 'ENFORCEMENT_DISABLED');
  assert.equal(r.data.enforcement, false);
});
