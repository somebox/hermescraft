import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadRegistry, boardIdForWorld } from './lib/registry.js';
import { fetchWithTimeout } from './lib/poll.js';
import { getCachedOpenRouterCredits } from './lib/openrouter.js';
import { updateAgentMotion } from './lib/motion.js';
import { fetchBoard } from './lib/kanban.js';
import {
  getWorldMapConfig,
  tileWorldForHermes,
  settingsJsonUrl,
  playerNamesFromMarkersJson,
  playersMarkersUrl,
} from './lib/world-map.js';
import { resolveHermesHome } from './lib/agent-paths.js';
import { loadCognitionFromHome } from './lib/cognition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const BOT_HOST = process.env.BOT_HOST || '127.0.0.1';
const HERMES_KANBAN_BASE = process.env.HERMES_KANBAN_BASE || 'http://127.0.0.1:27124';

const registry = loadRegistry(REPO_ROOT);
if (!registry) {
  console.error('Missing data/agent-registry.json');
  process.exit(1);
}

const worldMapConfig = getWorldMapConfig(registry);

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

function normalizeAgentRow(agent, healthBody, obsBody, err) {
  const connected = healthBody?.connected === true;
  const mcUsername =
    healthBody?.username != null ? String(healthBody.username).trim() : null;
  const identityOk =
    !connected ||
    !mcUsername ||
    mcUsername.toLowerCase() === String(agent.name || '').toLowerCase();
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
  const motion = updateAgentMotion(agent.name, pos && typeof pos.x === 'number' ? pos : null);
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
    name: agent.name,
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
    model: agent.model || null,
    api_port: agent.api_port,
    viewer_port: agent.viewer_port ?? null,
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

async function fetchMarks(agent) {
  const url = botUrl(agent.api_port, '/marks');
  const r = await fetchWithTimeout(url, { timeout: 8000 }).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => null);
  const marks = j?.data?.marks;
  return Array.isArray(marks) ? marks : [];
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
  try {
    const r = await fetchWithTimeout(playersMarkersUrl(worldMapConfig.baseUrl, tileWorld), {
      timeout: 5000,
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body) return [];
    return playerNamesFromMarkersJson(body);
  } catch {
    return [];
  }
}

async function fetchNearbyPlayers(agent) {
  const url = botUrl(agent.api_port, '/nearby?radius=48');
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

async function buildFleetSnapshot() {
  tick += 1;
  const agents = await Promise.all(registry.agents.map((a) => pollAgent(a)));
  const openrouter = await getCachedOpenRouterCredits(REPO_ROOT);

  /** @type {{ name: string, online: boolean, world: string, position: any, human: boolean }[]} */
  const humansMap = new Map();
  const onlinePairs = agents
    .filter((a) => a.online)
    .map((a) => ({ row: a, reg: registry.agents.find((x) => x.name === a.name) }))
    .filter((p) => p.reg);
  await Promise.all(
    onlinePairs.map(async ({ row, reg }) => {
      const world = row.world || reg.world || registry.defaultWorld;
      const nearby = await fetchNearbyPlayers(reg);
      for (const e of nearby) {
        const name = e.type || 'player';
        if (!name || name === reg.name) continue;
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

  const botNames = new Set(registry.agents.map((a) => String(a.name).toLowerCase()));
  const worldsForPlayers = new Set([registry.defaultWorld]);
  for (const a of agents) {
    if (a.world) worldsForPlayers.add(a.world);
  }
  for (const w of worldsForPlayers) {
    const mapNames = await fetchMapPlayerNames(w);
    for (const name of mapNames) {
      if (!name || botNames.has(name.toLowerCase())) continue;
      if (!humansMap.has(name)) {
        humansMap.set(name, {
          name,
          online: true,
          world: w,
          position: null,
          human: true,
        });
      }
    }
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
    const w = agent.world || registry.defaultWorld;
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
    const agents = snap.agents.map(({ new_chat, ...rest }) => rest);
    const out = { ...snap, agents };
    return sendJson(res, 200, out);
  }

  if (req.method === 'GET' && url.pathname === '/api/worlds') {
    return sendJson(res, 200, { worlds: registry.worlds || [] });
  }

  if (req.method === 'GET' && url.pathname === '/api/map/config') {
    if (!worldMapConfig) {
      return sendJson(res, 200, { ok: false, enabled: false });
    }
    return sendJson(res, 200, {
      ok: true,
      enabled: true,
      baseUrl: worldMapConfig.baseUrl,
      hermesToTileWorld: worldMapConfig.hermesToTileWorld,
      iframeDefaults: worldMapConfig.iframeDefaults,
      tile: worldMapConfig.tile,
    });
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
      return sendJson(res, 200, { ok: true, hermesWorld, tileWorld, data: body });
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

  if (req.method === 'GET' && url.pathname === '/api/kanban') {
    const world = url.searchParams.get('world') || registry.defaultWorld;
    const boardId = boardIdForWorld(registry, world);
    const data = await fetchBoard(HERMES_KANBAN_BASE, boardId);
    return sendJson(res, 200, { world, boardId, ...data });
  }

  const agentRoute = url.pathname.match(/^\/api\/agent\/([^/]+)\/(inventory|goals|cognition)$/);
  if (req.method === 'GET' && agentRoute) {
    const name = decodeURIComponent(agentRoute[1]);
    const sub = agentRoute[2];
    const agent = registry.agents.find((a) => a.name === name);
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
      const home = resolveHermesHome(agent);
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 15));
      const cursor = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
      const tail = url.searchParams.get('tail') === '1' || url.searchParams.get('tail') === 'true';
      const cog = loadCognitionFromHome(home, { limit, cursor, tail });
      return sendJson(res, 200, { agent: name, hermes_home: home, ...cog });
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
  console.log(`HermesCraft dashboard http://127.0.0.1:${PORT}`);
  console.log(`BOT_HOST=${BOT_HOST}  HERMES_KANBAN_BASE=${HERMES_KANBAN_BASE}`);
  if (worldMapConfig) {
    console.log(`WORLD_MAP=${worldMapConfig.baseUrl}`);
  }
});
