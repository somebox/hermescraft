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

  it('renderHuman prints nav_brief_text for observe without full JSON dump', () => {
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      renderHuman({
        ok: true,
        command: 'observe',
        data: {
          nav_brief_text: 'Surface at 1,2,3 — open (4 exits)\npaths:\n- base: move base',
          goals: [{ id: 'wood', satisfied: false }],
          task: { kind: 'idle', status: 'ready' },
        },
      });
    } finally {
      console.log = orig;
    }
    const joined = logs.join('\n');
    assert.ok(joined.includes('Surface at 1,2,3'));
    assert.ok(joined.includes('move base'));
    assert.ok(joined.includes('goals: wood'));
    assert.ok(!joined.includes('"nav_brief_text"'));
  });

  it('renderHuman prefixes mc scene with nav_header line (#50 follow-up)', () => {
    // Server now ships nav_header on /scene and /status envelopes so the
    // brief reaches workers who favor those verbs. The CLI human renderer
    // must surface the compact line as a prefix; otherwise the header
    // arrives in the JSON but is invisible to the agent's terminal output.
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      renderHuman({
        ok: true,
        command: 'scene',
        data: {
          nav_header: {
            situation: 'Surface',
            pos: { x: -469, y: 64, z: 597 },
            nav_mode: 'open',
            signals: { exit_count: 3, text: '3 exits' },
          },
          summary: 'Visible blocks: grass_block 2m center.',
          visible_blocks: [],
        },
      });
    } finally {
      console.log = orig;
    }
    const joined = logs.join('\n');
    assert.ok(joined.includes('Surface at -469,64,597'), 'nav_header line missing');
    assert.ok(joined.includes('open'), 'nav_mode missing from header line');
    assert.ok(joined.includes('Visible blocks'), 'scene summary still rendered');
  });

  it('renderHuman prefixes mc status with nav_header line (#50 follow-up)', () => {
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      renderHuman({
        ok: true,
        command: 'status',
        data: {
          nav_header: {
            situation: 'Surface',
            pos: { x: 5, y: 64, z: 5 },
            nav_mode: 'open',
            signals: { exit_count: 4, text: '4 exits' },
          },
          health: 20,
          food: 18,
          position: { x: 5, y: 64, z: 5 },
        },
      });
    } finally {
      console.log = orig;
    }
    const joined = logs.join('\n');
    assert.ok(joined.includes('Surface at 5,64,5'), 'nav_header line missing on status');
  });

  it('renderHuman prints nav frame line for observe without brief mode', () => {
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      renderHuman({
        ok: true,
        command: 'observe',
        data: {
          nav_mode: 'open',
          nav_header: {
            situation: 'Surface',
            pos: { x: 5, y: 64, z: -1 },
            nav_mode: 'open',
            signals: { text: '4 exits' },
          },
          journey: { line: 'spawn → here' },
        },
      });
    } finally {
      console.log = orig;
    }
    const joined = logs.join('\n');
    assert.match(joined, /Surface at 5,64,-1 — open \(4 exits\)/);
    assert.ok(joined.includes('journey: spawn → here'));
    assert.ok(!joined.includes('"nav_header"'));
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
