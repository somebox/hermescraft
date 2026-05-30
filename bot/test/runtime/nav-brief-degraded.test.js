import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderNavBrief,
  rankNavBriefPaths,
  applyK1RepairToRanked,
  computeNavBrief,
} from '../../lib/runtime/nav-brief.js';

/**
 * Coverage for the follow-up work after the 2026-05-30 code review:
 * - Degraded modes (PARTIAL_BRIEF / STALE_BRIEF / brief_refresh_required)
 *   surface in the rendered text the agent reads.
 * - Confined nav_mode TAGS strategic rows instead of dropping them.
 * - K=1 repair promotes the repaired row to the head of the move section so
 *   the `← suggested` annotation lands at the top of the visible list.
 */

const baseBrief = () => ({
  schema_version: 'nav_brief/1',
  brief_id: 'nb-1',
  computed_at: 1000,
  pos_snapshot: { x: 0, y: 64, z: 0 },
  nav_mode: 'open',
  nav_mode_signals: { text: '4 exits' },
  header: { situation: 'Surface' },
  paths: [
    {
      label: 'base',
      verb: 'move',
      args: 'base_anchor',
      straight_m: 14,
      reachable: true,
      suggested: true,
      provenance: 'inferred',
    },
  ],
});

test('renderNavBrief surfaces ⚠ PARTIAL_BRIEF in the agent-facing text', () => {
  const text = renderNavBrief(baseBrief(), { nav_brief_status: 'PARTIAL_BRIEF' });
  assert.match(text, /⚠ PARTIAL_BRIEF/);
  assert.match(text, /treat missing rows as unknown, not blocked/);
});

test('renderNavBrief surfaces ⚠ STALE_BRIEF', () => {
  const text = renderNavBrief(baseBrief(), { nav_brief_status: 'STALE_BRIEF' });
  assert.match(text, /⚠ STALE_BRIEF/);
  assert.match(text, /position changed since compute/);
});

test('renderNavBrief surfaces brief_refresh_required when terrain mutated', () => {
  const text = renderNavBrief(baseBrief(), { brief_refresh_required: true });
  assert.match(text, /⚠ brief_refresh_required/);
});

test('renderNavBrief emits no warning lines when status is clean', () => {
  const text = renderNavBrief(baseBrief(), {});
  assert.ok(!text.includes('⚠ PARTIAL_BRIEF'));
  assert.ok(!text.includes('⚠ STALE_BRIEF'));
  assert.ok(!text.includes('⚠ brief_refresh_required'));
});

test('rankNavBriefPaths confined mode TAGS strategic rows instead of dropping them', () => {
  const paths = [
    { label: 'base', verb: 'move', args: 'base_anchor', straight_m: 120, reachable: true },
    { label: 'chest_food', verb: 'move', args: 'chest_food', straight_m: 8, reachable: true, local: true },
    { label: 'back', verb: 'retrace', args: '--trail', reachable: true },
  ];
  const ranked = rankNavBriefPaths(paths, { nav_mode: 'confined' });

  // Strategic row is still in the list — the agent must know "base exists".
  const base = ranked.find((r) => r.label === 'base');
  assert.ok(base, 'distant strategic row must remain in the list under confined mode');
  assert.equal(base.confined_strategic, true);
  assert.equal(base.blocked, true);
  assert.equal(base.reachable, false);
  assert.equal(base.suggested, false);

  // Local + back rows untouched.
  const local = ranked.find((r) => r.label === 'chest_food');
  assert.equal(local.blocked, undefined);
  assert.equal(local.reachable, true);

  const back = ranked.find((r) => r.label === 'back');
  assert.ok(back, 'back-line must always remain in confined mode');
});

test('renderNavBrief annotates confined-strategic rows with ⚠ blocked (confined)', () => {
  const brief = baseBrief();
  brief.nav_mode = 'confined';
  brief.nav_mode_signals = { text: '1 exit, density 0.81' };
  brief.paths = [
    {
      label: 'base',
      verb: 'move',
      args: 'base_anchor',
      straight_m: 120,
      blocked: true,
      reachable: false,
      confined_strategic: true,
    },
  ];
  const text = renderNavBrief(brief);
  assert.match(text, /⚠ blocked \(confined\)/);
  assert.ok(!text.includes('⚠ blocked,'), 'should not double-emit a plain ⚠ blocked tag');
});

test('applyK1RepairToRanked promotes the repaired row to the head of the move section', () => {
  // K=1 repair only fires when NO move row is currently reachable (line 126
  // of nav-brief.js: early return if any reachable+!blocked move exists).
  // So we set both move rows as blocked; the closer one should be selected
  // for repair AND promoted to the front of the move section.
  const candidates = [
    { name: 'chest_food', x: 5, y: 64, z: 0 }, // closer, will be repaired
    { name: 'base_anchor', x: 100, y: 64, z: 0 }, // farther, also blocked
  ];
  const ranked = [
    {
      label: 'back',
      verb: 'retrace',
      args: '--trail',
      reachable: true,
      local: true,
    },
    {
      label: 'base_anchor',
      verb: 'move',
      args: 'base_anchor',
      straight_m: 100,
      reachable: false,
      blocked: true,
    },
    {
      label: 'chest_food',
      verb: 'move',
      args: 'chest_food',
      straight_m: 5,
      reachable: false,
      blocked: true,
    },
  ];

  const fakeBot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
  };
  const ctx = { runtime: {}, world: { bot: fakeBot } };
  const frame = { nav_mode: 'open' };
  const deps = {
    confirmK1Repair: () => true,
    isDigProtected: () => false,
    shouldSkipDigAt: () => ({ skip: false }),
    getConfig: () => ({ behaviors: {} }),
  };

  const out = applyK1RepairToRanked(ctx, fakeBot, ranked, candidates, frame, deps);

  // The first move-verb row should be the repaired chest_food (suggested).
  // Without the promotion, it would land wherever it was placed in the
  // input order (last in this case).
  const moveRows = out.filter((r) => r.verb === 'move');
  assert.equal(moveRows[0].label, 'chest_food');
  assert.equal(moveRows[0].suggested, true);
  assert.equal(moveRows[0].via_k1_repair, true);
  assert.ok(moveRows[0].composite_hint.includes('→ move chest_food'));
  // The other still-blocked row keeps its blocked state, no suggested.
  const other = moveRows.find((r) => r.label === 'base_anchor');
  assert.ok(!other.suggested);
});

test('renderNavBrief includes both PARTIAL_BRIEF and brief_refresh_required when both set', () => {
  const text = renderNavBrief(baseBrief(), {
    nav_brief_status: 'PARTIAL_BRIEF',
    brief_refresh_required: true,
  });
  assert.match(text, /⚠ PARTIAL_BRIEF/);
  assert.match(text, /⚠ brief_refresh_required/);
});

test('computeNavBrief sets status=PARTIAL_BRIEF but no longer stashes stale_reason on the brief', () => {
  const ctx = {
    runtime: { navTrail: { crumbs: [] } },
    world: {
      bot: { entity: { position: { x: 0, y: 64, z: 0 } } },
    },
  };
  // Single mark + zero budget triggers PARTIAL_BRIEF path.
  const deps = {
    loadLocations: () => ({ a: { x: 100, y: 64, z: 0 } }),
    getStandingState: () => null,
    getPathTo: () => ({ status: 'success' }),
    budgetMs: 0,
    now: ((t) => () => (t += 1))(0),
  };
  const result = computeNavBrief(ctx, deps);
  assert.equal(result.status, 'PARTIAL_BRIEF');
  assert.ok(result.brief, 'partial result still ships a brief');
  // Single source of truth: status lives on the result envelope, not duped on the brief.
  assert.equal(result.brief.stale_reason, undefined);
});
