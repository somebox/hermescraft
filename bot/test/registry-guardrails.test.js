/**
 * Registry guardrails from mc-command-audit 2026-05-29 (F.2, F.3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RAW_COMMAND_DEFS, CATEGORY_ORDER } from '../cli/registry.mjs';

/** Meta verbs where empty Examples in --help is acceptable. */
const EXAMPLES_OPT_OUT = new Set([
  'help',
  'commands',
  'connect',
  'batch',
  'dashboard',
]);

test('every command category is listed in CATEGORY_ORDER', () => {
  const orderSet = new Set(CATEGORY_ORDER);
  const missing = [];
  for (const cmd of RAW_COMMAND_DEFS) {
    if (!orderSet.has(cmd.category)) missing.push(`${cmd.name} → ${cmd.category}`);
  }
  assert.equal(missing.length, 0, `categories not in CATEGORY_ORDER:\n  ${missing.join('\n  ')}`);
});

test('commands have examples or are explicitly opted out', () => {
  const violations = [];
  for (const cmd of RAW_COMMAND_DEFS) {
    if (EXAMPLES_OPT_OUT.has(cmd.name)) continue;
    const ex = cmd.examples;
    if (!Array.isArray(ex) || ex.length === 0) violations.push(cmd.name);
  }
  assert.equal(
    violations.length,
    0,
    `${violations.length} commands missing examples (run scripts/backfill-registry-examples.mjs):\n  ${violations.slice(0, 20).join(', ')}${violations.length > 20 ? '…' : ''}`,
  );
});
