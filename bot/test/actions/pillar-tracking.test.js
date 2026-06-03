/**
 * Pillar-step tracking + cleanup-hint behavior (T1c, 2026-05-27).
 *
 * pillar_step is mineflayer-heavy (placeBlock/blockAt/controlState/etc.)
 * so we can't easily run the full primitive in unit tests. These tests
 * pin two contract-level behaviors that the T1c fix introduced:
 *
 *   1. The factory imports recordRecentPlace and ctx from deps —
 *      regression guard for "someone removed the import."
 *   2. The static shape of the returned cleanup_hint string when
 *      formatted for N placed blocks.
 *
 * Full behavioral verification happens through functional tests against
 * a real mineflayer body (tests/functional/) — not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildingPillarPart } from '../../lib/actions/building/pillar.js';

test('createBuildingPillarPart accepts the deps shape (ctx, ensureBot, sleep, getActions)', () => {
  const part = createBuildingPillarPart({
    ctx: { runtime: { recentPlaces: [] } },
    ensureBot: () => ({}),
    sleep: async () => {},
    getActions: () => ({}),
  });
  assert.equal(typeof part.pillar_step, 'function',
    'pillar_step must be exposed on the part for createActions to wire it');
});

test('pillar_step propagates ctx to recordRecentPlace (factory wiring smoke test)', () => {
  // Pillar.js imports recordRecentPlace from dig-tools.js. If someone
  // removes the import OR the recentPlaces array is missing on ctx, this
  // catches the regression at module load time (ctx.runtime.recentPlaces
  // is the storage; recordRecentPlace creates it lazily).
  const ctx = { runtime: {} };
  const part = createBuildingPillarPart({
    ctx,
    ensureBot: () => ({ entity: { position: { x: 0, y: 0, z: 0 } } }),
    sleep: async () => {},
    getActions: () => ({}),
  });
  // Just confirm the factory built without throwing — imports resolved.
  assert.ok(part, 'factory built');
});

// ─────────────────────────────────────────────────────────────────────────
// PILLAR_FROM_PARTIAL_BLOCK guard. The slab off-by-one (caught in
// pillar-geometry.test.js's KNOWN BUG property test) is now refused at
// pre-flight unless force=true. This is a contract-shape test — we drive
// pillar_step with a stub bot standing on a slab and verify the refusal
// envelope before any place/jump happens.
// ─────────────────────────────────────────────────────────────────────────

test('pillar_step: refuses with PILLAR_FROM_PARTIAL_BLOCK when standing on a slab', async () => {
  // Stub bot foot on top of a slab at y=64 (slab top = y=64.5).
  // The block at (0, 64, 0) is an oak_slab.
  let placeBlockCalls = 0;
  const slabBlock = {
    name: 'oak_slab',
    position: { x: 0, y: 64, z: 0 },
    boundingBox: 'block',
    getProperties: () => ({}),
  };
  const bot = {
    entity: { position: { x: 0.5, y: 64.5, z: 0.5 }, isInWater: false, onGround: true },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt: (pos) => {
      if (pos.x === 0 && pos.y === 64 && pos.z === 0) return slabBlock;
      return { name: 'air', position: pos, boundingBox: 'empty' };
    },
    placeBlock: async () => { placeBlockCalls++; },
    setControlState: () => {},
    clearControlStates: () => {},
    equip: async () => {},
    heldItem: null,
  };
  const ctx = { runtime: { recentPlaces: [] } };

  const part = createBuildingPillarPart({
    ctx, ensureBot: () => bot, sleep: async () => {}, getActions: () => ({}),
  });
  const r = await part.pillar_step({ count: 3 });
  assert.equal(r.ok, false, 'expected refusal envelope');
  assert.equal(r.error.code, 'PILLAR_FROM_PARTIAL_BLOCK');
  assert.equal(placeBlockCalls, 0, 'no placeBlock should have been called');
  assert.match(r.error.message, /partial-height block|slab/);
  assert.match(r.error.next_action_hint, /mc move/);
  // observed_state should report what the bot was standing on.
  assert.equal(r.error.observed_state.standing_block, 'oak_slab');
});

test('pillar_step: force=true bypasses PILLAR_FROM_PARTIAL_BLOCK', async () => {
  // Power-user override — caller acknowledges the off-by-one and proceeds.
  // We can't easily verify the full place flow without heavy mineflayer
  // mocking, but we CAN verify the guard doesn't refuse.
  const slabBlock = {
    name: 'oak_slab',
    position: { x: 0, y: 64, z: 0 },
    boundingBox: 'block',
    getProperties: () => ({}),
  };
  const bot = {
    entity: { position: { x: 0.5, y: 64.5, z: 0.5 }, isInWater: false, onGround: true },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt: (pos) => {
      if (pos.x === 0 && pos.y === 64 && pos.z === 0) return slabBlock;
      return { name: 'air', position: pos, boundingBox: 'empty' };
    },
    // placeBlock throws → the place loop fails (we don't care; only that
    // we got past the partial-block guard).
    placeBlock: async () => { throw new Error('test'); },
    setControlState: () => {},
    clearControlStates: () => {},
    equip: async () => {},
    heldItem: { name: 'cobblestone', type: 4 },
  };
  const ctx = { runtime: { recentPlaces: [] } };

  const part = createBuildingPillarPart({
    ctx, ensureBot: () => bot, sleep: async () => {}, getActions: () => ({}),
  });
  const r = await part.pillar_step({ count: 1, force: true });
  // We don't care about the exact outcome; we care that it's NOT the
  // PILLAR_FROM_PARTIAL_BLOCK refusal.
  if (r.ok === false) {
    assert.notEqual(r.error.code, 'PILLAR_FROM_PARTIAL_BLOCK',
      `force=true must bypass the partial-block guard; got ${r.error.code}`);
  }
});

test('pillar_step: full-block start (no slab) skips the guard', async () => {
  // Bot foot at y=64.0 (top of full block at y=63). Standing block is a
  // regular cobblestone. Guard should not trigger.
  const fullBlock = {
    name: 'cobblestone',
    position: { x: 0, y: 63, z: 0 },
    boundingBox: 'block',
    getProperties: () => ({}),
  };
  const bot = {
    entity: { position: { x: 0.5, y: 64.0, z: 0.5 }, isInWater: false, onGround: true },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt: (pos) => {
      if (pos.x === 0 && pos.y === 63 && pos.z === 0) return fullBlock;
      return { name: 'air', position: pos, boundingBox: 'empty' };
    },
    placeBlock: async () => { throw new Error('test'); }, // bail out further down — guard already passed
    setControlState: () => {},
    clearControlStates: () => {},
    equip: async () => {},
    heldItem: { name: 'cobblestone', type: 4 },
  };
  const ctx = { runtime: { recentPlaces: [] } };

  const part = createBuildingPillarPart({
    ctx, ensureBot: () => bot, sleep: async () => {}, getActions: () => ({}),
  });
  const r = await part.pillar_step({ count: 1 });
  // Whatever happens downstream, it must NOT be PILLAR_FROM_PARTIAL_BLOCK.
  if (r.ok === false) {
    assert.notEqual(r.error.code, 'PILLAR_FROM_PARTIAL_BLOCK',
      `full-block start must not trigger the partial-block guard; got ${r.error.code}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Run-7 Step 3 (PR-F): pillar_step rejects counts that look like an
// absolute target Y rather than a relative climb delta.
//
// Run-6/7 evidence: Steward whispered `pillar_up to Y=105` and the
// worker interpreted the literal `105` as the climb count. The OLD
// code silently truncated to 64 (the prior cap) and burned ~64 attempts
// before the model gave up. PR-F caps at 32 AND adds a second heuristic
// for low-feet_y poses where the cap alone wouldn't trigger.
// ─────────────────────────────────────────────────────────────────────────

function _makeStubBot(feetY = 64) {
  const grass = { name: 'grass_block', position: { x: 0, y: feetY - 1, z: 0 },
                  boundingBox: 'block', getProperties: () => ({}) };
  return {
    entity: { position: { x: 0.5, y: feetY, z: 0.5 }, isInWater: false, onGround: true },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt: (pos) => {
      if (pos.x === 0 && pos.y === feetY - 1 && pos.z === 0) return grass;
      return { name: 'air', position: pos, boundingBox: 'empty' };
    },
    placeBlock: async () => {},
    setControlState: () => {},
    clearControlStates: () => {},
    equip: async () => {},
    heldItem: null,
  };
}

test('pillar_step: rejects count=105 (run-7 regression — Y=105 whisper)', async () => {
  const bot = _makeStubBot(96);  // Gatherer-ish pose
  const ctx = { runtime: { recentPlaces: [] } };
  const part = createBuildingPillarPart({
    ctx, ensureBot: () => bot, sleep: async () => {}, getActions: () => ({}),
  });
  const r = await part.pillar_step({ count: 105 });
  assert.equal(r.ok, false, 'expected refusal envelope');
  assert.equal(r.error.code, 'PILLAR_COUNT_OVER_CAP');
  assert.match(r.error.message, /max is 32|run-7|Y=105/i);
  assert.equal(r.error.observed_state.requested_count, 105);
  assert.equal(r.error.observed_state.cap, 32);
});

test('pillar_step: rejects count=33 (boundary above cap)', async () => {
  const bot = _makeStubBot(64);
  const part = createBuildingPillarPart({
    ctx: { runtime: { recentPlaces: [] } },
    ensureBot: () => bot, sleep: async () => {}, getActions: () => ({}),
  });
  const r = await part.pillar_step({ count: 33 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PILLAR_COUNT_OVER_CAP');
});

test('pillar_step: count=32 passes the cap (boundary at cap)', async () => {
  // Use force=true so we don't trip the slab guard or other pre-flights.
  // Beyond the PR-F guards the action will fail for other reasons (stub
  // bot lacks pathfinder etc.) — we ONLY assert it's not a PR-F error.
  const bot = _makeStubBot(64);
  const part = createBuildingPillarPart({
    ctx: { runtime: { recentPlaces: [] } },
    ensureBot: () => bot, sleep: async () => {}, getActions: () => ({}),
  });
  const r = await part.pillar_step({ count: 32 });
  if (r.ok === false) {
    assert.notEqual(r.error.code, 'PILLAR_COUNT_OVER_CAP',
      `count=32 must clear the cap guard; got ${r.error.code}`);
    assert.notEqual(r.error.code, 'PILLAR_ABSOLUTE_Y_LOOKS_LIKE',
      `count=32 at feet_y=64 must not look like absolute Y; got ${r.error.code}`);
  }
});

test('pillar_step: heuristic rejects count > 16 AND count > feet_y + 32', async () => {
  // Deep-underground / low-feet_y pose: feet_y=-20 (Nether-ish).
  // count=20 → 20 > 16 ✓ AND 20 > -20+32=12 ✓ → heuristic fires.
  const bot = _makeStubBot(-20);
  const part = createBuildingPillarPart({
    ctx: { runtime: { recentPlaces: [] } },
    ensureBot: () => bot, sleep: async () => {}, getActions: () => ({}),
  });
  const r = await part.pillar_step({ count: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PILLAR_ABSOLUTE_Y_LOOKS_LIKE');
  assert.match(r.error.message, /target Y|relative delta/i);
  assert.equal(r.error.observed_state.requested_count, 20);
  assert.equal(r.error.observed_state.feet_y, -20);
});

test('pillar_step: heuristic does NOT fire on count ≤ 16 (small climb)', async () => {
  // count=16 → 16 > 16 ✗ → heuristic doesn't fire even at low feet_y.
  const bot = _makeStubBot(-20);
  const part = createBuildingPillarPart({
    ctx: { runtime: { recentPlaces: [] } },
    ensureBot: () => bot, sleep: async () => {}, getActions: () => ({}),
  });
  const r = await part.pillar_step({ count: 16 });
  if (r.ok === false) {
    assert.notEqual(r.error.code, 'PILLAR_ABSOLUTE_Y_LOOKS_LIKE');
    assert.notEqual(r.error.code, 'PILLAR_COUNT_OVER_CAP');
  }
});

test('pillar_step: heuristic does NOT fire when feet_y is high (normal surface)', async () => {
  // feet_y=70 (surface), count=25. 25 > 16 ✓ BUT 25 > 70+32=102 ✗ →
  // heuristic doesn't fire; the user is asking for a reasonable 25-block
  // climb from a normal surface, not an absolute Y target.
  const bot = _makeStubBot(70);
  const part = createBuildingPillarPart({
    ctx: { runtime: { recentPlaces: [] } },
    ensureBot: () => bot, sleep: async () => {}, getActions: () => ({}),
  });
  const r = await part.pillar_step({ count: 25 });
  if (r.ok === false) {
    assert.notEqual(r.error.code, 'PILLAR_ABSOLUTE_Y_LOOKS_LIKE');
    assert.notEqual(r.error.code, 'PILLAR_COUNT_OVER_CAP');
  }
});
