import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNavBrief,
  buildNavFrame,
  rankNavBriefPaths,
  collectKeyLocations,
  KEY_LOCATION_CAP,
  NAV_BRIEF_SCHEMA,
  markBriefRefreshRequired,
  reconcileNavBriefPaths,
  recordNavBriefNegativeLeg,
  navBriefLineKey,
} from '../../lib/runtime/nav-brief.js';

/** Forest-edge mock: open surface, trail from base through forest_edge. */
function makeForestCtx(overrides = {}) {
  const pos = { x: 276.5, y: 64, z: 78.5 };
  const bot = {
    entity: { position: pos, onGround: true },
  };
  const ctx = {
    world: { bot, botReady: true },
    runtime: {
      navTrail: {
        crumbs: [
          { x: 305, y: 64, z: -52, junction: 'base_anchor', ts: Date.now() - 60_000 },
          { x: 276, y: 64, z: 78, junction: 'forest_edge', ts: Date.now() - 30_000 },
          { x: 276, y: 64, z: 78, ts: Date.now() - 10_000 },
        ],
      },
      ...overrides.runtime,
    },
  };
  return { ctx, bot, pos };
}

function makeForestDeps(getPathToImpl, locationSet = 'forest') {
  const forestLocs = {
    base_anchor: { x: 305, y: 64, z: -52 },
    chest_food: { x: 298, y: 64, z: -48 },
    lt_mine: { x: 340, y: 64, z: 10 },
  };
  const manyLocs = {
    ...forestLocs,
    mark_a: { x: 280, y: 64, z: 70 },
    mark_b: { x: 281, y: 64, z: 71 },
    mark_c: { x: 282, y: 64, z: 72 },
    mark_d: { x: 283, y: 64, z: 73 },
    mark_e: { x: 284, y: 64, z: 74 },
    mark_f: { x: 285, y: 64, z: 75 },
    mark_g: { x: 286, y: 64, z: 76 },
    mark_h: { x: 287, y: 64, z: 77 },
    mark_i: { x: 288, y: 64, z: 78 },
  };
  const locations = locationSet === 'many' ? manyLocs : forestLocs;
  return {
    loadLocations: () => locations,
    getStandingState: () => ({
      classification: 'open',
      open_dirs: ['north', 'east', 'south', 'west'],
    }),
    getPathTo: getPathToImpl,
    now: () => 1_000_000,
    budgetMs: 500,
  };
}

test('collectKeyLocations caps at KEY_LOCATION_CAP', () => {
  const { ctx } = makeForestCtx();
  const deps = makeForestDeps(undefined, 'many');
  const keys = collectKeyLocations(ctx, deps);
  assert.equal(keys.length, KEY_LOCATION_CAP);
});

test('buildNavFrame: open mode + journey line', () => {
  const { ctx } = makeForestCtx();
  const frame = buildNavFrame(ctx, makeForestDeps());
  assert.equal(frame.nav_mode, 'open');
  assert.ok(frame.journey.line.includes('base anchor'));
  assert.ok(frame.journey.line.endsWith('here'));
  assert.deepEqual(frame.pos_snapshot, { x: 276, y: 64, z: 78 });
});

test('computeNavBrief: forest fixture with mock getPathTo', () => {
  const { ctx, bot } = makeForestCtx();
  const reachable = new Set(['base_anchor', 'chest_food', 'mark_a']);
  const deps = makeForestDeps((_ctx, _bot, goal) => {
    const locs = makeForestDeps(undefined, 'forest').loadLocations();
    const key = Object.entries(locs).find(
      ([, l]) => l.x === goal.x && l.y === goal.y && l.z === goal.z,
    )?.[0];
    if (key && reachable.has(key)) {
      return { status: 'success', path: [{ x: 0, y: 0, z: 0 }] };
    }
    return { status: 'noPath' };
  });

  const result = computeNavBrief(ctx, deps);
  assert.equal(result.brief.schema_version, NAV_BRIEF_SCHEMA);
  assert.equal(result.brief.nav_mode, 'open');
  assert.ok(result.brief.paths.some((p) => p.label === 'back' && p.args === '--trail'));
  const base = result.brief.paths.find((p) => p.label === 'base_anchor');
  assert.ok(base?.reachable);
  const suggested = result.brief.paths.find((p) => p.suggested);
  assert.equal(suggested?.label, 'chest_food');
  const blocked = result.brief.paths.find((p) => p.label === 'lt_mine');
  assert.ok(blocked?.blocked);
  assert.equal(result.status, null);
  assert.ok(result.compute_ms >= 0);
  assert.equal(bot.entity.position.x, 276.5);
});

test('computeNavBrief: PARTIAL_BRIEF when budget exhausted', () => {
  const { ctx } = makeForestCtx();
  let t = 1_000_000;
  const deps = makeForestDeps(() => {
    t += 20;
    return { status: 'success', path: [] };
  });
  deps.budgetMs = 5;
  deps.now = () => t;

  const result = computeNavBrief(ctx, deps);
  assert.equal(result.status, 'PARTIAL_BRIEF');
  // The result envelope carries the degraded status — the brief struct
  // itself no longer dupes it (single source of truth, see
  // nav-brief-degraded.test.js for the round-trip).
  assert.equal(result.brief.stale_reason, undefined);
});

test('rankNavBriefPaths: confined TAGS long strategic moves (does not drop them)', () => {
  const paths = [
    { label: 'base', verb: 'move', args: 'base', straight_m: 80, reachable: true },
    { label: 'back', verb: 'retrace', args: '--trail', reachable: true, local: true },
    { label: 'near', verb: 'move', args: 'near', straight_m: 10, reachable: true },
  ];
  const ranked = rankNavBriefPaths(paths, { nav_mode: 'confined' });
  // Distant strategic row stays so the agent knows base exists, but is
  // tagged blocked + confined_strategic and never suggested.
  const base = ranked.find((p) => p.label === 'base');
  assert.ok(base, 'distant strategic row must remain listed in confined mode');
  assert.equal(base.confined_strategic, true);
  assert.equal(base.blocked, true);
  assert.equal(base.reachable, false);
  assert.equal(base.suggested, false);
  // Local row preserved without tagging.
  const near = ranked.find((p) => p.label === 'near');
  assert.equal(near.blocked, undefined);
  assert.equal(near.reachable, true);
});

test('markBriefRefreshRequired sets runtime hook', () => {
  const { ctx } = makeForestCtx();
  assert.equal(ctx.runtime.briefRefreshRequired, undefined);
  markBriefRefreshRequired(ctx, { cells: [{ x: 1, y: 2, z: 3 }] });
  assert.deepEqual(ctx.runtime.briefRefreshRequired.cells, [{ x: 1, y: 2, z: 3 }]);
});

test('reconcileNavBriefPaths drops negative legs for this round', () => {
  const { ctx } = makeForestCtx();
  recordNavBriefNegativeLeg(ctx, 'move:base_anchor');
  const paths = [
    { label: 'base_anchor', verb: 'move', args: 'base_anchor', reachable: true },
    { label: 'back', verb: 'retrace', args: '--trail', reachable: true, local: true },
  ];
  const out = reconcileNavBriefPaths(ctx, paths);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'back');
  assert.equal(navBriefLineKey(paths[0]), 'move:base_anchor');
});

test('computeNavBrief applies reconcile before rank', () => {
  const { ctx } = makeForestCtx();
  recordNavBriefNegativeLeg(ctx, 'move:chest_food');
  const deps = makeForestDeps(() => ({ status: 'success', path: [] }));
  const result = computeNavBrief(ctx, deps);
  assert.ok(!result.brief.paths.some((p) => p.label === 'chest_food'));
});

test('computeNavBrief passes radius=2 to getPathTo (GoalNear semantics for marks)', () => {
  // Regression guard: container marks like chests are solid blocks. Without
  // GoalNear semantics, getPathTo({x,y,z}) treats it as GoalBlock and every
  // chest mark renders ⚠ blocked. Observed live in g-2026-05-30-2: Steward
  // at base saw all 5 chests as blocked despite being 3m away. The fix
  // threads `radius: 2` through opts so server.js wraps in goals.GoalNear.
  const { ctx } = makeForestCtx();
  const capturedOpts = [];
  const deps = makeForestDeps((_ctx, _bot, _goal, opts) => {
    capturedOpts.push(opts);
    return { status: 'success', path: [] };
  });
  computeNavBrief(ctx, deps);
  assert.ok(capturedOpts.length > 0, 'getPathTo should be called at least once');
  for (const opts of capturedOpts) {
    assert.equal(opts.radius, 2, 'radius must be 2 so marks are reachable from nearby cells');
  }
});
