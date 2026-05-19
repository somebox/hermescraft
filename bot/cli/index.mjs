#!/usr/bin/env node
/**
 * HermesCraft `mc` — Node CLI (ESM `.mjs`) talking to bot HTTP (`bot/server.js`).
 */
import process from 'node:process';
import { stripGlobalFlags } from './args.mjs';
import { buildHttpRequest } from './dispatch.mjs';
import { executeHttp, logDebug } from './execute.mjs';
import { requestHttp } from './http.mjs';
import { RAW_COMMAND_DEFS, buildAliasMap, CATEGORY_ORDER } from './registry.mjs';
import { runAdviseCli } from './advise.mjs';
import { renderHuman } from './output.mjs';

const MAX_BATCH = 10;

/**
 * Commands that get reason-wrapped when MC_FORCE_REASON=1.
 * NOTE: `status` is deliberately NOT in this set. We want a thin, fast
 * status (location/HP/food/holding/time) so the agent can use it as a
 * cheap "where am I, what am I holding" check without paying for a
 * digest LLM call. For richer world-state, the agent must use
 * scene/find/map/nearby (which DO wrap).
 */
const FORCED_REASON_COMMANDS = new Set(['scene', 'map', 'find', 'nearby']);

/** Derive a coarse phase label from MC tick (0..23999). */
function timePhase(t) {
  if (t == null || isNaN(Number(t))) return null;
  const tick = Number(t) % 24000;
  if (tick < 12000) return 'day';
  if (tick < 13000) return 'dusk';
  if (tick < 23000) return 'night';
  return 'dawn';
}

/**
 * Project /status into a thin envelope. Drops scene/nearby/inventory etc —
 * agents must call `mc inventory`, `mc scene --reason=...`, `mc look` for
 * those. Keeps: position, HP/food, holding, time/phase, weather.
 */
function slimStatusEnvelope(raw) {
  const d = raw?.data || {};
  const pos = d.position || null;
  return {
    ok: true,
    command: 'status',
    data: {
      position: pos
        ? { x: Math.round((pos.x ?? 0) * 10) / 10, y: Math.round(pos.y ?? 0), z: Math.round((pos.z ?? 0) * 10) / 10 }
        : null,
      health: d.health ?? null,
      food: d.food ?? null,
      saturation: d.saturation ?? null,
      holding: d.holding ?? null,
      time: d.time ?? null,
      phase: timePhase(d.time),
      raining: d.isRaining ?? null,
      hint:
        'thin status: only location/HP/food/holding/time. ' +
        'For richer info use mc scene/find/map/nearby with --reason. ' +
        'For polling a goto/collect task use mc task.',
    },
  };
}

/**
 * Extract --reason from positional args (used by FORCED_REASON_COMMANDS).
 * Supports `--reason "..."`, `--reason=...`, and `-r "..."`. Leaves other
 * tokens untouched so callers can still pass cmd-specific flags if they
 * want to (we ignore them in wrapped mode).
 * @param {string[]} positional
 * @returns {string}
 */
function extractReason(positional) {
  for (let i = 0; i < positional.length; i++) {
    const t = String(positional[i]);
    if (t === '--reason' || t === '-r') return String(positional[i + 1] ?? '').trim();
    if (t.startsWith('--reason=')) return t.slice('--reason='.length).trim();
  }
  return '';
}

function apiUrl() {
  if (process.env._MC_API_URL_LOCKED) return String(process.env._MC_API_URL_LOCKED);
  if (process.env.MC_API_URL) return String(process.env.MC_API_URL);
  return `http://localhost:3001`;
}

/** Registry templates that never map to literal HTTP endpoints. */
function isIncompleteRegistryPath(def) {
  if (def?.name === 'bg') return false;
  const p = def?.path ?? '';
  return typeof p === 'string' && p.includes('__REPLACE__');
}

/** Cosmetic skip for grouped help listing (internals / composites). */
function hideFromBriefHelp(def) {
  return isIncompleteRegistryPath(def);
}

function summarizeArgSchema(def) {
  return (def.argSchema || []).map((a) => ({
    key: a.key,
    type: a.type,
    ...(a.required !== undefined ? { required: a.required } : {}),
    ...(a.default !== undefined ? { default: a.default } : {}),
    ...(a.min !== undefined ? { min: a.min } : {}),
    ...(a.max !== undefined ? { max: a.max } : {}),
  }));
}

/** @typedef {{ category?: string }} CommandsExtra */

/** @returns { CommandsExtra & { rest: string[] } } */
function extractCommandsFlags(positional) {
  /** @type {CommandsExtra} */
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

/**
 * Minimal registry introspection blob for LLM discovery.
 *
 * @param {{ limit?:number, fields?:string[] }} [globalsOpts]
 */
function introspectDefinitions(globalsOpts = {}, categoryFilterRaw) {
  const catFilter = categoryFilterRaw?.toLowerCase?.();
  /** @type {Record<string, unknown>} */
  const defs = {};

  for (const def of RAW_COMMAND_DEFS) {
    const name = def.name;
    if (name === 'bg') {
      if (catFilter && String(def.category).toLowerCase() !== catFilter) continue;
      defs[name] = {
        category: def.category,
        ...(def.aliases?.length ? { aliases: [...def.aliases] } : {}),
        method: def.method ?? 'POST',
        ...(def.description ? { description: def.description } : {}),
        ...(def.usage ? { usage: def.usage } : {}),
        path: '/task/:action',
        args: summarizeArgSchema(def),
        ...(def.examples?.length ? { examples: [...def.examples] } : {}),
      };
      continue;
    }
    if (isIncompleteRegistryPath(def)) continue;
    if (catFilter && String(def.category).toLowerCase() !== catFilter) continue;

    defs[name] = {
      category: def.category,
      ...(def.aliases?.length ? { aliases: [...def.aliases] } : {}),
      method: def.method,
      ...(def.description ? { description: def.description } : {}),
      ...(def.usage ? { usage: def.usage } : {}),
      path:
        def.name === 'anchors'
          ? 'composite(status,marks)'
          : def.name === 'dashboard'
            ? '(dashboard URL)'
            : typeof def.path === 'string'
              ? def.path
              : '(pathFn)',
      args: summarizeArgSchema(def),
      ...(def.examples?.length ? { examples: [...def.examples] } : {}),
    };
  }

  /** @type {Record<string, unknown>} */
  let shaped = defs;
  if (globalsOpts?.limit != null) {
    const lim = globalsOpts.limit;
    const entries = Object.fromEntries(Object.entries(defs).slice(0, lim));
    shaped = entries;
  }
  if (globalsOpts?.fields?.length) {
    const f = globalsOpts.fields;
    shaped = Object.fromEntries(
      Object.entries(shaped).filter(([k]) => f.some((wanted) => wanted === k)),
    );
  }

  return shaped;
}

/** @param {ReturnType<typeof buildAliasMap>} aliasMap */
function printHelp(aliasMap) {
  const groups = {};

  for (const cat of CATEGORY_ORDER)
    groups[cat] = RAW_COMMAND_DEFS.filter(
      (d) => d.category === cat && !hideFromBriefHelp(d),
    )
      .map((d) => d.name)
      .sort();

  for (const cat of CATEGORY_ORDER.filter((c) => groups[c]?.length)) {
    console.log(`\n=== ${cat} ===`);
    for (const n of groups[cat]) console.log(`  mc ${n}`);
  }

  console.log('\nAlso: mc help <command>, mc commands [--category <observe|...>]');
  console.log('Flags anywhere: --json, --dry-run, --limit N, --fields a,b,c');
  console.log(`Registry: ~${Object.keys(aliasMap).length} tokens.\n`);
}

/** @param {ReturnType<typeof buildAliasMap>[string]} hit */
function printOneCommandHelp(hit) {
  const def = hit.def;
  const name = hit.canonicalName;
  console.log(`\n${name}${def.aliases?.length ? ` (${def.aliases.join(', ')})` : ''}`);
  if (def.description) console.log(`  ${def.description}`);
  if (def.usage) console.log(`  usage: ${def.usage}`);
  console.log(`  category: ${def.category}`);
  if (typeof def.path === 'string') console.log(`  ${def.method} ${def.path}`);
  else console.log(`  ${def.method} (pathFn)`);
  const args = summarizeArgSchema(def);
  if (args.length) {
    console.log('  args:');
    for (const a of args)
      console.log(
        `    ${a.key}: ${a.type}${a.required ? ' (required)' : ''}${a.default !== undefined ? ` default=${JSON.stringify(a.default)}` : ''}`,
      );
  }
  if (def.examples?.length) {
    console.log('  examples:');
    for (const ex of def.examples) console.log(`    ${ex}`);
  }
  console.log('');
}

function notchFilter(nb) {
  const want = new Set(['chest', 'crafting_table', 'furnace', 'bed', 'barrel', 'smoker', 'blast_furnace']);
  return (nb || []).filter((b) => want.has(String(b?.name))).slice(0, 40);
}

/** Anchors composite (status + GET /marks). */
async function anchorsEnvelope(api, globals) {
  if (globals.dryRun) return { ok: true, command: 'anchors', data: { dryRun: true } };

  const statusResp = await requestHttp(api, `/status`);
  const marksResp = await requestHttp(api, `/marks`);

  return {
    ok: true,
    command: 'anchors',
    data: {
      position: statusResp.json?.data?.position ?? null,
      anchors: notchFilter(statusResp.json?.data?.notableBlocks),
      marks: marksResp.json?.data ?? marksResp.json ?? null,
    },
  };
}

/**
 * Expand batch fragments into per-segment argv tails.
 *
 * @param {string[]} restArgv tokens after `batch`
 */
function expandBatchArgv(restArgv) {
  if (!restArgv.length) throw new Error('batch needs at least one subcommand');
  if (restArgv.length > MAX_BATCH) throw new Error(`batch exceeds ${MAX_BATCH} segments`);
  return restArgv.map((frag) =>
    /\s/.test(frag)
      ? frag.match(/"(?:[^"\\]|\\.)*"|\S+/g)?.map((s) => s.replace(/^"|"$/g, '').replace(/\\"/g, '"')) || [frag]
      : [frag],
  );
}

/**
 * @param {string} token first token of a segment
 * @param {ReturnType<typeof buildAliasMap>} aliasMap
 */
function resolveToken(token, aliasMap) {
  const k = String(token || '').toLowerCase();
  const hit = aliasMap[k];
  if (!hit) throw new Error(`unknown command: ${token}`);
  return hit;
}

function printJson(obj, pretty) {
  console.log(JSON.stringify(obj, null, pretty ? 2 : undefined));
}

/**
 * @typedef {{ ok: boolean, env?: unknown, render: 'json'|'human'|'none' }} DispatchOutcome
 */

/**
 * @returns {Promise<DispatchOutcome>}
 */
async function dispatchHttpLike(resolved, positional, globals, ctx) {
  const { canonicalName, def } = resolved;

  if (canonicalName === 'commands') {
    const { category, rest } = extractCommandsFlags(positional);
    if (rest.length) throw new Error(`commands: unexpected arguments: ${rest.join(' ')}`);
    const data = introspectDefinitions(globals, category);
    const env = { ok: true, command: 'commands', data: { definitions: data } };
    /** Introspection is always JSON-shaped (even without `--json`). */
    return { ok: true, env, render: 'json' };
  }

  if (canonicalName === 'help') {
    if (positional[0]) {
      const sub = resolveToken(positional[0], ctx.aliasMap);
      if (globals.json) {
        const all = introspectDefinitions({}, undefined);
        const definition = all[sub.canonicalName] ?? null;
        return {
          ok: true,
          env: { ok: true, command: 'help', data: { target: sub.canonicalName, definition } },
          render: 'json',
        };
      }
      printOneCommandHelp(sub);
      return { ok: true, render: 'none' };
    }
    if (globals.json)
      return { ok: true, env: { ok: true, command: 'help', data: { sections: CATEGORY_ORDER } }, render: 'json' };
    printHelp(ctx.aliasMap);
    return { ok: true, render: 'none' };
  }

  if (canonicalName === 'dashboard') {
    const url = `${ctx.api}/dashboard`;
    if (globals.json)
      return { ok: true, env: { ok: true, command: 'dashboard', data: { url } }, render: 'json' };
    console.log(`Web dashboard: ${url}`);
    return { ok: true, render: 'none' };
  }

  if (canonicalName === 'anchors') {
    const env = await anchorsEnvelope(ctx.api, globals);
    return { ok: env.ok !== false, env, render: globals.json ? 'json' : 'human' };
  }

  if (canonicalName === 'advise') {
    const built = buildHttpRequest(def, canonicalName, positional);
    const reason = String(built.params?.reason ?? '');
    if (globals.dryRun) {
      const env = await runAdviseCli({ reason, apiBase: ctx.api, dryRun: true, kind: 'advise' });
      return { ok: env.ok !== false, env, render: globals.json ? 'json' : 'human' };
    }
    const env = await runAdviseCli({ reason, apiBase: ctx.api, kind: 'advise' });
    return { ok: env.ok !== false, env, render: globals.json ? 'json' : 'human' };
  }

  // Slim `mc status` to a fixed essentials projection. Rich world-state
  // lives under scene/find/map/nearby. This keeps status cheap and fast.
  if (canonicalName === 'status') {
    const r = await requestHttp(ctx.api, `/status?lean=true`);
    const env = slimStatusEnvelope(r.json);
    return { ok: true, env, render: globals.json ? 'json' : 'human' };
  }

  // MC_FORCE_REASON=1: wrap observation commands through the digest pipeline.
  // Forces the agent to articulate its sub-goal before observing.
  if (process.env.MC_FORCE_REASON === '1' && FORCED_REASON_COMMANDS.has(canonicalName)) {
    // stripGlobalFlags peels --reason/reason= into globals.reason; fall
    // back to scanning positional for builds that still pass it through.
    const reason = String(globals.reason ?? '').trim() || extractReason(positional);
    if (!reason) {
      const env = {
        ok: false,
        command: canonicalName,
        error:
          `MC_FORCE_REASON is on — \`mc ${canonicalName}\` requires --reason="<sub-goal>". ` +
          `Example: mc ${canonicalName} --reason="find oak wood near base". ` +
          `Announce what you're doing in chat first (mc chat ...) so the digest has context.`,
        error_type: 'missing_argument',
      };
      return { ok: false, env, render: globals.json ? 'json' : 'human' };
    }
    if (globals.dryRun) {
      const env = await runAdviseCli({ reason, apiBase: ctx.api, dryRun: true, kind: canonicalName });
      return { ok: env.ok !== false, env, render: globals.json ? 'json' : 'human' };
    }
    const env = await runAdviseCli({ reason, apiBase: ctx.api, kind: canonicalName });
    return { ok: env.ok !== false, env, render: globals.json ? 'json' : 'human' };
  }

  if (canonicalName === 'screenshot_meta') {
    if (positional.length) {
      throw new Error(`screenshot_meta takes no arguments (got: ${positional.join(' ')})`);
    }
    const env = {
      ok: false,
      command: 'screenshot_meta',
      error: 'screenshot_meta is not wired to the bot HTTP API on this build.',
      error_type: 'not_implemented',
      hint:
        'Use mc scene, mc map, mc look, mc nearby, mc status for spatial context. Capture the Minecraft window with your OS/screenshot tool if you need pixel-level vision.',
      http_status: 0,
    };
    return { ok: false, env, render: globals.json ? 'json' : 'human' };
  }

  const env = await executeHttp(
    { def, canonicalName },
    positional,
    globals,
    {
      requestBuilder: buildHttpRequest,
      apiBase: ctx.api,
      debugLog: ctx.debugLog,
    },
  );
  return { ok: Boolean(env.ok), env, render: globals.json ? 'json' : 'human' };
}

async function main() {
  const argv = process.argv.slice(2);
  const { globals, rest } = stripGlobalFlags(argv.length ? argv : ['help']);

  const cmdLine = rest.length ? rest : ['help'];

  const aliasMap = buildAliasMap();
  const debugLog = process.env.MC_DEBUG_LOG || '';

  const ctx = { api: apiUrl(), debugLog, aliasMap };

  logDebug(debugLog, `tokens=${JSON.stringify(cmdLine)} api=${ctx.api}`);

  const first = cmdLine[0];
  const firstHit = resolveToken(first, aliasMap);

  // Short-circuit `mc <cmd> --help` (and `-h`) before dispatch — prints the
  // command's metadata and exits without an HTTP call. Lets agents discover
  // arg shapes on demand instead of having to memorize them.
  if (globals.help) {
    if (globals.json) {
      const all = introspectDefinitions({}, undefined);
      printJson({ ok: true, command: 'help', data: { target: firstHit.canonicalName, definition: all[firstHit.canonicalName] ?? null } }, true);
    } else {
      printOneCommandHelp(firstHit);
    }
    process.exit(0);
  }

  // Shell-chaining detection. Agents sometimes write
  //   mc craft stick 4 && mc craft crafting_table 1
  // thinking the CLI honours bash-style chaining. It doesn't — argv
  // contains the literal `&&` (or `;` / `||`) token, and the first
  // verb either silently ignores trailing tokens or treats them as
  // bogus args. We catch that here and emit a hint pointing at
  // `mc batch`, the actual multi-command mechanism.
  if (firstHit.canonicalName !== 'batch') {
    const CHAIN = new Set(['&&', '||', ';', '|']);
    const chainIdx = cmdLine.findIndex((t) => CHAIN.has(t));
    if (chainIdx > 0) {
      // Segment by chain operators, dropping `mc` prefixes within each.
      const segs = [];
      let cur = [];
      for (const t of cmdLine) {
        if (CHAIN.has(t)) {
          if (cur.length) segs.push(cur);
          cur = [];
          continue;
        }
        if (cur.length === 0 && t === 'mc') continue;
        cur.push(t);
      }
      if (cur.length) segs.push(cur);
      const suggestion = segs.map((s) => `"${s.join(' ')}"`).join(' ');
      console.log(
        `ERROR (cli): "${cmdLine[chainIdx]}" is shell-chaining syntax — mc runs ONE command per call. ` +
          `To run multiple commands, use:\n\n  mc batch ${suggestion}\n\n` +
          `or issue them as separate \`mc\` calls.`,
      );
      process.exit(2);
    }
  }

  if (firstHit.canonicalName === 'batch') {
    const segments = expandBatchArgv(cmdLine.slice(1));

    /** @type {unknown[]} */
    const out = [];
    let anyBad = false;

    for (const seg of segments) {
      const h = resolveToken(seg[0], aliasMap);
      if (h.canonicalName === 'batch') throw new Error('nested batch is not allowed');
      const r = await dispatchHttpLike(h, seg.slice(1), globals, ctx);
      if (!r.ok) anyBad = true;
      if (globals.json) {
        if (r.env !== undefined) out.push(r.env);
      } else {
        if (r.render === 'json' && r.env !== undefined) printJson(r.env, true);
        else if (r.render === 'human' && r.env !== undefined) renderHuman(/** @type {any} */ (r.env));
      }
    }

    if (globals.json) printJson(out, true);

    anyBad ||= out.some((e) => e && typeof e === 'object' && 'ok' in e && /** @type {any}*/ (e).ok === false);
    process.exit(anyBad ? 1 : 0);
    return;
  }

  const r = await dispatchHttpLike(firstHit, cmdLine.slice(1), globals, ctx);
  if (r.render === 'json' && r.env !== undefined) printJson(r.env, true);
  else if (r.render === 'human' && r.env !== undefined) renderHuman(/** @type {any} */ (r.env));
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => {
  const msg = String(e.message || e);
  if (/^unknown command:/i.test(msg.trim())) {
    console.log(
      `${msg.replace(/\s+$/, '')}. Run mc commands or mc help.`,
    );
  } else {
    console.log(`ERROR (cli): ${msg}`);
  }
  process.exit(2);
});
