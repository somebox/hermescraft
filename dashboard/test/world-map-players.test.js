import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { playerNamesFromMarkersJson, parseSquaremapWorldZoom, initialMapZoom } from '../lib/world-map.js';

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

describe('squaremap zoom', () => {
  it('parseSquaremapWorldZoom reads max and extra', () => {
    assert.deepEqual(parseSquaremapWorldZoom({ zoom: { def: 3, max: 3, extra: 2 } }), {
      def: 3,
      max: 3,
      extra: 2,
      uiMax: 5,
    });
  });

  it('initialMapZoom clamps registry default to uiMax', () => {
    const cfg = { iframeDefaults: { zoom: 6 }, hermesToTileWorld: {}, baseUrl: 'http://x' };
    const lim = { def: 3, max: 3, extra: 2, uiMax: 5 };
    assert.equal(initialMapZoom(cfg, lim), 5);
    assert.equal(initialMapZoom({ ...cfg, iframeDefaults: { zoom: 4 } }, lim), 4);
  });
});
