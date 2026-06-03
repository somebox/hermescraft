/**
 * Phase 8 Change A regression: mc mark surfaces a structured
 * `observed_state.warnings` entry when the note text references coords
 * but the caller didn't pass `--at`. Mark IS still saved (soft warning).
 *
 * Run-4 postmortem (2026-06-03) finding: 0 of ~12 explore-phase marks
 * used `--at` despite the SOUL bullet. Marks saved at bot standing
 * position with target coords only in note text — downstream `mc go_mark`
 * resolved to wrong cells, cascading into Pattern A nav failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../../lib/shared/action-contract.js';
import { createMarksActions } from '../../lib/actions/marks.js';

function makeDeps(saved) {
  return {
    ensureBot: () => ({
      entity: { position: { x: 0.5, y: 64.5, z: 0.5 } },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
    }),
    goals: { GoalNear: function GoalNear() {} },
    fmt: (n) => String(n),
    posObj: () => ({ x: 0, y: 64, z: 0 }),
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
  };
}

test('mark: note text with coords but no --at returns MARK_NO_AT_COORD_IN_NOTE warning', async () => {
  const saved = {};
  const { mark } = createMarksActions(makeDeps(saved));

  const r = await mark({
    name: 'lt_iron_se',
    note: 'iron vein face at (19,99,30)',
    // intentionally no `at`
  });

  // Mark still saved (soft warning, not fail)
  assert.equal(r.ok, true);
  assert.equal(validate(r).valid, true);
  assert.ok(saved.lt_iron_se);
  // Saved at bot position (0,64,0), NOT at the note coords
  assert.deepEqual(
    { x: saved.lt_iron_se.x, y: saved.lt_iron_se.y, z: saved.lt_iron_se.z },
    { x: 0, y: 64, z: 0 },
  );

  // Warning is in observed_state.warnings
  assert.ok(r.observed_state, 'expected observed_state on success');
  assert.ok(Array.isArray(r.observed_state.warnings), 'expected warnings array');
  assert.equal(r.observed_state.warnings.length, 1);
  const w = r.observed_state.warnings[0];
  assert.equal(w.code, 'MARK_NO_AT_COORD_IN_NOTE');
  assert.deepEqual(w.note_coords, { x: 19, y: 99, z: 30 });
  assert.deepEqual(w.saved_at, { x: 0, y: 64, z: 0 });
  assert.match(w.message, /--at 19 99 30/);
});

test('mark: passing --at suppresses the warning', async () => {
  const saved = {};
  const { mark } = createMarksActions(makeDeps(saved));

  const r = await mark({
    name: 'lt_iron_se',
    note: 'iron vein at (19,99,30)',
    at: { x: 19, y: 99, z: 30 },
  });

  assert.equal(r.ok, true);
  assert.deepEqual(
    { x: saved.lt_iron_se.x, y: saved.lt_iron_se.y, z: saved.lt_iron_se.z },
    { x: 19, y: 99, z: 30 },
  );
  assert.ok(!r.observed_state || !r.observed_state.warnings,
    'expected no warning when --at provided');
});

test('mark: note without coords does not warn', async () => {
  const saved = {};
  const { mark } = createMarksActions(makeDeps(saved));

  const r = await mark({
    name: 'fishing_spot',
    note: 'good fishing here near the cove',
  });

  assert.equal(r.ok, true);
  assert.ok(saved.fishing_spot);
  assert.ok(!r.observed_state || !r.observed_state.warnings,
    'expected no warning when note has no coord-shaped substring');
});

test('mark: negative coords in note text are detected', async () => {
  const saved = {};
  const { mark } = createMarksActions(makeDeps(saved));

  const r = await mark({
    name: 'lt_coal_nw',
    note: 'coal cluster at (-30,87,-5)',
  });

  assert.equal(r.ok, true);
  assert.ok(r.observed_state?.warnings?.length === 1);
  assert.deepEqual(
    r.observed_state.warnings[0].note_coords,
    { x: -30, y: 87, z: -5 },
  );
});

test('mark: space-separated coords (no commas) are detected', async () => {
  const saved = {};
  const { mark } = createMarksActions(makeDeps(saved));

  const r = await mark({
    name: 'lt_iron_ne',
    note: 'exposed face -22 47 -28',
  });

  assert.equal(r.ok, true);
  assert.ok(r.observed_state?.warnings?.length === 1);
  assert.deepEqual(
    r.observed_state.warnings[0].note_coords,
    { x: -22, y: 47, z: -28 },
  );
});

test('mark: two-number sequences do NOT trigger the warning (false-positive guard)', async () => {
  const saved = {};
  const { mark } = createMarksActions(makeDeps(saved));

  // "found 5 logs at chest" should not trigger — only one number
  const r1 = await mark({
    name: 'note1',
    note: 'found 5 oak logs in chest',
  });
  assert.equal(r1.ok, true);
  assert.ok(!r1.observed_state?.warnings, 'single number must not match');

  // "Y=64" alone is not a coord triple either
  const r2 = await mark({
    name: 'note2',
    note: 'platform at Y=64',
  });
  assert.equal(r2.ok, true);
  assert.ok(!r2.observed_state?.warnings, 'single-axis Y= must not match');
});

test('mark: at_mark suppresses warning (relocation via mark name)', async () => {
  const saved = {};
  const deps = makeDeps(saved);
  // Stub resolveMarkPlaceFromBody to return a placeholder when at_mark is provided
  deps.resolveMarkPlaceFromBody = (body) => {
    if (body.at_mark) return { x: 5, y: 64, z: 5 };
    if (body.at) return {
      x: Math.round(Number(body.at.x)),
      y: Math.round(Number(body.at.y)),
      z: Math.round(Number(body.at.z)),
    };
    return null;
  };
  const { mark } = createMarksActions(deps);

  const r = await mark({
    name: 'lt_iron_se',
    note: 'iron at (19,99,30)',
    at_mark: 'base_anchor',
  });

  assert.equal(r.ok, true);
  assert.ok(!r.observed_state?.warnings,
    'at_mark should be treated as explicit positioning, no warning');
});
