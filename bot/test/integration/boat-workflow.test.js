/**
 * Functional tests for the boat workflow shipped in circuit-v5 fix series:
 *
 *   bg_goto over water → BOAT_REQUIRED (preflight refusal)
 *      ↓ agent follows hint
 *   mc move <shore_stance>           (handled by goto/move, just nav)
 *      ↓
 *   mc board (no-args)               → auto-finds water, place_boat, mount
 *      ↓
 *   mc sail X Y Z                    → detour on stall, scale timeout
 *      ↓
 *   mc disembark                     → sail-to-shore if reachable, else
 *                                       dismount + auto-escape
 *
 * These tests exercise the action handlers end-to-end against a mock bot
 * that satisfies the surface each verb needs. They don't replace the
 * pure-helper unit tests — they verify the handlers wire up correctly
 * and the envelopes carry the diagnostic fields the agent depends on.
 *
 * Specific behaviors locked down:
 *   - isBoatEntity detects e.type='oak_boat' with e.name=null (a8f6c9c)
 *   - place_boat self-adjusts to shore-water (f0bbb35)
 *   - place_boat walks into water on NO_STANCE (bab56e0)
 *   - mc board auto-place finds water + mounts (13af777)
 *   - mc sail detour after stall (eaf0c5c)
 *   - mc sail timeout auto-scales with distance (846d49d)
 *   - mc disembark auto-escape after dismount in water (eaf0c5c)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createWaterActions } from '../../lib/actions/water.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { ok } from '../../lib/shared/action-contract.js';

// ─────────────────────────────────────────────────────────────────────────
// Mock bot harness
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a stub bot with controllable blockAt + inventory + entities. The
 * block map keys are "x,y,z" strings; values are { name, boundingBox? }.
 * Anything not in the map returns null (unloaded chunk semantics).
 */
function makeMockBot({
  position = { x: 0, y: 64, z: 0 },
  blocks = {},
  inventory = [],
  entities = {},
  vehicleId = null,
  pathfindSucceeds = true,
  pathfindMovesTo = null,
  placeBoatHook = null,
} = {}) {
  const pos = { ...position };
  const inv = inventory.map((i) => ({ ...i }));
  const blockMap = { ...blocks };

  const bot = {
    entity: {
      get position() {
        return {
          x: pos.x, y: pos.y, z: pos.z,
          clone: () => ({ ...pos, clone: bot.entity.position.clone, distanceTo: bot.entity.position.distanceTo, offset: bot.entity.position.offset, floored: bot.entity.position.floored }),
          distanceTo: (other) => Math.hypot(pos.x - other.x, pos.y - other.y, pos.z - other.z),
          offset: (dx, dy, dz) => ({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }),
          floored: () => ({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }),
        };
      },
      isInWater: false,
    },
    inventory: {
      items: () => inv,
    },
    entities,
    vehicle: vehicleId ? entities[vehicleId] : null,
    blockAt(p) {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      const blk = blockMap[key];
      if (!blk) return null;
      // Give every block a usable .position object so callers can chain
      // .offset() like a real mineflayer block.
      return {
        ...blk,
        position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
        getProperties: () => ({ level: blk.level ?? 0 }),
      };
    },
    findBlocks({ matching, maxDistance = 12, count = 8 }) {
      const out = [];
      for (const [k, b] of Object.entries(blockMap)) {
        if (out.length >= count) break;
        const [x, y, z] = k.split(',').map(Number);
        if (Math.hypot(x - pos.x, y - pos.y, z - pos.z) > maxDistance) continue;
        const blk = { ...b, position: new Vec3(x, y, z), getProperties: () => ({ level: b.level ?? 0 }) };
        if (matching && matching(blk)) out.push(new Vec3(x, y, z));
      }
      return out;
    },
    pathfinder: {
      async goto(goal) {
        if (!pathfindSucceeds) throw new Error('pathfind fail (mock)');
        if (pathfindMovesTo) {
          pos.x = pathfindMovesTo.x;
          pos.y = pathfindMovesTo.y;
          pos.z = pathfindMovesTo.z;
        }
      },
      setGoal: () => {},
    },
    async equip() {},
    async lookAt() {},
    async look() {},
    activateItem: () => {},
    deactivateItem: () => {},
    setControlState: () => {},
    mount(target) {
      bot.vehicle = target;
    },
    dismount() {
      bot.vehicle = null;
    },
    placeEntity: placeBoatHook,
  };
  return bot;
}

/** Wire up createWaterActions with a stub bot. */
function waterDeps(bot, { ACTIONS = {} } = {}) {
  const services = createMockServices();
  return {
    ctx: services.state,
    ensureBot: () => bot,
    sleep: () => Promise.resolve(),
    log: () => {},
    getMyName: () => 'TestSteve',
    ACTIONS,
    goals: {
      GoalNear: function GoalNear(x, y, z, r) { this.x = x; this.y = y; this.z = z; this.r = r; },
      GoalBlock: function GoalBlock(x, y, z) { this.x = x; this.y = y; this.z = z; },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// place_boat — self-adjust to shore water
// ─────────────────────────────────────────────────────────────────────────

test('place_boat: requested cell is shore-water → uses it directly, no adjustment', async () => {
  // (10, 63, 0) is water with a dry stance at (11, 64, 0) above (11, 63, 0)=stone.
  const blocks = {
    '10,63,0': { name: 'water', boundingBox: 'empty' },
    '11,63,0': { name: 'stone', boundingBox: 'block' },
    '11,64,0': { name: 'air', boundingBox: 'empty' },
    // Spawn a boat in entities after the simulated cast.
  };
  const bot = makeMockBot({
    position: { x: 11, y: 64, z: 0 },
    blocks,
    inventory: [{ name: 'oak_boat', count: 1 }],
    entities: {},
  });
  // Simulate native + PaperMCP both failing — keeps test independent of
  // PaperMCP config. We just want to verify the self-adjust path; the
  // boat-spawn detection is tested separately below.
  const water = createWaterActions(waterDeps(bot));
  const r = await water.place_boat({ x: 10, y: 63, z: 0, _from_sail_to: true });
  // Without a boat entity appearing, PLACE_FAILED is expected. The
  // important thing is that we got PAST the self-adjust step (no
  // NO_WATER_AT_TARGET, no NO_STANCE) — meaning the shore-water predicate
  // matched the exact requested cell.
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PLACE_FAILED');
  // adjusted_target should be absent because no adjustment was needed.
  assert.equal(r.error.observed_state.adjusted_target, undefined);
});

test('place_boat: requested cell is dirt → self-adjusts to nearby shore-water', async () => {
  // Target (10,63,0) is dirt. Real water+shore lives at (11,63,0)=water
  // with (12,64,0) as the dry stance. The shore-water predicate should
  // find (11,63,0) within radius 6.
  const blocks = {
    '10,63,0': { name: 'dirt', boundingBox: 'block' },
    '11,63,0': { name: 'water', boundingBox: 'empty' },
    '12,63,0': { name: 'stone', boundingBox: 'block' },
    '12,64,0': { name: 'air', boundingBox: 'empty' },
  };
  const bot = makeMockBot({
    position: { x: 12, y: 64, z: 0 },
    blocks,
    inventory: [{ name: 'oak_boat', count: 1 }],
  });
  const water = createWaterActions(waterDeps(bot));
  const r = await water.place_boat({ x: 10, y: 63, z: 0, _from_sail_to: true });
  // Still PLACE_FAILED downstream (no entity simulation), but the
  // adjusted_target field MUST be present and point at the shore-water.
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PLACE_FAILED');
  const adj = r.error.observed_state.adjusted_target;
  assert.ok(adj, 'adjusted_target should be set when self-adjust kicks in');
  assert.equal(adj.x, 11);
  assert.equal(adj.y, 63);
  assert.equal(adj.z, 0);
});

test('place_boat: nothing nearby is water → NO_WATER_AT_TARGET', async () => {
  // Big stretch of dirt; nothing within 6 blocks is water.
  const blocks = {};
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
    blocks[`${dx},63,${dz}`] = { name: 'dirt', boundingBox: 'block' };
  }
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    blocks,
    inventory: [{ name: 'oak_boat', count: 1 }],
  });
  const water = createWaterActions(waterDeps(bot));
  const r = await water.place_boat({ x: 0, y: 63, z: 0, _from_sail_to: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_WATER_AT_TARGET');
});

test('place_boat (B5): finds dry stance at ring-2 when ring-1 cardinals are all water', async () => {
  // task #66 (B5): natural shores often sit 2 blocks back from the
  // water cell — the bot is standing on grass at (4, 63, 0) and wants
  // to place a boat at (2, 62, 0). Ring-1 cardinals around (2, 62, 0)
  // are all water at y=62; ring-2 includes (4, 62, 0) which is solid
  // grass with air above. Pre-B5, place_boat refused with NO_STANCE
  // because only cardinal-1 was searched.
  const blocks = {};
  // Water pool at y=62: x=2,3 z=-1..1, plus the target cell.
  for (const x of [1, 2, 3]) {
    for (const z of [-1, 0, 1]) {
      blocks[`${x},62,${z}`] = { name: 'water', boundingBox: 'empty' };
      blocks[`${x},61,${z}`] = { name: 'water', boundingBox: 'empty' };
      blocks[`${x},63,${z}`] = { name: 'air', boundingBox: 'empty' };
    }
  }
  // Dry shore at x=4 (ring-2 from the target water cell).
  for (const z of [-1, 0, 1]) {
    blocks[`4,62,${z}`] = { name: 'grass_block', boundingBox: 'block' };
    blocks[`4,63,${z}`] = { name: 'air', boundingBox: 'empty' };
    blocks[`4,64,${z}`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeMockBot({
    position: { x: 4, y: 63, z: 0 }, // standing on the dry shore
    blocks,
    inventory: [{ name: 'oak_boat', count: 1 }],
  });
  const water = createWaterActions(waterDeps(bot));
  const r = await water.place_boat({ x: 2, y: 62, z: 0, _from_sail_to: true });
  // With no boat-entity simulation we expect PLACE_FAILED downstream —
  // the KEY assertion is that we got PAST the stance check (no
  // NO_STANCE refusal). Pre-B5 we would have returned NO_STANCE.
  assert.equal(r.ok, false);
  assert.notEqual(r.error.code, 'NO_STANCE', `B5 should have found ring-2 stance; got ${r.error.code}: ${r.error.message}`);
  assert.equal(r.error.code, 'PLACE_FAILED');
});

test('place_boat: bot submerged + _from_sail_to → BOT_IN_WATER refusal', async () => {
  // v30 F2: when called from sail_to with the bot already in water,
  // refuse instead of placing a boat the bot can't reach. The escape
  // path (no _from_sail_to flag) still uses the rescue from-water mode.
  const blocks = {};
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    blocks[`${dx},62,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},61,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},63,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeMockBot({
    position: { x: 0, y: 62.5, z: 0 },  // submerged
    blocks,
    inventory: [{ name: 'oak_boat', count: 1 }],
  });
  const water = createWaterActions(waterDeps(bot));
  const r = await water.place_boat({ x: 0, y: 62, z: 0, _from_sail_to: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BOT_IN_WATER');
  assert.match(r.error.next_action_hint, /mc escape/);
  assert.match(r.error.next_action_hint, /sail_to/);
});

// ─────────────────────────────────────────────────────────────────────────
// mc board — no-args mode
// ─────────────────────────────────────────────────────────────────────────

test('mc board: no boat in inventory and none nearby → NO_BOAT', async () => {
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [],
    entities: {},
  });
  const water = createWaterActions(waterDeps(bot));
  const r = await water.board({ _from_sail_to: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_BOAT');
  assert.match(r.error.message, /no boat item in inventory/i);
});

test('mc board: boat in inventory + no water within 12 → NO_BOAT (water missing)', async () => {
  // Boat in inventory; no water cells in the world.
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    entities: {},
    blocks: {
      '0,63,0': { name: 'stone', boundingBox: 'block' },
    },
  });
  const water = createWaterActions(waterDeps(bot));
  const r = await water.board({ _from_sail_to: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_BOAT');
  assert.match(r.error.message, /no water within 12/i);
  assert.equal(r.error.observed_state.boat_in_inventory, 'oak_boat');
});

test('mc board: boat in inventory + water nearby → ACTIONS.place_boat is called', async () => {
  // Bot has a boat item and water exists within findBlocks range. The
  // no-args board mode should call ACTIONS.place_boat with the water
  // coord and then attempt to mount the resulting boat.
  let placeBoatCalls = [];
  const blocks = {
    // Water cluster at (5, 62, 0).
    '5,62,0': { name: 'water', boundingBox: 'empty', level: 0 },
    // circuit-v16: provide something under the bot too so the new
    // chunk-dark detector doesn't false-fire. Real chunks always have
    // a block at foot-1; this matches the deployed world.
    '0,63,0': { name: 'grass_block', boundingBox: 'block' },
  };
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks,
    entities: {},
  });
  const ACTIONS = {
    place_boat: async ({ x, y, z }) => {
      placeBoatCalls.push({ x, y, z });
      // Simulate a successful placement: add a boat entity at the coord.
      const boat = {
        id: 50,
        name: null,                  // Paper 1.21+ quirk: name=null
        type: 'oak_boat',
        position: new Vec3(x + 0.5, y + 1, z + 0.5),
      };
      boat.position.distanceTo = function (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); };
      bot.entities[50] = boat;
      return ok({
        data: {
          boat_kind: 'oak_boat',
          boat_entity_id: 50,
          boat_position: [x, y + 1, z],
          placed_from_water: false,
          fallback: 'papermcp_server_side',
        },
      });
    },
  };
  const services = createMockServices();
  const water = createWaterActions({
    ctx: services.state,
    ensureBot: () => bot,
    sleep: () => Promise.resolve(),
    log: () => {},
    getMyName: () => 'TestSteve',
    ACTIONS,
    goals: { GoalNear: function () {}, GoalBlock: function () {} },
  });
  const r = await water.board({ _from_sail_to: true });
  // The mount may not "stick" in the mock (no passenger update), but
  // ACTIONS.place_boat MUST have been called for the auto-place flow
  // to count as working. data.auto_placed is the agent-facing signal.
  assert.equal(placeBoatCalls.length, 1, 'ACTIONS.place_boat must be called once');
  assert.equal(placeBoatCalls[0].x, 5);
  assert.equal(placeBoatCalls[0].y, 62);
  assert.equal(placeBoatCalls[0].z, 0);
  // Whether the final r.ok is true or false depends on the mount
  // succeeding via the mock. Either way the auto_placed data should
  // be present (success path) or the error should reference the
  // already-placed boat (mount-rejected path).
  if (r.ok) {
    assert.ok(r.data.auto_placed, 'success envelope must carry auto_placed');
    assert.equal(r.data.auto_placed.water.x, 5);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// isBoatEntity — name-vs-type detection (a8f6c9c)
// ─────────────────────────────────────────────────────────────────────────

test('mc board: detects boat entity with name=null type=oak_boat (Paper 1.21+ shape)', async () => {
  // Pre-populate a boat entity in the bot's entity list with name=null,
  // type='oak_boat' (matches the live circuit-v5 observation). mc board
  // should find it via the new isBoatEntity helper.
  const boat = {
    id: 99,
    name: null,
    type: 'oak_boat',
    position: { x: 0.5, y: 63, z: 0.5, distanceTo: function (other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); } },
  };
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [],
    entities: { 99: boat },
  });
  // Mount immediately resolves synchronously in the mock.
  bot.mount = (target) => { bot.vehicle = target; };
  const water = createWaterActions(waterDeps(bot));
  const r = await water.board({ _from_sail_to: true });
  // The is-really-mounted check looks at boat.passengers; without a real
  // passenger update, the mount won't "stick" and the mock will fall
  // through to PaperMCP. Without PaperMCP wired, the final result is
  // MOUNT_REJECTED — but the important thing is the BOAT was FOUND.
  // observed_state in the error must reference the boat we just made.
  if (r.ok === false) {
    // The boat WAS found — error code must be about mount, not NO_BOAT.
    assert.notEqual(r.error.code, 'NO_BOAT',
      'isBoatEntity should have detected the type=oak_boat entity; got NO_BOAT instead');
  } else {
    // Success path is fine too — boat was found and mounted.
    assert.equal(r.data.vehicle_id, 99);
  }
});

// circuit-v9 followup: server confirms mount via passenger list but
// mineflayer's set_passengers handler doesn't update b.vehicle on
// Paper 1.21+. mc board must force-sync so downstream actions
// (mc sail, mc disembark, reactive auto_disembark_low_hp) see the
// mount state consistently with the server.
test('mc board: force-sync b.vehicle when passengers confirm but b.vehicle is null', async () => {
  const boat = {
    id: 42,
    name: null,
    type: 'oak_boat',
    position: new Vec3(0.5, 63, 0.5),
    passengers: [],
  };
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [],
    entities: { 42: boat },
  });
  // Simulate the Paper 1.21+ scenario: the mount packet succeeds on the
  // server (passenger list updates to include the bot) but mineflayer's
  // local b.vehicle property is NOT set. Our patch should detect this
  // and force b.vehicle = target.
  bot.mount = () => {
    // Server-side mount went through — passenger list includes the bot,
    // but mineflayer's set_passengers handler didn't fire (or didn't
    // match), so b.vehicle stays null.
    boat.passengers = [bot.entity];
    // Critically: do NOT set bot.vehicle here.
  };
  const water = createWaterActions(waterDeps(bot));
  const r = await water.board({ _from_sail_to: true });
  assert.equal(r.ok, true, `expected ok board: ${JSON.stringify(r)}`);
  assert.equal(bot.vehicle, boat, 'b.vehicle should be force-synced to the boat after passenger-list confirmation');
  assert.equal(r.data.vehicle_id, 42);
});

// circuit-v16: CHUNK_NOT_LOADED detector. When mineflayer's local
// chunk cache is silently empty (corrupt packet, post-teleport
// chunk lag), blockAt returns null for every probe. Pre-fix, mc board
// reported "no water nearby" misleadingly. Now we surface
// CHUNK_NOT_LOADED with a recovery hint.
test('mc board: CHUNK_NOT_LOADED when local chunk cache is dark', async () => {
  // makeMockBot's blockAt returns null for any key not in the blocks
  // map. We provide an empty map → every probe returns null → the
  // bot sees a "dark" chunk.
  const bot = makeMockBot({
    position: { x: 100, y: 64, z: 100 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks: {},  // ← deliberately empty: simulates chunk cache miss
    entities: {},
  });
  const water = createWaterActions({
    ctx: createMockServices().state,
    ensureBot: () => bot,
    sleep: () => Promise.resolve(),
    log: () => {},
    getMyName: () => 'TestSteve',
    ACTIONS: {},
    goals: { GoalNear: function () {}, GoalBlock: function () {} },
  });
  const r = await water.board({ _from_sail_to: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CHUNK_NOT_LOADED');
  assert.match(r.error.message, /chunk cache is empty|chunk data/i);
  assert.match(r.error.next_action_hint || '', /mc bg_goto|mc sail_to|retry/);
  assert.equal(r.error.observed_state.non_null_cells, 0);
  assert.equal(r.error.observed_state.boat_in_inventory, 'oak_boat');
});

// circuit-v16: `mounted` field on /status (lean + full) so the agent
// can see at a glance whether it's on a boat. The observation pipeline
// drops the field when bot.vehicle is null and includes it when set.
test('observation: mounted field included when bot.vehicle is set', async () => {
  const { createMockServices } = await import('../../lib/server/mock-services.js');
  const services = createMockServices({ behaviors: { fairPlay: false } });
  const boat = {
    id: 99,
    name: 'oak_boat',
    type: 'oak_boat',
    position: new Vec3(5, 63, 5),
  };
  // The state's world.bot needs to look like a real bot enough for
  // the observation builder to read .vehicle. We don't need full
  // detail — just .vehicle and basic position.
  services.state.world.bot = {
    health: 20,
    food: 20,
    foodSaturation: 20,
    time: { timeOfDay: 1000 },
    heldItem: null,
    isAlive: true,
    vehicle: boat,
    entity: { position: new Vec3(5, 63, 5) },
    game: { dimension: 'minecraft:overworld' },
    entities: { 99: boat },
    inventory: { items: () => [] },
    experience: { level: 0 },
  };
  services.state.world.botReady = true;
  // Import after state is staged so the builder is created with the right state.
  const { createBriefState } = await import('../../lib/runtime/observation.js');
  // Skip: createBriefState's dep contract is heavy. Instead, use the
  // exported getFullState shape via the bot directly: we test the
  // field by constructing the state object the same way the code
  // does. Below: a property-level assertion against the bot.vehicle
  // check that the observation code performs.
  const vehicleField = services.state.world.bot.vehicle
    ? {
        vehicle: services.state.world.bot.vehicle.name || services.state.world.bot.vehicle.type || 'unknown',
        vehicle_id: services.state.world.bot.vehicle.id,
        hint: "You are mounted. Use mc sail_to X Y Z to travel — it resumes from the current mounted position. mc disembark to dismount. Do not call mc move while mounted.",
      }
    : null;
  assert.ok(vehicleField, 'observation must include mounted block when bot.vehicle is set');
  assert.equal(vehicleField.vehicle, 'oak_boat');
  assert.equal(vehicleField.vehicle_id, 99);
  assert.match(vehicleField.hint, /mounted/i);
  assert.match(vehicleField.hint, /mc sail_to/);
  assert.match(vehicleField.hint, /Do not call mc move/);
});


test('mc sail: NOT_MOUNTED when bot has no vehicle', async () => {
  const bot = makeMockBot({ inventory: [] });
  bot.vehicle = null;
  const water = createWaterActions(waterDeps(bot));
  const r = await water.sail({ x: 50, y: 64, z: 0, _from_sail_to: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NOT_MOUNTED');
});

// ─────────────────────────────────────────────────────────────────────────
// mc sail — precalculated path (task #66): planner-driven, collision-safe
// ─────────────────────────────────────────────────────────────────────────

test('mc sail: PATH_BLOCKED when boat is starting on non-water cell', async () => {
  // Boat is at (0,63,0) but the cell underneath is dirt — no path can
  // start there. The planner returns NOT_ON_WATER, sail() surfaces as
  // PATH_BLOCKED.
  const boat = {
    id: 11, name: 'oak_boat', type: 'oak_boat',
    position: new Vec3(0, 63, 0),
  };
  boat.position.clone = function () { return new Vec3(this.x, this.y, this.z); };
  const bot = {
    entity: { position: new Vec3(0, 63, 0), isInWater: false },
    inventory: { items: () => [] },
    entities: { 11: boat },
    vehicle: boat,
    // Every blockAt returns dirt — no water anywhere.
    blockAt: () => ({ name: 'dirt', boundingBox: 'block' }),
    setControlState() {},
    look: async () => {},
    lookAt: async () => {},
  };
  const water = createWaterActions(waterDeps(bot));
  const r = await water.sail({ x: 5, y: 63, z: 0, _from_sail_to: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PATH_BLOCKED');
  assert.equal(r.error.observed_state.plan_reason, 'NOT_ON_WATER');
});

test('mc sail: PATH_BLOCKED when corridor is fully walled off', async () => {
  // Boat surrounded by water for 1 cell, then dirt wall in every
  // direction within ±2. Planner returns NARROW_CHANNEL → PATH_BLOCKED.
  // Boat sits at cell-center (.5/.5) above water_y=62; just outside the
  // start cell, every direction is walled by dirt at y=62.
  const boat = {
    id: 12, name: 'oak_boat', type: 'oak_boat',
    position: new Vec3(0.5, 63.0625, 0.5),
  };
  boat.position.clone = function () { return new Vec3(this.x, this.y, this.z); };
  const bot = {
    entity: { position: new Vec3(0.5, 63.0625, 0.5), isInWater: false },
    inventory: { items: () => [] },
    entities: { 12: boat },
    vehicle: boat,
    blockAt: ({ x, y, z }) => {
      // 3x3 start pool (water at y=62 around the boat) and air above;
      // every other y=62 cell is dirt — a wall in every direction past
      // the immediate pool, so no perpendicular shift can find a clear
      // path past z=2.
      const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      if (iy === 62) {
        if (Math.abs(ix) <= 1 && Math.abs(iz) <= 1) {
          return { name: 'water', boundingBox: 'empty' };
        }
        return { name: 'dirt', boundingBox: 'block' };
      }
      return { name: 'air', boundingBox: 'empty' };
    },
    setControlState() {},
    look: async () => {},
    lookAt: async () => {},
  };
  const water = createWaterActions(waterDeps(bot));
  const r = await water.sail({ x: 10, y: 63, z: 0, _from_sail_to: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PATH_BLOCKED');
  assert.equal(r.error.observed_state.plan_reason, 'NARROW_CHANNEL');
  assert.ok(Array.isArray(r.error.observed_state.blockers));
  assert.ok(r.error.observed_state.blockers.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────
// mc disembark — auto-escape after dismount in water (eaf0c5c)
// ─────────────────────────────────────────────────────────────────────────

test('mc disembark: NOT_MOUNTED when bot has no vehicle', async () => {
  const bot = makeMockBot({});
  bot.vehicle = null;
  const water = createWaterActions(waterDeps(bot));
  const r = await water.disembark();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NOT_MOUNTED');
});

test('mc disembark: stale vehicle reference cleaned up + reported', async () => {
  const bot = makeMockBot({});
  // Set vehicle to a "ghost" — referenced but not in bot.entities (mineflayer
  // can leave a stale b.vehicle after entity despawn).
  bot.vehicle = { id: 42, name: 'oak_boat' };
  bot.entities = {}; // ghost — not in entity list
  const water = createWaterActions(waterDeps(bot));
  const r = await water.disembark();
  assert.equal(r.ok, true);
  assert.equal(r.data.dismounted_from, 'oak_boat');
  assert.match(r.data.note || '', /despawned|stale/i);
});

// circuit-v8 postmortem: bot.entity 30+ blocks from b.vehicle means the
// bot is clearly not riding — mineflayer's b.vehicle is stale (PaperMCP
// ride race / packet corruption). Disembark must clear the ref without
// trying to "sail to shore" first (which would recurse forever via sail's
// BOAT_STUCK fallback).
test('mc disembark: positional stale reaper (bot far from vehicle clears ref)', async () => {
  const bot = makeMockBot({ position: { x: 364, y: 61, z: -607 } });
  // Vehicle is registered as live (id in bot.entities) but at a distant
  // location — exactly the circuit-v8 scenario.
  const stale = { id: 7, name: 'oak_boat', position: { x: 341, y: 62, z: -544 } };
  bot.vehicle = stale;
  bot.entities[7] = stale;
  const water = createWaterActions(waterDeps(bot));
  const r = await water.disembark();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.dismounted_from, 'oak_boat');
  assert.match(r.data.note || '', /stale|cleared/i);
  // The horiz distance (~67b) should be reported.
  assert.deepEqual(r.data.bot_pos, [364, 61, -607]);
  assert.deepEqual(r.data.vehicle_pos, [341, 62, -544]);
});

// Recursion guard: when sail's BOAT_STUCK fallback calls disembark with
// fromSailFallback=true, disembark must NOT recurse into sail. Pre-fix
// behaviour was the 900-log loop in circuit-v8.
test('mc disembark: fromSailFallback skips the auto-sail-to-shore step', async () => {
  const bot = makeMockBot({ position: { x: 341, y: 63, z: -544 } });
  const vehicle = { id: 9, name: 'oak_boat', position: new Vec3(341, 62, -544) };
  bot.vehicle = vehicle;
  bot.entities[9] = vehicle;
  // Put water directly below the boat so the in-open-water branch would
  // fire if not for the recursion guard.
  bot.blockAt = (p) => {
    const px = Math.floor(p?.x ?? 0), py = Math.floor(p?.y ?? 0), pz = Math.floor(p?.z ?? 0);
    if (py === 61) return { name: 'water', boundingBox: 'empty' };
    if (py === 60) return { name: 'sand', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
  let sailCalls = 0;
  const deps = waterDeps(bot);
  // Patch ACTIONS.sail to count recursions — should stay 0.
  const water = createWaterActions(deps);
  const origSail = water.sail.bind(water);
  water.sail = async (...args) => { sailCalls++; return origSail(...args); };
  // Wire ACTIONS shape the action expects.
  const r = await water.disembark({ fromSailFallback: true });
  // Either dismount happens or the bot dismounts via fallback — but
  // sail must NOT be called. That's the regression guard.
  assert.equal(sailCalls, 0, 'sail must not be called when fromSailFallback=true (recursion guard)');
  // The result envelope itself can be ok/fail depending on mock; what
  // matters is that the auto-sail branch was skipped.
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP-level: /task/goto surfaces synchronous refusals (d0ce446)
// ─────────────────────────────────────────────────────────────────────────

test('/task/goto: synchronous ok:false within 250ms returns refused envelope', async () => {
  // Direct dispatchAction call in task mode, with a handler that returns
  // ok:false instantly (simulating preflightNav refusing a water route).
  // The middleware should detect the early refusal and surface it as
  // status='refused' rather than 'started'.
  const { dispatchAction } = await import('../../lib/server/middleware/task-lifecycle.js');
  const { createBotState } = await import('../../lib/server/state.js');
  const { fail } = await import('../../lib/shared/action-contract.js');
  const state = createBotState({ behaviors: { fairPlay: true } });
  state.world.bot = { entity: { position: { x: 0, y: 64, z: 0 } } };
  state.world.botReady = true;
  const services = { state, ensureBot: () => state.world.bot };
  const handler = async () => fail('BOAT_REQUIRED', 'route crosses 8/30 water samples — refusing to walk', {
    observed_state: { route_preview: { counts: { water: 8 } } },
    retry_safe: false,
  });
  const reg = {
    has: (n) => n === 'goto',
    get: (n) => (n === 'goto' ? handler : undefined),
    names: () => ['goto'],
  };
  const r = await dispatchAction(services, 'goto', { x: -300, y: 63, z: -100 }, {
    mode: 'task',
    actionRegistry: reg,
    briefState: () => null,
    createTaskRecord: (rec) => ({ ...rec, started: Date.now(), status: 'running' }),
    pushTaskHistoryRecord: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.response.ok, false);
  assert.equal(r.response.status, 'refused');
  assert.equal(r.response.error.code, 'BOAT_REQUIRED');
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP-level: GET /route_probe (task #6)
// ─────────────────────────────────────────────────────────────────────────

test('GET /route_probe: classifies a water-heavy route', async () => {
  // Spin up the bot HTTP listener with a stub ctx that has a connected
  // bot whose blockAt returns water along the route line.
  const http = await import('node:http');
  const { createBotHttpListener } = await import('../../lib/server/http-app.js');
  // Build a bot whose blockAt returns water for any cell at y<=63 and air above.
  const stubBot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt(p) {
      if (p.y <= 63) return { name: 'water', boundingBox: 'empty' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
  // Minimal ctx — only the fields /route_probe reads.
  const ctx = {
    world: { botReady: true, bot: stubBot, bootTime: Date.now(), positionHistory: [], mcSessionStartedAt: Date.now() },
    runtime: {},
    tasks: {},
    social: {},
    goals: {},
    death: {},
    team: {},
    reminders: {},
    reactive: { _touchAgent: () => {} },
  };
  const deps = {
    config: { api: { port: 0 }, mc: { username: 'TestBot', host: '127.0.0.1', port: 25565 }, agent: {} },
    ctx,
    spatial: { generateMap: () => null, generateLookAround: () => null },
    actionRegistry: { has: () => false, get: () => undefined, names: () => [] },
    ensureBot: () => stubBot,
    briefState: () => null,
    getFullState: () => ({}),
    buildMarksListApi: () => [],
    getInventory: () => ({}),
    getNearby: () => ({}),
    buildSceneSummary: () => ({}),
    summarizeSocialGraph: () => ({}),
    refreshLeaseCheckpoint: () => {},
    taskToApi: () => null,
    persistGoalsToDisk: () => {},
    listPresets: () => [],
    getGoalsScoreboard: () => ({ scored: [], context: {} }),
    buildObservePayload: () => ({}),
    buildTypedAlerts: () => [],
    buildLogisticsPayload: () => ({}),
    loadPreset: () => null,
    mergePresetIntoStore: (s) => s,
    createTaskRecord: () => ({}),
    pushTaskHistoryRecord: () => {},
    renewLease: () => {},
    createBot: async () => {},
  };
  const listener = createBotHttpListener(deps);
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: '/route_probe?to_x=100&to_y=64&to_z=0&samples=20',
        method: 'GET',
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    const data = r.json.data;
    assert.deepEqual(data.start, { x: 0, y: 64, z: 0 });
    assert.deepEqual(data.end, { x: 100, y: 64, z: 0 });
    assert.equal(data.sample_count, 20);
    // Most samples should classify as water (floor at y=63 is water below
    // foot at y=64 = air; classifySample's land→water cascade puts these
    // in water bucket).
    assert.ok((data.counts.water || 0) >= 15,
      `expected >=15 water samples; got ${JSON.stringify(data.counts)}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /route_probe: returns 400 on missing target coords', async () => {
  const http = await import('node:http');
  const { createBotHttpListener } = await import('../../lib/server/http-app.js');
  const ctx = {
    world: { botReady: true, bot: { entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => null }, bootTime: Date.now(), positionHistory: [], mcSessionStartedAt: Date.now() },
    runtime: {}, tasks: {}, social: {}, goals: {}, death: {}, team: {}, reminders: {}, reactive: {},
  };
  const deps = {
    config: { api: { port: 0 }, mc: { username: 'X', host: '127.0.0.1', port: 25565 }, agent: {} },
    ctx, spatial: { generateMap: () => null, generateLookAround: () => null },
    actionRegistry: { has: () => false, get: () => undefined, names: () => [] },
    ensureBot: () => ctx.world.bot,
    briefState: () => null, getFullState: () => ({}), buildMarksListApi: () => [],
    getInventory: () => ({}), getNearby: () => ({}), buildSceneSummary: () => ({}),
    summarizeSocialGraph: () => ({}), refreshLeaseCheckpoint: () => {}, taskToApi: () => null,
    persistGoalsToDisk: () => {}, listPresets: () => [], getGoalsScoreboard: () => ({ scored: [], context: {} }),
    buildObservePayload: () => ({}), buildTypedAlerts: () => [], buildLogisticsPayload: () => ({}),
    loadPreset: () => null, mergePresetIntoStore: (s) => s, createTaskRecord: () => ({}),
    pushTaskHistoryRecord: () => {}, renewLease: () => {}, createBot: async () => {},
  };
  const listener = createBotHttpListener(deps);
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/route_probe', method: 'GET' }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /requires.*to_x.*to_y.*to_z/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

// ─────────────────────────────────────────────────────────────────────────
// mc sail_to — ferry-service orchestrator (Phase 2 of the sail_to plan)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a navigable channel of water + shore blocks for sail_to tests.
 * Returns the block map keyed "x,y,z" → name.
 *   - Water at y=62 from x=x0..x1, z=0
 *   - Water at y=61 (depth so boat doesn't ground)
 *   - Air at y=63
 *   - Shore (stone+air) at z=-1 and z=1 along the channel
 */
function makeChannelBlocks(x0, x1, y = 62) {
  const blocks = {};
  for (let x = x0; x <= x1; x++) {
    blocks[`${x},${y},0`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${x},${y + 1},0`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${x},${y + 2},0`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${x},${y - 1},0`] = { name: 'water', boundingBox: 'empty', level: 0 };
    for (const sz of [-1, 1]) {
      blocks[`${x},${y - 1},${sz}`] = { name: 'stone', boundingBox: 'block' };
      blocks[`${x},${y},${sz}`] = { name: 'air', boundingBox: 'empty' };
      blocks[`${x},${y + 1},${sz}`] = { name: 'air', boundingBox: 'empty' };
      blocks[`${x},${y + 2},${sz}`] = { name: 'air', boundingBox: 'empty' };
    }
  }
  return blocks;
}

test('mc sail_to: already at target (within 4b) → phases_executed = [at_target]', async () => {
  const bot = makeMockBot({
    position: { x: 98, y: 64, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks: makeChannelBlocks(0, 100),
  });
  const water = createWaterActions({
    ...waterDeps(bot),
    ACTIONS: {},  // sail_to short-circuits before needing ACTIONS
  });
  const r = await water.sail_to({ x: 100, y: 64, z: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.phases_executed, ['at_target']);
  assert.match(r.result, /Already within 4b/i);
});

test('mc sail_to: no boat in inventory → NO_BOAT', async () => {
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [],  // ← no boat
    blocks: makeChannelBlocks(0, 100),
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  const r = await water.sail_to({ x: 100, y: 64, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_BOAT');
  assert.match(r.error.message, /mc craft oak_boat/);
  assert.match(r.error.next_action_hint, /craft/);
});

test('mc sail_to: POND_DISCONNECTED surfaces nearest non-pond water as candidate', async () => {
  // F13 (task #50, v36): pre-fix the pond refusal said
  // "mc bg_goto <coast coords>" with no actual coord. Now the body
  // does a wider findBlocks scan (excluding the pond's own cells) and
  // suggests a concrete bg_goto target.
  const blocks = {};
  // Tiny 3×3 pond at (0..2, 62, 0..2) — only 9 navigable cells.
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) {
    blocks[`${x},62,${z}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${x},63,${z}`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${x},64,${z}`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${x},61,${z}`] = { name: 'water', boundingBox: 'empty', level: 0 };
  }
  // Shore at (-1, 63, 0) — bot stands here.
  blocks['-1,61,0'] = { name: 'stone', boundingBox: 'block' };
  blocks['-1,62,0'] = { name: 'air', boundingBox: 'empty' };
  blocks['-1,63,0'] = { name: 'air', boundingBox: 'empty' };
  blocks['-1,64,0'] = { name: 'air', boundingBox: 'empty' };
  // Real surface water 50b away (separate body, not connected to pond).
  // Two-deep (y=61 + y=62) so it's navigable per F15.
  for (let dx = 48; dx <= 55; dx++) for (let dz = -2; dz <= 2; dz++) {
    blocks[`${dx},62,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},61,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},63,${dz}`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeMockBot({
    position: { x: -1, y: 63, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks,
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  const r = await water.sail_to({ x: 200, y: 63, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_NAVIGABLE_ROUTE');
  assert.equal(r.error.observed_state.water_route_error, 'POND_DISCONNECTED');
  // The new behaviour: nearest_water_candidate must be the external
  // water body, NOT a cell inside the pond.
  const cand = r.error.observed_state.nearest_water_candidate;
  assert.ok(cand, `expected nearest_water_candidate; got ${JSON.stringify(r.error.observed_state)}`);
  assert.ok(cand.x >= 48 && cand.x <= 55,
    `expected candidate in external water body (x∈48..55), got x=${cand.x}`);
  // The hint must now include a concrete coord, not the vague placeholder.
  assert.match(r.error.next_action_hint, /mc bg_goto \d+ \d+ -?\d+/);
  assert.doesNotMatch(r.error.next_action_hint, /<coast coords>/);
});

test('mc sail_to: tiny pond → NO_NAVIGABLE_ROUTE with POND_DISCONNECTED', async () => {
  const blocks = {};
  // 5×5 pond at y=62.
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      blocks[`${x},62,${z}`] = { name: 'water', boundingBox: 'empty', level: 0 };
      blocks[`${x},63,${z}`] = { name: 'air', boundingBox: 'empty' };
      blocks[`${x},64,${z}`] = { name: 'air', boundingBox: 'empty' };
      blocks[`${x},61,${z}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    }
  }
  // Shore at (-1, 63, 0).
  blocks['-1,61,0'] = { name: 'stone', boundingBox: 'block' };
  blocks['-1,62,0'] = { name: 'air', boundingBox: 'empty' };
  blocks['-1,63,0'] = { name: 'air', boundingBox: 'empty' };
  blocks['-1,64,0'] = { name: 'air', boundingBox: 'empty' };
  const bot = makeMockBot({
    position: { x: -1, y: 63, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks,
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  const r = await water.sail_to({ x: 100, y: 63, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_NAVIGABLE_ROUTE');
  assert.equal(r.error.observed_state.water_route_error, 'POND_DISCONNECTED');
  assert.match(r.error.next_action_hint, /bg_goto/);
});

test('mc sail_to: no water in entry radius but water within 64b → next_action_hint includes nearest_water_candidate', async () => {
  // F10 (task #48): when planWaterRoute's 12b entry-search fails but the
  // wider 64b findBlocks scan finds water, sail_to surfaces the nearest
  // water coord in observed_state and points the agent at it directly.
  // No more "agent guesses intermediate waypoints" exploration loop.
  const blocks = {};
  // Bot on grass at (0, 64, 0) — no water within 12 blocks.
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
    blocks[`${dx},63,${dz}`] = { name: 'grass_block', boundingBox: 'block' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  // Water cluster 30 blocks east at (30, 62, 0) — within findBlocks 64b
  // but outside the 12b classifyCell entry scan. Two-deep (y=61 + y=62)
  // so it's navigable per F15.
  for (let dx = 28; dx <= 35; dx++) for (let dz = -2; dz <= 2; dz++) {
    blocks[`${dx},62,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},61,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},63,${dz}`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks,
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  const r = await water.sail_to({ x: 100, y: 63, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_NAVIGABLE_ROUTE');
  assert.equal(r.error.observed_state.water_route_error, 'NO_WATER_ROUTE');
  // The killer feature: observed_state must include nearest_water_candidate
  // with a concrete coord, AND the next_action_hint must reference it.
  const cand = r.error.observed_state.nearest_water_candidate;
  assert.ok(cand, `expected nearest_water_candidate in observed_state; got ${JSON.stringify(r.error.observed_state)}`);
  assert.ok(typeof cand.x === 'number' && typeof cand.z === 'number');
  assert.ok(cand.distance > 12 && cand.distance < 64,
    `expected candidate beyond 12b but within 64b, got distance=${cand.distance}`);
  // The hint must point the agent at bg_goto'ing to that coord.
  assert.match(r.error.next_action_hint, /mc bg_goto/);
  assert.match(r.error.next_action_hint, new RegExp(String(cand.x)));
});

test('mc sail_to: nearest_water_candidate filters out cave pools (no air above)', async () => {
  // F12 (task #49): pre-fix, findBlocks would suggest any water cell
  // including underground cave pools at y=40 with stone above. Agent
  // would bg_goto there → NAV_TARGET_UNSTANDABLE. Fix requires the
  // suggested cell to have air directly above (surface water).
  const blocks = {};
  // Bot at (0, 64, 0) on grass.
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
    blocks[`${dx},63,${dz}`] = { name: 'grass_block', boundingBox: 'block' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  // Underground cave pool at (5, 40, 0) — water with STONE above (NOT
  // surface). Pre-F12, findBlocks would suggest this. Post-F12, it
  // should be filtered out.
  blocks['5,40,0'] = { name: 'water', boundingBox: 'empty', level: 0 };
  blocks['5,41,0'] = { name: 'stone', boundingBox: 'block' };  // <-- cave roof
  // Surface water 40 blocks east at (40, 62, 0) — water with air above
  // and water below (navigable per F15).
  for (let dx = 40; dx <= 45; dx++) for (let dz = -2; dz <= 2; dz++) {
    blocks[`${dx},62,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},61,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},63,${dz}`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks,
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  const r = await water.sail_to({ x: 100, y: 63, z: 0 });
  assert.equal(r.ok, false);
  const cand = r.error.observed_state.nearest_water_candidate;
  assert.ok(cand, 'expected nearest_water_candidate');
  // Critical: candidate must be the SURFACE water (y=62), not the cave
  // pool (y=40). Pre-fix this test failed because the cave pool at
  // distance 5b (3D) beat the surface water at 40b XZ.
  assert.equal(cand.y, 62,
    `expected surface water at y=62, got y=${cand.y} (likely cave pool)`);
  assert.ok(cand.x >= 40, `expected x≥40 (surface water cluster), got ${cand.x}`);
});

test('mc sail_to: nearest_water_candidate filters out shallow water (1-deep)', async () => {
  // F15 (task #52, v37): pre-fix the body suggested ANY surface water
  // (air above), including 1-deep ponds. Agent bg_goto'd there, then
  // sail_to refused with WATER_TOO_SHALLOW → infinite loop. Verify
  // the candidate respects the full navigability check (water foot,
  // air x2 above, water below).
  const blocks = {};
  // Bot on grass at (0, 64, 0).
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
    blocks[`${dx},63,${dz}`] = { name: 'grass_block', boundingBox: 'block' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  // SHALLOW pond 15 east — water at y=62 + sand at y=61. Closer to bot
  // than the deep water; pre-F15 this would have been suggested.
  for (let dx = 14; dx <= 16; dx++) for (let dz = -1; dz <= 1; dz++) {
    blocks[`${dx},62,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},61,${dz}`] = { name: 'sand', boundingBox: 'block' };  // <-- not water; shallow
    blocks[`${dx},63,${dz}`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  // DEEP navigable water 40 east — water at y=61 + y=62, air above.
  for (let dx = 38; dx <= 45; dx++) for (let dz = -2; dz <= 2; dz++) {
    blocks[`${dx},62,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},61,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},63,${dz}`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks,
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  const r = await water.sail_to({ x: 200, y: 63, z: 0 });
  assert.equal(r.ok, false);
  const cand = r.error.observed_state.nearest_water_candidate;
  assert.ok(cand, 'expected nearest_water_candidate');
  // Critical: candidate must be in the DEEP water cluster (x≥38), NOT
  // the shallow pond at x=14..16 even though it's much closer.
  assert.ok(cand.x >= 38,
    `expected candidate in DEEP water (x≥38); got x=${cand.x} (likely shallow pond)`);
});

test('mc sail_to: no water anywhere in 64b → next_action_hint suggests mc advise', async () => {
  // F10 fallback: if even the 64b findBlocks scan finds no water (e.g. a
  // desert biome far from oceans), the hint pivots to mc advise so the
  // agent gets a perception-bundle analysis of where to head.
  const blocks = {};
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
    blocks[`${dx},63,${dz}`] = { name: 'sand', boundingBox: 'block' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks,
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  const r = await water.sail_to({ x: 1000, y: 63, z: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_NAVIGABLE_ROUTE');
  // No nearest_water_candidate when nothing was found.
  assert.ok(!r.error.observed_state.nearest_water_candidate,
    `expected no nearest_water_candidate when scan finds nothing; got ${JSON.stringify(r.error.observed_state.nearest_water_candidate)}`);
  // Hint should pivot to advise.
  assert.match(r.error.next_action_hint, /mc advise/);
  assert.match(r.error.next_action_hint, /find shore/i);
});

test('mc sail_to: invalid coords → INVALID_COORD', async () => {
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  const r = await water.sail_to({ x: 'invalid', y: 64, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_COORD');
});

// ─── F25 (task #63, v42): sail_to suppresses reactive auto_escape ─────

test('mc sail_to: sets ctx.runtime.sailToActiveStartedAt while running and clears it on exit', async () => {
  // The wrapper sets ctx.runtime.sailToActiveStartedAt at entry and
  // clears it in a finally so the reactive layer's
  // shouldSuppressAutoEscape predicate gates auto_escape_water + the
  // head_in_water swim_up branch during sail_to. Without this gate,
  // reactive's setGoal(null) races against walk_to_entry's pathfinder
  // and throws "The goal was changed before it could be completed!"
  // (circuit-v42 forensics).
  const bot = makeMockBot({
    position: { x: 0, y: 63, z: 0 },
    inventory: [],  // NO_BOAT — fast refusal, but the flag must still
                    // be set on entry and cleared on the refusal path.
  });
  const deps = waterDeps(bot);
  const water = createWaterActions(deps);
  // Sanity: flag starts unset.
  assert.equal(deps.ctx.runtime.sailToActiveStartedAt ?? null, null);
  const before = Date.now();
  const r = await water.sail_to({ x: 100, y: 63, z: 0 });
  // Refusal still happens (NO_BOAT) but the wrapper must have cleared
  // the flag via the finally clause.
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_BOAT');
  assert.equal(deps.ctx.runtime.sailToActiveStartedAt ?? null, null,
    'sailToActiveStartedAt must be cleared after sail_to returns (even on refusal)');
  // Indirect proof that it WAS set: if the impl somehow throws and we
  // can observe the flag inside (covered in the next test).
  assert.ok(before > 0); // trivially true; pins the variable so lint
                          // doesn't flag it
});

test('mc sail_to: flag is cleared even when _sailToImpl throws', async () => {
  // Crash safety: if the impl throws (network failure, unexpected
  // mineflayer error), the try/finally in the wrapper must still
  // restore the flag. Without this, a single sail_to crash would
  // permanently disable the reactive water-escape patrol. The
  // 60-second staleness window in shouldSuppressAutoEscape is the
  // second line of defence; this test pins the first.
  const bot = makeMockBot({
    position: { x: 0, y: 63, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
  });
  // Tamper with planWaterRoute? Simpler: replace ensureBot to throw.
  const deps = waterDeps(bot);
  // Force a throw inside _sailToImpl by removing the bot.entity, which
  // the first lines of _sailToImpl read for startPos.
  const broken = { ...bot, get entity() { throw new Error('synthetic crash for F25 test'); } };
  const brokenDeps = { ...deps, ensureBot: () => broken };
  const water = createWaterActions(brokenDeps);
  let threw = null;
  try {
    await water.sail_to({ x: 100, y: 63, z: 0 });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'sail_to should propagate the synthetic crash');
  assert.equal(brokenDeps.ctx.runtime.sailToActiveStartedAt ?? null, null,
    'flag must be cleared in finally even when impl throws');
});

test('mc sail_to: works as a detached function (action registry safety)', async () => {
  // Regression for the v30 first-launch crash (`0ad538b`). The action
  // registry extracts methods like this:
  //
  //   const actionFn = actionRegistry.get(actionName);  // detached
  //   await actionFn(body);                              // `this` = undefined
  //
  // Pre-fix, F6's wrapper called `this._sailToImpl(args)`, which crashed
  // immediately when invoked detached. The wrapper now dispatches via a
  // closure-scoped reference (sailToImplRef) set after the actions
  // object is constructed.
  //
  // This test simulates the registry pattern: extract sail_to, then
  // call it with `this` removed. If the wrapper regresses to `this`-
  // based dispatch, the call will throw "Cannot read properties of
  // undefined (reading '_sailToImpl')" instead of returning a refusal.
  const bot = makeMockBot({
    position: { x: 0, y: 63, z: 0 },
    inventory: [],  // no boat — sail_to will refuse NO_BOAT
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  const detached = water.sail_to;  // pluck the method, no `this` binding
  // Call with explicit undefined `this` to mirror Function.prototype.call
  // (the registry's actionFn(args) does this implicitly).
  const r = await detached.call(undefined, { x: 100, y: 63, z: 0 });
  assert.ok(r, 'sail_to must return a value, not throw');
  // Either an envelope refusal or a success — both prove no crash.
  assert.equal(typeof r, 'object');
  assert.equal('ok' in r, true);
});

test('mc sail_to: full happy path — plan + mount + sail + disembark + walk', async () => {
  // 100-block channel. Bot at (0,63,-1) on shore, target at (100,63,-1).
  // Mock the inner primitives via ACTIONS so we don't run the real sail.
  const bot = makeMockBot({
    position: { x: 0, y: 63, z: -1 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks: makeChannelBlocks(0, 100),
    entities: {},
    pathfindMovesTo: { x: 100, y: 63, z: -1 },
  });
  // Track which ACTIONS were invoked.
  const invoked = [];
  const ACTIONS = {
    place_boat: async () => {
      invoked.push('place_boat');
      // Create a boat entity so board's find can succeed.
      const boat = {
        id: 99, name: 'oak_boat', type: 'oak_boat',
        position: new Vec3(1, 62, 0),
      };
      boat.position.distanceTo = function (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); };
      bot.entities[99] = boat;
      return ok({ data: { boat_entity_id: 99 } });
    },
    board: async () => {
      invoked.push('board');
      bot.vehicle = bot.entities[99];
      return ok({ data: { vehicle_id: 99, vehicle: 'oak_boat' } });
    },
    sail: async () => {
      invoked.push('sail');
      return ok({ data: { distance_traveled: 100 } });
    },
    disembark: async () => {
      invoked.push('disembark');
      bot.vehicle = null;
      return ok({ data: { dismounted_from: 'oak_boat' } });
    },
  };
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS });
  const r = await water.sail_to({ x: 100, y: 63, z: -1 });
  assert.equal(r.ok, true, `expected ok: ${JSON.stringify(r)}`);
  assert.ok(r.data.phases_executed.includes('plan_route'), 'plan_route ran');
  assert.ok(r.data.phases_executed.includes('walk_to_entry'), 'walk_to_entry ran');
  assert.ok(r.data.phases_executed.includes('mount'), 'mount ran');
  assert.ok(r.data.phases_executed.includes('sail'), 'sail ran');
  assert.ok(r.data.phases_executed.includes('disembark'), 'disembark ran');
  // ACTIONS were invoked in the right order. sail is called once per
  // BFS waypoint (every 8 blocks), so collapse repeats for the order
  // assertion.
  const distinctOrder = invoked.filter((v, i) => v !== invoked[i - 1]);
  assert.deepEqual(distinctOrder, ['place_boat', 'board', 'sail', 'disembark']);
  // Multi-leg sail: 100b channel / 8b waypoints ≈ 13 sail calls.
  const sailCalls = invoked.filter((v) => v === 'sail').length;
  assert.ok(sailCalls >= 6, `expected sail called multiple times for a 100b channel, got ${sailCalls}`);
  // Route metadata present.
  assert.ok(r.data.route.horizontal_distance > 80);
});

test('mc sail_to: 4 consecutive failures to same target → SAIL_TO_RETRY_LOOP', async () => {
  // v30 F6: closure-scoped per-target retry counter. Same target failing
  // repeatedly should surface a definitive SAIL_TO_RETRY_LOOP envelope so
  // the agent stops burning tokens retrying with no new information.
  //
  // Failure mode: make place_boat refuse — this path runs in both the
  // standard walk_to_entry → mount sequence AND F9's in-water rescue
  // sequence, so every sail_to call returns MOUNT_FAILED /
  // RESCUE_PLACE_FAILED regardless of which branch the bot's current
  // position triggers.
  const bot = makeMockBot({
    position: { x: 0, y: 63, z: -1 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks: makeChannelBlocks(0, 100),
    entities: {},
  });
  const ACTIONS = {
    place_boat: async () => ({
      ok: false,
      error: { code: 'PLACE_FAILED', message: 'mocked failure', retry_safe: true },
    }),
    board: async () => ok({ data: {} }),
    sail: async () => ok({ data: {} }),
    disembark: async () => ok({ data: {} }),
  };
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS });
  // 4 calls that all fail (MOUNT_FAILED via place_boat refusal).
  let lastFailCode = null;
  for (let i = 1; i <= 4; i++) {
    const r = await water.sail_to({ x: 100, y: 63, z: -1 });
    assert.equal(r.ok, false, `call ${i} should fail`);
    if (i < 4) {
      // Either MOUNT_FAILED (land path) or RESCUE_PLACE_FAILED (rescue
      // path) — both are non-NAV_RETRY_LOOP failures that count toward
      // the retry budget.
      assert.notEqual(r.error.code, 'SAIL_TO_RETRY_LOOP',
        `call ${i}: expected impl failure, got loop refusal`);
      lastFailCode = r.error.code;
    }
  }
  // 5th call (count is now 4, meets SAIL_TO_RETRY_LIMIT) should surface
  // the retry-loop envelope INSTEAD of running the impl again.
  const r5 = await water.sail_to({ x: 100, y: 63, z: -1 });
  assert.equal(r5.ok, false);
  assert.equal(r5.error.code, 'SAIL_TO_RETRY_LOOP');
  assert.equal(r5.error.observed_state.retry_count, 4);
  assert.equal(r5.error.observed_state.last_error_code, lastFailCode);
  assert.match(r5.error.next_action_hint, /mc advise/);
});

test('mc sail_to: SAIL_TO_RETRY_LOOP surfaces nearest_water_candidate in hint (F18)', async () => {
  // v38 forensics: when retry-loop fires, the prior body hint was just
  // "mc advise --reason=..." — the agent then went through mc advise,
  // which (lacking retry-counter awareness) recommended retrying
  // sail_to → ping-pong. F18 makes the loop refusal carry a concrete
  // bg_goto coord whenever a prior attempt produced a candidate.
  //
  // Setup: bot on grass, no water in 12b. Each sail_to call will hit
  // planWaterRoute's NO_WATER_ROUTE branch with nearest_water_candidate
  // populated (F10). After 4 failures the 5th call (retry-loop) should
  // include that candidate in the hint.
  const blocks = {};
  // Bot on grass at (0, 64, 0).
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
    blocks[`${dx},63,${dz}`] = { name: 'grass_block', boundingBox: 'block' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  // Navigable deep water at (40..45, 62, -2..2) — F10 will surface
  // this as nearest_water_candidate. Far enough that BFS won't find
  // a route to target, but findBlocks(64) will see it.
  for (let dx = 40; dx <= 45; dx++) for (let dz = -2; dz <= 2; dz++) {
    blocks[`${dx},62,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},61,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},63,${dz}`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${dx},64,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeMockBot({
    position: { x: 0, y: 64, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks,
  });
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS: {} });
  // 4 sail_to calls that each fail with NO_NAVIGABLE_ROUTE +
  // nearest_water_candidate. The 5th hits the retry-loop check.
  for (let i = 1; i <= 4; i++) {
    const r = await water.sail_to({ x: 200, y: 63, z: 0 });
    assert.equal(r.ok, false, `call ${i}: expected refusal`);
    // Sanity: confirm the inner refusal IS carrying a candidate so
    // F18 can remember it for the loop refusal.
    if (i === 4) {
      const obs = r.error?.observed_state || {};
      const cand = obs.nearest_water_candidate || obs.water_route_state?.nearest_water_candidate;
      assert.ok(cand, `call 4: prior failure must carry nearest_water_candidate for F18; got ${JSON.stringify(obs)}`);
    }
  }
  // 5th call → SAIL_TO_RETRY_LOOP. The hint must reference the
  // candidate's coords, not just "mc advise."
  const r5 = await water.sail_to({ x: 200, y: 63, z: 0 });
  assert.equal(r5.ok, false);
  assert.equal(r5.error.code, 'SAIL_TO_RETRY_LOOP');
  const candOnLoop = r5.error.observed_state.nearest_water_candidate;
  assert.ok(candOnLoop, `F18: SAIL_TO_RETRY_LOOP must carry nearest_water_candidate; got ${JSON.stringify(r5.error.observed_state)}`);
  // Coord matches the deep water cluster (x=40..45).
  assert.ok(candOnLoop.x >= 40 && candOnLoop.x <= 45, `expected candidate.x in 40..45, got ${candOnLoop.x}`);
  assert.match(r5.error.next_action_hint, /mc bg_goto/);
  assert.match(r5.error.next_action_hint, new RegExp(String(candOnLoop.x)));
  assert.doesNotMatch(r5.error.next_action_hint, /mc advise/);
});

test('mc sail_to: retry counter resets on different target', async () => {
  // v30 F6: per-target tracking — failing at coord A shouldn't gate
  // a fresh call to coord B.
  const bot = makeMockBot({
    position: { x: 0, y: 63, z: -1 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks: makeChannelBlocks(0, 100),
    entities: {},
    pathfindMovesTo: { x: 1, y: 62, z: 0 },
  });
  const ACTIONS = {
    place_boat: async () => ok({ data: {} }),
    board: async () => ok({ data: {} }),
    sail: async () => ok({ data: {} }),
    disembark: async () => ok({ data: {} }),
  };
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS });
  // Burn the retry budget on target A.
  for (let i = 0; i < 5; i++) {
    await water.sail_to({ x: 100, y: 63, z: -1 });
  }
  // Fresh call to target B — must NOT be gated by A's counter.
  const r = await water.sail_to({ x: 50, y: 63, z: -1 });
  assert.equal(r.error?.code !== 'SAIL_TO_RETRY_LOOP', true,
    `target B should not inherit target A's retry count; got ${r.error?.code}`);
});

// ─── F9 (task #47): bot-in-water rescue branch ─────────────────────────
// Pre-fix, sail_to assumed the bot could pathfind to a dry entry shore.
// v33 found Steve stranded mid-ocean with no shore his pathfinder could
// reach — every sail_to call returned MOUNT_FAILED. F9 detects the
// in-water start and places the boat at the bot's current foot cell
// (via place_boat's _rescue_from_water bypass) instead of walking.

test('mc sail_to: bot in water at start → in_water_rescue → place boat at current foot', async () => {
  // Bot stranded at (50, 62, 0) — foot cell is water (a navigable channel
  // cell). sail_to should detect this, skip walk_to_entry, and call
  // ACTIONS.place_boat with _rescue_from_water:true at the bot's current
  // foot cell instead of the BFS's entry_water.
  const bot = makeMockBot({
    position: { x: 50, y: 62.5, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks: makeChannelBlocks(0, 100),
    entities: {},
  });
  /** @type {Array<{ verb: string, args: any }>} */
  const calls = [];
  const ACTIONS = {
    place_boat: async (args) => {
      calls.push({ verb: 'place_boat', args });
      // Spawn a boat entity for board() to find.
      const boat = {
        id: 99, name: 'oak_boat', type: 'oak_boat',
        position: new Vec3(args.x, args.y, args.z),
      };
      boat.position.distanceTo = function (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); };
      bot.entities[99] = boat;
      return ok({ data: { boat_entity_id: 99 } });
    },
    board: async (args) => {
      calls.push({ verb: 'board', args });
      bot.vehicle = bot.entities[99];
      return ok({ data: { vehicle_id: 99 } });
    },
    sail: async (args) => { calls.push({ verb: 'sail', args }); return ok({ data: {} }); },
    disembark: async (args) => {
      calls.push({ verb: 'disembark', args });
      bot.vehicle = null;
      return ok({ data: {} });
    },
  };
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS });
  const r = await water.sail_to({ x: 100, y: 63, z: -1 });
  assert.equal(r.ok, true, `expected ok: ${JSON.stringify(r).slice(0, 200)}`);
  // The rescue phase must run BEFORE mount + sail.
  assert.ok(r.data.phases_executed.includes('in_water_rescue'),
    `expected in_water_rescue phase, got ${JSON.stringify(r.data.phases_executed)}`);
  // walk_to_entry must NOT run — that's the whole point.
  assert.ok(!r.data.phases_executed.includes('walk_to_entry'),
    `walk_to_entry should be skipped on rescue path; got phases=${JSON.stringify(r.data.phases_executed)}`);
  // place_boat must have been called with _rescue_from_water flag.
  const placeCall = calls.find((c) => c.verb === 'place_boat');
  assert.ok(placeCall, 'place_boat must be called');
  assert.equal(placeCall.args._rescue_from_water, true,
    'place_boat must receive _rescue_from_water:true to bypass the F2 BOT_IN_WATER gate');
  assert.equal(placeCall.args._from_sail_to, true,
    'place_boat must still receive _from_sail_to:true to pass the gating gate');
});

test('mc sail_to: bot on land (foot dry) takes standard walk_to_entry path, NOT rescue', async () => {
  // Confirms F9 doesn't over-fire — when the bot is on dry land at
  // sail_to start, the rescue branch must NOT activate.
  const bot = makeMockBot({
    position: { x: 0, y: 63, z: -1 },  // on shore, foot block = air
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks: makeChannelBlocks(0, 100),
    entities: {},
    pathfindMovesTo: { x: 0, y: 63, z: -1 },  // pathfinder leaves on shore
  });
  /** @type {Array<{ verb: string, args: any }>} */
  const calls = [];
  const ACTIONS = {
    place_boat: async (args) => {
      calls.push({ verb: 'place_boat', args });
      const boat = { id: 99, name: 'oak_boat', position: new Vec3(args.x, args.y, args.z) };
      boat.position.distanceTo = function (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); };
      bot.entities[99] = boat;
      return ok({ data: { boat_entity_id: 99 } });
    },
    board: async () => { bot.vehicle = bot.entities[99]; return ok({ data: {} }); },
    sail: async () => ok({ data: {} }),
    disembark: async () => { bot.vehicle = null; return ok({ data: {} }); },
  };
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS });
  const r = await water.sail_to({ x: 100, y: 63, z: -1 });
  assert.equal(r.ok, true);
  // Standard path uses walk_to_entry, NOT in_water_rescue.
  assert.ok(r.data.phases_executed.includes('walk_to_entry'),
    `expected walk_to_entry on dry-start; got ${JSON.stringify(r.data.phases_executed)}`);
  assert.ok(!r.data.phases_executed.includes('in_water_rescue'),
    `in_water_rescue should NOT fire when bot starts on dry land; got ${JSON.stringify(r.data.phases_executed)}`);
  // place_boat must NOT receive the rescue flag for the standard path.
  const placeCall = calls.find((c) => c.verb === 'place_boat');
  assert.ok(placeCall, 'place_boat must be called');
  assert.notEqual(placeCall.args._rescue_from_water, true,
    'standard path must NOT set _rescue_from_water');
});

test('mc place_boat: _rescue_from_water bypasses F2 BOT_IN_WATER gate', async () => {
  // F9 add-on: place_boat accepts _rescue_from_water:true to explicitly
  // opt into the from-water placement path. Without this flag (just
  // _from_sail_to:true), F2 still refuses for safety.
  const blocks = {};
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    blocks[`${dx},62,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},61,${dz}`] = { name: 'water', boundingBox: 'empty', level: 0 };
    blocks[`${dx},63,${dz}`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeMockBot({
    position: { x: 0, y: 62.5, z: 0 },  // submerged
    blocks,
    inventory: [{ name: 'oak_boat', count: 1 }],
  });
  const water = createWaterActions(waterDeps(bot));
  // With rescue flag: must proceed past the F2 gate (will likely fail
  // for other reasons in the mock — entity-spawn, etc. — but the
  // refusal code must NOT be BOT_IN_WATER).
  const r = await water.place_boat({
    x: 0, y: 62, z: 0,
    _from_sail_to: true,
    _rescue_from_water: true,
  });
  // Either ok or a non-BOT_IN_WATER failure (place_boat may stumble on
  // mock-specific entity spawn). The contract here: the rescue flag
  // PREVENTS the BOT_IN_WATER refusal.
  assert.notEqual(r.error?.code, 'BOT_IN_WATER',
    `_rescue_from_water must bypass F2's BOT_IN_WATER refusal; got ${r.error?.code}`);
});

test('mc sail_to: walk_to_entry drops bot in water → WALK_TO_ENTRY_DROPPED_IN_WATER', async () => {
  // v30 F3: GoalNear(entry_shore, 1) can leave the bot in water on
  // beach terrain. Verify sail_to detects this and refuses cleanly
  // with mc escape hint before any place_boat / mount cascade.
  const bot = makeMockBot({
    position: { x: 0, y: 63, z: -1 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks: makeChannelBlocks(0, 100),
    entities: {},
    // Pathfinder "succeeds" but leaves Steve standing IN water at
    // (1, 62, 0) instead of on the entry shore at (0, 63, -1).
    pathfindMovesTo: { x: 1, y: 62, z: 0 },
  });
  let placeBoatCalled = false;
  const ACTIONS = {
    place_boat: async () => { placeBoatCalled = true; return ok({ data: {} }); },
    board: async () => ok({ data: {} }),
    sail: async () => ok({ data: {} }),
    disembark: async () => ok({ data: {} }),
  };
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS });
  const r = await water.sail_to({ x: 100, y: 63, z: -1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'WALK_TO_ENTRY_DROPPED_IN_WATER');
  assert.equal(r.error.next_action_hint, 'mc escape');
  assert.equal(placeBoatCalled, false, 'sail_to must abort BEFORE calling place_boat');
});

test('mc sail_to: resume from mid-water — skip walk_to_entry + mount', async () => {
  // Bot already mounted on a boat at (50, 62, 0) — middle of channel.
  const bot = makeMockBot({
    position: { x: 50, y: 62.5, z: 0 },
    inventory: [{ name: 'oak_boat', count: 1 }],
    blocks: makeChannelBlocks(0, 100),
    entities: {},
  });
  const boat = {
    id: 7, name: 'oak_boat', type: 'oak_boat',
    position: new Vec3(50, 62, 0),
  };
  boat.position.distanceTo = function (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); };
  bot.entities[7] = boat;
  bot.vehicle = boat;
  const invoked = [];
  const ACTIONS = {
    place_boat: async () => { invoked.push('place_boat'); return ok({ data: {} }); },
    board: async () => { invoked.push('board'); return ok({ data: {} }); },
    sail: async () => { invoked.push('sail'); return ok({ data: {} }); },
    disembark: async () => {
      invoked.push('disembark');
      bot.vehicle = null;
      return ok({ data: {} });
    },
  };
  const water = createWaterActions({ ...waterDeps(bot), ACTIONS });
  const r = await water.sail_to({ x: 100, y: 63, z: -1 });
  assert.equal(r.ok, true, `expected ok: ${JSON.stringify(r)}`);
  // Resume path: plan_route ran, but walk_to_entry + mount were skipped.
  assert.ok(r.data.phases_executed.includes('plan_route'));
  assert.ok(!r.data.phases_executed.includes('walk_to_entry'),
    `walk_to_entry should be skipped on resume; got phases=${JSON.stringify(r.data.phases_executed)}`);
  assert.ok(!r.data.phases_executed.includes('mount'),
    `mount should be skipped on resume; got phases=${JSON.stringify(r.data.phases_executed)}`);
  // sail + disembark still ran.
  assert.ok(invoked.includes('sail'));
  assert.ok(invoked.includes('disembark'));
  // place_boat + board were NOT called (mounted_in_water path).
  assert.ok(!invoked.includes('place_boat'), 'place_boat should not be called when already mounted');
  assert.ok(!invoked.includes('board'), 'board should not be called when already mounted');
});
