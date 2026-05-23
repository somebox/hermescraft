/**
 * Manifest assertion: every `create*Actions` factory exported by a
 * non-helper file under `bot/lib/actions/` must be imported by
 * `lib/actions/index.js`. Catches the "added a new action module but
 * forgot to wire it" failure mode.
 *
 * Excluded:
 *   - filenames starting with `_` (private helpers like _helpers, _nav-helpers)
 *   - `index.js` itself (it's the manifest)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIONS_DIR = path.resolve(__dirname, '..', 'lib', 'actions');
const INDEX_PATH = path.join(ACTIONS_DIR, 'index.js');

function listActionModules() {
  return fs
    .readdirSync(ACTIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => f !== 'index.js')
    .filter((f) => !f.startsWith('_'));
}

function extractFactoryNames(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  // Match `export function createXxxActions(` — case-sensitive, factory-naming convention.
  const matches = [...src.matchAll(/export\s+function\s+(create[A-Z][a-zA-Z0-9]*Actions)\s*\(/g)];
  const factories = [...matches.map((m) => m[1])];

  /** Barrel shim: export { createXxxActions } from '...'; */
  for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from\s+/g)) {
    for (const part of String(m[1]).split(',')) {
      let name = part.replace(/\bas\s+[a-zA-Z0-9_]+\b/gi, '').trim().split(/\s+/)[0];
      if (/^create[A-Z][a-zA-Z0-9]*Actions$/.test(name)) factories.push(name);
    }
  }

  return [...new Set(factories)];
}

test('every action module exporting create*Actions is imported in index.js', () => {
  const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');
  const modules = listActionModules();
  const missing = [];

  for (const file of modules) {
    const factories = extractFactoryNames(path.join(ACTIONS_DIR, file));
    if (factories.length === 0) {
      // A non-helper file with no create*Actions export is suspicious but
      // not strictly a manifest failure — note it but don't fail.
      continue;
    }
    for (const factory of factories) {
      // Require `import { createXxxActions ...` from './<file>'
      // (single-quote or double-quote, with or without .js suffix).
      const importPattern = new RegExp(
        `import\\s*\\{[^}]*\\b${factory}\\b[^}]*\\}\\s*from\\s*['"]\\.\/${file.replace('.js', '')}(?:\\.js)?['"]`,
      );
      if (!importPattern.test(indexSrc)) {
        missing.push(`${file}: ${factory}`);
      }
    }
  }

  assert.equal(missing.length, 0, `manifest drift — index.js is missing these factories:\n  ${missing.join('\n  ')}`);
});

test('index.js does not import factories that no longer exist', () => {
  const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');
  // Extract every `from './X.js'` (or `./X`) referencing the actions directory.
  const importMatches = [...indexSrc.matchAll(/from\s+['"]\.\/([a-zA-Z_][a-zA-Z0-9_-]*)(?:\.js)?['"]/g)];
  const referencedFiles = importMatches.map((m) => m[1] + '.js');

  const missing = referencedFiles.filter((f) => {
    if (f.startsWith('_')) return false; // helpers OK to be imported even if no factory
    return !fs.existsSync(path.join(ACTIONS_DIR, f));
  });

  assert.equal(missing.length, 0, `index.js imports files that don't exist: ${missing.join(', ')}`);
});

test('action module factory names match the createXxxActions convention', () => {
  const modules = listActionModules();
  const violations = [];

  for (const file of modules) {
    const factories = extractFactoryNames(path.join(ACTIONS_DIR, file));
    // Each non-helper file should export at least one create*Actions factory.
    if (factories.length === 0) {
      violations.push(`${file}: no create*Actions export found`);
    }
  }

  assert.equal(violations.length, 0, `convention violations:\n  ${violations.join('\n  ')}`);
});
