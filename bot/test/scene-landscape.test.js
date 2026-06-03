import test from 'node:test';
import assert from 'node:assert/strict';
import {
  yBandLabel,
  pickSuggestedCardinalLabel,
  formatLandscapeClause,
} from '../lib/shared/scene-landscape.js';

test('yBandLabel buckets elevation', () => {
  assert.match(yBandLabel(96), /high/);
  assert.match(yBandLabel(80), /mid/);
  assert.match(yBandLabel(65), /low/);
});

test('pickSuggestedCardinalLabel prefers downhill walk', () => {
  assert.equal(pickSuggestedCardinalLabel({ N: 2, E: 0, S: -5, W: 1 }), 'S');
});

test('formatLandscapeClause is compact', () => {
  const s = formatLandscapeClause({
    biome: 'plains',
    yBand: 'mid (72-95)',
    reliefFormatted: 'N+2 E-1 S+0 W+0',
    treesText: 'trees: 0 (bare)',
  });
  assert.match(s, /plains/);
  assert.match(s, /N\+2/);
});
