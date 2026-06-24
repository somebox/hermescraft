/**
 * mc verify action contract tests.
 *
 * Tier 1 — no MC server, no LLM, no network. Mocks the bot's inventory
 * and the locations service; asserts the response shape against the
 * canonical envelope (mc-verify-spec.md).
 *
 * Spec: docs/architecture/mc-verify-spec.md
 * Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md (Session 2)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createVerifyActions } from '../../lib/actions/verify.js';

function makeServices({ inventory = [], botPos = { x: 0, y: 65, z: 0 }, locations = null, blockAt = null, openContainerImpl = null } = {}) {
  const bot = {
    entity: { position: botPos },
    inventory: {
      items: () => inventory.map((it) => (typeof it === 'string' ? { name: it, count: 1 } : it)),
    },
    blockAt: blockAt || (() => null),
    openContainer: openContainerImpl || (async () => { throw new Error('openContainer not stubbed'); }),
  };
  return {
    state: { world: { bot } },
    ensureBot: () => bot,
    locations: locations || { load: () => ({}) },
  };
}

// ── Dispatcher / unknown kind ──────────────────────────────────────────

test('verify: missing kind → MISSING_ARG', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_ARG');
  assert.equal(r.error.retry_safe, false);
});

test('verify: unknown kind → UNKNOWN_KIND with doc pointer', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({ kind: 'bogus_kind' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_KIND');
  assert.match(r.error.message, /bogus_kind/);
  assert.match(r.error.message, /mc-verify-spec\.md/);
});

// ── inventory_contains ─────────────────────────────────────────────────

test('verify inventory_contains: satisfied=true when count >= min', async () => {
  const { verify } = createVerifyActions(makeServices({
    inventory: [{ name: 'cobblestone', count: 4 }],
  }));
  const r = await verify({ kind: 'inventory_contains', item: 'cobblestone', min_count: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.data.kind, 'inventory_contains');
  assert.equal(r.data.satisfied, true);
  assert.deepEqual(r.data.observed, { item: 'cobblestone', count: 4 });
  assert.deepEqual(r.data.expected, { item: 'cobblestone', min_count: 4 });
});

test('verify inventory_contains: satisfied=false when count < min', async () => {
  const { verify } = createVerifyActions(makeServices({
    inventory: [{ name: 'cobblestone', count: 2 }],
  }));
  const r = await verify({ kind: 'inventory_contains', item: 'cobblestone', min_count: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.data.satisfied, false);
  assert.equal(r.data.observed.count, 2);
  assert.equal(r.data.expected.min_count, 4);
});

test('verify inventory_contains: sums multiple stacks of same item', async () => {
  const { verify } = createVerifyActions(makeServices({
    inventory: [
      { name: 'cobblestone', count: 2 },
      { name: 'cobblestone', count: 3 },
      { name: 'oak_log', count: 4 },
    ],
  }));
  const r = await verify({ kind: 'inventory_contains', item: 'cobblestone', min_count: 4 });
  assert.equal(r.data.observed.count, 5);
  assert.equal(r.data.satisfied, true);
});

test('verify inventory_contains: missing item arg → MISSING_ARG', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({ kind: 'inventory_contains' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_ARG');
});

test('verify inventory_contains: min_count defaults to 1', async () => {
  const { verify } = createVerifyActions(makeServices({
    inventory: [{ name: 'oak_log', count: 1 }],
  }));
  const r = await verify({ kind: 'inventory_contains', item: 'oak_log' });
  assert.equal(r.data.expected.min_count, 1);
  assert.equal(r.data.satisfied, true);
});

// ── chest_contains ─────────────────────────────────────────────────────

test('verify chest_contains: mark not found → MARK_NOT_FOUND', async () => {
  const { verify } = createVerifyActions(makeServices({
    locations: { load: () => ({}) },  // no marks
  }));
  const r = await verify({ kind: 'chest_contains', mark: 'storage', item: 'cobblestone', min_count: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MARK_NOT_FOUND');
  assert.equal(r.error.observed_state.requested_mark, 'storage');
});

test('verify chest_contains: bot too far → NOT_ADJACENT with next_action_hint', async () => {
  const { verify } = createVerifyActions(makeServices({
    botPos: { x: 100, y: 65, z: 100 },
    locations: { load: () => ({ storage: { x: 4, y: 65, z: 0 } }) },
  }));
  const r = await verify({ kind: 'chest_contains', mark: 'storage', item: 'cobblestone', min_count: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NOT_ADJACENT');
  assert.match(r.error.next_action_hint, /mc move @storage/);
});

test('verify chest_contains: block at mark not a chest → BLOCK_NOT_CHEST', async () => {
  const { verify } = createVerifyActions(makeServices({
    botPos: { x: 4, y: 65, z: 1 },
    locations: { load: () => ({ storage: { x: 4, y: 65, z: 0 } }) },
    blockAt: () => ({ name: 'oak_planks' }),
  }));
  const r = await verify({ kind: 'chest_contains', mark: 'storage', item: 'cobblestone', min_count: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BLOCK_NOT_CHEST');
  assert.equal(r.error.observed_state.block_name, 'oak_planks');
});

test('verify chest_contains: opens chest, sums items, satisfied=true', async () => {
  let opened = false;
  let closed = false;
  const { verify } = createVerifyActions(makeServices({
    botPos: { x: 4, y: 65, z: 1 },
    locations: { load: () => ({ storage: { x: 4, y: 65, z: 0 } }) },
    blockAt: () => ({ name: 'chest' }),
    openContainerImpl: async () => {
      opened = true;
      return {
        containerItems: () => [
          { name: 'cobblestone', count: 4 },
          { name: 'oak_log', count: 2 },
        ],
        close: async () => { closed = true; },
      };
    },
  }));
  const r = await verify({ kind: 'chest_contains', mark: 'storage', item: 'cobblestone', min_count: 4 });
  assert.equal(opened, true, 'chest should be opened');
  assert.equal(closed, true, 'chest should be closed after read');
  assert.equal(r.ok, true);
  assert.equal(r.data.kind, 'chest_contains');
  assert.equal(r.data.satisfied, true);
  assert.equal(r.data.observed.mark, 'storage');
  assert.deepEqual(r.data.observed.coords, { x: 4, y: 65, z: 0 });
  assert.equal(r.data.observed.item, 'cobblestone');
  assert.equal(r.data.observed.count, 4);
});

test('verify chest_contains: missing item arg → MISSING_ARG', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({ kind: 'chest_contains', mark: 'storage' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_ARG');
});

test('verify chest_contains: missing mark arg → MISSING_ARG', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({ kind: 'chest_contains', item: 'cobblestone' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_ARG');
});

// ── at_mark ────────────────────────────────────────────────────────────

test('verify at_mark (bot mode): satisfied=true when within near radius', async () => {
  const { verify } = createVerifyActions(makeServices({
    botPos: { x: 5, y: 65, z: 0 },
    locations: { load: () => ({ field_south: { x: 6, y: 65, z: 0 } }) },
  }));
  const r = await verify({ kind: 'at_mark', mark: 'field_south', near: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.data.kind, 'at_mark');
  assert.equal(r.data.mode, 'bot');
  assert.equal(r.data.satisfied, true);
});

test('verify at_mark (bot mode): satisfied=false when beyond near', async () => {
  const { verify } = createVerifyActions(makeServices({
    botPos: { x: 20, y: 65, z: 0 },
    locations: { load: () => ({ field_south: { x: 0, y: 65, z: 0 } }) },
  }));
  const r = await verify({ kind: 'at_mark', mark: 'field_south', near: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.data.satisfied, false);
});

test('verify at_mark (bot mode): near defaults to 2', async () => {
  const { verify } = createVerifyActions(makeServices({
    botPos: { x: 3, y: 65, z: 0 },
    locations: { load: () => ({ field_south: { x: 0, y: 65, z: 0 } }) },
  }));
  // dist=3, default near=2 → not satisfied
  const r = await verify({ kind: 'at_mark', mark: 'field_south' });
  assert.equal(r.ok, true);
  assert.equal(r.data.satisfied, false);
  assert.equal(r.data.expected.max_dist, 2);
});

test('verify at_mark (block mode): satisfied=true when block matches', async () => {
  const { verify } = createVerifyActions(makeServices({
    locations: { load: () => ({ water_source: { x: 5, y: 64, z: 5 } }) },
    blockAt: () => ({ name: 'water' }),
  }));
  const r = await verify({ kind: 'at_mark', mark: 'water_source', block: 'water' });
  assert.equal(r.ok, true);
  assert.equal(r.data.mode, 'block');
  assert.equal(r.data.satisfied, true);
  assert.equal(r.data.observed.block, 'water');
});

test('verify at_mark (block mode): satisfied=false when block differs', async () => {
  const { verify } = createVerifyActions(makeServices({
    locations: { load: () => ({ water_source: { x: 5, y: 64, z: 5 } }) },
    blockAt: () => ({ name: 'dirt' }),
  }));
  const r = await verify({ kind: 'at_mark', mark: 'water_source', block: 'water' });
  assert.equal(r.ok, true);
  assert.equal(r.data.mode, 'block');
  assert.equal(r.data.satisfied, false);
  assert.equal(r.data.observed.block, 'dirt');
});

// `from=` mode — remote proximity check without the bot moving
// (proc-nav-1781014144: presence-requiring verification forced round-trips).

test('verify at_mark (from mode): satisfied without bot anywhere near', async () => {
  const { verify } = createVerifyActions(makeServices({
    botPos: { x: 9999, y: 65, z: 9999 },  // bot is far away and stays there
    locations: { load: () => ({ field_south: { x: 365, y: 65, z: -575 } }) },
  }));
  const r = await verify({ kind: 'at_mark', mark: 'field_south', from: '366,65,-575', near: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.data.mode, 'from');
  assert.equal(r.data.satisfied, true);
  assert.deepEqual(r.data.observed.from, { x: 366, y: 65, z: -575 });
  assert.equal(r.data.observed.bot_pos, undefined);
});

test('verify at_mark (from mode): accepts {x,y,z} object form', async () => {
  const { verify } = createVerifyActions(makeServices({
    botPos: { x: 9999, y: 65, z: 9999 },
    locations: { load: () => ({ field_south: { x: 0, y: 65, z: 0 } }) },
  }));
  const r = await verify({ kind: 'at_mark', mark: 'field_south', from: { x: 50, y: 65, z: 0 }, near: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.data.mode, 'from');
  assert.equal(r.data.satisfied, false);
  assert.equal(r.data.observed.dist, 50);
});

test('verify at_mark (from mode): malformed from → INVALID_ARGS', async () => {
  const { verify } = createVerifyActions(makeServices({
    locations: { load: () => ({ field_south: { x: 0, y: 65, z: 0 } }) },
  }));
  const r = await verify({ kind: 'at_mark', mark: 'field_south', from: 'not-coords' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_ARGS');
  assert.equal(r.error.retry_safe, false);
});

test('verify at_mark: mark not found → MARK_NOT_FOUND', async () => {
  const { verify } = createVerifyActions(makeServices({
    locations: { load: () => ({}) },
  }));
  const r = await verify({ kind: 'at_mark', mark: 'ghost' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MARK_NOT_FOUND');
});

test('verify at_mark: missing mark arg → MISSING_ARG', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({ kind: 'at_mark' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_ARG');
});

test('verify at_mark (block mode): unreadable block → READ_FAILED', async () => {
  const { verify } = createVerifyActions(makeServices({
    locations: { load: () => ({ water_source: { x: 5, y: 64, z: 5 } }) },
    blockAt: () => null,
  }));
  const r = await verify({ kind: 'at_mark', mark: 'water_source', block: 'water' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'READ_FAILED');
  assert.equal(r.error.retry_safe, true);
});

// ── region_blocks ──────────────────────────────────────────────────────

function makeRegionServices(blockGrid) {
  // blockGrid is a map "x,y,z" → block name (or absent for null).
  return makeServices({
    blockAt: (pos) => {
      const key = `${pos.x},${pos.y},${pos.z}`;
      const name = blockGrid[key];
      return name ? { name } : null;
    },
  });
}

test('verify region_blocks: counts matching blocks in region', async () => {
  // 3x1x3 region all filled with farmland.
  const grid = {};
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) grid[`${x},65,${z}`] = 'farmland';
  const { verify } = createVerifyActions(makeRegionServices(grid));
  const r = await verify({
    kind: 'region_blocks',
    corner1: { x: 0, y: 65, z: 0 },
    corner2: { x: 2, y: 65, z: 2 },
    block: 'farmland',
    min_count: 9,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.kind, 'region_blocks');
  assert.equal(r.data.satisfied, true);
  assert.equal(r.data.observed.count, 9);
  assert.equal(r.data.observed.scanned, 9);
  assert.equal(r.data.observed.unreadable, 0);
});

test('verify region_blocks: satisfied=false when below min_count', async () => {
  const grid = {};
  // Only 5 of 9 cells are farmland.
  let placed = 0;
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) {
    grid[`${x},65,${z}`] = placed++ < 5 ? 'farmland' : 'dirt';
  }
  const { verify } = createVerifyActions(makeRegionServices(grid));
  const r = await verify({
    kind: 'region_blocks',
    corner1: { x: 0, y: 65, z: 0 },
    corner2: { x: 2, y: 65, z: 2 },
    block: 'farmland',
    min_count: 9,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.satisfied, false);
  assert.equal(r.data.observed.count, 5);
});

test('verify region_blocks: corners normalised (corner1 may be max)', async () => {
  const grid = {};
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) grid[`${x},65,${z}`] = 'farmland';
  const { verify } = createVerifyActions(makeRegionServices(grid));
  // Pass corner1 as the MAX corner — the function must normalise.
  const r = await verify({
    kind: 'region_blocks',
    corner1: { x: 2, y: 65, z: 2 },
    corner2: { x: 0, y: 65, z: 0 },
    block: 'farmland',
    min_count: 9,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.satisfied, true);
  assert.equal(r.data.observed.count, 9);
  assert.equal(r.data.observed.region.min.x, 0);
  assert.equal(r.data.observed.region.max.x, 2);
});

test('verify region_blocks: partial unreadable region reports observed', async () => {
  // 2x1x2 region; 2 cells readable as farmland, 2 cells null.
  const grid = {
    '0,65,0': 'farmland',
    '1,65,0': 'farmland',
    // '0,65,1' and '1,65,1' absent → null
  };
  const { verify } = createVerifyActions(makeRegionServices(grid));
  const r = await verify({
    kind: 'region_blocks',
    corner1: { x: 0, y: 65, z: 0 },
    corner2: { x: 1, y: 65, z: 1 },
    block: 'farmland',
    min_count: 4,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.satisfied, false);
  assert.equal(r.data.observed.count, 2);
  assert.equal(r.data.observed.scanned, 2);
  assert.equal(r.data.observed.unreadable, 2);
});

test('verify region_blocks: fully unreadable region → READ_FAILED', async () => {
  const { verify } = createVerifyActions(makeRegionServices({}));
  const r = await verify({
    kind: 'region_blocks',
    corner1: { x: 0, y: 65, z: 0 },
    corner2: { x: 1, y: 65, z: 1 },
    block: 'farmland',
    min_count: 4,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'READ_FAILED');
  assert.equal(r.error.retry_safe, true);
});

test('verify region_blocks: volume above cap → VOLUME_TOO_LARGE', async () => {
  const { verify } = createVerifyActions(makeRegionServices({}));
  // 100x10x100 = 100,000 > 4,096 cap.
  const r = await verify({
    kind: 'region_blocks',
    corner1: { x: 0, y: 0, z: 0 },
    corner2: { x: 99, y: 9, z: 99 },
    block: 'farmland',
    min_count: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'VOLUME_TOO_LARGE');
  assert.equal(r.error.retry_safe, false);
});

test('verify region_blocks: missing corners → MISSING_ARG', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({ kind: 'region_blocks', block: 'farmland' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_ARG');
});

test('verify region_blocks: missing block → MISSING_ARG', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({
    kind: 'region_blocks',
    corner1: { x: 0, y: 0, z: 0 },
    corner2: { x: 1, y: 1, z: 1 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_ARG');
});

test('verify region_blocks: corner missing y/z coords → INVALID_ARGS', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({
    kind: 'region_blocks',
    corner1: { x: 0, z: 0 }, // no y
    corner2: { x: 1, y: 1, z: 1 },
    block: 'farmland',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_ARGS');
  assert.match(r.error.message, /numeric x, y, z/);
});

test('verify region_blocks: non-numeric corner coord → INVALID_ARGS', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({
    kind: 'region_blocks',
    corner1: { x: 0, y: 'nope', z: 0 },
    corner2: { x: 1, y: 1, z: 1 },
    block: 'farmland',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_ARGS');
});

// ── UNKNOWN_KIND lists new verbs ────────────────────────────────────────

test('verify: UNKNOWN_KIND message lists at_mark and region_blocks', async () => {
  const { verify } = createVerifyActions(makeServices());
  const r = await verify({ kind: 'unrecognised_kind' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_KIND');
  assert.match(r.error.message, /at_mark/);
  assert.match(r.error.message, /region_blocks/);
});
