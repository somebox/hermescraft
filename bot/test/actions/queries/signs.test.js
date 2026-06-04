/**
 * nearby_signs — list signs within RADIUS with read-back text + owner_poi
 * cross-reference. The owner_poi cross-ref is what makes this verb a
 * navigation primitive rather than just a `findBlocks` wrapper.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSignsQueries } from '../../../lib/actions/queries/signs.js';
import { assertFailure } from '../../_helpers/action-harness.js';

/**
 * Build a minimal bot stub with:
 *   - `entity.position` at origin
 *   - `findBlocks` returning the supplied sign coords (Vec3-ish {x,y,z})
 *   - `blockAt` returning a sign block with text from `signsByCoord`
 *     keyed `${x},${y},${z}`; everything else is air.
 *
 * The shape lets us test (a) zero-results path, (b) modern signText array,
 * (c) legacy signEntity.text, and (d) owner_poi cross-ref by injecting
 * `loadPersonalPois`.
 */
function makeBot({ positions = [], signsByCoord = {}, throwsOnFind = false } = {}) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    findBlocks: ({ matching, maxDistance, count }) => {
      if (throwsOnFind) throw new Error('chunk not loaded');
      assert.equal(typeof matching, 'function', 'findBlocks should receive a predicate fn');
      assert.equal(maxDistance > 0, true);
      assert.equal(typeof count, 'number');
      // Sanity: the predicate must accept a sign block.
      assert.equal(matching({ name: 'oak_sign' }), true);
      assert.equal(matching({ name: 'stone' }), false);
      assert.equal(matching({ name: 'oak_wall_sign' }), true);
      return positions.slice(0, count);
    },
    blockAt: (pos) => {
      const k = `${pos.x},${pos.y},${pos.z}`;
      const stub = signsByCoord[k];
      if (stub) return stub;
      return { name: 'air' };
    },
  };
}

test('nearby_signs: zero signs nearby → empty list, ok result', async () => {
  const bot = makeBot();
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({}),
  });
  const r = await nearby_signs({});
  assert.equal(r.ok, true);
  assert.match(r.result, /No signs within 32 blocks/);
  assert.deepEqual(r.data.signs, []);
  assert.equal(r.data.radius, 32);
});

test('nearby_signs: clamps radius to [4, 64]', async () => {
  const bot = makeBot();
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({}),
  });
  const small = await nearby_signs({ radius: 1 });
  assert.equal(small.data.radius, 4);
  const big = await nearby_signs({ radius: 9999 });
  assert.equal(big.data.radius, 64);
});

test('nearby_signs: modern signText array surfaces 4 lines + distance', async () => {
  const positions = [{ x: 3, y: 64, z: 4 }];  // 5m away
  const signsByCoord = {
    '3,64,4': { name: 'oak_sign', signText: ['spider hill', 'great view', '', ''] },
  };
  const bot = makeBot({ positions, signsByCoord });
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({}),
  });
  const r = await nearby_signs({});
  assert.equal(r.ok, true);
  assert.equal(r.data.signs.length, 1);
  assert.deepEqual(r.data.signs[0].lines, ['spider hill', 'great view', '', '']);
  assert.equal(r.data.signs[0].dist, 5);
  assert.equal(r.data.signs[0].owner_poi, null);
  assert.match(r.result, /spider hill \/ great view/);
});

test('nearby_signs: legacy signEntity.text (newline string) parses to 4 lines', async () => {
  const positions = [{ x: 0, y: 64, z: 8 }];
  const signsByCoord = {
    '0,64,8': {
      name: 'birch_wall_sign',
      signEntity: { text: 'cairn\nnorth gate' },
    },
  };
  const bot = makeBot({ positions, signsByCoord });
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({}),
  });
  const r = await nearby_signs({ radius: 16 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.signs[0].lines, ['cairn', 'north gate', '', '']);
});

test('nearby_signs: owner_poi populated from personal POI store when sign_at matches', async () => {
  const positions = [
    { x: 3, y: 64, z: 4 },  // anchors POI "spider_hill"
    { x: 9, y: 64, z: 0 },  // unowned
  ];
  const signsByCoord = {
    '3,64,4': { name: 'oak_sign', signText: ['spider hill'] },
    '9,64,0': { name: 'oak_sign', signText: ['??'] },
  };
  const bot = makeBot({ positions, signsByCoord });
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({
      spider_hill: { name: 'spider_hill', x: 3, y: 64, z: 4, sign_at: { x: 3, y: 64, z: 4 } },
      cairn_west: { name: 'cairn_west', x: -50, y: 64, z: 0, sign_at: { x: -50, y: 64, z: 0 } },
    }),
  });
  const r = await nearby_signs({});
  assert.equal(r.ok, true);
  const byCoord = Object.fromEntries(r.data.signs.map((s) => [`${s.x},${s.y},${s.z}`, s]));
  assert.equal(byCoord['3,64,4'].owner_poi, 'spider_hill');
  assert.equal(byCoord['9,64,0'].owner_poi, null);
  assert.match(r.result, /\[poi=spider_hill\]/);
});

test('nearby_signs: sorts results by distance ascending', async () => {
  const positions = [
    { x: 10, y: 64, z: 0 },  // 10m
    { x: 3, y: 64, z: 0 },   // 3m
    { x: 5, y: 64, z: 0 },   // 5m
  ];
  const signsByCoord = Object.fromEntries(
    positions.map((p) => [`${p.x},${p.y},${p.z}`, { name: 'oak_sign', signText: ['s'] }]),
  );
  const bot = makeBot({ positions, signsByCoord });
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({}),
  });
  const r = await nearby_signs({});
  assert.deepEqual(r.data.signs.map((s) => s.dist), [3, 5, 10]);
});

test('nearby_signs: skips positions where blockAt is not a sign (chunk shifted under us)', async () => {
  const positions = [
    { x: 3, y: 64, z: 0 },
    { x: 5, y: 64, z: 0 },  // chunk shifted; now air
  ];
  const signsByCoord = {
    '3,64,0': { name: 'oak_sign', signText: ['real'] },
    // 5,64,0 missing → blockAt returns air, must be skipped
  };
  const bot = makeBot({ positions, signsByCoord });
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({}),
  });
  const r = await nearby_signs({});
  assert.equal(r.data.signs.length, 1);
  assert.equal(r.data.signs[0].x, 3);
});

test('nearby_signs: findBlocks throws → FIND_BLOCKS_FAILED, retry_safe', async () => {
  const bot = makeBot({ throwsOnFind: true });
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({}),
  });
  const r = await nearby_signs({});
  assertFailure(r, { code: 'FIND_BLOCKS_FAILED', retrySafe: true });
});

test('nearby_signs: findBlocks unavailable → FIND_BLOCKS_UNAVAILABLE', async () => {
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => null };
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({}),
  });
  const r = await nearby_signs({});
  assertFailure(r, { code: 'FIND_BLOCKS_UNAVAILABLE', retrySafe: true });
});

test('nearby_signs: missing loadPersonalPois works (owner_poi stays null)', async () => {
  const positions = [{ x: 3, y: 64, z: 4 }];
  const signsByCoord = {
    '3,64,4': { name: 'oak_sign', signText: ['anon'] },
  };
  const bot = makeBot({ positions, signsByCoord });
  const { nearby_signs } = createSignsQueries({ ensureBot: () => bot });
  const r = await nearby_signs({});
  assert.equal(r.ok, true);
  assert.equal(r.data.signs[0].owner_poi, null);
});

test('nearby_signs: blank sign renders as "(blank)" in result text but lines preserved', async () => {
  const positions = [{ x: 0, y: 64, z: 3 }];
  const signsByCoord = {
    '0,64,3': { name: 'oak_sign', signText: ['', '', '', ''] },
  };
  const bot = makeBot({ positions, signsByCoord });
  const { nearby_signs } = createSignsQueries({
    ensureBot: () => bot,
    loadPersonalPois: () => ({}),
  });
  const r = await nearby_signs({});
  assert.match(r.result, /\(blank\)/);
  assert.deepEqual(r.data.signs[0].lines, ['', '', '', '']);
});
