import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkout,
  release,
  renew,
  resolveLeaseUrl,
  ownerId,
  __testOnly_setTaskProbe,
  __testOnly_setHealthProbe,
  __testOnly_setStamp,
  __testOnly_setPool,
  loadBotPool,
} from '../../cli/lease-registry.mjs';
import { apiUrl, isNoActiveLease } from '../../cli/api-url.mjs';

describe('bot lease registry', () => {
  let tmpDb;
  const envKeys = [
    'HERMES_BOT_LEASE_DB',
    'HERMES_BOT_LEASE',
    'HERMES_KANBAN_TASK',
    'HERMES_KANBAN_BOARD',
    'HERMES_BOT_LEASE_ADMIN',
    'MC_API_URL',
    '_MC_API_URL_LOCKED',
  ];
  const saved = {};

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `bot-leases-test-${process.pid}-${Date.now()}.db`);
    for (const k of envKeys) saved[k] = process.env[k];
    process.env.HERMES_BOT_LEASE_DB = tmpDb;
    process.env.HERMES_BOT_LEASE = '1';
    delete process.env.MC_API_URL;
    delete process.env._MC_API_URL_LOCKED;
    __testOnly_setTaskProbe(async () => ({ busy: false, reachable: true }));
    __testOnly_setStamp(() => {}); // no-op: don't shell out to real `hermes` in tests
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __testOnly_setTaskProbe(null);
    __testOnly_setStamp(null);
    __testOnly_setPool(null);
    __testOnly_setHealthProbe(null);
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* ignore */
    }
  });

  it('loadBotPool includes mox and pip from registry', () => {
    const pool = loadBotPool();
    assert.ok(pool.mox);
    assert.ok(pool.pip);
    assert.equal(pool.mox.api_url, 'http://127.0.0.1:3007');
  });

  it('checkout and idempotent re-checkout same owner', async () => {
    process.env.HERMES_KANBAN_TASK = 't_a';
    const oid = ownerId();
    const a = await checkout({ bot: 'mox', ttl: 120 });
    assert.equal(a.ok, true);
    assert.equal(a.bot, 'mox');
    const b = await checkout({ bot: 'mox', ttl: 120 });
    assert.equal(b.ok, true);
    assert.equal(b.lease_version, a.lease_version);
    assert.equal(resolveLeaseUrl(oid), 'http://127.0.0.1:3007');
  });

  it('second owner cannot take same bot', async () => {
    process.env.HERMES_KANBAN_TASK = 't_one';
    await checkout({ bot: 'mox', ttl: 120 });
    const prevPid = process.env.HERMES_KANBAN_TASK;
    process.env.HERMES_KANBAN_TASK = 't_two';
    const other = await checkout({ bot: 'mox', ttl: 120 });
    assert.equal(other.ok, false);
    assert.match(String(other.error), /taken/);
    process.env.HERMES_KANBAN_TASK = prevPid;
  });

  it('release clears lease; resolve returns empty', async () => {
    process.env.HERMES_KANBAN_TASK = 't_rel';
    const oid = ownerId();
    await checkout({ bot: 'pip', ttl: 120 });
    await release();
    assert.equal(resolveLeaseUrl(oid), '');
  });

  it('renew fails after lease stolen', async () => {
    process.env.HERMES_KANBAN_TASK = 't_ren';
    const oid = ownerId();
    const c = await checkout({ bot: 'pip', ttl: 120 });
    const { execFileSync } = await import('node:child_process');
    execFileSync('sqlite3', [tmpDb, `DELETE FROM bot_leases WHERE bot='pip';`]);
    process.env.HERMES_KANBAN_TASK = 't_other';
    await checkout({ bot: 'pip', ttl: 120 });
    await assert.rejects(() => renew({ ttl: 300, owner_id: oid }), /no active bot lease|lease lost/);
    assert.ok(c.lease_version);
  });

  it('no free body defer includes holders and retry_after_ms', async () => {
    const pool = loadBotPool();
    const bots = Object.keys(pool);
    let i = 0;
    for (const b of bots) {
      process.env.HERMES_KANBAN_TASK = `t_h${i++}`;
      await checkout({ bot: b, ttl: 120 });
    }
    process.env.HERMES_KANBAN_TASK = 't_h_final';
    const d = await checkout({ ttl: 120 });
    assert.equal(d.ok, false);
    assert.match(String(d.error), /no free body/);
    assert.ok(d.retry_after_ms >= 2000);
    assert.ok(Array.isArray(d.holders));
  });

  it('TTL reclaim when expired and idle', async () => {
    process.env.HERMES_KANBAN_TASK = 't_old';
    await checkout({ bot: 'mox', ttl: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    process.env.HERMES_KANBAN_TASK = 't_new';
    const n = await checkout({ bot: 'mox', ttl: 120 });
    assert.equal(n.ok, true);
    assert.equal(n.bot, 'mox');
  });

  it('release refuses when busy unless force+operator', async () => {
    process.env.HERMES_KANBAN_TASK = 't_busy';
    await checkout({ bot: 'mox', ttl: 120 });
    __testOnly_setTaskProbe(async () => ({ busy: true, reachable: true }));
    await assert.rejects(() => release(), /busy/);
    await assert.rejects(
      () => release({ force: true, asOperator: true }),
      /HERMES_BOT_LEASE_ADMIN/,
    );
    process.env.HERMES_BOT_LEASE_ADMIN = '1';
    const r = await release({ force: true, asOperator: true });
    assert.equal(r.ok, true);
  });

  // ── D1: --near nearest-free ──────────────────────────────────────────────
  it('checkout --near picks the nearest free body', async () => {
    __testOnly_setPool(() => ({
      near1: { bot: 'near1', api_url: 'http://127.0.0.1:4001', username: 'N', port: 4001, caps: null },
      far1: { bot: 'far1', api_url: 'http://127.0.0.1:4002', username: 'F', port: 4002, caps: null },
    }));
    __testOnly_setHealthProbe(async (url) =>
      url.includes('4001') ? { position: { x: 0, y: 0, z: 0 } } : { position: { x: 100, y: 0, z: 0 } },
    );
    process.env.HERMES_KANBAN_TASK = 't_near';
    const r = await checkout({ near: { x: 2, y: 0, z: 0 }, ttl: 120 });
    assert.equal(r.ok, true);
    assert.equal(r.bot, 'near1');
  });

  // ── D2: --cap capability filter ──────────────────────────────────────────
  it('checkout --cap excludes incapable bodies', async () => {
    __testOnly_setPool(() => ({
      miner: { bot: 'miner', api_url: 'http://127.0.0.1:4001', username: 'M', port: 4001, caps: ['mine'] },
      builder: { bot: 'builder', api_url: 'http://127.0.0.1:4002', username: 'B', port: 4002, caps: ['build'] },
    }));
    process.env.HERMES_KANBAN_TASK = 't_cap1';
    const r = await checkout({ cap: 'mine', ttl: 120 });
    assert.equal(r.ok, true);
    assert.equal(r.bot, 'miner');
  });

  it('body with no caps passes any --cap (universal)', async () => {
    __testOnly_setPool(() => ({
      generic: { bot: 'generic', api_url: 'http://127.0.0.1:4003', username: 'G', port: 4003, caps: null },
    }));
    process.env.HERMES_KANBAN_TASK = 't_cap2';
    const r = await checkout({ cap: 'mine', ttl: 120 });
    assert.equal(r.ok, true);
    assert.equal(r.bot, 'generic');
  });

  // ── D3: --mark continuity (overrides LRL) ────────────────────────────────
  it('checkout --mark prefers the body that last worked that mark', async () => {
    __testOnly_setPool(() => ({
      a: { bot: 'a', api_url: 'http://127.0.0.1:4001', username: 'A', port: 4001, caps: null },
      b: { bot: 'b', api_url: 'http://127.0.0.1:4002', username: 'B', port: 4002, caps: null },
    }));
    // Mark the lexically-LATER body 'b' with m1, so continuity must override the
    // lexical tie-break (which otherwise picks 'a').
    process.env.HERMES_KANBAN_TASK = 't_seed_b';
    await checkout({ bot: 'b', mark: 'm1', ttl: 120 });
    await release();
    // Plain checkout (no mark) → lexical → 'a'.
    process.env.HERMES_KANBAN_TASK = 't_plain';
    const plain = await checkout({ ttl: 120 });
    assert.equal(plain.bot, 'a');
    await release();
    // --mark m1 → continuity picks 'b' despite lexical preferring 'a'.
    process.env.HERMES_KANBAN_TASK = 't_cont';
    const cont = await checkout({ mark: 'm1', ttl: 120 });
    assert.equal(cont.bot, 'b');
  });

  // ── D4: kanban audit stamp ───────────────────────────────────────────────
  it('stamps the card on checkout; a failing stamp does not fail checkout', async () => {
    let captured = null;
    __testOnly_setStamp((info) => {
      captured = info;
      throw new Error('stamp boom'); // best-effort: must be swallowed
    });
    process.env.HERMES_KANBAN_TASK = 't_stamp';
    process.env.HERMES_KANBAN_BOARD = 'genesis-v2';
    const r = await checkout({ bot: 'mox', ttl: 120 });
    assert.equal(r.ok, true);
    assert.ok(captured, 'stamp was invoked');
    assert.equal(captured.bot, 'mox');
    assert.equal(captured.task, 't_stamp');
    assert.equal(captured.board, 'genesis-v2');
  });
});

describe('apiUrl lease mode', () => {
  const envKeys = ['HERMES_BOT_LEASE', 'HERMES_BOT_LEASE_DB', 'HERMES_KANBAN_TASK', 'MC_API_URL'];
  const saved = {};
  let tmpDb;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `bot-leases-api-${process.pid}-${Date.now()}.db`);
    for (const k of envKeys) saved[k] = process.env[k];
    process.env.HERMES_BOT_LEASE = '1';
    process.env.HERMES_BOT_LEASE_DB = tmpDb;
    delete process.env.MC_API_URL;
    __testOnly_setTaskProbe(async () => ({ busy: false, reachable: true }));
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __testOnly_setTaskProbe(null);
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* ignore */
    }
  });

  it('returns no lease sentinel without checkout', () => {
    delete process.env.HERMES_KANBAN_TASK;
    assert.equal(isNoActiveLease(apiUrl()), true);
  });

  it('prefers MC_API_URL when set even in lease mode', () => {
    process.env.MC_API_URL = 'http://localhost:3999';
    assert.equal(apiUrl(), 'http://localhost:3999');
  });
});
