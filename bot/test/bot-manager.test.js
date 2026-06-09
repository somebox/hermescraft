import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconnectBackoffMs,
  STUCK_MOVEMENT_ACTIONS,
  SYNC_STUCK_ACTIONS,
  MOVEMENTS_TUNING,
  applyMovementsTuning,
  parsePositiveIntEnv,
} from '../lib/runtime/manager.js';

test('reconnectBackoffMs caps exponential delay', () => {
  assert.equal(reconnectBackoffMs(0), 5000);
  assert.equal(reconnectBackoffMs(1), 10000);
  assert.equal(reconnectBackoffMs(2), 20000);
  assert.equal(reconnectBackoffMs(3), 40000);
  assert.equal(reconnectBackoffMs(4), 60000);
  assert.equal(reconnectBackoffMs(10), 60000);
});

test('STUCK_MOVEMENT_ACTIONS includes pathing but not collect (in-place mining)', () => {
  for (const a of ['goto', 'follow', 'combo']) {
    assert.ok(STUCK_MOVEMENT_ACTIONS.includes(a), a);
  }
  assert.equal(STUCK_MOVEMENT_ACTIONS.includes('collect'), false);
});

// ─────────────────────────────────────────────────────────────────────────
// SYNC_STUCK_ACTIONS — guards the sync-action stuck detector. Any verb
// missing here is a 2-minute wedge waiting to happen. The road trial on
// 2026-06-09 (postmortem: data/postmortems/proc-nav-lab/proc-nav-1780994801)
// surfaced that new road-tier verbs were never registered.
// ─────────────────────────────────────────────────────────────────────────

test('SYNC_STUCK_ACTIONS includes all movement-bearing road-tier verbs', () => {
  // These are the verbs the road trial observed wedging on without nudge.
  // The bite criterion: if you add a verb that calls pathfindGotoNear
  // and/or b.dig() / b.placeBlock() across multiple cells, it MUST be
  // in this set, or the bot can wedge on a cell boundary for the entire
  // call duration with no recenter intervention.
  const movementBearing = [
    // Terrain shapers
    'level', 'level_ground', 'dig_pit', 'build_stairs',
    // Road-tier primitives (new 2026-06)
    'clear_strip', 'deck', 'fell_tree',
  ];
  for (const verb of movementBearing) {
    assert.ok(
      SYNC_STUCK_ACTIONS.has(verb),
      `SYNC_STUCK_ACTIONS must include '${verb}' — it pathfinds + digs/places ` +
      'across cells, so a block-edge wedge stalls the whole call. Without it ' +
      'the stuck nudge at manager.js:~1080 never fires while ' + verb + ' runs.',
    );
  }
});

test('SYNC_STUCK_ACTIONS preserves the original movement verbs', () => {
  // Regression guard: the 2026-06-09 fix added many new verbs to the set.
  // Don't let a future cleanup drop any of the pre-existing entries.
  const preExisting = [
    'collect', 'dig', 'dig_area', 'goto', 'goto_near', 'pickup',
    'follow', 'go_mark', 'fish', 'sail', 'hunt', 'lure', 'through',
    'place_fill', 'wall', 'tunnel',
  ];
  for (const verb of preExisting) {
    assert.ok(SYNC_STUCK_ACTIONS.has(verb),
      `SYNC_STUCK_ACTIONS must still include the pre-2026-06 verb '${verb}'`);
  }
});

test('SYNC_STUCK_ACTIONS does NOT include pure-look / pure-inventory verbs', () => {
  // These verbs don't move the bot; including them would generate
  // false-positive nudge logs during fast iterative use.
  const stationary = [
    'inventory', 'scene', 'observe', 'status', 'terrain_top',
    'inspect', 'mark', 'go_marks', 'help',
  ];
  for (const verb of stationary) {
    assert.equal(SYNC_STUCK_ACTIONS.has(verb), false,
      `SYNC_STUCK_ACTIONS must NOT include '${verb}' — it doesn't move the bot`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Pathfinder Movements tuning — locks the specific knobs that previous
// in-game-QA rounds proved necessary. If a future change regresses these,
// the agent regression is downstream and hard to find — pin them here.
// ─────────────────────────────────────────────────────────────────────────

test('MOVEMENTS_TUNING: liquidCost = 250 (circuit-v1 deep-route penalty)', () => {
  // Bumped from 50 → 250 after circuit-v1: short water routes attracted
  // the bot's path; physics carried it into deeper water. With 250,
  // pathfinder accepts up to 250×N blocks of dry detour to avoid an
  // N-block ford — short fords (1-2 blocks) still possible if there's
  // no alternative, long swims always refused.
  assert.equal(MOVEMENTS_TUNING.liquidCost, 250);
});

test('MOVEMENTS_TUNING: infiniteLiquidDropdownDistance = false (no water cushioning)', () => {
  // Pathfinder default `true` lets the bot treat a drop into water as
  // safe at any height — so it cheerfully routes over a cliff into a
  // pond as a "shortcut". We want drops capped at maxDropDown (=4)
  // like solid ground so the bot doesn't fall into deep pools.
  assert.equal(MOVEMENTS_TUNING.infiniteLiquidDropdownDistance, false);
});

test('MOVEMENTS_TUNING: canDig=false, canOpenDoors=true preserved', () => {
  // Existing F66 (open doors) and read-only navigation invariants.
  assert.equal(MOVEMENTS_TUNING.canDig, false);
  assert.equal(MOVEMENTS_TUNING.canOpenDoors, true);
});

test('MOVEMENTS_TUNING: maxCumulativeDropDown = 3 (hyd2 Y-drift cap)', () => {
  // hyd2 trace: avoidWater=true blocked the level route, pathfinder
  // descended a slope from y=64 → y=60 to reach a `collect dirt`
  // target, then bot needed ~50 cmds to climb back. Refuse any path
  // step whose landing is >3 below current foot Y.
  assert.equal(MOVEMENTS_TUNING.maxCumulativeDropDown, 3);
});

test('parsePositiveIntEnv: rejects invalid values and floors valid inputs', () => {
  assert.equal(parsePositiveIntEnv(undefined, 3), 3);
  assert.equal(parsePositiveIntEnv('', 3), 3);
  assert.equal(parsePositiveIntEnv('abc', 3), 3);
  assert.equal(parsePositiveIntEnv(0, 3), 3);
  assert.equal(parsePositiveIntEnv(-2, 3), 3);
  assert.equal(parsePositiveIntEnv('7.9', 3), 7);
  assert.equal(parsePositiveIntEnv('12', 3), 12);
});

test('MOVEMENTS_TUNING: avoidWater defaults to "shallow" mode (depth-aware)', () => {
  // The actual value reads process.env at module load. Three modes:
  //   'hard'    — original strict (all water in blocksToAvoid)
  //   'shallow' — depth-aware (wrap safeOrBreak; only refuse water
  //                cells without solid floor below). DEFAULT.
  //   'off'     — no avoidance, liquidCost only.
  assert.ok('avoidWater' in MOVEMENTS_TUNING);
  const env = (process.env.BOT_AVOID_WATER || '').toLowerCase();
  if (env === 'hard' || env === 'strict') {
    assert.equal(MOVEMENTS_TUNING.avoidWater, 'hard');
  } else if (env === 'off' || env === 'false') {
    assert.equal(MOVEMENTS_TUNING.avoidWater, 'off');
  } else {
    assert.equal(MOVEMENTS_TUNING.avoidWater, 'shallow');
  }
});

function makeMockMovements(opts = {}) {
  // Mirrors the subset of mineflayer-pathfinder Movements that
  // applyMovementsTuning touches.
  const moves = {
    allowSprinting: false,
    allowParkour: true,
    canDig: true,
    canOpenDoors: false,
    scafoldingBlocks: ['dummy'],
    liquidCost: 1,
    infiniteLiquidDropdownDistance: true,
    blocksCantBreak: new Set(),
    blocksToAvoid: new Set(),
  };
  if (opts.withBot) {
    moves.bot = { entity: { position: { y: opts.footY ?? 64 } } };
  }
  if (opts.withGetLandingBlock) {
    // Stand-in for mineflayer-pathfinder Movements.getLandingBlock.
    // Returns a fake "landing block" at the candidate Y supplied via
    // dir.candidateY (so each test can probe a specific drop depth).
    moves.getLandingBlock = function (_node, dir) {
      if (dir?.candidateY === null) return null;
      return { position: { y: dir?.candidateY ?? 64, x: 0, z: 0 } };
    };
  }
  return moves;
}

test('applyMovementsTuning: writes liquidCost and disables infinite liquid dropdown', () => {
  const moves = makeMockMovements();
  applyMovementsTuning(moves, { blocksByName: {} });
  assert.equal(moves.liquidCost, 250);
  assert.equal(moves.infiniteLiquidDropdownDistance, false);
});

test('applyMovementsTuning: preserves explicit allowParkour override', () => {
  const moves = makeMockMovements();
  applyMovementsTuning(moves, { blocksByName: {} }, { allowParkour: true });
  assert.equal(moves.allowParkour, true);
  // Default (no override) flips to false:
  const m2 = makeMockMovements();
  applyMovementsTuning(m2, { blocksByName: {} });
  assert.equal(m2.allowParkour, false);
});

test('applyMovementsTuning: opts.profile=slow forces sprint+parkour off and raises jumpCost', () => {
  const moves = makeMockMovements();
  moves.allow1by1towers = true;     // start "on" to verify the override flips it
  moves.jumpCost = 0.5;             // mineflayer-pathfinder default
  applyMovementsTuning(moves, { blocksByName: {} }, { profile: 'slow', allowParkour: true });
  // Slow-mode overrides allowParkour caller opt — anti-cheat trumps the hint.
  assert.equal(moves.allowSprinting, false, 'slow disables sprinting');
  assert.equal(moves.allowParkour, false, 'slow forces parkour off even if caller wants it');
  assert.equal(moves.allow1by1towers, false, 'slow disables 1x1 vertical pillaring');
  assert.equal(moves.jumpCost, 1.5, 'slow raises jumpCost 3x to discourage arc-apex paths');
});

test('applyMovementsTuning: opts.profile=default preserves historical behaviour', () => {
  const moves = makeMockMovements();
  moves.allow1by1towers = true;
  moves.jumpCost = 0.5;
  applyMovementsTuning(moves, { blocksByName: {} }, { profile: 'default', allowParkour: true });
  assert.equal(moves.allowSprinting, true, 'default keeps sprinting on');
  assert.equal(moves.allowParkour, true, 'default honors caller allowParkour');
  assert.equal(moves.allow1by1towers, true, 'default does not touch 1x1 towers');
  assert.equal(moves.jumpCost, 0.5, 'default does not raise jumpCost');
});

test('applyMovementsTuning: registers protectedBlocks into blocksCantBreak', () => {
  const moves = makeMockMovements();
  const mcData = {
    blocksByName: {
      oak_planks: { id: 5 },
      cobblestone: { id: 4 },
      missing_block: undefined,
    },
  };
  applyMovementsTuning(moves, mcData, {
    protectedBlocks: ['oak_planks', 'cobblestone', 'missing_block'],
  });
  assert.ok(moves.blocksCantBreak.has(5));
  assert.ok(moves.blocksCantBreak.has(4));
  // Missing blocks silently skipped — important so a new mc-data version
  // dropping a block name doesn't crash startup.
  assert.equal(moves.blocksCantBreak.size, 2);
});

test('applyMovementsTuning: avoidWater="hard" adds water block id to blocksToAvoid', () => {
  // Hard mode = original strict behaviour. Every water cell refused
  // regardless of cost.
  const moves = makeMockMovements();
  const mcData = { blocksByName: { water: { id: 32 } } };
  applyMovementsTuning(moves, mcData, { avoidWater: 'hard' });
  assert.ok(moves.blocksToAvoid.has(32), 'water id 32 must be in blocksToAvoid in hard mode');
  assert.equal(moves.avoidWaterMode, 'hard');
});

test('applyMovementsTuning: avoidWater=false / "off" leaves blocksToAvoid clean and skips wrapper', () => {
  // Opt-out for bots that need to cross water (BOT_AVOID_WATER=off).
  const moves = makeMockMovements();
  const mcData = { blocksByName: { water: { id: 32 } } };
  applyMovementsTuning(moves, mcData, { avoidWater: false });
  assert.equal(moves.blocksToAvoid.has(32), false);
  assert.equal(moves.avoidWaterMode, 'off');
});

test('applyMovementsTuning: avoidWater="shallow" does NOT add to blocksToAvoid (uses safeOrBreak wrapper instead)', () => {
  // Shallow mode is the new default: pathfinder still considers water
  // cells as candidates; the safeOrBreak wrapper refuses ones without
  // solid floor below. So blocksToAvoid stays empty.
  const moves = makeMockMovements();
  moves.safeOrBreak = function (_b, _t) { return 0; }; // stub
  const mcData = { blocksByName: { water: { id: 32 } } };
  applyMovementsTuning(moves, mcData, { avoidWater: 'shallow' });
  assert.equal(moves.blocksToAvoid.has(32), false);
  assert.equal(moves.avoidWaterMode, 'shallow');
});

test('applyMovementsTuning: avoidWater="hard" silently skips if mcData has no water entry', () => {
  // Defensive — a stripped-down mcData (mostly in tests) shouldn't crash.
  const moves = makeMockMovements();
  applyMovementsTuning(moves, { blocksByName: {} }, { avoidWater: 'hard' });
  assert.equal(moves.blocksToAvoid.size, 0);
});

test('applyMovementsTuning: shallow mode safeOrBreak wrapper refuses water with no solid floor', () => {
  // Mock bot.blockAt: returns water at all y (deep ocean).
  const water = { name: 'water', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } };
  const moves = makeMockMovements();
  moves.bot = { blockAt: () => ({ name: 'water', boundingBox: 'empty' }) };
  moves.safeOrBreak = function (_b, _t) { return 0; }; // baseline cost for non-water
  applyMovementsTuning(moves, { blocksByName: {} }, { avoidWater: 'shallow' });
  // Pathfinder treats cost>=100 as refusal. Water cell with water below → refuse.
  assert.equal(moves.safeOrBreak(water, []), 100);
});

test('applyMovementsTuning: shallow mode allows water cell with solid floor (wading)', () => {
  // Mock bot.blockAt: returns dirt one block below — wadeable.
  const water = { name: 'water', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } };
  const moves = makeMockMovements();
  moves.bot = {
    blockAt: (p) => p.y === 63
      ? { name: 'dirt', boundingBox: 'block' }
      : { name: 'water', boundingBox: 'empty' },
  };
  moves.safeOrBreak = function (_b, _t) { return 0; }; // baseline cost
  applyMovementsTuning(moves, { blocksByName: {} }, { avoidWater: 'shallow' });
  // Shallow ford: fall through to original safeOrBreak → cost 0 (cheap base).
  // Pathfinder will then ADD liquidCost (50) externally for the liquid cell.
  assert.equal(moves.safeOrBreak(water, []), 0);
});

test('applyMovementsTuning: shallow mode safeOrBreak passes non-water blocks through', () => {
  // Ensure the wrapper doesn't accidentally penalise dirt, stone, etc.
  const dirt = { name: 'dirt', boundingBox: 'block', position: { x: 10, y: 64, z: 10 } };
  const moves = makeMockMovements();
  moves.bot = { blockAt: () => ({ name: 'water', boundingBox: 'empty' }) };
  moves.safeOrBreak = function (_b, _t) { return 7; }; // baseline cost
  applyMovementsTuning(moves, { blocksByName: {} }, { avoidWater: 'shallow' });
  assert.equal(moves.safeOrBreak(dirt, []), 7); // unchanged
});

test('applyMovementsTuning: shallow mode wrapper is idempotent', () => {
  const moves = makeMockMovements();
  moves.safeOrBreak = function (_b, _t) { return 0; };
  applyMovementsTuning(moves, { blocksByName: {} }, { avoidWater: 'shallow' });
  const first = moves.safeOrBreak;
  applyMovementsTuning(moves, { blocksByName: {} }, { avoidWater: 'shallow' });
  assert.equal(moves.safeOrBreak, first, 'safeOrBreak patch must not stack');
});

test('applyMovementsTuning: writes maxCumulativeDropDown onto the Movements instance', () => {
  const moves = makeMockMovements();
  applyMovementsTuning(moves, { blocksByName: {} });
  assert.equal(moves.maxCumulativeDropDown, 3);
  // Override via opts:
  const moves2 = makeMockMovements();
  applyMovementsTuning(moves2, { blocksByName: {} }, { maxCumulativeDropDown: 10 });
  assert.equal(moves2.maxCumulativeDropDown, 10);
});

test('applyMovementsTuning: getLandingBlock override refuses drops deeper than cap', () => {
  // Bot stands at y=64. Cap=3 means any landing.y < 61 is refused.
  const moves = makeMockMovements({ withBot: true, footY: 64, withGetLandingBlock: true });
  applyMovementsTuning(moves, { blocksByName: {} });
  // 1-block drop to y=63 — allowed.
  assert.ok(moves.getLandingBlock({}, { candidateY: 63 }) !== null);
  // 3-block drop to y=61 — exactly at the cap, allowed.
  assert.ok(moves.getLandingBlock({}, { candidateY: 61 }) !== null);
  // 4-block drop to y=60 — refused. This is the exact hyd2 failure cell.
  assert.equal(moves.getLandingBlock({}, { candidateY: 60 }), null);
  // 10-block plunge — refused.
  assert.equal(moves.getLandingBlock({}, { candidateY: 54 }), null);
});

test('applyMovementsTuning: getLandingBlock override uses CURRENT foot Y, not construction Y', () => {
  // If the bot moves down legitimately (mc stair_down), the next
  // pathfind should anchor to the new foot Y. We simulate by mutating
  // moves.bot.entity.position.y between calls.
  const moves = makeMockMovements({ withBot: true, footY: 64, withGetLandingBlock: true });
  applyMovementsTuning(moves, { blocksByName: {} });
  // From y=64, dropping to y=60 is refused.
  assert.equal(moves.getLandingBlock({}, { candidateY: 60 }), null);
  // Bot stair_downs to y=58. Now dropping to y=55 (3 below new Y) is ok.
  moves.bot.entity.position.y = 58;
  assert.ok(moves.getLandingBlock({}, { candidateY: 55 }) !== null);
  // But y=54 (4 below new Y) is still refused.
  assert.equal(moves.getLandingBlock({}, { candidateY: 54 }), null);
});

test('applyMovementsTuning: getLandingBlock override preserves null returns from underlying impl', () => {
  // If the underlying Movements.getLandingBlock says "no landing"
  // (e.g. void below), the override must still return null — not
  // mistakenly approve.
  const moves = makeMockMovements({ withBot: true, footY: 64, withGetLandingBlock: true });
  applyMovementsTuning(moves, { blocksByName: {} });
  assert.equal(moves.getLandingBlock({}, { candidateY: null }), null);
});

test('applyMovementsTuning: getLandingBlock override is defensive when bot is missing', () => {
  // Test mocks without a bot field must not crash — the override
  // should pass through.
  const moves = makeMockMovements({ withGetLandingBlock: true });
  applyMovementsTuning(moves, { blocksByName: {} });
  // No bot.entity.position.y → cap is skipped, original return passes through.
  assert.ok(moves.getLandingBlock({}, { candidateY: 10 }) !== null);
});

test('applyMovementsTuning: getLandingBlock patch is idempotent', () => {
  // Wrapping the override twice would cumulatively shrink the cap.
  // Guard via _cumulativeDropPatched flag.
  const moves = makeMockMovements({ withBot: true, footY: 64, withGetLandingBlock: true });
  applyMovementsTuning(moves, { blocksByName: {} });
  const firstWrap = moves.getLandingBlock;
  applyMovementsTuning(moves, { blocksByName: {} });
  assert.equal(moves.getLandingBlock, firstWrap, 'patch must not stack');
});

test('applyMovementsTuning: gracefully skips liquidCost on Movements lacking the field', () => {
  // Defensive: older mineflayer-pathfinder builds without liquidCost
  // shouldn't crash startup. (We're on a recent build but it's a cheap
  // backstop.)
  const moves = makeMockMovements();
  delete moves.liquidCost;
  delete moves.infiniteLiquidDropdownDistance;
  applyMovementsTuning(moves, { blocksByName: {} });
  // No throw, and we still set the other knobs:
  assert.equal(moves.canDig, false);
  assert.equal(moves.canOpenDoors, true);
});

// ─────────────────────────────────────────────────────────────────────────
// Soft-block allowlist (task #4). Pathfinder should auto-break leaves /
// grass / ferns / flowers during navigation even with canDig=false so
// dense forest floors don't become impassable. The wrapper short-circuits
// safeOrBreak: matching block names return SOFT_BLOCK_COST=3 and are
// pushed to toBreak; non-matching blocks fall through to the original
// safeOrBreak (which still respects canDig=false for everything else).
// ─────────────────────────────────────────────────────────────────────────

test('MOVEMENTS_TUNING: softBlocks list includes the expected terrain noise', () => {
  assert.ok(Array.isArray(MOVEMENTS_TUNING.softBlocks) || MOVEMENTS_TUNING.softBlocks instanceof Object);
  const list = [...MOVEMENTS_TUNING.softBlocks];
  // Core leaves
  assert.ok(list.includes('oak_leaves'), 'oak_leaves in allowlist');
  assert.ok(list.includes('birch_leaves'), 'birch_leaves in allowlist');
  // Grass + ferns
  assert.ok(list.includes('tall_grass'), 'tall_grass in allowlist');
  assert.ok(list.includes('short_grass'), 'short_grass in allowlist');
  assert.ok(list.includes('fern'), 'fern in allowlist');
  // NOT in allowlist (these must NOT bypass canDig=false)
  assert.ok(!list.includes('stone'), 'stone must NOT be in allowlist');
  assert.ok(!list.includes('dirt'), 'dirt must NOT be in allowlist');
  assert.ok(!list.includes('cobblestone'), 'cobblestone must NOT be in allowlist');
});

test('applyMovementsTuning: soft-block safeOrBreak returns low cost + pushes to toBreak', () => {
  const moves = makeMockMovements();
  moves.safeOrBreak = function (_b, _t) { return 0; }; // baseline
  applyMovementsTuning(moves, { blocksByName: {} });
  const toBreak = [];
  const leaf = { name: 'oak_leaves', position: { x: 5, y: 70, z: 5 }, boundingBox: 'empty' };
  const cost = moves.safeOrBreak(leaf, toBreak);
  assert.equal(cost, 3, 'soft-block cost = 3');
  assert.deepEqual(toBreak, [{ x: 5, y: 70, z: 5 }], 'soft-block pushed to toBreak');
});

test('applyMovementsTuning: non-soft block falls through to original safeOrBreak', () => {
  const moves = makeMockMovements();
  // Original returns 100 = "can't break" (mineflayer's canDig=false guard)
  moves.safeOrBreak = function (_b, _t) { return 100; };
  applyMovementsTuning(moves, { blocksByName: {} });
  const toBreak = [];
  const dirt = { name: 'dirt', position: { x: 0, y: 64, z: 0 }, boundingBox: 'block' };
  const cost = moves.safeOrBreak(dirt, toBreak);
  assert.equal(cost, 100, 'non-soft block still gets canDig=false treatment');
  assert.deepEqual(toBreak, [], 'non-soft block NOT auto-added to toBreak');
});

test('applyMovementsTuning: soft-block wrapper preserves water depth check', () => {
  // Both gates share one wrapper. Verify water-depth still works:
  // water with no solid floor → 100 (refused), grass → 3 (broken).
  const moves = makeMockMovements();
  moves.bot = { blockAt: () => ({ name: 'water', boundingBox: 'empty' }) }; // water below
  moves.safeOrBreak = function (_b, _t) { return 0; };
  applyMovementsTuning(moves, { blocksByName: {} }, { avoidWater: 'shallow' });
  const tb = [];
  // Water with water below = deep water = refuse
  assert.equal(moves.safeOrBreak({ name: 'water', position: { x: 10, y: 64, z: 10 } }, tb), 100);
  // Grass = soft-block = break at cost 3
  assert.equal(moves.safeOrBreak({ name: 'tall_grass', position: { x: 0, y: 64, z: 0 }, boundingBox: 'empty' }, tb), 3);
});

test('applyMovementsTuning: soft-block patch is idempotent', () => {
  // Double-apply must not double-wrap (would inflate cost on each call).
  const moves = makeMockMovements();
  moves.safeOrBreak = function (_b, _t) { return 0; };
  applyMovementsTuning(moves, { blocksByName: {} });
  const firstWrap = moves.safeOrBreak;
  applyMovementsTuning(moves, { blocksByName: {} });
  assert.equal(moves.safeOrBreak, firstWrap, 'safeOrBreak must not stack');
  // Sanity: still works
  const tb = [];
  assert.equal(moves.safeOrBreak({ name: 'fern', position: { x: 0, y: 64, z: 0 } }, tb), 3);
});

test('applyMovementsTuning: opts.softBlocks override replaces the default list', () => {
  // Bots that want a custom allowlist (e.g. mushroom-fields biome) can
  // pass their own. Test: override to ONLY {brown_mushroom} → leaves no
  // longer get auto-broken; brown_mushroom does.
  const moves = makeMockMovements();
  moves.safeOrBreak = function (_b, _t) { return 100; }; // baseline = refuse
  applyMovementsTuning(moves, { blocksByName: {} }, { softBlocks: ['brown_mushroom'] });
  const tb = [];
  // Leaves no longer in allowlist → falls through → 100
  assert.equal(moves.safeOrBreak({ name: 'oak_leaves', position: { x: 0, y: 64, z: 0 } }, tb), 100);
  // brown_mushroom IS in custom allowlist → 3
  assert.equal(moves.safeOrBreak({ name: 'brown_mushroom', position: { x: 1, y: 64, z: 1 } }, tb), 3);
});

// ─── Task #22 — disposable terrain auto-break (water-only) ───────────────

test('MOVEMENTS_TUNING: disposableBlocks list covers dirt/sand/gravel family', () => {
  const list = [...MOVEMENTS_TUNING.disposableBlocks];
  assert.ok(list.includes('dirt'), 'dirt');
  assert.ok(list.includes('grass_block'), 'grass_block');
  assert.ok(list.includes('sand'), 'sand');
  assert.ok(list.includes('gravel'), 'gravel');
  assert.ok(list.includes('podzol'), 'podzol');
  // NOT disposable (would be destructive to auto-break)
  assert.ok(!list.includes('stone'));
  assert.ok(!list.includes('oak_log'));
  assert.ok(!list.includes('iron_ore'));
});

test('applyMovementsTuning: disposable terrain in water → cost 25, pushed to toBreak', () => {
  const moves = makeMockMovements();
  moves.bot = { entity: { isInWater: true, position: { y: 64 } }, blockAt: () => null };
  // Baseline: original safeOrBreak refuses dirt (canDig=false → 100).
  moves.safeOrBreak = function (_b, _t) { return 100; };
  applyMovementsTuning(moves, { blocksByName: {} });
  const tb = [];
  const sand = { name: 'sand', position: { x: 5, y: 63, z: 5 }, boundingBox: 'block' };
  const cost = moves.safeOrBreak(sand, tb);
  assert.equal(cost, 25, 'disposable cost is 25 when bot is in water');
  assert.deepEqual(tb, [{ x: 5, y: 63, z: 5 }], 'sand pushed to toBreak');
});

test('applyMovementsTuning: disposable terrain on DRY land → falls through (cost 100)', () => {
  // The whole point of the gate: avoid eroding random beaches during
  // normal travel. Only active when bot is in water.
  const moves = makeMockMovements();
  moves.bot = { entity: { isInWater: false, position: { y: 64 } }, blockAt: () => null };
  moves.safeOrBreak = function (_b, _t) { return 100; };
  applyMovementsTuning(moves, { blocksByName: {} });
  const tb = [];
  const cost = moves.safeOrBreak({ name: 'dirt', position: { x: 0, y: 64, z: 0 }, boundingBox: 'block' }, tb);
  assert.equal(cost, 100, 'dry-land dirt still refused');
  assert.deepEqual(tb, [], 'dry-land dirt NOT auto-added');
});

test('applyMovementsTuning: disposable terrain caps at 3 blocks per leg', () => {
  const moves = makeMockMovements();
  moves.bot = { entity: { isInWater: true, position: { y: 64 } }, blockAt: () => null };
  moves.safeOrBreak = function (_b, _t) { return 100; };
  applyMovementsTuning(moves, { blocksByName: {} });
  const tb = [];
  // First 3 sand blocks: each pushes to toBreak at cost 25.
  for (let i = 0; i < 3; i++) {
    const c = moves.safeOrBreak({ name: 'sand', position: { x: i, y: 63, z: 0 }, boundingBox: 'block' }, tb);
    assert.equal(c, 25, `block ${i} should still be in cap`);
  }
  assert.equal(tb.length, 3, '3 blocks scheduled');
  // 4th sand block: hit the cap → falls through to default (100).
  const c4 = moves.safeOrBreak({ name: 'sand', position: { x: 4, y: 63, z: 0 }, boundingBox: 'block' }, tb);
  assert.equal(c4, 100, '4th sand exceeds cap, refused');
  assert.equal(tb.length, 3, 'cap held; no 4th block added');
});

test('applyMovementsTuning: disposable tier patch is idempotent under double-apply', () => {
  const moves = makeMockMovements();
  moves.bot = { entity: { isInWater: true, position: { y: 64 } }, blockAt: () => null };
  moves.safeOrBreak = function (_b, _t) { return 100; };
  applyMovementsTuning(moves, { blocksByName: {} });
  const firstWrap = moves.safeOrBreak;
  applyMovementsTuning(moves, { blocksByName: {} });
  assert.equal(moves.safeOrBreak, firstWrap, 'safeOrBreak must not double-wrap');
  // Sanity: still works.
  const tb = [];
  assert.equal(moves.safeOrBreak({ name: 'dirt', position: { x: 0, y: 63, z: 0 }, boundingBox: 'block' }, tb), 25);
});
