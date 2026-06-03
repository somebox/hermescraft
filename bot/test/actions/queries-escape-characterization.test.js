/**
 * queries.escape characterization tests (# characterization).
 * ADR: docs/design/action-contract.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createQueriesActions } from '../../lib/actions/queries.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertContract } from '../_helpers/action-harness.js';

function makeMcData() {
  return { blocksByName: {}, itemsByName: {}, items: {} };
}

function escapeServices(bot, getActions = () => ({})) {
  return createMockServices({
    state: { world: { botReady: true, bot, mcData: makeMcData() }, runtime: {} },
    ensureBot: () => bot,
    getActions,
  });
}

function makeOpenFieldBot() {
  const pos = new Vec3(0.5, 64, 0.5);
  return {
    entity: { position: pos, isInWater: false, onGround: true, yaw: 0, pitch: 0 },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (y < 64) return { name: 'grass_block', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    findBlocks: () => [],
    entities: {},
  };
}

test('queries.escape # characterization: open → ok no-op', async () => {
  const actions = createQueriesActions(escapeServices(makeOpenFieldBot()));
  const r = await actions.escape();
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.classification_before, 'open');
  assert.equal(r.data.action_taken, 'none');
});

test('queries.escape # characterization: alley treated like open', async () => {
  const pos = new Vec3(0.5, 64, 0.5);
  const wallNS = (x, y, z) => {
    if (x === 0 && z === 0 && y === 63) return true;
    if (x === 0 && (z === -1 || z === 1) && (y === 64 || y === 65)) return true;
    return false;
  };
  const bot = {
    entity: { position: pos, isInWater: false, onGround: true, yaw: 0, pitch: 0 },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (wallNS(x, y, z)) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    findBlocks: () => [],
    entities: {},
  };
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.classification_before, 'alley');
  assert.equal(r.data.action_taken, 'none');
});

test('queries.escape # characterization: in_air still airborne → ESCAPE_FAILED_AIRBORNE', async () => {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), isInWater: false, onGround: false },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    findBlocks: () => [],
    entities: {},
  };
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ESCAPE_FAILED_AIRBORNE');
  assert.equal(r.data, undefined);
});

test('queries.escape # characterization: in_water branch (failure envelope)', async () => {
  const pos = new Vec3(0.5, 64, 0.5);
  const bot = {
    entity: { position: pos, isInWater: true, onGround: false },
    health: 20,
    inventory: { items: () => [] },
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (y === 64 && x === 0 && z === 0) return { name: 'water', boundingBox: 'empty' };
      if (y === 63) return { name: 'dirt', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    setControlState: () => {},
    lookAt: async () => {},
    findBlocks: () => [],
    entities: {},
  };
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok === false) assertContract(r);
});

test('queries.escape # characterization: in_flowing_water branch (failure envelope)', async () => {
  const pos = new Vec3(0.5, 64, 0.5);
  const bot = {
    entity: { position: pos, isInWater: true, onGround: false },
    health: 20,
    inventory: { items: () => [] },
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (y === 63) return { name: 'dirt', boundingBox: 'block' };
      if (y === 64 && x === 0 && z === 0) return { name: 'flowing_water', boundingBox: 'empty' };
      if (y === 65 && x === 0 && z === 0) return { name: 'air', boundingBox: 'empty' };
      return { name: 'air', boundingBox: 'empty' };
    },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    setControlState: () => {},
    lookAt: async () => {},
    findBlocks: () => [],
    entities: {},
  };
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok === false) {
    assertContract(r);
    assert.equal(r.error.observed_state?.classification, 'in_flowing_water');
  } else {
    assert.equal(r.data.classification_before, 'in_flowing_water');
  }
});

function makeStepUpOnlyBot({ moveOnGoto = true }) {
  const position = new Vec3(0.5, 64, 0.5);
  const wallAt = (x, y, z) => {
    if (x === 0 && z === 0 && y === 63) return true;
    if (x === -1 && z === 0 && y === 64) return true;
    if (x === 1 && z === 0 && (y === 64 || y === 65)) return true;
    if (x === 0 && z === -1 && (y === 64 || y === 65)) return true;
    if (x === 0 && z === 1 && (y === 64 || y === 65)) return true;
    return false;
  };
  const bot = {
    entity: { position, isInWater: false, onGround: true, yaw: 0, pitch: 0 },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (wallAt(x, y, z)) return { name: 'cobblestone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    findBlocks: () => [],
    entities: {},
    pathfinder: {
      goto: async (g) => {
        if (moveOnGoto) {
          bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5);
        }
      },
      setGoal: () => {},
      stop: () => {},
    },
  };
  return bot;
}

test('queries.escape # characterization: step_up_only success envelope', async () => {
  const bot = makeStepUpOnlyBot({ moveOnGoto: true });
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.classification_before, 'step_up_only');
  assert.match(r.data.action_taken, /^step_up_/);
  assert.equal(r.data.success, true);
});

test('queries.escape # characterization: step_up_only failure → ESCAPE_STEP_UP_FAILED', async () => {
  const bot = makeStepUpOnlyBot({ moveOnGoto: false });
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assertContract(r);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ESCAPE_STEP_UP_FAILED');
});

// Phase 9 PR-G — lock in the "step-up preferred over panic-pillar" invariant.
// Run-4 + Run-5 evidence: Pattern C (panic-pillar) cost ~10-13 dirt/cobble
// pillars left in the world per replay. The classifier already routes
// step_up_only away from pillar; this regression test names the case so
// future refactors don't re-introduce the cascade.
test('queries.escape # PR-G: 1-block depression with cardinal egress → step-up, NOT pillar', async () => {
  const bot = makeStepUpOnlyBot({ moveOnGoto: true });
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.classification_before, 'step_up_only');
  assert.match(r.data.action_taken, /^step_up_/, 'first action must be step-up, not pillar');
  assert.doesNotMatch(r.data.action_taken, /pillar/, 'must NOT cascade to pillar when cardinal egress exists');
});

test('queries.escape # PR-G: step_up failure does NOT cascade to pillar_up', async () => {
  // When the cheap step-up egress fails, escape returns ESCAPE_STEP_UP_FAILED
  // with retry_safe: true so the agent picks a different verb (mc dig, mc move
  // to a different cell). Cascading to pillar_up from this state was the
  // run-4/run-5 anti-pattern: 22-min grinds of pillar attempts on bad poses.
  const bot = makeStepUpOnlyBot({ moveOnGoto: false });
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assertContract(r);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ESCAPE_STEP_UP_FAILED');
  // The error envelope must NOT mention pillar — that would signal the
  // fallback we explicitly prevent.
  assert.doesNotMatch(r.error.message || '', /pillar/i, 'failure path must not suggest pillar');
});

test('queries.escape # characterization: trapped refuses when no pillar block', async () => {
  const pos = new Vec3(0.5, 64, 0.5);
  const inWall = (x, y, z) => {
    if (x === 0 && z === 0 && y === 63) return true;
    const onCard = (Math.abs(x) === 1 && z === 0) || (x === 0 && Math.abs(z) === 1);
    return onCard && (y === 64 || y === 65);
  };
  const bot = {
    entity: { position: pos, isInWater: false, onGround: true },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (inWall(x, y, z)) return { name: 'cobblestone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    findBlocks: () => [],
    entities: {},
  };
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ESCAPE_NO_PILLAR_BLOCK');
});

test('queries.escape # characterization: enclosure_inside + low HP → ESCAPE_HP_TOO_LOW', async () => {
  const pos = new Vec3(0.5, 64, 0.5);
  const solid = (p) => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    if (y === 63) return { name: 'stone', boundingBox: 'block' };
    if (Math.abs(x) <= 4 && Math.abs(z) <= 4 && y >= 64 && y <= 67) {
      if (Math.abs(x) === 4 || Math.abs(z) === 4 || y === 67) return { name: 'stone', boundingBox: 'block' };
    }
    return { name: 'air', boundingBox: 'empty' };
  };
  const bot = {
    entity: { position: pos, isInWater: false },
    health: 0,
    inventory: { items: () => [] },
    blockAt: solid,
    findBlocks: () => [],
    entities: {},
  };
  const actions = createQueriesActions(escapeServices(bot));
  const r = await actions.escape();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ESCAPE_HP_TOO_LOW');
});

test('queries.escape # characterization: enclosure_inside + healthy → auto-dig escape', async () => {
  const pos = new Vec3(0.5, 64, 0.5);
  const solid = (p) => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    if (y === 63) return { name: 'stone', boundingBox: 'block' };
    if (Math.abs(x) <= 4 && Math.abs(z) <= 4 && y >= 64 && y <= 67) {
      if (Math.abs(x) === 4 || Math.abs(z) === 4 || y === 67) return { name: 'stone', boundingBox: 'block' };
    }
    return { name: 'air', boundingBox: 'empty' };
  };
  const bot = {
    entity: { position: pos, isInWater: false },
    health: 20,
    inventory: { items: () => [] },
    blockAt: (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (x === 1 && y === 64 && z === 0) return { name: 'stone', boundingBox: 'block' };
      return solid(p);
    },
    findBlocks: () => [],
    entities: {},
  };
  const dig = async () => ({ ok: true });
  const actions = createQueriesActions(escapeServices(bot, () => ({ dig })));
  const r = await actions.escape();
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.action_taken, 'dig_out_of_enclosure');
});
