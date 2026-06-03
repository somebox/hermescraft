import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const lifecyclePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../lib/actions/lifecycle.js',
);

const helpersPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../lib/actions/_helpers.js',
);

test('deathpoint uses pathfindGotoNear (not move facade)', () => {
  const src = fs.readFileSync(lifecyclePath, 'utf8');
  const start = src.indexOf('async deathpoint');
  assert.ok(start >= 0);
  const block = src.slice(start, start + 1200);
  assert.match(block, /pathfindGotoNear/);
  assert.doesNotMatch(block, /navigateToTarget/);
  assert.match(block, /respawn_reach/);
  assert.match(block, /ACTION_CAPS_MS\.reach/);
});

// Phase 9 PR-C — goto_near wallclock cap bumped 8s → 15s.
// Run-5 evidence: goto_near 8000ms cap was the top error in 6 of 53
// Gatherer cycles including the final cycle before iteration_budget_exhausted.
test('ACTION_CAPS_MS.goto_near is 15000 (Phase 9 PR-C)', () => {
  const src = fs.readFileSync(helpersPath, 'utf8');
  const start = src.indexOf('ACTION_CAPS_MS');
  assert.ok(start >= 0);
  const block = src.slice(start, start + 400);
  assert.match(block, /goto_near:\s*15000/);
  assert.doesNotMatch(block, /goto_near:\s*8000/);
});
