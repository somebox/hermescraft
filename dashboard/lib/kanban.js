import { fetchWithTimeout } from './poll.js';
import { runHermesCli } from './hermes-cli.js';

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

/** Hermes SQLite `status` field → dashboard lane id. */
const STATUS_TO_LANE = {
  triage: 'triage',
  todo: 'todo',
  ready: 'ready',
  running: 'running',
  blocked: 'blocked',
  done: 'done',
  archived: 'archived',
};

const LANES = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived'];

function laneForColumn(column) {
  if (!column) return 'todo';
  const k = String(column).trim().toLowerCase();
  return COL_TO_LANE[k] || STATUS_TO_LANE[k] || 'todo';
}

function emptyGrouped() {
  const g = {};
  for (const L of LANES) g[L] = [];
  return g;
}

function normalizeTasksFromRows(rows, boardLabel) {
  const tasks = rows.map((c) => {
    const hermesStatus = c.status != null ? String(c.status) : c.column;
    const lane = laneForColumn(hermesStatus || c.column);
    return {
      id: c.id,
      title: c.title,
      status: lane,
      column: c.column || hermesStatus || null,
      assignee: c.assignee ?? null,
      board: boardLabel,
      updated_at: c.updated_at ?? c.completed_at ?? c.started_at ?? c.created_at ?? null,
      checked: Boolean(c.checked),
      blocked: lane === 'blocked' || String(hermesStatus).toLowerCase() === 'blocked',
      raw: c,
    };
  });
  const grouped = emptyGrouped();
  for (const t of tasks) {
    const lane = grouped[t.status] ? t.status : 'todo';
    grouped[lane].push(t);
  }
  return { tasks, grouped };
}

function parseJsonArray(stdout) {
  const t = stdout.trim();
  if (!t) return [];
  const j = JSON.parse(t);
  return Array.isArray(j) ? j : [];
}

export async function fetchBoardFromCli(boardId) {
  if (!boardId) {
    return { ok: false, error: 'no_board_for_world', tasks: [], grouped: emptyGrouped() };
  }
  try {
    const { stdout } = await runHermesCli(['kanban', '--board', boardId, 'list', '--json'], 45_000);
    const rows = parseJsonArray(stdout);
    const { tasks, grouped } = normalizeTasksFromRows(rows, boardId);
    return {
      ok: true,
      source: 'cli',
      board: { id: boardId, title: boardId, cards: rows },
      tasks,
      grouped,
      columns: [],
    };
  } catch (e) {
    return {
      ok: false,
      error: 'kanban_cli_err',
      message: e instanceof Error ? e.message : String(e),
      tasks: [],
      grouped: emptyGrouped(),
    };
  }
}

export async function fetchBoardsListFromCli() {
  try {
    const { stdout } = await runHermesCli(['kanban', 'boards', 'list', '--json'], 20_000);
    const rows = parseJsonArray(stdout);
    const boards = rows.map((b) => ({
      id: b.slug || b.id,
      title: b.name || b.slug,
      path: b.slug,
      slug: b.slug,
    }));
    return { ok: true, source: 'cli', boards };
  } catch {
    return { ok: false, boards: [] };
  }
}

/**
 * Bridge first; fall back to local `hermes kanban list --json` when bridge is down.
 */
export async function fetchBoardWithFallback(baseUrl, boardId) {
  const bridge = await fetchBoard(baseUrl, boardId);
  if (bridge.ok && (bridge.tasks?.length ?? 0) > 0) {
    return { ...bridge, source: 'bridge' };
  }
  if (bridge.ok && (bridge.tasks?.length ?? 0) === 0) {
    const cli = await fetchBoardFromCli(boardId);
    if (cli.ok && (cli.tasks?.length ?? 0) > 0) return cli;
    return { ...bridge, source: 'bridge' };
  }
  const cli = await fetchBoardFromCli(boardId);
  if (cli.ok) return cli;
  return bridge.ok ? { ...bridge, source: 'bridge' } : cli;
}

export async function fetchBoardsListWithFallback(baseUrl) {
  const bridge = await fetchBoardsList(baseUrl);
  if (bridge.ok && bridge.boards?.length) return { ...bridge, source: 'bridge' };
  const cli = await fetchBoardsListFromCli();
  if (cli.ok && cli.boards?.length) return cli;
  return bridge.ok ? { ...bridge, source: 'bridge' } : cli;
}

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
  const { tasks, grouped } = normalizeTasksFromRows(
    cards.map((c) => ({
      ...c,
      status: c.status ?? c.column,
      column: c.column,
    })),
    board.title || board.id,
  );
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

export async function fetchBoardsList(baseUrl) {
  const r = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/boards`, { timeout: 8000 }).catch(
    () => null,
  );
  if (!r || !r.ok) return { ok: false, boards: [] };
  const j = await r.json().catch(() => null);
  const boards = j?.boards || [];
  return { ok: true, boards };
}

export { LANES };
