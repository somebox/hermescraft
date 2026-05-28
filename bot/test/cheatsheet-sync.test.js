/**
 * Guards `docs/mc-cheatsheet.md` against drift from `bot/cli/registry.mjs`.
 *
 * The cheatsheet is the canonical "what mc verbs exist" reference embedded
 * in skill prompts. Stale entries silently mislead agents — we fail the
 * build instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RAW_COMMAND_DEFS } from '../cli/registry.mjs';
import { buildCheatsheet, CHEATSHEET_PATH } from '../../scripts/gen-mc-cheatsheet.mjs';

test('docs/mc-cheatsheet.md is up-to-date with bot/cli/registry.mjs', () => {
  const expected = buildCheatsheet(RAW_COMMAND_DEFS);
  const actual = fs.readFileSync(CHEATSHEET_PATH, 'utf8');
  if (expected !== actual) {
    assert.fail(
      'mc-cheatsheet.md is stale. Run `node scripts/gen-mc-cheatsheet.mjs` (or `npm run cheatsheet` from bot/) and commit the result.',
    );
  }
});
