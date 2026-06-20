/**
 * mc survey_line — adaptive-road-planning §7.2 contract.
 *
 * The verb wraps K1 walk-classify with a bot column scan. We mock blockAt
 * from the committed fixture JSONs so each fixture terrain class becomes
 * a profile test — same source the K1 kernel parity goldens use, but
 * exercising the live verb's column-scan + envelope shape + chunk-
 * unloaded handling + --diff path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyFromBot,
  createSurveyLineQueries,
  scanColumn,
} from '../../lib/actions/queries/survey-line.js';
import { getWalkabilitySpec } from '../../lib/shared/walkability-spec.js';
import { assertContract, assertFailure } from '../_helpers/action-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'fixtures', 'terrain');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

function botFromFixture(fx, { unloaded = new Set() } = {}) {
  const byCol = new Map(fx.columns.map((c) => [`${c.x},${c.z}`, new Map(c.blocks)]));
  return {
    username: 'tester',
    entity: { position: { x: fx.line.from[0], y: fx.line.y_hint + 1, z: fx.line.from[1] } },
    blockAt: (vec) => {
      const key = `${vec.x},${vec.z}`;
      if (unloaded.has(key)) return null;
      const col = byCol.get(key);
      if (!col) {
        // Outside the fixture strip: treat as fully loaded air column so the
        // classifier sees a clean (empty) shoulder cell rather than crashing.
        return { name: 'air', position: vec };
      }
      const name = col.get(vec.y);
      return name ? { name, position: vec } : { name: 'air', position: vec };
    },
  };
}

const SPEC = getWalkabilitySpec();

function runFromBot(fx, extraBody = {}) {
  const bot = botFromFixture(fx);
  const body = { x1: fx.line.from[0], z1: fx.line.from[1],
                 x2: fx.line.to[0],   z2: fx.line.to[1],
                 y_hint: fx.line.y_hint, ...extraBody };
  return classifyFromBot(bot, body, SPEC);
}

test('scanColumn produces the K1 [[y,name], ...] shape and skips air', () => {
  const fx = fixture('river');
  const bot = botFromFixture(fx);
  const ref = fx.line.y_hint + 1;
  const { blocks, anyLoaded } = scanColumn(bot, 0, 14,
    { yLo: ref - 20, yHi: ref + 16 });
  assert.equal(anyLoaded, true);
  // The river fixture stacks water at y=61..63 over a dirt floor at y=60.
  // No air entries — scanColumn only records solids/fluids.
  const tags = blocks.map(([, n]) => n);
  assert.ok(tags.includes('dirt'));
  assert.ok(tags.includes('water'));
  assert.equal(tags.filter((t) => t === 'air').length, 0);
});

test('classifyFromBot reproduces fixture annotations on every terrain class', () => {
  const failures = [];
  for (const name of ['flat', 'ridge', 'river', 'ravine', 'forest',
                       'cliff', 'dither', 'overhang', 'slab_stairs']) {
    const fx = fixture(name);
    const out = runFromBot(fx);
    if (!out.ok) {
      failures.push(`${name}: ${out.code} ${out.message}`);
      continue;
    }
    const r = out.result;
    const ann = fx.annotations;
    const gotKinds = r.runs.map((rr) => rr.kind);
    if (JSON.stringify(gotKinds) !== JSON.stringify(ann.expected_run_kinds)) {
      failures.push(`${name}: run kinds ${gotKinds} != ${ann.expected_run_kinds}`);
    }
    if (r.walkable !== ann.walkable) {
      failures.push(`${name}: walkable ${r.walkable} != ${ann.walkable}`);
    }
    try {
      assert.deepEqual(r.deficits, ann.deficits, `${name}: deficits`);
    } catch (e) {
      failures.push(`${name}: deficits mismatch — ${e.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('classifyFromBot rejects lines longer than the 96-cell cap', () => {
  // Synthesize a 97-cell line; column data doesn't matter — the cap check
  // runs before the scan.
  const fx = {
    line: { from: [0, 0], to: [0, 96], y_hint: 64 },
    columns: [],
    annotations: { walkable: true, deficits: [], expected_run_kinds: ['walk'] },
  };
  const bot = botFromFixture(fx);
  const out = classifyFromBot(bot,
    { x1: 0, z1: 0, x2: 0, z2: 96, y_hint: 64 }, SPEC);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'OUT_OF_RANGE');
  assert.match(out.message, /96.*cap/);
});

test('classifyFromBot returns UNLOADED_CHUNKS with a move hint mid-line', () => {
  const fx = fixture('flat');
  // Unload columns z=10..15 at every x in the strip.
  const unloaded = new Set();
  for (let z = 10; z <= 15; z++) {
    for (let x = -3; x <= 3; x++) unloaded.add(`${x},${z}`);
  }
  const bot = botFromFixture(fx, { unloaded });
  const out = classifyFromBot(bot,
    { x1: fx.line.from[0], z1: fx.line.from[1],
      x2: fx.line.to[0], z2: fx.line.to[1],
      y_hint: fx.line.y_hint }, SPEC);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'UNLOADED_CHUNKS');
  assert.match(out.message, /move closer/i);
});

test('handler envelope carries roadplan-survey/v1 schema and fix commands', async (t) => {
  const fx = fixture('river');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-line-test-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const bot = botFromFixture(fx);
  const actions = createSurveyLineQueries({ ensureBot: () => bot, repoRoot });
  const r = await actions.survey_line({
    x1: fx.line.from[0], z1: fx.line.from[1],
    x2: fx.line.to[0],   z2: fx.line.to[1],
    y_hint: fx.line.y_hint,
  });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.envelope_schema, 'roadplan-survey/v1');
  assert.equal(r.data.walkable, false);
  assert.ok(r.data.runs.some((run) => run.kind === 'water'));
  assert.ok(r.data.fix_commands.length > 0);
  assert.match(r.data.fix_commands.find((c) => c.startsWith('mc level')) || '', /<deck-y>/);
});

test('tree deficits emit the registry fell_tree form (X Z y_hint=Y), not X base_y Z', async (t) => {
  const fx = fixture('forest');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-forest-test-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const bot = botFromFixture(fx);
  const actions = createSurveyLineQueries({ ensureBot: () => bot, repoRoot });
  const r = await actions.survey_line({
    x1: fx.line.from[0], z1: fx.line.from[1],
    x2: fx.line.to[0],   z2: fx.line.to[1],
    y_hint: fx.line.y_hint,
  });
  assertContract(r);
  const fell = (r.data.fix_commands || []).find((c) => c.startsWith('mc fell_tree'));
  assert.ok(fell, 'expected a fell_tree fix command from a forested line');
  // Correct: `mc fell_tree X Z y_hint=Y`. The old bug emitted `X base_y Z`.
  assert.match(fell, /^mc fell_tree -?\d+ -?\d+ y_hint=-?\d+$/);
});

test('--diff against the prior survey reports a bridged-water resolution', async (t) => {
  const fx = fixture('river');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-diff-test-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  // First pass: river not bridged.
  let bot = botFromFixture(fx);
  const actions1 = createSurveyLineQueries({ ensureBot: () => bot, repoRoot });
  await actions1.survey_line({
    x1: fx.line.from[0], z1: fx.line.from[1],
    x2: fx.line.to[0],   z2: fx.line.to[1],
    y_hint: fx.line.y_hint,
  });

  // Second pass: deck the river over with oak_planks at y=63.
  const bridged = {
    ...fx,
    columns: fx.columns.map((c) => {
      const hasWater = c.blocks.some(([, b]) => b === 'water');
      return hasWater
        ? { ...c, blocks: [[60, 'dirt'], [63, 'oak_planks']] }
        : c;
    }),
  };
  bot = botFromFixture(bridged);
  const actions2 = createSurveyLineQueries({ ensureBot: () => bot, repoRoot });
  const r = await actions2.survey_line({
    x1: fx.line.from[0], z1: fx.line.from[1],
    x2: fx.line.to[0],   z2: fx.line.to[1],
    y_hint: fx.line.y_hint,
    diff: true,
  });
  assert.equal(r.ok, true);
  assert.ok(r.data.diff, 'diff payload missing');
  assert.equal(r.data.diff.to_spec, true);
  assert.ok(r.data.diff.resolved.length > 0);
  assert.match(r.result, /to spec/i);
});

test('invalid coordinates → INVALID_COORD loud fail (no scan attempted)', () => {
  const fx = fixture('flat');
  const bot = botFromFixture(fx);
  let scanCalls = 0;
  bot.blockAt = (vec) => { scanCalls++; return { name: 'air', position: vec }; };
  const out = classifyFromBot(bot,
    { x1: 'oops', z1: 0, x2: 0, z2: 31, y_hint: 63 }, SPEC);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_COORD');
  assert.equal(scanCalls, 0);
});
