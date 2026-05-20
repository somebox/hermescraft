import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconnectBackoffMs,
  STUCK_MOVEMENT_ACTIONS,
  MOVEMENTS_TUNING,
  applyMovementsTuning,
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
