/**
 * HermesCraft dashboard frontend (vanilla ESM).
 */
import { boundsXZ, worldToCanvas } from './map2d.js';

const LS_WORLD = 'hc_dashboard_world';
const LS_SEL = 'hc_dashboard_selection';
const LS_TAB = 'hc_dashboard_tab';

const LANES = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived'];

let worlds = [];
let fleet = null;
let pois = [];
let kanbanData = { tasks: [], grouped: null, ok: false };
/** @type {{ cx: number, cy: number, r: number, kind: string, id: string, label: string }[]} */
let mapHitTargets = [];

/** Last FPV iframe URL we applied — avoids resetting `src` every fleet poll (full reload + viewer spam). */
let fpvLoadedUrl = '';

/** Last detail panel selection key — same player: update inner block only so radar iframe is not recreated every poll. */
let prevDetailKey = null;

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

function dlRow(dtText, ddNode) {
  const dt = el('dt', null, dtText);
  const dd = document.createElement('dd');
  if (typeof ddNode === 'string') dd.textContent = ddNode;
  else dd.appendChild(ddNode);
  return [dt, dd];
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
  renderDetail();
  renderChat();
  if (state.centerTab === 'map') {
    await fetchPoi();
    renderMap();
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
  const bal = fleet?.openrouter?.balance_usd;
  const use = fleet?.openrouter?.usage_usd;
  $('openrouterBal').textContent = bal == null ? '$ —' : `$${Number(bal).toFixed(2)}`;
  $('openrouterUse').textContent = use == null ? 'use —' : `use $${Number(use).toFixed(2)}`;

  const day = fleet?.time?.is_day;
  const dn = $('dayNight');
  if (day === true) {
    dn.textContent = '☀ day';
    dn.className = 'badge ok';
  } else if (day === false) {
    dn.textContent = '☽ night';
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
    const taskLine = task ? `${task.action || 'task'} ${task.status || ''}`.trim() : 'idle';

    btn.appendChild(el('div', 'name', a.name));
    btn.appendChild(el('div', 'row2', `${a.holding || 'empty'} · ${taskLine}`));
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

async function renderDetail() {
  const panel = $('detailPanel');
  const sel = state.selection;
  const key = sel ? `${sel.kind}:${sel.id}` : '';

  if (key !== prevDetailKey) {
    prevDetailKey = key;
    panel.replaceChildren();
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
    }
    main.replaceChildren();

    main.appendChild(buildPlayerMetrics(a));

    const dl = document.createElement('dl');
    const tg = a.top_goal;
    const frag = document.createDocumentFragment();

    const nameDd = document.createElement('dd');
    const strong = document.createElement('strong');
    strong.textContent = a.name;
    nameDd.appendChild(strong);
    if (!a.online) nameDd.appendChild(document.createTextNode(' (offline)'));
    dl.append(...dlRow('Agent', nameDd));
    dl.append(...dlRow('Model', a.model || '—'));
    dl.append(...dlRow('World', a.world || '—'));
    const posStr = a.position
      ? `${a.position.x.toFixed(1)}, ${a.position.y.toFixed(1)}, ${a.position.z.toFixed(1)}`
      : '—';
    dl.append(...dlRow('Position', posStr));
    const taskPre = el('code', null, JSON.stringify(a.task || null));
    dl.append(...dlRow('Task', taskPre));
    dl.append(...dlRow('Top goal', tg ? tg.id : '—'));
    dl.append(...dlRow('Recent', a.recent_action || '—'));

    const invOb = el('dd', 'inventory-summary', formatInv(a.inventory_summary));
    dl.append(...dlRow('Inventory (observe)', invOb));

    const invFull = document.createElement('dd');
    invFull.id = 'invFull';
    if (a.online) invFull.textContent = 'Loading inventory…';
    else invFull.textContent = '—';
    dl.append(...dlRow('Inventory (full)', invFull));

    frag.appendChild(dl);
    main.appendChild(frag);

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
      fetch(`/api/agent/${encodeURIComponent(a.name)}/inventory`)
        .then((r) => r.json())
        .then((j) => {
          const elFull = document.getElementById('invFull');
          if (!elFull) return;
          const pre = document.createElement('pre');
          pre.className = 'inventory-summary';
          try {
            if (j?.data?.items) {
              pre.textContent = JSON.stringify(j.data.items).slice(0, 4000);
            } else {
              pre.textContent = JSON.stringify(j?.data ?? j).slice(0, 2000);
            }
          } catch {
            elFull.textContent = 'inventory parse error';
          }
          elFull.replaceChildren(pre);
        })
        .catch(() => {
          const elFull = document.getElementById('invFull');
          if (elFull) elFull.textContent = 'inventory fetch failed';
        });
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
    const dl = document.createElement('dl');
    const nameDd = document.createElement('dd');
    const s = document.createElement('strong');
    s.textContent = hu.name;
    nameDd.appendChild(s);
    dl.append(...dlRow('Player', nameDd));
    dl.append(...dlRow('World', hu.world || '—'));
    const posStr = hu.position
      ? `${Number(hu.position.x).toFixed(1)}, ${Number(hu.position.y).toFixed(1)}, ${Number(hu.position.z).toFixed(1)}`
      : '—';
    dl.append(...dlRow('Position', posStr));
    panel.appendChild(dl);
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
    const dl = document.createElement('dl');
    const nameDd = document.createElement('dd');
    const s = document.createElement('strong');
    s.textContent = p.name;
    nameDd.appendChild(s);
    dl.append(...dlRow('POI', nameDd));
    dl.append(...dlRow('World', p.world));
    dl.append(...dlRow('Position', `${p.x}, ${p.y}, ${p.z}`));
    dl.append(...dlRow('Note', p.note || '—'));
    dl.append(...dlRow('Last visited by', p.last_visited_by || '—'));
    panel.appendChild(dl);
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
    const dl = document.createElement('dl');
    const titleDd = document.createElement('dd');
    const st = document.createElement('strong');
    st.textContent = t.title;
    titleDd.appendChild(st);
    dl.append(...dlRow('Task', titleDd));
    dl.append(...dlRow('Lane', `${t.status} (${t.column || ''})`));
    const idCode = el('code', null, t.id);
    dl.append(...dlRow('Id', idCode));
    panel.appendChild(dl);
    panel.appendChild(
      el(
        'p',
        'muted',
        'Comments: read-only in v1. Use Hermes / Obsidian for full card body and timeline.'
      )
    );
    const pre = document.createElement('pre');
    pre.className = 'inventory-summary';
    try {
      pre.textContent = JSON.stringify(t.raw || t, null, 2).slice(0, 6000);
    } catch {
      pre.textContent = String(t);
    }
    panel.appendChild(pre);
  }
}

function poiKey(p) {
  return `${p.world}|${p.name}|${Math.round(p.x)}|${Math.round(p.y)}|${Math.round(p.z)}`;
}

function formatInv(summary) {
  if (!summary || typeof summary !== 'object') return '—';
  const parts = Object.entries(summary)
    .slice(0, 24)
    .map(([k, v]) => `${k}×${v}`);
  return parts.join(', ') || '—';
}

function prettyItemName(holding) {
  if (holding == null || holding === '' || holding === 'empty') return '—';
  const s = String(holding);
  const i = s.lastIndexOf(':');
  const raw = i >= 0 ? s.slice(i + 1) : s;
  return raw.replace(/_/g, ' ');
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

  const eq = el('div', 'metric metric-equip');
  eq.appendChild(el('span', 'metric-label', 'Equipped'));
  const equipVal = el('span', 'metric-value equip-name', prettyItemName(a.holding));
  if (a.holding && a.holding !== 'empty') equipVal.title = String(a.holding);
  eq.appendChild(equipVal);

  const row = el('div', 'metric-row');

  const hp = el('div', 'metric metric-hp');
  hp.appendChild(el('span', 'metric-label', 'Health'));
  const hFrac = Math.min(1, (a.health || 0) / 20);
  const hb = el('div', 'metric-bar', null);
  const hi = document.createElement('i');
  hi.style.width = `${Math.round(hFrac * 100)}%`;
  hb.appendChild(hi);
  hp.appendChild(hb);
  hp.appendChild(el('span', 'metric-num', `${Math.round(Number(a.health) || 0)}/20`));

  const fd = el('div', 'metric metric-food');
  fd.appendChild(el('span', 'metric-label', 'Food'));
  const fFrac = Math.min(1, (a.food || 0) / 20);
  const fbar = el('div', 'metric-bar food', null);
  const fi = document.createElement('i');
  fi.style.width = `${Math.round(fFrac * 100)}%`;
  fbar.appendChild(fi);
  fd.appendChild(fbar);
  fd.appendChild(el('span', 'metric-num', `${Math.round(Number(a.food) || 0)}/20`));

  row.appendChild(hp);
  row.appendChild(fd);

  const ses = el('div', 'metric metric-session');
  ses.appendChild(el('span', 'metric-label', 'In-game session'));
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
  ses.appendChild(el('span', 'metric-value metric-session-value', sessionText));

  wrap.appendChild(eq);
  wrap.appendChild(row);
  wrap.appendChild(ses);
  return wrap;
}

function renderChat() {
  const body = $('chatBody');
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
    renderDetail();
    if (state.centerTab === 'map') fetchPoi().then(renderMap);
    if (state.centerTab === 'kanban') fetchKanban();
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTab(btn.dataset.tab);
      if (btn.dataset.tab === 'kanban') fetchKanban();
      if (btn.dataset.tab === 'map') fetchPoi().then(renderMap);
    });
  });

  $('mapCanvas').addEventListener('click', canvasClick);

  $('chatToggle').addEventListener('click', () => {
    const body = $('chatBody');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    $('chatToggle').setAttribute('aria-expanded', open ? 'false' : 'true');
  });

  setTab(state.centerTab);
}

async function main() {
  bindUi();
  await fetchWorlds();
  await fetchFleet();
  setInterval(fetchFleet, 2000);
  setInterval(fetchWorlds, 30_000);
  setInterval(() => {
    if (state.centerTab === 'kanban') fetchKanban();
  }, 5000);
  window.addEventListener('resize', () => {
    if (state.centerTab === 'map') renderMap();
  });
}

main().catch((e) => console.error(e));
