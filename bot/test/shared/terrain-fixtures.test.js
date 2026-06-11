import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'fixtures', 'terrain');

const ROUTE_CLASSES = new Set(['natural', 'stairs', 'bridge', 'clearing']);
const RUN_KINDS = new Set(['walk', 'climb', 'descend', 'water', 'gap', 'trees', 'clearance']);

function loadAll() {
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => ({
    file: f,
    fixture: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')),
  }));
}

test('terrain fixture corpus is present and complete', () => {
  const names = loadAll().map(({ fixture }) => fixture.name).sort();
  assert.deepEqual(names, [
    'cliff', 'dither', 'flat', 'forest', 'overhang',
    'ravine', 'ridge', 'river', 'slab_stairs',
  ]);
});

test('every fixture conforms to terrain-fixture/v1', () => {
  for (const { file, fixture } of loadAll()) {
    assert.equal(fixture.schema, 'terrain-fixture/v1', file);
    assert.equal(`${fixture.name}.json`, file, 'name must match filename');
    assert.ok(Array.isArray(fixture.columns) && fixture.columns.length > 0, file);
    for (const col of fixture.columns) {
      assert.ok(Number.isInteger(col.x) && Number.isInteger(col.z), file);
      assert.ok(Array.isArray(col.blocks) && col.blocks.length > 0, file);
      let prevY = -Infinity;
      for (const [y, block] of col.blocks) {
        assert.ok(Number.isInteger(y) && y > prevY, `${file}: blocks must be y-ascending`);
        assert.equal(typeof block, 'string', file);
        prevY = y;
      }
    }
    const ann = fixture.annotations;
    assert.ok(ROUTE_CLASSES.has(ann.expected_route_class), file);
    assert.ok(ann.expected_run_kinds.every((k) => RUN_KINDS.has(k)), file);
    assert.ok(Array.isArray(ann.deficits), file);
    assert.equal(ann.walkable, ann.deficits.length === 0, file);
  }
});

test('line endpoints have columns in the corpus', () => {
  for (const { file, fixture } of loadAll()) {
    const cells = new Set(fixture.columns.map((c) => `${c.x},${c.z}`));
    const [fx, fz] = fixture.line.from;
    const [tx, tz] = fixture.line.to;
    assert.ok(cells.has(`${fx},${fz}`), `${file}: line.from column missing`);
    assert.ok(cells.has(`${tx},${tz}`), `${file}: line.to column missing`);
  }
});
