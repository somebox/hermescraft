import { describe, it } from 'node:test';
import assert from 'node:assert';

import { renderHuman, fmtHumanErrOneLine, slimStatusEnvelope } from '../../cli/output.mjs';

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

  // Run-7 PR-J end-to-end contract: terrain reaches `mc status` stdout.
  // The hermetic `renderNavBrief` test passed because it tested a function
  // workers don't see — `formatNavFrameLine` is the actual status/scene
  // path. Bench A asserts the agent-visible output, not the isolated helper.
  it('renderHuman includes terrain= on mc status when nav_header.terrain is set', () => {
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
            pos: { x: 4, y: 96, z: 24 },
            nav_mode: 'open',
            signals: { text: '4 exits' },
            terrain: { kind: 'flat', feet_vs_local_ground: 0 },
          },
          health: 20,
          food: 20,
        },
      });
    } finally {
      console.log = orig;
    }
    const joined = logs.join('\n');
    assert.ok(
      /terrain=flat \(feet_vs_local_ground=0\)/.test(joined),
      `expected terrain=flat in stdout; got:\n${joined}`,
    );
    // Same-line contract: terrain rides on the situation/mode line so
    // worker SOULs that grep `^Surface at` still see it.
    const headerLine = joined.split('\n').find((l) => l.startsWith('Surface at'));
    assert.ok(headerLine, 'nav header line missing');
    assert.ok(
      /terrain=flat/.test(headerLine),
      `terrain should be on the same line as "Surface at"; line was:\n${headerLine}`,
    );
  });

  it('renderHuman includes terrain=unknown with run-8 muster feet offset (PR-J regression)', () => {
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
            pos: { x: 4, y: 88, z: 24 },
            nav_mode: 'open',
            signals: { text: '4 exits' },
            terrain: { kind: 'unknown', feet_vs_local_ground: -9 },
          },
          health: 20,
          food: 20,
        },
      });
    } finally {
      console.log = orig;
    }
    const joined = logs.join('\n');
    assert.ok(
      /terrain=unknown \(feet_vs_local_ground=-9\)/.test(joined),
      `expected run-8 muster terrain line; got:\n${joined}`,
    );
  });

  it('renderHuman includes terrain= on mc scene when nav_header.terrain is set', () => {
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      renderHuman({
        ok: true,
        command: 'scene',
        data: {
          nav_header: {
            situation: 'Underground',
            pos: { x: 0, y: 84, z: 0 },
            nav_mode: 'confined',
            signals: { text: '0 exits' },
            terrain: { kind: 'underground', feet_vs_local_ground: -12 },
          },
          summary: 'Visible blocks: stone everywhere.',
          visible_blocks: [],
        },
      });
    } finally {
      console.log = orig;
    }
    const joined = logs.join('\n');
    assert.ok(/terrain=underground \(feet_vs_local_ground=-12\)/.test(joined));
  });

  it('renderHuman omits terrain= when nav_header.terrain is partial / unset', () => {
    // Defensive: never emit `terrain=undefined` or `terrain=null
    // (feet_vs_local_ground=undefined)` when the classifier hasn't filled
    // in fields (chunk-loading mid-flight, just-spawned bot).
    const fixtures = [
      // No terrain at all.
      { situation: 'Surface', pos: { x: 0, y: 64, z: 0 }, nav_mode: 'open', signals: { text: '4 exits' } },
      // terrain present but kind missing.
      { situation: 'Surface', pos: { x: 0, y: 64, z: 0 }, nav_mode: 'open', signals: { text: '4 exits' },
        terrain: { feet_vs_local_ground: 0 } },
      // terrain present but feet_vs_local_ground missing.
      { situation: 'Surface', pos: { x: 0, y: 64, z: 0 }, nav_mode: 'open', signals: { text: '4 exits' },
        terrain: { kind: 'flat' } },
    ];
    for (const nav_header of fixtures) {
      const logs = [];
      const orig = console.log;
      console.log = (...args) => logs.push(args.join(' '));
      try {
        renderHuman({ ok: true, command: 'status', data: { nav_header, health: 20, food: 20 } });
      } finally {
        console.log = orig;
      }
      const joined = logs.join('\n');
      assert.ok(!/terrain=undefined/.test(joined), `terrain=undefined leaked: ${joined}`);
      assert.ok(!/terrain=null/.test(joined), `terrain=null leaked: ${joined}`);
      assert.ok(!/feet_vs_local_ground=undefined/.test(joined),
        `feet_vs_local_ground=undefined leaked: ${joined}`);
    }
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

  // proc-nav-1781014144: a worker ran 200+ commands as Mox while believing
  // it was Pip. Every status read must lead with WHO you are.
  describe('bot identity leads mc status', () => {
    it('slimStatusEnvelope puts bot + identity first in data', () => {
      const out = slimStatusEnvelope({
        ok: true,
        data: { bot: 'Mox', position: { x: 1.24, y: 64, z: -2.4 }, health: 20, food: 18 },
      });
      assert.equal(out.data.bot, 'Mox');
      assert.equal(out.data.identity, 'You are Mox @ (1, 64, -2)');
      const keys = Object.keys(out.data);
      assert.equal(keys[0], 'bot', `bot must be the first key; got ${keys[0]}`);
      assert.equal(keys[1], 'identity');
    });

    it('slimStatusEnvelope identity without position omits coords', () => {
      const out = slimStatusEnvelope({ ok: true, data: { bot: 'Pip', health: 20 } });
      assert.equal(out.data.identity, 'You are Pip');
    });

    it('slimStatusEnvelope omits identity when bot is unknown', () => {
      const out = slimStatusEnvelope({ ok: true, data: { health: 20, food: 20 } });
      assert.equal(out.data.identity, undefined);
      assert.equal(out.data.bot, undefined);
    });

    it('renderHuman prints identity as the FIRST line of mc status', () => {
      const logs = [];
      const orig = console.log;
      console.log = (...args) => logs.push(args.join(' '));
      try {
        renderHuman({
          ok: true,
          command: 'status',
          data: {
            bot: 'Mox',
            identity: 'You are Mox @ (1, 64, -2)',
            nav_header: {
              situation: 'Surface',
              pos: { x: 1, y: 64, z: -2 },
              nav_mode: 'open',
              signals: { text: '4 exits' },
            },
            health: 20,
            food: 18,
            position: { x: 1, y: 64, z: -2 },
          },
        });
      } finally {
        console.log = orig;
      }
      assert.ok(logs.length > 0, 'nothing rendered');
      assert.equal(logs[0], 'You are Mox @ (1, 64, -2)', `identity must lead; got: ${logs[0]}`);
      const navIdx = logs.findIndex((l) => l.startsWith('Surface at'));
      assert.ok(navIdx > 0, 'nav header should still render after identity');
    });

    it('renderHuman does not print identity on non-status commands', () => {
      const logs = [];
      const orig = console.log;
      console.log = (...args) => logs.push(args.join(' '));
      try {
        renderHuman({
          ok: true,
          command: 'scene',
          data: { identity: 'You are Mox @ (1, 64, -2)', summary: 'Visible blocks: stone.' },
        });
      } finally {
        console.log = orig;
      }
      assert.ok(!logs.includes('You are Mox @ (1, 64, -2)'), 'identity leaked onto scene output');
    });
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
