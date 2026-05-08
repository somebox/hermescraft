import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RAW_COMMAND_DEFS } from '../cli/registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Extract async handler keys from lib/actions/*.js domain modules.
 * ACTIONS is assembled via createAllActions() so we scan the source modules directly.
 */
function serverActionNames() {
  const actionsDir = path.join(__dirname, '..', 'lib', 'actions');
  const names = new Set();
  for (const file of fs.readdirSync(actionsDir)) {
    if (!file.endsWith('.js') || file === 'index.js') continue;
    const src = fs.readFileSync(path.join(actionsDir, file), 'utf8');
    for (const m of src.matchAll(/^\s+async (\w+)\(/gm)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** POST /task routes that are not ACTION handlers */
const SKIP_TASK_SEGMENT = new Set([
  'start',
  'cancel',
  'pause',
  'resume',
  'checkpoint-respond',
  'history',
]);

function cliPostActionNames() {
  const names = new Set();
  for (const def of RAW_COMMAND_DEFS) {
    if (def.method !== 'POST' || typeof def.path !== 'string') continue;
    if (def.path.includes('__REPLACE__')) continue;
    const am = def.path.match(/^\/action\/(\w+)$/);
    if (am) names.add(am[1]);
    const tm = def.path.match(/^\/task\/([\w_]+)$/);
    if (tm && !SKIP_TASK_SEGMENT.has(tm[1])) names.add(tm[1]);
  }
  return names;
}

test('CLI POST /action and /task paths reference handlers defined in ACTIONS', () => {
  const handlers = serverActionNames();
  const cli = cliPostActionNames();
  const missing = [...cli].filter((n) => !handlers.has(n));
  assert.deepEqual(
    missing,
    [],
    `CLI references unknown handlers: ${missing.join(', ')}`,
  );
});
