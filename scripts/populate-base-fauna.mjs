#!/usr/bin/env node
// Scatter passive mobs and food crops around a region (default `:base:`).
//
// Talks to the Paper server over PaperMCP (WebSocket on PAPERMCP_HOST:PORT,
// auth token from .env / shell). Reads the target region from
// data/regions-world.json so it picks up whatever the placemark sign produced.
//
// Usage:
//   scripts/populate-base-fauna.mjs                       # default multiplier 1
//   scripts/populate-base-fauna.mjs --multiplier 2        # 2x radius, 2x count
//   scripts/populate-base-fauna.mjs --region hut3         # different region
//   scripts/populate-base-fauna.mjs --include-fish        # also try salmon/cod
//
// Vegetables only land where the floor block is already minecraft:grass_block
// (grass → farmland → crop, all gated by `execute if block`). Berries place
// directly on grass. Misses leave terrain untouched. No raw food items, no
// floating drops — only growing/harvestable blocks and animals.
//   scripts/populate-base-fauna.mjs --inner-exclude 12    # keep N blocks around anchor clear
//   scripts/populate-base-fauna.mjs --anchor 366,65,-593  # override region anchor
//   scripts/populate-base-fauna.mjs --radius 24           # override region radius (then scaled by --multiplier)
//   scripts/populate-base-fauna.mjs --dry-run             # print commands only
//   scripts/populate-base-fauna.mjs --seed 42             # reproducible scatter

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ANIMALS = { pig: 8, chicken: 12, cow: 8, sheep: 6 };
const PLANTS = { carrots: 20, potatoes: 20, beetroots: 12, sweet_berry_bush: 15 };
const FISH = { salmon: 5, cod: 5 };

function usage() {
  process.stdout.write(`populate-base-fauna — scatter animals + crops around a region

Usage: scripts/populate-base-fauna.mjs [options]

Options:
  --multiplier N      Scale radius and counts (default 1.0)
  --region ID         Region id from regions-world.json (default: base)
  --include-fish      Also summon salmon/cod (default off — they die without water)
  --no-soil-prep      DEPRECATED no-op (crops are always gated to grass blocks)
  --inner-exclude N   Skip placements within N blocks of anchor (default 0; absolute,
                      not scaled by --multiplier). Useful to leave the base interior alone.
  --anchor X,Y,Z      Override region anchor (e.g. when the sign isn't at the true center)
  --radius N          Override region radius before multiplier is applied
  --dry-run           Print commands without sending
  --seed N            Reproducible scatter (default: time-based)
  --help, -h          Show this help

Reads:
  data/regions-world.json       region anchor + radius
  .env or shell env             PAPERMCP_HOST, PAPERMCP_PORT, PAPERMCP_TOKEN
`);
}

function parseArgs(argv) {
  const opts = {
    multiplier: 1.0,
    region: 'base',
    includeFish: false,
    soilPrep: true,
    innerExclude: 0,
    anchorOverride: null,
    radiusOverride: null,
    dryRun: false,
    seed: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--multiplier') opts.multiplier = Number(argv[++i]);
    else if (a === '--region') opts.region = String(argv[++i]).toLowerCase();
    else if (a === '--include-fish') opts.includeFish = true;
    else if (a === '--no-soil-prep') opts.soilPrep = false;
    else if (a === '--inner-exclude') opts.innerExclude = Number(argv[++i]);
    else if (a === '--anchor') {
      const parts = String(argv[++i]).split(',').map((s) => Number(s.trim()));
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error('--anchor must be "X,Y,Z" with three numbers');
      }
      opts.anchorOverride = { x: parts[0], y: parts[1], z: parts[2] };
    }
    else if (a === '--radius') opts.radiusOverride = Number(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else { process.stderr.write(`unknown arg: ${a}\n`); usage(); process.exit(2); }
  }
  if (!Number.isFinite(opts.multiplier) || opts.multiplier <= 0) {
    throw new Error('--multiplier must be a positive number');
  }
  if (!Number.isFinite(opts.innerExclude) || opts.innerExclude < 0) {
    throw new Error('--inner-exclude must be ≥ 0');
  }
  return opts;
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

function readRegion(id) {
  const file = path.join(REPO_ROOT, 'data/regions-world.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = (json.regions || []).find((x) => String(x.id).toLowerCase() === id);
  if (!r) {
    const ids = (json.regions || []).map((x) => x.id).join(', ');
    throw new Error(`region :${id}: not found in ${file} — place the sign first or pick another (have: ${ids})`);
  }
  if (!r.anchor || r.anchor.x == null) {
    throw new Error(`region :${id}: has no anchor — sign may not have been read by listener yet`);
  }
  const radius = r.shape?.radius ?? 16;
  return { anchor: r.anchor, radius, shape: r.shape };
}

// Mulberry32 — small reproducible PRNG.
function mulberry32(seed) {
  let s = (seed >>> 0) || 0x9E3779B9;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uniformAnnulus(rng, rMin, rMax) {
  // Inverse-CDF for area-uniform sampling: r = sqrt(u·(rMax² − rMin²) + rMin²).
  const r = Math.sqrt(rng() * (rMax * rMax - rMin * rMin) + rMin * rMin);
  const t = 2 * Math.PI * rng();
  return [Math.round(r * Math.cos(t)), Math.round(r * Math.sin(t))];
}

function buildCommands(opts, region) {
  const rng = mulberry32(opts.seed ?? Date.now());
  const rMax = Math.max(1, Math.round(region.radius * opts.multiplier));
  const rMin = Math.min(opts.innerExclude, rMax - 1);
  const { x: ax, y: ay, z: az } = region.anchor;
  const cmds = [];
  const summary = {};

  const scale = (n) => Math.max(1, Math.round(n * opts.multiplier));
  const scatter = () => uniformAnnulus(rng, rMin, rMax);

  for (const [entity, base] of Object.entries(ANIMALS)) {
    const n = scale(base);
    summary[entity] = n;
    for (let i = 0; i < n; i++) {
      const [dx, dz] = scatter();
      cmds.push(`summon minecraft:${entity} ${ax + dx} ${ay + 1} ${az + dz}`);
    }
  }

  // Vegetables only land on existing grass_block. The first `execute if` flips
  // grass→farmland (gated), the second places the crop (gated on the now-present
  // farmland) so misses leave the terrain untouched. Berries grow on grass
  // directly, so a single gated setblock suffices.
  for (const [crop, base] of Object.entries(PLANTS)) {
    const n = scale(base);
    summary[crop] = n;
    for (let i = 0; i < n; i++) {
      const [dx, dz] = scatter();
      const x = ax + dx;
      const z = az + dz;
      if (crop === 'sweet_berry_bush') {
        cmds.push(`execute if block ${x} ${ay} ${z} minecraft:grass_block run setblock ${x} ${ay + 1} ${z} minecraft:sweet_berry_bush[age=3]`);
      } else {
        const stateByCrop = { carrots: '[age=7]', potatoes: '[age=7]', beetroots: '[age=3]' };
        cmds.push(`execute if block ${x} ${ay} ${z} minecraft:grass_block run setblock ${x} ${ay} ${z} minecraft:farmland[moisture=7]`);
        cmds.push(`execute if block ${x} ${ay} ${z} minecraft:farmland run setblock ${x} ${ay + 1} ${z} minecraft:${crop}${stateByCrop[crop] || ''}`);
      }
    }
  }

  if (opts.includeFish) {
    for (const [fish, base] of Object.entries(FISH)) {
      const n = scale(base);
      summary[fish] = n;
      for (let i = 0; i < n; i++) {
        const [dx, dz] = scatter();
        cmds.push(`summon minecraft:${fish} ${ax + dx} ${ay + 3} ${az + dz}`);
      }
    }
  }

  return { cmds, summary, rMax, rMin };
}

function openSocket(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PaperMCP connect timeout: ${url}`)), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e?.message ? new Error(e.message) : new Error('ws error')); });
  });
}

async function runBatch(ws, token, cmds) {
  const pending = new Map();
  let nextId = 1;
  let authResolve;
  const authReady = new Promise((res) => { authResolve = res; });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
    catch { return; }
    if (msg.type === 'auth_response') { authResolve(msg); return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  ws.send(JSON.stringify({ type: 'authenticate', token }));
  const authResp = await Promise.race([
    authReady,
    new Promise((_, rej) => setTimeout(() => rej(new Error('auth timeout')), 5000)),
  ]);
  if (!authResp.success) throw new Error(`PaperMCP auth failed: ${authResp.message || 'invalid token'}`);

  let ok = 0, fail = 0;
  const failures = [];
  // Modest concurrency — server is single-threaded for commands anyway.
  const concurrency = 8;
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < cmds.length) {
      const my = idx++;
      const cmd = cmds[my];
      const id = nextId++;
      const p = new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error('rpc timeout')); }, 10000);
        pending.set(id, {
          resolve: (msg) => { clearTimeout(t); resolve(msg); },
        });
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'execute_command', params: { command: cmd } }));
      try {
        const resp = await p;
        if (resp.error) { fail++; failures.push({ cmd, error: resp.error.message || JSON.stringify(resp.error) }); }
        else ok++;
      } catch (e) {
        fail++; failures.push({ cmd, error: e.message });
      }
    }
  });
  await Promise.all(workers);
  return { ok, fail, failures };
}

async function main() {
  const opts = parseArgs(process.argv);
  loadDotEnv(path.join(REPO_ROOT, '.env'));

  let region;
  if (opts.anchorOverride && opts.radiusOverride != null) {
    region = { anchor: opts.anchorOverride, radius: opts.radiusOverride, shape: null };
  } else {
    region = readRegion(opts.region);
    if (opts.anchorOverride) region.anchor = opts.anchorOverride;
    if (opts.radiusOverride != null) region.radius = opts.radiusOverride;
  }
  const { cmds, summary, rMax, rMin } = buildCommands(opts, region);

  const dist = Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(' ');
  const { anchor } = region;
  const ringDesc = rMin > 0 ? `annulus ${rMin}..${rMax}` : `radius ${rMax}`;
  process.stdout.write(`region :${opts.region}: anchor=(${anchor.x},${anchor.y},${anchor.z}) ${ringDesc} (base*${opts.multiplier})\n`);
  process.stdout.write(`${dist}\n`);
  process.stdout.write(`${cmds.length} commands prepared (vegetables gated to grass blocks, fish=${opts.includeFish})\n`);

  if (opts.dryRun) {
    for (const c of cmds) process.stdout.write(`${c}\n`);
    return;
  }

  const host = process.env.PAPERMCP_HOST || process.env.MC_HOST || '192.168.1.202';
  const port = Number(process.env.PAPERMCP_PORT || 25577);
  const token = process.env.PAPERMCP_TOKEN;
  if (!token) throw new Error('PAPERMCP_TOKEN not set — add to .env or shell env');

  const url = `ws://${host}:${port}`;
  process.stdout.write(`connecting ${url} ...\n`);
  const ws = await openSocket(url);
  let result;
  try {
    result = await runBatch(ws, token, cmds);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
  process.stdout.write(`done: ${result.ok} ok, ${result.fail} failed\n`);
  if (result.fail) {
    const sample = result.failures.slice(0, 5);
    for (const f of sample) process.stderr.write(`FAIL ${f.cmd}\n  → ${f.error}\n`);
    if (result.failures.length > sample.length) {
      process.stderr.write(`(${result.failures.length - sample.length} more failures suppressed)\n`);
    }
  }
}

main().catch((e) => { process.stderr.write(`${e.stack || e.message || e}\n`); process.exit(1); });
