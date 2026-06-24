/**
 * F2 — bot manager must clear construct session on death and disconnect (end).
 * Contract test: wiring lives in manager.js death/end handlers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const managerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../lib/runtime/manager.js',
);

function deathHandlerBlock(src) {
  const start = src.indexOf("ctx.world.bot.on('death'");
  assert.ok(start >= 0, 'death handler missing');
  const end = src.indexOf('botInstance.on(\'spawn\'', start);
  assert.ok(end > start, 'death handler block not bounded');
  return src.slice(start, end);
}

function endHandlerBlock(src) {
  const start = src.indexOf("ctx.world.bot.on('end'");
  assert.ok(start >= 0, 'end handler missing');
  const end = src.indexOf('ctx.death.reconnectAttempts = 0', start);
  assert.ok(end > start, 'end handler block not bounded');
  return src.slice(start, end);
}

test('F2: death handler clears construct session', () => {
  const src = fs.readFileSync(managerPath, 'utf8');
  const block = deathHandlerBlock(src);
  assert.match(block, /clearConstructSession\(ctx\)/);
});

test('F2: disconnect (end) handler clears construct session', () => {
  const src = fs.readFileSync(managerPath, 'utf8');
  const block = endHandlerBlock(src);
  assert.match(block, /clearConstructSession\(ctx\)/);
});
