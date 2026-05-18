import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadRegistry, boardIdForWorld } from './lib/registry.js';
import { fetchWithTimeout } from './lib/poll.js';
import { getCachedOpenRouterCredits } from './lib/openrouter.js';
import { fetchBoard } from './lib/kanban.js';

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

function normalizeAgentRow(agent, healthBody, obsBody, err) {
  const connected = healthBody?.connected === true;
  const obsOk = obsBody?.ok === true;
  /** briefState() is null when off-world or not ready — do not coerce to {} */
  const rawState = obsBody?.state;
  const hasLiveBody =
    rawState != null &&
    typeof rawState === 'object' &&
    rawState.position &&
    typeof rawState.position.x === 'number';
  const online = connected && obsOk && hasLiveBody;
  const state = hasLiveBody ? rawState : {};
  const pos = state.position;
  const goals = obsBody?.goals || [];
  const top = goals.find((g) => g && g.satisfied === false) || goals[0] || null;
  const recent = Array.isArray(obsBody?.recent_actions) ? obsBody.recent_actions[0] : null;
  let recentStr = '';
  if (recent) recentStr = `${recent.action || ''} ${recent.status || ''}`.trim();

  return {
    name: agent.name,
    online,
    is_day: obsBody?.is_day ?? null,
    poll_error: err || null,
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
    task: obsBody?.task || null,
    top_goal: top ? { id: top.id, satisfied: Boolean(top.satisfied) } : null,
    recent_action: recentStr || null,
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
  const firstOnline = agents.find((a) => a.online);
  const firstOnlineAgent = firstOnline
    ? registry.agents.find((x) => x.name === firstOnline.name)
    : null;
  if (firstOnlineAgent) {
    const world = firstOnlineAgent.world || registry.defaultWorld;
    const nearby = await fetchNearbyPlayers(firstOnlineAgent);
    const selfName = firstOnlineAgent.name;
    for (const e of nearby) {
      const name = e.type || 'player';
      if (!name || name === selfName) continue;
      humansMap.set(name, {
        name,
        online: true,
        world,
        position: e.position || null,
        human: true,
      });
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

  return {
    tick,
    time: { ticks: null, is_day: dayRow ? dayRow.is_day : null },
    openrouter: {
      balance_usd: openrouter.balance_usd,
      usage_usd: openrouter.usage_usd,
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

  if (req.method === 'GET' && url.pathname.startsWith('/api/agent/') && url.pathname.endsWith('/inventory')) {
    const parts = url.pathname.split('/');
    const name = decodeURIComponent(parts[3] || '');
    const agent = registry.agents.find((a) => a.name === name);
    if (!agent) return sendJson(res, 404, { ok: false, error: 'unknown_agent' });
    const data = await fetchInventory(agent);
    return sendJson(res, 200, { ok: true, data });
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
});
