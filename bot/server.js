#!/usr/bin/env node
/**
 * HermesCraft Bot Server
 * 
 * A standalone HTTP server that controls a Mineflayer Minecraft bot.
 * Start this, then use the `mc` CLI or any HTTP client to control the bot.
 *
 * Usage:
 *   node server.js                              # defaults
 *   MC_HOST=localhost MC_PORT=25565 node server.js
 *   node server.js --port 3001 --mc-host localhost --mc-port 35901
 *
 * Environment:
 *   MC_HOST       Minecraft server host (default: localhost)
 *   MC_PORT       Minecraft server port (default: 25565)
 *   MC_USERNAME   Bot username (default: HermesBot)
 *   MC_AUTH       Auth type: offline|microsoft (default: offline)
 *   API_PORT      HTTP API port (default: 3001)
 *   VIEWER_PORT   If set, starts prismarine-viewer FPV web UI on this TCP port (e.g. 4001)
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pathfinderPkg;
// pvp plugin disabled — its deprecated physicTick event breaks pathfinder
// import pvpPkg from 'mineflayer-pvp';
// const pvpPlugin = pvpPkg.plugin;
import armorManager from 'mineflayer-armor-manager';
import { loader as autoEatLoader } from 'mineflayer-auto-eat';
import collectBlockPkg from 'mineflayer-collectblock';
const collectBlock = collectBlockPkg.plugin;
import minecraftData from 'minecraft-data';
import {
  CURRENT_CAST,
  buildKnownNames,
  parseMessageRouting,
  isMessageForMe,
  broadcastMentionsMe,
  stripMentionPrefix,
  stripInlineNameMention,
  applySocialEvent,
  summarizeSocialGraph,
} from './lib/shared/chat.js';
import {
  ingredientCountsFromSlots,
  recipeIngredientMap as _recipeIngredientMap,
  bestRecipeForInventory as _bestRecipeForInventory,
  buildCraftPlanFromRecipes,
} from './lib/shared/recipe-ingredients.js';
import {
  goalsFileForUser,
  loadGoalsStore,
  saveGoalsStore,
  chestSnapshotsFileForUser,
  loadChestSnapshots,
  saveChestSnapshots,
  loadPreset,
  listPresets,
  mergePresetIntoStore,
} from './lib/goals/engine.js';
import { createTaskRecord, refreshLeaseCheckpoint, renewLease, taskToApi } from './lib/goals/tasks.js';
import { loadConfig } from './lib/config/index.js';
import { createBotState } from './lib/server/state.js';
import { createServices } from './lib/server/services.js';
import { resolveInventoryItem, resolveCraftTarget, resolveBlockQuery } from './lib/shared/resolver.js';
import { FAIR_PLAY } from './lib/runtime/fair-play-constants.js';
import { createFairPlaySuite } from './lib/runtime/fair-play.js';
import { createSpatial } from './lib/runtime/spatial.js';
import { createActionRegistry } from './lib/server/action-registry.js';
import { createBotHttpListener } from './lib/server/http-app.js';
import { createBotManager } from './lib/runtime/manager.js';
import { createReactive } from './lib/runtime/reactive.js';
import { createLocationsStore, isContainerBlock, findNearbyContainer } from './lib/runtime/locations.js';
import { createRegionStore } from './lib/runtime/regions/index.js';
import { createAllActions } from './lib/actions/index.js';
import { createObservation } from './lib/runtime/observation.js';

// Per-bot locations file to prevent race conditions in multi-agent mode
const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');

// Locations store — initialized after config is loaded (below)
let locations;

function loadLocations() { return locations.load(); }
function saveLocations(locs) { locations.save(locs); }
function flagMarkStale(markName, reason) { locations.flagStale(markName, reason); }
function clearMarkStale(markName) { locations.clearStale(markName); }
function resolveMarkPlaceFromBody(body, locsPreload) { return locations.resolvePlace(body, locsPreload); }
function normalizeDepositWithdrawItems(body) { return locations.normalizeDepositWithdrawItems(body); }
function resolveContainerCoords(body) { return locations.resolveContainerCoords(body); }

function buildMarksListApi() {
  const b = ctx.world.bot && ctx.world.botReady ? ctx.world.bot : null;
  const pos = b ? b.entity.position : null;
  return locations.buildMarksList({ botPos: pos, chestSnapshots: ctx.goals.chestSnapshots });
}

// ═══════════════════════════════════════════════════════════════════
// Configuration + injectable context
// ═══════════════════════════════════════════════════════════════════

const config = loadConfig(process.argv);
locations = createLocationsStore({ dataDir: DATA_DIR, username: config.mc.username });
const ctx = createBotState(config);
ctx.runtime.regions = createRegionStore({ dataDir: DATA_DIR, world: config.behaviors.regionsWorld });
ctx.runtime.dataDir = DATA_DIR;

const viewerPortOpt = (() => {
  const raw = process.env.VIEWER_PORT;
  if (raw == null || String(raw).trim() === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : null;
})();

// ═══════════════════════════════════════════════════════════════════
// Bot Manager (mutable state lives on ctx)
// ═══════════════════════════════════════════════════════════════════

function remindersFilePath() {
  return path.join(DATA_DIR, `reminders-${config.mc.username.toLowerCase()}.json`);
}

function loadReminders() {
  try {
    const raw = fs.readFileSync(remindersFilePath(), 'utf8');
    const data = JSON.parse(raw);
    ctx.reminders.reminders = Array.isArray(data.reminders) ? data.reminders : [];
    ctx.reminders.remindersNextId = typeof data.nextId === 'number' ? data.nextId : (ctx.reminders.reminders.length ? Math.max(...ctx.reminders.reminders.map(r => r.id)) + 1 : 1);
  } catch {
    ctx.reminders.reminders = [];
    ctx.reminders.remindersNextId = 1;
  }
}

function saveReminders() {
  const dir = path.dirname(remindersFilePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(remindersFilePath(), JSON.stringify({ reminders: ctx.reminders.reminders, nextId: ctx.reminders.remindersNextId }, null, 2));
}

function getDueReminders() {
  const now = Date.now();
  return ctx.reminders.reminders.filter(r => now - (r.last_fired || r.created) >= r.interval_ms);
}

function fireDueReminders() {
  const now = Date.now();
  const due = [];
  for (const r of ctx.reminders.reminders) {
    if (now - (r.last_fired || r.created) >= r.interval_ms) {
      due.push({ id: r.id, note: r.note, mark: r.mark || null });
      r.last_fired = now;
    }
  }
  if (due.length) saveReminders();
  return due;
}

function goalsPath() {
  return goalsFileForUser(config.mc.username);
}
function loadGoalsFromDisk() {
  ctx.goals.goalsStore = loadGoalsStore(goalsPath());
}
function persistGoalsToDisk() {
  saveGoalsStore(goalsPath(), {
    goals: ctx.goals.goalsStore.goals,
    deficitSince: ctx.goals.goalsStore.deficitSince || {},
  });
}

function chestSnapshotsPath() {
  return chestSnapshotsFileForUser(config.mc.username);
}
function loadChestSnapshotsFromDisk() {
  ctx.goals.chestSnapshots = loadChestSnapshots(chestSnapshotsPath());
}
function persistChestSnapshotsToDisk() {
  saveChestSnapshots(chestSnapshotsPath(), ctx.goals.chestSnapshots || {});
}

function snapshotChestAtPosition(x, y, z, containerItems) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const items = (containerItems || []).map((i) => ({ name: i.name, count: i.count }));
  const total = items.reduce((s, i) => s + i.count, 0);
  const locs = loadLocations();
  let markName = `${ix},${iy},${iz}`;
  for (const [name, l] of Object.entries(locs)) {
    if (Math.floor(l.x) === ix && Math.floor(l.y) === iy && Math.floor(l.z) === iz) {
      markName = name;
      break;
    }
  }
  ctx.goals.chestSnapshots[markName] = {
    at: new Date().toISOString(),
    position: { x: ix, y: iy, z: iz },
    total,
    items,
  };
  // Best-effort persistence — never let a write failure break a chest action.
  try {
    persistChestSnapshotsToDisk();
  } catch {}
}

function pushTaskHistoryRecord(task, finalStatus) {
  if (!task) return;
  const ended = Date.now();
  ctx.tasks.taskHistory.unshift({
    id: task.id,
    action: task.action,
    status: finalStatus,
    ended,
    duration_s: Math.round((ended - task.started) / 1000),
    parent_goal_id: task.parent_goal_id || null,
    error: task.error || undefined,
  });
  ctx.tasks.taskHistory = ctx.tasks.taskHistory.slice(0, ctx.tasks.MAX_TASK_HISTORY);
}


function recipeIngredientMap(recipe) {
  return _recipeIngredientMap(recipe, ctx.world.mcData);
}

function bestRecipeForInventory(recipes, b, wantCount) {
  return _bestRecipeForInventory(recipes, b.inventory.items(), wantCount, ctx.world.mcData);
}

function buildCraftPlan(b, itemName, wantCount = 1) {
  const itemType = ctx.world.mcData.itemsByName[itemName];
  if (!itemType) return { ok: false, error: `Unknown item "${itemName}"` };
  const table = b.findBlock({
    matching: ctx.world.mcData.blocksByName.crafting_table?.id,
    maxDistance: 4,
  });
  let recipes = b.recipesFor(itemType.id, null, 1, null);
  if ((!recipes || !recipes.length) && table) {
    recipes = b.recipesFor(itemType.id, null, 1, table);
  }
  if (!recipes || !recipes.length) {
    try { recipes = b.recipesAll(itemType.id, null, 1); } catch { recipes = null; }
  }
  return buildCraftPlanFromRecipes({
    recipes, invItems: b.inventory.items(), mcData: ctx.world.mcData,
    chestSnapshots: ctx.goals.chestSnapshots, itemName, wantCount,
  });
}

function getMyName() {
  return config.mc.username.toLowerCase();
}

function getNearbyPlayerNames() {
  if (!ctx.world.bot) return [];
  return Object.values(ctx.world.bot.entities || {})
    .map((entity) => entity.username)
    .filter(Boolean);
}

function rememberSocialEvent(event) {
  const withTime = { time: Date.now(), ...event };
  ctx.social.socialEvents.push(withTime);
  ctx.social.socialEvents = ctx.social.socialEvents.filter((entry) => Date.now() - entry.time < 30 * 60 * 1000).slice(-200);
  if (withTime.actor) applySocialEvent(ctx.social.socialGraph, withTime);
}

function getMemoryHints(limit = 4) {
  const hints = [...ctx.reactive.observedBlocks.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map((entry) => `${entry.name} ${entry.bearing} ${entry.distance}m (${Math.round((Date.now() - entry.lastSeen) / 1000)}s ago)`);
  return hints;
}

// Handle incoming chat message with routing
async function handleChat(username, message) {
  // Drop all rcon / server-broadcast chat. These are control-plane identities
  // — vanilla command-feedback ("Successfully filled", "Teleported X"), `say`
  // broadcasts from operators, and test harness announcements (`say [test #N]`
  // from tests/conftest.py) all reach every connected bot regardless of world
  // and pollute production-agent chat context. Different servers/proxies use
  // different sender names: Paper reports `Rcon`, vanilla `say` shows as
  // `Server` or `server`, some plugins prefix with `[Server]`. Drop them all
  // — a player character has no reason to react to operator broadcasts.
  const u = String(username || '').toLowerCase();
  if (u === 'rcon' || u === 'server' || u === '[server]' || u === '') {
    return;
  }

  const knownNames = buildKnownNames(getMyName(), getNearbyPlayerNames());
  const routing = parseMessageRouting(message, { knownNames });
  let forMe = isMessageForMe(routing, getMyName());

  // Proximity filter: broadcasts from other known agents only heard when nearby.
  // Human players are not in CURRENT_CAST so they always pass through.
  // BOT_HEAR_ALL=true bypasses this entirely — for coordinated multi-agent
  // tests where bots need to hear each other regardless of distance.
  const hearAll = config.behaviors.hearAll;
  if (!hearAll && forMe && routing.isBroadcast && ctx.world.bot && ctx.world.botReady) {
    const senderLower = username.toLowerCase();
    const isOtherAgent = CURRENT_CAST.includes(senderLower) && senderLower !== getMyName().toLowerCase();
    if (isOtherAgent) {
      const senderEntity = Object.values(ctx.world.bot.entities || {}).find(
        e => e.username && e.username.toLowerCase() === senderLower
      );
      const dist = senderEntity ? ctx.world.bot.entity.position.distanceTo(senderEntity.position) : Infinity;
      if (dist > FAIR_PLAY.LOS_ENTITY_RANGE) {
        ctx.social.overheardLog.push({ time: Date.now(), from: username, message: routing.body, channel: 'distant_broadcast', to: [] });
        if (ctx.social.overheardLog.length > ctx.social.MAX_LOG) ctx.social.overheardLog.shift();
        rememberSocialEvent({ actor: username, kind: 'heard', channel: 'overheard_distant', message: routing.body });
        return;
      }
    }
  }

  if (forMe) {
    // Message is for us — add to ctx.social.chatLog (visible in mc read_chat / mc status)
    ctx.social.chatLog.push({
      time: Date.now(),
      from: username,
      message: routing.body,
      private: !routing.isBroadcast,
      channel: routing.channel,
      targets: routing.targets.length > 0 ? routing.targets : undefined,
    });
    if (ctx.social.chatLog.length > ctx.social.MAX_LOG) ctx.social.chatLog.shift();
    log(`[Chat${routing.isBroadcast ? '' : ' @me'}] <${username}> ${routing.body}`);
    
    // If directly addressed (Name: msg format), queue as command
    if (!routing.isBroadcast) {
      ctx.social.commandQueue.push({
        time: Date.now(),
        from: username,
        command: routing.body,
        channel: routing.channel,
        originalMessage: message,
        status: 'pending',
      });
      rememberSocialEvent({ actor: username, kind: 'heard', channel: routing.channel, command: true, message: routing.body });
      if (ctx.social.commandQueue.length > ctx.social.MAX_QUEUE) ctx.social.commandQueue.shift();
      log(`[Queued] ${username}: ${routing.body}`);
    } else {
      // Broadcast but mentions our name at start? Also queue as command.
      const mention = broadcastMentionsMe(routing.body, getMyName());
      const command =
        mention != null
          ? stripMentionPrefix(routing.body, mention)
          : stripInlineNameMention(routing.body, getMyName());
      if (command) {
        ctx.social.commandQueue.push({
          time: Date.now(),
          from: username,
          command,
          channel: mention != null ? 'public_mention' : 'public_mention_inline',
          originalMessage: message,
          status: 'pending',
        });
        rememberSocialEvent({
          actor: username,
          kind: 'heard',
          channel: mention != null ? 'public_mention' : 'public_mention_inline',
          command: true,
          message: command,
        });
        if (ctx.social.commandQueue.length > ctx.social.MAX_QUEUE) ctx.social.commandQueue.shift();
        log(`[Queued via mention] ${username}: ${command}`);
      } else {
        rememberSocialEvent({ actor: username, kind: 'heard', channel: routing.channel, message: routing.body });
      }
    }
  } else {
    // Message is NOT for us — overheard only
    ctx.social.overheardLog.push({ time: Date.now(), from: username, message: routing.body,
                        channel: routing.channel, to: routing.targets });
    if (ctx.social.overheardLog.length > ctx.social.MAX_LOG) ctx.social.overheardLog.shift();
    rememberSocialEvent({ actor: username, kind: 'heard', channel: `overheard_${routing.channel}`, message: routing.body });
    log(`[Overheard] <${username}> → [${routing.targets.join(',')}] ${routing.body}`);
  }
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(v) { return typeof v === 'number' ? Math.round(v * 10) / 10 : v; }

function posObj(pos) {
  const p = pos || ctx.world.bot?.entity?.position;
  if (!p) return null;
  return { x: fmt(p.x), y: fmt(p.y), z: fmt(p.z) };
}

function itemStr(item) {
  if (!item) return null;
  return { name: item.name, count: item.count };
}

function ensureBot() {
  if (!ctx.world.bot || !ctx.world.botReady) {
    throw new Error('Bot not connected. POST /connect to retry.');
  }
  // mineflayer health plugin: isAlive false while on death screen / respawn packet in flight
  if (ctx.world.bot.isAlive === false) {
    throw new Error('Bot dead — respawn in progress. Retry in 1–2s (mineflayer auto-respawn + server).');
  }
  if (!ctx.world.bot.entity) {
    throw new Error('Bot not connected. POST /connect to retry.');
  }
  return ctx.world.bot;
}

// ═══════════════════════════════════════════════════════════════════
// Fair Play — Line-of-Sight & Perception (see lib/runtime/fair-play.js)
// ═══════════════════════════════════════════════════════════════════

const fairPlayApi = createFairPlaySuite({
  ctx,
  ensureBot,
  fmt,
  posObj,
  sleep,
  getMemoryHints,
});

const {
  filterEntitiesFairPlay,
  addSoundEvent,
  fairPlayHarvestTrunkCandidates,
  findVisibleBlocksByNameWithPhysicalSweep,
  entitiesMatchingAfterLookSweep,
  reactionDelay,
  buildSceneSummary,
  hasLineOfSight,
  eyePosition,
} = fairPlayApi;

const spatial = createSpatial({ ensureBot, fmt, posObj });

// Central services container (Phase 1 — additive). `services.state` is the
// flat ctx for now; sliced from Phase 3. `getActions` is late-bound below
// once ACTIONS is constructed. Existing factory call sites stay on the
// legacy deps shape; pilot migration starts in Phase 2 (crafting.js).
const actionsRef = { value: {} };
const services = createServices({
  config,
  state: ctx,
  ensureBot,
  resolver: { resolveInventoryItem, resolveCraftTarget, resolveBlockQuery },
  // `craft` bundle wires the server-built closures (over ctx.world.mcData,
  // ctx.goals.chestSnapshots) so crafting handlers can read them from services
  // instead of receiving them as flat deps. Phase 2 onward.
  craft: {
    resolveCraftItemName,
    buildCraftPlan,
    bestRecipeForInventory,
  },
  fairPlay: fairPlayApi,
  spatial,
  locations,
  social: { rememberSocialEvent, getMyName, getNearbyPlayerNames },
  utils: { fmt, posObj, sleep, log, itemStr },
  getActions: () => actionsRef.value,
});

const { createBot, startStuckWatchdog } = createBotManager({
  ctx,
  config,
  log,
  sleep,
  mineflayer,
  minecraftData,
  pathfinder,
  Movements,
  armorManager,
  autoEatLoader,
  collectBlock,
  FAIR_PLAY,
  handleChat,
  loadGoalsFromDisk,
  loadChestSnapshotsFromDisk,
  loadReminders,
  posObj,
  fmt,
  addSoundEvent,
  loadLocations,
  saveLocations,
  pruneDeathMarks: locations.pruneDeathMarks,
  pushTaskHistoryRecord,
  viewerPort: viewerPortOpt,
});

startStuckWatchdog();

/** Resolve CLI-style block query (incl. groups like wood → oak_log). */
function resolveMiningBlockName(raw) {
  let br = resolveBlockQuery({ mcData: ctx.world.mcData, query: String(raw), policy: 'exact_required' });
  if (!br.ok && br.code === 'ambiguous_query') {
    br = resolveBlockQuery({ mcData: ctx.world.mcData, query: String(raw), policy: 'cheapest_craftable' });
  }
  if (!br.ok) {
    throw new Error(
      br.message || `Unknown block "${raw}". Check spelling (e.g. oak_log, iron_ore, cobblestone).`,
    );
  }
  return br.selected.name;
}

/** Resolve craft target (exact id or alias like axe → wooden_axe). */
function resolveCraftItemName(raw) {
  let cr = resolveCraftTarget({ mcData: ctx.world.mcData, query: String(raw), policy: 'cheapest_craftable' });
  if (!cr.ok) cr = resolveCraftTarget({ mcData: ctx.world.mcData, query: String(raw), policy: 'exact_required' });
  if (!cr.ok) throw new Error(cr.message || `Unknown item "${raw}". Check spelling.`);
  return cr.selected.name;
}

const observation = createObservation({
  ctx,
  ensureBot,
  fmt,
  posObj,
  loadLocations,
  filterEntitiesFairPlay,
  buildSceneSummary,
  fireDueReminders,
  FAIR_PLAY,
  itemStr,
});
const {
  briefState,
  getFullState,
  getInventory,
  getNearby,
  buildObservePayload,
  buildLogisticsPayload,
  buildTypedAlerts,
  getGoalsScoreboard,
} = observation;

// ═══════════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════════

const ACTIONS = createAllActions({
  // Phase 2: services is available alongside the legacy deps. Migrated
  // factories (crafting.js) use services; others still use the flat deps.
  // Removed in Phase 3 when every factory is on services.
  services,
  ctx,
  config,
  ensureBot,
  goals,
  fmt,
  posObj,
  sleep,
  log,
  resolveMiningBlockName,
  resolveCraftItemName,
  buildCraftPlan,
  bestRecipeForInventory,
  resolveInventoryItem,
  fairPlayHarvestTrunkCandidates,
  findVisibleBlocksByNameWithPhysicalSweep,
  entitiesMatchingAfterLookSweep,
  filterEntitiesFairPlay,
  hasLineOfSight,
  eyePosition,
  reactionDelay,
  rememberSocialEvent,
  getMyName,
  loadLocations,
  saveLocations,
  flagMarkStale,
  clearMarkStale,
  resolveMarkPlaceFromBody,
  resolveContainerCoords,
  normalizeDepositWithdrawItems,
  buildMarksListApi,
  isContainerBlock,
  findNearbyContainer,
  snapshotChestAtPosition,
  persistChestSnapshotsToDisk,
  saveReminders,
});

// Phase 1: late-bind actions into services.getActions(). Cross-module
// action refs are still done via the legacy ACTIONS map in Phase 1;
// future phases switch callers to services.getActions().
actionsRef.value = ACTIONS;

const actionRegistry = createActionRegistry(ACTIONS);

// ── Reactive layer (Layer 2) ───────────────────────────────────────────
// Default-on; ticks every 400ms, no-ops while bot is disconnected.
// Agent picks the policy via `mc mode normal | guard | hold`.
// Disable entirely with REACTIVE=off env var.
const reactiveOn = config.behaviors.reactiveOn;
if (reactiveOn) {
  // COMBAT_SKILL env var lets per-character launchers default the bot to
  // soldier (0.9) or farmer (0.2) without an explicit `mc combat_skill` call.
  const skillEnv = config.behaviors.combatSkill;
  if (skillEnv !== undefined && skillEnv !== '') {
    const n = Number(skillEnv);
    if (Number.isFinite(n)) ctx.reactive.combat_skill = Math.max(0, Math.min(1, n));
  }
  const reactive = createReactive({ ctx, log, ACTIONS, sleep, hasLineOfSight, eyePosition });
  reactive.start();
  // Expose touchAgent on ctx so the HTTP layer can mark "agent is
  // driving" on every mc <verb> request (task #20 idle gate).
  ctx.reactive._touchAgent = reactive.touchAgent;
}


// ═══════════════════════════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════════════════════════

const httpServer = http.createServer(
  createBotHttpListener({
    config,
    ctx,
    spatial,
    actionRegistry,
    ensureBot,
    briefState,
    getFullState,
    buildMarksListApi,
    getInventory,
    getNearby,
    buildSceneSummary,
    summarizeSocialGraph,
    refreshLeaseCheckpoint,
    taskToApi,
    persistGoalsToDisk,
    listPresets,
    getGoalsScoreboard,
    buildObservePayload,
    buildTypedAlerts,
    buildLogisticsPayload,
    loadPreset,
    mergePresetIntoStore,
    createTaskRecord,
    pushTaskHistoryRecord,
    renewLease,
    createBot,
    viewerPort: viewerPortOpt,
  }),
);

// ═══════════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════════

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${config.api.port} already in use — exiting so bot-loop can respawn`);
  } else {
    log(`HTTP server error: ${err.message}`);
  }
  process.exit(1);
});

httpServer.listen(config.api.port, () => {
  if (config.logging.banner) {
    log(`╔═══════════════════════════════════════╗`);
    log(`║     HermesCraft Bot Server v4.0      ║`);
    log(`╠═══════════════════════════════════════╣`);
    log(`║  API:  http://localhost:${config.api.port}          ║`);
    log(`║  MC:   ${config.mc.host}:${config.mc.port}                ║`);
    log(`║  User: ${config.mc.username.padEnd(28)}║`);
    log(`╚═══════════════════════════════════════╝`);
  } else {
    log(`HermesCraft bot ready: API :${config.api.port} | MC ${config.mc.host}:${config.mc.port} | user ${config.mc.username}`);
  }
  const profile = config.agent.profile;
  const agentModel = config.agent.model;
  const agentProvider = config.agent.provider;
  log(`LLM routing (AGENT_* → /health): profile=${profile}`);
  if (agentModel) {
    log(`LLM model:   ${agentModel}`);
    log(`LLM provider: ${agentProvider || '(unset)'}`);
  } else {
    log('LLM model:   (AGENT_MODEL not set — Hermes uses its own -m/--provider; dashboard may show null)');
  }

  // Connect ctx.world.bot
  createBot().catch(e => {
    log(`Initial connection failed: ${e.message}`);
    log('Bot server is running — POST /connect when Minecraft is ready.');
  });
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message} — exiting so bot-loop can respawn`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err} — exiting so bot-loop can respawn`);
  process.exit(1);
});
