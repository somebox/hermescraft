/**
 * mc reachable — honest path-check contract.
 *
 * proc-nav-1781014144: `reachable` answered standability only, and agents
 * read "standable" as "I can get there" — confident retries against targets
 * the pathfinder could never reach. The verb now runs the executor's own
 * pathfinder (getPathTo, NO movement) and reports path: {exists, length,
 * approximate, status, checked_cell} alongside the standability fields.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueriesActions } from '../../lib/actions/queries.js';
import { createMockServices } from '../../lib/server/mock-services.js';

const PASSABLE = new Set(['air', 'cave_air', 'void_air']);

function makeBot(terrain, { getPathTo, botPos = { x: 0, y: 65, z: 0 } } = {}) {
  return {
    entity: {
      position: {
        ...botPos,
        distanceTo: (v) => Math.hypot(v.x - botPos.x, v.y - botPos.y, v.z - botPos.z),
      },
    },
    game: { minY: -64, height: 384 },
    inventory: { items: () => [] },
    ...(getPathTo ? { pathfinder: { movements: {}, getPathTo } } : {}),
    blockAt({ x, y, z }) {
      const k = `${x},${y},${z}`;
      const t = terrain.get(k);
      if (!t) return { name: 'air', boundingBox: 'empty', position: { x, y, z } };
      return { name: t, boundingBox: PASSABLE.has(t) ? 'empty' : 'block', position: { x, y, z } };
    },
  };
}

function makeQueries(bot) {
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
  });
  return createQueriesActions(services);
}

/** Solid ground at block_y, so feet at block_y+1 are standable. */
function groundColumn(t, x, z, blockY = 64) {
  t.set(`${x},${blockY},${z}`, 'grass_block');
}

test('reachable: standable + pathfinder success → path.exists with length', async () => {
  const t = new Map();
  groundColumn(t, 10, 0);
  let seenBudget = null;
  const q = makeQueries(makeBot(t, {
    getPathTo: (_movements, _goal, budget) => {
      seenBudget = budget;
      return { status: 'success', path: new Array(7) };
    },
  }));
  const r = await q.reachable({ x: 10, y: 65, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target_standable, true);
  assert.equal(r.data.path.exists, true);
  assert.equal(r.data.path.approximate, false);
  assert.equal(r.data.path.length, 7);
  assert.deepEqual(r.data.path.checked_cell, { x: 10, y: 65, z: 0 });
  assert.match(r.result, /Path found from your position \(7 blocks\)/);
  assert.ok(seenBudget >= 1000 && seenBudget <= 3000, `budget ${seenBudget} outside clamp`);
});

test('reachable: standable but noPath → path.exists=false with blunt warning', async () => {
  const t = new Map();
  groundColumn(t, 10, 0);
  const q = makeQueries(makeBot(t, {
    getPathTo: () => ({ status: 'noPath', path: [] }),
  }));
  const r = await q.reachable({ x: 10, y: 65, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target_standable, true);
  assert.equal(r.data.path.exists, false);
  assert.equal(r.data.path.approximate, false);
  assert.match(r.result, /NO path found from your position/);
});

test('reachable: pathfinder timeout/partial → approximate=true, not a hard no', async () => {
  const t = new Map();
  groundColumn(t, 10, 0);
  for (const status of ['timeout', 'partial']) {
    const q = makeQueries(makeBot(t, {
      getPathTo: () => ({ status, path: new Array(3) }),
    }));
    const r = await q.reachable({ x: 10, y: 65, z: 0 });
    assert.equal(r.data.path.exists, false, status);
    assert.equal(r.data.path.approximate, true, status);
    assert.match(r.result, /inconclusive/, status);
    assert.ok(!/NO path found/.test(r.result), `${status} must not claim a hard no`);
  }
});

test('reachable: no pathfinder bound → path=null, standability answer unchanged', async () => {
  const t = new Map();
  groundColumn(t, 10, 0);
  const q = makeQueries(makeBot(t));
  const r = await q.reachable({ x: 10, y: 65, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target_standable, true);
  assert.equal(r.data.path, null);
  assert.equal(r.result, 'Cell 10,65,0 is standable.');
});

test('reachable: getPathTo throwing never breaks the standability answer', async () => {
  const t = new Map();
  groundColumn(t, 10, 0);
  const q = makeQueries(makeBot(t, {
    getPathTo: () => { throw new Error('pathfinder exploded'); },
  }));
  const r = await q.reachable({ x: 10, y: 65, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data.target_standable, true);
  assert.equal(r.data.path, null);
});

test('reachable: target not standable → probe runs against best_stand cell', async () => {
  const t = new Map();
  // Target column is sealed (solid at feet level); neighbor is standable.
  groundColumn(t, 10, 0);
  t.set('10,65,0', 'stone'); // feet blocked at target
  groundColumn(t, 11, 0);
  let probed = null;
  const q = makeQueries(makeBot(t, {
    getPathTo: (_m, goal) => {
      probed = { x: goal.x, y: goal.y, z: goal.z };
      return { status: 'success', path: new Array(12) };
    },
  }));
  const r = await q.reachable({ x: 10, y: 65, z: 0, range: 3 });
  assert.equal(r.data.target_standable, false);
  assert.ok(r.data.best_stand, 'expected a best_stand cell');
  assert.deepEqual(r.data.path.checked_cell, {
    x: r.data.best_stand.x, y: r.data.best_stand.y, z: r.data.best_stand.z,
  });
  assert.ok(probed, 'getPathTo should have been called for best_stand');
  assert.match(r.result, /NOT standable .* Closest standable cell.*Path found/s);
});
