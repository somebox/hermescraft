import test from 'node:test';
import assert from 'node:assert/strict';
import {
  placementCellInsight,
  nearbyPlacementBlockersFromHits,
} from '../../lib/shared/placement-insight.js';

test('placementCellInsight: chest blocks placement with dig hint', () => {
  const r = placementCellInsight('chest', { x: 1, y: 64, z: 2 }, {});
  assert.equal(r.blocks_placement, true);
  assert.equal(r.is_relocatable, true);
  assert.match(r.placement_hint, /mc dig 1 64 2/);
  assert.match(r.placement_hint, /blocks mc place/);
});

test('placementCellInsight: air does not block placement', () => {
  const r = placementCellInsight('air', { x: 0, y: 64, z: 0 }, {});
  assert.equal(r.blocks_placement, false);
});

test('nearbyPlacementBlockersFromHits: surfaces close chest', () => {
  const hits = [
    {
      name: 'chest',
      position: { x: 2, y: 64, z: 3 },
      distance: '2.1',
      sector: 'center',
    },
    { name: 'stone', position: { x: 10, y: 64, z: 10 }, distance: '12', sector: 'right' },
  ];
  const blockers = nearbyPlacementBlockersFromHits(hits, {}, { maxDistance: 5 });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].name, 'chest');
  assert.equal(blockers[0].coord.x, 2);
});

test('nearbyPlacementBlockersFromHits: excludeCoord drops the crosshair cell', () => {
  const hits = [
    { name: 'chest', position: { x: 2, y: 64, z: 3 }, distance: 2.1, sector: 'center' },
    { name: 'furnace', position: { x: 4, y: 64, z: 3 }, distance: 3.0, sector: 'right' },
  ];
  const blockers = nearbyPlacementBlockersFromHits(hits, {}, {
    maxDistance: 5,
    excludeCoord: { x: 2, y: 64, z: 3 },
  });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].name, 'furnace');
});
