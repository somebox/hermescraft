/**
 * Walkability spec loader — single source of truth for path/road thresholds.
 *
 * data/walkability-spec.json is shared with the Python planning toolchain
 * (scripts/roadplan). Do not re-declare these thresholds inline; the
 * spec-literal audit test (bot/test/shared/walkability-spec.test.js) fails
 * the build if migrated constants reappear as literals.
 *
 * See docs/planning/adaptive-road-planning.md §4 for the spec contract and
 * the alignment table (spec key ↔ JS consumer ↔ skill doctrine).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// bot/lib/shared → bot/lib → bot → repo root → data/
const SPEC_PATH = path.resolve(__dirname, '..', '..', '..', 'data', 'walkability-spec.json');

const REQUIRED_NUMERIC = [
  'max_step_up',
  'max_unguarded_drop',
  'clearance_height',
  'path_width',
  'shoulder_width',
  'fill_shallow_max_depth',
  'no_floor_min_depth',
  'max_bridge',
  'torch_spacing_max',
];

/** @type {Record<string, any> | null} */
let SPEC = null;

function validate(data) {
  if (typeof data !== 'object' || !data) {
    throw new Error('walkability-spec.json: top-level must be an object');
  }
  for (const key of REQUIRED_NUMERIC) {
    if (!Number.isFinite(data[key])) {
      throw new Error(`walkability-spec.json: missing or non-numeric "${key}"`);
    }
  }
  if (!Array.isArray(data.forbidden_floor) || data.forbidden_floor.some((b) => typeof b !== 'string')) {
    throw new Error('walkability-spec.json: "forbidden_floor" must be an array of block names');
  }
  return data;
}

export function getWalkabilitySpec() {
  if (!SPEC) {
    SPEC = validate(JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')));
  }
  return SPEC;
}

/** Force a fresh re-read. For tests that point at a temp spec file. */
export function reloadWalkabilitySpec(overridePath) {
  const p = overridePath || SPEC_PATH;
  SPEC = validate(JSON.parse(fs.readFileSync(p, 'utf8')));
  return SPEC;
}
