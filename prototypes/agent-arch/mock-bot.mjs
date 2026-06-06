#!/usr/bin/env node
// Mock Mineflayer bot HTTP server for the agent-architecture prototype.
//
// Listens on PROTO_MOCK_PORT (default 3091). State lives in-memory.
// Every request is appended to PROTO_MOCK_LOG (default /tmp/proto-mock.log).
//
// Response shapes mirror the canonical bot:
//   { ok: true,  data: <content> }
//   { ok: false, error: { code, message, observed_state, retry_safe } }
// per bot/lib/server/http-app.js and bot/cli/results.mjs.
//
// Movement model is deliberately simple: each /action/move steps the bot
// MOVE_STEP blocks toward the target. Once within ARRIVAL_RADIUS, return
// arrived:true. /action/dig consumes the block at the bot's current position
// from the blocks map and adds an item to inventory.
//
// Usage:
//   node mock-bot.mjs &                # background
//   curl http://127.0.0.1:3091/status?lean=true
//   kill $(cat /tmp/proto-mock.pid)    # stop

import http from 'node:http';
import fs from 'node:fs';
import { URL } from 'node:url';

const PORT = Number(process.env.PROTO_MOCK_PORT || 3091);
const LOG_PATH = process.env.PROTO_MOCK_LOG || '/tmp/proto-mock.log';
const PID_PATH = process.env.PROTO_MOCK_PID || '/tmp/proto-mock.pid';
const MOVE_STEP = 2;
const ARRIVAL_RADIUS = 1.5;

// Marks fixture — keep in sync with scenarios/*.txt and dsl_parse.
// Three named marks; coordinates chosen so the navigator can step there
// in a handful of /action/move calls.
const MARKS = {
  base_anchor: { x: 0, y: 64, z: 0, kind: 'anchor' },
  mine_nw: { x: 20, y: 60, z: 20, kind: 'mine' },
  ore_seam: { x: 22, y: 58, z: 22, kind: 'resource' },
};

// Initial state. The bot starts at base_anchor and has no items.
// `blocks` keys are "x,y,z" strings — used by /action/dig to know if there
// is anything to mine at the current position.
const state = {
  pos: { x: 0, y: 64, z: 0 },
  facing: 'south',
  hp: 20,
  food: 20,
  inventory: [],
  blocks: {
    '22,58,22': 'stone',
    '22,58,23': 'stone',
    '23,58,22': 'stone',
    '23,58,23': 'stone',
    '22,57,22': 'iron_ore',
  },
};

function logReq(method, path, body) {
  const line = `${new Date().toISOString()} ${method} ${path}` +
    (body ? ' ' + JSON.stringify(body) : '') + '\n';
  fs.appendFileSync(LOG_PATH, line);
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, data, result) {
  send(res, 200, result !== undefined ? { ok: true, data, result } : { ok: true, data });
}

function fail(res, status, code, message, retry_safe = false) {
  send(res, status, {
    ok: false,
    error: {
      code,
      message,
      observed_state: { pos: { ...state.pos }, hp: state.hp, food: state.food },
      retry_safe,
    },
  });
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function stepToward(target) {
  const cur = state.pos;
  const dx = target.x - cur.x;
  const dy = target.y - cur.y;
  const dz = target.z - cur.z;
  const dist = distance(cur, target);
  if (dist <= ARRIVAL_RADIUS) return true;
  const k = Math.min(MOVE_STEP, dist) / dist;
  state.pos = {
    x: Math.round((cur.x + dx * k) * 100) / 100,
    y: Math.round((cur.y + dy * k) * 100) / 100,
    z: Math.round((cur.z + dz * k) * 100) / 100,
  };
  return distance(state.pos, target) <= ARRIVAL_RADIUS;
}

function resolveTarget(body) {
  // /action/move accepts either {x,y,z} or {mark: "name"} or {at_mark: "name"}.
  if (body && typeof body === 'object') {
    if (body.x != null && body.y != null && body.z != null) {
      return { x: Number(body.x), y: Number(body.y), z: Number(body.z) };
    }
    const markName = body.mark || body.at_mark;
    if (markName && MARKS[markName]) {
      const m = MARKS[markName];
      return { x: m.x, y: m.y, z: m.z };
    }
  }
  return null;
}

function buildLeanStatus() {
  // Mirrors a strict subset of the real bot's /status?lean=true:
  // (bot/lib/runtime/observation.js getFullState). Fields chosen for what
  // the navigator + miner skill bundles read first.
  return {
    health: state.hp,
    food: state.food,
    saturation: 5,
    position: { ...state.pos },
    nav_header: {
      situation: 'walking',
      pos: { ...state.pos },
      nav_mode: 'walk',
      signals: [],
      computed_at: Date.now(),
    },
    time: 6000,
    holding: 'empty',
    mounted: false,
    supplies: buildSupplies(),
    nearby_entities: [],
    lookingAt: null,
    unreadChat: { count: 0, recent: [] },
  };
}

function buildSupplies() {
  // Brief inventory dict — name → count, capped.
  const dict = {};
  for (const item of state.inventory) {
    dict[item.name] = (dict[item.name] || 0) + item.count;
  }
  return dict;
}

function buildLeanObserve() {
  // Minimal /observe?lean=true. nav_brief.suggested is the field the
  // navigator bundle conditions on; we always nudge it toward mine_nw
  // for Phase 1 deterministic-test reasons.
  return {
    goals: [],
    task: null,
    recent_actions: [],
    nav_brief: {
      suggested: 'mine_nw',
      suggested_hint: 'closest known mark',
      computed_at: Date.now(),
    },
    landmarks: Object.entries(MARKS).map(([name, m]) => ({
      name,
      kind: m.kind,
      position: { x: m.x, y: m.y, z: m.z },
      distance: Math.round(distance(state.pos, { x: m.x, y: m.y, z: m.z })),
    })),
  };
}

function buildMarks() {
  return {
    marks: Object.entries(MARKS).map(([name, m]) => ({
      name,
      x: m.x,
      y: m.y,
      z: m.z,
      kind: m.kind,
    })),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8') || '';
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  let body = null;
  if (req.method !== 'GET') {
    try {
      body = await readBody(req);
    } catch {
      return fail(res, 400, 'BAD_JSON', 'request body is not valid JSON');
    }
  }
  logReq(req.method, path + url.search, body);

  // --- Read endpoints ---
  if (req.method === 'GET' && path === '/status') {
    return ok(res, buildLeanStatus());
  }
  if (req.method === 'GET' && path === '/observe') {
    return ok(res, buildLeanObserve());
  }
  if (req.method === 'GET' && path === '/inventory') {
    return ok(res, { items: state.inventory });
  }
  if (req.method === 'GET' && path === '/scene') {
    return ok(res, { entities: [], landmarks: buildLeanObserve().landmarks });
  }
  if (req.method === 'GET' && path === '/map') {
    return ok(res, { ascii: '. . . .\n. P . .\n. . M .\n. . . .', center: state.pos });
  }
  if (req.method === 'GET' && path === '/marks') {
    return ok(res, buildMarks());
  }
  if (req.method === 'GET' && path === '/alerts') {
    return ok(res, { alerts: [] });
  }

  // --- Action endpoints (POST /action/*) ---
  if (req.method === 'POST' && path === '/action/marks') {
    return ok(res, buildMarks());
  }
  if (req.method === 'POST' && (path === '/action/move' || path === '/action/goto' || path === '/action/goto_near')) {
    const startPos = { ...state.pos };
    const target = resolveTarget(body);
    if (!target) {
      return fail(res, 400, 'NAV_TARGET_MISSING', 'no target coordinates or mark provided');
    }
    const arrived = stepToward(target);
    return ok(res, {
      start_position: startPos,
      end_position: { ...state.pos },
      doors_used: [],
      legs: 1,
      moved: distance(startPos, state.pos) > 0.01,
      arrived,
      remaining: Math.round(distance(state.pos, target) * 10) / 10,
    }, arrived ? 'arrived' : 'in_progress');
  }
  if (req.method === 'POST' && path === '/action/dig') {
    const key = `${Math.round(state.pos.x)},${Math.round(state.pos.y)},${Math.round(state.pos.z)}`;
    const blockName = state.blocks[key];
    if (!blockName) {
      return fail(res, 200, 'NOTHING_TO_DIG',
        `no block to dig at ${key}; current inventory: ${state.inventory.length} items`);
    }
    delete state.blocks[key];
    const drop = blockName === 'iron_ore' ? 'raw_iron' : 'cobblestone';
    state.inventory.push({ name: drop, count: 1 });
    return ok(res, {
      block: blockName,
      drop,
      at: key,
      inventory_count: state.inventory.length,
    }, `dug ${blockName}`);
  }
  if (req.method === 'POST' && path === '/action/collect') {
    const want = (body && body.what) || 'cobblestone';
    const count = Math.max(1, Number(body?.count || 1));
    // Simulate collect by digging up to `count` adjacent blocks of any kind.
    let collected = 0;
    for (const key of Object.keys(state.blocks)) {
      if (collected >= count) break;
      delete state.blocks[key];
      state.inventory.push({ name: want, count: 1 });
      collected += 1;
    }
    return ok(res, {
      requested: want,
      requested_count: count,
      collected,
      inventory_count: state.inventory.length,
    }, `collected ${collected}/${count}`);
  }
  if (req.method === 'POST' && path === '/action/place') {
    return ok(res, { placed: true, at: { ...state.pos } }, 'placed');
  }
  if (req.method === 'POST' && path === '/action/stop') {
    return ok(res, { stopped: true });
  }
  if (req.method === 'POST' && path === '/action/chat') {
    const msg = body?.message ?? '';
    return ok(res, { sent: msg });
  }

  // Unknown
  return fail(res, 404, 'UNKNOWN_PATH', `${req.method} ${path} not implemented in mock`);
});

server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(PID_PATH, String(process.pid));
  process.stderr.write(`[mock-bot] listening on http://127.0.0.1:${PORT} (pid=${process.pid}, log=${LOG_PATH})\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { fs.unlinkSync(PID_PATH); } catch {}
    server.close(() => process.exit(0));
  });
}
