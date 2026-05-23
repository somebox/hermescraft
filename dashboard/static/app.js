/**
 * HermesCraft dashboard frontend (vanilla ESM).
 */
import { boundsXZ, worldToCanvas } from './map2d.js';
import {
  actionLabel,
  buildChipList,
  buildHumanDetail,
  buildInventoryFull,
  buildKanbanDetail,
  buildPoiDetail,
  collapsibleRaw,
  motionSummary,
  mountPlayerDetailShell,
  patchDetailHero,
  patchGoalsBody,
  patchRecentActionsHost,
  patchReactiveHost,
  prettyItemName,
} from './detail-view.js';
import { patchAgentLiveStrip } from './agent-live-strip.js';

const LS_WORLD = 'hc_dashboard_world';
const LS_SEL = 'hc_dashboard_selection';
const LS_TAB = 'hc_dashboard_tab';
const LS_MAP_SUB = 'hc_dashboard_map_sub';
const LS_CHAT_SUB = 'hc_dashboard_chat_sub';

const LANES = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived'];

let worlds = [];
let fleet = null;
let pois = [];
let kanbanData = { tasks: [], grouped: null, ok: false };
/** @type {{ cx: number, cy: number, r: number, kind: string, id: string, label: string }[]} */
let mapHitTargets = [];

/** Last FPV iframe URL we applied — avoids resetting `src` every fleet poll (full reload + viewer spam). */
let fpvLoadedUrl = '';

/** Last terrain map iframe URL (same stability as FPV). */
let terrainLoadedUrl = '';

/** From GET /api/map/config — null when disabled. */
let worldMapConfig = null;

/** Last detail panel selection key — same player: update inner block only so radar iframe is not recreated every poll. */
let prevDetailKey = null;

/** Throttle full inventory fetch while same agent selected. */
let lastInvFetch = { agent: null, at: 0 };

/** Throttle goals fetch while same agent selected. */
let lastGoalsFetch = { agent: null, at: 0, goals: null };

/** Cached goals for detail panel when fetch fails. */
let cachedGoalsList = [];

/** Mind panel: poll only while Mind tab + selected agent online. */
let mindPollTimer = null;
const MIND_POLL_MS = 5000;
const MIND_TAIL_LIMIT = 8;

function loadJson(key, fallback) {
  try {
    const t = localStorage.getItem(key);
    return t ? JSON.parse(t) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

let state = {
  world: loadJson(LS_WORLD, null) || 'world',
  selection: loadJson(LS_SEL, null),
  centerTab: loadJson(LS_TAB, 'map') || 'map',
  mapSub: loadJson(LS_MAP_SUB, 'tactical') || 'tactical',
  chatSub: loadJson(LS_CHAT_SUB, 'ingame') || 'ingame',
};

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setTab(name) {
  state.centerTab = name;
  saveJson(LS_TAB, name);
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    const on = p.id === `panel-${name}`;
    p.classList.toggle('active', on);
    p.hidden = !on;
  });
  if (name === 'fpv') refreshFpv();
  if (name === 'map' && state.mapSub === 'terrain') refreshTerrainMap();
}

function buildTerrainIframeUrl(cfg, hermesWorld) {
  const tileWorld = cfg.hermesToTileWorld?.[hermesWorld];
  if (!tileWorld) return null;
  const zoom = cfg.iframeDefaults?.zoom ?? 4;
  const u = new URL('/', cfg.baseUrl);
  u.searchParams.set('world', tileWorld);
  u.searchParams.set('zoom', String(zoom));
  return u.toString();
}

function applyWorldMapUi() {
  const nav = document.getElementById('mapSubtabs');
  if (!nav) return;
  const enabled = Boolean(worldMapConfig?.enabled);
  nav.hidden = !enabled;
  if (!enabled && state.mapSub === 'terrain') {
    state.mapSub = 'tactical';
    saveJson(LS_MAP_SUB, state.mapSub);
  }
  setMapSubTab(state.mapSub, { skipSave: true });
}

function setMapSubTab(name, opts = {}) {
  if (!worldMapConfig?.enabled && name === 'terrain') name = 'tactical';
  state.mapSub = name;
  if (!opts.skipSave) saveJson(LS_MAP_SUB, name);
  document.querySelectorAll('.map-subtab').forEach((b) => {
    const on = b.dataset.mapSub === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const tactical = document.getElementById('mapPanelTactical');
  const terrain = document.getElementById('mapPanelTerrain');
  if (tactical) tactical.hidden = name !== 'tactical';
  if (terrain) terrain.hidden = name !== 'terrain';
  if (name === 'tactical' && state.centerTab === 'map') renderMap();
  if (name === 'terrain') refreshTerrainMap();
}

function refreshTerrainMap() {
  const frame = document.getElementById('terrainFrame');
  const link = document.getElementById('terrainOpenLink');
  if (!frame || !worldMapConfig?.enabled) return;
  const next = buildTerrainIframeUrl(worldMapConfig, state.world);
  if (link) {
    if (next) {
      link.href = next;
      link.classList.remove('disabled');
    } else {
      link.href = '#';
      link.classList.add('disabled');
    }
  }
  if (!next) {
    terrainLoadedUrl = '';
    frame.removeAttribute('src');
    return;
  }
  if (terrainLoadedUrl !== next) {
    terrainLoadedUrl = next;
    frame.src = next;
  }
}

async function fetchMapConfig() {
  try {
    const r = await fetch('/api/map/config');
    const j = await r.json();
    worldMapConfig = j.enabled ? j : null;
  } catch {
    worldMapConfig = null;
  }
  applyWorldMapUi();
}

function agentsInWorld() {
  if (!fleet?.agents) return [];
  return fleet.agents.filter((a) => a.online && a.world === state.world);
}

function humansInWorld() {
  if (!fleet?.humans) return [];
  return fleet.humans.filter((h) => h.world === state.world);
}

async function fetchWorlds() {
  const r = await fetch('/api/worlds');
  const j = await r.json();
  worlds = j.worlds || [];
  const sel = $('worldSelect');
  sel.replaceChildren();
  for (const w of worlds) {
    const o = document.createElement('option');
    o.value = w.name;
    o.textContent = w.name;
    sel.appendChild(o);
  }
  if (!worlds.some((w) => w.name === state.world)) {
    state.world = worlds[0]?.name || 'world';
  }
  sel.value = state.world;
}

async function fetchFleet() {
  const r = await fetch('/api/fleet');
  fleet = await r.json();
  renderHeader();
  renderAgentList();
  renderHumanList();
  renderDetail();
  if (state.chatSub === 'mind') syncMindPanel();
  else renderChat();
  if (state.centerTab === 'map') {
    if (state.mapSub === 'terrain' && worldMapConfig?.enabled) {
      refreshTerrainMap();
    } else {
      await fetchPoi();
      renderMap();
    }
  }
  if (state.centerTab === 'fpv') refreshFpv();
}

async function fetchPoi() {
  const r = await fetch(`/api/poi?world=${encodeURIComponent(state.world)}`);
  const j = await r.json();
  pois = j.pois || [];
}

async function fetchKanban() {
  const r = await fetch(`/api/kanban?world=${encodeURIComponent(state.world)}`);
  kanbanData = await r.json();
  const st = $('kanbanStatus');
  if (!kanbanData.ok) {
    st.textContent = kanbanData.error
      ? `Kanban: ${kanbanData.error}`
      : 'Kanban unavailable (is Hermes Kanban Bridge running?)';
  } else {
    st.textContent = kanbanData.boardId ? `Board: ${kanbanData.boardId}` : '';
  }
  renderKanban();
  renderDetail();
}

function renderHeader() {
  const or = fleet?.openrouter || {};
  const bal = or.balance_usd;
  const use = or.usage_usd;
  const daily = or.usage_daily_usd;
  const monthly = or.usage_monthly_usd;
  const balEl = $('openrouterBal');
  const useEl = $('openrouterUse');
  balEl.textContent = bal == null ? '$ —' : `$${Number(bal).toFixed(2)} left`;
  let useText = 'use —';
  if (use != null) {
    useText = daily != null ? `day $${Number(daily).toFixed(2)}` : `use $${Number(use).toFixed(2)}`;
    if (monthly != null) useText += ` · mo $${Number(monthly).toFixed(2)}`;
  }
  useEl.textContent = useText;
  balEl.title =
    or.label != null
      ? `OpenRouter key: ${or.label} · limit remaining (GET /api/v1/key)`
      : 'OpenRouter limit remaining (GET /api/v1/key)';
  useEl.title =
    use != null
      ? `Total usage $${Number(use).toFixed(2)} on this key`
      : 'OpenRouter usage for this API key';

  const day = fleet?.time?.is_day;
  const ticks = fleet?.time?.ticks;
  const dn = $('dayNight');
  if (day === true) {
    dn.textContent = ticks != null ? `☀ ${formatMcClockHeader(ticks)}` : '☀ day';
    dn.className = 'badge ok';
  } else if (day === false) {
    dn.textContent = ticks != null ? `☽ ${formatMcClockHeader(ticks)}` : '☽ night';
    dn.className = 'badge warn';
  } else {
    dn.textContent = '—';
    dn.className = 'badge off';
  }

  const all = fleet?.agents?.length || 0;
  const onCount = fleet?.agents?.filter((x) => x.online).length || 0;
  $('liveCount').textContent = `live ${onCount}/${all}`;
}

function renderAgentList() {
  const host = $('agentList');
  host.replaceChildren();
  const list = agentsInWorld();
  for (const a of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-card';
    if (state.selection?.kind === 'player' && state.selection.id === a.name) {
      btn.classList.add('selected');
    }
    const hFrac = Math.min(1, (a.health || 0) / 20);
    const fFrac = Math.min(1, (a.food || 0) / 20);
    const task = a.task;
    const taskLine = task
      ? `${actionLabel(task.action)} ${task.status || ''}`.trim()
      : 'idle';
    const moveLine = a.online ? motionSummary(a) : 'offline';

    btn.appendChild(el('div', 'name', a.name));
    btn.appendChild(el('div', 'row2', `${moveLine} · ${taskLine}`));
    const hb = el('div', 'stat-bar', null);
    const hi = document.createElement('i');
    hi.style.width = `${Math.round(hFrac * 100)}%`;
    hb.appendChild(hi);
    btn.appendChild(hb);
    const fb = el('div', 'stat-bar food', null);
    const fi = document.createElement('i');
    fi.style.width = `${Math.round(fFrac * 100)}%`;
    fb.appendChild(fi);
    btn.appendChild(fb);

    btn.addEventListener('click', () => {
      state.selection = { kind: 'player', id: a.name };
      saveJson(LS_SEL, state.selection);
      renderAgentList();
      renderHumanList();
      renderDetail();
      if (state.centerTab === 'fpv') refreshFpv();
      if (state.centerTab === 'map') renderMap();
    });
    host.appendChild(btn);
  }
  if (!list.length) {
    host.appendChild(el('p', 'muted', 'No online agents in this world.'));
  }
}

function botNameSet() {
  return new Set((fleet?.agents || []).map((a) => String(a.name).toLowerCase()));
}

function renderHumanList() {
  const host = document.getElementById('humanList');
  if (!host) return;
  host.replaceChildren();
  const bots = botNameSet();
  const list = humansInWorld()
    .filter((h) => h.name && !bots.has(String(h.name).toLowerCase()))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!list.length) {
    host.appendChild(el('p', 'muted human-list-empty', 'No players in this world.'));
    return;
  }
  for (const h of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'human-sidebar-card';
    if (state.selection?.kind === 'human' && state.selection.id === h.name) {
      btn.classList.add('selected');
    }
    btn.appendChild(el('span', 'human-sidebar-name', h.name));
    btn.addEventListener('click', () => {
      state.selection = { kind: 'human', id: h.name };
      saveJson(LS_SEL, state.selection);
      renderHumanList();
      renderAgentList();
      renderDetail();
      if (state.centerTab === 'map') renderMap();
    });
    host.appendChild(btn);
  }
}

function renderAgentLiveStrip() {
  const host = document.getElementById('agentLiveStrip');
  if (!host) return;
  const sel = state.selection;
  if (sel?.kind === 'player') {
    const a = fleet?.agents?.find((x) => x.name === sel.id);
    host.classList.remove('muted');
    patchAgentLiveStrip(host, a || null);
    return;
  }
  host.classList.add('muted');
  host.dataset.liveKey = '';
  host.replaceChildren(
    el('p', 'muted live-empty', sel ? 'Live strip is for agents only.' : 'Select an agent to see live status.'),
  );
}

async function renderDetail() {
  renderAgentLiveStrip();
  const panel = $('detailPanel');
  const sel = state.selection;
  const key = sel ? `${sel.kind}:${sel.id}` : '';

  if (key !== prevDetailKey) {
    prevDetailKey = key;
    panel.replaceChildren();
    lastInvFetch = { agent: null, at: 0 };
    lastGoalsFetch = { agent: null, at: 0, goals: null };
    cachedGoalsList = [];
    if (state.chatSub === 'mind') syncMindPanel(true);
  }

  if (!sel) {
    panel.className = 'detail-panel muted';
    if (!panel.firstChild) {
      panel.appendChild(
        document.createTextNode('Select an agent, map marker, or kanban card.'),
      );
    }
    return;
  }
  if (sel.kind === 'player') {
    const a = fleet?.agents?.find((x) => x.name === sel.id);
    panel.className = 'detail-panel';
    if (!a) {
      panel.replaceChildren();
      panel.appendChild(document.createTextNode('Agent not in fleet.'));
      return;
    }

    let main = panel.querySelector('#detailPlayerMain');
    if (!main) {
      panel.replaceChildren();
      main = document.createElement('div');
      main.id = 'detailPlayerMain';
      panel.appendChild(main);
      mountPlayerDetailShell(main);
      const metricsRoot = main.querySelector('#detailMetrics');
      if (metricsRoot) metricsRoot.appendChild(buildPlayerMetrics(a));
    }

    const hero = main.querySelector('#detailHero');
    if (hero) {
      patchDetailHero(hero, a.name, {
        online: a.online,
        model: a.model || null,
        world: a.world || null,
      });
    }
    updatePlayerMetrics(main.querySelector('#detailMetrics'), a);

    const recentActionsSlot = main.querySelector('#detailRecentActionsSlot');
    if (recentActionsSlot) patchRecentActionsHost(recentActionsSlot, a.recent_actions);
    const reactiveSlot = main.querySelector('#detailReactiveSlot');
    if (reactiveSlot) patchReactiveHost(reactiveSlot, a.auto_action_log);

    const goalsBody = main.querySelector('#detailGoalsBody');
    if (goalsBody) {
      if (cachedGoalsList.length) patchGoalsBody(goalsBody, cachedGoalsList);
      else if (!goalsBody.dataset.goalsKey) {
        goalsBody.replaceChildren(el('p', 'detail-muted', a.online ? 'Loading goals…' : '—'));
      }
      if (a.online) refreshAgentGoals(a.name);
    }

    patchInvLive(main.querySelector('#detailInvLive'), a.inventory_summary);

    const invFull = main.querySelector('#invFull');
    if (invFull && !a.online && !invFull.dataset.cleared) {
      invFull.dataset.cleared = '1';
      invFull.replaceChildren(el('p', 'detail-muted', '—'));
    } else if (invFull && a.online) {
      invFull.dataset.cleared = '';
    }

    const rawDet = main.querySelector('#detailRawObserve');
    if (rawDet) {
      const pre = rawDet.querySelector('pre');
      if (pre) {
        const rawPayload = {
          task: a.task,
          top_goal: a.top_goal,
          telemetry: {
            time_ticks: a.time_ticks,
            last_death_age_s: a.last_death_age_s,
            motion_speed_bps: a.motion_speed_bps,
            motion_idle_sec: a.motion_idle_sec,
            idle_reason: a.idle_reason,
          },
        };
        const rawStr = JSON.stringify(rawPayload, null, 2);
        if (pre.textContent !== rawStr) pre.textContent = rawStr;
      }
    }

    const host = fleet?._meta?.bot_host || '127.0.0.1';
    const radarUrl = a.radar_port ? `http://${host}:${a.radar_port}/` : null;
    let radarFrame = panel.querySelector('#agentRadarFrame');
    if (!radarUrl) {
      radarFrame?.remove();
    } else {
      if (!radarFrame) {
        radarFrame = document.createElement('iframe');
        radarFrame.id = 'agentRadarFrame';
        radarFrame.className = 'radar-mini';
        panel.appendChild(radarFrame);
      }
      radarFrame.title = `Radar ${a.name}`;
      if (radarFrame.src !== radarUrl) {
        radarFrame.src = radarUrl;
      }
    }

    if (a.online) {
      const invAgent = a.name;
      const now = Date.now();
      const needInv =
        lastInvFetch.agent !== invAgent || now - lastInvFetch.at > 12_000;
      if (needInv) {
        lastInvFetch = { agent: invAgent, at: now };
        fetch(`/api/agent/${encodeURIComponent(invAgent)}/inventory`)
          .then((r) => r.json())
          .then((j) => {
            if (state.selection?.kind !== 'player' || state.selection.id !== invAgent) return;
            const elFull = document.getElementById('invFull');
            if (!elFull) return;
            elFull.replaceChildren(buildInventoryFull(j?.data ?? j));
          })
          .catch(() => {
            const elFull = document.getElementById('invFull');
            if (elFull) {
              elFull.replaceChildren(el('p', 'detail-task-error', 'Inventory fetch failed'));
            }
          });
      }
    } else {
      lastInvFetch = { agent: null, at: 0 };
    }
    return;
  }
  if (sel.kind === 'human') {
    panel.replaceChildren();
    const hu = fleet?.humans?.find((x) => x.name === sel.id);
    panel.className = 'detail-panel';
    if (!hu) {
      panel.appendChild(document.createTextNode('Human not in fleet snapshot.'));
      return;
    }
    panel.appendChild(buildHumanDetail(hu));
    return;
  }
  if (sel.kind === 'poi') {
    panel.replaceChildren();
    const p = pois.find((x) => poiKey(x) === sel.id);
    panel.className = 'detail-panel';
    if (!p) {
      panel.appendChild(document.createTextNode('POI not found.'));
      return;
    }
    panel.appendChild(buildPoiDetail(p));
    return;
  }
  if (sel.kind === 'task') {
    panel.replaceChildren();
    const t = (kanbanData.tasks || []).find((x) => x.id === sel.id);
    panel.className = 'detail-panel';
    if (!t) {
      panel.appendChild(document.createTextNode('Task not loaded; open Kanban tab.'));
      return;
    }
    panel.appendChild(buildKanbanDetail(t));
  }
}

function poiKey(p) {
  return `${p.world}|${p.name}|${Math.round(p.x)}|${Math.round(p.y)}|${Math.round(p.z)}`;
}

function formatMcClockHeader(ticks) {
  const t = Math.floor(Number(ticks)) % 24000;
  const h = Math.floor((t / 1000 + 6) % 24);
  const m = Math.floor(((t % 1000) * 60) / 1000);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function formatSessionDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function buildPlayerMetrics(a) {
  const wrap = el('div', 'player-metrics');

  const ses = el('div', 'metric metric-session');
  ses.appendChild(el('span', 'metric-label', 'In-game session'));
  const sesVal = el('span', 'metric-value metric-session-value', '');
  sesVal.id = 'metricSessionVal';
  ses.appendChild(sesVal);

  wrap.appendChild(ses);
  updatePlayerMetrics(wrap, a);
  return wrap;
}

function updatePlayerMetrics(root, a) {
  if (!root) return;
  const sesVal = root.querySelector('#metricSessionVal');
  if (sesVal) {
    let sessionText = '—';
    if (a.online) {
      const dur = formatSessionDuration(a.session_uptime_sec);
      if (a.session_started_at_ms != null) {
        const clock = new Date(a.session_started_at_ms).toLocaleTimeString(undefined, {
          timeStyle: 'short',
        });
        sessionText = `${dur} · since ${clock}`;
      } else {
        sessionText = dur;
      }
    }
    sesVal.textContent = sessionText;
  }
}

function patchInvLive(host, summary) {
  const key = JSON.stringify(summary || {});
  if (host.dataset.invKey === key) return;
  host.dataset.invKey = key;
  host.replaceChildren(buildChipList(summary));
}

function refreshAgentGoals(agentName) {
  const now = Date.now();
  if (lastGoalsFetch.agent === agentName && now - lastGoalsFetch.at < 8000) {
    const goalsBody = document.getElementById('detailGoalsBody');
    if (goalsBody && lastGoalsFetch.goals) patchGoalsBody(goalsBody, lastGoalsFetch.goals);
    return;
  }
  fetch(`/api/agent/${encodeURIComponent(agentName)}/goals`)
    .then((r) => r.json())
    .then((j) => {
      if (state.selection?.kind !== 'player' || state.selection.id !== agentName) return;
      if (j.ok && Array.isArray(j.goals)) {
        cachedGoalsList = j.goals;
        lastGoalsFetch = { agent: agentName, at: Date.now(), goals: j.goals };
        const goalsBody = document.getElementById('detailGoalsBody');
        if (goalsBody) patchGoalsBody(goalsBody, j.goals);
      }
    })
    .catch(() => {});
}

function setChatSubTab(name) {
  state.chatSub = name;
  saveJson(LS_CHAT_SUB, name);
  document.querySelectorAll('.chat-subtab').forEach((b) => {
    const on = b.dataset.chatSub === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const ingame = $('chatBody');
  const mind = document.getElementById('mindBody');
  if (ingame) ingame.hidden = name !== 'ingame';
  if (mind) mind.hidden = name !== 'mind';
  if (name === 'ingame') renderChat();
  if (name === 'mind') {
    syncMindPanel(true);
    startMindPoll();
  } else {
    stopMindPoll();
  }
}

function clearMindPanel() {
  const mind = document.getElementById('mindBody');
  if (!mind) return;
  mind.replaceChildren();
  mind.dataset.mindKey = '';
  mind.scrollTop = 0;
}

function stopMindPoll() {
  if (mindPollTimer != null) {
    clearInterval(mindPollTimer);
    mindPollTimer = null;
  }
}

function startMindPoll() {
  stopMindPoll();
  mindPollTimer = setInterval(() => {
    if (state.chatSub !== 'mind') {
      stopMindPoll();
      return;
    }
    syncMindPanel(false);
  }, MIND_POLL_MS);
}

/** @returns {boolean} whether Mind should show content for current selection */
function mindSelectionActive() {
  if (!fleet?.agents?.some((a) => a.online)) return false;
  const sel = state.selection;
  if (sel?.kind !== 'player') return false;
  const a = fleet.agents.find((x) => x.name === sel.id);
  return Boolean(a?.online);
}

function syncMindPanel(force) {
  const mind = document.getElementById('mindBody');
  if (!mind || state.chatSub !== 'mind') return;
  if (!mindSelectionActive()) {
    clearMindPanel();
    return;
  }
  refreshMindFeed(Boolean(force));
}

function renderChat() {
  const body = $('chatBody');
  if (!body || state.chatSub !== 'ingame') return;
  body.replaceChildren();
  const lines = fleet?.chat || [];
  const filtered = lines.filter((c) => c.world === state.world).slice(-30);
  for (const c of filtered) {
    const div = el('div', 'chat-line', null);
    const wtag = c.world ? `[${c.world.slice(0, 3)}] ` : '';
    div.textContent = `${wtag}${c.from}: ${c.message}`;
    body.appendChild(div);
  }
}

function appendMindTurn(container, turn) {
  const line = el('div', `cog-line cog-${turn.kind}`, null);
  if (turn.kind === 'think') {
    line.textContent = `think: ${turn.text}`;
  } else if (turn.kind === 'say') {
    line.textContent = `asst: ${turn.text}`;
  } else if (turn.kind === 'tool') {
    line.textContent = `${turn.toolName || 'tool'}: ${turn.text}`;
  } else if (turn.kind === 'tool_result') {
    line.classList.add(turn.isError ? 'cog-err' : 'cog-out');
    line.textContent = `${turn.isError ? 'ERR' : 'out'} → ${turn.text}`;
  } else {
    line.textContent = turn.text || '';
  }
  const key = turn.turnKey || `${turn.index}:${turn.kind}`;
  line.dataset.turnKey = key;
  container.appendChild(line);
}

function ensureMindSessionHeader(mind, agentName, sessionFile) {
  let head = mind.querySelector('.mind-session-head');
  if (!head) {
    head = el('div', 'mind-session-head muted', '');
    mind.prepend(head);
  }
  head.textContent = sessionFile
    ? `${agentName} · ${sessionFile}`
    : `${agentName} · (no session)`;
}

function refreshMindFeed(force) {
  const mind = document.getElementById('mindBody');
  if (!mind || state.chatSub !== 'mind' || !mindSelectionActive()) {
    clearMindPanel();
    return;
  }
  const agentName = state.selection.id;
  const url = `/api/agent/${encodeURIComponent(agentName)}/cognition?tail=1&limit=${MIND_TAIL_LIMIT}`;
  fetch(url)
    .then((r) => r.json())
    .then((j) => {
      if (state.chatSub !== 'mind' || !mindSelectionActive()) {
        clearMindPanel();
        return;
      }
      if (state.selection?.id !== agentName) return;
      if (!j.ok) {
        clearMindPanel();
        return;
      }
      const contentKey = `${agentName}|${j.session || ''}|${JSON.stringify(j.turns || [])}`;
      if (!force && mind.dataset.mindKey === contentKey) return;
      mind.dataset.mindKey = contentKey;
      mind.replaceChildren();
      if (!j.turns?.length) return;
      ensureMindSessionHeader(mind, agentName, j.session);
      for (const t of j.turns) appendMindTurn(mind, t);
    })
    .catch(() => {
      if (force) clearMindPanel();
    });
}

function renderKanban() {
  const host = $('kanbanBoard');
  host.replaceChildren();
  const g = kanbanData.grouped;
  if (!g) return;
  for (const lane of LANES) {
    const cards = g[lane] || [];
    const col = el('div', 'kanban-col', null);
    col.appendChild(el('h4', null, lane));
    for (const c of cards) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kanban-card';
      if (state.selection?.kind === 'task' && state.selection.id === c.id) b.classList.add('selected');
      b.textContent = c.title;
      b.addEventListener('click', () => {
        state.selection = { kind: 'task', id: c.id };
        saveJson(LS_SEL, state.selection);
        renderKanban();
        renderDetail();
      });
      col.appendChild(b);
    }
    host.appendChild(col);
  }
}

/** Size backing store for sharp rendering; CSS size follows container. */
function syncMapCanvasSize() {
  const canvas = $('mapCanvas');
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.25);
  const cssW = Math.max(260, Math.floor(wrap.clientWidth));
  const cssH = Math.max(200, Math.round((cssW * 400) / 640));
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
}

/** @returns {{ cw: number, ch: number, dpr: number }} logical (CSS) pixel size */
function mapBeginFrame(ctx, canvas) {
  const cssW = parseFloat(canvas.style.width) || canvas.clientWidth || 640;
  const cssH = parseFloat(canvas.style.height) || canvas.clientHeight || 400;
  const dpr = canvas.width / cssW;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cw: cssW, ch: cssH, dpr };
}

function drawMapGrid(ctx, b, cw, ch) {
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 8);
  const step = span > 500 ? 64 : span > 180 ? 32 : span > 80 ? 16 : 8;
  ctx.save();
  ctx.strokeStyle = 'rgba(139, 148, 158, 0.14)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  const minX = Math.floor(b.minX / step) * step;
  const maxX = Math.ceil(b.maxX / step) * step;
  const minZ = Math.floor(b.minZ / step) * step;
  const maxZ = Math.ceil(b.maxZ / step) * step;
  for (let x = minX; x <= maxX; x += step) {
    const p0 = worldToCanvas(x, b.minZ, b, cw, ch);
    const p1 = worldToCanvas(x, b.maxZ, b, cw, ch);
    ctx.beginPath();
    ctx.moveTo(p0.cx, p0.cy);
    ctx.lineTo(p1.cx, p1.cy);
    ctx.stroke();
  }
  for (let z = minZ; z <= maxZ; z += step) {
    const p0 = worldToCanvas(b.minX, z, b, cw, ch);
    const p1 = worldToCanvas(b.maxX, z, b, cw, ch);
    ctx.beginPath();
    ctx.moveTo(p0.cx, p0.cy);
    ctx.lineTo(p1.cx, p1.cy);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function fillDiamond(ctx, cx, cy, r, fillStyle) {
  ctx.save();
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawMapLabel(ctx, text, cx, cy, dy) {
  const t = String(text).slice(0, 15);
  ctx.save();
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(13, 17, 23, 0.92)';
  ctx.fillStyle = 'rgba(230, 237, 243, 0.96)';
  const y = cy + dy;
  ctx.strokeText(t, cx, y);
  ctx.fillText(t, cx, y);
  ctx.restore();
}

function mapIsSelected(kind, id) {
  const s = state.selection;
  return s?.kind === kind && s.id === id;
}

function renderMap() {
  syncMapCanvasSize();
  const canvas = $('mapCanvas');
  const ctx = canvas.getContext('2d');
  const { cw, ch } = mapBeginFrame(ctx, canvas);

  const root = getComputedStyle(document.documentElement);
  const bg = root.getPropertyValue('--bg').trim() || '#0d1117';
  const borderCol = root.getPropertyValue('--border').trim() || '#30363d';
  const accent = root.getPropertyValue('--accent').trim() || '#58a6ff';
  const good = root.getPropertyValue('--good').trim() || '#3fb950';
  const warn = root.getPropertyValue('--warn').trim() || '#d29922';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cw, ch);

  const points = [];
  for (const a of agentsInWorld()) {
    if (a.position) points.push({ x: a.position.x, z: a.position.z });
  }
  for (const hum of humansInWorld()) {
    if (hum.position) points.push({ x: hum.position.x, z: hum.position.z });
  }
  for (const p of pois) {
    points.push({ x: p.x, z: p.z });
  }

  const b = boundsXZ(points);
  mapHitTargets = [];

  drawMapGrid(ctx, b, cw, ch);

  ctx.strokeStyle = borderCol;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, cw - 1, ch - 1);

  for (const p of pois) {
    const { cx, cy } = worldToCanvas(p.x, p.z, b, cw, ch);
    const rr = 5;
    const id = poiKey(p);
    const sel = mapIsSelected('poi', id);
    fillDiamond(ctx, cx, cy, rr, warn);
    if (sel) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rr + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    mapHitTargets.push({ cx, cy, r: 10, kind: 'poi', id, label: p.name });
    drawMapLabel(ctx, p.name || 'POI', cx, cy, rr + 10);
  }

  for (const hum of humansInWorld()) {
    if (!hum.position) continue;
    const { cx, cy } = worldToCanvas(hum.position.x, hum.position.z, b, cw, ch);
    const r = 6;
    ctx.fillStyle = '#8b949e';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    if (mapIsSelected('human', hum.name)) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    mapHitTargets.push({ cx, cy, r: 11, kind: 'human', id: hum.name, label: hum.name });
    drawMapLabel(ctx, hum.name, cx, cy, r + 10);
  }

  for (const a of agentsInWorld()) {
    if (!a.position) continue;
    const { cx, cy } = worldToCanvas(a.position.x, a.position.z, b, cw, ch);
    const r = 7;
    ctx.fillStyle = good;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    const sel = mapIsSelected('player', a.name);
    ctx.strokeStyle = sel ? accent : 'rgba(0,0,0,0.35)';
    ctx.lineWidth = sel ? 2.5 : 1;
    ctx.stroke();
    mapHitTargets.push({ cx, cy, r: 12, kind: 'player', id: a.name, label: a.name });
    drawMapLabel(ctx, a.name, cx, cy, r + 11);
  }

  const spanX = b.maxX - b.minX;
  const spanZ = b.maxZ - b.minZ;
  const stepHint =
    spanX > 500 || spanZ > 500 ? '64' : spanX > 180 || spanZ > 180 ? '32' : spanX > 80 || spanZ > 80 ? '16' : '8';
  const meta = document.getElementById('mapMeta');
  if (meta) {
    meta.textContent = `~${spanX.toFixed(0)} × ${spanZ.toFixed(0)} blocks · grid ${stepHint}`;
  }
}

function canvasClick(ev) {
  const canvas = $('mapCanvas');
  const rect = canvas.getBoundingClientRect();
  const cssW = parseFloat(canvas.style.width) || rect.width;
  const cssH = parseFloat(canvas.style.height) || rect.height;
  const sx = ((ev.clientX - rect.left) / rect.width) * cssW;
  const sy = ((ev.clientY - rect.top) / rect.height) * cssH;
  let best = null;
  let bestD = Infinity;
  for (const t of mapHitTargets) {
    const d = Math.hypot(sx - t.cx, sy - t.cy);
    if (d <= t.r && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  if (!best) return;
  state.selection = { kind: best.kind, id: best.id };
  saveJson(LS_SEL, state.selection);
  renderAgentList();
  renderHumanList();
  renderDetail();
  if (state.centerTab === 'map') renderMap();
}

function refreshFpv() {
  const ph = $('fpvPlaceholder');
  const frame = $('fpvFrame');
  const sel = state.selection;
  const ag =
    sel?.kind === 'player' ? fleet?.agents?.find((x) => x.name === sel.id) : null;
  const botHost = fleet?._meta?.bot_host || '127.0.0.1';
  if (ag?.viewer_port && sel?.kind === 'player') {
    const next = `http://${botHost}:${ag.viewer_port}/`;
    if (
      fpvLoadedUrl === next &&
      frame.classList.contains('visible') &&
      ph.style.display === 'none'
    ) {
      return;
    }
    ph.style.display = 'none';
    frame.classList.add('visible');
    if (fpvLoadedUrl !== next) {
      fpvLoadedUrl = next;
      frame.src = next;
    }
  } else {
    fpvLoadedUrl = '';
    frame.classList.remove('visible');
    frame.removeAttribute('src');
    ph.style.display = 'block';
    ph.textContent = ag
      ? 'No viewer_port for this agent (set VIEWER_PORT when starting the bot).'
      : 'Select an agent to view FPV.';
  }
}

function bindUi() {
  $('worldSelect').addEventListener('change', (e) => {
    state.world = e.target.value;
    saveJson(LS_WORLD, state.world);
    state.selection = null;
    saveJson(LS_SEL, null);
    renderAgentList();
    renderHumanList();
    renderDetail();
    if (state.centerTab === 'map') {
      if (state.mapSub === 'terrain') refreshTerrainMap();
      else fetchPoi().then(renderMap);
    }
    if (state.centerTab === 'kanban') fetchKanban();
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTab(btn.dataset.tab);
      if (btn.dataset.tab === 'kanban') fetchKanban();
      if (btn.dataset.tab === 'map') {
        if (state.mapSub === 'terrain') refreshTerrainMap();
        else fetchPoi().then(renderMap);
      }
    });
  });

  document.querySelectorAll('.map-subtab').forEach((btn) => {
    btn.addEventListener('click', () => setMapSubTab(btn.dataset.mapSub));
  });

  document.querySelectorAll('.chat-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      setChatSubTab(btn.dataset.chatSub);
      if (btn.dataset.chatSub === 'mind') {
        syncMindPanel(true);
        startMindPoll();
      } else stopMindPoll();
    });
  });

  $('mapCanvas').addEventListener('click', canvasClick);

  $('chatToggle').addEventListener('click', () => {
    const ingame = $('chatBody');
    const mind = document.getElementById('mindBody');
    const active = state.chatSub === 'mind' ? mind : ingame;
    const open = active && active.style.display !== 'none' && !active.hidden;
    const next = open ? 'none' : 'block';
    if (ingame && state.chatSub === 'ingame') ingame.style.display = next;
    if (mind && state.chatSub === 'mind') {
      mind.style.display = next;
      mind.hidden = false;
    }
    $('chatToggle').setAttribute('aria-expanded', open ? 'false' : 'true');
  });

  setChatSubTab(state.chatSub);
  if (state.chatSub === 'mind') startMindPoll();
  setTab(state.centerTab);
}

async function main() {
  bindUi();
  await fetchMapConfig();
  await fetchWorlds();
  await fetchFleet();
  setInterval(fetchFleet, 2000);
  setInterval(fetchWorlds, 30_000);
  setInterval(() => {
    if (state.centerTab === 'kanban') fetchKanban();
  }, 5000);
  window.addEventListener('resize', () => {
    if (state.centerTab === 'map' && state.mapSub === 'tactical') renderMap();
  });
}

main().catch((e) => console.error(e));
