/**
 * Regression tests for the TARGET_ENTITY_OCCUPIED pre-flight check in
 * mc place (bot/lib/actions/building/place-single.js).
 *
 * Production bug (2026-05-29): a dropped item entity at the target cell
 * tripped the entity-occupied path and returned `mc attack item` as the
 * next_action_hint — a no-op command that left the agent stuck. Dropped
 * items, xp orbs, arrows, and similar negligible-hitbox entities should
 * not block placement at all.
 *
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createBuildingActions } from '../../lib/actions/building.js';
import { createMockServices } from '../../lib/server/mock-services.js';

/**
 * Build a mineflayer-like bot positioned next to the target cell with a
 * stone floor at (x, y-1, z) so the placement has a solid reference block.
 * Inventory holds the requested item; placeBlock + blockAt succeed.
 *
 * @param {object} opts
 * @param {{x:number,y:number,z:number}} opts.target
 * @param {string} [opts.item='oak_door']
 * @param {Record<string, any>} [opts.entities] entity map indexed by id
 */
function makePlaceBot({ target, item = 'oak_door', entities = {} }) {
  const { x, y, z } = target;
  const botPos = new Vec3(x + 1, y, z); // 1 block away, same Y
  const heldRef = { name: null };
  const placeCalls = [];

  return {
    entity: { position: botPos },
    entities,
    inventory: {
      items: () => [{ name: item, count: 1, slot: 36 }],
    },
    get heldItem() {
      return heldRef.name ? { name: heldRef.name } : null;
    },
    equip: async (it) => { heldRef.name = it.name; },
    placeBlock: async (ref, faceVec) => {
      placeCalls.push({ ref: ref?.position, face: faceVec });
    },
    blockAt: (pos) => {
      // After placeBlock is called, target cell reports as the placed block.
      if (pos.x === x && pos.y === y && pos.z === z) {
        if (placeCalls.length > 0) return { name: item, boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      }
      // Solid floor directly below the target — the only valid reference face.
      if (pos.x === x && pos.y === y - 1 && pos.z === z) {
        return { name: 'stone', boundingBox: 'block', position: pos };
      }
      // Everything else is air.
      return { name: 'air', boundingBox: 'empty' };
    },
    world: { raycast: () => null },
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    _placeCalls: placeCalls,
  };
}

function buildPlaceAction(bot) {
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
    utils: { posObj: (p) => ({ x: p.x, y: p.y, z: p.z }) },
  });
  return createBuildingActions(services);
}

test('place: dropped item in target cell does NOT block placement', async () => {
  const target = { x: -456, y: 74, z: 594 };
  const bot = makePlaceBot({
    target,
    entities: {
      e1: {
        // Mineflayer reports dropped items as type='object' with name='item'.
        type: 'object',
        name: 'item',
        position: new Vec3(target.x + 0.5, target.y + 0.1, target.z + 0.5),
      },
    },
  });
  const actions = buildPlaceAction(bot);
  const r = await actions.place({ block: 'oak_door', x: target.x, y: target.y, z: target.z });
  assert.equal(r.ok, true, `expected placement to succeed, got: ${JSON.stringify(r)}`);
  assert.equal(r.data.placed_block, 'oak_door');
  assert.equal(bot._placeCalls.length, 1);
});

test('place: player in target cell → TARGET_ENTITY_OCCUPIED with chat_to hint', async () => {
  const target = { x: -456, y: 74, z: 594 };
  const bot = makePlaceBot({
    target,
    entities: {
      p1: {
        type: 'player',
        username: 'Partner',
        name: 'player',
        position: new Vec3(target.x + 0.5, target.y, target.z + 0.5),
      },
    },
  });
  const actions = buildPlaceAction(bot);
  const r = await actions.place({ block: 'oak_door', x: target.x, y: target.y, z: target.z });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TARGET_ENTITY_OCCUPIED');
  assert.match(r.error.message, /player 'Partner'/);
  assert.match(r.error.next_action_hint, /^mc chat_to Partner /);
});

test('place: mob in target cell → TARGET_ENTITY_OCCUPIED with attack <name> hint', async () => {
  const target = { x: -456, y: 74, z: 594 };
  const bot = makePlaceBot({
    target,
    entities: {
      m1: {
        type: 'hostile',
        name: 'zombie',
        displayName: 'Zombie',
        position: new Vec3(target.x + 0.5, target.y, target.z + 0.5),
      },
    },
  });
  const actions = buildPlaceAction(bot);
  const r = await actions.place({ block: 'oak_door', x: target.x, y: target.y, z: target.z });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TARGET_ENTITY_OCCUPIED');
  // Hint must name the mob (username/displayName/name) — never `item`.
  assert.match(r.error.next_action_hint, /^mc attack (zombie|Zombie)\b/);
  assert.doesNotMatch(r.error.next_action_hint, /mc attack item/);
});

test('place: xp orb / arrow in target cell does NOT block placement', async () => {
  const target = { x: -456, y: 74, z: 594 };
  const cases = [
    { type: 'orb', name: 'experience_orb' },
    { type: 'object', name: 'arrow' },
  ];
  for (const { type, name } of cases) {
    const bot = makePlaceBot({
      target,
      entities: {
        e1: {
          type,
          name,
          position: new Vec3(target.x + 0.5, target.y + 0.1, target.z + 0.5),
        },
      },
    });
    const actions = buildPlaceAction(bot);
    const r = await actions.place({ block: 'oak_door', x: target.x, y: target.y, z: target.z });
    assert.equal(r.ok, true, `${name} should not block placement, got: ${JSON.stringify(r)}`);
  }
});

test('place: entity standing 2 cells above (head cell match) still triggers block', async () => {
  // Sanity check: the y / y+1 entity occupancy logic still catches players
  // whose feet are at y-1 (head occupies our target cell).
  const target = { x: -456, y: 75, z: 594 };
  const bot = makePlaceBot({
    target,
    entities: {
      p1: {
        type: 'player',
        username: 'Tall',
        name: 'player',
        position: new Vec3(target.x + 0.5, target.y - 1, target.z + 0.5),
      },
    },
  });
  const actions = buildPlaceAction(bot);
  const r = await actions.place({ block: 'oak_door', x: target.x, y: target.y, z: target.z });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TARGET_ENTITY_OCCUPIED');
});
