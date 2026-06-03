// Phase 9 PR-E — classifyTerrain hermetic tests.
//
// The classifier is a pure function over typed inputs; the bot fixture
// only matters for the wrapper in buildLandscapeContext (not tested here).
// SOUL trusts these labels — make sure the conservative defaults hold.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTerrain } from '../lib/shared/scene-landscape.js';

const FLAT_DELTAS = { N: 0, E: 0, S: 0, W: 0 };

test('flat: max |delta| ≤ 1 and feet at surface', () => {
  const out = classifyTerrain({
    deltas: FLAT_DELTAS,
    feetY: 64,
    surfaceY: 64,
    canopyDetected: false,
    feetBlockName: 'grass_block',
  });
  assert.equal(out.terrain_kind, 'flat');
  assert.equal(out.feet_vs_local_ground, 0);
});

test('depression_1: feet 1 below local surface', () => {
  const out = classifyTerrain({
    deltas: { N: 1, E: 1, S: 1, W: 1 },
    feetY: 63,
    surfaceY: 64,
    canopyDetected: false,
    feetBlockName: 'dirt',
  });
  assert.equal(out.terrain_kind, 'depression_1');
  assert.equal(out.feet_vs_local_ground, -1);
});

test('mound_1: feet 1 above natural local surface', () => {
  const out = classifyTerrain({
    deltas: { N: -1, E: -1, S: -1, W: -1 },
    feetY: 65,
    surfaceY: 64,
    canopyDetected: false,
    feetBlockName: 'grass_block',
  });
  assert.equal(out.terrain_kind, 'mound_1');
});

test('on_structure: feet above local AND feet block is placed material', () => {
  const out = classifyTerrain({
    deltas: { N: -4, E: -4, S: -4, W: -4 },
    feetY: 101,
    surfaceY: 97,
    canopyDetected: false,
    feetBlockName: 'cobblestone',
  });
  assert.equal(out.terrain_kind, 'on_structure');
  assert.equal(out.feet_vs_local_ground, 4);
});

test('on_structure also matches oak_planks (worker pad)', () => {
  const out = classifyTerrain({
    deltas: { N: -3, E: 0, S: 0, W: 0 },
    feetY: 101,
    surfaceY: 100,
    canopyDetected: false,
    feetBlockName: 'oak_planks',
  });
  assert.equal(out.terrain_kind, 'on_structure');
});

test('underground: ≥3 below surface AND no cardinal egress within 2', () => {
  const out = classifyTerrain({
    deltas: { N: 5, E: 6, S: 4, W: 5 },
    feetY: 84,
    surfaceY: 96,
    canopyDetected: false,
    feetBlockName: 'stone',
  });
  assert.equal(out.terrain_kind, 'underground');
  assert.equal(out.feet_vs_local_ground, -12);
});

test('underground guard: ≥3 below BUT cardinal egress nearby → not underground', () => {
  // Bot 4 below surface but a cardinal jumps back up 1 — there's a step
  // they can climb. Should NOT classify as underground (that would prescribe
  // pillar_up via PR-F SOUL when a step would do).
  const out = classifyTerrain({
    deltas: { N: 1, E: 5, S: 5, W: 5 },
    feetY: 92,
    surfaceY: 96,
    canopyDetected: false,
    feetBlockName: 'stone',
  });
  assert.notEqual(out.terrain_kind, 'underground');
});

test('slope_N: monotone north delta ≥ 2, opposite ≤ 1', () => {
  const out = classifyTerrain({
    deltas: { N: 4, E: 0, S: -1, W: 0 },
    feetY: 70,
    surfaceY: 70,
    canopyDetected: false,
    feetBlockName: 'grass_block',
  });
  assert.equal(out.terrain_kind, 'slope_N');
});

test('slope_S: monotone south delta ≥ 2, opposite ≤ 1', () => {
  const out = classifyTerrain({
    deltas: { N: 0, E: 0, S: 3, W: 0 },
    feetY: 70,
    surfaceY: 70,
    canopyDetected: false,
    feetBlockName: 'grass_block',
  });
  assert.equal(out.terrain_kind, 'slope_S');
});

test('cliff_above: one cardinal jumps ≥ 6 up, none drops', () => {
  // Deltas of 4-5 are slopes; ≥6 over a 16-block radius is a true wall.
  const out = classifyTerrain({
    deltas: { N: 7, E: 0, S: 0, W: 0 },
    feetY: 64,
    surfaceY: 64,
    canopyDetected: false,
    feetBlockName: 'grass_block',
  });
  assert.equal(out.terrain_kind, 'cliff_above');
});

test('cliff_below: one cardinal drops ≤ -6, none rises', () => {
  const out = classifyTerrain({
    deltas: { N: 0, E: 0, S: -7, W: 0 },
    feetY: 64,
    surfaceY: 64,
    canopyDetected: false,
    feetBlockName: 'grass_block',
  });
  assert.equal(out.terrain_kind, 'cliff_below');
});

test('slope vs cliff distinction: delta=4 is slope, delta=6 is cliff', () => {
  // The threshold band is the central case to lock down — a hill that
  // rises 4 blocks over 16m is a slope (walkable gradient); a sudden 6+
  // step is a cliff (pathfinder will refuse).
  const slope = classifyTerrain({
    deltas: { N: 4, E: 0, S: 0, W: 0 },
    feetY: 64,
    surfaceY: 64,
    canopyDetected: false,
    feetBlockName: 'grass_block',
  });
  assert.equal(slope.terrain_kind, 'slope_N');
  const cliff = classifyTerrain({
    deltas: { N: 6, E: 0, S: 0, W: 0 },
    feetY: 64,
    surfaceY: 64,
    canopyDetected: false,
    feetBlockName: 'grass_block',
  });
  assert.equal(cliff.terrain_kind, 'cliff_above');
});

test('canopy guard: canopyDetected → unknown (do not act on tree-as-surface)', () => {
  const out = classifyTerrain({
    deltas: FLAT_DELTAS,
    feetY: 64,
    surfaceY: 70,
    canopyDetected: true,
    feetBlockName: 'grass_block',
  });
  assert.equal(out.terrain_kind, 'unknown');
  // feet_vs_local_ground still computed (informational, just not load-bearing)
  assert.equal(out.feet_vs_local_ground, -6);
});

test('null surface → unknown, no feet_vs_local_ground', () => {
  const out = classifyTerrain({
    deltas: FLAT_DELTAS,
    feetY: 64,
    surfaceY: null,
    canopyDetected: false,
    feetBlockName: null,
  });
  assert.equal(out.terrain_kind, 'unknown');
  assert.equal(out.feet_vs_local_ground, null);
});

test('mound_1 not on_structure when feet block is natural', () => {
  // Standing on a natural dirt block one above local ground — that's a
  // small mound, not "on structure". on_structure requires a placed block.
  const out = classifyTerrain({
    deltas: { N: -1, E: -1, S: -1, W: -1 },
    feetY: 65,
    surfaceY: 64,
    canopyDetected: false,
    feetBlockName: 'dirt',
  });
  assert.equal(out.terrain_kind, 'mound_1');
});

// Run-5 regression cases — these are the actual poses Steward misread.

test('run-5 case: Gatherer at Y=105 atop her 1x1 pillar — should be on_structure', () => {
  // Gatherer pillared up to Y=105 on Steward's literal whisper, building a
  // dirt/cobble 1x1 column. Surrounding terrain was Y=96 (~9 below).
  // Should classify as on_structure, NOT underground or mound_1.
  const out = classifyTerrain({
    deltas: { N: -9, E: -9, S: -9, W: -9 },
    feetY: 105,
    surfaceY: 96,
    canopyDetected: false,
    feetBlockName: 'cobblestone',
  });
  assert.equal(out.terrain_kind, 'on_structure');
});

test('run-5 case: Mason at Y=92 self-sourcing — should be underground', () => {
  // Mason wasted 21 min mining cobble at Y=92 under spawn surface at Y=96.
  // No cardinal egress (all walls solid stone). Should classify underground
  // so PR-F can prescribe the correct response.
  const out = classifyTerrain({
    deltas: { N: 4, E: 4, S: 4, W: 4 },
    feetY: 92,
    surfaceY: 96,
    canopyDetected: false,
    feetBlockName: 'stone',
  });
  assert.equal(out.terrain_kind, 'underground');
});

test('run-5 case: Mason on pad at Y=101 — should be on_structure (not mound_1)', () => {
  // Mason placed cobble pad at Y=101 with local grass at Y=97. Standing on
  // her own cobble. Steward must NOT misread this as 'mound' or
  // 'underground' and whisper pillar_up.
  const out = classifyTerrain({
    deltas: { N: -4, E: -4, S: -4, W: -4 },
    feetY: 101,
    surfaceY: 97,
    canopyDetected: false,
    feetBlockName: 'cobblestone',
  });
  assert.equal(out.terrain_kind, 'on_structure');
});
