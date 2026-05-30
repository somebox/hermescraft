import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rankNavBriefPaths,
  computeNavBrief,
  renderNavBrief,
  classifyNavMode,
} from '../../lib/runtime/nav-brief.js';

test('rankNavBriefPaths tags distant strategic rows when confined (Phase 2 doctrine)', () => {
  // Phase 2 behavior per docs/features/route-precompute-context.md:188-190 —
  // strategic rows are KEPT in the list so the agent knows base/chest_food
  // exist, but tagged blocked + confined_strategic and never suggested.
  // Earlier Phase 1 behavior dropped them; this test guards the new tag.
  const paths = [
    { label: 'back', verb: 'retrace', args: '--trail', reachable: true, local: true },
    { label: 'base', verb: 'move', args: 'base_anchor', reachable: true, straight_m: 120 },
    { label: 'near', verb: 'move', args: 'chest_food', reachable: true, straight_m: 10 },
  ];
  const ranked = rankNavBriefPaths(paths, { nav_mode: 'confined' });
  assert.ok(ranked.some((p) => p.label === 'back'));
  const base = ranked.find((p) => p.label === 'base' && p.straight_m === 120);
  assert.ok(base, 'distant strategic row should remain present (tagged, not dropped)');
  assert.equal(base.confined_strategic, true);
  assert.equal(base.blocked, true);
  assert.equal(base.reachable, false);
});

test('classifyNavMode: pit hut enclosure_inside is confined', () => {
  const { mode, signals } = classifyNavMode({
    classification: 'enclosure_inside',
    open_dirs: ['up'],
    step_up_dirs: ['north'],
    local_density: 0.81,
  });
  assert.equal(mode, 'confined');
  assert.match(signals.text, /1 exit/);
});

test('computeNavBrief pit hut fixture suppresses far marks and renders standing', () => {
  const pos = { x: 272.5, y: 38.5, z: 82.5 };
  const bot = { entity: { position: pos } };
  const ctx = {
    world: { bot, botReady: true },
    runtime: {
      navTrail: {
        crumbs: [
          { x: 272, y: 64, z: 82, junction: 'pit_lip', ts: Date.now() - 120_000 },
          { x: 272, y: 50, z: 82, ts: Date.now() - 60_000 },
          { x: 272, y: 38, z: 82, ts: Date.now() - 10_000 },
        ],
      },
    },
  };
  const standing = {
    classification: 'enclosure_inside',
    open_dirs: ['up'],
    step_up_dirs: ['north'],
    local_density: 0.81,
  };
  const result = computeNavBrief(ctx, {
    loadLocations: () => ({
      base_anchor: { x: 305, y: 64, z: -52 },
      chest_food: { x: 298, y: 64, z: -48 },
      lt_mine: { x: 340, y: 64, z: 10 },
    }),
    getStandingState: () => standing,
    getPathTo: () => ({ status: 'noPath' }),
    now: () => 3_000_000,
    budgetMs: 500,
  });

  assert.equal(result.brief.nav_mode, 'confined');
  assert.ok(result.brief.standing_summary?.includes('enclosure_inside'));
  // Strategic far mark is kept but tagged (Phase 2 doctrine — listed so
  // the agent knows base_anchor exists, ⚠ blocked (confined), never suggested).
  const baseRow = result.brief.paths.find(
    (p) => p.label === 'base_anchor' && (p.straight_m ?? 0) > 32,
  );
  assert.ok(baseRow, 'far strategic mark should remain in the brief, tagged');
  assert.equal(baseRow.confined_strategic, true);
  assert.ok(!baseRow.suggested, 'tagged strategic row must never be suggested');
  assert.ok(result.brief.paths.some((p) => p.label === 'back'));

  const text = renderNavBrief(result.brief);
  // Header label now responds to standing classification — pit/tunnel/etc.
  // For an `enclosure_inside` situation it falls through to "Underground".
  assert.match(text, /(Underground|Pit|Tunnel) at 272,38,82 — confined/);
  assert.match(text, /standing: enclosure_inside/);
  assert.match(text, /⚠ blocked \(confined\)/);
});
