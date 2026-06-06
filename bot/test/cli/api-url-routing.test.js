import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl } from '../../cli/api-url.mjs';

describe('apiUrl routing', () => {
  const envKeys = ['_MC_API_URL_LOCKED', 'MC_API_URL', 'HERMES_KANBAN_TASK'];

  function withEnv(patch, fn) {
    const saved = {};
    for (const k of envKeys) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const k of envKeys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it('prefers _MC_API_URL_LOCKED for continuous agents', () => {
    withEnv(
      {
        _MC_API_URL_LOCKED: 'http://localhost:3005',
        MC_API_URL: 'http://localhost:3002',
      },
      () => assert.equal(apiUrl(), 'http://localhost:3005'),
    );
  });

  it('prefers MC_API_URL for kanban workers when lock disagrees', () => {
    withEnv(
      {
        HERMES_KANBAN_TASK: 't_test',
        _MC_API_URL_LOCKED: 'http://localhost:3005',
        MC_API_URL: 'http://localhost:3002',
      },
      () => assert.equal(apiUrl(), 'http://localhost:3002'),
    );
  });

  it('uses MC_API_URL when only profile url is set on a worker', () => {
    withEnv(
      {
        HERMES_KANBAN_TASK: 't_test',
        MC_API_URL: 'http://localhost:3003',
      },
      () => assert.equal(apiUrl(), 'http://localhost:3003'),
    );
  });
});
