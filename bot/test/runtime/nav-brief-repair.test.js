import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNavBrief,
  buildK1RepairHint,
  renderNavBrief,
  rayFirstSolidBlocker,
} from '../../lib/runtime/nav-brief.js';

function makeBot({ pos, blocks = {} }) {
  const blockAt = (x, y, z) => {
    let cx = x; let cy = y; let cz = z;
    if (x && typeof x === 'object' && 'x' in x) {
      cx = x.x; cy = x.y; cz = x.z;
    }
    const key = `${cx},${cy},${cz}`;
    const name = blocks[key];
    if (!name) return { name: 'air', boundingBox: 'empty' };
    return { name, boundingBox: 'block' };
  };
  return {
    entity: { position: pos },
    blockAt,
  };
}

test('buildK1RepairHint emits composite dig → move when confirm passes', () => {
  const bot = makeBot({
    pos: { x: 272.5, y: 38.5, z: 82.5 },
    blocks: { '273,38,82': 'stone' },
  });
  const ctx = { runtime: {} };
  const loc = { name: 'base_anchor', x: 305, y: 64, z: -52 };
  const hint = buildK1RepairHint(ctx, bot, loc, {
    computeReachability: () => ({
      walkable_to_target: false,
      next_hop_suggestion: { x: 273, y: 38, z: 82 },
    }),
    confirmK1Repair: () => true,
  });
  assert.ok(hint?.composite?.includes('dig 273 38 82'));
  assert.ok(hint.composite.includes('→ move base_anchor'));
});

test('buildK1RepairHint refuses protected blocker cells', () => {
  const bot = makeBot({
    pos: { x: 10.5, y: 64.5, z: 10.5 },
    blocks: { '11,64,10': 'stone' },
  });
  const ctx = { runtime: {} };
  const hint = buildK1RepairHint(ctx, bot, { name: 'chest_food', x: 20, y: 64, z: 10 }, {
    computeReachability: () => ({
      walkable_to_target: false,
      next_hop_suggestion: { x: 11, y: 64, z: 10 },
    }),
    shouldSkipDigAt: () => ({ skip: true, regionId: 'base1' }),
    confirmK1Repair: () => true,
  });
  assert.equal(hint.refused, true);
  assert.match(hint.reason, /protect:base1/);
});

test('computeNavBrief attaches k=1 composite on nearest blocked mark when all blocked', () => {
  const bot = makeBot({
    pos: { x: 276.5, y: 64.5, z: 78.5 },
    blocks: { '277,64,78': 'cobblestone' },
  });
  const ctx = {
    world: { bot, botReady: true },
    runtime: { navTrail: { crumbs: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }] } },
  };
  const result = computeNavBrief(ctx, {
    loadLocations: () => ({
      base_anchor: { x: 305, y: 64, z: -52 },
      chest_food: { x: 298, y: 64, z: -48 },
    }),
    getStandingState: () => ({ classification: 'open', open_dirs: ['n', 's', 'e', 'w'] }),
    getPathTo: () => ({ status: 'noPath' }),
    computeReachability: () => ({
      walkable_to_target: false,
      next_hop_suggestion: { x: 277, y: 64, z: 78 },
    }),
    confirmK1Repair: () => true,
    now: () => 2_000_000,
    budgetMs: 500,
  });

  const chest = result.brief.paths.find((p) => p.label === 'chest_food');
  assert.ok(chest?.composite_hint);
  assert.ok(chest.suggested);
  assert.equal(chest.via_k1_repair, true);
  const text = renderNavBrief(result.brief);
  assert.match(text, /dig 277 64 78 → move chest_food/);
});

test('rayFirstSolidBlocker finds solid on segment toward goal', () => {
  const bot = makeBot({
    pos: { x: 0.5, y: 64.5, z: 0.5 },
    blocks: { '2,64,0': 'dirt' },
  });
  const cell = rayFirstSolidBlocker(bot, { x: 10, y: 64, z: 0 });
  assert.deepEqual(cell, { x: 2, y: 64, z: 0, block: 'dirt' });
});
