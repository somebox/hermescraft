import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
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

test('mc dig --force does not bypass region protect (use forceEscape for trap escape)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reg-force-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'shell',
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
  });
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  const bot = {
    entity: { position: new Vec3(0, 64, 0), isInWater: false, onGround: true },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    blockAt: (p) => ({
      name: 'cobblestone',
      boundingBox: 'block',
      position: new Vec3(p.x, p.y, p.z),
      digTime: () => 0,
    }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    dig: async () => {
      throw new Error('should not dig');
    },
    equip: async () => {},
    tool: { itemInHand: () => ({ name: 'iron_pickaxe' }), getDigTime: () => 20 },
    heldItem: { name: 'iron_pickaxe' },
    entities: {},
  };
  const config = { behaviors: { regionsEnabled: true, allowSlowDig: true, digDropScanMs: 0 } };
  const digHandlers = createDigHandlers({
    ctx,
    config,
    ensureBot: () => bot,
    goals: { GoalNear: class {} },
    posObj: (p) => ({ x: p.x, y: p.y, z: p.z }),
    sleep: async () => {},
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0, 0, 0),
  });
  const dig = await digHandlers.dig({ x: 1, y: 64, z: 0, force: true });
  assert.equal(dig.ok, false);
  assert.equal(dig.error.code, 'REGION_PROTECTED');
});

test('mc dig forceEscape bypasses region protect (escape enclosure path)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reg-force-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'shell',
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
  });
  const ctx = { runtime: { regions: store, recentDigFailures: [] } };
  let dug = false;
  const bot = {
    entity: { position: new Vec3(0, 64, 0), isInWater: false, onGround: true },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    blockAt: (p) => ({
      name: 'cobblestone',
      boundingBox: 'block',
      position: new Vec3(p.x, p.y, p.z),
      digTime: () => 0,
    }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    dig: async () => {
      dug = true;
    },
    equip: async () => {},
    tool: { itemInHand: () => ({ name: 'iron_pickaxe' }), getDigTime: () => 20 },
    heldItem: { name: 'iron_pickaxe' },
    entities: {},
  };
  const config = { behaviors: { regionsEnabled: true, allowSlowDig: true, digDropScanMs: 0 } };
  const digHandlers = createDigHandlers({
    ctx,
    config,
    ensureBot: () => bot,
    goals: { GoalNear: class {} },
    posObj: (p) => ({ x: p.x, y: p.y, z: p.z }),
    sleep: async () => {},
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0, 0, 0),
  });
  const dig = await digHandlers.dig({ x: 1, y: 64, z: 0, force: true, forceEscape: true });
  assert.equal(dig.ok, true, dig.error?.message || JSON.stringify(dig));
  assert.equal(dug, true);
});

test('navBlockedNextActionHint in protect region avoids dig_area fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reg-nav-hint-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'active',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
    sites: { gate: { x: 8, y: 64, z: 0 } },
  });
  const { enrichWithStand } = await import('../../lib/actions/movement/_preflight.js');
  const { navBlockedNextActionHint } = await import('../../lib/actions/movement/nav-hints.js');
  const ctx = { runtime: { regions: store } };
  const b = makeMockBot({
    position: { x: 5, y: 64, z: 5 },
    blockAt: (p) => {
      if (p.x === 6 && p.y === 64 && p.z === 5) {
        return { name: 'stone', boundingBox: 'block' };
      }
      return { name: 'grass_block', boundingBox: 'block' };
    },
  });
  const obs = enrichWithStand(
    b,
    { target: { x: 6, y: 64, z: 5 }, target_standable: false },
    6,
    64,
    5,
    ctx,
  );
  const hint = navBlockedNextActionHint(b, { x: 6, y: 64, z: 5 }, { x: 5, y: 64, z: 5 }, { observedState: obs });
  assert.equal(obs.nav_in_protect_region, true);
  assert.doesNotMatch(hint, /dig_area/);
  assert.match(hint, /mc (goto_near|reachable|go_site|check|move)/);
});
