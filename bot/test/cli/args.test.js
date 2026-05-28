import { describe, it } from 'node:test';
import assert from 'node:assert';
import { stripGlobalFlags, positionalToParams, normalizeMark } from '../../cli/args.mjs';
import { RAW_COMMAND_DEFS } from '../../cli/registry.mjs';

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

  // pillar_step --force / pillar_down --pickup=false used to fail because
  // the schema declared force/jump/pickup as type:'string'. The bare --force
  // token then wasn't recognized as a flag (the bare-flag handler only
  // fires for type:'boolean'), so it leaked into the positional queue and
  // was coerced as the next positional — typically `count` (type:'number').
  // Number('--force') → NaN → "pillar_step:count:not_number". The fix
  // flipped the schema to type:'boolean'; these tests drive the FULL
  // registry pipeline (schema + bodyFn) so we lock in the HTTP body the
  // action layer actually receives.
  describe('pillar_step / pillar_down boolean-flag parsing', () => {
    // Find the canonical command definitions from the registry. Keeping
    // schema in one place means a schema regression here surfaces
    // immediately, not in a duplicated local copy that drifts.
    const pillarStep = RAW_COMMAND_DEFS.find((d) => d.name === 'pillar_step');
    const pillarDown = RAW_COMMAND_DEFS.find((d) => d.name === 'pillar_down');
    assert.ok(pillarStep, 'pillar_step must be in RAW_COMMAND_DEFS');
    assert.ok(pillarDown, 'pillar_down must be in RAW_COMMAND_DEFS');
    const stepSchema = pillarStep.argSchema;
    const stepBodyFn = pillarStep.bodyFn;
    const downSchema = pillarDown.argSchema;
    const downBodyFn = pillarDown.bodyFn;

    /** Run the whole pipeline a real CLI invocation goes through. */
    function pipeline(verb, schema, bodyFn, argv) {
      const params = positionalToParams(verb, schema, argv);
      return JSON.parse(bodyFn(params));
    }

    it('regression guard: pillar_step schema declares jump+force as type:boolean', () => {
      const byKey = Object.fromEntries(stepSchema.map((s) => [s.key, s]));
      assert.equal(byKey.jump?.type, 'boolean',
        'pillar_step.jump must be type:boolean — string causes the bare-flag parser to skip it');
      assert.equal(byKey.force?.type, 'boolean',
        'pillar_step.force must be type:boolean — string causes Number("--force") → NaN');
    });

    it('regression guard: pillar_down schema declares pickup as type:boolean', () => {
      const byKey = Object.fromEntries(downSchema.map((s) => [s.key, s]));
      assert.equal(byKey.pickup?.type, 'boolean',
        'pillar_down.pickup must be type:boolean — string breaks "--pickup=false" routing');
    });

    it('mc pillar_step --force (no count) → body force=true, no count', () => {
      const body = pipeline('pillar_step', stepSchema, stepBodyFn, ['--force']);
      assert.equal(body.force, true);
      assert.equal(body.count, undefined, 'count should be omitted, action defaults it to 1');
    });

    it('mc pillar_step 5 --force → body { count: 5, force: true }', () => {
      // Pre-fix this threw "pillar_step:count:not_number". Two orderings:
      // --force-first and count-first must both work.
      const a = pipeline('pillar_step', stepSchema, stepBodyFn, ['5', '--force']);
      assert.equal(a.count, 5);
      assert.equal(a.force, true);
      assert.equal(a.block, undefined, 'numeric-only positional must be rewritten to count');

      const b = pipeline('pillar_step', stepSchema, stepBodyFn, ['--force', '5']);
      assert.equal(b.count, 5);
      assert.equal(b.force, true);
    });

    it('mc pillar_step cobblestone 10 --force → block, count, force', () => {
      const body = pipeline('pillar_step', stepSchema, stepBodyFn, ['cobblestone', '10', '--force']);
      assert.equal(body.block, 'cobblestone');
      assert.equal(body.count, 10);
      assert.equal(body.force, true);
    });

    it('mc pillar_step force=true (kw=value form) still works', () => {
      const body = pipeline('pillar_step', stepSchema, stepBodyFn, ['force=true']);
      assert.equal(body.force, true);
    });

    it('mc pillar_step force=false → force omitted from body (false is the default)', () => {
      // The bodyFn's conditional spread emits force only when truthy after
      // normalization; force=false produces `{ force: false }` in the body.
      const body = pipeline('pillar_step', stepSchema, stepBodyFn, ['force=false']);
      assert.equal(body.force, false);
    });

    it('mc pillar_down --pickup=false → body { pickup: false }, count omitted', () => {
      const body = pipeline('pillar_down', downSchema, downBodyFn, ['--pickup=false']);
      assert.equal(body.pickup, false);
      assert.equal(body.count, undefined);
    });

    it('mc pillar_down 8 --pickup=false → body { count: 8, pickup: false }', () => {
      const body = pipeline('pillar_down', downSchema, downBodyFn, ['8', '--pickup=false']);
      assert.equal(body.count, 8);
      assert.equal(body.pickup, false);
    });

    it('mc pillar_down (no args) → empty body, action defaults apply', () => {
      const body = pipeline('pillar_down', downSchema, downBodyFn, []);
      assert.equal(body.count, undefined);
      assert.equal(body.pickup, undefined);
    });

    it('mc pillar_down --no-pickup → body { pickup: false } (negation form)', () => {
      // --no-FLAG sugar is the agent-friendly alternative to --pickup=false.
      // Many CLIs support both; before this fix only the =-form worked.
      const body = pipeline('pillar_down', downSchema, downBodyFn, ['--no-pickup']);
      assert.equal(body.pickup, false);
    });

    it('mc pillar_step --no-force --no-jump → both false', () => {
      const body = pipeline('pillar_step', stepSchema, stepBodyFn, ['--no-force', '--no-jump']);
      assert.equal(body.force, false);
      assert.equal(body.jump, false);
    });

    it('mc pillar_step 5 --no-force → count=5, force=false', () => {
      const body = pipeline('pillar_step', stepSchema, stepBodyFn, ['5', '--no-force']);
      assert.equal(body.count, 5);
      assert.equal(body.force, false);
    });
  });

  // --no-FLAG sugar — common CLI convention agents reach for. Was silently
  // unsupported before; "--no-pickup" used to fall through to positional
  // consumption and either get coerced wrong (for a number spec) or
  // silently ignored. This block pins the universal sugar at the parser
  // layer (positionalToParams), independent of any single verb's schema.
  describe('--no-FLAG boolean negation', () => {
    const SCHEMA = [
      { key: 'foo', type: 'boolean' },
      { key: 'bar_baz', type: 'boolean' },
      { key: 'qux', type: 'number' },
    ];

    it('--no-foo → foo=false', () => {
      const p = positionalToParams('demo', SCHEMA, ['--no-foo']);
      assert.equal(p.foo, false);
    });

    it('--no-bar-baz (dash form) → bar_baz=false', () => {
      // CLI users often write the key with dashes even when the schema
      // declares it with underscores. Accept both.
      const p = positionalToParams('demo', SCHEMA, ['--no-bar-baz']);
      assert.equal(p.bar_baz, false);
    });

    it('--no_bar_baz (underscore form) → bar_baz=false', () => {
      const p = positionalToParams('demo', SCHEMA, ['--no_bar_baz']);
      assert.equal(p.bar_baz, false);
    });

    it('--foo and --no-foo can co-exist; last one wins', () => {
      // kwOverrides assignment is last-write-wins. Documented behaviour.
      const p = positionalToParams('demo', SCHEMA, ['--foo', '--no-foo']);
      assert.equal(p.foo, false);
      const q = positionalToParams('demo', SCHEMA, ['--no-foo', '--foo']);
      assert.equal(q.foo, true);
    });

    it('--no-FLAG for a non-boolean spec falls through as positional', () => {
      // Safety: only boolean specs accept --no-FLAG. A number/string spec
      // with --no- prefix should NOT silently bind to false (the user
      // probably meant something else, or the spec is wrong). It falls
      // through to positional consumption — the first non-string spec it
      // hits then fails its coercion, surfacing a clear error.
      assert.throws(
        () => positionalToParams('demo', SCHEMA, ['--no-qux']),
        /demo:.+:(not_bool|not_number)/,
      );
    });

    it('--no-bogus (unknown key) falls through as positional', () => {
      // Unknown --no-FLAG should error like any other unknown flag — gets
      // pushed onto positional and fails the next type coercion. Confirms
      // the matcher checks specByKey before binding.
      assert.throws(
        () => positionalToParams('demo', SCHEMA, ['--no-bogus']),
        /demo:.+:(not_bool|not_number)/,
      );
    });
  });
});
