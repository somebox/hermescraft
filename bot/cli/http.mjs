/**
 * HTTP wrapper: timeouts (read vs action), retries on GET unreachable only.
 *
 * Long actions (`/action/collect`, dig, pathfinding pickups, …) can exceed the default action
 * budget while the server still succeeds — bump those paths or override via env below.
 */

function boundedMs(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const READ_DEADLINE_MS = boundedMs('MC_HTTP_READ_MS', 8000, 1000, 120_000);
const ACTION_DEADLINE_MS = boundedMs('MC_HTTP_ACTION_MS', 25_000, 5_000, 600_000);
const LONG_ACTION_DEADLINE_MS = boundedMs('MC_HTTP_LONG_ACTION_MS', 120_000, 10_000, 600_000);

/** Paths where the Mineflayer action often runs tens of seconds (pathfind + digs + pickups). */
const LONG_ACTION_PATHS = new Set([
  '/action/collect',
  '/action/dig',
  '/action/dig_area',
  '/action/pickup',
  '/action/craft',
  '/action/smelt',
  '/action/wait',
  '/action/goto',
  '/action/goto_near',
  '/action/follow',
  '/action/pillar_step',
  '/action/fish',
  '/action/sail',
  // F29 (task #66, v44): sail_to runs the full
  // plan_route → walk_to_entry → mount → sail → disembark →
  // walk_to_target chain. circuit-v44 forensics: a real journey
  // took 2m30s end-to-end, far past the 25s default. Pre-fix the
  // agent's HTTP client aborted at 25s while the body kept sailing,
  // consuming boats from inventory the agent thought it still had.
  '/action/sail_to',
  '/action/lure',
  '/action/breed',
  '/action/shear',
  '/action/milk_cow',
  '/action/hunt',
  '/action/through',
  '/task/start',
  // 2026-05-26 hut1-supply forensics: stair_down/stair_up/tunnel/move
  // are compound primitives (per-step pathfind + dig + settle) that
  // routinely run 30-90s server-side. Pre-fix they used the 25s default
  // and clients aborted with "HTTP wait ended before the bot replied"
  // while the bot kept executing. Across a 12-hour run we logged 23×
  // tunnel, 11× stair_down, 7× stair_up, 6× move aborts. The server
  // also caps move at 30s (ACTION_CAPS_MS.move) — guaranteed mismatch
  // with the 25s client deadline. /action/goto has a 300s server cap
  // (long surface legs) and falls into the same trap. Multi-block
  // shape primitives (fill/dig_pit/level/wall/build_stairs/till_area)
  // are dig_area-class — same rationale.
  '/action/stair_down',
  '/action/stair_up',
  '/action/tunnel',
  '/action/move',
  '/action/safe_dig',
  '/action/dig_pit',
  '/action/level',
  '/action/wall',
  '/action/place_fill',
  '/action/build_stairs',
  '/action/till_area',
  '/task/place_fill',
]);

function classifyPathDeadline(method, pathname) {
  const u = pathname.split('?')[0];
  if (method === 'GET' || u === '/health' || u === '/observe' || u === '/checkpoint') return READ_DEADLINE_MS;
  if (LONG_ACTION_PATHS.has(u)) return LONG_ACTION_DEADLINE_MS;
  return ACTION_DEADLINE_MS;
}

const BACKOFF_MS = [250, 800];

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchOnce(url, init, deadlineMs, signalOuter) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await fetch(url, {
      ...init,
      signal: signalOuter ?? controller.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} baseApi no trailing slash
 * @param {string} pathname with leading /
 * @param {{ method?: string, body?: string|null, headers?: Record<string,string>, signal?: AbortSignal }} opts
 */
export async function requestHttp(baseApi, pathname, opts = {}) {
  const url = `${baseApi.replace(/\/$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  const method = (opts.method || 'GET').toUpperCase();
  const pathnameOnly = pathname.split('?')[0];
  const deadline = classifyPathDeadline(method, pathnameOnly);
  const allowRetry = method === 'GET';
  let lastErr;
  const attempts = allowRetry ? 1 + BACKOFF_MS.length : 1;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchOnce(
        url,
        {
          method,
          headers: opts.headers || (opts.body ? { 'Content-Type': 'application/json' } : {}),
          body: opts.body ?? undefined,
        },
        deadline,
        opts.signal,
      );

      let text = '';
      try {
        text = await res.text();
      } catch (_) {
        text = '';
      }

      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch (_) {
          json = { ok: false, error: text || `HTTP ${res.status}`, raw: true };
        }
      } else json = {};

      const out = {
        ok: res.ok && (json.ok !== false || json.raw),
        httpStatus: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        json,
        text,
      };

      const netFail = res.status === 0 || Number.isNaN(res.status);

      if (allowRetry && (netFail || res.status >= 503) && i < attempts - 1) {
        await sleep(BACKOFF_MS[i] ?? 800);
        continue;
      }

      return out;
    } catch (e) {
      lastErr = e;
      if (allowRetry && i < attempts - 1) {
        await sleep(BACKOFF_MS[i] ?? 800);
        continue;
      }
      return {
        ok: false,
        httpStatus: 0,
        networkError: String(e.message || e),
        json: {
          ok: false,
          error: `Cannot reach bot server (${e.name || 'Error'}): ${String(e.message || e)}`,
        },
        text: '',
      };
    }
  }
  return {
    ok: false,
    httpStatus: 0,
    json: {
      ok: false,
      error: String(lastErr?.message || lastErr || 'Request failed'),
    },
    text: '',
  };
}

export { READ_DEADLINE_MS, ACTION_DEADLINE_MS, LONG_ACTION_DEADLINE_MS, classifyPathDeadline };
