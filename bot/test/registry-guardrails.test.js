/**
 * Registry guardrails from mc-command-audit 2026-05-29 (F.2, F.3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RAW_COMMAND_DEFS, CATEGORY_ORDER } from '../cli/registry.mjs';
import { buildCheatsheet } from '../../scripts/gen-mc-cheatsheet.mjs';
import { SURFACE_CORE, SURFACE_MICROSCOPE } from '../cli/registry-surface.mjs';

const VALID_SURFACES = new Set(['core', 'extended', 'microscope']);
const MAX_CORE = 45;

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

test('agent surface tier is valid on every command', () => {
  for (const cmd of RAW_COMMAND_DEFS) {
    const tier = cmd.surface ?? 'extended';
    assert.ok(VALID_SURFACES.has(tier), `${cmd.name} has invalid surface ${tier}`);
  }
});

test('core surface tier count stays bounded', () => {
  const coreN = RAW_COMMAND_DEFS.filter((c) => (c.surface ?? 'extended') === 'core').length;
  assert.ok(coreN <= MAX_CORE, `core tier has ${coreN} commands (max ${MAX_CORE})`);
  assert.equal(coreN, SURFACE_CORE.size, 'core tier should match SURFACE_CORE set size');
});

test('surface tier sets do not overlap', () => {
  for (const name of SURFACE_CORE) {
    assert.ok(!SURFACE_MICROSCOPE.has(name), `${name} in both core and microscope`);
  }
});

test('every registry command appears in generated cheatsheet', () => {
  const text = buildCheatsheet(RAW_COMMAND_DEFS);
  const missing = [];
  for (const cmd of RAW_COMMAND_DEFS) {
    const hasMc = text.includes(`mc ${cmd.name}`) || text.includes(`\`${cmd.name}\``);
    if (!hasMc) missing.push(cmd.name);
  }
  assert.equal(missing.length, 0, `missing from cheatsheet: ${missing.join(', ')}`);
});
