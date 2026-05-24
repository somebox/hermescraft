import test from 'node:test';
import assert from 'node:assert/strict';
import { regionBoundsPoints, regionHitTargetsFromLayout } from '../static/regions-map.js';
import { boundsXZ, worldToCanvas } from '../static/map2d.js';

test('region hit targets include region kind', () => {
  const regions = [
    {
      id: 'base1',
      intent: 'protect',
      status: 'active',
      anchor: { x: 0, y: 64, z: 0 },
      shape: { radius: 16 },
      sites: [{ name: 'tower', x: 5, z: 5 }],
    },
  ];
  const points = regionBoundsPoints(regions);
  const b = boundsXZ(points);
  const layout = { bounds: b, cw: 400, ch: 300, worldToCanvas };
  const hits = regionHitTargetsFromLayout(regions, layout);
  assert.ok(hits.some((h) => h.kind === 'region' && h.id === 'base1'));
});
