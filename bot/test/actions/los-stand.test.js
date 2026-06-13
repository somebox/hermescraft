/**
 * Characterization pin for pickLosStandCell — the chest-adjacent LOS stand
 * picker extracted verbatim from goto_near (Pass 1 seam for the future
 * `approach` verb). Locks: it returns the NEAREST standable cell with LOS to
 * a target face, the targetIsSolid gate, and the null paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { pickLosStandCell } from '../../lib/actions/movement/_los-stand.js';

// World: solid target at (5,64,0); solid floor under two lateral stand cells
// (4,64,0) d=1 and (2,64,0) d=3. The cell on TOP of the target (5,65,0) is
// also standable (floor = the target block) — the case we must NOT pick.
function makeBot() {
  const solid = new Set(['5,64,0', '4,63,0', '2,63,0']);
  return {
    blockAt(p) {
      const k = `${p.x},${p.y},${p.z}`;
      if (solid.has(k)) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
}

test('pickLosStandCell: returns nearest LOS-clear lateral cell, never on-top', () => {
  const b = makeBot();
  // LOS passes only for eyes west of the target (x < 5): the two lateral
  // cells qualify (eye x = 4.5, 2.5); the on-top cell's eye (x = 5.5) fails.
  const r = pickLosStandCell(b, { tx: 5, ty: 64, tz: 0, range: 3 }, { hasLineOfSight: (from) => from.x < 5 });
  assert.deepEqual(r, { cx: 4, cy: 64, cz: 0, d: 1 });
});

test('pickLosStandCell: non-solid (air) target → null (targetIsSolid gate)', () => {
  const air = { blockAt: () => ({ name: 'air', boundingBox: 'empty' }) };
  assert.equal(pickLosStandCell(air, { tx: 5, ty: 64, tz: 0, range: 3 }, { hasLineOfSight: () => true }), null);
});

test('pickLosStandCell: no LOS-clear cell → null', () => {
  const b = makeBot();
  assert.equal(pickLosStandCell(b, { tx: 5, ty: 64, tz: 0, range: 3 }, { hasLineOfSight: () => false }), null);
});

test('pickLosStandCell: missing hasLineOfSight → null', () => {
  const b = makeBot();
  assert.equal(pickLosStandCell(b, { tx: 5, ty: 64, tz: 0, range: 3 }, {}), null);
});
