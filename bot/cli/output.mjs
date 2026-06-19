/** One-line summary for transcripts that only preserve a single stdout row (set MC_CLI_ERRORS_MULTILINE=1 for expanded lines). */
export function fmtHumanErrOneLine(e) {
  const cmd = e.command ? `[${e.command}]` : '';
  const primary = String(e.error || 'unknown').replace(/\s+/g, ' ').trim();
  let line = [`ERROR`, cmd, ':', primary].filter(Boolean).join(' ').trim();
  if (e.hint && String(e.hint) !== String(primary)) {
    line += ` — Hint: ${String(e.hint).replace(/\s+/g, ' ').trim()}`;
  }
  const meta = [];
  if (e.http_status != null && e.http_status !== 0) meta.push(`http=${e.http_status}`);
  if (e.error_type) meta.push(`type=${e.error_type}`);
  if (e.code) meta.push(`code=${e.code}`);
  if (meta.length) line += ` [${meta.join(' ')}]`;
  const st = e.state;
  if (st && typeof st === 'object') {
    const hb = [];
    if (st.holding !== undefined) hb.push(`Hold:${st.holding}`);
    if (st.position) hb.push(`Pos:${fmtPos(st.position)}`);
    if (hb.length) line += ` | ${hb.join(' | ')}`;
  }
  return line.length > 1800 ? `${line.slice(0, 1797)}...` : line;
}

import { formatNavHeaderLine } from '../lib/runtime/nav-brief.js';

function fmtPos(p) {
  if (!p || typeof p !== 'object') return String(p);
  return `${p.x},${p.y},${p.z}`;
}

/**
 * Compact nav frame line for `mc status` / `mc scene` (Phase 0c).
 * Run-7 PR-J: delegates to the shared `formatNavHeaderLine` so terrain
 * lands on the same line as situation/mode and reaches the agent prompt.
 * Previously, this function discarded `header.terrain` while
 * `renderNavBrief` (used only by `observe`) emitted it — workers favour
 * status, so the terrain label never made it to the prompt.
 */
function formatNavFrameLine(d) {
  return formatNavHeaderLine(d.nav_header, {
    fallbackNavMode: d.nav_mode,
    fallbackPos: d.nav_frame?.pos_snapshot,
    fallbackSigText: d.nav_frame?.nav_mode_signals?.text,
    // Status/scene historically did not carry `as_of` — keep that contract
    // so existing parsers don't shift.
    includeAsOf: false,
  });
}

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
 * those. Keeps: identity, position, HP/food, holding, time/phase, weather.
 * Identity leads — proc-nav-1781014144 saw a worker run 200+ commands as the
 * wrong bot; every status read must say who you are.
 */
export function slimStatusEnvelope(raw, { verbose = false } = {}) {
  const d = raw?.data || {};
  const pos = d.position || null;
  const stuckMin = d.stuck_minutes;
  const stuckWarning = d.stuck_warning;
  const hint = stuckWarning
    ? `⚠ ${stuckWarning}`
    : ('status = self (location/HP/food/holding/supplies). ' +
       'World vision: mc scene / nearby / map. Task poll: mc task.');
  const identity = d.bot
    ? `You are ${d.bot}${pos ? ` @ (${Math.round(pos.x ?? 0)}, ${Math.round(pos.y ?? 0)}, ${Math.round(pos.z ?? 0)})` : ''}`
    : null;
  const data = {
    ...(identity ? { bot: d.bot, identity } : {}),
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
    ...(stuckMin != null ? { stuck_minutes: stuckMin } : {}),
    ...(stuckWarning ? { stuck_warning: stuckWarning } : {}),
    hint,
  };
  if (d.supplies != null) data.supplies = d.supplies;
  if (d.nearby_entities != null) data.nearby_entities = d.nearby_entities;
  if (d.hand_vs_inventory) data.hand_vs_inventory = d.hand_vs_inventory;
  if (d.situation) data.situation = d.situation;
  // #50: nav_header rides on /status now (open|confined classification +
  // signals). It's small enough to keep in the slim projection — without
  // this the brief reaches /status's response but slimStatusEnvelope drops
  // it before the CLI renderer ever sees it.
  if (d.nav_header) data.nav_header = d.nav_header;
  if (verbose) {
    if (d.task_context) data.task_context = d.task_context;
    if (d.regions_here) data.regions_here = d.regions_here;
    if (d.lookingAt) data.lookingAt = d.lookingAt;
    if (d.mounted !== undefined) data.mounted = d.mounted;
    if (d.unreadChat) data.unreadChat = d.unreadChat;
    if (d.inventoryCount != null) data.inventoryCount = d.inventoryCount;
    if (d.deaths != null) data.deaths = d.deaths;
    if (d.sounds) data.sounds = d.sounds;
  }
  return { ok: true, command: 'status', data };
}

/** Goals/task/alerts one-liners after nav text so human observe is not JSON-only. */
function projectObserveTail(d) {
  if (Array.isArray(d?.next_action_hints) && d.next_action_hints.length) {
    console.log('Suggested next commands:');
    for (const h of d.next_action_hints.slice(0, 5)) console.log(`  ${h}`);
  }
  if (d.task && typeof d.task === 'object' && d.task.kind) {
    console.log(`  task: ${d.task.kind}${d.task.status ? ` (${d.task.status})` : ''}`);
  }
  if (Array.isArray(d.alerts) && d.alerts.length) {
    for (const a of d.alerts.slice(0, 4)) {
      const kind = a.kind || a.type || 'alert';
      console.log(`  alert: ${kind}${a.message ? ` — ${a.message}` : ''}`);
    }
  }
  if (Array.isArray(d.goals) && d.goals.length) {
    const open = d.goals.filter((g) => g && !g.satisfied).slice(0, 3);
    if (open.length) {
      console.log(`  goals: ${open.map((g) => g.id || g.metric || '?').join(', ')}`);
    }
  }
}

/** @param {unknown} env */
export function renderHuman(envelope, /** @type {any} */ _opts = {}) {
  if (!envelope || typeof envelope !== 'object') return String(envelope);

  if (!(/** @type {any} */ (envelope).ok)) {
    const e = /** @type {any} */ (envelope);
    const summary = fmtHumanErrOneLine(e);
    console.log(summary);
    const multiline =
      process.env.MC_CLI_ERRORS_MULTILINE === '1' ||
      process.env.MC_CLI_ERRORS_MULTILINE === 'true';
    if (multiline) {
      const cmd = e.command ? `[${e.command}]` : '';
      const primary = e.error || 'unknown';
      const head = [`ERROR`, cmd, ':', primary].filter(Boolean).join(' ');
      if (head !== summary) console.log(head);
      if (e.http_status != null && e.http_status !== 0) console.log(`  http: ${e.http_status}`);
      if (e.error_type) console.log(`  type: ${e.error_type}`);
      if (e.code) console.log(`  code: ${e.code}`);
      if (e.hint && String(e.hint) !== String(primary)) console.log(`  hint: ${e.hint}`);
      if (e.details && typeof e.details === 'object' && Object.keys(e.details).length) {
        console.log(`  details: ${JSON.stringify(e.details)}`);
      }
      if (e.params && typeof e.params === 'object' && Object.keys(e.params).length) {
        console.log(`  params: ${JSON.stringify(e.params)}`);
      }
      const st = e.state;
      if (st && typeof st === 'object') {
        const bits = [];
        if (st.health !== undefined) bits.push(`HP:${st.health}`);
        if (st.food !== undefined) bits.push(`Food:${st.food}`);
        if (st.position) bits.push(`Pos:${fmtPos(st.position)}`);
        if (st.holding !== undefined) bits.push(`Hold:${st.holding}`);
        if (bits.length) console.log(`  state: ${bits.join(' | ')}`);
      }
    }
    return summary;
  }

  const e = /** @type {any} */ (envelope);
  if (e.empty) console.log(`(empty) ${e.hint || ''}`);
  const d = e.data;
  const st = e.state;

  // On the happy path, only surface chat events from the state block —
  // HP/Food/Pos/Hold are noise that the agent can fetch with mc status
  // when relevant. Prepending it to every tool response was costing
  // ~50 tokens/call. The agent already has the world state from its
  // last explicit status call.
  if (st && typeof st === 'object' && st.new_chat?.length) {
    for (const m of st.new_chat) console.log(`  chat <${m.from}> ${m.message}`);
  }

  // Print the action's human-readable result line. Action handlers put it
  // at envelope top-level ({ ok, data, result }); some legacy code paths
  // nest it under data. Check both.
  const resultStr = typeof e?.result === 'string'
    ? e.result
    : typeof d?.result === 'string'
      ? d.result
      : null;
  if (resultStr) console.log(`  ${resultStr}`);

  if (Array.isArray(d?.hints) && d.hints.length) {
    for (const h of d.hints) console.log(`  hint: ${h}`);
  }

  if (d && typeof d === 'object') {
    // D2: navigation brief is rendered text; typed struct stays in JSON (--json) only.
    if (typeof d.nav_brief_text === 'string' && d.nav_brief_text.trim()) {
      console.log(d.nav_brief_text.trim());
      if (d.nav_brief_status) console.log(`  nav_brief_status: ${d.nav_brief_status}`);
      projectObserveTail(d);
      return '';
    }
    if (d.nav_header && typeof d.nav_header === 'object' && e.command === 'observe') {
      console.log(formatNavFrameLine(d));
      if (d.journey?.line) console.log(`journey: ${d.journey.line}`);
      projectObserveTail(d);
      return '';
    }
    // #50 follow-up: surface the compact nav line on scene + status too —
    // workers favor those over observe, and the server now ships nav_header
    // on their envelopes. Without this, the header arrives in the JSON but
    // never reaches the agent's rendered output. Print as a prefix line and
    // fall through to the verb's normal rendering (summary, blocks, etc.).
    // Identity leads every status read (proc-nav-1781014144: a worker ran
    // 200+ commands as the wrong bot because nothing surfaced who it was).
    if (typeof d.identity === 'string' && e.command === 'status') {
      console.log(d.identity);
    }
    if (
      d.nav_header &&
      typeof d.nav_header === 'object' &&
      (e.command === 'scene' || e.command === 'status')
    ) {
      console.log(formatNavFrameLine(d));
    }
    if (d.map && typeof d.map === 'string') {
      console.log(d.map);
      if (d.legend) console.log(d.legend);
      return '';
    }
    if (d.description && typeof d.description === 'string') {
      console.log(d.description);
      return '';
    }
    if (d.summary && typeof d.summary === 'string') {
      console.log(d.summary);
      if (Array.isArray(d.recommendations) && d.recommendations.length) {
        for (const rec of d.recommendations.slice(0, 8)) {
          const pos = rec.position ? ` @${rec.position.join(',')}` : '';
          const kind = rec.kind || 'action';
          const target = rec.block_or_entity || rec.entity || '';
          console.log(
            `  → ${kind}${target ? ` ${target}` : ''}${pos} (${rec.confidence || '?'}) — ${rec.rationale || ''}`,
          );
        }
      }
      if (Array.isArray(d.caveats) && d.caveats.length) {
        for (const c of d.caveats.slice(0, 4)) console.log(`  caveat: ${c}`);
      }
      if (d.nothing_actionable) console.log('  (nothing actionable)');
      if (d.timing?.total_ms != null) {
        console.log(
          `  timing: http ${d.timing.http_ms}ms + digest ${d.timing.digest_ms}ms (${d.timing.model || 'model?'})`,
        );
      }
      return '';
    }
    if (d.categories && typeof d.categories === 'object') {
      for (const [cat, items] of Object.entries(d.categories)) {
        console.log(`  [${String(cat).toUpperCase()}]`);
        for (const it of /** @type {any[]} */ (items))
          console.log(`    ${it.name} x${it.count}`);
      }
      return '';
    }
    if (Array.isArray(d.entities) && Array.isArray(d.blocks)) {
      console.log(`  entities (${d.entities.length}):`);
      for (const ent of d.entities.slice(0, 12)) {
        const p = ent.position;
        const loc = p ? ` @${p.x},${p.y},${p.z}` : '';
        console.log(`    ${ent.type} (${ent.distance}m)${loc}`);
      }
      console.log(`  blocks (${d.blocks.length} types):`);
      for (const b of d.blocks.slice(0, 15)) {
        const n = b.nearest;
        const loc = n ? ` nearest:${n.x},${n.y},${n.z}` : '';
        console.log(`    ${b.name} x${b.count}${loc}`);
      }
      return '';
    }
    if (Array.isArray(d.messages)) {
      if (!d.messages.length) console.log('  (no messages)');
      else for (const m of d.messages) console.log(`  <${m.from}> ${m.message}`);
      return '';
    }
    if (Array.isArray(d.locations)) {
      for (const loc of d.locations.slice(0, 20))
        console.log(`    (${loc.x},${loc.y},${loc.z}) — ${loc.distance}m`);
      return '';
    }
  }

  // Fallback JSON. Pretty-print when stdout is a TTY (a human is reading
  // it), compact when piped (LLM agents or other tools consuming it) —
  // compact JSON is ~50% smaller and saves real tokens in agent runs.
  const pretty = process.stdout.isTTY;
  console.log(JSON.stringify(e, null, pretty ? 2 : undefined));
  return '';
}
