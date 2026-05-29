/**
 * Unit tests for the egress guard — protects a bot's own stair_down
 * staircase treads from being dug out by bulk ops / single dig.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  egressTreadCells,
  isEgressProtectedCell,
  clearEgressTrail,
  createEgressTracker,
} from '../../lib/runtime/egress-guard.js';

function trailCtx(overrides = {}) {
  return {
    runtime: {
      lastDugSteps: {
        steps: [
          { x: 0, y: 65, z: 0 },
          { x: 0, y: 64, z: -1 },
          { x: 0, y: 63, z: -2 },
        ],
        source: 'stair_down',
        ts: Date.now(),
        ...overrides,
      },
    },
  };
}

test('egressTreadCells: returns support cells one below each stand cell', () => {
  const eg = egressTreadCells(trailCtx());
  assert.ok(eg, 'expected an egress set');
  // tread support = (x, y-1, z) for each recorded stand cell
  assert.ok(isEgressProtectedCell(eg, 0, 64, 0));
  assert.ok(isEgressProtectedCell(eg, 0, 63, -1));
  assert.ok(isEgressProtectedCell(eg, 0, 62, -2));
  // the stand cells themselves (air) are NOT protected
  assert.equal(isEgressProtectedCell(eg, 0, 65, 0), false);
  assert.equal(isEgressProtectedCell(eg, 0, 64, -1), false);
});

test('egressTreadCells: null when no trail / too few steps / wrong source / stale', () => {
  assert.equal(egressTreadCells({ runtime: {} }), null);
  assert.equal(egressTreadCells(null), null);
  assert.equal(egressTreadCells(trailCtx({ steps: [{ x: 0, y: 65, z: 0 }] })), null);
  assert.equal(egressTreadCells(trailCtx({ source: 'nav_trail' })), null);
  // 31 minutes old → past the 30-min TTL
  assert.equal(egressTreadCells(trailCtx({ ts: Date.now() - 31 * 60 * 1000 })), null);
});

test('isEgressProtectedCell: null set is never protected', () => {
  assert.equal(isEgressProtectedCell(null, 0, 64, 0), false);
});

test('clearEgressTrail: nulls lastDugSteps and records reason', () => {
  const ctx = trailCtx();
  clearEgressTrail(ctx, 'unit-test');
  assert.equal(ctx.runtime.lastDugSteps, null);
  assert.equal(ctx.runtime.lastDugStepsClearedAt.reason, 'unit-test');
});

test('createEgressTracker: skips protected treads when not forced', () => {
  const ctx = trailCtx();
  const t = createEgressTracker(ctx, { force: false });
  assert.equal(t.active, true);
  assert.equal(t.shouldSkip(0, 64, 0), true, 'tread should be skipped');
  assert.equal(t.shouldSkip(5, 64, 5), false, 'non-tread should dig');
  assert.equal(t.skippedTotal(), 1);
  t.finalize();
  // not forced → trail preserved
  assert.ok(ctx.runtime.lastDugSteps, 'trail should remain after a skip-only run');
  assert.match(t.suffix(), /Preserved 1 staircase tread/);
  assert.deepEqual(t.dataFields(), { egress_protected: 1 });
});

test('createEgressTracker: force digs through treads and invalidates trail on finalize', () => {
  const ctx = trailCtx();
  const t = createEgressTracker(ctx, { force: true });
  assert.equal(t.shouldSkip(0, 64, 0), false, 'forced → dig the tread');
  assert.equal(t.breachedTotal(), 1);
  assert.equal(t.skippedTotal(), 0);
  t.finalize();
  assert.equal(ctx.runtime.lastDugSteps, null, 'forced breach should invalidate the trail');
  assert.match(t.suffix(), /Removed 1 staircase tread/);
  assert.deepEqual(t.dataFields(), { egress_removed: 1 });
});

test('createEgressTracker: ownsTrail=false defers trail invalidation to caller', () => {
  const ctx = trailCtx();
  const t = createEgressTracker(ctx, { force: true, ownsTrail: false });
  t.shouldSkip(0, 64, 0);
  t.finalize();
  assert.ok(ctx.runtime.lastDugSteps, 'sub-op must NOT clear the trail; the top-level op owns it');
});

test('createEgressTracker: inactive when no trail (everything digs)', () => {
  const t = createEgressTracker({ runtime: {} }, { force: false });
  assert.equal(t.active, false);
  assert.equal(t.shouldSkip(0, 64, 0), false);
  assert.equal(t.suffix(), '');
  assert.deepEqual(t.dataFields(), {});
});
