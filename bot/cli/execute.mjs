import { appendFileSync } from 'node:fs';
import { requestHttp } from './http.mjs';
import { buildEnvelope } from './results.mjs';
import { expandMarkTokens, hasMarkTokens } from './args.mjs';

/**
 * Append one debug line — matches legacy MC_DEBUG_LOG behavior.
 *
 * On failures after HTTP responses: writes `RES … FAIL` then `FAIL_DETAIL …`
 * with `http`, `error`, optional `hint`/`type`, and `raw_body` when JSON lacked `.error`.
 *
 * @param {string | undefined} logPath
 */
export function logDebug(logPath, line) {
  if (!logPath) return;
  try {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    appendFileSync(logPath, `[${ts}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Execute a single normalized HTTP-backed command definition.
 *
 * @param {{ def: import('./registry.mjs').CmdDef, canonicalName: string }} spec
 */
export async function executeHttp(spec, positional, globals, runtime) {
  const { requestBuilder, apiBase } = runtime;
  const { def, canonicalName } = spec;

  // B4: pre-expand `@mark` tokens into the mark's stored (x, y, z) coords
  // BEFORE the verb's argument parser runs. Universal across all
  // coord-taking verbs without per-verb wiring. Fetches /marks once if
  // any token starts with `@`; otherwise zero overhead.
  let expandedPositional = positional;
  if (hasMarkTokens(positional)) {
    let marksByName = {};
    try {
      const marksRes = await requestHttp(apiBase, '/marks', { method: 'GET' });
      const list = marksRes?.json?.data?.marks || marksRes?.json?.marks || [];
      for (const m of list) {
        if (m && typeof m.name === 'string') marksByName[m.name] = m;
      }
    } catch {
      // If /marks fetch fails (bot down, network), surface a clear error
      // instead of letting the @token fall through to the verb's parser
      // and produce a confusing coord-coercion failure.
      throw new Error('mark_resolution_failed: could not fetch /marks from bot');
    }
    const r = expandMarkTokens(positional, marksByName);
    if ('error' in r) {
      const known = Object.keys(marksByName).slice(0, 8).join(', ');
      throw new Error(
        `unknown_mark: @${r.name} — no such mark. ${known ? `Known: ${known}${Object.keys(marksByName).length > 8 ? ', …' : ''}.` : 'No marks defined.'} Use \`mc marks\` to list.`
      );
    }
    expandedPositional = r.expanded;
    logDebug(runtime.debugLog, `MARK_EXPAND ${canonicalName} used=${r.usedMarks.join(',')} positional=${JSON.stringify(expandedPositional)}`);
  }

  let built;
  try {
    built = requestBuilder(def, canonicalName, expandedPositional);
  } catch (parseErr) {
    const msg = String(parseErr.message || parseErr);
    const usageHint = def.usage ? `\n  Usage: ${def.usage}` : '';
    throw new Error(`${msg}${usageHint}`);
  }
  logDebug(runtime.debugLog, `REQ ${built.method} ${apiBase}${built.path} body=${built.body || ''}`);

  let /** @type {import('./http.mjs').RequestHttpOut} */ httpRes;

  if (globals.dryRun) {
    httpRes = {
      ok: true,
      httpStatus: 0,
      json: {
        ok: true,
        result: `[dry-run] ${built.method} ${built.path}`,
        data: {},
      },
      text: '',
    };
  } else {
    httpRes = await requestHttp(apiBase, built.path, {
      method: built.method,
      body: built.method === 'POST' || built.method === 'DELETE' ? built.body ?? '{}' : undefined,
    });
  }

  const envelope = buildEnvelope({
    command: canonicalName,
    httpRes,
    parsedParams: built.params,
    globals,
  });

  logDebug(runtime.debugLog, `RES ${canonicalName} http=${httpRes.httpStatus}${envelope.ok ? '' : ' FAIL'}`);

  if (!envelope.ok && runtime.debugLog) {
    const parts = [
      `FAIL_DETAIL ${canonicalName}`,
      `http=${httpRes.httpStatus}`,
      envelope.error ? `error=${String(envelope.error).replace(/\s+/g, ' ').slice(0, 1200)}` : '',
      envelope.hint && envelope.hint !== envelope.error
        ? `hint=${String(envelope.hint).replace(/\s+/g, ' ').slice(0, 600)}`
        : '',
      envelope.error_type ? `type=${envelope.error_type}` : '',
      httpRes.text &&
      httpRes.text.length &&
      (!httpRes.json || (typeof httpRes.json === 'object' && !httpRes.json.error))
        ? `raw_body=${httpRes.text.replace(/\s+/g, ' ').slice(0, 800)}`
        : '',
    ].filter(Boolean);
    logDebug(runtime.debugLog, parts.join(' | '));
  }

  if (!envelope.ok && def.usage && !envelope.hint) {
    envelope.hint = `Usage: ${def.usage}`;
  }

  return envelope;
}
