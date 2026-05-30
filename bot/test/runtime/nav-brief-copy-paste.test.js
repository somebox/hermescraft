import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNavBrief } from '../../lib/runtime/nav-brief.js';

/** Lines must be copy-pasteable mc invocations (plan 1-14). */
const MC_LINE = /^(move|retrace|dig|pillar_up|escape)\s+[\w@.:,-\s→]+$/;

test('renderNavBrief path lines parse as single mc commands or composites', () => {
  const brief = {
    computed_at: 1,
    pos_snapshot: { x: 1, y: 64, z: 2 },
    nav_mode: 'open',
    nav_mode_signals: { text: '4 exits' },
    header: { situation: 'Surface' },
    paths: [
      { label: 'base', verb: 'move', args: 'base_anchor', reachable: true, suggested: true },
      { label: 'back', verb: 'retrace', args: '--trail', reachable: true, local: true },
      {
        label: 'chest',
        verb: 'move',
        args: 'chest_food',
        composite_hint: 'dig 3 64 4 → move chest_food',
        via_k1_repair: true,
        suggested: true,
        reachable: true,
      },
    ],
  };
  const text = renderNavBrief(brief);
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const body = line.replace(/^-[^:]+:\s*/, '').split(/\s{2,}/)[0].trim();
    if (body.includes('→')) {
      const parts = body.split('→').map((s) => s.trim());
      assert.equal(parts.length, 2);
      assert.match(parts[0], /^dig -?\d+ -?\d+ -?\d+$/);
      assert.match(parts[1], /^move \w+$/);
    } else {
      assert.match(body.split(/\s+/).slice(0, 2).join(' '), /^(move|retrace)/);
    }
  }
});
