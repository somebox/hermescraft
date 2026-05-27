/**
 * Containers action contract tests (refusal paths).
 * ADR: docs/design/action-contract.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createContainerActions, evictChestSnapshotsAtPosition } from '../../lib/actions/containers.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function containerDeps(overrides = {}) {
  const services = createMockServices();
  const bot = overrides.bot || {
    entity: { position: new Vec3(1.5, 64, 1.5) },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'chest', boundingBox: 'block', position: { x: 1, y: 64, z: 1 } }),
    openContainer: async () => ({
      containerItems: () => [],
      deposit: async () => {},
      withdraw: async () => {},
      close: async () => {},
    }),
    pathfinder: { goto: async () => {} },
  };
  return {
    ctx: services.state,
    config: services.config,
    ensureBot: () => bot,
    goals: { GoalNear: function () {} },
    fmt: services.utils.fmt,
    posObj: services.utils.posObj,
    sleep: services.utils.sleep,
    log: services.utils.log,
    loadLocations: () => ({}),
    saveLocations: () => {},
    flagMarkStale: () => {},
    clearMarkStale: () => {},
    resolveMarkPlaceFromBody: () => null,
    resolveContainerCoords: overrides.resolveContainerCoords || (() => { throw new Error('need coords'); }),
    normalizeDepositWithdrawItems: (body) => {
      if (Array.isArray(body.items)) return body.items;
      if (!body.item) throw new Error('Missing item — pass item + count or an items array');
      return [{ item: String(body.item), count: Number(body.count ?? 0) }];
    },
    buildMarksListApi: () => [],
    isContainerBlock: overrides.isContainerBlock || (() => false),
    findNearbyContainer: (_b, ix, iy, iz) => ({
      name: 'chest',
      boundingBox: 'block',
      position: { x: ix, y: iy, z: iz },
    }),
    snapshotChestAtPosition: () => {},
    rememberSocialEvent: () => {},
    saveReminders: () => {},
    getMyName: () => 'TestBot',
    hasLineOfSight: () => true,
    eyePosition: () => ({ x: 0, y: 65, z: 0 }),
  };
}

test('containers.deposit: missing item in body → MISSING_ITEMS', async () => {
  const bot = {
    entity: { position: { x: 1.5, y: 64, z: 1.5 } },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'chest', boundingBox: 'block', position: { x: 1, y: 64, z: 1 } }),
    openContainer: async () => ({
      containerItems: () => [],
      deposit: async () => {},
      close: async () => {},
    }),
    pathfinder: { goto: async () => {} },
  };
  const actions = createContainerActions(containerDeps({
    resolveContainerCoords: () => ({ ix: 1, iy: 64, iz: 1 }),
    isContainerBlock: () => true,
    bot,
  }));
  const r = await actions.deposit({ count: 1 });
  assertFailure(r, { code: 'MISSING_ITEMS', retrySafe: false });
});

test('containers.withdraw: missing item in body → MISSING_ITEMS', async () => {
  const actions = createContainerActions(containerDeps({
    resolveContainerCoords: () => ({ ix: 0, iy: 64, iz: 0 }),
    isContainerBlock: () => true,
  }));
  const r = await actions.withdraw({ count: 1 });
  assertFailure(r, { code: 'MISSING_ITEMS', retrySafe: false });
});

test('containers.chest_search: missing item → MISSING_ITEM', async () => {
  const actions = createContainerActions(containerDeps({
    resolveContainerCoords: () => ({ ix: 0, iy: 64, iz: 0 }),
  }));
  const r = await actions.chest_search({});
  assertFailure(r, { code: 'MISSING_ITEM', retrySafe: false });
});

// ─── chest_search freshness ────────────────────────────────────────────
// The 2026-05-27 stale-chest incident: mason's chest_search returned a
// 10-hour-old snapshot at (321,64,-590) for a chest that had been broken,
// then walked 67m and burned 60s on windowOpen timeouts. These tests pin
// the freshness contract that prevents recurrence.

test('chest_search: tags age_minutes + stale on every match', async () => {
  const deps = containerDeps();
  const tenHoursAgo = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
  deps.ctx.goals.chestSnapshots = {
    fresh_chest: {
      at: oneMinuteAgo,
      position: { x: 10, y: 64, z: 10 },
      total: 5,
      items: [{ name: 'andesite', count: 5 }],
    },
    stale_chest: {
      at: tenHoursAgo,
      position: { x: 321, y: 64, z: -590 },
      total: 169,
      items: [{ name: 'andesite', count: 169 }],
    },
  };
  const r = await createContainerActions(deps).chest_search({ item: 'andesite' });
  assert.equal(r.ok, true);
  assert.equal(r.data.match_count, 2);
  assert.equal(r.data.match_count_stale, 1);
  assert.ok(Number.isFinite(r.data.stale_after_hours));
  const byMark = Object.fromEntries(r.data.matches.map((m) => [m.mark, m]));
  assert.equal(byMark.fresh_chest.stale, false);
  assert.equal(byMark.stale_chest.stale, true);
  assert.ok(byMark.fresh_chest.age_minutes < 5);
  assert.ok(byMark.stale_chest.age_minutes >= 599); // ~10 hr
});

test('chest_search: fresh hits sort before stale hits regardless of distance', async () => {
  // Mason's exact failure shape: 67m fresh chest beats 5m stale chest. The
  // pre-fix sort was distance-only, so the stale phantom routed mason 67m.
  const deps = containerDeps();
  deps.ctx.goals.chestSnapshots = {
    far_fresh: {
      at: new Date(Date.now() - 30 * 1000).toISOString(),
      position: { x: 70, y: 64, z: 0 },
      items: [{ name: 'cobblestone', count: 50 }],
    },
    close_stale: {
      at: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
      position: { x: 3, y: 64, z: 0 },
      items: [{ name: 'cobblestone', count: 50 }],
    },
  };
  const r = await createContainerActions(deps).chest_search({ item: 'cobblestone' });
  assert.equal(r.data.matches[0].mark, 'far_fresh');
  assert.equal(r.data.matches[0].stale, false);
  assert.equal(r.data.matches[1].mark, 'close_stale');
  assert.equal(r.data.matches[1].stale, true);
});

test('chest_search: human-readable result flags STALE when nearest is stale', async () => {
  const deps = containerDeps();
  deps.ctx.goals.chestSnapshots = {
    only_stale: {
      at: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
      position: { x: 0, y: 64, z: 0 },
      items: [{ name: 'iron_ingot', count: 32 }],
    },
  };
  const r = await createContainerActions(deps).chest_search({ item: 'iron_ingot' });
  assert.match(r.result, /STALE/);
  assert.match(r.result, /verify/i);
});

// ─── openContainerStructured eviction ─────────────────────────────────

test('deposit @ phantom chest → NO_CONTAINER + evicts the stale snapshot', async () => {
  // The fix: if findNearbyContainer says no container is here, the snapshot
  // pointing here must be wrong. Delete it so chest_search stops returning
  // it on every future hit.
  const persisted = [];
  const deps = containerDeps({
    resolveContainerCoords: () => ({ ix: 321, iy: 64, iz: -590 }),
    isContainerBlock: () => false,
  });
  deps.findNearbyContainer = () => null;
  deps.persistChestSnapshotsToDisk = () => persisted.push(true);
  deps.ctx.goals.chestSnapshots = {
    phantom: {
      at: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
      position: { x: 321, y: 64, z: -590 },
      items: [{ name: 'andesite', count: 169 }],
    },
    unrelated: {
      at: new Date().toISOString(),
      position: { x: 0, y: 64, z: 0 },
      items: [{ name: 'wheat', count: 10 }],
    },
  };
  const r = await createContainerActions(deps).deposit({
    items: [{ item: 'andesite', count: 1 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_CONTAINER');
  assert.deepEqual(r.error.observed_state.evicted_snapshots, ['phantom']);
  assert.equal('phantom' in deps.ctx.goals.chestSnapshots, false);
  assert.equal('unrelated' in deps.ctx.goals.chestSnapshots, true);
  assert.equal(persisted.length, 1);
  assert.match(r.error.next_action_hint, /evicted|re-discover/i);
});

test('deposit @ chest where openContainer times out → INTERRUPTED + evict', async () => {
  // Mason's actual failure mode: findNearbyContainer thinks there's a chest
  // (cached chunk), openContainer throws windowOpen-timeout. The snapshot is
  // still wrong; evict so the retry loop doesn't return here.
  const persisted = [];
  const bot = {
    entity: { position: { x: 321.3, y: 64, z: -588.3 } },
    inventory: { items: () => [{ name: 'andesite', count: 1, slot: 0 }] },
    blockAt: () => ({ name: 'chest', boundingBox: 'block', position: { x: 321, y: 64, z: -590 } }),
    openContainer: async () => { throw new Error('Event windowOpen did not fire within timeout of 20000ms'); },
    pathfinder: { goto: async () => {} },
  };
  const deps = containerDeps({
    bot,
    resolveContainerCoords: () => ({ ix: 321, iy: 64, iz: -590 }),
    isContainerBlock: () => true,
  });
  deps.persistChestSnapshotsToDisk = () => persisted.push(true);
  deps.ctx.goals.chestSnapshots = {
    phantom: {
      at: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
      position: { x: 321, y: 64, z: -590 },
      items: [{ name: 'andesite', count: 169 }],
    },
  };
  const r = await createContainerActions(deps).deposit({
    items: [{ item: 'andesite', count: 1 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INTERRUPTED');
  assert.deepEqual(r.error.observed_state.evicted_snapshots, ['phantom']);
  assert.equal('phantom' in deps.ctx.goals.chestSnapshots, false);
  assert.equal(persisted.length, 1);
  assert.equal(r.error.retry_safe, false); // becomes non-retry-safe once evicted
});

test('evictChestSnapshotsAtPosition: pure helper, floor coords, no side-effects beyond delete', () => {
  const snaps = {
    a: { position: { x: 10.4, y: 64, z: -5.9 }, items: [] },
    b: { position: { x: 10, y: 64, z: -6 }, items: [] }, // floored equivalent of a
    c: { position: { x: 11, y: 64, z: -5 }, items: [] }, // different
    d: { /* no position */ items: [] },
  };
  const removed = evictChestSnapshotsAtPosition(snaps, 10, 64, -6);
  assert.deepEqual(removed.sort(), ['a', 'b']);
  assert.equal('a' in snaps, false);
  assert.equal('b' in snaps, false);
  assert.equal('c' in snaps, true);
  assert.equal('d' in snaps, true); // entries without position untouched
});

test('evictChestSnapshotsAtPosition: tolerates null/undefined input', () => {
  assert.deepEqual(evictChestSnapshotsAtPosition(null, 0, 0, 0), []);
  assert.deepEqual(evictChestSnapshotsAtPosition(undefined, 0, 0, 0), []);
  assert.deepEqual(evictChestSnapshotsAtPosition({}, 0, 0, 0), []);
});
