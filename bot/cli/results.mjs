const EMPTY_ARRAY_KEYS = new Set(['locations', 'blocks', 'entities', 'messages', 'goals']);

const MAX_ENVELOPE_CHARS = 200_000;

/** @param {unknown} obj */
function deepCloneTrim(obj, limit) {
  if (obj == null) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice(0, limit ?? obj.length);
  const o = { ...obj };
  for (const k of Object.keys(o)) {
    if (Array.isArray(/** @type {any} */ (o)[k])) /** @type {any} */ (o)[k] = /** @type {any[]} */ (o[k]).slice(0, limit ?? o[k].length);
  }
  return o;
}

/** @param {unknown} data @param {string[]} fields */
function projectFields(data, fields) {
  if (!fields?.length || typeof data !== 'object' || data === null) return data;
  /** @type {Record<string,unknown>} */
  const out = {};
  for (const f of fields) if (f in /** @type {object}*/ (data)) out[f] = /** @type {any} */ (data)[f];
  return out;
}

/** @param {Record<string,unknown>} body */
export function detectEmpty(command, body) {
  if (!body || typeof body !== 'object') return { empty: false, hint: '' };
  for (const k of EMPTY_ARRAY_KEYS) {
    const v = body[k];
    if (Array.isArray(v) && v.length === 0) {
      return {
        empty: true,
        hint: `No results in ${k}. Try increasing radius, moving closer, or a different search command.`,
      };
    }
  }
  if (
    body.skipped &&
    Array.isArray(body.skipped) &&
    body.skipped.length > 0 &&
    (!body.mined || typeof body.mined !== 'object')
  )
    return { empty: false, hint: '' };
  return { empty: false, hint: '' };
}

/**
 * Classify failures from HTTP + JSON payloads.
 *
 * `httpRes` optional — from `requestHttp()` result `{ httpStatus, networkError?, json }`
 */
export function classifyError(httpRes, command) {
  if (httpRes?.networkError) {
    const ne = String(httpRes.networkError);
    const abort = /abort/i.test(ne);
    return {
      error_type: 'unreachable',
      hint: abort
        ? `HTTP wait ended before the bot replied (${ne}). Long steps like mc collect may still finish on the server — try mc status or mc inventory. Default long-action timeout is 120s; override with MC_HTTP_LONG_ACTION_MS. Also check MC_API_URL and that the bot process is running.`
        : `Bot server unreachable. Check MC_API_URL and that npm start ran in bot/. (${ne})`,
    };
  }

  const st = httpRes?.httpStatus ?? 0;
  const js = /** @type {Record<string,unknown>} */ (httpRes?.json ?? {});

  const msg =
    typeof js.error === 'string'
      ? js.error
      : typeof js.message === 'string'
        ? js.message
        : 'Request failed';

  if (st === 409) return { error_type: 'task_conflict', hint: 'POST /task/cancel first, then retry.' };
  if (st === 404) return { error_type: 'not_found', hint: msg };

  // Semantic hints for typical bot failures — must run before generic HTTP 400 bucket.
  if (/Unknown mark|No location/i.test(msg)) return { error_type: 'not_found', hint: `${msg} Try mc marks.` };
  if (/can't see|can\x27t see|not visible|no path/i.test(msg)) return { error_type: 'blocked', hint: msg };
  if (/Wrong tool for|need any axe for wood|not a pickaxe|pickaxe\)/i.test(msg))
    return { error_type: 'wrong_tool', hint: msg };
  if (
    /Mineflayer place failed for|No solid neighbor for|Cannot place at .* already|cell is already /i.test(msg)
  )
    return { error_type: 'placement_blocked', hint: msg };
  if (/Refusing to dig .* ticks|MC_ALLOW_SLOW_DIG/i.test(msg))
    return { error_type: 'blocked', hint: msg };
  if (/No .+ in inventory/i.test(msg)) return { error_type: 'missing_item', hint: msg };

  if (st === 400) return { error_type: 'invalid_args', hint: msg };
  if (st >= 500) return { error_type: 'api_error', hint: msg };
  if (st === 0) return { error_type: 'unreachable', hint: msg };

  return { error_type: 'api_error', hint: msg };
}

/**
 * Turn server JSON + transport metadata into the standard CLI envelope.
 */
export function buildEnvelope({ command, httpRes, parsedParams, globals }) {
  const js = /** @type {Record<string,unknown>} */ (httpRes?.json ?? {});
  const ok = Boolean(httpRes?.ok && js.ok !== false);

  if (!ok) {
    const classified = classifyError(httpRes, command);
    const serverHint =
      typeof js.hint === 'string' && js.hint.trim() ? js.hint.trim() : '';
    const hint = serverHint || classified.hint;
    const error_type =
      typeof js.error_type === 'string' && js.error_type.trim()
        ? js.error_type.trim()
        : classified.error_type;

    // Phase-2 action contract: js.error may be an OBJECT
    // ({code, message, observed_state, retry_safe}) — extract `.message`
    // for the human one-liner and `.code` for the error code, instead of
    // serializing the whole envelope into `primary`. Falling through to
    // `httpRes.text` (legacy behavior) used to ship the full JSON tail
    // — including `observed_state` and `state` — into every error
    // response, ballooning per-turn token cost by 5-10×.
    let primary;
    let phase2Code = null;
    if (js.error && typeof js.error === 'object') {
      const errObj = /** @type {Record<string,unknown>} */ (js.error);
      primary = typeof errObj.message === 'string' ? errObj.message : 'error';
      if (typeof errObj.code === 'string') phase2Code = errObj.code;
    } else if (typeof js.error === 'string') {
      primary = js.error;
    } else if (typeof js.message === 'string') {
      primary = js.message;
    } else if (httpRes?.text?.trim()) {
      primary = httpRes.text.trim().slice(0, 4000);
    } else {
      primary = 'error';
    }

    // Trim state blob to the 5 fields the human renderer actually uses
    // (HP, Food, Pos, Hold, time). Dropping spawn_point/top_goal/
    // nearby_utilities/isDay from EVERY error response saves ~150 bytes/
    // call × dozens of calls per turn = a major chunk of context bloat.
    let trimmedState;
    if (js.state != null && typeof js.state === 'object') {
      const s = /** @type {Record<string,unknown>} */ (js.state);
      trimmedState = {};
      if (s.health !== undefined) trimmedState.health = s.health;
      if (s.food !== undefined) trimmedState.food = s.food;
      if (s.position !== undefined) trimmedState.position = s.position;
      if (s.holding !== undefined) trimmedState.holding = s.holding;
      if (s.time !== undefined) trimmedState.time = s.time;
    }

    return {
      ok: false,
      command,
      error: primary,
      error_type,
      hint,
      http_status: httpRes?.httpStatus ?? 0,
      ...(phase2Code ? { code: phase2Code }
          : js.code != null && typeof js.code === 'string' ? { code: js.code } : {}),
      ...(js.details != null && typeof js.details === 'object' ? { details: js.details } : {}),
      ...(trimmedState ? { state: trimmedState } : {}),
      ...(parsedParams && Object.keys(parsedParams).length ? { params: parsedParams } : {}),
    };
  }

  const data = /** @type {Record<string,unknown>} */ (js.data !== undefined ? js.data : js);
  const state = /** @type {Record<string,unknown>|undefined} */ (js.state);

  const emptyInfo = detectEmpty(command, data);

  /** @type {Record<string,unknown>} */
  let shaped = { ...data };
  if (globals?.limit != null) shaped = /** @type {Record<string,unknown>} */ (deepCloneTrim(shaped, globals.limit));
  if (globals?.fields?.length) shaped = /** @type {Record<string,unknown>} */ (projectFields(shaped, globals.fields));

  // Preserve any top-level `result` string from the action. Action handlers
  // return { ok, data, result, ... } and the result string is meant to be
  // a human-readable one-liner ("Block at X,Y,Z: chest", or the F53.5
  // unread-chat banner). Dropping it silently meant the brain only saw the
  // JSON dump minus this prominent summary line. Bug found 2026-05-14.
  const base = {
    ok: true,
    command,
    data: shaped,
    ...(typeof js.result === 'string' ? { result: js.result } : {}),
    ...(state ? { state } : {}),
    ...(emptyInfo.empty ? { empty: true, hint: emptyInfo.hint } : {}),
  };

  const str = JSON.stringify(base);
  if (str.length > MAX_ENVELOPE_CHARS) {
    return {
      ...base,
      data: { note: 'Response truncated for size; re-run with --limit or --fields.' },
      truncated: true,
      hint: 'Payload exceeded size cap; use --limit or --fields.',
    };
  }
  return base;
}

export const MAX_RESPONSE_BODY_CHARS = MAX_ENVELOPE_CHARS;
