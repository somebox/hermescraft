/**
 * Real-time agent ticker below map/FPV (center column).
 */
import {
  actionLabel,
  el,
  formatMcClock,
  formatDurationShort,
  formatRecentAction,
  idleReasonLabel,
  motionSummary,
  prettyItemName,
} from './detail-view.js';

function liveCell(label, valueNode) {
  const cell = el('div', 'live-cell');
  cell.appendChild(el('span', 'live-label', label));
  const v = el('div', 'live-value');
  if (typeof valueNode === 'string') v.textContent = valueNode;
  else v.appendChild(valueNode);
  cell.appendChild(v);
  return cell;
}

function miniBars(a) {
  const wrap = el('div', 'live-mini-bars');
  const hp = el('div', 'live-mini-bar');
  hp.title = 'Health';
  const hi = document.createElement('i');
  hi.style.width = `${Math.round(Math.min(1, (a.health || 0) / 20) * 100)}%`;
  hp.appendChild(hi);
  const fd = el('div', 'live-mini-bar food');
  fd.title = 'Food';
  const fi = document.createElement('i');
  fi.style.width = `${Math.round(Math.min(1, (a.food || 0) / 20) * 100)}%`;
  fd.appendChild(fi);
  wrap.appendChild(hp);
  wrap.appendChild(fd);
  wrap.appendChild(
    el('span', 'live-mini-nums', `${Math.round(a.health || 0)}/20 · ${Math.round(a.food || 0)}/20`),
  );
  return wrap;
}

function taskLine(a) {
  const t = a.task;
  if (!t) return 'Idle';
  const parts = [actionLabel(t.action), t.status || ''].filter(Boolean);
  let line = parts.join(' · ');
  if (t.error) line += ` — ${String(t.error).slice(0, 80)}`;
  else if (a.poll_error) line += ` — poll: ${a.poll_error}`;
  return line;
}

/**
 * @param {object | null} a fleet agent row
 */
export function buildAgentLiveStrip(a) {
  const root = el('div', 'agent-live-strip-inner');
  if (!a) {
    root.appendChild(el('p', 'muted live-empty', 'Select an agent to see live status.'));
    return root;
  }

  root.appendChild(el('div', 'live-head', a.name));

  const grid = el('div', 'live-grid');

  const equipVal = el('span', 'live-equip-name', prettyItemName(a.holding));
  if (a.holding && a.holding !== 'empty') equipVal.title = String(a.holding);
  grid.appendChild(liveCell('Equipped', equipVal));

  const pos =
    a.position && typeof a.position.x === 'number'
      ? `${a.position.x.toFixed(1)} · ${a.position.y.toFixed(1)} · ${a.position.z.toFixed(1)}`
      : '—';
  grid.appendChild(liveCell('Position', pos));

  const dayPart = a.is_day === true ? 'day' : a.is_day === false ? 'night' : '—';
  const clock = formatMcClock(a.time_ticks);
  const motion = motionSummary(a);
  const idle = idleReasonLabel(a.idle_reason);
  grid.appendChild(
    liveCell('World', `${clock} (${dayPart}) · ${motion} · ${idle}`),
  );

  const taskErr = el('div', 'live-task-line');
  const taskText = taskLine(a);
  taskErr.textContent = taskText;
  if (a.poll_error || a.task?.error) taskErr.classList.add('live-err');
  grid.appendChild(liveCell('Task', taskErr));

  if (a.top_goal?.id) {
    grid.appendChild(
      liveCell('Focus goal', `${a.top_goal.id}${a.top_goal.satisfied ? ' ✓' : ''}`),
    );
  }

  if (a.last_death_age_s != null) {
    grid.appendChild(
      liveCell('Last death', formatDurationShort(a.last_death_age_s) + ' ago'),
    );
  }

  grid.appendChild(liveCell('Vitals', miniBars(a)));

  const recent = formatRecentAction(a.recent_action);
  if (recent) grid.appendChild(liveCell('Last mc', recent));

  root.appendChild(grid);
  return root;
}

/**
 * Incremental patch into #agentLiveStrip inner container.
 * @param {HTMLElement | null} host #agentLiveStrip
 * @param {object | null} a
 */
export function patchAgentLiveStrip(host, a) {
  if (!host) return;
  const key = a
    ? [
        a.name,
        a.holding,
        a.position?.x,
        a.health,
        a.food,
        a.task?.action,
        a.task?.status,
        a.task?.error,
        a.poll_error,
        a.motion_speed_bps,
        a.motion_idle_sec,
        a.idle_reason,
        a.time_ticks,
        a.top_goal?.id,
      ].join('|')
    : '';
  if (host.dataset.liveKey === key) return;
  host.dataset.liveKey = key;
  host.replaceChildren(buildAgentLiveStrip(a));
}
