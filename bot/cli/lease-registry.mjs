/**
 * Bot lease registry — shared SQLite store for mc bot checkout/release.
 * @see docs/architecture/bot-lease.md
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

/** Sentinel: lease-mode active but no lease for this owner. */
export const NO_LEASE = '';

// The lease TTL doubles as the IDLE-RECLAIM window: a live holder renews it on
// every command (touch-on-use, see resolveLeaseUrl), so the TTL only elapses once
// the holder STOPS issuing commands — i.e. it timed out, was killed, or crashed.
// At that point the body becomes reclaimable within one TTL instead of lingering
// for an hour. Keep it comfortably longer than the worst gap between commands a
// live worker has (slow-model planning turns), but short enough that a dead
// worker's body frees quickly. Override with HERMES_BOT_LEASE_TTL_S if a flow
// legitimately holds a body idle for longer.
const DEFAULT_TTL_S = Number(process.env.HERMES_BOT_LEASE_TTL_S) > 0
  ? Number(process.env.HERMES_BOT_LEASE_TTL_S)
  : 600;
const DEFER_RETRY_MS_MIN = 2000;
const DEFER_RETRY_MS_MAX = 5000;

/** @type {((apiUrl: string) => Promise<{ busy: boolean, reachable: boolean }>) | null} */
let taskProbeOverride = null;

/** @param {((apiUrl: string) => Promise<{ busy: boolean, reachable: boolean }>) | null} fn */
export function __testOnly_setTaskProbe(fn) {
  taskProbeOverride = fn;
}

export function leaseModeEnabled() {
  return process.env.HERMES_BOT_LEASE === '1';
}

function sqlQuote(s) {
  return String(s).replace(/'/g, "''");
}

export function dbPath() {
  const fromEnv = process.env.HERMES_BOT_LEASE_DB;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.hermes', 'bot-leases.db');
}

const schemaInitialized = new Set();

function ensureSchema(db) {
  if (schemaInitialized.has(db)) return;
  const dir = path.dirname(db);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(db)) {
    execFileSync('sqlite3', [db, 'SELECT 1;'], { encoding: 'utf8' });
  }
  execFileSync(
    'sqlite3',
    [
      db,
      `CREATE TABLE IF NOT EXISTS bot_leases (
      bot TEXT PRIMARY KEY,
      api_url TEXT NOT NULL,
      world TEXT,
      owner_id TEXT NOT NULL,
      lease_version INTEGER NOT NULL,
      leased_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      profile TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_last_mark (
      bot TEXT PRIMARY KEY,
      mark TEXT NOT NULL,
      ts_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_last_task (
      task_id TEXT PRIMARY KEY,
      bot TEXT NOT NULL,
      ts_ms INTEGER NOT NULL
    );`,
    ],
    { encoding: 'utf8' },
  );
  schemaInitialized.add(db);
}

function runSql(sql, { db = dbPath() } = {}) {
  ensureSchema(db);
  const out = execFileSync('sqlite3', ['-batch', db, sql], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return out.trim();
}

/** @type {(() => Record<string, any>) | null} */
let poolOverride = null;

/** @param {(() => Record<string, any>) | null} fn */
export function __testOnly_setPool(fn) {
  poolOverride = fn;
}

/** @returns {Record<string, { bot: string, api_url: string, username: string, port: number, caps: string[] | null }>} */
export function loadBotPool() {
  if (poolOverride) return poolOverride();
  const dir = path.join(REPO_ROOT, 'data', 'bots');
  /** @type {Record<string, { bot: string, api_url: string, username: string, port: number, caps: string[] | null }>} */
  const pool = {};
  if (!fs.existsSync(dir)) return pool;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.yaml')) continue;
    const bot = name.replace(/\.yaml$/, '').toLowerCase();
    const raw = fs.readFileSync(path.join(dir, name), 'utf8');
    const doc = yaml.parse(raw);
    const port = Number(doc?.api_port);
    if (!Number.isFinite(port)) continue;
    // Exclude test-harness / observer bots from the leasable pool. tester.yaml has no
    // `caps`, so it would otherwise be a "universal" body that colony workers check out
    // (gv2-2026-06-22-3: a worker leased Tester ~270 blocks from the colony spawn ->
    // pathfinding failures). These bots are addressed directly by their harness, never leased.
    const role = String(doc?.role || '').toLowerCase();
    if (role === 'tester' || role === 'observer') continue;
    // Optional capability registry flag. Missing/empty caps = universal body
    // (passes any --cap), so the current generic pool is unaffected.
    const caps = Array.isArray(doc?.caps)
      ? doc.caps.map((c) => String(c).toLowerCase())
      : null;
    pool[bot] = {
      bot,
      api_url: `http://127.0.0.1:${port}`,
      username: String(doc?.username || bot),
      port,
      caps,
    };
  }
  return pool;
}

/**
 * @returns {string}
 */
export function ownerId() {
  const task = String(process.env.HERMES_KANBAN_TASK || '').trim();
  const board = String(process.env.HERMES_KANBAN_BOARD || 'landfolk-ops').trim();
  // Owner identity MUST be stable across separate `mc` invocations — an agent
  // checks out in one process and uses `mc` in many later ones. Do NOT use
  // process.pid (it differs per invocation, so the lease would never resolve).
  // A kanban task is claimed by one worker session at a time, so board:task is
  // the stable owner; include a session id when the worker exposes one.
  const session = String(
    process.env.HERMES_SESSION_ID || process.env.HERMES_SESSION || process.env.HERMES_SESSION_KEY || ''
  ).trim();
  if (task) return session ? `${board}:${task}:${session}` : `${board}:${task}`;
  // Adhoc CLI (no task): allow an explicit, stable owner for testing/operators.
  const adhoc = String(process.env.HERMES_BOT_LEASE_OWNER || '').trim();
  return adhoc ? `cli:adhoc:${adhoc}` : 'cli:adhoc';
}

export function requireOwnerForMutation() {
  return ownerId();
}

/** @typedef {{ bot: string, api_url: string, world: string | null, owner_id: string, lease_version: number, leased_at_ms: number, expires_at_ms: number, profile: string | null }} LeaseRow */

/** @returns {LeaseRow | null} */
function rowFromLine(line) {
  if (!line) return null;
  const parts = line.split('|');
  if (parts.length < 8) return null;
  return {
    bot: parts[0],
    api_url: parts[1],
    world: parts[2] || null,
    owner_id: parts[3],
    lease_version: Number(parts[4]),
    leased_at_ms: Number(parts[5]),
    expires_at_ms: Number(parts[6]),
    profile: parts[7] || null,
  };
}

/** @returns {LeaseRow[]} */
function queryLeases(where = '1=1') {
  const sql = `SELECT bot, api_url, IFNULL(world,''), owner_id, lease_version, leased_at_ms, expires_at_ms, IFNULL(profile,'') FROM bot_leases WHERE ${where};`;
  const out = runSql(sql);
  if (!out) return [];
  return out.split('\n').map(rowFromLine).filter(Boolean);
}

/** @returns {LeaseRow | null} */
function leaseForOwner(owner_id) {
  const rows = queryLeases(`owner_id='${sqlQuote(owner_id)}'`);
  return rows[0] || null;
}

/** @returns {LeaseRow | null} */
function leaseForBot(bot) {
  const rows = queryLeases(`bot='${sqlQuote(bot)}'`);
  return rows[0] || null;
}

async function probeTask(apiUrl) {
  if (taskProbeOverride) return taskProbeOverride(apiUrl);
  const base = String(apiUrl).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/task`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { busy: false, reachable: false };
    const body = await res.json();
    const data = body?.data ?? body;
    const busy = data?.sync != null || data?.task != null;
    return { busy: Boolean(busy), reachable: true };
  } catch {
    return { busy: false, reachable: false };
  }
}

/**
 * @param {LeaseRow} row
 * @param {number} now
 */
async function isReclaimable(row, now) {
  if (row.expires_at_ms >= now) return false;
  const { busy, reachable } = await probeTask(row.api_url);
  if (!reachable) return true;
  return !busy;
}

/** @type {((apiUrl: string) => Promise<{ position: {x:number,y:number,z:number} | null }>) | null} */
let healthProbeOverride = null;

/** @param {((apiUrl: string) => Promise<{ position: {x:number,y:number,z:number} | null }>) | null} fn */
export function __testOnly_setHealthProbe(fn) {
  healthProbeOverride = fn;
}

/** @returns {Promise<{ position: {x:number,y:number,z:number} | null }>} */
async function probeHealth(apiUrl) {
  if (healthProbeOverride) return healthProbeOverride(apiUrl);
  const base = String(apiUrl).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { position: null };
    const body = await res.json();
    const pos = body?.position ?? body?.data?.position ?? null;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
      return { position: { x: pos.x, y: pos.y, z: pos.z } };
    }
    return { position: null };
  } catch {
    return { position: null };
  }
}

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** @returns {string | null} mark this body last worked, for continuity */
function lastMarkFor(bot) {
  const out = runSql(`SELECT mark FROM bot_last_mark WHERE bot='${sqlQuote(bot)}';`);
  return out ? out.trim() : null;
}

function recordLastMark(bot, mark) {
  runSql(
    `INSERT INTO bot_last_mark (bot, mark, ts_ms) VALUES ('${sqlQuote(bot)}','${sqlQuote(mark)}',${Date.now()})
     ON CONFLICT(bot) DO UPDATE SET mark=excluded.mark, ts_ms=excluded.ts_ms;`,
  );
}

function lastBotForTask(taskId) {
  const out = runSql(`SELECT bot FROM bot_last_task WHERE task_id='${sqlQuote(taskId)}';`);
  return out ? out.trim() : null;
}

function recordTaskContinuity(taskId, bot) {
  runSql(
    `INSERT INTO bot_last_task (task_id, bot, ts_ms) VALUES ('${sqlQuote(taskId)}','${sqlQuote(bot)}',${Date.now()})
     ON CONFLICT(task_id) DO UPDATE SET bot=excluded.bot, ts_ms=excluded.ts_ms;`,
  );
}

/** @type {((info: { bot: string, leaseVersion: number, board: string, task: string }) => void) | null} */
let stampOverride = null;

/** @param {((info: { bot: string, leaseVersion: number, board: string, task: string }) => void) | null} fn */
export function __testOnly_setStamp(fn) {
  stampOverride = fn;
}

/** Best-effort audit: stamp the worker's card with which body it leased. Never throws. */
function stampCard(bot, leaseVersion) {
  const task = process.env.HERMES_KANBAN_TASK;
  if (!task) return;
  const board = process.env.HERMES_KANBAN_BOARD || 'landfolk-ops';
  try {
    if (stampOverride) {
      stampOverride({ bot, leaseVersion, board, task });
      return;
    }
    execFileSync('hermes', ['kanban', '--board', board, 'comment', task, `leased_bot=${bot} v${leaseVersion}`], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    /* audit is advisory — a failed stamp must not fail the checkout */
  }
}

/**
 * @param {number} now
 */
export async function reapExpiredIdle(now = Date.now()) {
  const rows = queryLeases();
  for (const row of rows) {
    if (await isReclaimable(row, now)) {
      runSql(`DELETE FROM bot_leases WHERE bot='${sqlQuote(row.bot)}' AND expires_at_ms < ${now};`);
    }
  }
}

/**
 * @param {string} owner_id
 * @returns {string | typeof NO_LEASE}
 */
export function resolveLeaseUrl(owner_id) {
  if (!leaseModeEnabled()) return NO_LEASE;
  const row = leaseForOwner(owner_id);
  if (!row) return NO_LEASE;
  const now = Date.now();
  if (row.expires_at_ms < now) return NO_LEASE; // already lapsed — leave for reclaim
  // Touch-on-use: resolving the lease means the holder is issuing a command, so
  // it's alive — push expiry out by a full TTL. This is what releases a body on
  // worker TIMEOUT/kill without an explicit `mc bot release`: a dead worker stops
  // issuing commands, so its lease stops being renewed and lapses within one TTL,
  // and the next checkout reclaims the now-idle body. `max()` never SHRINKS a
  // longer explicit lease (e.g. a deliberate --ttl 7200 unattended job).
  try {
    const floor = now + DEFAULT_TTL_S * 1000;
    runSql(
      `UPDATE bot_leases SET expires_at_ms=max(expires_at_ms, ${floor}) WHERE bot='${sqlQuote(row.bot)}' AND owner_id='${sqlQuote(owner_id)}' AND lease_version=${row.lease_version};`,
    );
  } catch {
    /* renewal is best-effort — a failed touch must never fail the command */
  }
  return row.api_url;
}

function randomDeferMs() {
  return DEFER_RETRY_MS_MIN + Math.floor(Math.random() * (DEFER_RETRY_MS_MAX - DEFER_RETRY_MS_MIN + 1));
}

/**
 * @param {LeaseRow[]} leasedRows
 * @param {Record<string, { bot: string, api_url: string }>} pool
 * @param {number} now
 */
async function buildHolders(leasedRows, pool, now) {
  const holders = [];
  for (const entry of Object.values(pool)) {
    const row = leasedRows.find((r) => r.bot === entry.bot) || null;
    if (!row) continue;
    let busy = false;
    if (row.expires_at_ms >= now) {
      const p = await probeTask(row.api_url);
      busy = p.busy;
    }
    holders.push({
      bot: entry.bot,
      owner_id: row.owner_id,
      expires_at_ms: row.expires_at_ms,
      busy,
      expired: row.expires_at_ms < now,
    });
  }
  return holders;
}

/**
 * Rank free candidates by the board-dynamics pull policy:
 * task continuity (same card/body) → mark continuity (last worked the mark) →
 * nearest (--near) → least-recently-leased
 * → lexical. `distances`/`mark` are optional; omitting them reduces to the
 * original LRL→lexical tie-break.
 * @param {{ leasedRows?: LeaseRow[], taskId?: string|null, mark?: string|null, distances?: Map<string,number>|null }} opts
 */
function rankCandidates(candidates, opts = {}) {
  const { leasedRows = [], taskId = null, mark = null, distances = null } = opts;
  const byBot = Object.fromEntries(leasedRows.map((r) => [r.bot, r]));
  const taskPreferredBot = taskId ? lastBotForTask(taskId) : null;
  const continuity = new Set(
    mark ? candidates.filter((c) => lastMarkFor(c.bot) === mark).map((c) => c.bot) : [],
  );
  return [...candidates].sort((a, b) => {
    // 1. task continuity: for an existing card, prefer the prior body.
    const ta = taskPreferredBot && a.bot === taskPreferredBot ? 0 : 1;
    const tb = taskPreferredBot && b.bot === taskPreferredBot ? 0 : 1;
    if (ta !== tb) return ta - tb;
    // 2. mark continuity: a body that last worked this mark comes first.
    const ca = continuity.has(a.bot) ? 0 : 1;
    const cb = continuity.has(b.bot) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    // 3. nearest to --near (only when distances provided).
    if (distances) {
      const da = distances.has(a.bot) ? distances.get(a.bot) : Infinity;
      const db = distances.has(b.bot) ? distances.get(b.bot) : Infinity;
      if (da !== db) return da - db;
    }
    // 4. least-recently leased (never-leased first).
    const la = byBot[a.bot]?.leased_at_ms ?? 0;
    const lb = byBot[b.bot]?.leased_at_ms ?? 0;
    const aNull = la === 0;
    const bNull = lb === 0;
    if (aNull !== bNull) return aNull ? -1 : 1;
    if (la !== lb) return la - lb;
    // 5. lexical.
    return a.bot.localeCompare(b.bot);
  });
}

/**
 * @param {{ bot?: string, ttl?: number, profile?: string, near?: {x:number,y:number,z:number}, cap?: string, mark?: string }} opts
 */
export async function checkout(opts = {}) {
  const owner_id = requireOwnerForMutation();
  const taskId = opts.task ? String(opts.task) : String(process.env.HERMES_KANBAN_TASK || '').trim();
  const now = Date.now();
  const ttlS = Number(opts.ttl) > 0 ? Number(opts.ttl) : DEFAULT_TTL_S;
  const expires = now + ttlS * 1000;
  const pool = loadBotPool();
  const poolBots = Object.keys(pool);
  if (!poolBots.length) throw new Error('no bots in data/bots registry');

  const existing = leaseForOwner(owner_id);
  if (existing) {
    if (opts.bot && opts.bot.toLowerCase() !== existing.bot) {
      throw new Error(`already hold lease on ${existing.bot} — release first`);
    }
    if (existing.expires_at_ms >= now) {
      return {
        ok: true,
        bot: existing.bot,
        api_url: existing.api_url,
        lease_version: existing.lease_version,
        expires_at_ms: existing.expires_at_ms,
        owner_id,
      };
    }
  }

  await reapExpiredIdle(now);

  const want = opts.bot ? String(opts.bot).toLowerCase() : null;
  let candidates = want ? [pool[want]].filter(Boolean) : poolBots.map((b) => pool[b]);
  if (want && !candidates.length) throw new Error(`unknown bot: ${want}`);

  // D2 capability filter — a body with no `caps` is universal (passes any --cap).
  const cap = opts.cap ? String(opts.cap).toLowerCase() : null;
  if (cap) {
    candidates = candidates.filter((c) => !c.caps || c.caps.includes(cap));
    if (!candidates.length) {
      return {
        ok: false,
        error: want ? `bot ${want} lacks cap ${cap}` : `no body with cap ${cap} — defer`,
        retry_after_ms: randomDeferMs(),
        holders: await buildHolders(queryLeases(), pool, now),
      };
    }
  }

  const leasedRows = queryLeases();
  const free = [];
  for (const c of candidates) {
    const row = leaseForBot(c.bot);
    if (!row) {
      free.push(c);
      continue;
    }
    if (row.owner_id === owner_id) {
      free.push(c);
      continue;
    }
    if (row.expires_at_ms < now && (await isReclaimable(row, now))) {
      free.push(c);
      continue;
    }
    if (row.expires_at_ms >= now) continue;
  }

  if (!free.length && want) {
    return {
      ok: false,
      error: `bot ${want} taken`,
      retry_after_ms: randomDeferMs(),
      holders: await buildHolders(leasedRows, pool, now),
    };
  }

  const rankSet = free.length ? free : candidates;
  // D1 nearest — probe each candidate's /health position only when --near given.
  let distances = null;
  if (opts.near) {
    distances = new Map();
    await Promise.all(
      rankSet.map(async (c) => {
        const { position } = await probeHealth(c.api_url);
        if (position) distances.set(c.bot, dist3(opts.near, position));
      }),
    );
  }
  const ordered = rankCandidates(rankSet, {
    leasedRows,
    taskId: taskId || null,
    mark: opts.mark || null,
    distances,
  });

  for (const entry of ordered) {
    const prev = leaseForBot(entry.bot);
    const nextVersion = prev ? prev.lease_version + 1 : 1;
    const canSteal =
      !prev ||
      prev.owner_id === owner_id ||
      (prev.expires_at_ms < now && (await isReclaimable(prev, now)));

    if (!canSteal) continue;

    if (prev && prev.expires_at_ms < now && prev.owner_id !== owner_id) {
      runSql(`DELETE FROM bot_leases WHERE bot='${sqlQuote(entry.bot)}' AND expires_at_ms < ${now};`);
    }

    const insertSql = `
      INSERT INTO bot_leases (bot, api_url, world, owner_id, lease_version, leased_at_ms, expires_at_ms, profile)
      VALUES ('${sqlQuote(entry.bot)}', '${sqlQuote(entry.api_url)}', NULL, '${sqlQuote(owner_id)}', ${nextVersion}, ${now}, ${expires}, NULL)
      ON CONFLICT(bot) DO UPDATE SET
        api_url=excluded.api_url,
        owner_id=excluded.owner_id,
        lease_version=${nextVersion},
        leased_at_ms=excluded.leased_at_ms,
        expires_at_ms=excluded.expires_at_ms,
        profile=NULL
      WHERE bot_leases.owner_id='${sqlQuote(owner_id)}' OR bot_leases.expires_at_ms < ${now};
    `;
    runSql(insertSql);
    const got = leaseForBot(entry.bot);
    if (got && got.owner_id === owner_id && got.expires_at_ms >= now) {
      if (taskId) recordTaskContinuity(taskId, got.bot);
      if (opts.mark) recordLastMark(got.bot, String(opts.mark)); // D3 continuity
      stampCard(got.bot, got.lease_version); // D4 audit (best-effort)
      return {
        ok: true,
        bot: got.bot,
        api_url: got.api_url,
        lease_version: got.lease_version,
        expires_at_ms: got.expires_at_ms,
        owner_id,
      };
    }
  }

  return {
    ok: false,
    error: 'no free body — defer',
    retry_after_ms: randomDeferMs(),
    holders: await buildHolders(queryLeases(), pool, now),
  };
}

/** @param {{ force?: boolean, asOperator?: boolean, owner_id?: string }} opts */
export async function release(opts = {}) {
  const owner_id = opts.owner_id || requireOwnerForMutation();
  const row = leaseForOwner(owner_id);
  if (!row) throw new Error('no active bot lease');

  const { busy } = await probeTask(row.api_url);
  if (busy && !opts.force) {
    throw new Error('body busy — refuse release (use mc bot release --force --as-operator if admin)');
  }

  if (opts.force) {
    if (!opts.asOperator) throw new Error('--as-operator required for --force');
    if (process.env.HERMES_BOT_LEASE_ADMIN !== '1') {
      throw new Error('HERMES_BOT_LEASE_ADMIN=1 required for forced release');
    }
    const base = row.api_url.replace(/\/$/, '');
    try {
      await fetch(`${base}/task/cancel`, { method: 'POST', signal: AbortSignal.timeout(8000) });
    } catch {
      /* best effort */
    }
  }

  runSql(
    `DELETE FROM bot_leases WHERE bot='${sqlQuote(row.bot)}' AND owner_id='${sqlQuote(owner_id)}' AND lease_version=${row.lease_version};`,
  );
  const after = leaseForOwner(owner_id);
  if (after && after.bot === row.bot) {
    throw new Error('lease lost — re-checkout');
  }
  const base = row.api_url.replace(/\/$/, '');
  try {
    await fetch(`${base}/task-context`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
  } catch {
    /* best-effort: clear worksite grant + construct session on release */
  }
  return { ok: true, released: row.bot };
}

/** @param {{ ttl?: number, owner_id?: string }} opts */
export async function renew(opts = {}) {
  const owner_id = opts.owner_id || requireOwnerForMutation();
  const row = leaseForOwner(owner_id);
  if (!row) throw new Error('no active bot lease');
  const now = Date.now();
  const ttlS = Number(opts.ttl) > 0 ? Number(opts.ttl) : DEFAULT_TTL_S;
  const expires = now + ttlS * 1000;
  runSql(
    `UPDATE bot_leases SET expires_at_ms=${expires} WHERE bot='${sqlQuote(row.bot)}' AND owner_id='${sqlQuote(owner_id)}' AND lease_version=${row.lease_version};`,
  );
  const got = leaseForBot(row.bot);
  if (!got || got.owner_id !== owner_id || got.lease_version !== row.lease_version) {
    throw new Error('lease lost — re-checkout');
  }
  return {
    ok: true,
    bot: got.bot,
    expires_at_ms: got.expires_at_ms,
    lease_version: got.lease_version,
  };
}

/** @param {{ pool?: boolean, owner_id?: string }} opts */
export async function status(opts = {}) {
  const owner_id = opts.owner_id || ownerId();
  const now = Date.now();
  const pool = loadBotPool();
  if (!opts.pool) {
    const row = leaseForOwner(owner_id);
    return { ok: true, lease: row && row.expires_at_ms >= now ? row : null };
  }
  const bodies = [];
  for (const entry of Object.values(pool)) {
    const row = leaseForBot(entry.bot);
    const probe = await probeTask(entry.api_url);
    bodies.push({
      bot: entry.bot,
      api_url: entry.api_url,
      lease: row,
      busy: probe.busy,
      reachable: probe.reachable,
    });
  }
  return { ok: true, bodies };
}

/**
 * @param {string[]} positional
 * @param {{ json?: boolean }} globals
 */
export async function dispatchBotSubcommand(positional, globals = {}) {
  const sub = (positional[0] || 'help').toLowerCase();
  const args = positional.slice(1);
  const flags = { bot: null, ttl: null, force: false, asOperator: false, pool: false, near: null, cap: null, mark: null, owner: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bot' && args[i + 1]) flags.bot = args[++i];
    else if (a === '--ttl' && args[i + 1]) flags.ttl = Number(args[++i]);
    else if (a === '--force') flags.force = true;
    else if (a === '--as-operator') flags.asOperator = true;
    else if (a === '--pool') flags.pool = true;
    else if (a === '--near' && args[i + 1]) flags.near = args[++i];
    else if (a === '--cap' && args[i + 1]) flags.cap = args[++i];
    else if (a === '--mark' && args[i + 1]) flags.mark = args[++i];
    // --owner releases a SPECIFIC owner's lease (orphan reaping by an operator /
    // the genesis poller), instead of the caller's own env-derived owner. The
    // busy-probe in release() still applies, so an in-flight body is never stolen.
    else if (a === '--owner' && args[i + 1]) flags.owner = args[++i];
  }

  // --near X,Y,Z (comma-separated, e.g. --near 10,64,-20)
  let near;
  if (flags.near) {
    const [x, y, z] = String(flags.near).split(',').map((n) => Number(n.trim()));
    if (![x, y, z].every(Number.isFinite)) throw new Error('--near must be X,Y,Z (e.g. --near 10,64,-20)');
    near = { x, y, z };
  }

  let result;
  if (sub === 'checkout') {
    result = await checkout({
      bot: flags.bot || undefined,
      ttl: flags.ttl || undefined,
      near,
      cap: flags.cap || undefined,
      mark: flags.mark || undefined,
    });
  } else if (sub === 'release') {
    result = await release({ force: flags.force, asOperator: flags.asOperator, owner_id: flags.owner || undefined });
  } else if (sub === 'renew') {
    result = await renew({ ttl: flags.ttl || undefined });
  } else if (sub === 'status') {
    result = await status({ pool: flags.pool });
  } else {
    throw new Error(`mc bot: unknown subcommand '${sub}' (checkout|release|renew|status)`);
  }

  if (globals.json) {
    return { ok: result.ok !== false, env: { ok: result.ok !== false, command: `bot ${sub}`, data: result }, render: 'json' };
  }
  return { ok: result.ok !== false, env: result, render: 'json' };
}
