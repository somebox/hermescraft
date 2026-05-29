import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStandingSituation } from '../../lib/shared/perception.js';

test('formatStandingSituation: pit with open sky', () => {
  const line = formatStandingSituation({
    classification: 'trapped',
    ceiling_within: null,
    head_blocked: false,
  });
  assert.ok(line?.includes('open sky'));
});

test('formatStandingSituation: sealed enclosure', () => {
  const line = formatStandingSituation({
    classification: 'enclosure_inside',
    ceiling_within: 2,
    head_blocked: false,
  });
  assert.ok(line?.includes('Sealed'));
});

test('formatStandingSituation: head blocked', () => {
  const line = formatStandingSituation({
    classification: 'open',
    head_blocked: true,
  });
  assert.ok(line?.includes('Head-level'));
});
