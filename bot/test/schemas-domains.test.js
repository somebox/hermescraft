import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DOMAINS, isDomain } from '../lib/shared/domains.js';
import { okEnvelope, errEnvelope, assertDomain } from '../lib/shared/schemas.js';
import { createBotState } from '../lib/server/state.js';
import { loadConfig } from '../lib/config/index.js';

describe('domains', () => {
  it('DOMAINS matches CLI category vocabulary length', () => {
    assert.strictEqual(DOMAINS.length, 10);
    assert.ok(DOMAINS.includes('world'));
    assert.ok(isDomain('task'));
    assert.strictEqual(isDomain('bogus'), false);
  });
});

describe('schemas', () => {
  it('okEnvelope builds consistent shape', () => {
    const o = okEnvelope({ result: 'ok', data: { x: 1 }, state: { hp: 20 } });
    assert.strictEqual(o.ok, true);
    assert.strictEqual(o.result, 'ok');
    assert.deepStrictEqual(o.data, { x: 1 });
    assert.deepStrictEqual(o.state, { hp: 20 });
  });

  it('errEnvelope includes code and message', () => {
    const e = errEnvelope({ code: 'missing_item', message: 'none', details: { item: 'coal' } });
    assert.strictEqual(e.ok, false);
    assert.strictEqual(e.code, 'missing_item');
    assert.strictEqual(e.message, 'none');
    assert.deepStrictEqual(e.details, { item: 'coal' });
  });

  it('assertDomain throws on invalid', () => {
    assert.throws(() => assertDomain('nope'), /invalid_domain/);
    assert.doesNotThrow(() => assertDomain('observe'));
  });
});

describe('createBotState', () => {
  it('two instances do not share mutable arrays', () => {
    const config = loadConfig(['node', 'server.js']);
    const a = createBotState(config);
    const b = createBotState(config);
    a.social.chatLog.push({ x: 1 });
    assert.strictEqual(b.social.chatLog.length, 0);
    assert.notStrictEqual(a.reactive.observedBlocks, b.reactive.observedBlocks);
  });

  it('stores config reference', () => {
    const c = loadConfig(['node', 'server.js', '--port', '4000']);
    const ctx = createBotState(c);
    assert.strictEqual(ctx.config.api.port, 4000);
  });
});
