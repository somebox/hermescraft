import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWalkabilitySpec } from '../../lib/shared/walkability-spec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('walkability spec loads with all required numeric keys', () => {
  const spec = getWalkabilitySpec();
  for (const key of [
    'max_step_up', 'max_unguarded_drop', 'clearance_height', 'path_width',
    'shoulder_width', 'fill_shallow_max_depth', 'no_floor_min_depth',
    'max_bridge', 'torch_spacing_max',
  ]) {
    assert.ok(Number.isFinite(spec[key]), `spec.${key} must be numeric`);
  }
  assert.ok(Array.isArray(spec.forbidden_floor) && spec.forbidden_floor.length > 0);
});

test('spec invariants hold (relationships the classifiers rely on)', () => {
  const spec = getWalkabilitySpec();
  assert.ok(spec.fill_shallow_max_depth < spec.no_floor_min_depth,
    'shallow-fill threshold must be below the no-floor threshold');
  assert.ok(spec.max_bridge <= spec.no_floor_min_depth,
    'bridge-fill must not claim to span no_floor-class holes');
  assert.ok(spec.max_step_up >= 1, 'players can always step 1 block');
  assert.ok(spec.path_width >= 1 && spec.clearance_height >= 2);
});

test('spec-literal audit: migrated thresholds are not re-declared inline', () => {
  // The single-source contract (docs/planning/adaptive-road-planning.md §4):
  // once a constant moves into walkability-spec.json, an inline re-declaration
  // anywhere in bot/lib is a fork waiting to drift.
  const offenders = [];
  const patterns = [
    /\bMAX_BRIDGE\s*=\s*\d/,
    /\bFILL_SHALLOW_MAX_DEPTH\s*=\s*\d/,
    /\bNO_FLOOR_MIN_DEPTH\s*=\s*\d/,
  ];
  const libDir = path.join(REPO_ROOT, 'bot', 'lib');
  const stack = [libDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const re of patterns) {
        if (re.test(src)) offenders.push(`${path.relative(REPO_ROOT, p)}: ${re}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `inline spec literals found:\n${offenders.join('\n')}`);
});

test('terrain.js consumes the spec loader', () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'bot', 'lib', 'actions', 'building', 'terrain.js'), 'utf8');
  assert.match(src, /getWalkabilitySpec/);
});
