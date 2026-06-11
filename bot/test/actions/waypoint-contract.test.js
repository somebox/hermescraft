/**
 * mc waypoint — adaptive-road-planning §7.1.
 *
 * Two layers under test:
 *   1. `pickTorchAnchor` decision table — pure: water / leaves / slab / air /
 *      obstructed torch cell. Test rows mirror §5.1/§7.1 exactly.
 *   2. The waypoint handler — contract envelope, private-mark persistence,
 *      torch-already-lit idempotency, popped-torch re-place, and old-torch
 *      cleanup hint when the mark moves out of reach.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import {
  createWaypointActions,
  pickTorchAnchor,
} from '../../lib/actions/waypoint.js';
import { assertContract, assertFailure } from '../_helpers/action-harness.js';

function gridBlockAt(grid) {
  return (p) => {
    const v = grid[`${p.x},${p.y},${p.z}`];
    if (v === undefined) return null;
    return typeof v === 'string'
      ? { name: v, boundingBox: v === 'air' ? 'empty' : 'block' }
      : { boundingBox: v.bb ?? 'block', ...v };
  };
}

test('pickTorchAnchor: solid ground below — anchors on (x,y-1,z)', () => {
  const blockAt = gridBlockAt({
    '0,64,0': 'air',
    '0,63,0': 'grass_block',
  });
  const r = pickTorchAnchor({ x: 0, y: 64, z: 0, blockAtFn: blockAt });
  assert.equal(r.ok, true);
  assert.deepEqual(r.anchor_at, { x: 0, y: 63, z: 0 });
  assert.deepEqual(r.torch_at, { x: 0, y: 64, z: 0 });
});

test('pickTorchAnchor: bottom slab anchors the torch on its top', () => {
  const blockAt = gridBlockAt({
    '0,64,0': 'air',
    '0,63,0': { name: 'oak_slab', bb: 'empty' },
  });
  const r = pickTorchAnchor({ x: 0, y: 64, z: 0, blockAtFn: blockAt });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.anchor_block, 'oak_slab');
  assert.deepEqual(r.torch_at, { x: 0, y: 64, z: 0 });
});

test('pickTorchAnchor: water below — hard fails with fluid_below', () => {
  const blockAt = gridBlockAt({
    '0,64,0': 'air',
    '0,63,0': { name: 'water', bb: 'empty' },
  });
  const r = pickTorchAnchor({ x: 0, y: 64, z: 0, blockAtFn: blockAt });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fluid_below');
});

test('pickTorchAnchor: leaves are skipped; falls through to the dirt below', () => {
  const blockAt = gridBlockAt({
    '0,64,0': 'air',
    '0,63,0': { name: 'oak_leaves', bb: 'block' },
    '0,62,0': 'dirt',
  });
  const r = pickTorchAnchor({ x: 0, y: 64, z: 0, blockAtFn: blockAt });
  assert.equal(r.ok, true);
  assert.equal(r.anchor_block, 'dirt');
  assert.deepEqual(r.torch_at, { x: 0, y: 63, z: 0 });
});

test('pickTorchAnchor: open air with nothing in scan range — no_solid_floor_within_scan', () => {
  const blockAt = gridBlockAt({
    '0,64,0': 'air', '0,63,0': 'air', '0,62,0': 'air', '0,61,0': 'air',
  });
  const r = pickTorchAnchor({ x: 0, y: 64, z: 0, blockAtFn: blockAt });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_solid_floor_within_scan');
});

test('pickTorchAnchor: torch already at the cell → already_lit (idempotent)', () => {
  const blockAt = gridBlockAt({
    '0,64,0': { name: 'torch', bb: 'empty' },
    '0,63,0': 'grass_block',
  });
  const r = pickTorchAnchor({ x: 0, y: 64, z: 0, blockAtFn: blockAt });
  assert.equal(r.ok, true);
  assert.equal(r.already_lit, true);
});

test('pickTorchAnchor: torch cell holds a non-replaceable block — torch_cell_obstructed', () => {
  const blockAt = gridBlockAt({
    '0,64,0': 'stone',
    '0,63,0': 'grass_block',
  });
  const r = pickTorchAnchor({ x: 0, y: 64, z: 0, blockAtFn: blockAt });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'torch_cell_obstructed');
});

test('pickTorchAnchor: unloaded chunk below → unloaded_chunk (no guessing)', () => {
  const blockAt = () => null;
  const r = pickTorchAnchor({ x: 0, y: 64, z: 0, blockAtFn: blockAt });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unloaded_chunk');
});

// ── Handler harness ──────────────────────────────────────────────────

function makeHarness({ grid, prevLocs = {}, placeResult, position }) {
  const blockMap = new Map(Object.entries(grid));
  const blockAt = (vec) => {
    const k = `${vec.x},${vec.y},${vec.z}`;
    const v = blockMap.get(k);
    if (v === undefined) return null;
    return typeof v === 'string'
      ? { name: v, boundingBox: v === 'air' ? 'empty' : 'block', position: vec }
      : { boundingBox: v.bb ?? 'block', position: vec, ...v };
  };
  const pos = position || new Vec3(0, 64, 0);
  pos.distanceTo = (other) => Math.hypot(other.x - pos.x, other.y - pos.y, other.z - pos.z);
  let locsState = { ...prevLocs };
  const dug = [];
  const placeCalls = [];
  const placeFn = async (args) => {
    placeCalls.push(args);
    // Mutate the grid as the verb would on success so subsequent reads
    // (idempotency re-call) see the torch.
    const r = (typeof placeResult === 'function')
      ? placeResult(args, blockMap)
      : (placeResult || { ok: true, data: { placed_block: args.block, at: { x: args.x, y: args.y, z: args.z } } });
    if (r.ok) blockMap.set(`${args.x},${args.y},${args.z}`,
      { name: args.block, bb: 'empty' });
    return r;
  };
  const bot = {
    entity: { position: pos },
    blockAt,
    dig: async (blk) => {
      dug.push({ x: blk.position.x, y: blk.position.y, z: blk.position.z, name: blk.name });
      blockMap.set(`${blk.position.x},${blk.position.y},${blk.position.z}`, 'air');
    },
  };
  const actions = createWaypointActions({
    ensureBot: () => bot,
    loadLocations: () => ({ ...locsState }),
    saveLocations: (l) => { locsState = { ...l }; },
    services: { getActions: () => ({ place: placeFn }) },
  });
  return {
    actions, bot, blockMap, dug, placeCalls,
    locs: () => locsState,
  };
}

test('handler: rejects missing name / non-numeric coords with INVALID_ARGS', async () => {
  const h = makeHarness({ grid: {} });
  assertFailure(await h.actions.waypoint({}), { code: 'INVALID_ARGS' });
  assertFailure(await h.actions.waypoint({ name: 'wp_1' }), {
    code: 'INVALID_ARGS',
    messageIncludes: 'numeric',
  });
});

test('handler: fresh waypoint — places torch, saves mark, no cleanup hint', async () => {
  const h = makeHarness({
    grid: { '0,64,0': 'air', '0,63,0': 'grass_block' },
  });
  const r = await h.actions.waypoint({ name: 'wp_3', x: 0, y: 64, z: 0 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.placement, 'placed');
  assert.deepEqual(r.data.torch_at, { x: 0, y: 64, z: 0 });
  assert.equal(r.data.moved, false);
  assert.equal(h.placeCalls.length, 1);
  assert.equal(h.placeCalls[0].block, 'torch');
  assert.deepEqual(h.locs().wp_3.torch_at, { x: 0, y: 64, z: 0 });
  assert.equal(h.locs().wp_3.category, 'waypoint');
  assert.equal('next_action_hint' in r, false);
});

test('handler: torch already lit (idempotent) — no placement, mark refreshed', async () => {
  const h = makeHarness({
    grid: {
      '0,64,0': { name: 'torch', bb: 'empty' },
      '0,63,0': 'grass_block',
    },
  });
  const r = await h.actions.waypoint({ name: 'wp_3', x: 0, y: 64, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data.placement, 'already_lit');
  assert.equal(h.placeCalls.length, 0);
});

test('handler: popped torch (mark exists, cell now air) — re-places', async () => {
  const h = makeHarness({
    grid: { '0,64,0': 'air', '0,63,0': 'grass_block' },
    prevLocs: {
      wp_3: {
        x: 0, y: 64, z: 0,
        torch_at: { x: 0, y: 64, z: 0 },
        category: 'waypoint',
        saved: '2026-06-01T00:00:00Z',
      },
    },
  });
  const r = await h.actions.waypoint({ name: 'wp_3', x: 0, y: 64, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data.placement, 'placed');
  assert.equal(h.placeCalls.length, 1);
});

test('handler: moved waypoint, old torch within reach — dug, no hint', async () => {
  const h = makeHarness({
    grid: {
      '10,64,0': 'air',
      '10,63,0': 'grass_block',
      '11,64,0': { name: 'torch', bb: 'empty' },
      '11,63,0': 'grass_block',
    },
    prevLocs: {
      wp_3: { x: 11, y: 64, z: 0, torch_at: { x: 11, y: 64, z: 0 } },
    },
    position: Object.assign(new Vec3(10, 64, 0), {}),
  });
  const r = await h.actions.waypoint({ name: 'wp_3', x: 10, y: 64, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data.moved, true);
  assert.equal(r.data.old_torch.kind, 'dug');
  assert.equal(h.dug.length, 1);
  assert.equal('next_action_hint' in r, false);
  // The shared-mark contract (§5.1): bot only ever writes the *private*
  // mark; the new position is recorded, prev_pos preserved for the
  // planner's reconciliation pass.
  assert.deepEqual(h.locs().wp_3.prev_pos, { x: 11, y: 64, z: 0 });
});

test('handler: moved waypoint, old torch out of reach — cleanup hint emitted', async () => {
  const h = makeHarness({
    grid: {
      '0,64,0': 'air',
      '0,63,0': 'grass_block',
      '50,64,0': { name: 'torch', bb: 'empty' },
      '50,63,0': 'grass_block',
    },
    prevLocs: {
      wp_3: { x: 50, y: 64, z: 0, torch_at: { x: 50, y: 64, z: 0 } },
    },
  });
  const r = await h.actions.waypoint({ name: 'wp_3', x: 0, y: 64, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data.old_torch.kind, 'out_of_reach');
  assert.match(r.next_action_hint, /old torch at \(50,64,0\)/);
  assert.equal(h.dug.length, 0);
});

test('handler: fluid below → NO_TORCH_ANCHOR loud-fails, mark not saved', async () => {
  const h = makeHarness({
    grid: { '0,64,0': 'air', '0,63,0': { name: 'water', bb: 'empty' } },
  });
  const r = await h.actions.waypoint({ name: 'wp_3', x: 0, y: 64, z: 0 });
  assertFailure(r, {
    code: 'NO_TORCH_ANCHOR',
    messageIncludes: 'fluid_below',
    observedKeys: ['decision', 'requested', 'waypoint'],
  });
  assert.equal(h.placeCalls.length, 0);
  // Mark not saved because the placement is impossible at the requested coord.
  assert.equal(h.locs().wp_3, undefined);
});

test('handler: place fails — waypoint mark already saved, place error surfaced', async () => {
  const h = makeHarness({
    grid: { '0,64,0': 'air', '0,63,0': 'grass_block' },
    placeResult: { ok: false, error: { code: 'INVENTORY_MISSING', message: 'No torch', retry_safe: false } },
  });
  const r = await h.actions.waypoint({ name: 'wp_3', x: 0, y: 64, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVENTORY_MISSING');
  assert.equal(r.error.observed_state.waypoint_saved, true);
  // Plan §5.1: the mark IS the planner's source of truth — saved even when
  // the torch placement deferred (so a later `mc waypoint` retry / a bot
  // with inventory can finish the job).
  assert.deepEqual(h.locs().wp_3.torch_at, { x: 0, y: 64, z: 0 });
});
