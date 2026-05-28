#!/usr/bin/env node
// scripts/system-chest.mjs — manage the in-world "system_chest" at base.
//
// The system_chest is a single, well-known dropoff chest near base that
// is written ONLY by ops scripts (this one), and READ by bots. Bots may
// withdraw, but should not deposit into it — keeps a clear stock that
// scripts/players can refill without contention from worker bots.
//
// Coordinates and CustomName are hardcoded so the location is part of
// the contract — change them only if you also update skills/MANIFEST docs.
//
// Subcommands:
//   place                          # create the chest + wall sign (idempotent)
//   fill [--manifest path.json]    # fill from manifest (default: built-in)
//   show                           # dump current contents via /data get
//   help
//
// Built-in default manifest: tools + food + wood (the "first restock" set).
//
// Run:
//   scripts/system-chest.mjs place
//   scripts/system-chest.mjs fill
//   scripts/system-chest.mjs fill --manifest /path/to/restock.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Contract (do not change without doc updates) ──────────────────────
// Per-run coords: genesis sets SYSTEM_CHEST_{PRIMARY,OTHER,SIGN}_{X,Y,Z} (ints).
// Fallback: legacy hardcoded production base coords.
function envCoord(role, axis, fallback) {
  const key = `SYSTEM_CHEST_${role}_${axis}`;
  const v = process.env[key];
  if (v !== undefined && v !== '') {
    const n = parseInt(v, 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

const DEFAULT_PRIMARY = { x: 366, y: 65, z: -594 };
const DEFAULT_OTHER = { x: 365, y: 65, z: -594 };
const DEFAULT_SIGN = { x: 366, y: 66, z: -594 };

const SYSTEM_CHEST = {
  primary: {
    x: envCoord('PRIMARY', 'X', DEFAULT_PRIMARY.x),
    y: envCoord('PRIMARY', 'Y', DEFAULT_PRIMARY.y),
    z: envCoord('PRIMARY', 'Z', DEFAULT_PRIMARY.z),
  },
  other: {
    x: envCoord('OTHER', 'X', DEFAULT_OTHER.x),
    y: envCoord('OTHER', 'Y', DEFAULT_OTHER.y),
    z: envCoord('OTHER', 'Z', DEFAULT_OTHER.z),
  },
  name: 'system_chest',
};
const SYSTEM_SIGN = {
  x: envCoord('SIGN', 'X', DEFAULT_SIGN.x),
  y: envCoord('SIGN', 'Y', DEFAULT_SIGN.y),
  z: envCoord('SIGN', 'Z', DEFAULT_SIGN.z),
};

// ── Built-in default manifest ─────────────────────────────────────────
// [slot, item, count] tuples. `slot` is informational (mc deposit lets the
// bot pick free slots), but kept for clarity + future direct-NBT support.
// Total slot footprint matters: a double chest has 54 slots, and
// non-stackable tools take 1 slot each per item (8 wooden_pickaxe = 8 slots,
// NOT 1). Stay ≤ 50 slots so re-runs have headroom for transient drift.
const DEFAULT_MANIFEST = [
  // Tools (~20 slots)
  [0,  'stone_pickaxe', 2],     // 2 slots
  [1,  'stone_axe', 2],         // 2
  [2,  'stone_shovel', 2],      // 2
  [3,  'stone_hoe', 2],         // 2
  [4,  'iron_pickaxe', 1],      // 1
  [5,  'iron_axe', 1],          // 1
  [6,  'iron_sword', 1],        // 1
  [7,  'wooden_pickaxe', 2],    // 2
  [8,  'wooden_axe', 2],        // 2
  [9,  'bucket', 4],            // 1 stack (buckets stack to 16)
  [10, 'fishing_rod', 1],       // 1
  [11, 'shears', 1],            // 1
  [12, 'torch', 64],            // 1 stack
  [13, 'flint_and_steel', 1],   // 1
  // Food (6 slots)
  [14, 'bread', 64],
  [15, 'cooked_beef', 64],
  [16, 'cooked_chicken', 64],
  [17, 'baked_potato', 64],
  [18, 'carrot', 64],
  [19, 'golden_apple', 8],
  // Wood — "lots" (16 stacks = 1024 of mixed wood)
  [20, 'oak_log', 64],
  [21, 'oak_log', 64],
  [22, 'oak_log', 64],
  [23, 'oak_log', 64],
  [24, 'oak_planks', 64],
  [25, 'oak_planks', 64],
  [26, 'oak_planks', 64],
  [27, 'oak_planks', 64],
  [28, 'spruce_log', 64],
  [29, 'spruce_log', 64],
  [30, 'birch_log', 64],
  [31, 'birch_log', 64],
  [32, 'oak_stairs', 64],
  [33, 'oak_slab', 64],
  [34, 'oak_fence', 64],
  [35, 'oak_sapling', 64],
];

// ── .env loader (PAPERMCP_TOKEN lives in repo .env) ───────────────────
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

// ── PaperMCP WebSocket client ─────────────────────────────────────────
// All RPC goes through client.send(cmd) — pure WebSocket JSON-RPC, no shell.
async function connect(host, port, token) {
  const ws = new WebSocket(`ws://${host}:${port}`);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`ws connect timeout: ${host}:${port}`)), 5000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', (e) => { clearTimeout(t); rej(e?.message ? new Error(e.message) : new Error('ws error')); });
  });
  const authReady = new Promise((res) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.type === 'auth_response') { ws.removeEventListener('message', onMsg); res(m); }
    };
    ws.addEventListener('message', onMsg);
  });
  ws.send(JSON.stringify({ type: 'authenticate', token }));
  const auth = await Promise.race([
    authReady,
    new Promise((_, rej) => setTimeout(() => rej(new Error('auth timeout')), 5000)),
  ]);
  if (!auth.success) throw new Error(`PaperMCP auth failed: ${auth.message}`);

  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data.toString());
    if (m.id != null && pending.has(m.id)) {
      const { resolve } = pending.get(m.id);
      pending.delete(m.id);
      resolve(m);
    }
  });
  const send = (cmd) => {
    const id = nextId++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { pending.delete(id); rej(new Error('rpc timeout')); }, 10000);
      pending.set(id, { resolve: (m) => { clearTimeout(t); res(m); } });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'execute_command', params: { command: cmd } }));
    });
  };
  return { ws, send, close: () => ws.close() };
}

// ── Subcommands ───────────────────────────────────────────────────────
async function cmdPlace(client) {
  const { primary, other, name } = SYSTEM_CHEST;
  // Double chest: two adjacent chests with same facing form one inventory.
  // facing=south, primary at (366,_,-594), other at (365,_,-594).
  // type=left/right names the half relative to the facing direction.
  const customName = `{CustomName:'{"text":"${name}","color":"gold"}'}`;
  for (const [half, coord, type] of [['primary', primary, 'left'], ['other', other, 'right']]) {
    const cmd = `setblock ${coord.x} ${coord.y} ${coord.z} minecraft:chest[facing=south,type=${type}]${customName} replace`;
    const r = await client.send(cmd);
    if (r.error) { process.stderr.write(`chest setblock (${half}) failed: ${r.error.message || JSON.stringify(r.error)}\n`); process.exit(1); }
    process.stdout.write(`✓ placed chest ${half} at (${coord.x},${coord.y},${coord.z})\n`);
  }

  // Standing sign above the primary half.
  const sx = SYSTEM_SIGN.x, sy = SYSTEM_SIGN.y, sz = SYSTEM_SIGN.z;
  const signCmd = `setblock ${sx} ${sy} ${sz} minecraft:oak_sign[rotation=0]{front_text:{messages:['{"text":"system_chest"}','{"text":"WRITE: scripts only"}','{"text":"READ: bots OK"}','{"text":"see skills/"}']}}`;
  const r2 = await client.send(signCmd);
  if (r2.error) process.stderr.write(`sign setblock failed (non-fatal): ${r2.error.message || JSON.stringify(r2.error)}\n`);
  else process.stdout.write(`✓ placed sign at (${sx},${sy},${sz})\n`);
}

function loadManifest(p) {
  if (!p) return DEFAULT_MANIFEST;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('manifest must be a JSON array of [slot, item, count] tuples');
  return raw;
}

// Default service bot for fill. Must be online + close to the chest. Steward
// is the natural pick (lives at base, read-only orchestrator otherwise idle).
const FILL_BOT = { name: 'Steward', api: 'http://localhost:3005' };

async function botPost(api, path, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await r.json();
  } finally { clearTimeout(t); }
}

async function cmdFill(client, manifestPath) {
  const { primary, other, name } = SYSTEM_CHEST;
  const { x, y, z } = primary;
  const items = loadManifest(manifestPath);

  // RESET first — script owns this chest exclusively, so fill semantics
  // are "replace contents with manifest". Re-placing both halves wipes
  // them clean. This makes re-runs idempotent.
  const customName = `{CustomName:'{"text":"${name}","color":"gold"}'}`;
  for (const [coord, type] of [[primary, 'left'], [other, 'right']]) {
    await client.send(`setblock ${coord.x} ${coord.y} ${coord.z} minecraft:chest[facing=south,type=${type}]${customName} replace`);
  }
  await new Promise((r) => setTimeout(r, 300));

  // PaperMCP's allowlist blocks /item replace block and silently drops
  // Items NBT in setblock for MC 1.21+ chests (component-based item NBT).
  // Workable path: give items to a service bot via /give, then have the
  // bot mc deposit them into the chest. The bot must be standing within
  // reach of the chest (~4 blocks).
  //
  // Service bot: Steward. We first TP Steward adjacent to the chest, then
  // give + deposit each manifest entry. Steward is read-only/orchestrator
  // so yanking her briefly doesn't disrupt worker pipelines.
  //
  // After: leave Steward where she landed (a step from the chest). Caller
  // can re-position via `scripts/landfolk fix tp steward …` if needed.

  process.stdout.write(`fill via ${FILL_BOT.name} (${FILL_BOT.api}) — ${items.length} stacks\n`);

  // TP service bot adjacent (one east of the chest, facing west toward it).
  const tpCmd = `tp ${FILL_BOT.name} ${x + 1} ${y} ${z} -90 0`;
  const tpRes = await client.send(tpCmd);
  if (tpRes.error) {
    process.stderr.write(`tp failed: ${tpRes.error.message || JSON.stringify(tpRes.error)}\n`);
    process.exit(1);
  }
  // Wipe the service bot's inventory so leftovers from a prior failed fill
  // don't get re-deposited (and so we have free slots for the give).
  await client.send(`clear ${FILL_BOT.name}`);
  await new Promise((r) => setTimeout(r, 1500));

  let ok = 0, fail = 0;
  for (const [slot, item, count] of items) {
    // 1. /give Steward the item
    const giveCmd = `give ${FILL_BOT.name} minecraft:${item} ${count}`;
    const giveRes = await client.send(giveCmd);
    if (giveRes.error) {
      fail++;
      process.stderr.write(`  give ${item}×${count} failed: ${giveRes.error.message || JSON.stringify(giveRes.error)}\n`);
      continue;
    }
    // 2. mc deposit item count x y z (count=0 = all of that item)
    const depRes = await botPost(FILL_BOT.api, '/action/deposit', { item, count, x, y, z });
    if (!depRes.ok) {
      fail++;
      process.stderr.write(`  deposit ${item}×${count}: ${depRes.error?.message || depRes.result || JSON.stringify(depRes)}\n`);
      continue;
    }
    ok++;
  }
  process.stdout.write(`${name} @ (${x},${y},${z}) — ${ok}/${items.length} deposited, ${fail} failed.\n`);
  if (fail > 0) process.exit(2);

  // Verify the chest actually has contents. `mc deposit` returns ok when
  // the bot's action ran, NOT when items landed in the chest. If the
  // chest's chunk isn't loaded or the bot's path to the chest is blocked,
  // deposit reports ok with zero items written. Observed g-2026-05-28-1:
  // 33 deposits reported ok, chest verified empty by Mason. Catch it here
  // before bots build on top of a broken setup.
  await new Promise((r) => setTimeout(r, 1500));
  const verifyRes = await botPost(FILL_BOT.api, '/action/list_container', { x, y, z });
  const verifyStr = String(verifyRes.result || '');
  const stacks = verifyStr.startsWith('Container:')
    ? verifyStr.slice('Container:'.length).split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  process.stdout.write(`verify: chest has ${stacks.length} stacks\n`);
  if (stacks.length === 0 && items.length > 0) {
    process.stderr.write(
      `fill verify FAILED: chest at (${x},${y},${z}) empty after ${items.length} deposit ops.\n` +
      `Likely cause: chunk not loaded when fill ran, or service bot was not in reach.\n` +
      `Retry fill in 5s, or run scripts/system-chest.mjs show to inspect.\n`
    );
    process.exit(3);
  }
}

async function cmdShow(client) {
  // /data get is blocked by PaperMCP allowlist — query the bot's
  // list_container action instead. Service bot must be in reach.
  const { primary } = SYSTEM_CHEST;
  const { x, y, z } = primary;
  const tpRes = await client.send(`tp ${FILL_BOT.name} ${x + 1} ${y} ${z} -90 0`);
  if (tpRes.error) {
    process.stderr.write(`tp service bot failed: ${tpRes.error.message || JSON.stringify(tpRes.error)}\n`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1200));
  const res = await botPost(FILL_BOT.api, '/action/list_container', { x, y, z });
  // list_container's response shape: result is a human string
  // "Container: stackx64, stackx64, …" and data.items / .contents may be
  // empty depending on bot version. Parse the result string for the count.
  const resultStr = String(res.result || '');
  const stacks = resultStr.startsWith('Container:')
    ? resultStr.slice('Container:'.length).split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  process.stdout.write(`${SYSTEM_CHEST.name} @ (${x},${y},${z}) — ${stacks.length} stacks:\n`);
  for (const s of stacks) process.stdout.write(`  ${s}\n`);
}

function usage() {
  process.stdout.write(`system-chest — manage the base dropoff chest at (${SYSTEM_CHEST.x},${SYSTEM_CHEST.y},${SYSTEM_CHEST.z})

  scripts/system-chest.mjs place                  # idempotent
  scripts/system-chest.mjs fill [--manifest F]    # default: tools + food + wood
  scripts/system-chest.mjs show
  scripts/system-chest.mjs help

Manifest format (JSON): [[slot, item, count], …]   slot in 0..26
`);
}

async function main() {
  const args = process.argv.slice(2);
  const sub = args[0] || 'help';
  if (sub === 'help' || sub === '-h' || sub === '--help') { usage(); return; }

  loadDotEnv(path.join(REPO_ROOT, '.env'));
  const host = process.env.PAPERMCP_HOST || process.env.MC_HOST || '192.168.1.202';
  const port = Number(process.env.PAPERMCP_PORT || 25577);
  const token = process.env.PAPERMCP_TOKEN;
  if (!token) { process.stderr.write('PAPERMCP_TOKEN not set (.env or shell)\n'); process.exit(1); }

  const client = await connect(host, port, token);
  try {
    if (sub === 'place') await cmdPlace(client);
    else if (sub === 'fill') {
      const mi = args.indexOf('--manifest');
      const manifestPath = mi >= 0 ? args[mi + 1] : null;
      await cmdFill(client, manifestPath);
    } else if (sub === 'show') await cmdShow(client);
    else { process.stderr.write(`unknown subcommand: ${sub}\n\n`); usage(); process.exit(2); }
  } finally {
    client.close();
  }
}
main().catch((e) => { process.stderr.write(`${e.stack || e.message}\n`); process.exit(1); });
