import { fetchWithTimeout } from './poll.js';

const COL_TO_LANE = {
  backlog: 'triage',
  triage: 'triage',
  'to do': 'todo',
  todo: 'todo',
  ready: 'ready',
  'in progress': 'running',
  running: 'running',
  review: 'blocked',
  blocked: 'blocked',
  done: 'done',
  archived: 'archived',
};

const LANES = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived'];

function laneForColumn(column) {
  if (!column) return 'todo';
  const k = String(column).trim().toLowerCase();
  return COL_TO_LANE[k] || 'todo';
}

function emptyGrouped() {
  const g = {};
  for (const L of LANES) g[L] = [];
  return g;
}

/**
 * @param {string} baseUrl
 * @param {string | null} boardId e.g. Kanban/world.md
 */
export async function fetchBoard(baseUrl, boardId) {
  if (!boardId) {
    return { ok: false, error: 'no_board_for_world', tasks: [], grouped: emptyGrouped() };
  }
  const enc = encodeURIComponent(boardId);
  const url = `${baseUrl.replace(/\/$/, '')}/boards/${enc}`;
  const r = await fetchWithTimeout(url, { timeout: 12_000 }).catch(() => null);
  if (!r || !r.ok) {
    return { ok: false, error: `kanban_http_${r?.status || 'err'}`, tasks: [], grouped: emptyGrouped() };
  }
  const j = await r.json().catch(() => null);
  if (!j?.ok || !j.board) {
    return { ok: false, error: 'kanban_bad_response', tasks: [], grouped: emptyGrouped() };
  }
  const { board } = j;
  const cards = board.cards || [];
  const tasks = cards.map((c) => ({
    id: c.id,
    title: c.title,
    status: laneForColumn(c.column),
    column: c.column,
    assignee: c.assignee ?? null,
    board: board.title || board.id,
    updated_at: c.updated_at ?? null,
    checked: Boolean(c.checked),
    blocked: Boolean(c.blocked),
    raw: c,
  }));
  const grouped = emptyGrouped();
  for (const t of tasks) {
    const lane = grouped[t.status] ? t.status : 'todo';
    grouped[lane].push(t);
  }
  return { ok: true, board, tasks, grouped, columns: board.columns || [] };
}

/**
 * Hermes Kanban Bridge: GET /boards — find board whose title matches world.
 * @param {string} baseUrl
 * @param {string} world
 */
export async function resolveBoardIdForWorld(baseUrl, world) {
  const r = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/boards`, { timeout: 8000 }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  const boards = j?.boards || [];
  const match = boards.find((b) => b.title === world || b.title === world.replace(/-/g, ' '));
  return match?.id || match?.path || null;
}

export { LANES };
