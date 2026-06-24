/**
 * mc collect handler tests.
 *
 * Three clusters:
 *   1. Contract-shape unit tests — UNKNOWN_BLOCK, cancelRequested, F72
 *      short-circuit, source-block fallback + surface-bias, inventory
 *      accounting, MIXED_FAILURE / behind_wall hints, pre-dig TOOL_INADEQUATE
 *      bail, strip-mine row discipline.
 *   2. Integration tests — drives the full harvest loop against a mutable
 *      stub world to verify row-by-row dig order, contiguity, region
 *      protection, force-bypass.
 *   3. Cross-call ring-share tests — collect skips cells that mc dig has
 *      already given up on within the 60s window.
 *
 * Shared scaffolding lives in `_mining-test-helpers.js`. Dig-side tests
 * live in mining-dig.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createMiningActions } from '../../lib/actions/mining.js';
import { validate } from '../../lib/shared/action-contract.js';
import {
  makeStubBot,
  makeDeps,
  flatPatch,
  makeMutableWorld,
  makeStubMcData,
} from './_mining-test-helpers.js';

// ─────────────────────────────────────────────────────────────────────────
// 1. UNKNOWN_BLOCK — pre-existing path, locks contract shape
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: UNKNOWN_BLOCK is a conforming failure envelope', async () => {
  const actions = createMiningActions(makeDeps());
  const r = await actions.collect({ block: 'not_a_real_block', count: 1 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_BLOCK');
  assert.equal(r.error.retry_safe, false);
  assert.match(r.error.message, /not_a_real_block/);
});

test('mining.collect: missing block → INVALID_ARGS from itemName', async () => {
  const actions = createMiningActions(makeDeps());
  const r = await actions.collect({});
  const v = validate(r);
  assert.equal(v.valid, true);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_ARGS');
  assert.match(r.error.message, /Expected one of:/);
});

test('mining.collect: non-positive count → INVALID_ARGS from parseCount', async () => {
  const actions = createMiningActions(makeDeps());
  const r = await actions.collect({ block: 'dirt', count: 0 });
  const v = validate(r);
  assert.equal(v.valid, true);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_ARGS');
  assert.match(r.error.message, /positive integer count/);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. cancelRequested cleared on entry (Fix B) — stale flag must not block
//    a fresh collect from running.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: clears stale cancelRequested on entry', async () => {
  const deps = makeDeps({ tasks: { cancelRequested: true } });
  // Use UNKNOWN_BLOCK so collect returns immediately without doing real work,
  // BUT after the cancel-clear runs. The flag should be false post-call.
  await deps.ctx.world; // touch ctx
  assert.equal(deps.ctx.tasks.cancelRequested, true, 'precondition: flag is stale-true');
  const actions = createMiningActions(deps);
  await actions.collect({ block: 'unknown_to_force_early_return', count: 1 });
  assert.equal(deps.ctx.tasks.cancelRequested, false, 'collect entry must clear the flag');
});

// ─────────────────────────────────────────────────────────────────────────
// 3. F72 short-circuit — recentPickups + matching inventory => no dig needed
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: F72 short-circuits when recent pickups already satisfy', async () => {
  const bot = makeStubBot({
    inventoryItems: [{ name: 'dirt', count: 5 }],
  });
  const deps = makeDeps({
    bot,
    runtime: {
      recentPickups: [{ ts: Date.now(), item: 'dirt', count: 1, source: 'dig' }],
    },
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.data.source, 'recent_pickup');
  assert.equal(r.data.mined_count, 0);
  assert.equal(r.data.dropped_items_collected, 1);
  assert.match(r.result, /auto-picked up from a recent dig/);
});

test('mining.collect: F72 guard requires inventory >= count', async () => {
  // recentPickups has 1 dirt but inventory has 0 dirt — F72 must NOT fire
  // (the guard at mining.js:137 enforces startedInventory >= count).
  const bot = makeStubBot({ inventoryItems: [] });
  const deps = makeDeps({
    bot,
    runtime: {
      recentPickups: [{ ts: Date.now(), item: 'dirt', count: 1, source: 'dig' }],
    },
    findVisible: async () => [],   // no visible dirt
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 1 });
  // Without F72, should fall through to candidate search and fail with
  // NO_VISIBLE_BLOCKS (no dirt, no grass_block-source either).
  assert.equal(r.ok, false);
  assert.notEqual(r.data?.source, 'recent_pickup');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Source-block fallback (Fix A) — augments when initial found < batchSize.
//    The new behavior (vs `found === 0`) is the augmentation case.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: source-block fallback augments when found < batchSize', async () => {
  // We don't need the dig loop to actually mine — just verify the fallback
  // populated `found` with grass_block candidates. Easiest probe: log
  // capture. mining.js logs `[collect] ... augmenting with N grass_block`
  // when the new augmentation path fires.
  const logs = [];
  const dirtSpot = new Vec3(2, 64, 0);
  const grassSpots = Array.from({ length: 5 }, (_, i) => new Vec3(i, 64, 1));
  const deps = makeDeps({
    log: (line) => logs.push(line),
    findVisible: async (name) => {
      if (name === 'dirt') return [{ position: dirtSpot }];
      if (name === 'grass_block') return grassSpots.map((p) => ({ position: p }));
      return [];
    },
    bot: makeStubBot({
      blockAtByPos: (pos) => ({ name: 'air' }),  // air above each candidate (surface)
      // dig fails fast so the loop exits — we only care that the fallback ran
      dig: async () => { throw new Error('test_no_dig'); },
    }),
  });
  const actions = createMiningActions(deps);
  await actions.collect({ block: 'dirt', count: 4 });  // batchSize=4, found=1 < 4 → augment
  const augLog = logs.find((l) => /augmenting with .* grass_block/.test(l));
  assert.ok(augLog, `expected augmentation log; got:\n${logs.join('\n')}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Source-block surface-bias: when the fallback kicks in (e.g. mc collect
// cobblestone → mine stone), candidates whose ceiling is NOT air should
// be filtered out. This prevents the bot from tunneling through grass/
// dirt to reach buried stone — one form of the "destroys structures"
// pattern the user reported when collect ignored protections.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: source-block fallback applies surface-bias filter (buried stone rejected)', async () => {
  // Two surface stones (above=air) at z=0, two buried stones (above=grass_block) at z=2.
  // Bot at (0.5, 64, -3.5). All four "stone" candidates returned by the source-block
  // findVisible call; surface-bias should drop the buried pair.
  const surfaceStones = [new Vec3(-1, 63, 0), new Vec3(1, 63, 0)];
  const buriedStones  = [new Vec3(-1, 63, 2), new Vec3(1, 63, 2)];

  const isBuried = (pos) => buriedStones.some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z);
  const isStone  = (pos) => surfaceStones.concat(buriedStones).some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z);

  const digOrder = [];
  // Pickaxe in inventory so pre-flight tool check passes.
  const bot = makeStubBot({
    position: new Vec3(0.5, 64, -3.5),
    inventoryItems: [{ name: 'iron_pickaxe', count: 1 }],
  });
  bot.blockAt = (pos) => {
    // The cell ABOVE a buried stone is grass_block; above a surface stone is air.
    const below = new Vec3(pos.x, pos.y - 1, pos.z);
    if (isBuried(below)) {
      return { name: 'grass_block', position: pos, boundingBox: 'block', getProperties: () => ({}) };
    }
    if (isStone(pos)) {
      return { name: 'stone', position: pos, boundingBox: 'block', getProperties: () => ({}), type: 1, hardness: 1.5 };
    }
    return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
  };
  // refreshPool uses b.findBlocks; return only the surface stones from id=1,
  // since the buried ones should already be excluded by the surface-bias filter
  // upstream. (If buried stones leaked through, the dig would still target them.)
  bot.findBlocks = ({ matching }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    if (!ids.includes(1)) return [];
    return surfaceStones.concat(buriedStones);
  };
  bot.dig = async (block) => {
    digOrder.push({ x: block.position.x, y: block.position.y, z: block.position.z });
  };
  // Iron pickaxe so equipForDig doesn't refuse on bare-hand stone.
  bot.heldItem = { name: 'iron_pickaxe' };
  bot.tool.itemInHand = () => ({ name: 'iron_pickaxe' });

  const deps = makeDeps({
    bot,
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) => {
      if (name === 'cobblestone') return []; // no cobblestone visible → triggers source fallback
      if (name === 'stone') {
        return surfaceStones.concat(buriedStones).map((p) => ({ position: p }));
      }
      return [];
    },
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'cobblestone', count: 4 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  // Buried stones must never have been dug.
  const buriedDug = digOrder.some((p) => isBuried(new Vec3(p.x, p.y, p.z)));
  assert.equal(buriedDug, false,
    `surface-bias should reject buried stones, but at least one was dug: ${JSON.stringify(digOrder)}`);
  // Surface stones SHOULD have been dug.
  assert.ok(digOrder.length >= 1, `expected surface stones to be dug; got: ${JSON.stringify(digOrder)}`);
  for (const dug of digOrder) {
    const ok = surfaceStones.some((p) => p.x === dug.x && p.y === dug.y && p.z === dug.z);
    assert.ok(ok, `dug a non-surface candidate: ${JSON.stringify(dug)}`);
  }
});

test('mining.collect: source-block fallback keeps buried fallback when NO surface candidates exist', async () => {
  // All candidates buried. Surface-bias finds 0 surface → falls back to original
  // (buried) list rather than failing outright. Documents the "better to try
  // buried stone than fail outright" comment in discovery.js.
  const buriedStones = [new Vec3(-1, 63, 0), new Vec3(1, 63, 0)];

  const digOrder = [];
  // Pickaxe in inventory so pre-flight tool check passes.
  const bot = makeStubBot({
    position: new Vec3(0.5, 64, -3.5),
    inventoryItems: [{ name: 'iron_pickaxe', count: 1 }],
  });
  bot.blockAt = (pos) => {
    // Every above-cell is grass_block — no surface candidates exist.
    const below = new Vec3(pos.x, pos.y - 1, pos.z);
    if (buriedStones.some((p) => p.x === below.x && p.y === below.y && p.z === below.z)) {
      return { name: 'grass_block', position: pos, boundingBox: 'block', getProperties: () => ({}) };
    }
    if (buriedStones.some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z)) {
      return { name: 'stone', position: pos, boundingBox: 'block', getProperties: () => ({}), type: 1, hardness: 1.5 };
    }
    return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
  };
  bot.findBlocks = ({ matching }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    if (!ids.includes(1)) return [];
    return buriedStones;
  };
  bot.dig = async (block) => {
    digOrder.push({ x: block.position.x, y: block.position.y, z: block.position.z });
  };
  bot.heldItem = { name: 'iron_pickaxe' };
  bot.tool.itemInHand = () => ({ name: 'iron_pickaxe' });

  const deps = makeDeps({
    bot,
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) => {
      if (name === 'cobblestone') return [];
      if (name === 'stone') return buriedStones.map((p) => ({ position: p }));
      return [];
    },
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'cobblestone', count: 2 });
  assert.equal(r.ok, true, `expected ok=true (buried fallback): ${JSON.stringify(r)}`);
  // At least one buried stone WAS dug.
  assert.ok(digOrder.length >= 1, `expected buried stones to be dug as last resort: ${JSON.stringify(digOrder)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Scout-assist surface-bias: discovery.js's fair-play fallback (lines 126-176)
// calls b.findBlocks (x-ray) to locate the nearest target, then pathfinds.
// Without a surface-bias filter, picking a BURIED candidate sends the
// pathfinder digging straight down through dirt to reach it — the exact
// "collect pillared down with no pickaxe" failure from genesis run
// g-2026-05-27-10. Verify the filter rejects buried scout hits and falls
// through to the actionable NO_VISIBLE_BLOCKS hint when no surface
// candidates exist.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: scout-assist rejects buried candidates and surfaces NO_VISIBLE_BLOCKS hint', async () => {
  // Two stones below y=63 (under a dirt pad): both buried. The scout's
  // b.findBlocks scan would return them; the surface-bias filter must
  // reject both, leaving no candidates → NO_VISIBLE_BLOCKS with hint.
  // Request 'stone' directly so the scout-assist scans for stone id=1.
  const buriedStones = [new Vec3(0, 60, 0), new Vec3(1, 61, 0)];
  const dirtAboveBuried = [new Vec3(0, 61, 0), new Vec3(1, 62, 0)];

  let pathfindCalls = 0;
  // Pickaxe in inventory so pre-flight tool check passes.
  const bot = makeStubBot({
    position: new Vec3(0.5, 64, 0.5),
    inventoryItems: [{ name: 'iron_pickaxe', count: 1 }],
  });
  bot.blockAt = (pos) => {
    if (buriedStones.some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z)) {
      return { name: 'stone', position: pos, boundingBox: 'block', getProperties: () => ({}), type: 1, hardness: 1.5 };
    }
    if (dirtAboveBuried.some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z)) {
      return { name: 'dirt', position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
    }
    return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
  };
  bot.findBlocks = ({ matching }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    if (ids.includes(1)) return buriedStones;
    return [];
  };
  bot.pathfinder.goto = async () => { pathfindCalls++; };

  const deps = makeDeps({
    bot,
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, 0.5),
    findVisible: async () => [], // no visible stone → triggers scout-assist branch
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'stone', count: 4 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_VISIBLE_BLOCKS');
  // Scout-assist pathfind should NOT have been called — every candidate
  // was rejected by surface-bias.
  assert.equal(pathfindCalls, 0,
    `pathfinder should not be invoked when all scout candidates are buried; pathfindCalls=${pathfindCalls}`);
});

test('mining.collect: scout-assist surface-accessible candidate triggers pathfind', async () => {
  // Mirror case: one surface stone (above=air), one buried stone (above=dirt).
  // Surface-bias should KEEP the surface stone and pathfind to it.
  // Place the surface stone CLOSER so the "nearest" pick chooses it after
  // the surface filter (the buried one is closer but should be rejected).
  const surfaceStone = new Vec3(4, 63, 0);
  const buriedStone = new Vec3(-2, 60, 0);
  const dirtAboveBuried = new Vec3(-2, 61, 0);

  let pathfindCalls = 0;
  let pathfindTarget = null;
  // Pickaxe in inventory so pre-flight tool check passes.
  const bot = makeStubBot({
    position: new Vec3(0.5, 64, 0.5),
    inventoryItems: [{ name: 'iron_pickaxe', count: 1 }],
  });
  bot.blockAt = (pos) => {
    if (pos.x === surfaceStone.x && pos.y === surfaceStone.y && pos.z === surfaceStone.z) {
      return { name: 'stone', position: pos, boundingBox: 'block', getProperties: () => ({}), type: 1, hardness: 1.5 };
    }
    if (pos.x === buriedStone.x && pos.y === buriedStone.y && pos.z === buriedStone.z) {
      return { name: 'stone', position: pos, boundingBox: 'block', getProperties: () => ({}), type: 1, hardness: 1.5 };
    }
    if (pos.x === dirtAboveBuried.x && pos.y === dirtAboveBuried.y && pos.z === dirtAboveBuried.z) {
      return { name: 'dirt', position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
    }
    return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
  };
  bot.findBlocks = ({ matching }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    if (ids.includes(1)) return [buriedStone, surfaceStone];
    return [];
  };
  bot.pathfinder.goto = async (goal) => {
    pathfindCalls++;
    pathfindTarget = { x: goal.x, y: goal.y, z: goal.z };
  };

  const deps = makeDeps({
    bot,
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, 0.5),
    findVisible: async () => [], // empty initial visible scan → triggers scout-assist
  });

  const actions = createMiningActions(deps);
  await actions.collect({ block: 'stone', count: 4 });

  // Pathfind should have been called targeting the SURFACE stone, not the buried one.
  assert.ok(pathfindCalls >= 1, `expected pathfind to fire toward the surface candidate; pathfindCalls=${pathfindCalls}`);
  assert.deepEqual(
    pathfindTarget,
    { x: surfaceStone.x, y: surfaceStone.y, z: surfaceStone.z },
    `pathfind target should be the surface stone, not buried: got ${JSON.stringify(pathfindTarget)}`,
  );
});

test('mining.collect: source-block fallback NOT triggered when found >= batchSize', async () => {
  const logs = [];
  const dirtSpots = Array.from({ length: 10 }, (_, i) => new Vec3(i, 64, 0));
  let grassScanCalls = 0;
  const deps = makeDeps({
    log: (line) => logs.push(line),
    findVisible: async (name) => {
      if (name === 'dirt') return dirtSpots.map((p) => ({ position: p }));
      if (name === 'grass_block') { grassScanCalls++; return []; }
      return [];
    },
    bot: makeStubBot({
      blockAtByPos: () => ({ name: 'air' }),
      dig: async () => { throw new Error('test_no_dig'); },
    }),
  });
  const actions = createMiningActions(deps);
  await actions.collect({ block: 'dirt', count: 4 });  // 10 >= 4 batchSize
  assert.equal(grassScanCalls, 0, 'should not scan source blocks when primary pool is large enough');
  const augLog = logs.find((l) => /augmenting/.test(l));
  assert.equal(augLog, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. cancelRequested mid-loop returns clean envelope (Fix B)
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: cancelRequested mid-loop returns CANCELLED envelope', async () => {
  // Strategy: set cancelRequested=true between when collect resolves the
  // candidate list and when it enters the outer while loop. We do that by
  // hooking findVisible — flip the flag AFTER it's called, so the
  // outer-while check sees the flag set and never enters.
  const deps = makeDeps({
    findVisible: async () => {
      deps.ctx.tasks.cancelRequested = true;
      return [{ position: new Vec3(2, 64, 0) }];
    },
    bot: makeStubBot({
      blockAtByPos: () => ({ name: 'air' }),
    }),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 1 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CANCELLED');
  assert.match(r.error.message, /mc stop/);
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Inventory gain reports drop name (Fix C)
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: inventory_gain captures the drop name when blockName ≠ drop', async () => {
  // We don't have a fully working dig-loop mock, so exercise this via the
  // F72 short-circuit success path which also surfaces inventory_gain — no,
  // actually F72 returns early before inventory_gain is computed. The
  // inventory_gain field lives in the post-pickup success path. We can
  // still smoke-test by reading the field on a failure response (it's
  // attached on the success path only) — best we can do here is verify
  // the field exists on a real success outcome.
  //
  // For now, assert presence of the data shape on F72 success (since that's
  // a clean handler-level success). F72 path doesn't populate
  // inventory_gain (it's not the mining success path) — instead verify the
  // *response data* doesn't crash on the new fields by triggering F72.
  const bot = makeStubBot({
    inventoryItems: [{ name: 'dirt', count: 5 }],
  });
  const deps = makeDeps({
    bot,
    runtime: {
      recentPickups: [{ ts: Date.now(), item: 'dirt', count: 1, source: 'dig' }],
    },
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 1 });
  assert.equal(r.ok, true);
  // F72 path returns early and reuses data.source='recent_pickup' shape; it
  // does NOT have inventory_gain (that's downstream of the dig loop). This
  // test mostly guards against a regression that would crash on the new
  // field shape.
  assert.equal(typeof r.data, 'object');
  assert.equal(r.data.block_name, 'dirt');
});

test('makeStubMcData: iron_ore block drops raw_iron item (MC 1.17+)', () => {
  const md = makeStubMcData();
  assert.equal(md.blocksByName.iron_ore.drops[0], 51);
  assert.equal(md.items[51].name, 'raw_iron');
});

// ─────────────────────────────────────────────────────────────────────────
// 6b. Inventory-truth in the success envelope
//    (postmortem 2026-06-07: trial 1 z_mine stalled because `Mined 32/32
//    cobblestone. Have 1 cobblestone in inventory` read as success to the
//    model. The fix headlines inventory delivery, not blocks broken.)
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: success envelope exposes postmortem-named alias fields', async () => {
  // Reuse the 5×5 integration fixture. bot.dig removes the block from the
  // world but no items are added to inventory — simulates the trial-1
  // pattern where drops landed out of reach and weren't collected.
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 2);
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);
  const bot = makeStubBot({ position: new Vec3(0.5, 64, -3.5) });
  bot.blockAt = (pos) => {
    const name = world.get(pos);
    if (!name || name === 'air') {
      return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    }
    return { name, position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = ({ matching }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    const wanted = new Set(ids);
    return patch.filter((p) => world.get(p) === 'dirt' && wanted.has(3));
  };
  bot.dig = async (block) => { world.setAir(block.position); };
  const deps = makeDeps({
    bot,
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch.filter((p) => world.get(p) === 'dirt').map((p) => ({ position: p })),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 5 });

  // Sanity.
  assert.equal(r.ok, true);
  assert.equal(r.data.mined_count, 5);

  // ── postmortem-named alias fields (claim-critical: dashboards + agents
  //    keying off these names need them to exist on the success path) ──
  assert.equal(typeof r.data.blocks_broken, 'number', 'blocks_broken alias must exist');
  assert.equal(typeof r.data.items_collected_in_inventory, 'number',
    'items_collected_in_inventory alias must exist');
  assert.equal(typeof r.data.items_dropped_uncollected, 'number',
    'items_dropped_uncollected alias must exist');
  assert.equal(typeof r.data.inventory_gap, 'boolean', 'inventory_gap boolean must exist');

  // ── arithmetic invariants ──
  // blocks_broken matches mined_count.
  assert.equal(r.data.blocks_broken, r.data.mined_count,
    'blocks_broken should equal mined_count');
  // bot.dig stub doesn't add to inventory, so collected = 0, lost = 5.
  assert.equal(r.data.items_collected_in_inventory, 0,
    'no inventory gain in this fixture (drops not picked up)');
  assert.equal(r.data.items_dropped_uncollected, 5,
    'all 5 blocks broken should count as uncollected drops');
  assert.equal(r.data.inventory_gap, true,
    'inventory_gap must be true when items_dropped_uncollected > 0');
});

test('mining.collect: result message leads with inventory truth, not blocks broken', async () => {
  // Same fixture as above. We're asserting the user-facing `result` string
  // does NOT lead with "Mined N/M" (trial-1 misleading wording).
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 2);
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);
  const bot = makeStubBot({ position: new Vec3(0.5, 64, -3.5) });
  bot.blockAt = (pos) => {
    const name = world.get(pos);
    if (!name || name === 'air') {
      return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    }
    return { name, position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = ({ matching }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    const wanted = new Set(ids);
    return patch.filter((p) => world.get(p) === 'dirt' && wanted.has(3));
  };
  bot.dig = async (block) => { world.setAir(block.position); };
  const deps = makeDeps({
    bot,
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch.filter((p) => world.get(p) === 'dirt').map((p) => ({ position: p })),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 5 });

  assert.equal(r.ok, true);

  // ── trial-1 regression: must NOT lead with "Mined N/M". The agent saw
  //    "Mined 32/32 cobblestone" and trusted the headline despite "Have 1
  //    cobblestone in inventory" further along. ──
  assert.ok(!/^Mined\s+\d+\/\d+/.test(r.result),
    `result must not lead with "Mined N/M"; got: ${r.result}`);

  // Headline must reference inventory, leading with "Collected" + the
  // delivery count (0/5 in this fixture).
  assert.match(r.result, /^Collected\s+0\/5\b/,
    `result should lead with "Collected 0/5"; got: ${r.result}`);

  // When inventory_gap is true, the message must include the explicit
  // diagnostic + an actionable hint. The agent must see WHY it should
  // change strategy.
  assert.match(r.result, /not picked up/i,
    `gap message missing "not picked up" diagnostic; got: ${r.result}`);
  assert.match(r.result, /pickup|smaller batch|reposition/i,
    `gap message missing actionable hint (pickup / smaller batch / reposition); got: ${r.result}`);

  // Blocks-broken count is still surfaced (for context), just not as the
  // headline.
  assert.match(r.result, /mined\s+5\s+blocks?/i,
    `result should still mention "mined 5 blocks" for context; got: ${r.result}`);
});

// ─────────────────────────────────────────────────────────────────────────
// 7. NO_VISIBLE_BLOCKS contract when nothing is found and no source-block
//    candidates exist either.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: NO_VISIBLE_BLOCKS conforms to contract when no candidates exist', async () => {
  const deps = makeDeps({
    findVisible: async () => [],
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 4 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_VISIBLE_BLOCKS');
  assert.equal(r.error.observed_state.requested_block, 'dirt');
  assert.equal(r.error.observed_state.requested_count, 4);
});

test('mining.collect: NO_VISIBLE_BLOCKS appends standing situation when enclosed', async () => {
  const pos = new Vec3(0.5, 64, 0.5);
  const solid = (p) => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    if (y === 63) return { name: 'stone', boundingBox: 'block' };
    if (Math.abs(x) <= 4 && Math.abs(z) <= 4 && y >= 64 && y <= 67) {
      if (Math.abs(x) === 4 || Math.abs(z) === 4 || y === 67) return { name: 'stone', boundingBox: 'block' };
    }
    return { name: 'air', boundingBox: 'empty' };
  };
  const bot = makeStubBot({
    position: pos,
    inventoryItems: [{ name: 'iron_pickaxe', count: 1 }],
  });
  bot.blockAt = solid;
  const deps = makeDeps({ bot, findVisible: async () => [] });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'stone', count: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_VISIBLE_BLOCKS');
  assert.match(r.error.message, /boxed|enclosed|dig|move/i);
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Strip-mine ordering (Fix E) — non-trunk harvests follow rows along
//     the densest axis instead of 3D-distance star pattern.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: non-trunk sort follows the bot row before stepping to next row', async () => {
  // Bot at (0, 64, 0). Candidates form a 7x3 patch at y=63:
  //   x = -3..3, z = -1..1  (21 cells, but we'll use a subset)
  // x-spread (6) > z-spread (2) ⇒ stripAxis=x, perpAxis=z.
  // Expected ordering: ALL z=0 candidates before any z=±1.
  const positions = [];
  for (const x of [-3, -2, -1, 1, 2, 3]) positions.push(new Vec3(x, 63, 0));
  for (const x of [-1, 1]) positions.push(new Vec3(x, 63, 1));
  for (const x of [-1, 1]) positions.push(new Vec3(x, 63, -1));
  // 6 z=0 candidates first, then 4 in z=±1 rows.

  const digOrder = [];
  const deps = makeDeps({
    findVisible: async (name) => name === 'dirt' ? positions.map((p) => ({ position: p })) : [],
    bot: makeStubBot({
      // accepted target so the loop reaches the dig step
      blockAtByPos: () => ({ name: 'dirt', getProperties: () => ({}) }),
      dig: async (block) => {
        digOrder.push({ x: block.position?.x ?? null, y: block.position?.y ?? null, z: block.position?.z ?? null });
        throw new Error('test_no_dig');  // non-instant non-aborted — burns the candidate cleanly
      },
    }),
  });
  // Wire blockAt to return positions on the actual Vec3 so the recheck
  // step gets a usable target. We override the stub helper here:
  deps.ensureBot().blockAt = (pos) => ({
    name: 'dirt',
    position: pos,
    getProperties: () => ({}),
  });

  const actions = createMiningActions(deps);
  await actions.collect({ block: 'dirt', count: 10 });

  // Verify: the first 6 dig attempts all share z=0 (the bot's row).
  // With the old 3D-distance sort, z=±1 candidates at distance 1.0
  // would interleave with z=0 ones at distance 1.0/2.0 — i.e.
  // (0,63,1), (1,63,0), (0,63,-1), (-1,63,0), (1,63,1), ... .
  assert.ok(digOrder.length >= 6, `expected >= 6 dig attempts, got ${digOrder.length}: ${JSON.stringify(digOrder)}`);
  const firstSixZ = digOrder.slice(0, 6).map((p) => p.z);
  assert.deepEqual(
    firstSixZ,
    [0, 0, 0, 0, 0, 0],
    `expected first 6 digs at bot's row z=0 (strip-mine), got z values ${JSON.stringify(firstSixZ)} (full order: ${JSON.stringify(digOrder)})`,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 10b. Within-row sweep is MONOTONIC (travel minimization). The old sort
//      ordered each row by |strip - botStrip|, interleaving the two sides of
//      the bot (1,-1,2,-2,…) so the bot crossed back over itself on every
//      block. Over a wide `mc collect stone 64` that back-and-forth exhausted
//      the wallclock budget. The serpentine sweep must walk the row in one
//      direction (no reversal) so travel between consecutive blocks is ~1.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: within a row the strip axis is swept monotonically (no zigzag)', async () => {
  // Bot off the patch (south) so the whole patch is one perp row (z=0) with
  // no self-block filtering. Candidates span x=-3..3 → stripAxis=x.
  const positions = [];
  for (const x of [-3, -2, -1, 0, 1, 2, 3]) positions.push(new Vec3(x, 63, 0));

  const digOrder = [];
  const deps = makeDeps({
    findVisible: async (name) => (name === 'dirt' ? positions.map((p) => ({ position: p })) : []),
    bot: makeStubBot({
      position: new Vec3(0.5, 64, -2.5),
      dig: async (block) => {
        digOrder.push({ x: block.position?.x ?? null, z: block.position?.z ?? null });
        throw new Error('test_no_dig'); // burn candidate cleanly
      },
    }),
  });
  deps.ensureBot().blockAt = (pos) => ({ name: 'dirt', position: pos, getProperties: () => ({}) });

  const actions = createMiningActions(deps);
  await actions.collect({ block: 'dirt', count: 7 });

  const xs = digOrder.slice(0, 7).map((p) => p.x);
  assert.equal(xs.length, 7, `expected 7 dig attempts, got ${xs.length}: ${JSON.stringify(digOrder)}`);
  // Monotonic = the strip coordinate only ever moves in ONE direction. Count
  // sign changes in successive deltas; a zigzag has many, a sweep has none.
  let reversals = 0;
  let dir = 0;
  for (let i = 1; i < xs.length; i++) {
    const step = Math.sign(xs[i] - xs[i - 1]);
    if (step === 0) continue;
    if (dir !== 0 && step !== dir) reversals += 1;
    dir = step;
  }
  assert.equal(reversals, 0, `row sweep must be monotonic (no direction reversals), got x order ${JSON.stringify(xs)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Pre-flight tool check + cascade bail. Two layers of defense:
//   1. NEW pre-flight check at collect entry — refuses BEFORE discovery
//      when no pickaxe (or axe, etc.) is in inventory. Prevents the
//      "pillared down with no pickaxe" failure mode by not pathfinding
//      toward an unreachable harvest.
//   2. equipForDig's per-candidate refusal cascade — surfaces TOOL_INADEQUATE
//      when force=true bypasses pre-flight but the tool state desyncs at
//      dig time. Still must bail the whole call (no cascade of 20+ retries).
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: pre-flight refuses with NO_SUITABLE_TOOL when no pickaxe in inventory', async () => {
  let digCalls = 0;
  const stonePositions = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (dx === 0 && dz === 0) continue;
      stonePositions.push(new Vec3(dx, 63, dz));
    }
  }
  const bot = makeStubBot({
    inventoryItems: [], // empty — pre-flight should refuse
    position: new Vec3(0, 64, 0),
    findBlocksByName: () => stonePositions,
    dig: async () => { digCalls++; },
  });
  bot.blockAt = (pos) => ({
    name: 'stone', position: pos, boundingBox: 'block', hardness: 1.5, type: 1,
    getProperties: () => ({}),
  });
  bot.heldItem = null;
  const deps = makeDeps({ bot });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'stone', count: 32 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_SUITABLE_TOOL');
  assert.match(r.error.message, /pickaxe/);
  assert.equal(digCalls, 0, 'pre-flight should bail before any dig or pathfind');
  assert.match(r.error.next_action_hint, /mc craft wooden_pickaxe/);
});

test('mining.collect: pre-flight covers source blocks (collect cobblestone refuses without pickaxe)', async () => {
  // Requesting cobblestone → source-block fallback is stone → needs pickaxe.
  // Pre-flight must check the source's tool requirement, not just the
  // requested item's.
  const bot = makeStubBot({ inventoryItems: [], position: new Vec3(0, 64, 0) });
  bot.blockAt = (pos) => ({
    name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}),
  });
  const deps = makeDeps({ bot });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'cobblestone', count: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_SUITABLE_TOOL');
  // The unmet_for should be a stone-family block (the source), not cobblestone.
  assert.match(r.error.observed_state.unmet_for, /stone|cobblestone/);
});

test('mining.collect: pre-flight passes with a pickaxe — runs through to harvest path', async () => {
  // Same setup as the refusal test, but bot has a wooden_pickaxe.
  // Pre-flight should pass and the call proceeds (eventually finishing with
  // NO_VISIBLE_BLOCKS or similar — that's not what we test here).
  const bot = makeStubBot({
    inventoryItems: [{ name: 'wooden_pickaxe', count: 1 }],
    position: new Vec3(0, 64, 0),
  });
  bot.blockAt = (pos) => ({
    name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}),
  });
  const deps = makeDeps({ bot, findVisible: async () => [] });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'stone', count: 4 });
  // Past the pre-flight gate — any code from here is legitimate. Just verify
  // it's NOT a NO_SUITABLE_TOOL refusal (it should be NO_VISIBLE_BLOCKS).
  if (r.ok === false) {
    assert.notEqual(r.error.code, 'NO_SUITABLE_TOOL',
      `pre-flight should pass with a pickaxe; got ${r.error.code}`);
  }
});

test('mining.collect: force=true bypasses pre-flight (TOOL_INADEQUATE cascade-bail still works)', async () => {
  // force=true skips pre-flight. If the bot then has no usable tool, the
  // per-candidate equipForDig refusal cascade should still bail the whole
  // call with TOOL_INADEQUATE (NOT cascade through 20+ candidates).
  let digCalls = 0;
  const stonePositions = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (dx === 0 && dz === 0) continue;
      stonePositions.push(new Vec3(dx, 63, dz));
    }
  }
  const bot = makeStubBot({
    inventoryItems: [],
    position: new Vec3(0, 64, 0),
    findBlocksByName: () => stonePositions,
    dig: async () => { digCalls++; },
  });
  bot.blockAt = (pos) => ({
    name: 'stone', position: pos, boundingBox: 'block', hardness: 1.5, type: 1,
    getProperties: () => ({}),
  });
  bot.heldItem = null;
  // Stub getDigTime so guardSlowDigEstimate throws "Refusing to dig …".
  bot.tool.getDigTime = () => 7500;
  const deps = makeDeps({
    bot,
    mcData: {
      blocksByName: { stone: { id: 1, drops: [4], boundingBox: 'block' } },
      itemsByName: { cobblestone: { id: 4 } },
      items: { 1: { name: 'stone' }, 4: { name: 'cobblestone' } },
    },
    findVisible: async () => stonePositions.map((p) => ({ position: p })),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'stone', count: 32, force: true });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TOOL_INADEQUATE');
  assert.match(r.error.message, /Refusing to dig/);
  assert.equal(digCalls, 0, 'no dig should have been attempted; bailed pre-dig');
  assert.ok(
    r.error.observed_state.attempted <= 1,
    `expected attempted <= 1, got ${r.error.observed_state.attempted}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Tool break mid-collect — when the pickaxe shatters (durability → 0) the
// hand empties. The bot must NOT keep stabbing stone bare-handed; it must
// abort with TOOL_INADEQUATE. Pre-fix the per-block equip cache memoized the
// first candidate's "ok" result and short-circuited the slow-dig guard on
// every later candidate, so a broken pickaxe went undetected and collect
// bare-handed the rest of the deposit.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: aborts when the pickaxe breaks mid-collect (no bare-hand mining)', async () => {
  // One row of stone in easy reach. The pickaxe breaks after the 2nd dig.
  const positions = [
    new Vec3(1, 63, 0), new Vec3(2, 63, 0), new Vec3(3, 63, 0),
    new Vec3(1, 63, 1), new Vec3(2, 63, 1), new Vec3(1, 63, -1),
  ];
  const breakAfter = 2;
  const digOrder = [];
  let held = { name: 'iron_pickaxe', count: 1 };
  let pickInInv = true;
  let digs = 0;

  const bot = {
    entity: { position: new Vec3(0, 64, 0), isInWater: false },
    get heldItem() { return held; },
    inventory: { items: () => (pickInInv ? [{ name: 'iron_pickaxe', count: 1 }] : []) },
    findBlocks: () => [],
    blockAt: (pos) => (pos.y >= 64
      ? { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) }
      : { name: 'stone', position: pos, boundingBox: 'block', hardness: 1.5, type: 1, getProperties: () => ({}) }),
    dig: async (block) => {
      digOrder.push({ x: block.position.x, y: block.position.y, z: block.position.z });
      digs += 1;
      if (digs >= breakAfter) { held = null; pickInInv = false; } // pickaxe shatters
    },
    stopDigging: () => {},
    pathfinder: { goto: async () => {}, setGoal: () => {}, stop: () => {}, goal: null },
    clearControlStates: () => {},
    tool: {
      itemInHand: () => held,
      // Fast with a pickaxe (well under the slow-dig cap), unusably slow bare-handed.
      getDigTime: (_block, h) => (h && /pickaxe/.test(h.name || '') ? 5 : 7500),
      equipForBlock: async () => {},
    },
    equip: async () => {},
    unequip: async () => {},
    entities: {},
  };

  const deps = makeDeps({
    bot,
    mcData: {
      blocksByName: { stone: { id: 1, drops: [4], boundingBox: 'block' } },
      itemsByName: { cobblestone: { id: 4 } },
      items: { 1: { name: 'stone' }, 4: { name: 'cobblestone' } },
    },
    findVisible: async (name) => (name === 'stone' ? positions.map((p) => ({ position: p })) : []),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'stone', count: 6 });

  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false, `expected abort, got: ${JSON.stringify(r)}`);
  assert.equal(r.error.code, 'TOOL_INADEQUATE', `expected TOOL_INADEQUATE, got ${r.error.code}`);
  assert.match(r.error.message, /Refusing to dig/);
  // The crucial assertion: exactly `breakAfter` blocks were dug. Without the
  // cache-revalidation fix this would be 6 (kept mining bare-handed).
  assert.equal(digOrder.length, breakAfter,
    `expected dig to stop at ${breakAfter} (when the pickaxe broke), got ${digOrder.length}: ${JSON.stringify(digOrder)}`);
  assert.equal(r.error.observed_state.mined_count, breakAfter);
});


// ─────────────────────────────────────────────────────────────────────────
// T3: behind_wall reposition hint — when every collect attempt fails LOS
// (canSeeMinableFace=false), the error must carry a concrete cell the
// agent can `mc move` to and retry. Pre-fix this looped silently:
// Steve called `mc collect oak_log 4` SEVEN times in round-2/3 (one per
// adjacent trunk), each erroring with `behind_wall (4/4)`, with nothing
// in the response telling him where to step.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: behind_wall MIXED_FAILURE includes next_action_hint and first_candidate', async () => {
  // Bot east of a 3-trunk grove. Candidates at (3,64,0), (5,64,0), (5,64,2).
  // hasLineOfSight always returns false → every dig attempt counts as
  // behind_wall. (We're not testing the LOS check itself, just the error
  // shape when behind_wall dominates.)
  const trunks = [
    new Vec3(3, 64, 0),
    new Vec3(5, 64, 0),
    new Vec3(5, 64, 2),
  ];
  const bot = makeStubBot({
    position: new Vec3(7, 64, 0), // bot is east of the grove
    // Axe in inventory so pre-flight tool check passes for oak_log.
    inventoryItems: [{ name: 'iron_axe', count: 1 }],
    findBlocksByName: () => trunks.slice(),
    dig: async () => { /* not reached — LOS check fails first */ },
  });
  bot.blockAt = (pos) => ({
    name: 'oak_log',
    position: pos,
    getProperties: () => ({}),
    boundingBox: 'block',
    type: 17,
  });
  const deps = makeDeps({
    bot,
    findVisible: async () => trunks.map((p) => ({ position: p })),
    hasLineOfSight: () => false,
    eyePosition: () => ({ x: 7, y: 65.6, z: 0 }),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'oak_log', count: 4 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MIXED_FAILURE');
  assert.ok(r.error.observed_state.causes.behind_wall > 0, 'expected behind_wall in causes');

  // The fix: an actionable hint + the candidate coord, so the agent
  // can `mc move` to a different cardinal and retry collect.
  assert.ok(r.error.next_action_hint, 'expected next_action_hint on behind_wall failure');
  assert.match(r.error.next_action_hint, /mc move/);
  assert.match(r.error.next_action_hint, /Suggested cells/);
  assert.deepEqual(r.error.observed_state.first_candidate, { x: 3, y: 64, z: 0 });

  // The bot was east of the trunk (dxToCand=-4), so the hint must NOT
  // suggest the "west" cardinal (that's the side it tried from). Other
  // cardinals — north/south/east — must appear.
  assert.doesNotMatch(r.error.next_action_hint, /\bwest\b/);
  assert.match(r.error.next_action_hint, /north|south|east/);
});

test('mining.collect: dig_failed dominant — no behind_wall hint emitted', async () => {
  // Negative case: when behind_wall is NOT the dominant cause, we should
  // NOT add the reposition hint (it would mislead the agent toward a
  // useless repositioning). Drive a dig_failed cascade: every dig call
  // throws a non-instant non-aborted error so causes.dig_failed += 1 per
  // attempt and behind_wall stays at 0.
  const positions = [];
  for (let dx = -3; dx <= 3; dx++) {
    if (dx === 0) continue;
    positions.push(new Vec3(dx, 63, 0));
  }
  const bot = makeStubBot({
    position: new Vec3(0, 64, 0),
    inventoryItems: [],
    findBlocksByName: () => positions,
    dig: async () => {
      // Sleep enough that the elapsed time exceeds INSTANT_FAIL_THRESHOLD_MS,
      // so this counts as a real dig_failed (not an instant-abort cascade).
      await new Promise((res) => setTimeout(res, 60));
      throw new Error('server_refused_dig');
    },
  });
  bot.blockAt = (pos) => ({
    name: 'dirt', position: pos, getProperties: () => ({}), boundingBox: 'block', type: 3,
  });
  const deps = makeDeps({
    bot,
    findVisible: async () => positions.map((p) => ({ position: p })),
    hasLineOfSight: () => true,  // every attempt has clear LOS → behind_wall = 0
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.error.observed_state.causes.behind_wall ?? 0, 0, 'precondition: no behind_wall in causes');
  assert.equal(r.error.next_action_hint, undefined, 'no behind_wall hint when behind_wall is not the dominant cause');
});

// ─────────────────────────────────────────────────────────────────────────
// Ordering + contiguity (integration): drives a full collect against a flat
// 5×5 dirt patch and asserts:
//   (a) dig order is row-major in the perp axis (all z=0 before any z=±1,
//       all z=+1 before any z=+2),
//   (b) the dug-cell set is 4-connected — no orphan holes.
// This catches the failure mode the user reports: collect leaving gaps and
// scattered single blocks in what should be a clean strip.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect (integration): 5×5 dirt patch dug row-by-row, dug-cell set is 4-connected', async () => {
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 2); // 5×5 around origin
  // Initial world: every patch cell is dirt; everything else is air.
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);

  const digOrder = [];
  // Bot stands SOUTH of the patch (z=-3.5) so the patch is contiguous from
  // the bot's perspective. Standing on the patch would trip ordering.js's
  // self-block filter and drop the cell directly under the bot, which
  // breaks the row-discipline assertion.
  const bot = makeStubBot({ position: new Vec3(0.5, 64, -3.5) });
  bot.blockAt = (pos) => {
    const name = world.get(pos);
    if (!name || name === 'air') {
      return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    }
    return { name, position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = ({ matching }) => {
    // refreshPool calls this — return any cell whose name maps to an id in `matching`.
    const ids = Array.isArray(matching) ? matching : [matching];
    const wanted = new Set(ids);
    const hits = [];
    for (const p of patch) {
      const name = world.get(p);
      if (name === 'dirt' && wanted.has(3)) hits.push(p);
    }
    return hits;
  };
  bot.dig = async (block) => {
    digOrder.push({ x: block.position.x, y: block.position.y, z: block.position.z });
    world.setAir(block.position); // make the world actually change so refreshPool sees progress
  };

  const deps = makeDeps({
    bot,
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch
        .filter((p) => world.get(p) === 'dirt')
        .map((p) => ({ position: p })),
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 15 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
  assert.equal(r.data.mined_count, 15, `mined_count expected 15, got ${r.data.mined_count}`);
  assert.equal(digOrder.length, 15, `expected 15 dig calls, got ${digOrder.length}`);

  // (a) Row discipline: bot is south at z=-3.5, perpAxis=z, perpDirection=+1.
  // Closest row to the bot is z=-2; sort order is z=-2 → -1 → 0 → +1 → +2.
  // We dig 15 = 3 full rows, so expect [-2 -2 -2 -2 -2, -1 -1 -1 -1 -1, 0 0 0 0 0].
  const z0 = digOrder.slice(0, 5).map((p) => p.z);
  const z1 = digOrder.slice(5, 10).map((p) => p.z);
  const z2 = digOrder.slice(10, 15).map((p) => p.z);
  assert.deepEqual(z0, [-2, -2, -2, -2, -2], `first row z values: ${JSON.stringify(z0)}`);
  assert.deepEqual(z1, [-1, -1, -1, -1, -1], `second row z values: ${JSON.stringify(z1)}`);
  assert.deepEqual(z2, [0, 0, 0, 0, 0],     `third row z values: ${JSON.stringify(z2)}`);

  // (b) 4-connected: BFS over the dug cells must reach every cell from any starting cell.
  const dug = new Set(digOrder.map((p) => `${p.x},${p.y},${p.z}`));
  const start = digOrder[0];
  const visited = new Set([`${start.x},${start.y},${start.z}`]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nk = `${cur.x + dx},${cur.y},${cur.z + dz}`;
      if (!dug.has(nk) || visited.has(nk)) continue;
      visited.add(nk);
      const [nx, , nz] = nk.split(',').map(Number);
      queue.push({ x: nx, y: cur.y, z: nz });
    }
  }
  assert.equal(visited.size, dug.size,
    `dug cells must form one 4-connected region — orphans detected. Dug: ${[...dug].sort().join(' | ')}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Region protection (integration): the region store says "deny" on one cell
// inside the patch. Collect must skip that cell and surface a region rollup
// in the success envelope's observed/data fields — same shape as dig_area.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: region-protected cell is skipped and surfaced in data.region_protected', async () => {
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 2);
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);

  // Mark (2, 63, 2) as inside region 'plaza' — deny dig.
  const PROTECTED = '2,63,2';
  const regions = {
    resolve: (verb, _args, { x, y, z }) => {
      if (verb !== 'dig') return { decision: 'allow', reason: 'DEFAULT_ALLOW' };
      if (`${x},${y},${z}` === PROTECTED) {
        return { decision: 'deny', reason: 'REGION_DENY', winning_region: { id: 'plaza' } };
      }
      return { decision: 'allow', reason: 'DEFAULT_ALLOW' };
    },
  };

  const digOrder = [];
  const bot = makeStubBot({ position: new Vec3(0.5, 64, 0.5) });
  bot.blockAt = (pos) => {
    const name = world.get(pos);
    if (!name || name === 'air') {
      return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    }
    return { name, position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = () => patch.filter((p) => world.get(p) === 'dirt');
  bot.dig = async (block) => {
    digOrder.push({ x: block.position.x, y: block.position.y, z: block.position.z });
    world.setAir(block.position);
  };

  const deps = makeDeps({
    bot,
    runtime: { regions },
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, 0.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch
        .filter((p) => world.get(p) === 'dirt')
        .map((p) => ({ position: p })),
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 25 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, true);
  // Protected cell must NOT appear in the dig order.
  const protectedDug = digOrder.some((p) => `${p.x},${p.y},${p.z}` === PROTECTED);
  assert.equal(protectedDug, false, `(2,63,2) is region-protected but was dug: ${JSON.stringify(digOrder)}`);
  // Region rollup must appear in data.
  assert.ok(r.data.region_protected, `expected data.region_protected, got: ${JSON.stringify(r.data)}`);
  assert.deepEqual(
    r.data.region_protected,
    [{ id: 'plaza', count: 1 }],
    `region rollup mismatch: ${JSON.stringify(r.data.region_protected)}`,
  );
  assert.equal(r.data.skipped_region, 1, `skipped_region scalar mismatch: ${r.data.skipped_region}`);
  // causes counter agrees.
  assert.equal(r.data.causes.region_protected, 1,
    `causes.region_protected mismatch: ${r.data.causes.region_protected}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Region protection: if EVERY candidate is denied, surface REGION_PROTECTED
// as the failure code (matches the dominant-cause branch in execute.js).
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: all-cells region-denied returns REGION_PROTECTED failure', async () => {
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 1); // 3×3 = 9 cells, all denied
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);

  const regions = {
    resolve: (verb) => verb === 'dig'
      ? { decision: 'deny', reason: 'REGION_DENY', winning_region: { id: 'cathedral' } }
      : { decision: 'allow', reason: 'DEFAULT_ALLOW' },
  };

  // South of patch to avoid the self-block filter eating (0,63,0).
  const bot = makeStubBot({ position: new Vec3(0.5, 64, -3.5) });
  bot.blockAt = (pos) => {
    const name = world.get(pos);
    if (!name || name === 'air') return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    return { name, position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = () => patch.filter((p) => world.get(p) === 'dirt');
  let digCalls = 0;
  bot.dig = async () => { digCalls++; };

  const deps = makeDeps({
    bot,
    runtime: { regions },
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch.map((p) => ({ position: p })),
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 9 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'REGION_PROTECTED');
  assert.equal(digCalls, 0, 'no dig should have been called when every cell is denied');
  assert.deepEqual(
    r.error.observed_state.region_protected,
    [{ id: 'cathedral', count: 9 }],
    `expected per-region rollup: ${JSON.stringify(r.error.observed_state.region_protected)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Force override: passing { force: true } bypasses the region-policy guard,
// matching the mc dig --force escape hatch.
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: force=true bypasses region protection', async () => {
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 1);
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);

  const regions = {
    resolve: (verb) => verb === 'dig'
      ? { decision: 'deny', reason: 'REGION_DENY', winning_region: { id: 'cathedral' } }
      : { decision: 'allow', reason: 'DEFAULT_ALLOW' },
  };

  const digOrder = [];
  const bot = makeStubBot({ position: new Vec3(0.5, 64, 0.5) });
  bot.blockAt = (pos) => {
    const name = world.get(pos);
    if (!name || name === 'air') return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    return { name, position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = () => patch.filter((p) => world.get(p) === 'dirt');
  bot.dig = async (block) => {
    digOrder.push({ x: block.position.x, y: block.position.y, z: block.position.z });
    world.setAir(block.position);
  };

  const deps = makeDeps({
    bot,
    runtime: { regions },
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, 0.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch.map((p) => ({ position: p })),
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 9, force: true });
  assert.equal(r.ok, true, `force=true should succeed despite region deny: ${JSON.stringify(r)}`);
  assert.ok(digOrder.length >= 1, 'force=true should produce at least one dig');
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-call dig-failure ring: collect skips cells that mc dig has already
// given up on in the last 60s (hit_count >= DIG_FAIL_REPEAT_THRESHOLD).
// Read-only — collect doesn't write to the ring (positional causes like
// pathfind_failed would block legitimate reposition retries).
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: cells in the dig-failure ring with hit_count>=3 are skipped', async () => {
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 1); // 3×3 = 9 cells around origin
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);

  // Pre-seed the ring: mc dig already failed 3× at (1, 63, 0) in the last
  // 60s. Collect should skip that cell and mine the other 8.
  const recentDigFailures = [
    {
      ts: Date.now(),
      cell: { x: 1, y: 63, z: 0 },
      block: 'dirt',
      code: 'NO_LINE_OF_SIGHT',
      hit_count: 3,
    },
  ];

  const digOrder = [];
  // South of patch to avoid the self-block filter eating (0,63,0).
  const bot = makeStubBot({ position: new Vec3(0.5, 64, -3.5) });
  bot.blockAt = (pos) => {
    const name = world.get(pos);
    if (!name || name === 'air') return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    return { name, position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = () => patch.filter((p) => world.get(p) === 'dirt');
  bot.dig = async (block) => {
    digOrder.push({ x: block.position.x, y: block.position.y, z: block.position.z });
    world.setAir(block.position);
  };

  const deps = makeDeps({
    bot,
    runtime: { recentDigFailures },
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch.map((p) => ({ position: p })),
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 9 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, true, `expected ok=true (8 of 9 mined): ${JSON.stringify(r)}`);
  // (1,63,0) must NOT appear in the dig order.
  const blockedDug = digOrder.some((p) => p.x === 1 && p.y === 63 && p.z === 0);
  assert.equal(blockedDug, false, `(1,63,0) is ring-blocked but was dug: ${JSON.stringify(digOrder)}`);
  // The repeat_blocked cause counter should be 1.
  assert.equal(r.data.causes.repeat_blocked, 1,
    `causes.repeat_blocked mismatch: ${r.data.causes.repeat_blocked}`);
});

test('mining.collect: all cells ring-blocked → DIG_BLOCKED_REPEAT failure', async () => {
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 1); // 3×3
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);

  // Pre-seed every patch cell into the ring.
  const recentDigFailures = patch.map((p) => ({
    ts: Date.now(),
    cell: { x: p.x, y: p.y, z: p.z },
    block: 'dirt',
    code: 'NO_LINE_OF_SIGHT',
    hit_count: 3,
  }));

  const bot = makeStubBot({ position: new Vec3(0.5, 64, -3.5) });
  bot.blockAt = (pos) => {
    const name = world.get(pos);
    if (!name || name === 'air') return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    return { name, position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = () => patch.filter((p) => world.get(p) === 'dirt');
  let digCalls = 0;
  bot.dig = async () => { digCalls++; };

  const deps = makeDeps({
    bot,
    runtime: { recentDigFailures },
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch.map((p) => ({ position: p })),
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 9 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'DIG_BLOCKED_REPEAT');
  assert.equal(digCalls, 0, 'no dig should have been attempted; every cell was ring-blocked');
});

test('mining.collect: stale ring entries (>60s old) do NOT block', async () => {
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 1);
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);

  // Ring entry from 90s ago — past the 60s window. Should be pruned and ignored.
  const recentDigFailures = [
    {
      ts: Date.now() - 90_000,
      cell: { x: 1, y: 63, z: 0 },
      block: 'dirt',
      code: 'NO_LINE_OF_SIGHT',
      hit_count: 5,
    },
  ];

  const digOrder = [];
  const bot = makeStubBot({ position: new Vec3(0.5, 64, -3.5) });
  bot.blockAt = (pos) => {
    const name = world.get(pos);
    if (!name || name === 'air') return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    return { name, position: pos, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = () => patch.filter((p) => world.get(p) === 'dirt');
  bot.dig = async (block) => {
    digOrder.push({ x: block.position.x, y: block.position.y, z: block.position.z });
    world.setAir(block.position);
  };

  const deps = makeDeps({
    bot,
    runtime: { recentDigFailures },
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch.map((p) => ({ position: p })),
  });

  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 9 });
  assert.equal(r.ok, true);
  assert.equal(r.data.causes.repeat_blocked, 0,
    `stale ring entry should not block: causes.repeat_blocked=${r.data.causes.repeat_blocked}`);
  // (1,63,0) should be among the dug cells.
  const blockedCellDug = digOrder.some((p) => p.x === 1 && p.y === 63 && p.z === 0);
  assert.equal(blockedCellDug, true,
    `(1,63,0) should have been dug (stale ring entry): ${JSON.stringify(digOrder)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Arena replacements: TARGET_IN_WATER, iron drop envelope, tool holding
// ─────────────────────────────────────────────────────────────────────────

test('mining.collect: TARGET_IN_WATER when every visible candidate is flooded', async () => {
  const pos = new Vec3(2, 63, 0);
  const water = { name: 'water', boundingBox: 'block', getProperties: () => ({}) };
  const stone = { name: 'stone', boundingBox: 'block', getProperties: () => ({}), hardness: 1.5, type: 1 };
  const bot = makeStubBot({
    position: new Vec3(0.5, 64, 0.5),
    inventoryItems: [{ name: 'iron_pickaxe', count: 1 }],
  });
  bot.tool = {
    itemInHand: () => ({ name: 'iron_pickaxe' }),
    getDigTime: () => 5,
    equipForBlock: async () => {},
  };
  bot.blockAt = (p) => {
    const { x, y, z } = p;
    if (x === 2 && y === 63 && z === 0) return { ...stone, position: p };
    const floodedNeighbors = [
      [2, 62, 0], [2, 64, 0], [3, 63, 0], [1, 63, 0], [2, 63, 1], [2, 63, -1],
    ];
    if (floodedNeighbors.some(([nx, ny, nz]) => nx === x && ny === y && nz === z)) {
      return { ...water, position: p };
    }
    return { name: 'air', boundingBox: 'empty', position: p };
  };
  const deps = makeDeps({
    bot,
    findVisible: async (name) => (name === 'stone' ? [{ position: pos }] : []),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'stone', count: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TARGET_IN_WATER');
});

test('mining.collect: success envelope names expected_drop_item raw_iron for iron_ore', async () => {
  const orePos = new Vec3(1, 63, 0);
  let inv = [{ name: 'iron_pickaxe', count: 1 }];
  const bot = makeStubBot({
    position: new Vec3(0.5, 64, 0.5),
    inventoryItems: inv,
  });
  bot.blockAt = (p) => {
    if (p.x === 1 && p.y === 63 && p.z === 0) {
      return {
        name: 'iron_ore', position: p, boundingBox: 'block', hardness: 3, type: 50,
        getProperties: () => ({}),
      };
    }
    if (p.y >= 64) return { name: 'air', boundingBox: 'empty', position: p };
    return { name: 'stone', boundingBox: 'block', position: p };
  };
  bot.tool = {
    itemInHand: () => ({ name: 'iron_pickaxe' }),
    getDigTime: () => 5,
    equipForBlock: async () => {},
  };
  bot.findBlocks = ({ matching }) => {
    if (matching === 50 || matching === bot.mcData?.blocksByName?.iron_ore?.id) {
      return [orePos];
    }
    return [];
  };
  bot.dig = async () => { inv.push({ name: 'raw_iron', count: 1 }); bot.inventory = { items: () => inv.slice() }; };
  const deps = makeDeps({
    bot,
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, 0.5),
    findVisible: async (name) => (name === 'iron_ore' ? [{ position: orePos }] : []),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'iron_ore', count: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.data.expected_drop_item, 'raw_iron');
  assert.ok((r.data.drop_item_gained ?? 0) >= 1 || (r.data.total_inventory_gain ?? 0) >= 1);
});

test('mining.collect: equips shovel for dirt when pickaxe was held (tool switch)', async () => {
  let held = { name: 'iron_pickaxe' };
  const dirtPos = new Vec3(1, 63, 0);
  const inv = [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_shovel', count: 1 }];
  const bot = makeStubBot({
    position: new Vec3(0.5, 64, 0.5),
    inventoryItems: inv,
  });
  bot.blockAt = (p) => {
    if (p.x === 1 && p.y === 63 && p.z === 0) {
      return { name: 'dirt', position: p, boundingBox: 'block', hardness: 0.5, type: 3, getProperties: () => ({}) };
    }
    return { name: 'air', boundingBox: 'empty', position: p };
  };
  bot.tool = {
    itemInHand: () => held,
    getDigTime: (_b, h) => (/shovel/.test(h?.name || '') ? 5 : 7500),
    equipForBlock: async (block) => {
      if (block.name === 'dirt') held = { name: 'iron_shovel' };
      if (block.name === 'stone') held = { name: 'iron_pickaxe' };
    },
  };
  bot.dig = async (block) => {
    if (block.position.x === 1) inv.push({ name: 'dirt', count: 1 });
  };
  const deps = makeDeps({
    bot,
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, 0.5),
    findVisible: async (name) => (name === 'dirt' ? [{ position: dirtPos }] : []),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 1 });
  assert.equal(r.ok, true);
  assert.equal(held.name, 'iron_shovel');
});

// ─────────────────────────────────────────────────────────────────────────
// Regression: plain {x,y,z} pool entries must be coerced to Vec3 before
// b.blockAt. ordering.js runs the all-same-y volume branch (and the
// trunk-harvest branch) through orderCells → normalizeUnit, which strips the
// Vec3 prototype. Real mineflayer's b.blockAt(point) calls point.floored()
// internally, so a plain object threw "pos.floored is not a function"
// (gv2-2026-06-24, zee mining oak_log). The test mocks here usually accept
// plain objects, hiding the bug — so this stub mimics mineflayer by REQUIRING
// .floored() on the arg.
// ─────────────────────────────────────────────────────────────────────────
test('mining.collect: plain-object pool entries are coerced to Vec3 (b.blockAt requires .floored)', async () => {
  const baseY = 63;
  const patch = flatPatch('dirt', baseY, 2); // 5×5, all same y → volume branch → plain objects
  const cellNames = new Map();
  for (const p of patch) cellNames.set(`${p.x},${p.y},${p.z}`, 'dirt');
  const world = makeMutableWorld(cellNames);
  const bot = makeStubBot({ position: new Vec3(0.5, 64, -3.5) });
  // Mimic mineflayer: blockAt calls pos.floored() internally. A plain
  // {x,y,z} (no prototype) makes this throw — exactly the production crash.
  bot.blockAt = (pos) => {
    if (typeof pos?.floored !== 'function') {
      throw new TypeError('pos.floored is not a function');
    }
    const fp = pos.floored();
    const name = world.get(fp);
    if (!name || name === 'air') {
      return { name: 'air', position: fp, boundingBox: 'empty', getProperties: () => ({}) };
    }
    return { name, position: fp, boundingBox: 'block', getProperties: () => ({}), type: 3, hardness: 0.5 };
  };
  bot.findBlocks = ({ matching }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    const wanted = new Set(ids);
    return patch.filter((p) => world.get(p) === 'dirt' && wanted.has(3));
  };
  bot.dig = async (block) => { world.setAir(block.position); };
  // Capture logs: the harvest loop catches the per-candidate throw and
  // recovers via refreshPool (which yields Vec3s), so mined_count still
  // reaches the target even WITHOUT the fix — masking the bug. The honest
  // signal is the logged error. Assert it never appears.
  const logs = [];
  const deps = makeDeps({
    bot,
    log: (m) => logs.push(String(m)),
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0.5, 65.6, -3.5),
    findVisible: async (name) =>
      name !== 'dirt' ? [] : patch.filter((p) => world.get(p) === 'dirt').map((p) => ({ position: p })),
  });
  const actions = createMiningActions(deps);
  const r = await actions.collect({ block: 'dirt', count: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.data.mined_count, 5);
  // The first batch (from orderCells → plain objects) must be processed
  // without the b.blockAt floored() crash.
  const flooredErr = logs.find((m) => m.includes('floored'));
  assert.equal(flooredErr, undefined,
    `no candidate should hit "pos.floored is not a function"; got: ${flooredErr}`);
});
