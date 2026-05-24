import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRegionStore } from '../../../lib/runtime/regions/index.js';
import { setupRegionSignWatcher } from '../../../lib/runtime/regions/sign-watcher.js';

test('setupRegionSignWatcher is idempotent per bot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-sign-idem-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  const bot = new EventEmitter();
  bot.findBlocks = () => [];
  const a = setupRegionSignWatcher(bot, store);
  const b = setupRegionSignWatcher(bot, store);
  assert.equal(a, b);
  assert.equal(typeof a.dispose, 'function');
  let listeners = bot.listenerCount('blockUpdate');
  assert.equal(listeners, 1);
  a.dispose();
  assert.equal(bot.listenerCount('blockUpdate'), 0);
});
