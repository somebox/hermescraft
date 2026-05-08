import { describe, it } from 'node:test';
import assert from 'node:assert';
import { stripGlobalFlags, positionalToParams, normalizeMark } from '../../cli/args.mjs';

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
});
