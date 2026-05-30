import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearNavTrail,
  sampleNavTrailCrumb,
  navTrailCrumbsNewestFirst,
  floorCellFromPos,
  mergeCollinearNavTrailCrumbs,
} from '../../lib/runtime/nav-trail.js';
import { loadConfig } from '../../lib/config/index.js';

test('floorCellFromPos floors entity coords', () => {
  assert.deepEqual(floorCellFromPos({ x: 1.7, y: 65.2, z: -2.1 }), { x: 1, y: 65, z: -3 });
});

test('sampleNavTrailCrumb: spacing and cap', () => {
  const ctx = { runtime: {} };
  const bot = {
    entity: { position: { x: 0.5, y: 65, z: 0.5 }, onGround: true },
  };
  sampleNavTrailCrumb(ctx, bot);
  bot.entity.position.x = 1.5;
  sampleNavTrailCrumb(ctx, bot);
  assert.equal(ctx.runtime.navTrail.crumbs.length, 1, 'under 2m spacing — no second crumb');
  bot.entity.position.x = 4.5;
  sampleNavTrailCrumb(ctx, bot);
  assert.equal(ctx.runtime.navTrail.crumbs.length, 2);
  for (let i = 0; i < 70; i++) {
    bot.entity.position.x = 4.5 + i * 3;
    sampleNavTrailCrumb(ctx, bot);
  }
  assert.ok(ctx.runtime.navTrail.crumbs.length <= 64);
});

test('clearNavTrail drops crumbs', () => {
  const ctx = { runtime: { navTrail: { crumbs: [{ x: 0, y: 65, z: 0, ts: Date.now() }] } } };
  clearNavTrail(ctx, 'test');
  assert.equal(ctx.runtime.navTrail, null);
});

test('navTrailCrumbsNewestFirst reverses order', () => {
  const ctx = {
    runtime: {
      navTrail: {
        crumbs: [
          { x: 0, y: 65, z: 0, ts: Date.now() },
          { x: 3, y: 65, z: 0, ts: Date.now() },
        ],
      },
    },
  };
  const rev = navTrailCrumbsNewestFirst(ctx);
  assert.equal(rev[0].x, 3);
  assert.equal(rev[1].x, 0);
});

test('mergeCollinearNavTrailCrumbs drops middle collinear crumb', () => {
  process.env.HERMES_RETRACE_TRAIL = 'true';
  loadConfig([]);
  const ctx = {
    runtime: {
      navTrail: {
        crumbs: [
          { x: 0, y: 65, z: 0, ts: Date.now() },
          { x: 1, y: 65, z: 0, ts: Date.now() },
          { x: 2, y: 65, z: 0, ts: Date.now() },
        ],
      },
    },
  };
  mergeCollinearNavTrailCrumbs(ctx);
  assert.equal(ctx.runtime.navTrail.crumbs.length, 2);
});

test('sampleNavTrailCrumb clears trail on large teleport', () => {
  const ctx = { runtime: { _navTrailLastPos: { x: 0, y: 65, z: 0 } } };
  ctx.runtime.navTrail = { crumbs: [{ x: 0, y: 65, z: 0, ts: Date.now() }] };
  const bot = { entity: { position: { x: 20, y: 65, z: 0 }, onGround: false } };
  sampleNavTrailCrumb(ctx, bot);
  assert.equal(ctx.runtime.navTrail, null);
  assert.equal(ctx.runtime.navTrailClearedAt?.reason, 'teleport');
});
