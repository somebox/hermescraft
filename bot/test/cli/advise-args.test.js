/**
 * F17 (task #55): regression test for `mc advise --target` with
 * negative coordinates.
 *
 * v38 saw the agent's `mc advise --target -300,63,-100` fail with
 *   "argument --target: expected one argument"
 * because Python's argparse mis-read the negative-prefix value as
 * another flag when it was passed as two separate argv tokens
 * (`--target` + `-300,63,-100`).
 *
 * The fix: pass the value joined with `=` (`--target=-300,63,-100`),
 * which argparse always parses as a single value regardless of the
 * leading `-`. Verify the spawn argv shape directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAdviseArgs } from '../../cli/advise.mjs';

test('buildAdviseArgs: --target uses = form for negative coords (F17)', () => {
  const args = buildAdviseArgs({
    reason: 'find shore',
    apiBase: 'http://localhost:3001',
    target: { x: -300, y: 63, z: -100 },
  });
  // The critical assertion: the --target piece is ONE arg containing
  // an `=`. Pre-fix this was two separate args (`--target` and
  // `-300,63,-100`), which argparse couldn't parse.
  const targetArgs = args.filter((a) => a.startsWith('--target'));
  assert.equal(targetArgs.length, 1, `expected exactly 1 --target arg, got ${JSON.stringify(args)}`);
  assert.equal(targetArgs[0], '--target=-300,63,-100');
  // Belt-and-suspenders: ensure no orphan negative-coord string
  // lingers as a separate arg (which would be misread by argparse).
  for (const a of args) {
    if (a === '--target') {
      assert.fail(`--target should be passed as --target=... single arg, found bare --target in ${JSON.stringify(args)}`);
    }
  }
});

test('buildAdviseArgs: --target uses = form for positive coords too (consistency)', () => {
  const args = buildAdviseArgs({
    reason: 'find shore',
    apiBase: 'http://localhost:3001',
    target: { x: 500, y: 64, z: 100 },
  });
  const targetArgs = args.filter((a) => a.startsWith('--target'));
  assert.equal(targetArgs.length, 1);
  assert.equal(targetArgs[0], '--target=500,64,100');
});

test('buildAdviseArgs: no --target when target omitted', () => {
  const args = buildAdviseArgs({
    reason: 'general advise',
    apiBase: 'http://localhost:3001',
  });
  assert.equal(args.some((a) => a.startsWith('--target')), false);
});

test('buildAdviseArgs: skips --target when any coord is non-finite', () => {
  const args = buildAdviseArgs({
    reason: 'bad input',
    apiBase: 'http://localhost:3001',
    target: { x: Number.NaN, y: 64, z: 100 },
  });
  assert.equal(args.some((a) => a.startsWith('--target')), false);
});

test('buildAdviseArgs: reason + apiBase always first (script invocation contract)', () => {
  const args = buildAdviseArgs({
    reason: 'first thing',
    apiBase: 'http://localhost:3001',
    target: { x: -1, y: -1, z: -1 },
  });
  // The script path is args[0]. Then --reason + value, then --api-url + value.
  assert.equal(args[1], '--reason');
  assert.equal(args[2], 'first thing');
  assert.equal(args[3], '--api-url');
  assert.equal(args[4], 'http://localhost:3001');
});
