import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionRegistry } from '../lib/server/action-registry.js';

test('createActionRegistry lists only callable handlers', () => {
  const reg = createActionRegistry({
    a: async () => {},
    b: () => {},
    notFn: 3,
  });
  assert.deepEqual(reg.names(), ['a', 'b']);
  assert.equal(reg.has('a'), true);
  assert.equal(reg.has('missing'), false);
  assert.equal(reg.get('b'), reg.get('b'));
});
