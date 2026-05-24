/**
 * HermesCraft dashboard frontend (vanilla ESM).
 */
import {
  actionLabel,
  buildChipList,
  buildHumanDetail,
  buildInventoryFull,
  buildKanbanDetail,
  buildPoiDetail,
  collapsibleRaw,
  detailSection,
  motionSummary,
  mountPlayerDetailShell,
  patchDetailHero,
  patchGoalsBody,
  patchRecentActionsHost,
  patchReactiveHost,
  patchAgentKanbanHost,
  prettyItemName,
} from './detail-view.js';
import { patchAgentLiveStrip } from './agent-live-strip.js';
import { pickAgentKanbanTask } from './kanban-agent.js';
import { appendMindTurn, ensureMindSessionHeader, renderMindEmpty } from './cognition-view.js';

const LS_WORLD = 'hc_dashboard_world';
const LS_SEL = 'hc_dashboard_selection';
const LS_TAB = 'hc_dashboard_tab';
const LS_CHAT_SUB = 'hc_dashboard_chat_sub';
const LS_KANBAN_BOARD = 'hc_dashboard_kanban_board';

const LANES = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived'];

let worlds = [];
let fleet = null;
let pois = [];
let regions = [];
let kanbanData = { tasks: [], grouped: null, ok: false };

/** Last FPV iframe URL we applied — avoids resetting `src` every fleet poll (full reload + viewer spam). */
let fpvLoadedUrl = '';

/** Last terrain map iframe URL (same stability as FPV). */
let terrainLoadedUrl = '';

/** Squaremap player names for current world (merged into Players sidebar). */
let mapPlayersForWorld = [];

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
const MIND_TAIL_LIMIT = 24;

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

let kanbanBoardIdsByWorld = {};
let defaultKanbanBoardId = null;
/** @type {{ id?: string, title?: string, name?: string, slug?: string, path?: string }[]} */
let kanbanBoardsList = [];

let state = {
  world: loadJson(LS_WORLD, null) || 'world',
  selection: loadJson(LS_SEL, null),
  centerTab: loadJson(LS_TAB, 'map') || 'map',
  chatSub: loadJson(LS_CHAT_SUB, 'ingame') || 'ingame',
  kanbanBoard: loadJson(LS_KANBAN_BOARD, null),
};

const CENTER_TABS = new Set(['map', 'fpv', 'kanban']);
if (!CENTER_TABS.has(state.centerTab)) state.centerTab = 'map';

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
  if (name === 'fpv') requestAnimationFrame(() => refreshFpv());
  if (name === 'map') requestAnimationFrame(() => refreshTerrainMap());
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
  const terrain = document.getElementById('mapPanelTerrain');
  const unavailable = document.getElementById('mapUnavailable');
  const enabled = Boolean(worldMapConfig?.enabled);
  if (terrain) terrain.hidden = !enabled;
  if (unavailable) unavailable.hidden = enabled;
  if (enabled && state.centerTab === 'map') refreshTerrainMap();
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

async function refreshMapPlayerNames() {
  mapPlayersForWorld = [];
  if (!worldMapConfig?.enabled) return;
  try {
    const r = await fetch(`/api/map/players?world=${encodeURIComponent(state.world)}`);
    const j = await r.json();
    if (j.ok && Array.isArray(j.names)) mapPlayersForWorld = j.names;
  } catch {
    mapPlayersForWorld = [];
  }
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
  kanbanBoardIdsByWorld = j.kanbanBoardIdsByWorld || {};
  defaultKanbanBoardId = j.defaultKanbanBoardId || null;
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
  syncKanbanBoardSelect();
}

function resolveKanbanBoardId() {
  if (state.kanbanBoard) return state.kanbanBoard;
  return kanbanBoardIdsByWorld[state.world] || defaultKanbanBoardId || null;
}

function syncKanbanBoardSelect() {
  const sel = document.getElementById('kanbanBoardSelect');
  if (!sel) return;
  const current = resolveKanbanBoardId();
  sel.replaceChildren();
  const seen = new Set();
  const add = (id, label) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const o = document.createElement('option');
    o.value = id;
    o.textContent = label;
    sel.appendChild(o);
  };
  if (current) add(current, `${current} (this world)`);
  for (const b of kanbanBoardsList) {
    const id = b.id || b.slug || b.path;
    if (!id) continue;
    add(id, b.title || b.name || id);
  }
  if (current && seen.has(current)) sel.value = current;
  else if (state.kanbanBoard && seen.has(state.kanbanBoard)) sel.value = state.kanbanBoard;
}

async function loadKanbanBoardsList() {
  try {
    const r = await fetch('/api/kanban/boards');
    const j = await r.json();
    if (j.ok) kanbanBoardsList = j.boards || [];
  } catch {
    kanbanBoardsList = [];
  }
  syncKanbanBoardSelect();
}

async function fetchKanban() {
  const board = resolveKanbanBoardId();
  const q = new URLSearchParams({ world: state.world });
  if (board) q.set('board', board);
  const r = await fetch(`/api/kanban?${q}`);
  kanbanData = await r.json();
  const st = $('kanbanStatus');
  if (!kanbanData.ok) {
    const err = kanbanData.error || 'unknown';
    if (err === 'no_board_for_world') {
      st.textContent =
        'No board mapped for this world — set kanbanBoardIdsByWorld / defaultKanbanBoardId in agent-registry.json.';
    } else if (String(err).startsWith('kanban_http')) {
      st.textContent =
        'Kanban bridge unreachable — using local hermes CLI if available (HERMES_KANBAN_BASE :27124).';
    } else if (err === 'kanban_cli_err') {
      st.textContent = `Kanban CLI failed: ${kanbanData.message || 'is hermes on PATH?'}`;
    } else {
      st.textContent = `Kanban: ${err}`;
    }
  } else {
    const n = kanbanData.tasks?.length ?? 0;
    const base = fleet?._meta?.kanban_base || 'bridge';
    const src = kanbanData.source === 'cli' ? 'hermes CLI' : base;
    st.textContent = `${kanbanData.boardId || board || 'board'} · ${n} cards · ${src}`;
  }
  renderKanban();
  renderDetail();
}

async function nudgeKanbanDispatch() {
  const board = resolveKanbanBoardId();
  const st = $('kanbanStatus');
  st.textContent = 'Running dispatch…';
  const q = new URLSearchParams({ world: state.world });
  if (board) q.set('board', board);
  try {
    const r = await fetch(`/api/kanban/dispatch?${q}`, { method: 'POST' });
    const j = await r.json();
    if (j.ok) {
      st.textContent = `Dispatch ok · ${board || 'board'}`;
      await fetchKanban();
    } else {
      st.textContent = j.message || j.error || 'Dispatch failed (is hermes on PATH?)';
    }
  } catch (e) {
    st.textContent = e instanceof Error ? e.message : 'Dispatch failed';
  }
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
  if (state.centerTab === 'map') refreshTerrainMap();
  if (state.centerTab === 'fpv') refreshFpv();
  await refreshMapPlayerNames();
  renderHumanList();
}

async function fetchPoi() {
  const worldQ = encodeURIComponent(state.world);
  const [poiRes, regRes] = await Promise.all([
    fetch(`/api/poi?world=${worldQ}`),
    fetch(`/api/regions?world=${worldQ}`),
  ]);
  const j = await poiRes.json();
  pois = j.pois || [];
  const rj = await regRes.json().catch(() => ({}));
  regions = rj.regions || [];
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
    });
    host.appendChild(btn);
  }
  if (!list.length) {
    host.appendChild(el('p', 'muted', 'No online agents in this world.'));
  }
}

function botNameSet() {
  const set = new Set();
  for (const a of fleet?.agents || []) {
    if (a.name) set.add(String(a.name).toLowerCase());
    if (a.mc_username) set.add(String(a.mc_username).toLowerCase());
  }
  return set;
}

function isSidebarPlayerName(name) {
  const n = String(name || '').trim().toLowerCase();
  return n && n !== 'player' && n !== 'unknown';
}

function renderHumanList() {
  const host = document.getElementById('humanList');
  if (!host) return;
  host.replaceChildren();
  const bots = botNameSet();
  const byKey = new Map();
  for (const h of humansInWorld()) {
    if (!isSidebarPlayerName(h.name) || bots.has(String(h.name).toLowerCase())) continue;
    byKey.set(String(h.name).toLowerCase(), h);
  }
  for (const name of mapPlayersForWorld) {
    if (!isSidebarPlayerName(name) || bots.has(String(name).toLowerCase())) continue;
    const key = String(name).toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, { name, online: true, world: state.world, human: true });
    }
  }
  const list = [...byKey.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
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
    } else if (!main.querySelector('#detailKanbanBody')) {
      const goalsSec = main.querySelector('#detailGoalsBody')?.closest('.detail-section');
      const kanbanBody = el('div', 'detail-section-body');
      kanbanBody.id = 'detailKanbanBody';
      const sec = detailSection('Kanban', kanbanBody);
      if (goalsSec?.nextSibling) main.insertBefore(sec, goalsSec.nextSibling);
      else main.appendChild(sec);
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

    const kanbanBody = main.querySelector('#detailKanbanBody');
    if (kanbanBody) {
      const boardId = resolveKanbanBoardId();
      const card = pickAgentKanbanTask(kanbanData.tasks || [], a.name);
      patchAgentKanbanHost(kanbanBody, card, {
        kanbanOk: kanbanData.ok,
        boardId,
        onOpen: (t) => {
          state.selection = { kind: 'task', id: t.id };
          saveJson(LS_SEL, state.selection);
          setTab('kanban');
          fetchKanban();
          renderAgentList();
          renderHumanList();
          renderKanban();
          renderDetail();
        },
      });
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
    if (state.chatSub === 'ingame') renderChat();
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
  renderMindEmpty(mind, 'Select an online agent to tail Hermes session (like watch-agent.py).');
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
  const sel = state.selection;
  const ag =
    sel?.kind === 'player' ? fleet?.agents?.find((x) => x.name === sel.id) : null;

  /** @type {{ from: string, message: string, world?: string, source?: string }[]} */
  const rows = [];

  if (ag?.online && Array.isArray(ag.new_chat)) {
    for (const line of ag.new_chat) {
      rows.push({
        from: line.from || '?',
        message: line.message || line.text || '',
        world: ag.world,
        source: 'heard',
      });
    }
  }

  const global = (fleet?.chat || []).filter((c) => c.world === state.world);
  for (const c of global) {
    if (ag && c.agent && c.agent !== ag.name) continue;
    rows.push({
      from: c.from,
      message: c.message,
      world: c.world,
      source: c.agent === ag?.name ? 'nearby' : 'world',
    });
  }

  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const k = `${r.from}|${r.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  const slice = deduped.slice(-40);
  if (!slice.length) {
    body.appendChild(
      el(
        'p',
        'chat-empty muted',
        ag?.online
          ? 'No recent chat for this agent (mc read_chat / in-world messages).'
          : 'Select an online agent for their chat tail.',
      ),
    );
    return;
  }

  for (const c of slice) {
    const div = el('div', 'chat-line', null);
    if (c.source === 'heard') div.classList.add('chat-heard');
    const wtag = c.world ? `[${c.world.slice(0, 3)}] ` : '';
    div.textContent = `${wtag}${c.from}: ${c.message}`;
    body.appendChild(div);
  }
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
        renderMindEmpty(mind, j.error === 'no_session' ? 'No Hermes session yet for this agent.' : 'Mind feed unavailable.');
        return;
      }
      const contentKey = `${agentName}|${j.session || ''}|${j.home_label || ''}|${JSON.stringify(j.turns || [])}`;
      if (!force && mind.dataset.mindKey === contentKey) return;
      mind.dataset.mindKey = contentKey;
      mind.replaceChildren();
      if (!j.turns?.length) {
        renderMindEmpty(mind, 'Session empty — waiting for Hermes turns…');
        return;
      }
      ensureMindSessionHeader(mind, agentName, j.session, j.home_label);
      for (const t of j.turns) appendMindTurn(mind, t);
    })
    .catch(() => {
      if (force) clearMindPanel();
    });
}

function renderKanban() {
  const host = $('kanbanBoard');
  host.replaceChildren();
  if (!kanbanData.ok) {
    host.appendChild(
      el('p', 'muted', 'No board data — see status line below (bridge or hermes CLI).'),
    );
    return;
  }
  const g = kanbanData.grouped;
  if (!g) return;
  for (const lane of LANES) {
    const cards = g[lane] || [];
    const col = el('div', 'kanban-col', null);
    col.appendChild(el('h4', null, `${lane} (${cards.length})`));
    for (const c of cards) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kanban-card';
      if (state.selection?.kind === 'task' && state.selection.id === c.id) b.classList.add('selected');
      b.appendChild(el('span', 'kanban-card-title', c.title));
      if (c.assignee) {
        b.appendChild(el('span', 'kanban-card-meta', c.assignee));
      }
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

function bindCenterUpperResize() {
  const upper = document.querySelector('.center-upper');
  if (!upper || typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => {
    if (state.centerTab === 'fpv') refreshFpv();
  });
  ro.observe(upper);
}

function resolveFpvPort(ag) {
  if (!ag) return null;
  if (ag.viewer_port != null && Number(ag.viewer_port) > 0) return Number(ag.viewer_port);
  if (ag.api_port != null) return Number(ag.api_port) + 1000;
  return null;
}

function refreshFpv() {
  const ph = $('fpvPlaceholder');
  const frame = $('fpvFrame');
  const sel = state.selection;
  const ag =
    sel?.kind === 'player' ? fleet?.agents?.find((x) => x.name === sel.id) : null;
  const botHost = fleet?._meta?.bot_host || '127.0.0.1';
  const link = document.getElementById('fpvOpenLink');

  const port = resolveFpvPort(ag);
  if (port && sel?.kind === 'player' && ag?.online) {
    const next = `http://${botHost}:${port}/`;
    if (link) {
      link.href = next;
      link.textContent = `Open FPV in new tab (${botHost}:${port})`;
      link.hidden = false;
    }

    if (ag.viewer_active === false) {
      ph.style.display = 'block';
      ph.textContent = `No viewer reported on /health — if FPV is blank, restart bot with VIEWER_PORT=${port}.`;
    } else {
      ph.style.display = 'none';
    }

    if (
      fpvLoadedUrl === next &&
      frame.classList.contains('visible') &&
      ph.style.display === 'none'
    ) {
      return;
    }
    frame.classList.add('visible');
    if (fpvLoadedUrl !== next) {
      fpvLoadedUrl = next;
      frame.src = next;
    }
  } else {
    fpvLoadedUrl = '';
    frame.classList.remove('visible');
    frame.removeAttribute('src');
    if (link) link.hidden = true;
    ph.style.display = 'block';
    if (!ag || sel?.kind !== 'player') {
      ph.textContent = 'Select an online agent, then open FPV.';
    } else if (!ag.online) {
      ph.textContent = `${ag.name} is offline — FPV follows the running bot process.`;
    } else {
      ph.textContent = 'No viewer port for this agent (set VIEWER_PORT when starting the bot).';
    }
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
    fetchPoi();
    refreshMapPlayerNames().then(() => renderHumanList());
    if (state.centerTab === 'map') refreshTerrainMap();
    if (state.centerTab === 'kanban') fetchKanban();
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTab(btn.dataset.tab);
      if (btn.dataset.tab === 'kanban') fetchKanban();
      if (btn.dataset.tab === 'map') refreshTerrainMap();
    });
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

  const kanbanSel = document.getElementById('kanbanBoardSelect');
  if (kanbanSel) {
    kanbanSel.addEventListener('change', () => {
      state.kanbanBoard = kanbanSel.value || null;
      saveJson(LS_KANBAN_BOARD, state.kanbanBoard);
      fetchKanban();
    });
  }
  const kanbanRefresh = document.getElementById('kanbanRefresh');
  if (kanbanRefresh) kanbanRefresh.addEventListener('click', () => fetchKanban());
  const kanbanDispatch = document.getElementById('kanbanDispatch');
  if (kanbanDispatch) kanbanDispatch.addEventListener('click', () => nudgeKanbanDispatch());

  setChatSubTab(state.chatSub);
  if (state.chatSub === 'mind') startMindPoll();
  setTab(state.centerTab);
}

async function main() {
  bindUi();
  bindCenterUpperResize();
  await fetchMapConfig();
  await refreshMapPlayerNames();
  await fetchWorlds();
  await loadKanbanBoardsList();
  await fetchFleet();
  await fetchPoi();
  await fetchKanban();
  setInterval(fetchFleet, 2000);
  setInterval(fetchWorlds, 30_000);
  setInterval(() => {
    fetchKanban();
  }, 8000);
  window.addEventListener('resize', () => {
    if (state.centerTab === 'fpv') refreshFpv();
  });
}

main().catch((e) => console.error(e));
