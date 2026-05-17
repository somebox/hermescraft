/**
 * Queries handler unit tests — focused on the `scout` extension that adds
 * an optional `block` argument with density buckets, centroid, and verdict
 * (Fix D from the mining punch list).
 *
 * createQueriesActions takes the services container directly (not the
 * legacy deps shape mining.js uses), so the mock wiring is shorter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createQueriesActions } from '../../lib/actions/queries.js';
import { validate } from '../../lib/shared/action-contract.js';
import { createMockServices } from '../../lib/server/mock-services.js';

function makeStubBot(opts = {}) {
  const position = opts.position || new Vec3(0, 64, 0);
  const targetPositions = opts.targetPositions || [];
  const aboveAt = opts.aboveAt || (() => 'air'); // name of block ONE ABOVE pos
  return {
    entity: { position, isInWater: false, yaw: 0, pitch: 0 },
    findBlocks: ({ matching }) => {
      // Tests pass `matching` as either a numeric id or a function. The
      // production code calls with numeric id for target-block scans and
      // with a function predicate for hazard scans. Tests only care
      // about the target-block scan; hazard scans return [].
      if (typeof matching === 'number') return targetPositions.slice();
      return [];
    },
    blockAt: (pos) => {
      // Used to look up what's directly above each candidate.
      // pos here is a Vec3 like targetPos.offset(0,1,0).
      const name = aboveAt({ x: pos.x, y: pos.y, z: pos.z });
      return { name, getProperties: () => ({}) };
    },
    entities: opts.entities || {},
  };
}

function makeMcData() {
  return {
    blocksByName: {
      dirt:        { id: 3, drops: [3], boundingBox: 'block' },
      grass_block: { id: 9, drops: [3], boundingBox: 'block' },
      coal_ore:    { id: 16, drops: [263], boundingBox: 'block' },
    },
    itemsByName: { dirt: { id: 3 }, coal: { id: 263 } },
    items: { 3: { name: 'dirt' }, 263: { name: 'coal' } },
  };
}

function makeServices(opts = {}) {
  const bot = opts.bot || makeStubBot();
  const services = createMockServices({
    state: { world: { botReady: true, bot, mcData: makeMcData() } },
    ensureBot: () => bot,
  });
  if (opts.fairPlayOverrides) {
    Object.assign(services.fairPlay, opts.fairPlayOverrides);
  }
  return services;
}

// ─────────────────────────────────────────────────────────────────────────
// Backward compat: legacy scout (no `block`) keeps its existing shape.
// ─────────────────────────────────────────────────────────────────────────

test('queries.scout: legacy shape (no block arg) — backward compatible', async () => {
  const services = makeServices();
  const actions = createQueriesActions(services);
  const r = await actions.scout({ radius: 8 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.data).sort(), ['bedrock', 'center', 'counts', 'falling_blocks', 'hostile_mobs', 'lava', 'radius', 'water']);
  assert.equal(r.data.target, undefined, 'legacy scout must not include target');
});

// ─────────────────────────────────────────────────────────────────────────
// UNKNOWN_BLOCK when --block names a non-existent block.
// ─────────────────────────────────────────────────────────────────────────

test('queries.scout: --block with unknown name returns UNKNOWN_BLOCK', async () => {
  const services = makeServices();
  const actions = createQueriesActions(services);
  const r = await actions.scout({ block: 'unobtainium' });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_BLOCK');
});

// ─────────────────────────────────────────────────────────────────────────
// Verdicts: not_enough / mine_here / move_to / unsafe
// ─────────────────────────────────────────────────────────────────────────

test('queries.scout: verdict=not_enough when too few exposed candidates', async () => {
  const positions = [
    new Vec3(1, 63, 0),  // 1 dirt at distance 1
    new Vec3(2, 63, 0),  // 1 dirt at distance 2
  ];
  const services = makeServices({
    bot: makeStubBot({ targetPositions: positions, aboveAt: () => 'air' }),
  });
  const actions = createQueriesActions(services);
  const r = await actions.scout({ block: 'dirt', radius: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target.block, 'dirt');
  assert.equal(r.data.target.verdict, 'not_enough');
  assert.equal(r.data.target.total_found, 2);
});

test('queries.scout: verdict=mine_here when enough visible candidates near bot', async () => {
  // Bot at (0,64,0). 6 dirt blocks within ~3 manhattan of bot — centroid close.
  const positions = [
    new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(-1, 63, 0),
    new Vec3(0, 63, 1), new Vec3(0, 63, -1), new Vec3(1, 63, 1),
  ];
  const services = makeServices({
    bot: makeStubBot({ targetPositions: positions, aboveAt: () => 'air' }),
  });
  const actions = createQueriesActions(services);
  const r = await actions.scout({ block: 'dirt', radius: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target.verdict, 'mine_here');
  assert.equal(r.data.target.counts.exposed_visible, 6);
  assert.ok(r.data.target.centroid, 'centroid required for mine_here');
});

test('queries.scout: verdict=move_to when centroid is far from bot', async () => {
  // Bot at (0,64,0). 8 dirt blocks clustered around (10, 63, 0) — far.
  const positions = [
    new Vec3(8, 63, 0), new Vec3(9, 63, 0), new Vec3(10, 63, 0), new Vec3(11, 63, 0),
    new Vec3(10, 63, 1), new Vec3(10, 63, -1), new Vec3(11, 63, 1), new Vec3(9, 63, -1),
  ];
  const services = makeServices({
    bot: makeStubBot({ targetPositions: positions, aboveAt: () => 'air' }),
  });
  const actions = createQueriesActions(services);
  const r = await actions.scout({ block: 'dirt', radius: 16 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target.verdict, 'move_to');
  assert.ok(r.data.target.centroid, 'centroid required for move_to');
  // Centroid x should be roughly the cluster mean (around x=10)
  assert.ok(r.data.target.centroid.x >= 8 && r.data.target.centroid.x <= 12);
  assert.match(r.data.target.verdict_detail, /centroid at .*~\d+ blocks away/);
});

test('queries.scout: verdict=unsafe when hostile mobs nearby', async () => {
  const positions = Array.from({ length: 6 }, (_, i) => new Vec3(i, 63, 0));
  const services = makeServices({
    bot: makeStubBot({
      targetPositions: positions,
      aboveAt: () => 'air',
      entities: {
        z1: { name: 'zombie', position: new Vec3(2, 64, 0) },
        z2: { name: 'skeleton', position: new Vec3(3, 64, 0) },
      },
    }),
  });
  const actions = createQueriesActions(services);
  const r = await actions.scout({ block: 'dirt', radius: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target.verdict, 'unsafe');
  assert.match(r.data.target.verdict_detail, /hostile/);
});

// ─────────────────────────────────────────────────────────────────────────
// Density buckets: exposed_buried vs fully_buried vs surface_under_liquid
// ─────────────────────────────────────────────────────────────────────────

test('queries.scout: classifies fully_buried (stone above) vs exposed_visible (air above)', async () => {
  // 4 exposed (air above) + 4 buried (stone above) — total 8, but visible 4
  const positions = [
    new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0), new Vec3(3, 63, 0),  // exposed
    new Vec3(0, 62, 0), new Vec3(1, 62, 0), new Vec3(2, 62, 0), new Vec3(3, 62, 0),  // buried (stone at y=63 above)
  ];
  const services = makeServices({
    bot: makeStubBot({
      targetPositions: positions,
      // Above-block lookup: y=64 (above the top dirt at y=63) is air;
      // y=63 (above the buried dirt at y=62) is the top dirt itself,
      // i.e. NOT air.
      aboveAt: ({ y }) => (y === 64 ? 'air' : 'dirt'),
    }),
  });
  const actions = createQueriesActions(services);
  const r = await actions.scout({ block: 'dirt', radius: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target.counts.exposed_visible, 4);
  assert.equal(r.data.target.counts.fully_buried, 4);
});

test('queries.scout: counts surface_under_liquid when water is above', async () => {
  const positions = [new Vec3(0, 62, 0), new Vec3(1, 62, 0)];
  const services = makeServices({
    bot: makeStubBot({
      targetPositions: positions,
      aboveAt: () => 'water',
    }),
  });
  const actions = createQueriesActions(services);
  const r = await actions.scout({ block: 'dirt', radius: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target.counts.surface_under_liquid, 2);
  assert.equal(r.data.target.counts.exposed_visible, 0);
  // not_enough because 0 exposed
  assert.equal(r.data.target.verdict, 'not_enough');
});
