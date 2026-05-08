import { describe, it } from 'node:test';
import assert from 'node:assert';

import { renderHuman, fmtHumanErrOneLine } from '../../cli/output.mjs';

describe('cli output', () => {
  it('renderHuman surfaces failures with hints', () => {
    const out = renderHuman({
      ok: false,
      command: 'goto',
      error: 'busy',
      error_type: 'task_conflict',
      hint: 'POST /task/cancel first.',
    });
    assert.match(out || '', /ERROR/);
    assert.match(out || '', /POST \/task\/cancel/);
  });

  it('fmtHumanErrOneLine packs hint and meta on one row', () => {
    const line = fmtHumanErrOneLine({
      command: 'place',
      error: 'No neighbors',
      http_status: 400,
      error_type: 'placement_blocked',
      hint: 'Stand closer.',
      state: { holding: 'cobblestone', position: { x: 1, y: 2, z: 3 } },
    });
    assert.ok(line.includes('ERROR'));
    assert.ok(line.includes('Stand closer'));
    assert.ok(line.includes('http=400'));
    assert.ok(line.includes('Hold:cobblestone'));
  });
});
