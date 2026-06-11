import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  GOLDEN_DIR, captureAll, loadFixtures,
} from '../../scripts/capture-terrain-goldens.js';

function loadCommitted() {
  const goldens = {};
  for (const f of fs.readdirSync(GOLDEN_DIR).filter((n) => n.endsWith('.golden.json'))) {
    const g = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), 'utf8'));
    goldens[g.fixture] = g;
  }
  return goldens;
}

test('committed goldens match a fresh level_ground dry-run capture (drift guard)', async () => {
  const fresh = await captureAll();
  const committed = loadCommitted();
  assert.deepEqual(Object.keys(committed).sort(), Object.keys(fresh).sort(),
    'golden set must cover exactly the fixture corpus (run node bot/scripts/capture-terrain-goldens.js)');
  for (const [name, golden] of Object.entries(fresh)) {
    assert.deepEqual(committed[name], golden,
      `${name}.golden.json drifted from the oracle (run node bot/scripts/capture-terrain-goldens.js)`);
  }
});

test('goldens cover every fixture column with a disposition', async () => {
  const committed = loadCommitted();
  for (const fixture of loadFixtures()) {
    const golden = committed[fixture.name];
    assert.ok(golden, `missing golden for ${fixture.name}`);
    assert.equal(golden.schema, 'terrain-golden/v1');
    assert.equal(golden.columns.length, fixture.columns.length, fixture.name);
    for (const c of golden.columns) {
      assert.ok(['fill', 'dig', 'level', 'preserve', 'unknown'].includes(c.action),
        `${fixture.name} (${c.x},${c.z}): bad action ${c.action}`);
    }
  }
});

test('oracle facts the kernels rely on', async () => {
  const committed = loadCommitted();
  const center = (name) => committed[name].columns.filter((c) => c.x === 0);

  assert.ok(center('flat').every((c) => c.action === 'level'));
  assert.ok(center('ravine').some((c) => c.fill_kind === 'no_floor'),
    'ravine must classify as no_floor — bridge edge, never a free fill');
  const riverFills = center('river').filter((c) => c.action === 'fill');
  assert.ok(riverFills.length > 0 && riverFills.every((c) => c.fill_kind === 'shallow'),
    'river floor reads as shallow fill (water is skipped by the survey)');
  // Known oracle divergence K1 must NOT copy: top-solid picks the shelf,
  // not the walkable ground under it (adaptive-road-planning §8.0.2 K1).
  assert.ok(center('overhang').filter((c) => c.z >= 8 && c.z <= 15)
    .every((c) => c.top_block_y === 69 && c.action === 'dig'));
});
