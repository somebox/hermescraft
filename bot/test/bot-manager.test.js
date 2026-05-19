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

test('MOVEMENTS_TUNING: liquidCost = 50 (round-A hydration-fall fix)', () => {
  // The pre-fix value of 5 was enough to bias against crossing lakes but
  // NOT enough to detour ONE 1-block water source adjacent to a farm —
  // pathfinder kept routing the bot through the hydration cell and
  // dropping it 1-2 blocks into water. 50 makes any 1-block water
  // detour preferable to up to ~50 extra blocks of dry travel.
  assert.equal(MOVEMENTS_TUNING.liquidCost, 50);
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

function makeMockMovements() {
  // Mirrors the subset of mineflayer-pathfinder Movements that
  // applyMovementsTuning touches.
  return {
    allowSprinting: false,
    allowParkour: true,
    canDig: true,
    canOpenDoors: false,
    scafoldingBlocks: ['dummy'],
    liquidCost: 1,
    infiniteLiquidDropdownDistance: true,
    blocksCantBreak: new Set(),
  };
}

test('applyMovementsTuning: writes liquidCost and disables infinite liquid dropdown', () => {
  const moves = makeMockMovements();
  applyMovementsTuning(moves, { blocksByName: {} });
  assert.equal(moves.liquidCost, 50);
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
