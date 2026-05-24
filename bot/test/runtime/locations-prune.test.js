import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocationsStore } from '../../lib/runtime/locations.js';

test('pruneDeathMarks keeps only the newest N death_* keys', () => {
  const store = createLocationsStore({ dataDir: '/tmp/unused', username: 'x' });
  const locs = {
    home: { x: 1, y: 2, z: 3 },
    death_1: { x: 0 },
    death_2: { x: 0 },
    death_3: { x: 0 },
    death_4: { x: 0 },
  };
  store.pruneDeathMarks(locs, 3);
  assert.deepEqual(Object.keys(locs).sort(), ['death_2', 'death_3', 'death_4', 'home']);
});
