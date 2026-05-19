/** @typedef {{ key:string, type:'string'|'number'|'boolean'|'json', required?:boolean, default?:unknown, min?:number, max?:number, enum?:string[] }} ArgSpec */

/**
 * Strip global CLI flags before command dispatch.
 * @param {string[]} argv tokens after slicing off program (e.g. process.argv.slice(2))
 */
export function stripGlobalFlags(argv) {
  const rest = [];
  let json = false;
  let dryRun = false;
  let help = false;
  /** @type {number|undefined} */
  let limit;
  /** @type {string[]|undefined} */
  let fields;
  // F56: accept `reason=...` (and `reason="..."`) as free-form metadata.
  // Bots use this for logging/announcing intent ("reason=M2A platform 4x4").
  // Shell tokenization may split a quoted reason across several tokens;
  // we glue them back together. The value is preserved for telemetry on
  // the brain side but NOT forwarded to the HTTP body (we just stop the
  // CLI from erroring on it).
  /** @type {string|undefined} */
  let reason;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--dry-run' || a === '-n') dryRun = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a.startsWith('--limit=')) limit = Number(a.slice('--limit='.length));
    else if (a === '--limit') {
      limit = Number(argv[i + 1]);
      i++;
    } else if (a.startsWith('--fields='))
      fields = String(a.slice('--fields='.length))
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    else if (a === '--fields') {
      fields = String(argv[i + 1] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      i++;
    } else if (
      typeof a === 'string' &&
      (/^reason=/i.test(a) || /^--reason=/i.test(a) || a === '--reason' || a === '-r')
    ) {
      // F56 + agent-form: `reason=...`, `--reason=...`, `--reason "..."`,
      // `-r "..."`. Telemetry only — the value lands in globals.reason and
      // is NOT forwarded to the HTTP body. Bots use this to articulate
      // intent (and under MC_FORCE_REASON=1 it routes scene/map/find/nearby
      // through the perception-digest pipeline).
      //
      // Shell tokenization may split a quoted reason across tokens; we glue
      // them back together until we hit another flag or `key=value` pair.
      let firstRaw;
      let valueStarts = i;
      if (a === '--reason' || a === '-r') {
        valueStarts = i + 1;
        if (valueStarts >= argv.length) continue;
        firstRaw = String(argv[valueStarts]);
      } else if (/^--reason=/i.test(a)) {
        firstRaw = a.slice('--reason='.length);
      } else {
        firstRaw = a.slice('reason='.length);
      }
      const chunks = [firstRaw];
      const openQuote = firstRaw.startsWith('"') || firstRaw.startsWith("'");
      let j = valueStarts + 1;
      while (j < argv.length) {
        const t = argv[j];
        if (typeof t !== 'string') break;
        if (t.startsWith('--')) break;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) break;
        chunks.push(t);
        if (openQuote && (t.endsWith('"') || t.endsWith("'"))) {
          j++;
          break;
        }
        if (!openQuote) {
          // Single bare token — don't grab everything after.
          j++;
          break;
        }
        j++;
      }
      reason = chunks.join(' ').replace(/^["']|["']$/g, '');
      i = j - 1;
    } else rest.push(a);
  }

  return {
    globals: {
      json,
      dryRun,
      help,
      ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
      ...(fields?.length ? { fields } : {}),
      ...(reason ? { reason } : {}),
    },
    rest,
  };
}

/** @returns {unknown} */
export function coerceValue(spec, raw) {
  const t = spec.type;

  if (raw === undefined) {
    if (spec.required) throw new Error('missing');
    return spec.default;
  }

  if (t === 'string') return String(raw);

  if (t === 'number') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isNaN(n)) throw new Error(`not_number`);
    if (spec.min != null && n < spec.min) throw new Error(`min:${spec.min}`);
    if (spec.max != null && n > spec.max) throw new Error(`max:${spec.max}`);
    return n;
  }

  if (t === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
    throw new Error('not_bool');
  }

  if (t === 'json') return typeof raw === 'object' && raw !== null ? raw : JSON.parse(String(raw));
  return raw;
}

/**
 * Merge leading JSON object positional into params (first token `{...`).
 * Returns null if does not apply.
 */
export function tryConsumeJsonObject(rest) {
  if (!rest[0]?.startsWith?.('{')) return null;
  try {
    return JSON.parse(rest[0]);
  } catch (_) {
    throw new Error('invalid_json_body');
  }
}

/**
 * For commands with argSchema — map positional argv (after stripping flags) excluding command name itself.
 *
 * Caller passes positional only (no cmd token).
 * If first positional is `{` JSON.parse whole object merge keys.
 *
 * Supports optional leading mark token `@home` BEFORE numeric triple for x-schema entries (applied when first spec key expects x triple).
 *
 * NOTE: Prefer customParse handlers in dispatcher for unusually shaped commands (deposit, rally, flee flags, etc.).
 */
export function positionalToParams(commandName, argSchema = [], positional) {
  if (!argSchema?.length) return {};

  /** @type {Record<string, unknown>} */
  const merged = {};

  if (positional[0]?.startsWith?.('{')) {
    let obj;
    try {
      obj = JSON.parse(positional[0]);
    } catch {
      throw new Error('invalid_json_body');
    }
    if (typeof obj !== 'object' || obj === null) throw new Error('invalid_json_body');
    Object.assign(merged, obj);

    for (const spec of argSchema) {
      if (!(spec.key in merged)) {
        if (spec.default !== undefined) merged[spec.key] = spec.default;
        else if (spec.required) throw new Error(`missing:${spec.key}`);
      } else merged[spec.key] = coerceValue(spec, merged[spec.key]);
    }
    return merged;
  }

  const tokens = positional.slice();

  // Pre-pass: extract `key=value` / `--key=value` / bare `--flag` tokens
  // (common CLI conventions agents assume work). Anything matching a spec
  // key gets routed to that spec; remaining tokens fall through to
  // positional consumption below. Bare `--flag` is only consumed when the
  // matching spec is boolean — otherwise it stays positional and will
  // surface a clear error.
  const kwOverrides = /** @type {Record<string, string>} */ ({});
  const specByKey = Object.fromEntries(argSchema.map((s) => [s.key, s]));
  const remaining = [];
  for (const t of tokens) {
    if (typeof t !== 'string') {
      remaining.push(t);
      continue;
    }
    let m = t.match(/^--([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && specByKey[m[1]]) {
      kwOverrides[m[1]] = m[2];
      continue;
    }
    m = t.match(/^--([A-Za-z_][A-Za-z0-9_]*)$/);
    if (m && specByKey[m[1]]?.type === 'boolean') {
      kwOverrides[m[1]] = 'true';
      continue;
    }
    m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && specByKey[m[1]]) {
      kwOverrides[m[1]] = m[2];
    } else {
      remaining.push(t);
    }
  }

  // Positional consumption — skip specs already filled via kw=value.
  for (const spec of argSchema) {
    if (spec.key in kwOverrides) {
      try {
        merged[spec.key] = coerceValue(spec, kwOverrides[spec.key]);
      } catch (e) {
        throw new Error(`${commandName}:${spec.key}:${/** @type {Error} */ (e).message || e}`);
      }
      continue;
    }
    const tok = remaining.shift();
    try {
      if (tok === undefined) {
        if (spec.default !== undefined) merged[spec.key] = spec.default;
        else if (spec.required) throw new Error(`missing:${spec.key}`);
      } else merged[spec.key] = coerceValue(spec, tok);
    } catch (e) {
      throw new Error(`${commandName}:${spec.key}:${/** @type {Error} */ (e).message || e}`);
    }
  }
  if (remaining.length) throw new Error(`extra_arguments:${commandName}`);
  return merged;
}

export function normalizeMark(body) {
  if (!body || typeof body !== 'object') return body;
  for (const field of ['mark', 'to']) {
    const val = /** @type {Record<string, string>} */ (body)[field];
    if (typeof val === 'string' && val.startsWith('@')) body[field] = val.slice(1);
  }
  return body;
}
