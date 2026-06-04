import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadRegistry, boardIdForWorld } from './lib/registry.js';
import { fetchWithTimeout } from './lib/poll.js';
import { getCachedOpenRouterCredits } from './lib/openrouter.js';
import { updateAgentMotion } from './lib/motion.js';
import { fetchBoardWithFallback, fetchBoardsListWithFallback } from './lib/kanban.js';
import {
  getWorldMapConfig,
  tileWorldForHermes,
  settingsJsonUrl,
  playerNamesFromMarkersJson,
  playersMarkerUrls,
  playersMarkersUrl,
  parseSquaremapWorldZoom,
  worldSettingsJsonUrl,
} from './lib/world-map.js';
import { nearbyPlayerName, isPlaceholderPlayerName } from './lib/nearby-players.js';
import {
  botMcNameSet,
  discoveryPortList,
  isHermesBotHealth,
  mergePollTargets,
} from './lib/bot-discovery.js';
import { hermesHomeCandidates, hermesHomeLabel } from './lib/agent-paths.js';
import { fetchLiveWorldFromBot, mergeAgentWorld } from './lib/live-world.js';
import { dedupePersonalPois } from './lib/personal-pois.js';
import { loadCognitionFromHomes } from './lib/cognition.js';
import { runHermesCli } from './lib/hermes-cli.js';
import { loadMapContext } from './lib/map-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const BOT_HOST = process.env.BOT_HOST || '127.0.0.1';
const HERMES_KANBAN_BASE = process.env.HERMES_KANBAN_BASE || 'http://127.0.0.1:27124';
/** Initial world selector value (from start-dashboard.sh --world or DASHBOARD_WORLD). */
const STARTUP_WORLD = (process.env.DASHBOARD_WORLD || '').trim() || null;

const registry = loadRegistry(REPO_ROOT);
if (!registry) {
  console.error('Missing data/agent-registry.json');
  process.exit(1);
}

const worldMapConfig = getWorldMapConfig(registry);

/** @type {{ at: number, byHermes: Record<string, { def: number, max: number, extra: number, uiMax: number }> }} */
let squaremapZoomCache = { at: 0, byHermes: {} };
const SQUAREMAP_ZOOM_CACHE_MS = 60_000;

async function fetchSquaremapZoomByHermesWorld() {
  if (!worldMapConfig) return {};
  const now = Date.now();
  if (now - squaremapZoomCache.at < SQUAREMAP_ZOOM_CACHE_MS && squaremapZoomCache.byHermes) {
    return squaremapZoomCache.byHermes;
  }
  /** @type {Record<string, { def: number, max: number, extra: number, uiMax: number }>} */
  const byHermes = {};
  const entries = Object.entries(worldMapConfig.hermesToTileWorld || {});
  await Promise.all(
    entries.map(async ([hermesWorld, tileWorld]) => {
      try {
        const url = worldSettingsJsonUrl(worldMapConfig.baseUrl, tileWorld);
        const r = await fetchWithTimeout(url, { timeout: 5000 });
        const body = await r.json().catch(() => null);
        if (!r.ok || !body) return;
        const parsed = parseSquaremapWorldZoom(body);
        if (parsed) byHermes[hermesWorld] = parsed;
      } catch {
        /* upstream offline */
      }
    }),
  );
  squaremapZoomCache = { at: now, byHermes };
  return byHermes;
}

let tick = 0;
/** @type {any} */
let lastFleet = null;

function botUrl(port, p) {
  return `http://${BOT_HOST}:${port}${p}`;
}

function parseHealth(n) {
  if (typeof n.health === 'number') return n.health;
  const x = parseFloat(String(n.health ?? ''));
  return Number.isFinite(x) ? x : 0;
}

/** briefState `task: { action, elapsed }` when full taskToApi is absent. */
function briefTaskFromState(state) {
  const t = state?.task;
  if (!t || typeof t !== 'object') return null;
  const action = typeof t.action === 'string' ? t.action : null;
  if (!action) return null;
  return {
    action,
    status: 'running',
    elapsed: typeof t.elapsed === 'string' ? t.elapsed : null,
  };
}

function resolveViewerPort(agent, healthBody, connected) {
  const hp = healthBody?.viewer_port;
  if (connected && hp != null && Number(hp) > 0) return Number(hp);
  if (agent.viewer_port != null && Number(agent.viewer_port) > 0) return Number(agent.viewer_port);
  if (agent.api_port != null) return Number(agent.api_port) + 1000;
  return null;
}

function normalizeAgentRow(agent, healthBody, obsBody, err) {
  const discovered = agent.discovered === true;
  const connected = healthBody?.connected === true;
  const mcUsername =
    healthBody?.username != null ? String(healthBody.username).trim() : null;
  const identityOk =
    discovered ||
    !connected ||
    !mcUsername ||
    mcUsername.toLowerCase() === String(agent.name || '').toLowerCase();
  const displayName =
    discovered && mcUsername ? mcUsername : String(agent.name || mcUsername || 'agent');
  const obsOk = obsBody?.ok === true;
  /** briefState() is null when off-world or not ready — do not coerce to {} */
  const rawState = obsBody?.state;
  const hasLiveBody =
    rawState != null &&
    typeof rawState === 'object' &&
    rawState.position &&
    typeof rawState.position.x === 'number';
  const online = connected && obsOk && hasLiveBody && identityOk;
  const state = hasLiveBody ? rawState : {};
  const pos = state.position;
  const motion = updateAgentMotion(displayName, pos && typeof pos.x === 'number' ? pos : null);
  const goals = obsBody?.goals || [];
  const top = goals.find((g) => g && g.satisfied === false) || goals[0] || null;
  const recent = Array.isArray(obsBody?.recent_actions) ? obsBody.recent_actions[0] : null;
  const timeTicks =
    obsBody?.time != null
      ? Number(obsBody.time)
      : state.time != null
        ? Number(state.time)
        : null;

  return {
    name: displayName,
    discovered,
    online,
    is_day: obsBody?.is_day ?? state.isDay ?? null,
    time_ticks: Number.isFinite(timeTicks) ? timeTicks : null,
    last_death_age_s:
      typeof state.last_death_age_s === 'number' ? state.last_death_age_s : null,
    death_count: typeof state.deaths === 'number' ? state.deaths : null,
    kills: typeof state.kills === 'number' ? state.kills : null,
    idle_reason: obsBody?.idle_reason ?? null,
    hazard: typeof state.hazard === 'string' ? state.hazard : null,
    damage_telemetry: state.damage_telemetry ?? null,
    respawn_pending: Boolean(state.respawn_pending),
    alerts_count: Array.isArray(obsBody?.alerts) ? obsBody.alerts.length : 0,
    motion_speed_bps: motion.speed_bps,
    motion_idle_sec: motion.idle_sec,
    poll_error:
      err ||
      (connected && !identityOk
        ? `MC user is ${mcUsername}, not ${agent.name}`
        : null),
    mc_username: mcUsername,
    model: agent.model || healthBody?.model || null,
    api_port: agent.api_port,
    viewer_port: resolveViewerPort(agent, healthBody, connected && identityOk),
    viewer_active:
      connected && identityOk
        ? healthBody?.viewer_port != null
          ? Number(healthBody.viewer_port) > 0
          : null
        : false,
    radar_port: agent.radar_port ?? null,
    world: agent.world || registry.defaultWorld,
    dimension: null,
    health: parseHealth(state),
    food: typeof state.food === 'number' ? state.food : Number(state.food) || 0,
    position: pos && typeof pos.x === 'number' ? { x: pos.x, y: pos.y, z: pos.z } : null,
    holding: state.holding || null,
    task: obsBody?.task || briefTaskFromState(state),
    top_goal: top
      ? {
          id: top.id,
          satisfied: Boolean(top.satisfied),
          urgency: top.urgency ?? null,
          gap: top.gap ?? null,
        }
      : null,
    recent_action: recent || null,
    recent_actions: Array.isArray(obsBody?.recent_actions)
      ? obsBody.recent_actions.slice(0, 5)
      : [],
    player_requests: Array.isArray(state.player_requests) ? state.player_requests.slice(0, 5) : [],
    active_tasks: Array.isArray(state.active_tasks) ? state.active_tasks.slice(0, 5) : [],
    auto_action_log: Array.isArray(obsBody?.auto_action_log)
      ? obsBody.auto_action_log.slice(-4)
      : [],
    inventory_summary: obsBody?.inventory_summary || {},
    new_chat: Array.isArray(state.new_chat) ? state.new_chat : [],
    spend_rate_usd_per_hr: null,
    cumulative_session_usd: null,
    session_uptime_sec:
      connected && typeof healthBody?.uptime_sec === 'number' ? healthBody.uptime_sec : null,
    session_started_at_ms:
      connected && healthBody?.session_started_at != null ? healthBody.session_started_at : null,
  };
}

async function pollAgent(agent) {
  const hUrl = botUrl(agent.api_port, '/health');
  const oUrl = botUrl(agent.api_port, '/observe?lean=true');
  let err = null;
  let healthBody = null;
  let obsBody = null;
  try {
    const [hr, oR] = await Promise.all([
      fetchWithTimeout(hUrl, { timeout: 8000 }),
      fetchWithTimeout(oUrl, { timeout: 8000 }),
    ]);
    healthBody = await hr.json().catch(() => null);
    obsBody = await oR.json().catch(() => null);
    if (!hr.ok) err = `health ${hr.status}`;
    else if (!oR.ok) err = `observe ${oR.status}`;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  return normalizeAgentRow(agent, healthBody, obsBody, err);
}

async function probeHermesBotsOnPorts(ports) {
  /** @type {{ port: number, username: string, model?: string | null, profile?: string | null }[]} */
  const found = [];
  await Promise.all(
    ports.map(async (port) => {
      try {
        const r = await fetchWithTimeout(botUrl(port, '/health'), { timeout: 1500 });
        const body = await r.json().catch(() => null);
        if (!r.ok || !isHermesBotHealth(body)) return;
        found.push({
          port,
          username: body.username.trim(),
          model: body.model ?? null,
          profile: body.profile ?? null,
        });
      } catch {
        /* closed port or non-bot */
      }
    }),
  );
  return found;
}

async function pollAllAgents() {
  const registryPorts = new Set(
    registry.agents.map((a) => Number(a.api_port)).filter((p) => Number.isFinite(p) && p > 0),
  );
  const scanPorts = discoveryPortList(registry, { dashboardPort: PORT }).filter(
    (p) => !registryPorts.has(p),
  );
  const discoveredHits = await probeHermesBotsOnPorts(scanPorts);
  const targets = mergePollTargets(registry, discoveredHits);
  const rows = await Promise.all(targets.map((a) => pollAgent(a)));
  await Promise.all(
    rows.map(async (row, i) => {
      const reg = targets[i];
      if (!row.online) return;
      const live = await fetchLiveWorldFromBot(botUrl, reg.api_port);
      row.world = mergeAgentWorld(live, reg.world, registry.defaultWorld);
    }),
  );
  return rows;
}

function resolveAgentRecord(name) {
  const reg = registry.agents.find((a) => a.name === name);
  if (reg) return reg;
  const row = lastFleet?.agents?.find((a) => a.name === name && a.discovered && a.api_port);
  if (!row) return null;
  return {
    name: row.name,
    api_port: row.api_port,
    world: row.world || registry.defaultWorld,
    model: row.model || null,
    discovered: true,
    hermes_home: null,
    viewer_port: row.viewer_port ?? null,
    radar_port: null,
  };
}

function pollRegForAgentRow(row) {
  return (
    registry.agents.find((x) => x.name === row.name) || {
      name: row.name,
      api_port: row.api_port,
      world: row.world || registry.defaultWorld,
    }
  );
}

async function fetchRegions(agent) {
  const url = botUrl(agent.api_port, '/regions');
  const r = await fetchWithTimeout(url, { timeout: 8000 }).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => null);
  const regions = j?.data?.regions;
  return Array.isArray(regions) ? regions : [];
}

async function buildRegionsForWorld(world) {
  const byId = new Map();
  const tasks = registry.agents.map(async (agent) => {
    const live = await fetchLiveWorldFromBot(botUrl, agent.api_port);
    const w = mergeAgentWorld(live, agent.world, registry.defaultWorld);
    if (w !== world) return;
    const regions = await fetchRegions(agent);
    for (const reg of regions) {
      if (!reg?.id || byId.has(reg.id)) continue;
      byId.set(reg.id, { world: w, ...reg });
    }
  });
  await Promise.all(tasks);
  return [...byId.values()];
}

async function fetchMarks(agent) {
  const url = botUrl(agent.api_port, '/marks');
  const r = await fetchWithTimeout(url, { timeout: 8000 }).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => null);
  const marks = j?.data?.marks;
  return Array.isArray(marks) ? marks : [];
}

async function fetchPersonalPois(agent) {
  const url = botUrl(agent.api_port, '/personal-pois');
  const r = await fetchWithTimeout(url, { timeout: 8000 }).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => null);
  const pois = j?.data?.pois;
  return Array.isArray(pois) ? pois : [];
}

async function fetchInventory(agent) {
  const url = botUrl(agent.api_port, '/inventory');
  const r = await fetchWithTimeout(url, { timeout: 8000 }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.data ?? null;
}

async function fetchAgentGoals(agent) {
  const url = botUrl(agent.api_port, '/goals?full=true');
  const r = await fetchWithTimeout(url, { timeout: 8000 }).catch(() => null);
  if (!r || !r.ok) return { ok: false, status: r?.status };
  const j = await r.json().catch(() => null);
  if (!j?.ok) return { ok: false };
  return { ok: true, goals: j.data?.goals ?? [], context: j.data?.context ?? null };
}

async function fetchMapPlayerNames(hermesWorld) {
  if (!worldMapConfig) return [];
  const tileWorld = tileWorldForHermes(worldMapConfig, hermesWorld);
  if (!tileWorld) return [];
  const urls = playersMarkerUrls(worldMapConfig.baseUrl, tileWorld);
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, { timeout: 5000 });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body) continue;
      const names = playerNamesFromMarkersJson(body);
      if (names.length) return names;
    } catch {
      /* try next URL */
    }
  }
  return [];
}

async function fetchNearbyPlayers(agent) {
  const url = botUrl(
    agent.api_port,
    '/nearby?radius=128&fair_play=false&entity_limit=48',
  );
  const r = await fetchWithTimeout(url, { timeout: 8000 }).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => null);
  const ents = j?.data?.entities || [];
  return ents.filter((e) => e.kind === 'player');
}

function dedupePoi(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = `${p.world}|${p.name}|${Math.round(p.x)}|${Math.round(p.y)}|${Math.round(p.z)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// dedupePersonalPois lives in ./lib/personal-pois.js so dashboard/test
// can import it without spinning up the HTTP server. The route below
// uses the imported function directly.

async function buildFleetSnapshot() {
  tick += 1;
  const agents = await pollAllAgents();
  lastFleet = { agents };
  const openrouter = await getCachedOpenRouterCredits(REPO_ROOT);

  /** @type {{ name: string, online: boolean, world: string, position: any, human: boolean }[]} */
  const humansMap = new Map();
  const onlinePairs = agents
    .filter((a) => a.online)
    .map((row) => ({ row, reg: pollRegForAgentRow(row) }));
  await Promise.all(
    onlinePairs.map(async ({ row, reg }) => {
      const world = row.world || reg.world || registry.defaultWorld;
      const nearby = await fetchNearbyPlayers(reg);
      for (const e of nearby) {
        const name = nearbyPlayerName(e);
        if (!name || isPlaceholderPlayerName(name)) continue;
        if (
          name.toLowerCase() === String(reg.name).toLowerCase() ||
          name.toLowerCase() === String(row.mc_username || '').toLowerCase()
        ) {
          continue;
        }
        const prev = humansMap.get(name);
        if (!prev || (e.position && !prev.position)) {
          humansMap.set(name, {
            name,
            online: true,
            world,
            position: e.position || null,
            human: true,
          });
        }
      }
    }),
  );

  const botNames = botMcNameSet(registry, agents);
  const worldsForPlayers = new Set([registry.defaultWorld]);
  for (const a of agents) {
    if (a.world) worldsForPlayers.add(a.world);
  }
  for (const w of worldsForPlayers) {
    const mapNames = await fetchMapPlayerNames(w);
    for (const name of mapNames) {
      if (!name || botNames.has(name.toLowerCase()) || isPlaceholderPlayerName(name)) continue;
      humansMap.set(name, {
        name,
        online: true,
        world: w,
        position: humansMap.get(name)?.position ?? null,
        human: true,
      });
    }
  }

  for (const key of [...humansMap.keys()]) {
    if (isPlaceholderPlayerName(key)) humansMap.delete(key);
  }

  const humans = [...humansMap.values()];

  const chat = [];
  const now = Date.now();
  for (const ag of agents) {
    if (!ag.online || !Array.isArray(ag.new_chat)) continue;
    const w = ag.world || registry.defaultWorld;
    for (const line of ag.new_chat) {
      chat.push({
        from: line.from,
        message: line.message,
        ts: now,
        world: w,
        agent: ag.name,
      });
    }
  }

  const dayRow = agents.find((a) => a.online && a.is_day != null);
  const timeRow = agents.find((a) => a.online && a.time_ticks != null);

  return {
    tick,
    time: {
      ticks: timeRow?.time_ticks ?? null,
      is_day: dayRow ? dayRow.is_day : null,
    },
    openrouter: {
      balance_usd: openrouter.balance_usd,
      usage_usd: openrouter.usage_usd,
      usage_daily_usd: openrouter.usage_daily_usd ?? null,
      usage_monthly_usd: openrouter.usage_monthly_usd ?? null,
      limit_usd: openrouter.limit_usd ?? null,
      label: openrouter.label ?? null,
    },
    agents,
    humans,
    chat: chat.slice(-40),
    _meta: { bot_host: BOT_HOST, kanban_base: HERMES_KANBAN_BASE },
  };
}

async function refreshFleetLoop() {
  try {
    lastFleet = await buildFleetSnapshot();
  } catch (e) {
    console.error('fleet poll failed', e);
  }
}

await refreshFleetLoop();
setInterval(refreshFleetLoop, 2000);

async function buildPoiForWorld(world) {
  const rows = [];
  const tasks = registry.agents.map(async (agent) => {
    const live = await fetchLiveWorldFromBot(botUrl, agent.api_port);
    const w = mergeAgentWorld(live, agent.world, registry.defaultWorld);
    if (w !== world) return;
    const marks = await fetchMarks(agent);
    for (const m of marks) {
      rows.push({
        world: w,
        name: m.name,
        x: m.x,
        y: m.y,
        z: m.z,
        note: m.note || '',
        last_visited_by: agent.name,
      });
    }
  });
  await Promise.all(tasks);
  return dedupePoi(rows);
}

/**
 * Aggregate personal POIs across all assignable agents in `world`. Each
 * bot has its own per-bot file; we fetch `GET /personal-pois` from every
 * agent, tag with the discovering bot, and dedupe by name keeping the
 * freshest `last_seen`. The result is the dashboard's Ops-map overlay
 * for personal POIs (a parallel layer to /api/poi for fleet marks).
 */
async function buildPersonalPoisForWorld(world) {
  const rows = [];
  const tasks = registry.agents.map(async (agent) => {
    const live = await fetchLiveWorldFromBot(botUrl, agent.api_port);
    const w = mergeAgentWorld(live, agent.world, registry.defaultWorld);
    if (w !== world) return;
    const pois = await fetchPersonalPois(agent);
    for (const p of pois) {
      rows.push({
        world: w,
        name: p.name,
        x: p.x,
        y: p.y,
        z: p.z,
        kind: p.kind || null,
        sign_at: p.sign_at || null,
        torch_at: p.torch_at || null,
        torch_missing_since: p.torch_missing_since || null,
        note: p.note || '',
        agent_owner: p.agent_owner || agent.name,
        last_seen: p.last_seen || null,
        added_at: p.added_at || null,
        source: p.source || null,
        observed_by: agent.name,
      });
    }
  });
  await Promise.all(tasks);
  return dedupePersonalPois(rows);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath, type) {
  fs.readFile(filePath, (e, buf) => {
    if (e) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/fleet') {
    const snap = lastFleet || (await buildFleetSnapshot());
    const agents = snap.agents.map((a) => ({
      ...a,
      new_chat: Array.isArray(a.new_chat) ? a.new_chat.slice(-12) : [],
    }));
    const out = { ...snap, agents };
    return sendJson(res, 200, out);
  }

  if (req.method === 'GET' && url.pathname === '/api/worlds') {
    const names = (registry.worlds || []).map((w) => w.name);
    const startupWorld =
      STARTUP_WORLD && names.includes(STARTUP_WORLD) ? STARTUP_WORLD : null;
    return sendJson(res, 200, {
      worlds: registry.worlds || [],
      kanbanBoardIdsByWorld: registry.kanbanBoardIdsByWorld || {},
      defaultKanbanBoardId: registry.defaultKanbanBoardId || null,
      defaultWorld: registry.defaultWorld || null,
      startupWorld,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/map/config') {
    if (!worldMapConfig) {
      return sendJson(res, 200, { ok: false, enabled: false });
    }
    const worldZoomByHermes = await fetchSquaremapZoomByHermesWorld();
    const hermesWorld = url.searchParams.get('world') || registry.defaultWorld;
    const mapContext = loadMapContext(REPO_ROOT, hermesWorld);
    return sendJson(res, 200, {
      ok: true,
      enabled: true,
      baseUrl: worldMapConfig.baseUrl,
      hermesToTileWorld: worldMapConfig.hermesToTileWorld,
      iframeDefaults: worldMapConfig.iframeDefaults,
      tile: worldMapConfig.tile,
      worldZoomByHermes,
      tileRevision: mapContext.tile_revision ?? null,
      procLab: mapContext.proc_lab ?? null,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/map/context') {
    const hermesWorld = url.searchParams.get('world') || registry.defaultWorld;
    const mapContext = loadMapContext(REPO_ROOT, hermesWorld);
    return sendJson(res, 200, { ok: true, ...mapContext });
  }

  if (req.method === 'GET' && url.pathname === '/api/map/settings') {
    if (!worldMapConfig) return sendJson(res, 503, { ok: false, error: 'world_map_disabled' });
    try {
      const r = await fetchWithTimeout(settingsJsonUrl(worldMapConfig.baseUrl), { timeout: 8000 });
      const body = await r.json().catch(() => null);
      if (!r.ok) return sendJson(res, r.status, { ok: false, error: 'upstream', status: r.status });
      return sendJson(res, 200, { ok: true, data: body });
    } catch (e) {
      return sendJson(res, 502, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/map/players') {
    if (!worldMapConfig) return sendJson(res, 503, { ok: false, error: 'world_map_disabled' });
    const hermesWorld = url.searchParams.get('world') || registry.defaultWorld;
    const tileWorld = tileWorldForHermes(worldMapConfig, hermesWorld);
    if (!tileWorld) {
      return sendJson(res, 400, { ok: false, error: 'unknown_world', hermesWorld });
    }
    try {
      const r = await fetchWithTimeout(playersMarkersUrl(worldMapConfig.baseUrl, tileWorld), {
        timeout: 8000,
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) return sendJson(res, r.status, { ok: false, error: 'upstream', status: r.status });
      const names = playerNamesFromMarkersJson(body);
      return sendJson(res, 200, { ok: true, hermesWorld, tileWorld, names, data: body });
    } catch (e) {
      return sendJson(res, 502, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/poi') {
    const world = url.searchParams.get('world') || registry.defaultWorld;
    const pois = await buildPoiForWorld(world);
    return sendJson(res, 200, { world, pois });
  }

  if (req.method === 'GET' && url.pathname === '/api/personal-pois') {
    const world = url.searchParams.get('world') || registry.defaultWorld;
    const pois = await buildPersonalPoisForWorld(world);
    return sendJson(res, 200, { world, pois });
  }

  if (req.method === 'GET' && url.pathname === '/api/regions') {
    const world = url.searchParams.get('world') || registry.defaultWorld;
    const regions = await buildRegionsForWorld(world);
    return sendJson(res, 200, { world, regions });
  }

  if (req.method === 'GET' && url.pathname === '/api/kanban/boards') {
    const data = await fetchBoardsListWithFallback(HERMES_KANBAN_BASE);
    return sendJson(res, 200, data);
  }

  if (req.method === 'GET' && url.pathname === '/api/kanban') {
    const world = url.searchParams.get('world') || registry.defaultWorld;
    const boardParam = url.searchParams.get('board');
    const boardId = boardParam || boardIdForWorld(registry, world);
    const data = await fetchBoardWithFallback(HERMES_KANBAN_BASE, boardId);
    return sendJson(res, 200, { world, boardId, ...data });
  }

  if (req.method === 'POST' && url.pathname === '/api/kanban/dispatch') {
    const world = url.searchParams.get('world') || registry.defaultWorld;
    const boardParam = url.searchParams.get('board');
    const boardId = boardParam || boardIdForWorld(registry, world);
    if (!boardId) {
      return sendJson(res, 400, { ok: false, error: 'no_board_for_world' });
    }
    const dryRun = url.searchParams.get('dry_run') === 'true';
    const args = ['kanban', '--board', boardId, 'dispatch'];
    if (dryRun) args.push('--dry-run');
    try {
      const out = await runHermesCli(args, 120_000);
      return sendJson(res, 200, {
        ok: true,
        boardId,
        dryRun,
        output: out.stdout.slice(-4000),
        stderr: out.stderr.slice(-2000),
      });
    } catch (e) {
      return sendJson(res, 502, {
        ok: false,
        error: 'dispatch_failed',
        message: e instanceof Error ? e.message : String(e),
        boardId,
      });
    }
  }

  const agentRoute = url.pathname.match(/^\/api\/agent\/([^/]+)\/(inventory|goals|cognition)$/);
  if (req.method === 'GET' && agentRoute) {
    const name = decodeURIComponent(agentRoute[1]);
    const sub = agentRoute[2];
    const agent = resolveAgentRecord(name);
    if (!agent) return sendJson(res, 404, { ok: false, error: 'unknown_agent' });

    if (sub === 'inventory') {
      const data = await fetchInventory(agent);
      return sendJson(res, 200, { ok: true, data });
    }
    if (sub === 'goals') {
      const g = await fetchAgentGoals(agent);
      if (!g.ok) {
        return sendJson(res, g.status === 404 ? 404 : 502, {
          ok: false,
          error: 'goals_unavailable',
          status: g.status,
        });
      }
      return sendJson(res, 200, { ok: true, goals: g.goals, context: g.context });
    }
    if (sub === 'cognition') {
      const homes = hermesHomeCandidates(agent);
      const limit = Math.min(80, Math.max(1, Number(url.searchParams.get('limit')) || 24));
      const cursor = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
      const tail = url.searchParams.get('tail') === '1' || url.searchParams.get('tail') === 'true';
      const kindsParam = url.searchParams.get('kinds');
      const kinds = kindsParam
        ? kindsParam.split(',').map((k) => k.trim()).filter(Boolean)
        : undefined;
      const cog = loadCognitionFromHomes(homes, { limit, cursor, tail, kinds });
      const home = cog.hermes_home || homes[0];
      return sendJson(res, 200, {
        agent: name,
        hermes_home: home,
        home_label: home ? hermesHomeLabel(home) : null,
        ...cog,
      });
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return sendFile(res, path.join(__dirname, 'index.html'), mime['.html']);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
    const rel = url.pathname.slice('/static/'.length);
    const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
    const fp = path.join(__dirname, 'static', safe);
    if (!fp.startsWith(path.join(__dirname, 'static'))) {
      res.writeHead(403);
      return res.end();
    }
    const ext = path.extname(fp);
    return sendFile(res, fp, mime[ext] || 'application/octet-stream');
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  const worldQ = STARTUP_WORLD ? `?world=${encodeURIComponent(STARTUP_WORLD)}` : '';
  console.log(`HermesCraft dashboard http://127.0.0.1:${PORT}${worldQ}`);
  console.log(`BOT_HOST=${BOT_HOST}  HERMES_KANBAN_BASE=${HERMES_KANBAN_BASE}`);
  if (STARTUP_WORLD) {
    const names = (registry.worlds || []).map((w) => w.name);
    if (names.includes(STARTUP_WORLD)) {
      console.log(`DASHBOARD_WORLD=${STARTUP_WORLD} (initial selector)`);
    } else {
      console.warn(
        `DASHBOARD_WORLD=${STARTUP_WORLD} not in agent-registry.json worlds — ignored`,
      );
    }
  }
  if (worldMapConfig) {
    console.log(`WORLD_MAP=${worldMapConfig.baseUrl}`);
  }
  const scan = discoveryPortList(registry, { dashboardPort: PORT });
  console.log(
    `BOT_DISCOVERY ports ${scan[0] ?? '—'}–${scan[scan.length - 1] ?? '—'} (${scan.length} probes, excludes dashboard ${PORT})`,
  );
});
