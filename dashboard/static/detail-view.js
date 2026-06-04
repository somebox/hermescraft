/**
 * Structured right-panel detail UI (no raw JSON dumps by default).
 */
import {
  goalBarDisplay,
  sortGoalsByUrgency,
  strategyChipsForDisplay,
} from './goals-format.js';

export function prettyItemName(id) {
  if (id == null || id === '' || id === 'empty') return '—';
  const s = String(id);
  const i = s.lastIndexOf(':');
  const raw = i >= 0 ? s.slice(i + 1) : s;
  return raw.replace(/_/g, ' ');
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function badge(text, variant = 'muted') {
  const s = el('span', `detail-badge detail-badge-${variant}`, text);
  return s;
}

export function detailSection(title, bodyNode) {
  const sec = el('section', 'detail-section');
  sec.appendChild(el('h3', 'detail-section-title', title));
  const body = el('div', 'detail-section-body');
  if (typeof bodyNode === 'string') body.textContent = bodyNode;
  else body.appendChild(bodyNode);
  sec.appendChild(body);
  return sec;
}

export function collapsibleRaw(label, data) {
  const det = document.createElement('details');
  det.className = 'detail-raw';
  const sum = document.createElement('summary');
  sum.textContent = label;
  det.appendChild(sum);
  const pre = document.createElement('pre');
  pre.className = 'detail-raw-pre';
  try {
    pre.textContent = JSON.stringify(data, null, 2).slice(0, 8000);
  } catch {
    pre.textContent = String(data);
  }
  det.appendChild(pre);
  return det;
}

export function buildDetailHero(name, opts = {}) {
  const hero = el('div', 'detail-hero');
  const h = el('h2', 'detail-hero-name', name);
  hero.appendChild(h);
  if (opts.subtitle) hero.appendChild(el('p', 'detail-muted', opts.subtitle));
  const row = el('div', 'detail-hero-badges');
  if (opts.online === true) row.appendChild(badge('Online', 'ok'));
  else if (opts.online === false) row.appendChild(badge('Offline', 'off'));
  if (opts.model) row.appendChild(badge(opts.model, 'model'));
  if (opts.world) row.appendChild(badge(opts.world, 'world'));
  hero.appendChild(row);
  return hero;
}

export function buildPositionLine(pos) {
  if (!pos || typeof pos.x !== 'number') return el('p', 'detail-muted', '—');
  const p = el('p', 'detail-coords', null);
  p.textContent = `${pos.x.toFixed(1)}  ${pos.y.toFixed(1)}  ${pos.z.toFixed(1)}`;
  p.title = 'X · Y · Z';
  return p;
}

function taskStatusVariant(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'done' || s === 'completed') return 'done';
  if (s === 'failed' || s === 'error') return 'err';
  return 'muted';
}

/** Human-readable action name (avoids [object Object]). */
export function actionLabel(action) {
  if (action == null || action === '') return 'task';
  if (typeof action === 'string') return action;
  if (typeof action === 'object') {
    const n = action.name || action.action || action.type || action.verb;
    if (typeof n === 'string') return n;
  }
  return 'task';
}

/** One-line summary of task result / error payloads. */
export function formatOutcome(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value.trim().slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const raw =
      value.result ??
      value.message ??
      value.summary ??
      value.error ??
      (typeof value.ok === 'boolean' ? (value.ok ? 'ok' : 'failed') : null);
    if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 500);
    if (raw != null && typeof raw !== 'object') return String(raw).slice(0, 500);
    try {
      const s = JSON.stringify(value);
      return s.length > 400 ? `${s.slice(0, 397)}…` : s;
    } catch {
      return null;
    }
  }
  return String(value).slice(0, 500);
}

/** Format last mc action history row or legacy string. */
export function formatRecentAction(recent) {
  if (recent == null) return null;
  if (typeof recent === 'string') {
    const t = recent.trim();
    return t && !t.includes('[object Object]') ? t : null;
  }
  if (typeof recent !== 'object') return String(recent);
  const act = actionLabel(recent.action);
  const st = recent.status ? String(recent.status) : '';
  const detail =
    typeof recent.detail === 'string'
      ? recent.detail
      : formatOutcome(recent.detail);
  let line = [act, st].filter(Boolean).join(' · ');
  if (detail) line = line ? `${line} — ${detail}` : detail;
  if (recent.reason) line += ` (${recent.reason})`;
  return line || null;
}

function formatProgress(progress) {
  if (!progress || typeof progress !== 'object') return null;
  const parts = [];
  for (const [k, v] of Object.entries(progress)) {
    if (v == null) continue;
    if (typeof v === 'object') continue;
    parts.push(`${k}: ${v}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

export function buildTaskCard(task) {
  const card = el('div', 'detail-task-card');
  if (!task) {
    card.appendChild(el('p', 'detail-muted', 'Idle — no active task'));
    return card;
  }
  const head = el('div', 'detail-task-head');
  head.appendChild(el('span', 'detail-task-action', actionLabel(task.action)));
  head.appendChild(badge(String(task.status || 'unknown'), taskStatusVariant(task.status)));
  card.appendChild(head);

  const meta = el('div', 'detail-task-meta');
  const parts = [];
  if (task.elapsed_s != null) parts.push(`${task.elapsed_s}s elapsed`);
  else if (typeof task.elapsed === 'string') parts.push(task.elapsed);
  if (task.lease_remaining_s != null) parts.push(`lease ${task.lease_remaining_s}s`);
  if (task.needs_checkpoint) parts.push('checkpoint due');
  if (task.parent_goal_id) parts.push(`goal ${task.parent_goal_id}`);
  const prog = formatProgress(task.progress);
  if (prog) parts.push(prog);
  if (parts.length) meta.textContent = parts.join(' · ');
  else if (task.id) meta.textContent = `id ${task.id}`;
  if (meta.textContent) card.appendChild(meta);

  const errText = formatOutcome(task.error);
  if (errText) {
    card.appendChild(el('p', 'detail-task-error', errText));
  }
  const resText = formatOutcome(task.result);
  if (resText) {
    card.appendChild(el('p', 'detail-task-result', resText));
  }
  return card;
}

/** Right-panel summary of assignee's active Hermes kanban card. */
export function patchAgentKanbanHost(host, task, opts = {}) {
  if (!host) return;
  const key = task
    ? `${task.id}|${task.status}|${task.title}`
    : `empty|${opts.kanbanOk}|${opts.boardId || ''}`;
  if (host.dataset.kanbanKey === key) return;
  host.dataset.kanbanKey = key;
  host.replaceChildren();
  if (!opts.kanbanOk) {
    host.appendChild(
      el(
        'p',
        'detail-muted',
        'Kanban not loaded — open Kanban tab or check hermes / bridge.',
      ),
    );
    return;
  }
  if (!task) {
    host.appendChild(
      el('p', 'detail-muted', `No card assigned to this agent on ${opts.boardId || 'board'}.`),
    );
    return;
  }
  const card = el('div', 'detail-agent-kanban-card');
  const head = el('div', 'detail-task-head');
  head.appendChild(el('span', 'detail-task-action', task.title || task.id));
  head.appendChild(badge(String(task.status || task.column || 'card'), taskStatusVariant(task.status)));
  card.appendChild(head);
  const meta = el('p', 'detail-muted detail-agent-kanban-meta', `${task.id}${task.assignee ? ` · ${task.assignee}` : ''}`);
  card.appendChild(meta);
  if (typeof opts.onOpen === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'detail-kanban-open';
    btn.textContent = 'Show full card';
    btn.addEventListener('click', () => opts.onOpen(task));
    card.appendChild(btn);
  }
  host.appendChild(card);
}

export function buildGoalRow(topGoal) {
  const row = el('div', 'detail-goal-row');
  if (!topGoal?.id) {
    row.appendChild(el('span', 'detail-muted', 'No active goal'));
    return row;
  }
  row.appendChild(el('span', 'detail-goal-id', topGoal.id));
  const parts = [];
  if (topGoal.urgency != null) parts.push(`urgency ${topGoal.urgency}`);
  if (topGoal.gap != null) parts.push(`gap ${topGoal.gap}`);
  if (parts.length) row.appendChild(el('span', 'detail-muted', parts.join(' · ')));
  row.appendChild(
    badge(topGoal.satisfied ? 'satisfied' : 'in progress', topGoal.satisfied ? 'done' : 'running'),
  );
  return row;
}

export function formatDurationShort(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Minecraft time-of-day ticks (0–23999) → clock label. */
export function formatMcClock(ticks) {
  if (ticks == null || !Number.isFinite(Number(ticks))) return '—';
  const t = Math.floor(Number(ticks)) % 24000;
  const h = Math.floor((t / 1000 + 6) % 24);
  const m = Math.floor(((t % 1000) * 60) / 1000);
  return `${h}:${String(m).padStart(2, '0')}`;
}

const IDLE_LABELS = {
  disconnected: 'Disconnected',
  task_running: 'Task running',
  task_stuck: 'Task stuck',
  error_loop: 'Error loop',
  recent_error: 'Recent API error',
  awaiting_agent: 'Awaiting agent',
};

export function idleReasonLabel(code) {
  if (!code) return '—';
  return IDLE_LABELS[code] || code.replace(/_/g, ' ');
}

export function motionSummary(a) {
  if (!a.online) return '—';
  const speed = a.motion_speed_bps;
  const idle = a.motion_idle_sec;
  if (speed != null && speed > 0.08) return `${speed.toFixed(2)} blocks/s`;
  if (idle != null && idle > 0) return `Idle ${formatDurationShort(idle)}`;
  return 'Stationary';
}

function telemetryDlRow(dt, ddText) {
  const dtEl = el('dt', null, dt);
  const ddEl = el('dd', null, ddText);
  return [dtEl, ddEl];
}

export function buildTelemetryDl(a) {
  const dl = el('dl', 'detail-telemetry-dl');
  const dayPart =
    a.is_day === true ? 'Day' : a.is_day === false ? 'Night' : '—';
  const clock = formatMcClock(a.time_ticks);
  dl.append(...telemetryDlRow('World time', `${clock} (${dayPart})`));

  if (a.last_death_age_s != null) {
    dl.append(...telemetryDlRow('Since last death', formatDurationShort(a.last_death_age_s)));
  } else if (a.death_count > 0) {
    dl.append(...telemetryDlRow('Since last death', '—'));
  } else {
    dl.append(...telemetryDlRow('Since last death', 'No deaths this session'));
  }

  dl.append(...telemetryDlRow('Movement', motionSummary(a)));
  dl.append(...telemetryDlRow('Idle state', idleReasonLabel(a.idle_reason)));

  const combat = [];
  if (a.kills > 0) combat.push(`${a.kills} kills`);
  if (a.death_count > 0) combat.push(`${a.death_count} deaths`);
  if (combat.length) dl.append(...telemetryDlRow('Combat', combat.join(' · ')));

  if (a.alerts_count > 0) {
    dl.append(...telemetryDlRow('Alerts', String(a.alerts_count)));
  }
  if (a.hazard) {
    dl.append(...telemetryDlRow('Hazard', a.hazard.slice(0, 120)));
  }
  if (a.damage_telemetry?.seconds_ago != null) {
    const d = a.damage_telemetry;
    dl.append(
      ...telemetryDlRow(
        'Recent damage',
        `${d.last_damage} dmg · ${d.hp_after} HP · ${d.seconds_ago}s ago`,
      ),
    );
  }
  if (a.respawn_pending) {
    dl.append(...telemetryDlRow('Status', 'Respawn pending'));
  }
  return dl;
}

/** One-time DOM skeleton for player detail (avoids full rebuild each poll). */
export function mountPlayerDetailShell(main) {
  main.replaceChildren();
  main.dataset.shell = '1';

  const hero = el('div', 'detail-hero');
  hero.id = 'detailHero';
  hero.appendChild(el('h2', 'detail-hero-name', ''));
  const badgeRow = el('div', 'detail-hero-badges');
  badgeRow.id = 'detailHeroBadges';
  hero.appendChild(badgeRow);
  main.appendChild(hero);

  const metrics = el('div', 'player-metrics');
  metrics.id = 'detailMetrics';
  main.appendChild(metrics);

  const goalsBody = el('div', 'detail-section-body');
  goalsBody.id = 'detailGoalsBody';
  main.appendChild(detailSection('Goals', goalsBody));

  const kanbanBody = el('div', 'detail-section-body');
  kanbanBody.id = 'detailKanbanBody';
  main.appendChild(detailSection('Kanban', kanbanBody));

  const actBody = el('div', 'detail-section-body');
  actBody.id = 'detailActivityBody';
  const recentListSlot = el('div', 'detail-activity-block');
  recentListSlot.id = 'detailRecentActionsSlot';
  recentListSlot.appendChild(el('h4', 'detail-activity-label', 'Recent actions'));
  recentListSlot.appendChild(el('div', 'detail-activity-slot', ''));
  actBody.appendChild(recentListSlot);
  const reactiveSlot = el('div', 'detail-activity-block');
  reactiveSlot.id = 'detailReactiveSlot';
  reactiveSlot.appendChild(el('h4', 'detail-activity-label', 'Reactive'));
  reactiveSlot.appendChild(el('div', 'detail-activity-slot', ''));
  actBody.appendChild(reactiveSlot);
  main.appendChild(detailSection('Activity log', actBody));

  const invLive = el('div', 'detail-section-body');
  invLive.id = 'detailInvLive';
  main.appendChild(detailSection('Inventory (live)', invLive));

  const invHost = el('div', 'detail-inv-full-host');
  invHost.id = 'invFull';
  main.appendChild(detailSection('Inventory (detail)', invHost));

  const raw = collapsibleRaw('Raw observe fields', {});
  raw.id = 'detailRawObserve';
  main.appendChild(raw);
}

export function patchDetailHero(heroEl, name, opts) {
  const h = heroEl.querySelector('.detail-hero-name');
  if (h) h.textContent = name;
  const row = heroEl.querySelector('.detail-hero-badges');
  if (!row) return;
  row.replaceChildren();
  if (opts.online === true) row.appendChild(badge('Online', 'ok'));
  else if (opts.online === false) row.appendChild(badge('Offline', 'off'));
  if (opts.model) row.appendChild(badge(opts.model, 'model'));
  if (opts.world) row.appendChild(badge(opts.world, 'world'));
}

function activitySlot(host) {
  return host?.querySelector('.detail-activity-slot') || host;
}

export function patchTaskCardHost(host, task) {
  const slot = activitySlot(host);
  if (slot) slot.replaceChildren(buildTaskCard(task));
}

export function patchGoalRowHost(host, topGoal) {
  const slot = activitySlot(host);
  if (slot) slot.replaceChildren(buildGoalRow(topGoal));
}

export function patchRecentHost(host, recent) {
  const slot = activitySlot(host);
  if (slot) slot.replaceChildren(buildRecentLine(recent));
}

export function patchGoalsBody(host, goals) {
  if (!host) return;
  const key = JSON.stringify(
    (goals || []).map((g) => [g.id, g.urgency, g.current, g.satisfied, g.gap, g.metric]),
  );
  if (host.dataset.goalsKey === key) return;
  host.dataset.goalsKey = key;
  host.replaceChildren(buildGoalsList(goals));
}

export function patchRecentActionsHost(host, actions) {
  const slot = activitySlot(host);
  if (!slot) return;
  const key = JSON.stringify(actions || []);
  if (slot.dataset.raKey === key) return;
  slot.dataset.raKey = key;
  slot.replaceChildren(buildRecentActionsList(actions));
}

export function patchReactiveHost(host, entries) {
  const slot = activitySlot(host);
  if (!slot) return;
  const key = JSON.stringify(entries || []);
  if (slot.dataset.rxKey === key) return;
  slot.dataset.rxKey = key;
  slot.replaceChildren(buildReactiveLog(entries));
}

export function buildRecentLine(recent) {
  const line = formatRecentAction(recent);
  if (!line) return el('p', 'detail-muted', '—');
  return el('p', 'detail-recent', line);
}

export function buildRecentActionsList(actions) {
  const ul = el('ul', 'detail-recent-actions');
  const list = Array.isArray(actions) ? actions : [];
  if (!list.length) {
    ul.appendChild(el('li', 'detail-muted', '—'));
    return ul;
  }
  for (const a of list.slice(0, 5)) {
    const line = formatRecentAction(a);
    ul.appendChild(el('li', null, line || '—'));
  }
  return ul;
}

export function buildReactiveLog(entries) {
  const ul = el('ul', 'detail-reactive-log');
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    ul.appendChild(el('li', 'detail-muted', '—'));
    return ul;
  }
  for (const e of list) {
    const why = e.why || e.kind || '';
    const act = e.action || '';
    const parts = [act, why].filter(Boolean).join(' · ');
    ul.appendChild(el('li', null, parts || '—'));
  }
  return ul;
}

function buildGoalCollapsibleBody(g) {
  const body = el('div', 'detail-goal-body');
  const barInfo = goalBarDisplay(g);
  if (barInfo.showBar) {
    const barWrap = el('div', 'detail-goal-bar-wrap');
    const bar = el('div', `detail-goal-bar detail-goal-bar-${barInfo.mode}`, null);
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(barInfo.ratio * 100)}%`;
    bar.appendChild(fill);
    barWrap.appendChild(bar);
    barWrap.appendChild(el('span', 'detail-goal-nums', barInfo.label));
    body.appendChild(barWrap);
  } else {
    body.appendChild(el('p', 'detail-goal-nums', barInfo.label));
  }

  const meta = [];
  if (g.metric) meta.push(g.metric.replace(/_/g, ' '));
  if (g.gap != null && g.metric !== 'threat_score') meta.push(`gap ${g.gap}`);
  if (g.time_in_deficit_s != null) meta.push(`deficit ${formatDurationShort(g.time_in_deficit_s)}`);
  if (g.note) meta.push(String(g.note).slice(0, 80));
  if (meta.length) body.appendChild(el('p', 'detail-goal-meta', meta.join(' · ')));

  const chips = strategyChipsForDisplay(g.strategies_available);
  if (chips.length) {
    const chipWrap = el('div', 'detail-chips');
    for (const s of chips) {
      const chip = el('span', 'detail-chip', s.replace(/_/g, ' '));
      chip.title = s;
      chipWrap.appendChild(chip);
    }
    body.appendChild(chipWrap);
  }
  return body;
}

export function buildGoalsList(goals) {
  const root = el('div', 'detail-goals-list');
  const sorted = sortGoalsByUrgency(goals || []);
  if (!sorted.length) {
    root.appendChild(el('p', 'detail-muted', 'No goals loaded.'));
    return root;
  }
  sorted.forEach((g, idx) => {
    const det = document.createElement('details');
    det.className = `detail-goal-collapsible${g.satisfied ? ' satisfied' : ''}`;
    if (idx === 0) det.open = true;

    const sum = document.createElement('summary');
    sum.className = 'detail-goal-summary';
    sum.appendChild(el('span', 'detail-goal-id', g.id || '—'));
    if (g.satisfied) sum.appendChild(badge('done', 'done'));
    else sum.appendChild(badge(`u ${g.urgency ?? '—'}`, 'running'));
    const barInfo = goalBarDisplay(g);
    if (barInfo.showBar && barInfo.label !== '—') {
      sum.appendChild(el('span', 'detail-goal-summary-metric', barInfo.label));
    }
    det.appendChild(sum);
    det.appendChild(buildGoalCollapsibleBody(g));
    root.appendChild(det);
  });
  return root;
}

export function buildChipList(entries, { max = 32 } = {}) {
  const wrap = el('div', 'detail-chips');
  const list = Object.entries(entries || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  if (!list.length) {
    wrap.appendChild(el('span', 'detail-muted', '—'));
    return wrap;
  }
  for (const [name, count] of list) {
    const chip = el('span', 'detail-chip', null);
    chip.appendChild(el('span', 'detail-chip-name', prettyItemName(name)));
    chip.appendChild(el('span', 'detail-chip-count', `×${count}`));
    chip.title = name;
    wrap.appendChild(chip);
  }
  return wrap;
}

const INV_CAT_ORDER = ['tools', 'weapons', 'armor', 'food', 'materials', 'blocks', 'other'];
const INV_CAT_LABEL = {
  tools: 'Tools',
  weapons: 'Weapons',
  armor: 'Armor',
  food: 'Food',
  materials: 'Materials',
  blocks: 'Blocks',
  other: 'Other',
};

export function buildInventoryFull(data) {
  const root = el('div', 'detail-inventory-full');
  if (!data) {
    root.appendChild(el('p', 'detail-muted', '—'));
    return root;
  }
  if (data.summary === 'empty' || (data.totalSlots === 0 && !data.categories)) {
    root.appendChild(el('p', 'detail-muted', 'Empty'));
    return root;
  }
  if (Array.isArray(data.advisories) && data.advisories.length) {
    const ul = el('ul', 'detail-advisories');
    for (const a of data.advisories.slice(0, 6)) {
      ul.appendChild(el('li', null, a));
    }
    root.appendChild(ul);
  }
  const cats = data.categories || {};
  const keys = [...new Set([...INV_CAT_ORDER, ...Object.keys(cats)])].filter((k) => cats[k]?.length);
  for (const key of keys) {
    const items = cats[key];
    if (!items?.length) continue;
    const block = el('div', 'detail-inv-cat');
    block.appendChild(el('h4', 'detail-inv-cat-title', INV_CAT_LABEL[key] || key));
    const chips = el('div', 'detail-chips');
    for (const it of items.slice(0, 24)) {
      const chip = el('span', 'detail-chip', null);
      chip.appendChild(el('span', 'detail-chip-name', prettyItemName(it.name)));
      chip.appendChild(el('span', 'detail-chip-count', `×${it.count}`));
      chip.title = it.name;
      chips.appendChild(chip);
    }
    block.appendChild(chips);
    root.appendChild(block);
  }
  if (data.totalSlots != null) {
    root.appendChild(el('p', 'detail-inv-slots', `${data.totalSlots} occupied slots`));
  }
  return root;
}

export function buildKanbanDetail(t) {
  const frag = document.createDocumentFragment();
  frag.appendChild(buildDetailHero(t.title, { world: t.board || null }));

  const lane = el('div', 'detail-kanban-lane');
  lane.appendChild(badge(t.status, 'lane'));
  if (t.column) lane.appendChild(badge(t.column, 'muted'));
  if (t.blocked) lane.appendChild(badge('blocked', 'err'));
  if (t.checked) lane.appendChild(badge('checked', 'ok'));
  frag.appendChild(lane);

  const raw = t.raw || t;
  const bodyText =
    raw.text || raw.body || raw.description || raw.notes || raw.content || '';
  if (bodyText && typeof bodyText === 'string') {
    const body = el('div', 'detail-kanban-body');
    body.textContent = bodyText.trim().slice(0, 4000);
    frag.appendChild(detailSection('Description', body));
  }

  const meta = el('dl', 'detail-meta-dl');
  const add = (dt, dd) => {
    meta.appendChild(el('dt', null, dt));
    meta.appendChild(el('dd', null, dd));
  };
  if (t.assignee) add('Assignee', t.assignee);
  if (t.updated_at) add('Updated', new Date(t.updated_at).toLocaleString());
  add('Id', t.id);
  frag.appendChild(meta);

  frag.appendChild(
    el(
      'p',
      'detail-hint muted',
      'Full card history: Hermes / Obsidian kanban.',
    ),
  );
  frag.appendChild(collapsibleRaw('Raw card JSON', raw));
  return frag;
}

export function buildHumanDetail(hu) {
  const frag = document.createDocumentFragment();
  frag.appendChild(buildDetailHero(hu.name, { world: hu.world || null }));
  frag.appendChild(detailSection('Position', buildPositionLine(hu.position)));
  return frag;
}

export function buildPoiDetail(p) {
  const frag = document.createDocumentFragment();
  frag.appendChild(buildDetailHero(p.name, { world: p.world }));
  const dl = el('dl', 'detail-meta-dl');
  const add = (dt, dd) => {
    dl.appendChild(el('dt', null, dt));
    dl.appendChild(el('dd', null, dd));
  };
  add('Position', `${p.x}, ${p.y}, ${p.z}`);
  if (p.note) add('Note', p.note);
  add('Last visited', p.last_visited_by || '—');
  frag.appendChild(dl);
  return frag;
}

/** Personal POI row from /api/personal-pois (mapping mission). */
export function buildPersonalPoiDetail(p) {
  const frag = document.createDocumentFragment();
  const sub = [p.kind, p.source || p.observed_by].filter(Boolean).join(' · ');
  frag.appendChild(buildDetailHero(p.name, { world: p.world, subtitle: sub || null }));
  const dl = el('dl', 'detail-meta-dl');
  const add = (dt, dd) => {
    dl.appendChild(el('dt', null, dt));
    dl.appendChild(el('dd', null, dd));
  };
  add('Position', `${p.x}, ${p.y}, ${p.z}`);
  if (p.kind) add('Kind', p.kind);
  if (p.agent_owner) add('Owner', p.agent_owner);
  if (p.sign_at) add('Sign', `${p.sign_at.x}, ${p.sign_at.y}, ${p.sign_at.z}`);
  else add('Sign', '—');
  if (p.torch_at) add('Torch', `${p.torch_at.x}, ${p.torch_at.y}, ${p.torch_at.z}`);
  if (p.torch_missing_since) add('Torch missing since', p.torch_missing_since);
  if (p.note) add('Note', p.note);
  if (p.last_seen) add('Last seen', p.last_seen);
  frag.appendChild(dl);
  return frag;
}
