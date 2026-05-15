#!/usr/bin/env node
/**
 * Parse `mc …` lines using the same argv → HTTP mapping as the bot CLI
 * (`bot/cli/registry.mjs` + `bot/cli/dispatch.mjs`), without contacting the server.
 *
 * Platform-only verbs handled in `bot/cli/index.mjs` (not `buildHttpRequest`)
 * are simulated here so they do not throw `unhandled_custom_parse`.
 */
import { stripGlobalFlags } from '../../bot/cli/args.mjs';
import { buildHttpRequest } from '../../bot/cli/dispatch.mjs';
import { buildAliasMap, resolveCommand } from '../../bot/cli/registry.mjs';

/** Lazily built — registry is large */
let _aliasMap = null;
export function getAliasMap() {
  if (!_aliasMap) _aliasMap = buildAliasMap();
  return _aliasMap;
}

/**
 * Tokenize text after `mc ` respecting single/double quotes and backslash escapes.
 * @param {string} tail everything after leading `mc `
 */
export function tokenizeMcTail(tail) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (quote) {
      if (c === '\\' && quote === '"' && tail[i + 1]) {
        cur += tail[++i];
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur.length) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur.length) tokens.push(cur);
  return tokens;
}

/** Matches `bot/cli/index.mjs` extractCommandsFlags */
function extractCommandsFlags(positional) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < positional.length; i++) {
    const a = positional[i];
    if ((a === '--category' || a === '--commands-category') && positional[i + 1]) {
      opts.category = String(positional[i + 1]);
      i++;
    } else rest.push(a);
  }
  return { ...opts, rest };
}

function sanitizeRequest(req) {
  if (!req) return null;
  const body =
    req.body == null
      ? undefined
      : typeof req.body === 'string' && req.body.length > 800
        ? `${req.body.slice(0, 800)}…`
        : req.body;
  return {
    method: req.method,
    path: req.path,
    ...(body !== undefined ? { body } : {}),
    params: req.params && typeof req.params === 'object' ? req.params : undefined,
  };
}

/**
 * Simulate CLI-only commands normally dispatched from `bot/cli/index.mjs`.
 * @returns {{ parse_ok: boolean, parse_error?: string, simulated_request?: Record<string, unknown> }}
 */
function simulateCliOnly(canonicalName, positional) {
  const aliasMap = getAliasMap();

  switch (canonicalName) {
    case 'commands': {
      try {
        const { rest } = extractCommandsFlags(positional);
        if (rest.length)
          return { parse_ok: false, parse_error: `commands: unexpected arguments: ${rest.join(' ')}` };
        return {
          parse_ok: true,
          simulated_request: { kind: 'cli_introspection', method: 'META', path: 'mc commands' },
        };
      } catch (e) {
        return { parse_ok: false, parse_error: String(/** @type {Error} */ (e).message || e) };
      }
    }
    case 'help': {
      if (positional.length > 1)
        return { parse_ok: false, parse_error: 'help: too many arguments' };
      if (positional[0]) {
        const sub = resolveCommand(positional[0], aliasMap);
        if (!sub) return { parse_ok: false, parse_error: `unknown command: ${positional[0]}` };
      }
      return { parse_ok: true, simulated_request: { kind: 'cli_help', path: 'mc help' } };
    }
    case 'dashboard': {
      if (positional.length)
        return { parse_ok: false, parse_error: 'dashboard takes no arguments' };
      return {
        parse_ok: true,
        simulated_request: { kind: 'cli_dashboard', note: 'prints configured dashboard URL' },
      };
    }
    case 'anchors': {
      if (positional.length)
        return { parse_ok: false, parse_error: 'anchors takes no arguments' };
      return {
        parse_ok: true,
        simulated_request: { kind: 'cli_composite', method: 'GET', path: 'composite(status,marks)' },
      };
    }
    case 'batch': {
      if (!positional.length) return { parse_ok: false, parse_error: 'batch needs at least one subcommand' };
      return {
        parse_ok: true,
        simulated_request: {
          kind: 'cli_batch',
          segment_count: positional.length,
          hint: 'validated shell-split only — segments not recursively parsed',
        },
      };
    }
    case 'screenshot_meta': {
      if (positional.length)
        return { parse_ok: false, parse_error: 'screenshot_meta takes no arguments' };
      return { parse_ok: true, simulated_request: { kind: 'cli_stub', note: 'not wired to HTTP in some builds' } };
    }
    default:
      return null;
  }
}

/**
 * @param {string} line single line starting with `mc `
 */
export function simulateMcLine(line) {
  const trimmed = line.trim();
  const raw = trimmed;
  const m = trimmed.match(/^mc\s+(.+)$/);
  if (!m)
    return {
      raw,
      known_command: false,
      parse_ok: false,
      parse_error: 'line does not start with mc + space',
    };

  const argvTail = tokenizeMcTail(m[1]);
  const { globals: _g, rest } = stripGlobalFlags(argvTail);
  const verb = rest[0];
  if (!verb)
    return {
      raw,
      known_command: false,
      parse_ok: false,
      parse_error: 'missing verb after mc',
    };

  const aliasMap = getAliasMap();
  const hit = resolveCommand(verb, aliasMap);
  if (!hit)
    return {
      raw,
      known_command: false,
      parse_ok: false,
      parse_error: `unknown command: ${verb}`,
    };

  const { def, canonicalName } = hit;
  const positional = rest.slice(1);

  const cliOnly = simulateCliOnly(canonicalName, positional);
  if (cliOnly)
    return {
      raw,
      known_command: true,
      canonical_name: canonicalName,
      category: def.category,
      ...cliOnly,
      simulated_request: cliOnly.simulated_request,
    };

  try {
    const req = buildHttpRequest(def, canonicalName, positional);
    return {
      raw,
      known_command: true,
      canonical_name: canonicalName,
      category: def.category,
      parse_ok: true,
      simulated_request: sanitizeRequest(req),
    };
  } catch (e) {
    return {
      raw,
      known_command: true,
      canonical_name: canonicalName,
      category: def.category,
      parse_ok: false,
      parse_error: String(/** @type {Error} */ (e).message || e),
    };
  }
}

export function simulateMcLines(lines) {
  return lines.map((ln) => simulateMcLine(ln));
}
