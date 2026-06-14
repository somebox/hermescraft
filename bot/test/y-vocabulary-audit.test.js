/**
 * Y-vocabulary drift guard.
 *
 * After the surface_y migration unified every Y-taking primitive on
 * `parseYInput` (y= legacy, surface_y= canonical feet), this test prevents
 * a future command from quietly inventing its own Y dialect or skipping
 * the input-table row that tells agents how to call it.
 *
 * Enforced today:
 *   1. Every command with a Y-named arg in argSchema is mentioned by name
 *      (or alias) in docs/reference/world-coordinates.md `### Inputs`, or
 *      explicitly exempted with a reason.
 *   2. `clear_strip` and `deck` are pinned in the doc table (regression
 *      guard for the migration that motivated this test).
 *   3. Every command listed in the doc input table resolves to a registered
 *      command name or alias (catches doc rot).
 *   4. The exemption list stays honest — no exempt command can also appear
 *      in the doc table.
 *
 * Enumeration: a command is Y-bearing if (a) its argSchema has a Y-named
 * key, or (b) its `usage` string advertises a Y token. The usage scan
 * catches customParse commands that have no argSchema Y key (e.g. `fence`,
 * `safe_dig`, `reach`, `through`, `inspect`, the `--at X Y Z` annotation
 * verbs) — these were previously invisible to an argSchema-only scan.
 *
 * Residual limitation: a command that reads a Y internally but advertises
 * it in neither argSchema NOR usage stays invisible. None exist today; a
 * future one could be caught by scanning handler source or requiring a
 * `yParams` hint. This is the only remaining hole.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RAW_COMMAND_DEFS, buildAliasMap } from '../cli/registry.mjs';

const DOC_PATH = new URL('../../docs/reference/world-coordinates.md', import.meta.url);

// Y-named keys we recognize directly off an argSchema entry.
const Y_KEY_RE = /^(y|y1|y2|surface_y|surface_y1|surface_y2|top_y)$/;

// Commands whose Y argument has a non-obvious name (i.e. wouldn't match
// Y_KEY_RE). The value is the argSchema key. Keep this small — most
// primitives use plain `y` / `surface_y`.
const EXTRA_Y_PARAMS = {
  level_ground: 'target',
};

// Commands with a Y arg that deliberately have no doc row. Every entry
// MUST carry a one-line reason explaining why the row would be misleading
// — that's what keeps the exemption list from accumulating cruft.
const EXEMPT = {
  look_at: 'y is a gaze-target point coordinate (camera aim), not a stand/dig/place Y — no block/surface ambiguity',
  region_create: '`--y MIN..MAX` is a vertical *range* (region extent), not a point/stand/dig Y — documented in docs/specs/world/designated-regions.md',
  bot: '`--near X,Y,Z` is an absolute-position distance hint for lease checkout (nearest free body), not a world-edit Y — no surface/block semantics; see docs/architecture/bot-lease.md',
};

// Y tokens in a usage string: positional Y / GY / DY / Y1 / Y2 (uppercase
// placeholders), the surface_y keyword, the y_hint hint, and the `--y` /
// `--y-hint` flag forms. Case-sensitive on the bare-Y branch so lowercase
// `y` inside ordinary words (e.g. "any") is not matched.
const USAGE_Y_RE = /(\b[GD]?Y[12]?\b|surface_y|y_hint|--y\b|--y-)/;

function collectYBearingCommands() {
  const out = [];
  for (const d of RAW_COMMAND_DEFS) {
    const schema = Array.isArray(d.argSchema) ? d.argSchema : null;
    let hit = false;
    if (schema) {
      for (const spec of schema) {
        const k = String(spec.key || '');
        if (Y_KEY_RE.test(k)) { hit = true; break; }
      }
      if (!hit && EXTRA_Y_PARAMS[d.name]) {
        hit = schema.some((s) => s.key === EXTRA_Y_PARAMS[d.name]);
      }
    }
    if (!hit && typeof d.usage === 'string' && USAGE_Y_RE.test(d.usage)) {
      hit = true;
    }
    if (hit) out.push(d.name);
  }
  return out;
}

function parseDocNames(docText) {
  // Slice the Inputs section: from `### Inputs` to `### Outputs`.
  const startIdx = docText.indexOf('### Inputs');
  const endIdx = docText.indexOf('### Outputs', startIdx + 1);
  assert.ok(startIdx >= 0 && endIdx > startIdx, 'world-coordinates.md must contain ### Inputs followed by ### Outputs');
  const section = docText.slice(startIdx, endIdx);

  const names = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`mc ([a-z_]+)`/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

test('y-vocabulary: every Y-bearing command has an Inputs row in world-coordinates.md (or is exempt)', () => {
  const docText = fs.readFileSync(DOC_PATH, 'utf8');
  const docNames = parseDocNames(docText);
  const yCommands = collectYBearingCommands();

  const missing = yCommands.filter((n) => !docNames.has(n) && !(n in EXEMPT));
  assert.deepEqual(
    missing, [],
    `commands with Y arg(s) missing from docs/reference/world-coordinates.md ### Inputs: ${missing.join(', ')}.\n` +
    `Either add a row, or add an entry to EXEMPT in this test with a one-line reason.`,
  );
});

test('y-vocabulary: clear_strip and deck stay pinned in the Inputs table (migration regression guard)', () => {
  const docText = fs.readFileSync(DOC_PATH, 'utf8');
  const docNames = parseDocNames(docText);
  assert.ok(docNames.has('clear_strip'), 'clear_strip row removed from world-coordinates.md ### Inputs — phase 2 migration regression');
  assert.ok(docNames.has('deck'), 'deck row removed from world-coordinates.md ### Inputs — phase 2 migration regression');
});

test('y-vocabulary: every command named in the Inputs table resolves to a registered command or alias', () => {
  const docText = fs.readFileSync(DOC_PATH, 'utf8');
  const docNames = parseDocNames(docText);
  const aliasMap = buildAliasMap();

  const rot = [...docNames].filter((n) => !aliasMap[n.toLowerCase()]);
  assert.deepEqual(
    rot, [],
    `docs/reference/world-coordinates.md ### Inputs references nonexistent commands: ${rot.join(', ')}.\n` +
    `Either fix the doc row to use a real command name (or registered alias) or delete the row.`,
  );
});

test('y-vocabulary: EXEMPT commands must not also appear in the Inputs table (keeps the list honest)', () => {
  const docText = fs.readFileSync(DOC_PATH, 'utf8');
  const docNames = parseDocNames(docText);
  const conflicts = Object.keys(EXEMPT).filter((n) => docNames.has(n));
  assert.deepEqual(
    conflicts, [],
    `commands listed in EXEMPT but also documented in ### Inputs: ${conflicts.join(', ')}.\n` +
    `Remove from EXEMPT — the doc row supersedes the exemption.`,
  );
});
