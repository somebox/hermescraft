/**
 * Shared test scaffolding for mining tests. Not a test file (underscore prefix
 * signals "helpers, not specs" so node:test's --test runner doesn't pick it up).
 *
 * Provides:
 *   - makeStubBot     — minimum mineflayer surface mining.js touches
 *   - makeStubMcData  — dirt/grass/stone/cobble/coal_ore/oak_log entries
 *                       with proper drops wiring (grass→dirt, stone→cobble)
 *   - makeDeps        — assembles the legacy deps bag createMiningActions wants
 *   - flatPatch       — 2D N×N grid of Vec3 positions at a given y
 *   - makeMutableWorld — cell→name map with get/setAir/setName for tests that
 *                        actually want the dig loop to mutate world state
 */

import { Vec3 } from 'vec3';
import { createMockServices } from '../../lib/server/mock-services.js';

/**
 * Build a stub mineflayer-bot. Each option is a function/array so individual
 * tests can override behavior without rebuilding the whole stub.
 */
export function makeStubBot(opts = {}) {
  const inventoryItems = opts.inventoryItems || [];
  const findBlocksByName = opts.findBlocksByName || (() => []);
  const blockAtByPos = opts.blockAtByPos || (() => null);
  const digImpl = opts.dig || (async () => {});
  const position = opts.position || new Vec3(0, 64, 0);

  return {
    entity: { position, isInWater: false },
    inventory: { items: () => inventoryItems.slice() },
    findBlocks: ({ matching, maxDistance, count }) => findBlocksByName({ matching, maxDistance, count }),
    blockAt: (pos) => blockAtByPos(pos),
    dig: digImpl,
    stopDigging: opts.stopDigging || (() => {}),
    pathfinder: {
      goto: opts.gotoImpl || (async () => {}),
      setGoal: () => {},
      stop: opts.pathfinderStop || (() => {}),
      goal: null,
    },
    clearControlStates: opts.clearControlStates || (() => {}),
    tool: {
      itemInHand: () => null,
      // mineflayer-tool plugin method called by dig-tools.preferHarvestToolForBlock /
      // equipForDig. Stub as a no-op so tests can drive the inner dig loop.
      equipForBlock: async () => {},
    },
    equip: async () => {},
    entities: opts.entities || {},
  };
}

/**
 * Build a deps object for createMiningActions. `state` patches into the
 * default mock state slices; remaining keys override the stub bot and
 * helper functions.
 */
export function makeDeps(opts = {}) {
  const services = createMockServices({
    state: { world: { botReady: true, ...(opts.state?.world || {}) } },
  });
  const bot = opts.bot || makeStubBot();
  services.state.world.bot = bot;
  services.state.world.mcData = opts.mcData || makeStubMcData();
  // Allow tests to set up extra slice state (e.g. recentPickups, cancelRequested)
  if (opts.runtime) Object.assign(services.state.runtime, opts.runtime);
  if (opts.tasks) Object.assign(services.state.tasks, opts.tasks);
  if (opts.reactive) Object.assign(services.state.reactive, opts.reactive);

  return {
    ctx: services.state,
    config: services.config,
    ensureBot: () => bot,
    goals: { GoalNear: function GoalNear(x, y, z, r) { this.x = x; this.y = y; this.z = z; this.r = r; } },
    fmt: services.utils.fmt,
    posObj: services.utils.posObj,
    sleep: opts.sleep || (() => Promise.resolve()),
    log: opts.log || (() => {}),
    resolveMiningBlockName: opts.resolveMiningBlockName || ((name) => name),
    fairPlayHarvestTrunkCandidates: services.fairPlay.fairPlayHarvestTrunkCandidates,
    findVisibleBlocksByNameWithPhysicalSweep: opts.findVisible || (async () => []),
    entitiesMatchingAfterLookSweep: services.fairPlay.entitiesMatchingAfterLookSweep,
    rememberSocialEvent: services.social.rememberSocialEvent,
    hasLineOfSight: opts.hasLineOfSight || services.fairPlay.hasLineOfSight,
    eyePosition: opts.eyePosition || services.fairPlay.eyePosition,
  };
}

/** Minimal mcData with `dirt`, `grass_block`, `cobblestone`, and `stone`
 *  wired so source-block lookup (grass_block→dirt, stone→cobblestone) works. */
export function makeStubMcData() {
  const blocks = {
    dirt:        { id: 3,  drops: [3],  boundingBox: 'block' },
    grass_block: { id: 9,  drops: [3],  boundingBox: 'block' },  // drops dirt
    stone:       { id: 1,  drops: [4],  boundingBox: 'block' },  // drops cobblestone
    cobblestone: { id: 4,  drops: [4],  boundingBox: 'block' },
    coal_ore:    { id: 16, drops: [263], boundingBox: 'block' }, // drops coal
    oak_log:     { id: 17, drops: [17], boundingBox: 'block' },
  };
  const items = {
    dirt: { id: 3 },
    cobblestone: { id: 4 },
    coal: { id: 263 },
    oak_log: { id: 17 },
  };
  return {
    blocksByName: blocks,
    itemsByName: items,
    items: {
      3: { name: 'dirt' },
      4: { name: 'cobblestone' },
      17: { name: 'oak_log' },
      263: { name: 'coal' },
    },
  };
}

/** Build a flat patch of `name` cells at y=baseY spanning [-r..r]×[-r..r]. */
export function flatPatch(name, baseY, r) {
  const cells = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      cells.push(new Vec3(dx, baseY, dz));
    }
  }
  return cells;
}

/** Build a mutable world stub: `b.blockAt(pos)` reads from the cell map. */
export function makeMutableWorld(blocks /* Map<string, string> */) {
  const k = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  return {
    get: (pos) => blocks.get(k(pos)) || null,
    setAir: (pos) => blocks.set(k(pos), 'air'),
    setName: (pos, name) => blocks.set(k(pos), name),
    has: (pos) => blocks.has(k(pos)),
  };
}
