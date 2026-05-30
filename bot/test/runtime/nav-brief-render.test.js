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
