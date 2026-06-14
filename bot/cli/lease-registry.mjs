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

const DEFAULT_TTL_S = 3600;
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

/** @returns {Record<string, { bot: string, api_url: string, username: string, port: number }>} */
export function loadBotPool() {
  const dir = path.join(REPO_ROOT, 'data', 'bots');
  /** @type {Record<string, { bot: string, api_url: string, username: string, port: number }>} */
  const pool = {};
  if (!fs.existsSync(dir)) return pool;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.yaml')) continue;
    const bot = name.replace(/\.yaml$/, '').toLowerCase();
    const raw = fs.readFileSync(path.join(dir, name), 'utf8');
    const doc = yaml.parse(raw);
    const port = Number(doc?.api_port);
    if (!Number.isFinite(port)) continue;
    pool[bot] = {
      bot,
      api_url: `http://127.0.0.1:${port}`,
      username: String(doc?.username || bot),
      port,
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
  if (row.expires_at_ms < Date.now()) return NO_LELEASE;
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

function sortCandidates(candidates, leasedRows) {
  const byBot = Object.fromEntries(leasedRows.map((r) => [r.bot, r]));
  return [...candidates].sort((a, b) => {
    const la = byBot[a.bot]?.leased_at_ms ?? 0;
    const lb = byBot[b.bot]?.leased_at_ms ?? 0;
    const aNull = la === 0;
    const bNull = lb === 0;
    if (aNull !== bNull) return aNull ? -1 : 1;
    if (la !== lb) return la - lb;
    return a.bot.localeCompare(b.bot);
  });
}

/**
 * @param {{ bot?: string, ttl?: number, profile?: string }} opts
 */
export async function checkout(opts = {}) {
  const owner_id = requireOwnerForMutation();
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

  const ordered = sortCandidates(free.length ? free : candidates, leasedRows);

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
  const flags = { bot: null, ttl: null, force: false, asOperator: false, pool: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bot' && args[i + 1]) flags.bot = args[++i];
    else if (a === '--ttl' && args[i + 1]) flags.ttl = Number(args[++i]);
    else if (a === '--force') flags.force = true;
    else if (a === '--as-operator') flags.asOperator = true;
    else if (a === '--pool') flags.pool = true;
    else if (a === '--near' || a === '--cap' || a === '--mark') {
      throw new Error(`${a} not implemented in MVP — see docs/architecture/bot-lease.md § Deferred`);
    }
  }

  let result;
  if (sub === 'checkout') {
    result = await checkout({ bot: flags.bot || undefined, ttl: flags.ttl || undefined });
  } else if (sub === 'release') {
    result = await release({ force: flags.force, asOperator: flags.asOperator });
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
