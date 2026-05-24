import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { playerNamesFromMarkersJson } from '../lib/world-map.js';

describe('world-map players', () => {
  it('playerNamesFromMarkersJson reads GeoJSON features', () => {
    const body = {
      type: 'FeatureCollection',
      features: [{ properties: { name: 're44' } }],
    };
    assert.deepEqual(playerNamesFromMarkersJson(body), ['re44']);
  });

  it('playerNamesFromMarkersJson reads layer markers', () => {
    const body = [
      {
        id: 'players',
        markers: [{ name: 're44' }, { name: 'Alex' }],
      },
    ];
    const names = playerNamesFromMarkersJson(body);
    assert.deepEqual(names.sort(), ['Alex', 're44']);
  });
});
