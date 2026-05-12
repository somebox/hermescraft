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

function fmtPos(p) {
  if (!p || typeof p !== 'object') return String(p);
  return `${p.x},${p.y},${p.z}`;
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

  if (typeof d?.result === 'string') console.log(`  ${d.result}`);

  if (Array.isArray(d?.hints) && d.hints.length) {
    for (const h of d.hints) console.log(`  hint: ${h}`);
  }

  if (d && typeof d === 'object') {
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
