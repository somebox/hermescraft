import fs from 'fs';
import path from 'path';

const TRUNC = 300;
const TRUNC_TOOL = 220;

/**
 * @param {string} s
 * @param {number} n
 */
export function truncate(s, n = TRUNC) {
  const t = (s || '').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

/**
 * @param {string} argsRaw
 */
export function renderToolCallArgs(argsRaw) {
  if (!argsRaw) return '';
  try {
    const d = JSON.parse(argsRaw);
    if (d && typeof d === 'object' && typeof d.command === 'string') {
      return truncate(d.command, TRUNC_TOOL);
    }
    return truncate(JSON.stringify(d), TRUNC_TOOL);
  } catch {
    return truncate(String(argsRaw), TRUNC_TOOL);
  }
}

/**
 * @param {unknown} content
 * @returns {{ text: string, isError: boolean }}
 */
export function renderToolResult(content) {
  if (typeof content !== 'string') {
    return { text: truncate(String(content), TRUNC_TOOL), isError: false };
  }
  let isError = false;
  try {
    const d = JSON.parse(content);
    const out = d?.output;
    if (typeof out === 'string') {
      if (out.trimStart().startsWith('ERROR')) isError = true;
      return { text: truncate(out, TRUNC_TOOL), isError };
    }
    if (d && d.error != null) {
      return { text: truncate(JSON.stringify(d.error), TRUNC_TOOL), isError: true };
    }
  } catch {
    /* fall through */
  }
  return { text: truncate(content, TRUNC_TOOL), isError: false };
}

/**
 * @param {string} sessionPath
 * @returns {object[]}
 */
export function loadSessionMessages(sessionPath) {
  try {
    const raw = fs.readFileSync(sessionPath, 'utf8');
    const d = JSON.parse(raw);
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.messages)) return d.messages;
    return [];
  } catch {
    return [];
  }
}

/**
 * @param {string} sessionsDir
 * @returns {string | null}
 */
/** Read Hermes session `last_updated` from file head; fallback to mtime. */
export function sessionActivityMs(sessionPath) {
  try {
    const fd = fs.openSync(sessionPath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, n).toString('utf8');
    const m = head.match(/"last_updated"\s*:\s*"([^"]+)"/);
    if (m) {
      const t = Date.parse(m[1]);
      if (Number.isFinite(t)) return t;
    }
  } catch {
    /* fall through */
  }
  try {
    return fs.statSync(sessionPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Session file most recently updated (by JSON last_updated, not directory mtime alone).
 * @param {string} sessionsDir
 */
export function activeSessionFile(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return null;
  let best = null;
  let bestMs = 0;
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!f.startsWith('session_') || !f.endsWith('.json')) continue;
    const p = path.join(sessionsDir, f);
    try {
      if (!fs.statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    const ms = sessionActivityMs(p);
    if (ms >= bestMs) {
      bestMs = ms;
      best = p;
    }
  }
  return best;
}

/** @deprecated use activeSessionFile */
export function newestSessionFile(sessionsDir) {
  return activeSessionFile(sessionsDir);
}

/**
 * Flatten session messages into display turns from sinceIndex.
 * @param {object[]} messages
 * @param {{ limit?: number, sinceIndex?: number }} [opts]
 */
export function extractTurns(messages, opts = {}) {
  const limit = opts.limit ?? 50;
  const sinceIndex = Math.max(0, opts.sinceIndex ?? 0);
  /** @type {Array<{ index: number, turnKey: string, kind: string, text: string, isError?: boolean, toolName?: string }>} */
  const turns = [];
  let nextIndex = sinceIndex;

  for (let i = sinceIndex; i < messages.length && turns.length < limit; i++) {
    const msg = messages[i];
    nextIndex = i + 1;
    const role = msg?.role;
    if (role === 'assistant') {
      const reasoning = (msg.reasoning_content || msg.reasoning || '').trim();
      const content = (msg.content || '').trim();
      if (reasoning && reasoning !== content) {
        turns.push({
          index: i,
          turnKey: `${i}:think`,
          kind: 'think',
          text: truncate(reasoning, TRUNC),
        });
      }
      if (content) {
        turns.push({ index: i, turnKey: `${i}:say`, kind: 'say', text: truncate(content, TRUNC) });
      }
      let toolN = 0;
      for (const tc of msg.tool_calls || []) {
        const fn = tc?.function || {};
        const name = fn.name || '?';
        const args = fn.arguments || '';
        turns.push({
          index: i,
          turnKey: `${i}:tool:${toolN}:${name}`,
          kind: 'tool',
          toolName: name,
          text: renderToolCallArgs(typeof args === 'string' ? args : JSON.stringify(args)),
        });
        toolN += 1;
      }
    } else if (role === 'tool') {
      const { text, isError } = renderToolResult(msg.content);
      turns.push({
        index: i,
        turnKey: `${i}:tool_result`,
        kind: 'tool_result',
        text,
        isError,
      });
    }
  }

  return { turns, nextIndex, totalMessages: messages.length };
}

/**
 * Last N display turns from the end of the session (for dashboard Mind panel).
 * @param {object[]} messages
 * @param {{ limit?: number, kinds?: string[] }} [opts]
 */
export function extractTurnsTail(messages, opts = {}) {
  const limit = Math.max(1, opts.limit ?? 8);
  const kinds = opts.kinds;
  const { turns } = extractTurns(messages, {
    limit: messages.length,
    sinceIndex: 0,
  });
  const filtered = kinds?.length ? turns.filter((t) => kinds.includes(t.kind)) : turns;
  return filtered.slice(-limit);
}

/**
 * @param {string} hermesHome
 * @param {{ limit?: number, cursor?: number, tail?: boolean }} [opts]
 */
export function loadCognitionFromHome(hermesHome, opts = {}) {
  const sessionsDir = path.join(hermesHome, 'sessions');
  const sessionPath = activeSessionFile(sessionsDir);
  if (!sessionPath) {
    return { ok: false, error: 'no_session', turns: [], cursor: 0, session: null };
  }
  const messages = loadSessionMessages(sessionPath);
  const limit = opts.limit ?? 15;
  if (opts.tail) {
    const turns = extractTurnsTail(messages, { limit, kinds: ['think', 'say'] });
    return {
      ok: true,
      turns,
      cursor: messages.length,
      totalMessages: messages.length,
      session: path.basename(sessionPath),
      tail: true,
    };
  }
  const cursor = Number(opts.cursor) || 0;
  const { turns, nextIndex, totalMessages } = extractTurns(messages, {
    limit,
    sinceIndex: cursor,
  });
  return {
    ok: true,
    turns,
    cursor: nextIndex,
    totalMessages,
    session: path.basename(sessionPath),
  };
}
