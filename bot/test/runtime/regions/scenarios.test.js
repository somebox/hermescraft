import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from '../../../lib/runtime/regions/resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.join(__dirname, 'fixtures', 'scenarios.json');
const { scenarios } = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

function assertDecision(actual, expect, label) {
  assert.equal(actual.decision, expect.decision, `${label} decision`);
  assert.equal(actual.reason, expect.reason, `${label} reason`);
  const winId = actual.winning_region?.id ?? actual.winning_region ?? null;
  const expWin = expect.winning_region ?? null;
  assert.equal(winId, expWin, `${label} winning_region`);
  if (expect.matched_capability != null) {
    assert.equal(actual.matched_capability, expect.matched_capability, `${label} matched_capability`);
  }
  if (expect.resolved) {
    assert.deepEqual(actual.resolved, expect.resolved, `${label} resolved`);
  }
}

for (const scenario of scenarios) {
  test(`scenario: ${scenario.name}`, () => {
    for (const d of scenario.decisions) {
      const pos = d.position || { x: 0, y: 64, z: 0 };
      const actual = resolve(d.verb, d.args || {}, pos, d.block ?? null, scenario.regions);
      assertDecision(actual, d.expect, d.name || scenario.name);
    }
  });
}
