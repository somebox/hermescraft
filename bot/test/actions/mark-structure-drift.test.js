/**
 * Phase 9 PR-D: mc mark surfaces a `MARK_COORD_VS_CARD_DRIFT` warning
 * when a STRUCTURE-prefixed mark (`base_*`, `pad_*`, `wall_*`, `roof_*`,
 * `chest_*`, `foundation_*`) is saved more than 3 blocks from the active
 * card body's target coord.
 *
 * Run-5 evidence (2026-06-03): Mason placed `base_foundation` while the
 * card target was the pad center; Steward caught a 38-block drift 22 min
 * later via manual review. This warning closes that detection latency to
 * per-mark.
 *
 * Card-body coord comes from `$HERMES_HOME/task-body-coord.json`, written
 * by `scripts/wb stash-coord` on card claim. The marks action reads it
 * each call; missing file → no warning, no error (drift check is
 * best-effort, never blocks a mark).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../../lib/shared/action-contract.js';
import { createMarksActions, readCardBodyCoord } from '../../lib/actions/marks.js';

function makeDeps(saved, opts = {}) {
  return {
    ensureBot: () => ({
      entity: { position: { x: opts.feetX ?? 0.5, y: opts.feetY ?? 64.5, z: opts.feetZ ?? 0.5 } },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
    }),
    goals: { GoalNear: function GoalNear() {} },
    fmt: (n) => String(n),
    posObj: () => ({ x: opts.feetX ?? 0, y: opts.feetY ?? 64, z: opts.feetZ ?? 0 }),
    sleep: async () => {},
    log: () => {},
    loadLocations: () => ({}),
    saveLocations: (locs) => {
      Object.keys(saved).forEach((k) => delete saved[k]);
      Object.assign(saved, locs);
    },
    flagMarkStale: () => {},
    clearMarkStale: () => {},
    resolveMarkPlaceFromBody: (body) => {
      if (body.at && typeof body.at === 'object') {
        return {
          x: Math.round(Number(body.at.x)),
          y: Math.round(Number(body.at.y)),
          z: Math.round(Number(body.at.z)),
        };
      }
      return null;
    },
    resolveContainerCoords: () => ({ ix: 0, iy: 64, iz: 0 }),
    normalizeDepositWithdrawItems: (b) => b,
    buildMarksListApi: () => [],
    isContainerBlock: () => false,
    findNearbyContainer: () => null,
    snapshotChestAtPosition: () => ({}),
    rememberSocialEvent: () => {},
    saveReminders: () => {},
    getMyName: () => 'testbot',
    services: {},
    config: {},
    ctx: { runtime: { navBriefNegativeLegs: {} } },
    // Inject the card-body coord reader via deps for hermetic testability.
    readCardBodyCoord: opts.readCardBodyCoord ?? (() => null),
  };
}

test('mark: structure-prefixed mark > 3 blocks from card coord fires MARK_COORD_VS_CARD_DRIFT', async () => {
  const saved = {};
  // Mason on pad at (15.5, 92.5, 52.5) attempting to mark base_foundation,
  // but card body says pad is at center (19, 101, 52). Distance ~9 blocks.
  const { mark } = createMarksActions(makeDeps(saved, {
    feetX: 15.5, feetY: 92.5, feetZ: 52.5,
    readCardBodyCoord: () => ({ x: 19, y: 101, z: 52 }),
  }));

  const r = await mark({ name: 'base_foundation', note: 'pad center' });
  assert.equal(r.ok, true);
  assert.equal(validate(r).valid, true);
  assert.ok(saved.base_foundation, 'mark must still be saved (soft warning)');
  const warnings = r.observed_state?.warnings || [];
  const drift = warnings.find((w) => w.code === 'MARK_COORD_VS_CARD_DRIFT');
  assert.ok(drift, `expected MARK_COORD_VS_CARD_DRIFT; got ${JSON.stringify(warnings)}`);
  assert.equal(drift.mark_name, 'base_foundation');
  assert.deepEqual(drift.card_coord, { x: 19, y: 101, z: 52 });
  assert.ok(drift.distance > 3);
});

test('mark: structure mark within 3 blocks of card coord — no drift warning', async () => {
  const saved = {};
  // Mason on pad at (20.5, 101.5, 52.5). Card target (19, 101, 52). Distance ~1.6 blocks.
  const { mark } = createMarksActions(makeDeps(saved, {
    feetX: 20.5, feetY: 101.5, feetZ: 52.5,
    readCardBodyCoord: () => ({ x: 19, y: 101, z: 52 }),
  }));

  const r = await mark({ name: 'base_foundation', note: 'pad center' });
  assert.equal(r.ok, true);
  const warnings = r.observed_state?.warnings || [];
  const drift = warnings.find((w) => w.code === 'MARK_COORD_VS_CARD_DRIFT');
  assert.equal(drift, undefined, 'within 3 blocks should not warn');
});

test('mark: non-structure prefix (lt_iron) does NOT fire drift warning even when far', async () => {
  const saved = {};
  // Resource mark — workers intentionally save these at vantage points
  // far from the resource cell (run-5 pattern: lt_iron_se saved at the
  // SE plateau, not the ore). This must NOT false-positive.
  const { mark } = createMarksActions(makeDeps(saved, {
    feetX: 100.5, feetY: 80.5, feetZ: 100.5,
    readCardBodyCoord: () => ({ x: 19, y: 101, z: 52 }),
  }));

  const r = await mark({ name: 'lt_iron_se', note: 'iron ore ~12 blocks' });
  assert.equal(r.ok, true);
  const warnings = r.observed_state?.warnings || [];
  const drift = warnings.find((w) => w.code === 'MARK_COORD_VS_CARD_DRIFT');
  assert.equal(drift, undefined, 'lt_* prefix is not a structure mark — no drift check');
});

test('mark: no stash file present → no drift warning, no error', async () => {
  const saved = {};
  // wb stash-coord has not been called (worker forgot, or card has no
  // extractable coord). Drift check is best-effort; mark must still save.
  const { mark } = createMarksActions(makeDeps(saved, {
    feetX: 100.5, feetY: 80.5, feetZ: 100.5,
    readCardBodyCoord: () => null,
  }));

  const r = await mark({ name: 'base_foundation', note: 'no card stash available' });
  assert.equal(r.ok, true);
  assert.ok(saved.base_foundation);
  const warnings = r.observed_state?.warnings || [];
  assert.equal(warnings.find((w) => w.code === 'MARK_COORD_VS_CARD_DRIFT'), undefined);
});

test('mark: drift warning + Phase 8.A coord-in-note warning coexist', async () => {
  const saved = {};
  // Both detectors fire: note has (X,Y,Z) triple AND structure mark drifts.
  const { mark } = createMarksActions(makeDeps(saved, {
    feetX: 0.5, feetY: 64.5, feetZ: 0.5,
    readCardBodyCoord: () => ({ x: 50, y: 64, z: 50 }),
  }));

  const r = await mark({
    name: 'pad_anchor',
    note: 'should be at (50,64,50)', // triggers 8.A
    // bot stands at (0,64,0); card says (50,64,50); distance ~70 blocks
  });
  assert.equal(r.ok, true);
  const warnings = r.observed_state?.warnings || [];
  assert.ok(warnings.find((w) => w.code === 'MARK_NO_AT_COORD_IN_NOTE'), 'Phase 8.A should fire');
  assert.ok(warnings.find((w) => w.code === 'MARK_COORD_VS_CARD_DRIFT'), 'Phase 9 PR-D should fire');
});

test('readCardBodyCoord: reads valid JSON from $HERMES_HOME/task-body-coord.json', () => {
  const tmpFiles = {};
  const stub = {
    env: { HERMES_HOME: '/tmp/fakehome' },
    readFile: (p) => {
      if (p === '/tmp/fakehome/task-body-coord.json') {
        return JSON.stringify({ task_id: 't_x', coord: { x: 10, y: 64, z: 20 } });
      }
      throw new Error('ENOENT');
    },
  };
  const c = readCardBodyCoord(stub);
  assert.deepEqual(c, { x: 10, y: 64, z: 20 });
});

test('readCardBodyCoord: missing HERMES_HOME → null', () => {
  const c = readCardBodyCoord({ env: {}, readFile: () => 'never called' });
  assert.equal(c, null);
});

test('readCardBodyCoord: malformed JSON → null (no throw)', () => {
  const stub = {
    env: { HERMES_HOME: '/tmp/fakehome' },
    readFile: () => '{not valid json',
  };
  const c = readCardBodyCoord(stub);
  assert.equal(c, null);
});

test('readCardBodyCoord: missing coord field → null', () => {
  const stub = {
    env: { HERMES_HOME: '/tmp/fakehome' },
    readFile: () => JSON.stringify({ task_id: 't_x' }),
  };
  const c = readCardBodyCoord(stub);
  assert.equal(c, null);
});
