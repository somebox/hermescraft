import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadMapContext } from '../lib/map-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');

describe('loadMapContext', () => {
  it('loads proc-lab revision when runtime files exist', () => {
    const ctx = loadMapContext(REPO, 'proc-lab');
    assert.equal(ctx.world, 'proc-lab');
    if (ctx.proc_lab?.seed) {
      assert.ok(ctx.tile_revision, 'tile_revision set when proc-lab state has seed');
    }
  });
});
