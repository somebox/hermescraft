import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyError, buildEnvelope, detectEmpty } from '../../cli/results.mjs';

describe('cli results', () => {
  it('detectEmpty detects empty arrays', () => {
    const d = detectEmpty('find_blocks', { locations: [], note: '' });
    assert.equal(d.empty, true);
    assert.ok(typeof d.hint === 'string' && d.hint.length > 5);
    assert.equal(detectEmpty('x', {}).empty, false);
  });

  it('classifyError maps statuses', () => {
    const unreachable = classifyError({ networkError: 'econnreset' }, 'status');
    assert.equal(unreachable.error_type, 'unreachable');

    const aborted = classifyError({ networkError: 'AbortError: aborted' }, 'collect');
    assert.equal(aborted.error_type, 'unreachable');
    assert.match(aborted.hint || '', /MC_HTTP_LONG_ACTION_MS/i);
    assert.match(aborted.hint || '', /may still finish on the server/i);

    const conflict = classifyError({ httpStatus: 409 }, 'task_cancel');
    assert.equal(conflict.error_type, 'task_conflict');

    const nf = classifyError({ httpStatus: 404 }, 'go_mark');
    assert.equal(nf.error_type, 'not_found');

    const place400 = classifyError(
      {
        httpStatus: 400,
        json: {
          ok: false,
          error: 'No solid neighbor for cobblestone at 1,2,3. Neighbors: ...',
        },
      },
      'place',
    );
    assert.equal(place400.error_type, 'placement_blocked');
  });

  it('buildEnvelope shapes ok payloads with limit/fields', () => {
    const envOk = buildEnvelope({
      command: 'nearby',
      httpRes: {
        ok: true,
        httpStatus: 200,
        json: { ok: true, data: { entities: [1, 2, 3], foo: 'bar' } },
        text: '',
      },
      parsedParams: {},
      globals: { limit: 2, fields: ['entities'] },
    });
    assert.equal(envOk.ok, true);
    assert.deepEqual(envOk.data.entities, [1, 2]);
    assert.strictEqual(envOk.data.foo, undefined);

    const envBad = buildEnvelope({
      command: 'collect',
      httpRes: {
        ok: true,
        httpStatus: 200,
        json: { ok: false, error: "can't see oak_log from here" },
        text: '',
      },
      parsedParams: {},
      globals: {},
    });
    assert.equal(envBad.ok, false);
    assert.equal(envBad.error_type, 'blocked');

    const envHint = buildEnvelope({
      command: 'craft',
      httpRes: {
        ok: false,
        httpStatus: 400,
        json: {
          ok: false,
          error: 'Missing ingredients.',
          hint: 'Try mc recipes wooden_axe first.',
        },
        text: '',
      },
      parsedParams: {},
      globals: {},
    });
    assert.equal(envHint.ok, false);
    assert.equal(envHint.hint, 'Try mc recipes wooden_axe first.');
  });

  // ─── F8 (task #46): Phase-2 nested envelope extraction ─────────────────
  // Pre-fix, action-contract refusals showed the agent `Hint: Request failed`
  // because the CLI looked at `js.error` (string) and `js.hint` (top-level),
  // but the contract puts both at js.error.message and js.error.next_action_hint.

  it('classifyError extracts message from Phase-2 envelope (js.error is object)', () => {
    const r = classifyError(
      {
        httpStatus: 200,
        ok: true,
        json: {
          ok: false,
          error: {
            code: 'NO_NAVIGABLE_ROUTE',
            message: "Can't plan a water route: No navigable water cell within 12b of start.",
            next_action_hint: 'mc bg_goto <coast coords>  # then mc sail_to again',
            observed_state: { foo: 'bar' },
          },
        },
      },
      'sail_to',
    );
    // The hint must contain the real message, NOT 'Request failed'.
    assert.match(r.hint, /Can't plan a water route/);
    assert.doesNotMatch(r.hint, /Request failed/);
  });

  it('buildEnvelope surfaces next_action_hint from Phase-2 envelope', () => {
    const env = buildEnvelope({
      command: 'sail_to',
      httpRes: {
        ok: true,
        httpStatus: 200,
        json: {
          ok: false,
          error: {
            code: 'NO_NAVIGABLE_ROUTE',
            message: "Can't plan a water route: No navigable water cell within 12b of start.",
            next_action_hint: 'mc bg_goto <coast coords>  # then mc sail_to again',
            observed_state: { water_route_error: 'NO_WATER_ROUTE' },
          },
        },
        text: '',
      },
      parsedParams: {},
      globals: {},
    });
    assert.equal(env.ok, false);
    // The agent-visible hint must be the body's next_action_hint, NOT a fallback.
    assert.match(env.hint, /mc bg_goto/);
    assert.match(env.hint, /sail_to again/);
    assert.doesNotMatch(env.hint, /Request failed/);
  });

  it('buildEnvelope prefers nested next_action_hint over top-level js.hint', () => {
    // If both are present, the nested one (action contract canonical) wins.
    const env = buildEnvelope({
      command: 'sail_to',
      httpRes: {
        ok: true,
        httpStatus: 200,
        json: {
          ok: false,
          hint: 'legacy top-level hint',
          error: {
            code: 'SAIL_TO_RETRY_LOOP',
            message: 'Retried too many times.',
            next_action_hint: 'mc advise --reason="sail_to stuck retrying"',
          },
        },
        text: '',
      },
      parsedParams: {},
      globals: {},
    });
    assert.match(env.hint, /mc advise/);
    assert.doesNotMatch(env.hint, /legacy top-level/);
  });
});
