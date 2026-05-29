/**
 * Audited numeric caps (mc-command-audit §D) — regression guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RAW_COMMAND_DEFS } from '../cli/registry.mjs';

const EXPECTED = [
  ['map', 'radius', { min: 1, max: 16 }],
  ['wait', 'seconds', { min: 0.1, max: 300 }],
  ['fight', 'duration', { min: 1, max: 600 }],
  ['complete_command', 'index', { min: 0, max: 100 }],
  ['hunt', 'count', { min: 1, max: 64 }],
  ['dig_pit', 'w', { min: 1, max: 64 }],
];

function specFor(name) {
  return RAW_COMMAND_DEFS.find((c) => c.name === name);
}

function argFor(cmd, key) {
  return cmd?.argSchema?.find((a) => a.key === key);
}

test('audited argSchema fields expose min/max', () => {
  const missing = [];
  for (const [name, key, want] of EXPECTED) {
    const cmd = specFor(name);
    const arg = argFor(cmd, key);
    if (!arg) {
      missing.push(`${name}.${key}: no argSchema`);
      continue;
    }
    if (want.min != null && arg.min !== want.min) missing.push(`${name}.${key}.min=${arg.min} want ${want.min}`);
    if (want.max != null && arg.max !== want.max) missing.push(`${name}.${key}.max=${arg.max} want ${want.max}`);
  }
  assert.equal(missing.length, 0, missing.join('\n'));
});
