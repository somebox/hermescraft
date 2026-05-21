import { describe, it } from 'node:test';
import assert from 'node:assert';
import { stripGlobalFlags, positionalToParams, normalizeMark } from '../../cli/args.mjs';

describe('cli args', () => {
  it('stripGlobalFlags peels known globals anywhere; leaves unrelated flags intact', () => {
    const a = stripGlobalFlags(['--json', 'status']);
    assert.equal(a.globals.json, true);
    assert.deepEqual(a.rest, ['status']);

    const b = stripGlobalFlags(['status', '--json']);
    assert.equal(b.globals.json, true);
    assert.deepEqual(b.rest, ['status']);

    const c = stripGlobalFlags(['--dry-run', '--limit', '3', '--fields=a,b', 'observe']);
    assert.equal(c.globals.dryRun, true);
    assert.equal(c.globals.limit, 3);
    assert.deepEqual(c.globals.fields, ['a', 'b']);
    assert.deepEqual(c.rest, ['observe']);

    const d = stripGlobalFlags(['mark', 'home', '--category', 'base']);
    assert.deepEqual(d.rest, ['mark', 'home', '--category', 'base']);

    const e = stripGlobalFlags(['goto', '1', '2', '3', '--json']);
    assert.equal(e.globals.json, true);
    assert.deepEqual(e.rest, ['goto', '1', '2', '3']);
  });

  it('positionalToParams maps primitives', () => {
    const params = positionalToParams(
      'goto',
      [
        { key: 'x', type: 'number', required: true },
        { key: 'y', type: 'number', required: true },
        { key: 'z', type: 'number', required: true },
      ],
      ['10', '64', '-3'],
    );
    assert.deepEqual(params, { x: 10, y: 64, z: -3 });
  });

  it('normalizeMark strips leading @', () => {
    const o = { mark: '@home', to: '@spawn' };
    normalizeMark(o);
    assert.deepEqual(o, { mark: 'home', to: 'spawn' });
  });

  // Patterns observed in live agent sessions (Steve, deepseek-v4-flash)
  // where the prompt's documented --reason="..." form was breaking the
  // CLI before it reached the verb handler.
  describe('--reason kwarg (agent-prompt form)', () => {
    it('strips --reason="quoted reason" into globals.reason', () => {
      const a = stripGlobalFlags(['scene', '--reason="checking for hostiles"']);
      assert.equal(a.globals.reason, 'checking for hostiles');
      assert.deepEqual(a.rest, ['scene']);
    });

    it('strips --reason=plain (no quotes) into globals.reason', () => {
      const a = stripGlobalFlags(['nearby', '--reason=any-chests']);
      assert.equal(a.globals.reason, 'any-chests');
      assert.deepEqual(a.rest, ['nearby']);
    });

    it('strips --reason "value" (space-separated) into globals.reason', () => {
      const a = stripGlobalFlags(['scene', '--reason', 'finding trees']);
      // bare `--reason X` only consumes the immediate next token; bots that
      // want multi-word reasons must quote them (--reason="finding trees")
      // or shell tokenization splits the words and only the first survives.
      assert.equal(a.globals.reason, 'finding trees');
      assert.deepEqual(a.rest, ['scene']);
    });

    it('strips -r "value" shorthand', () => {
      const a = stripGlobalFlags(['advise', '-r', 'find oak wood']);
      assert.equal(a.globals.reason, 'find oak wood');
      assert.deepEqual(a.rest, ['advise']);
    });

    it('preserves the legacy reason=value form (F56)', () => {
      const a = stripGlobalFlags(['scene', 'reason=checking trees']);
      assert.equal(a.globals.reason, 'checking trees');
      assert.deepEqual(a.rest, ['scene']);
    });

    it('does not consume --reason at the wrong position (mid-positional)', () => {
      // `mc find oak_log 32 --reason="..."` — the round-2 failing pattern.
      // Verb=find, resource=oak_log, scan_range=32, reason=... (telemetry).
      const a = stripGlobalFlags(['find', 'oak_log', '32', '--reason="finding cows"']);
      assert.equal(a.globals.reason, 'finding cows');
      assert.deepEqual(a.rest, ['find', 'oak_log', '32']);
    });
  });

  // End-to-end-ish: simulate full `mc <verb> ...` argv flow. We strip
  // globals then map remaining positionals against the registry schema
  // for the affected verbs. These were the exact failure modes in
  // rounds 1-3 of the in-game QA (Steve / deepseek-v4-flash).
  describe('scene/find/nearby/map positional parse with --reason', () => {
    const SCENE_SCHEMA = [
      { key: 'range', type: 'number', default: 16 },
      { key: 'full', type: 'boolean', default: false },
    ];
    const FIND_SCHEMA = [
      { key: 'resource', type: 'string', required: true, positional: true },
      { key: 'scan_range', type: 'number', default: 32 },
      { key: 'max_results', type: 'number', default: 12 },
    ];
    const NEARBY_SCHEMA = [{ key: 'radius', type: 'number', default: 32 }];

    function dispatch(verb, schema, argv) {
      const { globals, rest } = stripGlobalFlags(argv);
      assert.equal(rest[0], verb, `verb mismatch: ${rest[0]}`);
      const params = positionalToParams(verb, schema, rest.slice(1));
      return { globals, params };
    }

    // Round 1 failure: `mc scene --reason="..."` → scene:range:not_number.
    it('mc scene --reason="..." → range=default, full=default', () => {
      const { globals, params } = dispatch('scene', SCENE_SCHEMA, [
        'scene',
        '--reason="checking for hostiles before chopping wood"',
      ]);
      assert.equal(params.range, 16);
      assert.equal(params.full, false);
      assert.equal(globals.reason, 'checking for hostiles before chopping wood');
    });

    // Round 1 failure: `mc nearby --reason="..."` → nearby:radius:not_number.
    it('mc nearby --reason="..." → radius=default', () => {
      const { globals, params } = dispatch('nearby', NEARBY_SCHEMA, [
        'nearby',
        '--reason="find chests with food at home base"',
      ]);
      assert.equal(params.radius, 32);
      assert.equal(globals.reason, 'find chests with food at home base');
    });

    // Round 1 failure: `mc find --reason="..."` → CLI took the reason as
    // the RESOURCE positional. Now it should report missing:resource.
    it('mc find --reason="..." (no resource) → throws missing:resource', () => {
      const { globals, rest } = stripGlobalFlags(['find', '--reason="finding cows for food"']);
      assert.equal(globals.reason, 'finding cows for food');
      assert.throws(() => positionalToParams('find', FIND_SCHEMA, rest.slice(1)), /missing:resource/);
    });

    // Round 2 failure: `mc find oak_log 32 --reason="..."` → find:max_results:not_number.
    it('mc find oak_log 32 --reason="..." → resource=oak_log scan_range=32 max_results=default', () => {
      const { globals, params } = dispatch('find', FIND_SCHEMA, [
        'find',
        'oak_log',
        '32',
        '--reason="finding oak logs for bootstrap stone pickaxe"',
      ]);
      assert.equal(params.resource, 'oak_log');
      assert.equal(params.scan_range, 32);
      assert.equal(params.max_results, 12);
      assert.equal(globals.reason, 'finding oak logs for bootstrap stone pickaxe');
    });

    // Round 2: positional range first, --reason after.
    it('mc scene 32 --reason="..." → range=32', () => {
      const { globals, params } = dispatch('scene', SCENE_SCHEMA, [
        'scene',
        '32',
        '--reason="finding trees"',
      ]);
      assert.equal(params.range, 32);
      assert.equal(params.full, false);
      assert.equal(globals.reason, 'finding trees');
    });

    // Round 3 failure: `mc scene --full --reason="..."` → scene:full:not_bool.
    // The `--full` flag was being eaten as a positional and crashing the
    // boolean coerce. With per-spec --flag handling it now resolves.
    it('mc scene --full --reason="..." → full=true', () => {
      const { globals, params } = dispatch('scene', SCENE_SCHEMA, [
        'scene',
        '--full',
        '--reason="finding trees"',
      ]);
      assert.equal(params.range, 16);
      assert.equal(params.full, true);
      assert.equal(globals.reason, 'finding trees');
    });

    // Combination: positional + --flag + --reason.
    it('mc scene 32 --full --reason="..." → range=32 full=true', () => {
      const { globals, params } = dispatch('scene', SCENE_SCHEMA, [
        'scene',
        '32',
        '--full',
        '--reason="ray-level scan"',
      ]);
      assert.equal(params.range, 32);
      assert.equal(params.full, true);
      assert.equal(globals.reason, 'ray-level scan');
    });

    // --key=value override using long-flag form — e.g. `--scan_range=48`.
    it('mc find oak_log --scan_range=48 → scan_range=48', () => {
      const { params } = dispatch('find', FIND_SCHEMA, ['find', 'oak_log', '--scan_range=48']);
      assert.equal(params.resource, 'oak_log');
      assert.equal(params.scan_range, 48);
      assert.equal(params.max_results, 12);
    });

    // Bare --flag for a non-boolean spec should NOT be consumed silently;
    // it should fall through to positional and error clearly.
    it('mc nearby --bogus → bogus stays positional and errors', () => {
      const { rest } = stripGlobalFlags(['nearby', '--bogus']);
      assert.throws(() => positionalToParams('nearby', NEARBY_SCHEMA, rest.slice(1)), /nearby:radius:not_number/);
    });
  });

  // mc advise --target X,Y,Z (task #6) — attaches a route_preview probe
  // to the perception bundle along the bot→target line. The flag is a
  // global, not a per-command arg, because mc advise has customParse=true.
  describe('--target global flag (advise route probe)', () => {
    it('accepts --target=X,Y,Z (= form, single token)', () => {
      const { globals } = stripGlobalFlags(['advise', '--reason=test', '--target=100,64,-200']);
      assert.deepEqual(globals.target, { x: 100, y: 64, z: -200 });
    });

    it('accepts --target X,Y,Z (space form, single comma token)', () => {
      const { globals } = stripGlobalFlags(['advise', '--reason=test', '--target', '1552,64,352']);
      assert.deepEqual(globals.target, { x: 1552, y: 64, z: 352 });
    });

    it('accepts --target X Y Z (three numeric tokens)', () => {
      const { globals, rest } = stripGlobalFlags(['advise', '--target', '10', '20', '30', '--reason=test']);
      assert.deepEqual(globals.target, { x: 10, y: 20, z: 30 });
      // Make sure the 3 numbers got consumed and don't leak into rest.
      assert.ok(!rest.includes('10'), 'X should be consumed');
      assert.ok(!rest.includes('30'), 'Z should be consumed');
    });

    it('handles negative coords in three-token form', () => {
      const { globals } = stripGlobalFlags(['advise', '--target', '-100', '64', '-200', '--reason=x']);
      assert.deepEqual(globals.target, { x: -100, y: 64, z: -200 });
    });

    it('drops malformed targets silently (target stays undefined)', () => {
      const { globals } = stripGlobalFlags(['advise', '--target', 'not-coords', '--reason=test']);
      assert.equal(globals.target, undefined);
    });

    it('handles fractional / decimal coords', () => {
      const { globals } = stripGlobalFlags(['advise', '--target=1.5,64.0,-2.25']);
      assert.deepEqual(globals.target, { x: 1.5, y: 64, z: -2.25 });
    });
  });
});
