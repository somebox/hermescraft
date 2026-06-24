/**
 * Static style gates from docs/reference/bot/code-style-standards.md (Phase 0).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT = path.resolve(__dirname, '..');
const ACTIONS = path.join(BOT, 'lib', 'actions');

/** Known debt — must shrink as refactor phases land. */
const INVALID_ARG_ALLOW = new Set([]);
const CONTRACT_DEBT = new Set([
  'test/actions/verify-contract.test.js',
  'test/actions/terrain-top-contract.test.js',
  'test/actions/mines.contract.test.js',
  'test/actions/inspect-mark.contract.test.js',
]);
/** Until Phase 3: camelCase nav key on ACTIONS map. */
const ALLOW_NAVIGATE_TO_TARGET_ON_ACTIONS = false;
const CONTRACT_HTTP_ONLY = new Set([
  'task-contract.test.js',
  'goals-contract.test.js',
  'perceive-route-contract.test.js',
]);

describe('code style audit', () => {
  it('discourages INVALID_ARG without S in action handlers', () => {
    const bad = [];
    function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
          const src = fs.readFileSync(p, 'utf8');
          if (/fail\s*\(\s*['"]INVALID_ARG['"]/.test(src)) bad.push(path.relative(BOT, p));
        }
      }
    }
    walk(ACTIONS);
    const filtered = bad.filter((p) => !INVALID_ARG_ALLOW.has(p));
    assert.equal(
      filtered.length,
      0,
      `Use INVALID_ARGS: ${filtered.join(', ')}`,
    );
  });

  it('movement ACTIONS map must not expose camelCase navigateToTarget (Phase 3)', () => {
    if (ALLOW_NAVIGATE_TO_TARGET_ON_ACTIONS) return;
    const src = fs.readFileSync(path.join(ACTIONS, 'movement', 'index.js'), 'utf8');
    assert.doesNotMatch(
      src,
      /^\s*navigateToTarget\s*,/m,
      'export internal nav as _navigateToTarget',
    );
  });

  it('action *-contract.test.js files import harness or validate (with exemptions)', () => {
    const actionsTest = path.join(BOT, 'test', 'actions');
    const missing = [];
    for (const name of fs.readdirSync(actionsTest)) {
      if (!name.endsWith('-contract.test.js') && name !== 'mines.contract.test.js') continue;
      if (CONTRACT_HTTP_ONLY.has(name)) continue;
      const rel = path.join('test', 'actions', name);
      if (CONTRACT_DEBT.has(rel)) continue;
      const content = fs.readFileSync(path.join(actionsTest, name), 'utf8');
      const hasHarness =
        /action-harness\.js/.test(content) &&
        (/assertContract|assertFailure/.test(content) || /validate\s*\(/.test(content));
      if (!hasHarness) missing.push(rel);
    }
    assert.equal(
      missing.length,
      0,
      `Add harness or validate(): ${missing.join(', ')}`,
    );
  });
});
