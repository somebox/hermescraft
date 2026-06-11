/**
 * K1 walk-classify kernel — fixture contracts + golden parity.
 *
 * The corpus annotations are construction facts (scripts/roadplan/fixtures.py);
 * the kernel must reproduce the run-kind sequence and the exact deficit list.
 * Parity: kernel surface-pick vs the level_ground dry-run goldens, with the
 * known oracle divergences ENUMERATED (overhang shelf-pick, tree trunks) —
 * a divergence outside that set is a kernel bug; one missing from it means
 * the kernel silently copied an oracle defect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeColumn, classifyLine, diffRuns } from '../../lib/shared/walk-classify.js';
import { getWalkabilitySpec } from '../../lib/shared/walkability-spec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'fixtures', 'terrain');
const GOLDEN_DIR = path.join(FIXTURE_DIR, 'goldens');

const spec = getWalkabilitySpec();

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}
function golden(name) {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, `${name}.golden.json`), 'utf8'));
}
const FIXTURE_NAMES = fs.readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));

test('classifyLine reproduces every fixture annotation (kinds, deficits, verdict)', () => {
  for (const name of FIXTURE_NAMES) {
    const fx = fixture(name);
    const out = classifyLine(fx, spec);
    const ann = fx.annotations;
    assert.deepEqual(out.runs.map((r) => r.kind), ann.expected_run_kinds,
      `${name}: run kind sequence`);
    assert.deepEqual(out.deficits, ann.deficits, `${name}: deficits`);
    assert.equal(out.walkable, ann.walkable, `${name}: walkable verdict`);
    if (ann.max_runs) {
      assert.ok(out.runs.length <= ann.max_runs,
        `${name}: hysteresis budget — ${out.runs.length} runs > ${ann.max_runs}`);
    }
  }
});

test('runs tile the line exactly (no gaps, no overlap)', () => {
  for (const name of FIXTURE_NAMES) {
    const fx = fixture(name);
    const out = classifyLine(fx, spec);
    const total = out.runs.reduce((n, r) => n + r.length, 0);
    assert.equal(total, out.steps.length, name);
    assert.deepEqual(out.runs[0].from, fx.line.from, name);
    assert.deepEqual(out.runs[out.runs.length - 1].to, fx.line.to, name);
  }
});

// Cells where the shipped oracle (level_ground top-solid survey) is KNOWN to
// disagree with walkable-surface semantics. §6.5: divergences are enumerated,
// never silent.
const ORACLE_DIVERGENCES = {
  overhang: (c) => (c.z >= 8 && c.z <= 15) || (c.z >= 18 && c.z <= 20),  // picks the shelf top
  forest: (c) => [[0, 10], [1, 15], [-1, 21]]        // picks the trunk top
    .some(([x, z]) => c.x === x && c.z === z),
};

test('golden parity: kernel surface-pick matches the oracle except enumerated divergences', () => {
  for (const name of FIXTURE_NAMES) {
    const fx = fixture(name);
    const g = golden(name);
    const ref = fx.line.y_hint + 1;
    const goldenTop = new Map(g.columns.map((c) => [`${c.x},${c.z}`, c.top_block_y]));
    const isDivergent = ORACLE_DIVERGENCES[name] || (() => false);
    for (const col of fx.columns) {
      const { surface } = analyzeColumn(col.blocks, ref, spec);
      assert.ok(surface, `${name} (${col.x},${col.z}): kernel found no surface`);
      const oracle = goldenTop.get(`${col.x},${col.z}`);
      if (isDivergent(col)) {
        assert.notEqual(surface.block_y, oracle,
          `${name} (${col.x},${col.z}): enumerated divergence vanished — ` +
          'either the oracle was fixed (shrink the list) or the kernel copied its defect');
      } else {
        assert.equal(surface.block_y, oracle,
          `${name} (${col.x},${col.z}): kernel surface ${surface.block_y} != oracle ${oracle}`);
      }
    }
  }
});

test('surface-pick prefers the floor nearest the walk elevation, not the top solid', () => {
  // Ground at 64 with a shelf at 68/69: ref near the ground picks the ground;
  // ref near the shelf picks the shelf (both are legitimate walking layers).
  const blocks = [[63, 'dirt'], [64, 'grass_block'], [68, 'stone'], [69, 'stone']];
  assert.equal(analyzeColumn(blocks, 65, spec).surface.block_y, 64);
  assert.equal(analyzeColumn(blocks, 70, spec).surface.block_y, 69);
});

test('diffRuns: bridging the river resolves the water deficit and reports the delta', () => {
  const fx = fixture('river');
  const before = classifyLine(fx, spec);
  const bridged = {
    ...fx,
    columns: fx.columns.map((c) => {
      const hasWater = c.blocks.some(([, b]) => b === 'water');
      return hasWater ? { ...c, blocks: [...c.blocks, [64, 'oak_planks']] } : c;
    }),
  };
  const after = classifyLine(bridged, spec);
  assert.equal(after.walkable, true, 'bridged river must be to spec');
  assert.deepEqual(after.runs.map((r) => r.kind), ['walk']);

  const diff = diffRuns(before, after);
  assert.equal(diff.to_spec, true);
  assert.equal(diff.added.length, 0);
  assert.deepEqual(diff.resolved, before.deficits, 'water deficit resolved');
  assert.deepEqual(diff.changed, [
    { from: [0, 14], to: [0, 17], length: 4, before: 'water', after: 'walk' },
  ]);
});

test('diffRuns: identical surveys produce an empty delta', () => {
  const fx = fixture('ridge');
  const a = classifyLine(fx, spec);
  const b = classifyLine(fx, spec);
  const diff = diffRuns(a, b);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.resolved, []);
  assert.deepEqual(diff.added, []);
});
