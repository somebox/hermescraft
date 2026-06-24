/**
 * level must dig blocks above targetY even when the target cell is already solid.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createBuildingTerrainPart } from '../../lib/actions/building/terrain.js';

function makeLevelPart(extra = {}) {
  const digYs = [];
  const blocks = {
    '0,63,0': 'stone',
    '0,64,0': 'stone',
    '0,65,0': 'dirt',
    '0,66,0': 'dirt',
  };
  const bot = {
    entity: { position: Object.assign(new Vec3(0.5, 65, 0.5), { distanceTo: () => 1 }) },
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
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    equip: async () => {},
    tool: { itemInHand: () => ({ name: 'iron_pickaxe' }), equipForBlock: async () => {} },
    dig: async (blk) => {
      digYs.push(blk.position.y);
      delete blocks[`${blk.position.x},${blk.position.y},${blk.position.z}`];
    },
    placeBlock: async () => { throw new Error('should not fill when target solid'); },
  };
  const part = createBuildingTerrainPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => ({}),
    ...extra,
  });
  return { part, digYs };
}

test('level legacy: digs above solid target before skipping fill', async () => {
  const { part, digYs } = makeLevelPart();
  const r = await part.level({ x1: 0, z1: 0, x2: 0, z2: 0, y: 64, up: 8 });
  assert.equal(r.ok, true);
  assert.deepEqual(digYs, [66, 65]);
  assert.equal(r.data.placed, 0);
});

test('level kernel: digs above solid target before skipping fill', async () => {
  const { part, digYs } = makeLevelPart({ useExecKernel: true });
  const r = await part.level({ x1: 0, z1: 0, x2: 0, z2: 0, y: 64, up: 8 });
  assert.equal(r.ok, true);
  assert.deepEqual(digYs, [66, 65]);
});
