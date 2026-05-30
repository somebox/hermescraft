import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const lifecyclePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../lib/actions/lifecycle.js',
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
