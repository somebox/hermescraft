import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNavBrief } from '../../lib/runtime/nav-brief.js';

test('renderNavBrief golden minimal', () => {
  const brief = {
    schema_version: 'nav_brief/1',
    brief_id: 'nb-golden',
    computed_at: 106,
    pos_snapshot: { x: 305, y: 64, z: -52 },
    nav_mode: 'open',
    nav_mode_signals: { text: '4 exits' },
    header: { situation: 'Surface' },
    paths: [
      {
        label: 'base',
        verb: 'move',
        args: 'base_anchor',
        straight_m: 14,
        provenance: 'inferred',
        reachable: true,
        suggested: true,
      },
      {
        label: 'chest_food',
        verb: 'move',
        args: 'chest_food',
        straight_m: 22,
        provenance: 'inferred',
        reachable: true,
      },
    ],
    journey: { line: 'base anchor → here' },
  };

  const text = renderNavBrief(brief);
  assert.equal(
    text,
    [
      'Surface at 305,64,-52 — open (4 exits)   as_of=106',
      'paths:',
      '- base:         move base_anchor     (14m), inferred, ← suggested',
      '- chest_food:   move chest_food     (22m), inferred',
      'journey: base anchor → here',
    ].join('\n'),
  );
});

test('renderNavBrief prints composite k=1 repair line', () => {
  const brief = {
    schema_version: 'nav_brief/1',
    computed_at: 200,
    pos_snapshot: { x: 272, y: 38, z: 82 },
    nav_mode: 'open',
    nav_mode_signals: { text: '4 exits' },
    header: { situation: 'Surface' },
    paths: [
      {
        label: 'chest_food',
        verb: 'move',
        args: 'chest_food',
        straight_m: 10,
        composite_hint: 'dig 273 38 82 → move chest_food',
        via_k1_repair: true,
        suggested: true,
        reachable: true,
      },
    ],
  };
  const text = renderNavBrief(brief);
  assert.match(text, /dig 273 38 82 → move chest_food/);
  assert.match(text, /← suggested/);
  assert.match(text, /k=1/);
});

// Phase 10 PR-J Bench A — terrain renders even when `flat`. Dispositive
// run-6 evidence: Flint at agent-flint.log:432 narrated "I'm at Y=96 which
// is underground in this world" while standing on the freshly-cleaned PR-H
// spawn floor. Classifier returned `flat`, renderer skipped it as "low
// signal" — Flint defaulted to raw-Y inference. Surface `flat` so SOUL has
// a positive label to act on.
test('PR-J: renderNavBrief emits terrain=flat when classifier returns flat', () => {
  const brief = {
    schema_version: 'nav_brief/1',
    computed_at: 500,
    pos_snapshot: { x: 0, y: 96, z: 0 },
    nav_mode: 'open',
    nav_mode_signals: { text: '4 exits' },
    header: {
      situation: 'Surface',
      terrain: { kind: 'flat', feet_vs_local_ground: 0 },
    },
    paths: [],
  };
  const text = renderNavBrief(brief);
  assert.match(text, /terrain=flat \(feet_vs_local_ground=0\)/);
});

test('PR-J: renderNavBrief emits terrain=underground when classifier returns underground', () => {
  // Regression guard: non-flat labels still render.
  const brief = {
    schema_version: 'nav_brief/1',
    computed_at: 501,
    pos_snapshot: { x: 0, y: 84, z: 0 },
    nav_mode: 'confined',
    nav_mode_signals: { text: '0 exits' },
    header: {
      situation: 'Underground',
      terrain: { kind: 'underground', feet_vs_local_ground: -12 },
    },
    paths: [],
  };
  const text = renderNavBrief(brief);
  assert.match(text, /terrain=underground \(feet_vs_local_ground=-12\)/);
});

test('PR-J: renderNavBrief omits terrain line when classifier returned no label', () => {
  // The classifier returns `unknown` for canopy/no-surface cases; the
  // renderer should still emit the label so SOUL knows it's unknown
  // rather than absent. The only case where the terrain line drops is
  // when `brief.header.terrain` is missing entirely.
  const briefMissing = {
    schema_version: 'nav_brief/1',
    computed_at: 502,
    pos_snapshot: { x: 0, y: 64, z: 0 },
    nav_mode: 'open',
    nav_mode_signals: { text: '4 exits' },
    header: { situation: 'Surface' },
    paths: [],
  };
  assert.doesNotMatch(renderNavBrief(briefMissing), /terrain=/);
  const briefUnknown = {
    ...briefMissing,
    computed_at: 503,
    header: { situation: 'Surface', terrain: { kind: 'unknown', feet_vs_local_ground: -6 } },
  };
  // unknown SHOULD render — the change in PR-J is that we surface
  // whatever the classifier returned, including 'unknown'.
  assert.match(renderNavBrief(briefUnknown), /terrain=unknown/);
});
