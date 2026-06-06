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
