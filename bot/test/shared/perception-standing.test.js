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

test('formatStandingSituation: standing on a chest takes priority and warns about destroying it', () => {
  const line = formatStandingSituation({
    classification: 'open',
    head_blocked: false,
    standing_on: {
      is_entity: false,
      name: 'chest',
      coord: { x: 1, y: 63, z: 2 },
      significant: true,
      reason: 'interactable',
    },
  });
  assert.match(line, /Standing on chest at 1,63,2/);
  assert.match(line, /destroys it/);
});

test('formatStandingSituation: standing on a mob explains it is not solid ground', () => {
  const line = formatStandingSituation({
    classification: 'in_air',
    standing_on: {
      is_entity: true,
      entity_name: 'pig',
      coord: { x: 1, y: 63, z: 2 },
      significant: true,
      reason: 'entity',
    },
  });
  assert.match(line, /Standing on pig/);
  assert.match(line, /not solid ground/);
});

test('formatStandingSituation: lone pillar block warns against stranding', () => {
  const line = formatStandingSituation({
    classification: 'on_pillar',
    standing_on: {
      is_entity: false,
      name: 'stone',
      coord: { x: 5, y: 64, z: 5 },
      significant: true,
      reason: 'isolated_block',
    },
  });
  assert.match(line, /lone stone/);
  assert.match(line, /pillar_down/);
});

test('formatStandingSituation: insignificant ground block does not produce a line', () => {
  const line = formatStandingSituation({
    classification: 'open',
    head_blocked: false,
    standing_on: { is_entity: false, name: 'grass_block', coord: { x: 0, y: 63, z: 0 }, significant: false },
  });
  assert.equal(line, null);
});
