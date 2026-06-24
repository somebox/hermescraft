import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bool } from '../../lib/actions/_args.js';
import { coerceBool } from '../../lib/shared/bool-coerce.js';
import { coerceValue } from '../../cli/args.mjs';

describe('_args bool / CLI parity', () => {
  const cases = [
    [undefined, false, false],
    ['true', false, true],
    ['false', true, false],
    ['1', false, true],
    ['0', true, false],
    ['yes', false, true],
    ['no', true, false],
    ['on', false, true],
    ['off', true, false],
  ];

  for (const [raw, def, expected] of cases) {
    it(`coerceBool(${JSON.stringify(raw)}, ${def}) === ${expected}`, () => {
      assert.equal(coerceBool(raw, def), expected);
      assert.equal(bool(raw, def), expected);
    });
  }

  it('CLI boolean spec uses coerceBool', () => {
    assert.equal(coerceValue({ key: 'x', type: 'boolean' }, 'yes'), true);
    assert.equal(coerceValue({ key: 'x', type: 'boolean' }, 'off'), false);
  });
});
