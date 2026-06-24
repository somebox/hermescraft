/**
 * dig_area visit order with execution kernel (layer-down boustrophedon, not Chebyshev ring).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createExcavationActions } from '../../lib/actions/excavation.js';
import { createMockServices } from '../../lib/server/mock-services.js';

test('dig_area kernel: 3×3 layer uses monotonic row sweep not Chebyshev ring', async () => {
  const digOrder = [];
  const blocks = {};
  for (let x = 0; x <= 2; x++) {
    for (let z = 0; z <= 2; z++) {
      blocks[`${x},64,${z}`] = 'stone';
    }
  }
  const bot = {
    entity: { position: new Vec3(0.5, 65, 0.5) },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    mcData: { toolsByMaterial: { iron: ['pickaxe'] } },
    blockAt: (p) => {
      const k = `${p.x},${p.y},${p.z}`;
      const name = blocks[k] || 'air';
      return {
        name,
        boundingBox: name === 'air' ? 'empty' : 'block',
        position: p,
        digTime: 1,
      };
    },
    pathfinder: { goto: async () => {} },
    equip: async () => {},
    tool: {
      itemInHand: () => ({ name: 'iron_pickaxe' }),
      equipForBlock: async () => {},
    },
    dig: async (blk) => {
      digOrder.push([blk.position.x, blk.position.y, blk.position.z]);
      delete blocks[`${blk.position.x},${blk.position.y},${blk.position.z}`];
    },
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot, mcData: { blocksByName: {} } } },
    ensureBot: () => bot,
    getActions: () => ({ pickup: async () => ({ ok: true }) }),
  });
  const actions = createExcavationActions(services);
  const r = await actions.dig_area({
    x1: 0, y1: 64, z1: 0, x2: 2, y2: 64, z2: 2,
    safe: false,
    clear_stand: false,
    _useKernel: true,
  });
  assert.equal(r.dug, 9);
  assert.equal(digOrder.length, 9);
  const steps = [];
  for (let i = 1; i < digOrder.length; i++) {
    const a = digOrder[i - 1];
    const b = digOrder[i];
    steps.push(Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]));
  }
  assert.ok(steps.every((s) => s <= 2), `adjacent steps expected, got ${steps.join(',')}`);
  assert.notDeepEqual(digOrder[0], [1, 64, 1], 'Chebyshev ring would start at center cell');
});

test('dig_area kernel: cancelRequested → CANCELLED partial', async () => {
  const bot = {
    entity: { position: new Vec3(0.5, 65, 0.5) },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    mcData: { toolsByMaterial: { iron: ['pickaxe'] } },
    blockAt: (p) => ({
      name: 'stone',
      boundingBox: 'block',
      position: p,
      digTime: 1,
    }),
    pathfinder: { goto: async () => {} },
    equip: async () => {},
    tool: { itemInHand: () => ({ name: 'iron_pickaxe' }), equipForBlock: async () => {} },
    dig: async () => {},
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot, mcData: { blocksByName: {} } }, tasks: { cancelRequested: true } },
    ensureBot: () => bot,
    getActions: () => ({ pickup: async () => ({ ok: true }) }),
  });
  const actions = createExcavationActions(services);
  const r = await actions.dig_area({
    x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0,
    safe: false,
    clear_stand: false,
    _useKernel: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CANCELLED');
  assert.equal(r.error.retry_safe, true);
  assert.equal(typeof r.error.observed_state?.plan_hash, 'string');
});

test('dig_area kernel: lava preflight → HAZARD_LAVA', async () => {
  const bot = {
    entity: { position: new Vec3(0.5, 65, 0.5) },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    mcData: { toolsByMaterial: { iron: ['pickaxe'] } },
    blockAt: (p) => {
      const pos = { x: p.x, y: p.y, z: p.z };
      if (p.x === 1 && p.y === 64 && p.z === 0) {
        return { name: 'lava', boundingBox: 'block', position: pos, digTime: 1 };
      }
      return { name: 'stone', boundingBox: 'block', position: pos, digTime: 1 };
    },
    pathfinder: { goto: async () => {} },
    equip: async () => {},
    tool: { itemInHand: () => ({ name: 'iron_pickaxe' }), equipForBlock: async () => {} },
    dig: async () => {},
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot, mcData: { blocksByName: { lava: { id: 1 } } } } },
    ensureBot: () => bot,
    getActions: () => ({ pickup: async () => ({ ok: true }) }),
  });
  const actions = createExcavationActions(services);
  const r = await actions.dig_area({
    x1: 0, y1: 64, z1: 0, x2: 1, y2: 64, z2: 0,
    safe: true,
    clear_stand: false,
    _useKernel: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'HAZARD_LAVA');
  assert.match(r.error.message, /dig_area aborted/);
});
