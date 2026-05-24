import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRegionStore } from '../../../lib/runtime/regions/index.js';
import { setupRegionSignWatcher } from '../../../lib/runtime/regions/sign-watcher.js';

test('sign break orphans matching active region', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-sign-watch-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'active',
    anchor: { x: 1, y: 64, z: 2 },
    shape: { radius: 8 },
  });
  const bot = new EventEmitter();
  bot.findBlocks = () => [];
  setupRegionSignWatcher(bot, store);
  const oldBlock = {
    name: 'oak_wall_sign',
    position: { x: 1, y: 64, z: 2 },
  };
  bot.emit('blockUpdate', oldBlock, { name: 'air', position: oldBlock.position });
  const row = store.get('base1');
  assert.equal(row.status, 'orphaned');
});
