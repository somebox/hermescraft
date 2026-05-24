import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionStore } from '../../lib/runtime/regions/index.js';
import { createRegionsCheckActions } from '../../lib/actions/regions/check.js';
import { makeMockBot, assertContract } from '../_helpers/action-harness.js';

test('check does not call bot.dig or mutate dig failure log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-check-dry-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  let dug = false;
  const bot = makeMockBot({
    blockAt: () => ({ name: 'dirt', boundingBox: 'block' }),
    extra: { dig: async () => { dug = true; } },
  });
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const check = createRegionsCheckActions({
    ctx,
    config: { behaviors: { regionsEnabled: true } },
    ensureBot: () => bot,
  });
  const r = await check.check({ verb: 'dig', x: 1, y: 64, z: 1 });
  assertContract(r);
  assert.equal(dug, false);
  assert.equal(ctx.runtime.recentDigFailures.length, 0);
});

test('check returns ENFORCEMENT_DISABLED when regionsEnabled is false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-check-dry-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
  });
  const bot = makeMockBot({
    blockAt: () => ({ name: 'dirt', boundingBox: 'block' }),
  });
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const check = createRegionsCheckActions({
    ctx,
    config: { behaviors: { regionsEnabled: false } },
    ensureBot: () => bot,
  });
  const r = await check.check({ verb: 'dig', x: 0, y: 64, z: 0 });
  assertContract(r);
  assert.equal(r.data.region_decision.reason, 'ENFORCEMENT_DISABLED');
  assert.equal(r.data.enforcement, false);
});
