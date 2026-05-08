import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { parseBody } from '../lib/router.js';

function mockReq(chunks) {
  const req = new EventEmitter();
  queueMicrotask(async () => {
    for (const c of chunks) {
      req.emit('data', typeof c === 'string' ? Buffer.from(c) : c);
    }
    req.emit('end');
  });
  return req;
}

test('parseBody parses JSON object', async () => {
  const req = mockReq(['{"a":1}']);
  const body = await parseBody(req);
  assert.deepEqual(body, { a: 1 });
});

test('parseBody rejects invalid JSON', async () => {
  const req = mockReq(['{not json']);
  await assert.rejects(parseBody(req), /Invalid JSON body/);
});
