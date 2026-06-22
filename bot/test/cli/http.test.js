import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ACTION_DEADLINE_MS,
  classifyPathDeadline,
  LONG_ACTION_DEADLINE_MS,
  READ_DEADLINE_MS,
  requestHttp,
} from '../../cli/http.mjs';

describe('cli http deadlines', () => {
  it('GET uses read deadline', () => {
    assert.strictEqual(classifyPathDeadline('GET', '/anything'), READ_DEADLINE_MS);
  });

  it('short POST keeps default action deadline', () => {
    assert.strictEqual(classifyPathDeadline('POST', '/action/stop'), ACTION_DEADLINE_MS);
  });

  it('collect, dig, dig_area, and pillar_step use long action deadline', () => {
    assert.strictEqual(classifyPathDeadline('POST', '/action/collect'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/dig'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/dig_area'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/pillar_step'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/task/start'), LONG_ACTION_DEADLINE_MS);
  });

  it('compound primitives (stair/tunnel/move/goto) use long action deadline — 2026-05-26 hut1 fix', () => {
    assert.strictEqual(classifyPathDeadline('POST', '/action/stair_down'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/stair_up'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/tunnel'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/move'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/goto'), LONG_ACTION_DEADLINE_MS);
  });

  it('bulk shape primitives use long action deadline', () => {
    assert.strictEqual(classifyPathDeadline('POST', '/action/safe_dig'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/dig_pit'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/level'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/wall'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/place_fill'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/build_stairs'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/till_area'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/task/place_fill'), LONG_ACTION_DEADLINE_MS);
  });

  it('ignores query string when classifying path', () => {
    assert.strictEqual(
      classifyPathDeadline('POST', '/action/collect?x=1'),
      LONG_ACTION_DEADLINE_MS,
    );
  });

  it('POST abort returns network error without retries (L3 attribution baseline)', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async () => {
        calls += 1;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      };
      const r = await requestHttp('http://127.0.0.1:3000', '/action/fell_tree', { method: 'POST' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.httpStatus, 0);
      assert.match(String(r.networkError || ''), /aborted/i);
      assert.strictEqual(calls, 1, 'POST path should not retry on abort');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
