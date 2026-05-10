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
    } else rest.push(a);
  }

  return {
    globals: {
      json,
      dryRun,
      help,
      ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
      ...(fields?.length ? { fields } : {}),
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
  for (const spec of argSchema) {
    const tok = tokens.shift();
    try {
      if (tok === undefined) {
        if (spec.default !== undefined) merged[spec.key] = spec.default;
        else if (spec.required) throw new Error(`missing:${spec.key}`);
      } else merged[spec.key] = coerceValue(spec, tok);
    } catch (e) {
      throw new Error(`${commandName}:${spec.key}:${/** @type {Error} */ (e).message || e}`);
    }
  }
  if (tokens.length) throw new Error(`extra_arguments:${commandName}`);
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
