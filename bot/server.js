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
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL, fileURLToPath } from 'url';
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
  applySocialEvent,
  summarizeSocialGraph,
} from './lib/chat.js';
import {
  goalsFileForUser,
  loadGoalsStore,
  saveGoalsStore,
  loadPreset,
  listPresets,
  mergePresetIntoStore,
} from './lib/goals.js';
import { createTaskRecord, refreshLeaseCheckpoint, renewLease, taskToApi } from './lib/tasks.js';
import { loadConfig } from './lib/config.js';
import { createBotState } from './lib/state.js';
import { resolveInventoryItem, resolveCraftTarget, resolveBlockQuery } from './lib/resolver.js';
import { FAIR_PLAY } from './lib/fair-play-constants.js';
import { createFairPlaySuite } from './lib/fair-play.js';
import { createSpatial } from './lib/spatial.js';
import { createActionRegistry } from './lib/action-registry.js';
import { createBotHttpListener } from './lib/router.js';
import { createBotManager } from './lib/bot-manager.js';
import { createLocationsStore, isContainerBlock, findNearbyContainer } from './lib/bot/locations.js';
import { createAllActions } from './lib/actions/index.js';
import { createObservation } from './lib/bot/observation.js';

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
  const b = ctx.bot && ctx.botReady ? ctx.bot : null;
  const pos = b ? b.entity.position : null;
  return locations.buildMarksList({ botPos: pos, chestSnapshots: ctx.chestSnapshots });
}

// ═══════════════════════════════════════════════════════════════════
// Configuration + injectable context
// ═══════════════════════════════════════════════════════════════════

const config = loadConfig(process.argv);
locations = createLocationsStore({ dataDir: DATA_DIR, username: config.mc.username });
const ctx = createBotState(config);

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
    ctx.reminders = Array.isArray(data.reminders) ? data.reminders : [];
    ctx.remindersNextId = typeof data.nextId === 'number' ? data.nextId : (ctx.reminders.length ? Math.max(...ctx.reminders.map(r => r.id)) + 1 : 1);
  } catch {
    ctx.reminders = [];
    ctx.remindersNextId = 1;
  }
}

function saveReminders() {
  const dir = path.dirname(remindersFilePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(remindersFilePath(), JSON.stringify({ reminders: ctx.reminders, nextId: ctx.remindersNextId }, null, 2));
}

function getDueReminders() {
  const now = Date.now();
  return ctx.reminders.filter(r => now - (r.last_fired || r.created) >= r.interval_ms);
}

function fireDueReminders() {
  const now = Date.now();
  const due = [];
  for (const r of ctx.reminders) {
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
  ctx.goalsStore = loadGoalsStore(goalsPath());
}
function persistGoalsToDisk() {
  saveGoalsStore(goalsPath(), {
    goals: ctx.goalsStore.goals,
    deficitSince: ctx.goalsStore.deficitSince || {},
  });
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
  ctx.chestSnapshots[markName] = {
    at: new Date().toISOString(),
    position: { x: ix, y: iy, z: iz },
    total,
    items,
  };
}

function pushTaskHistoryRecord(task, finalStatus) {
  if (!task) return;
  const ended = Date.now();
  ctx.taskHistory.unshift({
    id: task.id,
    action: task.action,
    status: finalStatus,
    ended,
    duration_s: Math.round((ended - task.started) / 1000),
    parent_goal_id: task.parent_goal_id || null,
    error: task.error || undefined,
  });
  ctx.taskHistory = ctx.taskHistory.slice(0, ctx.MAX_TASK_HISTORY);
}


function recipeIngredientMap(recipe) {
  const ings = {};
  const addId = (id) => {
    if (!id || id === -1) return;
    const name = ctx.mcData.items[id]?.name || `id:${id}`;
    ings[name] = (ings[name] || 0) + 1;
  };
  if (recipe.inShape) {
    for (const row of recipe.inShape) for (const id of row) addId(id);
  } else if (recipe.ingredients) {
    for (const row of recipe.ingredients) for (const id of row) addId(id);
  }
  return ings;
}

function buildCraftPlan(b, itemName, wantCount = 1) {
  const itemType = ctx.mcData.itemsByName[itemName];
  if (!itemType) return { ok: false, error: `Unknown item "${itemName}"` };
  const table = b.findBlock({
    matching: ctx.mcData.blocksByName.crafting_table?.id,
    maxDistance: 4,
  });
  let recipes = b.recipesFor(itemType.id, null, 1, null);
  if ((!recipes || !recipes.length) && table) {
    recipes = b.recipesFor(itemType.id, null, 1, table);
  }
  if (!recipes || !recipes.length) {
    try {
      recipes = b.recipesAll(itemType.id, null, 1);
    } catch {
      recipes = null;
    }
  }
  if (!recipes || !recipes.length) {
    return { ok: false, error: `No recipe for ${itemName}` };
  }
  const r = recipes[0];
  const ingCounts = recipeIngredientMap(r);
  const inv = b.inventory.items();
  const countHave = (n) => inv.filter((i) => i.name === n).reduce((s, i) => s + i.count, 0);
  const missing = [];
  const have = {};
  for (const [n, c] of Object.entries(ingCounts)) {
    const need = c * wantCount;
    const h = countHave(n);
    have[n] = h;
    if (h < need) missing.push({ name: n, need, have: h, short: need - h });
  }
  return {
    ok: true,
    item: itemName,
    count: wantCount,
    ingredients: ingCounts,
    have,
    missing,
    needs_table: r.requiresTable !== false,
  };
}

function getMyName() {
  return config.mc.username.toLowerCase();
}

function getNearbyPlayerNames() {
  if (!ctx.bot) return [];
  return Object.values(ctx.bot.entities || {})
    .map((entity) => entity.username)
    .filter(Boolean);
}

function rememberSocialEvent(event) {
  const withTime = { time: Date.now(), ...event };
  ctx.socialEvents.push(withTime);
  ctx.socialEvents = ctx.socialEvents.filter((entry) => Date.now() - entry.time < 30 * 60 * 1000).slice(-200);
  if (withTime.actor) applySocialEvent(ctx.socialGraph, withTime);
}

function getMemoryHints(limit = 4) {
  const hints = [...ctx.observedBlocks.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map((entry) => `${entry.name} ${entry.bearing} ${entry.distance}m (${Math.round((Date.now() - entry.lastSeen) / 1000)}s ago)`);
  return hints;
}

// Handle incoming chat message with routing
async function handleChat(username, message) {
  const knownNames = buildKnownNames(getMyName(), getNearbyPlayerNames());
  const routing = parseMessageRouting(message, { knownNames });
  let forMe = isMessageForMe(routing, getMyName());

  // Proximity filter: broadcasts from other known agents only heard when nearby.
  // Human players are not in CURRENT_CAST so they always pass through.
  if (forMe && routing.isBroadcast && ctx.bot && ctx.botReady) {
    const senderLower = username.toLowerCase();
    const isOtherAgent = CURRENT_CAST.includes(senderLower) && senderLower !== getMyName().toLowerCase();
    if (isOtherAgent) {
      const senderEntity = Object.values(ctx.bot.entities || {}).find(
        e => e.username && e.username.toLowerCase() === senderLower
      );
      const dist = senderEntity ? ctx.bot.entity.position.distanceTo(senderEntity.position) : Infinity;
      if (dist > FAIR_PLAY.LOS_ENTITY_RANGE) {
        ctx.overheardLog.push({ time: Date.now(), from: username, message: routing.body, channel: 'distant_broadcast', to: [] });
        if (ctx.overheardLog.length > ctx.MAX_LOG) ctx.overheardLog.shift();
        rememberSocialEvent({ actor: username, kind: 'heard', channel: 'overheard_distant', message: routing.body });
        return;
      }
    }
  }

  if (forMe) {
    // Message is for us — add to ctx.chatLog (visible in mc read_chat / mc status)
    ctx.chatLog.push({
      time: Date.now(),
      from: username,
      message: routing.body,
      private: !routing.isBroadcast,
      channel: routing.channel,
      targets: routing.targets.length > 0 ? routing.targets : undefined,
    });
    if (ctx.chatLog.length > ctx.MAX_LOG) ctx.chatLog.shift();
    log(`[Chat${routing.isBroadcast ? '' : ' @me'}] <${username}> ${routing.body}`);
    
    // If directly addressed (Name: msg format), queue as command
    if (!routing.isBroadcast) {
      ctx.commandQueue.push({
        time: Date.now(),
        from: username,
        command: routing.body,
        channel: routing.channel,
        originalMessage: message,
        status: 'pending',
      });
      rememberSocialEvent({ actor: username, kind: 'heard', channel: routing.channel, command: true, message: routing.body });
      if (ctx.commandQueue.length > ctx.MAX_QUEUE) ctx.commandQueue.shift();
      log(`[Queued] ${username}: ${routing.body}`);
    } else {
      // Broadcast but mentions our name at start? Also queue as command.
      const mention = broadcastMentionsMe(routing.body, getMyName());
      if (mention) {
        const command = stripMentionPrefix(routing.body, mention);
        if (command) {
          ctx.commandQueue.push({
            time: Date.now(),
            from: username,
            command,
            channel: 'public_mention',
            originalMessage: message,
            status: 'pending',
          });
          rememberSocialEvent({ actor: username, kind: 'heard', channel: 'public_mention', command: true, message: command });
          if (ctx.commandQueue.length > ctx.MAX_QUEUE) ctx.commandQueue.shift();
          log(`[Queued via mention] ${username}: ${command}`);
        }
      } else {
        rememberSocialEvent({ actor: username, kind: 'heard', channel: routing.channel, message: routing.body });
      }
    }
  } else {
    // Message is NOT for us — overheard only
    ctx.overheardLog.push({ time: Date.now(), from: username, message: routing.body,
                        channel: routing.channel, to: routing.targets });
    if (ctx.overheardLog.length > ctx.MAX_LOG) ctx.overheardLog.shift();
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
  const p = pos || ctx.bot?.entity?.position;
  if (!p) return null;
  return { x: fmt(p.x), y: fmt(p.y), z: fmt(p.z) };
}

function itemStr(item) {
  if (!item) return null;
  return { name: item.name, count: item.count };
}

function ensureBot() {
  if (!ctx.bot || !ctx.botReady || !ctx.bot.entity) {
    throw new Error('Bot not connected. POST /connect to retry.');
  }
  return ctx.bot;
}

// ═══════════════════════════════════════════════════════════════════
// Fair Play — Line-of-Sight & Perception (see lib/fair-play.js)
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
} = fairPlayApi;

const spatial = createSpatial({ ensureBot, fmt, posObj });

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
  loadReminders,
  posObj,
  fmt,
  addSoundEvent,
  loadLocations,
  saveLocations,
  pushTaskHistoryRecord,
});

startStuckWatchdog();

/** Resolve CLI-style block query (incl. groups like wood → oak_log). */
function resolveMiningBlockName(raw) {
  let br = resolveBlockQuery({ mcData: ctx.mcData, query: String(raw), policy: 'exact_required' });
  if (!br.ok && br.code === 'ambiguous_query') {
    br = resolveBlockQuery({ mcData: ctx.mcData, query: String(raw), policy: 'cheapest_craftable' });
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
  let cr = resolveCraftTarget({ mcData: ctx.mcData, query: String(raw), policy: 'cheapest_craftable' });
  if (!cr.ok) cr = resolveCraftTarget({ mcData: ctx.mcData, query: String(raw), policy: 'exact_required' });
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
  resolveInventoryItem,
  fairPlayHarvestTrunkCandidates,
  findVisibleBlocksByNameWithPhysicalSweep,
  entitiesMatchingAfterLookSweep,
  filterEntitiesFairPlay,
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
  saveReminders,
});

const actionRegistry = createActionRegistry(ACTIONS);


// ═══════════════════════════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════════════════════════

const dashboardHtmlPath = fileURLToPath(new URL('./dashboard.html', import.meta.url));

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
    dashboardHtmlPath,
  }),
);

// ═══════════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════════

httpServer.listen(config.api.port, () => {
  log(`╔═══════════════════════════════════════╗`);
  log(`║     HermesCraft Bot Server v4.0      ║`);
  log(`╠═══════════════════════════════════════╣`);
  log(`║  API:  http://localhost:${config.api.port}          ║`);
  log(`║  MC:   ${config.mc.host}:${config.mc.port}                ║`);
  log(`║  User: ${config.mc.username.padEnd(28)}║`);
  log(`╚═══════════════════════════════════════╝`);

  // Connect ctx.bot
  createBot().catch(e => {
    log(`Initial connection failed: ${e.message}`);
    log('Bot server is running — POST /connect when Minecraft is ready.');
  });
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err}`);
});
