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
});
