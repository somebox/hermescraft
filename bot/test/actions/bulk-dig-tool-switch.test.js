/**
 * Per-block tool auto-switching across bulk dig operations.
 *
 * Requirement (2026-05-29): when a bot HAS the right tools and runs a bulk
 * dig that touches mixed materials (stair_down, tunnel, dig_area, …), it must
 * switch to a shovel for dirt/sand/gravel and a pickaxe for stone/ore (and an
 * axe for wood) on a per-block basis — not equip once and grind the whole
 * operation with the wrong tool.
 *
 * Audit (grep of `b.dig(` call sites in bot/lib): every terrain bulk op routes
 * each block through `equipForDig` before digging:
 *   - dig_area        excavation.js  (and tunnel delegates to dig_area)
 *   - stair_down      excavation.js  (digOne → equipForDig per cell)
 *   - stair_up        excavation.js  (ceiling dig + dig_area slice)
 *   - pillar_down     excavation.js  (equipForDig on the underfoot block)
 *   - mc dig / collect mining/*      (equipForDig / equipForDigCached)
 * (farming harvest digs mature crops by hand — no tool tier — so it's exempt.)
 *
 * These tests pin the switcher (`preferHarvestToolForBlock` / `equipForDig`)
 * AND drive two real bulk ops end-to-end, asserting the tool held at each
 * b.dig matches the block being dug.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import {
  preferHarvestToolForBlock,
  equipForDig,
  blockNeedsShovelHarvest,
} from '../../lib/runtime/dig-tools.js';
import { createExcavationActions } from '../../lib/actions/excavation.js';
import { createMockServices } from '../../lib/server/mock-services.js';

// ── classifier sanity (blockNeedsShovelHarvest had no direct coverage) ─────

test('blockNeedsShovelHarvest recognizes soft terrain, rejects stone/wood', () => {
  for (const n of ['dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay', 'coarse_dirt', 'soul_sand', 'snow_block']) {
    assert.ok(blockNeedsShovelHarvest(n), `${n} should be shovel-harvest`);
  }
  assert.ok(!blockNeedsShovelHarvest('stone'));
  assert.ok(!blockNeedsShovelHarvest('oak_log'));
  assert.ok(!blockNeedsShovelHarvest('iron_ore'));
});

// ── tool-tracking mock bot ─────────────────────────────────────────────────
//
// One source of truth for the held item (`bot.heldItem`). equip/unequip and
// the mineflayer-tool `equipForBlock` stub all mutate it; `dig` records which
// tool was in hand at the moment of the dig so tests can assert per-block
// switching. `equipForBlock` simulates mineflayer choosing the fastest tool in
// inventory for the block (shovel→soft, pickaxe→stone, axe→wood), else leaving
// the current hand (so soft blocks dug bare-handed when no shovel exists).

function toolItem(name, i) { return { name, type: 100 + i, count: 1, slot: i }; }

function makeToolBot({ inventory = [], held = null, world }) {
  const items = inventory.map(toolItem);
  const k = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const nameAt = (p) => world.get(k(p)) || 'air';
  /** @type {{block:string, tool:string}[]} */
  const digLog = [];

  const fastestToolFor = (blockName) => {
    if (/_log$|_wood$|stem$|hyphae$/.test(blockName)) return items.find((i) => /_axe$/.test(i.name)) || null;
    if (blockNeedsShovelHarvest(blockName)) return items.find((i) => /shovel$/.test(i.name)) || null;
    if (/(^|_)(stone|cobblestone|andesite|diorite|granite|tuff|calcite)$|ore$|deepslate/.test(blockName)) {
      return items.find((i) => /pickaxe$/.test(i.name)) || null;
    }
    return null;
  };

  const bot = {
    entity: { position: new Vec3(0, 64, 0), onGround: true, isInWater: false },
    game: { minY: -64, height: 384 },
    heldItem: held ? items.find((i) => i.name === held) || null : null,
    inventory: { items: () => items.slice() },
    blockAt(p) {
      const name = nameAt(p);
      return {
        name,
        position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
        boundingBox: name === 'air' ? 'empty' : 'block',
        getProperties: () => ({}),
      };
    },
    async equip(item) { bot.heldItem = item; },
    async unequip() { bot.heldItem = null; },
    async dig(blk) {
      digLog.push({ block: blk.name, tool: bot.heldItem?.name || 'hand' });
      world.set(k(blk.position), 'air');
    },
    stopDigging() {},
    async look() {},
    async lookAt() {},
    setControlState() {},
    clearControlStates() {},
    pathfinder: { goto: async () => {}, setGoal() {}, stop() {}, goal: null },
    entities: {},
    tool: {
      itemInHand: () => bot.heldItem,
      equipForBlock: async (blk) => { const t = fastestToolFor(blk.name); if (t) bot.heldItem = t; },
      getDigTime: () => 5,
    },
  };
  return { bot, digLog };
}

const FULL_KIT = ['iron_shovel', 'iron_pickaxe', 'iron_axe'];

// ── switcher: preferHarvestToolForBlock ────────────────────────────────────

test('preferHarvestToolForBlock: bare hand → pickaxe for stone', async () => {
  const { bot } = makeToolBot({ inventory: FULL_KIT, world: new Map() });
  await preferHarvestToolForBlock(bot, { name: 'stone' });
  assert.equal(bot.heldItem?.name, 'iron_pickaxe');
});

test('preferHarvestToolForBlock: holding pickaxe → shovel for dirt', async () => {
  const { bot } = makeToolBot({ inventory: FULL_KIT, held: 'iron_pickaxe', world: new Map() });
  await preferHarvestToolForBlock(bot, { name: 'dirt' });
  assert.equal(bot.heldItem?.name, 'iron_shovel');
});

test('preferHarvestToolForBlock: holding shovel → pickaxe for stone', async () => {
  const { bot } = makeToolBot({ inventory: FULL_KIT, held: 'iron_shovel', world: new Map() });
  await preferHarvestToolForBlock(bot, { name: 'stone' });
  assert.equal(bot.heldItem?.name, 'iron_pickaxe');
});

test('preferHarvestToolForBlock: holding pickaxe → axe for oak_log', async () => {
  const { bot } = makeToolBot({ inventory: FULL_KIT, held: 'iron_pickaxe', world: new Map() });
  await preferHarvestToolForBlock(bot, { name: 'oak_log' });
  assert.equal(bot.heldItem?.name, 'iron_axe');
});

test('preferHarvestToolForBlock: already holding shovel on dirt → no redundant switch', async () => {
  const { bot } = makeToolBot({ inventory: FULL_KIT, held: 'iron_shovel', world: new Map() });
  const before = bot.heldItem;
  await preferHarvestToolForBlock(bot, { name: 'gravel' });
  assert.equal(bot.heldItem, before, 'must keep the shovel it already holds');
});

test('preferHarvestToolForBlock: no shovel in kit → dirt dug bare-handed (not pickaxe)', async () => {
  // Correctness: a pickaxe gives no dig bonus on dirt, so we must NOT waste its
  // durability. The switcher unequips to bare hand when no shovel exists.
  const { bot } = makeToolBot({ inventory: ['iron_pickaxe'], held: 'iron_pickaxe', world: new Map() });
  await preferHarvestToolForBlock(bot, { name: 'dirt' });
  assert.equal(bot.heldItem, null, 'expected bare hand for dirt when no shovel available');
});

// ── full equipForDig result + alternating mixed column ─────────────────────

test('equipForDig: lands on the correct tool for stone / dirt / oak_log', async () => {
  const { bot } = makeToolBot({ inventory: FULL_KIT, world: new Map() });
  await equipForDig(bot, { name: 'stone' });
  assert.equal(bot.heldItem?.name, 'iron_pickaxe', 'stone → pickaxe');
  await equipForDig(bot, { name: 'dirt' });
  assert.equal(bot.heldItem?.name, 'iron_shovel', 'dirt → shovel');
  await equipForDig(bot, { name: 'oak_log' });
  assert.equal(bot.heldItem?.name, 'iron_axe', 'oak_log → axe');
});

test('equipForDig: alternates tools across a mixed dirt/stone column (no sticky tool)', async () => {
  const { bot } = makeToolBot({ inventory: FULL_KIT, world: new Map() });
  const column = ['dirt', 'stone', 'dirt', 'gravel', 'stone'];
  const heldAfter = [];
  for (const name of column) {
    await equipForDig(bot, { name });
    heldAfter.push(bot.heldItem?.name);
  }
  assert.deepEqual(heldAfter, [
    'iron_shovel', 'iron_pickaxe', 'iron_shovel', 'iron_shovel', 'iron_pickaxe',
  ]);
});

// ── integration: dig_area (covers tunnel, which delegates to dig_area) ─────

function makeExcavation(bot) {
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
    utils: { sleep: async () => {} },
    getActions: () => ({ pickup: async () => ({ result: '' }), mark: async () => {} }),
  });
  return createExcavationActions(services);
}

test('dig_area: equips shovel for dirt, pickaxe for stone, axe for wood — per block', async () => {
  const world = new Map([
    ['2,64,1', 'dirt'],
    ['2,64,2', 'stone'],
    ['2,64,3', 'oak_log'],
  ]);
  const { bot, digLog } = makeToolBot({ inventory: FULL_KIT, world });
  const actions = makeExcavation(bot);

  const res = await actions.dig_area({
    x1: 2, y1: 64, z1: 1, x2: 2, y2: 64, z2: 3,
    clear_stand: false, safe: false, pickup: false,
  });
  assert.equal(res.dug, 3, `expected 3 dug, got ${res.dug}`);

  const byBlock = Object.fromEntries(digLog.map((d) => [d.block, d.tool]));
  assert.equal(byBlock.dirt, 'iron_shovel');
  assert.equal(byBlock.stone, 'iron_pickaxe');
  assert.equal(byBlock.oak_log, 'iron_axe');
});

// ── integration: stair_down (the op the user named) ────────────────────────

test('stair_down: switches tool per cell of a mixed 3-tall column', async () => {
  // One step north (dx=0, dz=-1) from (0,64,0). The dug column is at z=-1:
  //   head  (0,65,-1) = dirt    → shovel
  //   body  (0,64,-1) = stone   → pickaxe
  //   floor (0,63,-1) = oak_log → axe
  // Floor support under the next stand cell (0,62,-1) must be solid so the
  // cave-below guard doesn't abort the step.
  const world = new Map([
    ['0,65,-1', 'dirt'],
    ['0,64,-1', 'stone'],
    ['0,63,-1', 'oak_log'],
    ['0,62,-1', 'stone'],
  ]);
  const { bot, digLog } = makeToolBot({ inventory: FULL_KIT, world });
  const actions = makeExcavation(bot);

  const res = await actions.stair_down({ direction: 'north', length: 1, pickup: false });
  assert.equal(res.ok, true);
  assert.equal(res.data.dug, 3, `expected 3 dug, got ${res.data.dug}`);

  const byBlock = Object.fromEntries(digLog.map((d) => [d.block, d.tool]));
  assert.equal(byBlock.dirt, 'iron_shovel', 'dirt cell dug with shovel');
  assert.equal(byBlock.stone, 'iron_pickaxe', 'stone cell dug with pickaxe');
  assert.equal(byBlock.oak_log, 'iron_axe', 'wood cell dug with axe');
});
