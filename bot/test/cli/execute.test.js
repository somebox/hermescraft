import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { executeHttp } from '../../cli/execute.mjs';

describe('cli execute', () => {
  const fetchOrig = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = fetchOrig;
  });

  it('dryRun never calls fetch', async () => {
    let fired = false;
    globalThis.fetch = async () => {
      fired = true;
      return new Response('', { status: 500 });
    };

    await executeHttp(
      { canonicalName: 'health', def: { method: 'GET', path: '/health' } },
      [],
      { dryRun: true, json: true },
      { requestBuilder: (def) => ({ method: def.method, path: def.path, body: null, params: {} }), apiBase: 'http://localhost:9' },
    );
    assert.equal(fired, false);
  });

  it('parses envelope from HTTP JSON', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true, data: { pong: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const env = await executeHttp(
      { canonicalName: 'health', def: { method: 'GET', path: '/health' } },
      [],
      { json: true },
      { requestBuilder: (def) => ({ method: def.method, path: def.path, body: null, params: {} }), apiBase: 'http://127.0.0.1:9', debugLog: '' },
    );
    assert.equal(env.ok, true);
    assert.strictEqual(env.data.pong, true);
  });
});
