import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toolReadiness,
  inventoryHas,
  sceneToolNeeds,
} from '../lib/runtime/inventory-hints.js';

// Mock bot factory — produces a bot stub with the minimal mineflayer
// surface our helpers touch: inventory.items() returning the given list,
// and tool.itemInHand() returning the given held item.
function mockBot(itemList, held = null) {
  return {
    inventory: { items: () => itemList.map((i, idx) => ({ ...i, slot: i.slot ?? idx + 9 })) },
    tool: { itemInHand: () => held },
  };
}

// ── toolReadiness — block needs pickaxe ──────────────────────────────

test('toolReadiness: cobblestone with no pickaxe in inventory → hint', () => {
  const b = mockBot([{ name: 'oak_log', count: 12 }]);
  const r = toolReadiness(b, 'cobblestone');
  assert.equal(r.tool_needed, 'pickaxe');
  assert.equal(r.have_tool, false);
  assert.equal(r.best_available, null);
  assert.match(r.hint, /no pickaxe in inventory/);
  assert.match(r.hint, /mc craft wooden_pickaxe/);
});

test('toolReadiness: cobblestone with stone_pickaxe in inventory → no hint, best=stone_pickaxe', () => {
  const b = mockBot([{ name: 'stone_pickaxe', count: 1 }]);
  const r = toolReadiness(b, 'cobblestone');
  assert.equal(r.tool_needed, 'pickaxe');
  assert.equal(r.have_tool, true);
  assert.equal(r.best_available, 'stone_pickaxe');
  assert.equal(r.hint, null);
});

test('toolReadiness: picks best tier when multiple in inventory', () => {
  const b = mockBot([
    { name: 'wooden_pickaxe', count: 1 },
    { name: 'iron_pickaxe', count: 1 },
    { name: 'stone_pickaxe', count: 2 },
  ]);
  const r = toolReadiness(b, 'iron_ore');
  // HARVEST_PICK_PRIORITY: netherite > diamond > iron > stone > golden > wooden
  assert.equal(r.best_available, 'iron_pickaxe');
});

// ── toolReadiness — block needs axe ──────────────────────────────────

test('toolReadiness: oak_log with no axe → hint', () => {
  const b = mockBot([{ name: 'stone_pickaxe', count: 1 }]);
  const r = toolReadiness(b, 'oak_log');
  assert.equal(r.tool_needed, 'axe');
  assert.equal(r.have_tool, false);
  assert.match(r.hint, /no axe in inventory/);
});

test('toolReadiness: oak_log with wooden_axe → no hint', () => {
  const b = mockBot([{ name: 'wooden_axe', count: 1 }]);
  const r = toolReadiness(b, 'oak_log');
  assert.equal(r.have_tool, true);
  assert.equal(r.best_available, 'wooden_axe');
  assert.equal(r.hint, null);
});

// ── toolReadiness — shovel-class is optional ─────────────────────────

test('toolReadiness: dirt with no shovel → still no hint (bare hand works)', () => {
  const b = mockBot([{ name: 'wooden_pickaxe', count: 1 }]);
  const r = toolReadiness(b, 'dirt');
  assert.equal(r.tool_needed, 'shovel');
  assert.equal(r.have_tool, false);
  // Shovel is an optimization for dirt/sand/gravel — bare hand mines fine
  // (just slower). Don't surface this as actionable.
  assert.equal(r.hint, null);
});

test('toolReadiness: dirt with iron_shovel → have_tool=true', () => {
  const b = mockBot([{ name: 'iron_shovel', count: 1 }]);
  const r = toolReadiness(b, 'dirt');
  assert.equal(r.have_tool, true);
  assert.equal(r.best_available, 'iron_shovel');
});

// ── toolReadiness — no tool needed ────────────────────────────────────

test('toolReadiness: leaves / flowers etc. → tool_needed=null, have_tool=true', () => {
  const b = mockBot([]);
  // grass / oak_sapling / poppy etc — bare hand works fine
  const r = toolReadiness(b, 'poppy');
  assert.equal(r.tool_needed, null);
  assert.equal(r.have_tool, true);
  assert.equal(r.hint, null);
});

// ── toolReadiness — defensive ────────────────────────────────────────

test('toolReadiness: missing bot or block → null (caller ignores)', () => {
  assert.equal(toolReadiness(null, 'cobblestone'), null);
  assert.equal(toolReadiness({}, ''), null);
});

// ── inventoryHas ──────────────────────────────────────────────────────

test('inventoryHas: empty inventory → count 0', () => {
  const b = mockBot([]);
  const r = inventoryHas(b, 'wooden_pickaxe');
  assert.equal(r.count, 0);
  assert.deepEqual(r.slots, []);
});

test('inventoryHas: single match → count + slot detail', () => {
  const b = mockBot([
    { name: 'wooden_pickaxe', count: 1, slot: 12 },
    { name: 'cobblestone', count: 32, slot: 13 },
  ]);
  const r = inventoryHas(b, 'wooden_pickaxe');
  assert.equal(r.count, 1);
  assert.deepEqual(r.slots, [{ slot: 12, count: 1 }]);
});

test('inventoryHas: multiple stacks of same item → sum + slot list', () => {
  const b = mockBot([
    { name: 'cobblestone', count: 64, slot: 9 },
    { name: 'cobblestone', count: 27, slot: 14 },
    { name: 'oak_log', count: 8, slot: 18 },
  ]);
  const r = inventoryHas(b, 'cobblestone');
  assert.equal(r.count, 91);
  assert.equal(r.slots.length, 2);
  assert.deepEqual(
    r.slots.sort((a, c) => a.slot - c.slot),
    [{ slot: 9, count: 64 }, { slot: 14, count: 27 }],
  );
});

test('inventoryHas: case-insensitive', () => {
  const b = mockBot([{ name: 'wooden_pickaxe', count: 1 }]);
  assert.equal(inventoryHas(b, 'WOODEN_PICKAXE').count, 1);
  assert.equal(inventoryHas(b, 'Wooden_Pickaxe').count, 1);
});

test('inventoryHas: no substring matching (exact name only)', () => {
  const b = mockBot([{ name: 'stone_pickaxe', count: 1 }]);
  assert.equal(inventoryHas(b, 'pickaxe').count, 0);
  assert.equal(inventoryHas(b, 'stone').count, 0);
});

test('inventoryHas: defensive on missing bot/item', () => {
  assert.deepEqual(inventoryHas(null, 'cobblestone'), { count: 0, slots: [] });
  assert.deepEqual(inventoryHas({}, 'cobblestone'), { count: 0, slots: [] });
  assert.deepEqual(inventoryHas({ inventory: { items: () => [] } }, ''), { count: 0, slots: [] });
});

// ── sceneToolNeeds — aggregate across visible blocks ───────────────────

test('sceneToolNeeds: pickaxe-needed visible, no pickaxe → tools_missing.pickaxe', () => {
  const b = mockBot([]);
  const visible = [
    { name: 'cobblestone', count: 12 },
    { name: 'stone', count: 8 },
  ];
  const r = sceneToolNeeds(b, visible);
  assert.equal(r.tools_missing.length, 1);
  assert.equal(r.tools_missing[0].category, 'pickaxe');
  assert.equal(r.tools_missing[0].total_count, 20);
  const blockNames = r.tools_missing[0].blocks.map((b) => b.name).sort();
  assert.deepEqual(blockNames, ['cobblestone', 'stone']);
  assert.match(r.tools_missing[0].hint, /no pickaxe/);
});

test('sceneToolNeeds: pickaxe-needed visible AND have pickaxe → tools_ready, no tools_missing', () => {
  const b = mockBot([{ name: 'stone_pickaxe', count: 1 }]);
  const visible = [{ name: 'cobblestone', count: 12 }];
  const r = sceneToolNeeds(b, visible);
  assert.equal(r.tools_missing.length, 0);
  assert.equal(r.tools_ready.length, 1);
  assert.equal(r.tools_ready[0].category, 'pickaxe');
  assert.equal(r.tools_ready[0].best_available, 'stone_pickaxe');
});

test('sceneToolNeeds: mixed scene — missing one category, have another', () => {
  const b = mockBot([{ name: 'wooden_pickaxe', count: 1 }]);
  const visible = [
    { name: 'cobblestone', count: 12 },   // pickaxe — have
    { name: 'oak_log', count: 3 },        // axe — missing
  ];
  const r = sceneToolNeeds(b, visible);
  assert.equal(r.tools_ready.length, 1);
  assert.equal(r.tools_ready[0].category, 'pickaxe');
  assert.equal(r.tools_missing.length, 1);
  assert.equal(r.tools_missing[0].category, 'axe');
});

test('sceneToolNeeds: shovel-class blocks (dirt) do NOT surface as missing', () => {
  // dirt mines with bare hand fine; shovel is optimization. Hint must be null
  // so the agent doesn't get noise telling them to craft a shovel they don't need.
  const b = mockBot([]);
  const visible = [{ name: 'dirt', count: 32 }];
  const r = sceneToolNeeds(b, visible);
  assert.equal(r.tools_missing.length, 0);
  assert.equal(r.tools_ready.length, 0);
});

test('sceneToolNeeds: non-mineable blocks (poppy) ignored entirely', () => {
  const b = mockBot([]);
  const visible = [
    { name: 'poppy', count: 4 },
    { name: 'tall_grass', count: 8 },
  ];
  const r = sceneToolNeeds(b, visible);
  assert.equal(r.tools_missing.length, 0);
  assert.equal(r.tools_ready.length, 0);
});

test('sceneToolNeeds: empty / missing args → empty result', () => {
  assert.deepEqual(sceneToolNeeds(null, []), { tools_missing: [], tools_ready: [] });
  assert.deepEqual(sceneToolNeeds(mockBot([]), null), { tools_missing: [], tools_ready: [] });
  assert.deepEqual(sceneToolNeeds(mockBot([]), []), { tools_missing: [], tools_ready: [] });
});

test('sceneToolNeeds: aggregates counts when same category has multiple blocks', () => {
  const b = mockBot([]);
  const visible = [
    { name: 'cobblestone', count: 10 },
    { name: 'andesite', count: 5 },
    { name: 'iron_ore', count: 2 },
  ];
  const r = sceneToolNeeds(b, visible);
  // All three need pickaxe; aggregated into one tools_missing entry
  assert.equal(r.tools_missing.length, 1);
  assert.equal(r.tools_missing[0].category, 'pickaxe');
  assert.equal(r.tools_missing[0].total_count, 17);
  assert.equal(r.tools_missing[0].blocks.length, 3);
});
