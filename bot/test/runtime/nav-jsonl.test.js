import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logNavEvent, navEventLogPath } from '../../lib/runtime/metrics.js';

describe('logNavEvent', () => {
  /** @type {string} */
  let prevTmp;
  /** @type {string} */
  let dir;

  before(async () => {
    prevTmp = process.env.HERMESCRAFT_TMP || '';
    dir = await mkdtemp(join(tmpdir(), 'nav-jsonl-'));
    process.env.HERMESCRAFT_TMP = dir;
  });

  after(async () => {
    process.env.HERMESCRAFT_TMP = prevTmp;
    await rm(dir, { recursive: true, force: true });
  });

  it('appends golden v1 schema line to nav-<profile>.jsonl', async () => {
    logNavEvent({
      profile: 'Flint',
      actionName: 'move',
      ok: false,
      error_code: 'NAV_BLOCKED',
      playbook_id: 'wood.chop_tall_tree',
      phase: 'approach',
    });
    await new Promise((r) => setTimeout(r, 80));
    const path = navEventLogPath('Flint');
    const raw = await readFile(path, 'utf8');
    const line = raw.trim().split('\n').pop();
    const row = JSON.parse(line);
    assert.equal(row.schema_version, 1);
    assert.equal(row.actionName, 'move');
    assert.equal(row.ok, false);
    assert.equal(row.error_code, 'NAV_BLOCKED');
    assert.equal(row.playbook_id, 'wood.chop_tall_tree');
    assert.equal(row.phase, 'approach');
    assert.ok(row.ts);
  });

  it('records ok: true on successful actions', async () => {
    logNavEvent({
      profile: 'Mason',
      actionName: 'status',
      ok: true,
    });
    await new Promise((r) => setTimeout(r, 80));
    const raw = await readFile(navEventLogPath('Mason'), 'utf8');
    const row = JSON.parse(raw.trim().split('\n').pop());
    assert.equal(row.ok, true);
    assert.equal(row.actionName, 'status');
  });
});
