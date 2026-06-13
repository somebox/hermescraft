/**
 * Characterization pin for pickLosStandCell — the chest-adjacent LOS stand
 * picker extracted verbatim from goto_near (Pass 1 seam for the future
 * `approach` verb). Locks: it returns the NEAREST standable cell with LOS to
 * a target face, the targetIsSolid gate, and the null paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Vec3 } from 'vec3';

import { pickLosStandCell, losStanceGoal, tryLosStance } from '../../lib/actions/movement/_los-stand.js';

function reachGoals() {
  return {
    GoalNear: class { constructor(x, y, z, r) { this.kind = 'near'; this.x = x; this.y = y; this.z = z; this.r = r; } },
    GoalBlock: class { constructor(x, y, z) { this.kind = 'block'; this.x = x; this.y = y; this.z = z; } },
  };
}

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

// ── losStanceGoal + tryLosStance (the shared approach orchestration) ──
// Solid target at (10,64,10); standable lateral cell (9,64,10) (floor 9,63,10).
function stanceBot(start) {
  const solid = new Set(['10,64,10', '9,63,10']);
  return {
    entity: { position: new Vec3(start.x, start.y, start.z) },
    blockAt: (p) => (solid.has(`${p.x},${p.y},${p.z}`)
      ? { name: 'chest', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }),
  };
}

test('losStanceGoal: builds a GoalBlock at the nearest LOS cell', () => {
  const g = losStanceGoal(stanceBot({ x: 0, y: 64, z: 0 }), reachGoals(),
    { tx: 10, ty: 64, tz: 10, range: 4.5 }, () => true);
  assert.equal(g.kind, 'block');
  assert.deepEqual([g.x, g.y, g.z], [9, 64, 10]);
});

test('losStanceGoal: null when no LOS predicate, or no standable target', () => {
  assert.equal(losStanceGoal(stanceBot({ x: 0, y: 64, z: 0 }), reachGoals(), { tx: 10, ty: 64, tz: 10, range: 4.5 }), null);
  const air = { blockAt: () => ({ name: 'air', boundingBox: 'empty' }) };
  assert.equal(losStanceGoal(air, reachGoals(), { tx: 10, ty: 64, tz: 10, range: 4.5 }, () => true), null);
});

test('tryLosStance: true when runGoto lands the bot in range', async () => {
  const bot = stanceBot({ x: 0, y: 64, z: 0 });
  const calls = [];
  const runGoto = async (goal) => { calls.push(goal); bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return true; };
  const ok = await tryLosStance({ bot, goals: reachGoals(), tx: 10, ty: 64, tz: 10, range: 4.5, hasLineOfSight: () => true, capMs: 4000, runGoto });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'block');
});

test('tryLosStance: false when runGoto fails (caller should fall back)', async () => {
  const bot = stanceBot({ x: 0, y: 64, z: 0 });
  const ok = await tryLosStance({ bot, goals: reachGoals(), tx: 10, ty: 64, tz: 10, range: 4.5, hasLineOfSight: () => true, capMs: 4000, runGoto: async () => false });
  assert.equal(ok, false);
});

test('tryLosStance: false when no stance cell (no runGoto call)', async () => {
  const bot = stanceBot({ x: 0, y: 64, z: 0 });
  let called = false;
  const ok = await tryLosStance({ bot, goals: reachGoals(), tx: 10, ty: 64, tz: 10, range: 4.5, hasLineOfSight: () => false, capMs: 4000, runGoto: async () => { called = true; return true; } });
  assert.equal(ok, false);
  assert.equal(called, false);
});

test('tryLosStance: false when runGoto succeeds but bot stays out of range', async () => {
  const bot = stanceBot({ x: 0, y: 64, z: 0 });
  // runGoto "succeeds" but doesn't move the bot — still ~14 blocks away.
  const ok = await tryLosStance({ bot, goals: reachGoals(), tx: 10, ty: 64, tz: 10, range: 4.5, hasLineOfSight: () => true, capMs: 4000, runGoto: async () => true });
  assert.equal(ok, false);
});
