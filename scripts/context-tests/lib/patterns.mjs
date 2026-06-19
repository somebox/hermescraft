import { simulateMcLine } from '../../benchmark/cli-simulate.mjs';

const DEFAULT_IGNORE = new Set(['status', 'observe', 'read_chat', 'task', 'goals', 'inventory']);

function canonicalsFromRows(rows, ignore = DEFAULT_IGNORE) {
  return rows
    .map((r) => r.canonical_name || r.sim?.canonical_name)
    .filter((c) => c && !ignore.has(c));
}

function getByPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function hintFromPrior(prior, hintPath) {
  if (!prior?.length) return null;
  const last = prior[prior.length - 1];
  const tr = last.tool_result || {};
  let h = getByPath(tr, hintPath);
  if (h == null && tr.data?.breach?.next_action_hint) h = tr.data.breach.next_action_hint;
  if (h == null && tr.error?.next_action_hint) h = tr.error.next_action_hint;
  return typeof h === 'string' ? h.trim() : null;
}

function defenseClassActionFirst(rows, args) {
  const allowed = new Set(args.allowed || ['wall', 'place', 'fence', 'fill']);
  const perception = new Set(args.perception_allowed || ['map', 'scene', 'observe']);
  const maxP = args.max_perception ?? 1;
  const seq = canonicalsFromRows(rows);
  let i = 0;
  let pCount = 0;
  while (i < seq.length && perception.has(seq[i]) && pCount < maxP) {
    pCount++;
    i++;
  }
  if (i >= seq.length) {
    return pCount > 0 && pCount <= maxP
      ? { pass: true, evidence: { seq, note: 'perception_only' } }
      : { pass: false, evidence: { seq, reason: 'no_actions' } };
  }
  const first = seq[i];
  const pass = allowed.has(first);
  return {
    pass,
    evidence: { seq, first_action: first, perception_prefix: seq.slice(0, i) },
  };
}

function nextActionHintFollowed(rows, args, ctx) {
  const hintPath = args.hint_path || 'error.next_action_hint';
  const hint = hintFromPrior(ctx?.prior, hintPath);
  if (!hint) {
    return { pass: false, evidence: { reason: 'no_hint_in_prior' } };
  }
  const line = hint.startsWith('mc ') ? hint : `mc ${hint}`;
  const hintSim = simulateMcLine(line);
  const seq = canonicalsFromRows(rows);
  if (!seq.length) {
    return { pass: false, evidence: { hint: line, reason: 'no_mc_emitted' } };
  }
  const first = seq[0];
  const pass = first === hintSim.canonical_name;
  return {
    pass,
    evidence: {
      hint: line,
      hint_canonical: hintSim.canonical_name,
      first_emitted: first,
      parse_ok: hintSim.parse_ok,
    },
  };
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

function priorAssistantMcLine(prior, index = 0) {
  const item = prior?.[index];
  if (!item?.assistant) return null;
  const line = String(item.assistant).trim();
  return line.startsWith('mc ') ? line : line.includes('mc ') ? line.slice(line.indexOf('mc ')) : null;
}

function worldShapingActionFirst(rows, args) {
  const allowed = new Set(
    args.allowed || [
      'deck',
      'place',
      'level_ground',
      'clear_strip',
      'build_stairs',
      'tunnel',
      'fell_tree',
      'dig',
      'fill',
    ],
  );
  const perception = new Set(
    args.perception_allowed || ['map', 'scene', 'observe', 'standing', 'reachable', 'terrain_top'],
  );
  const maxP = args.max_perception ?? 1;
  const seq = canonicalsFromRows(rows, new Set([...DEFAULT_IGNORE, ...perception]));
  let i = 0;
  let pCount = 0;
  const allCanon = canonicalsFromRows(rows);
  while (i < allCanon.length && perception.has(allCanon[i]) && pCount < maxP) {
    pCount++;
    i++;
  }
  if (i >= allCanon.length) {
    return { pass: false, evidence: { reason: 'perception_only_no_shaping' } };
  }
  const first = allCanon[i];
  const pass = allowed.has(first);
  return { pass, evidence: { seq: allCanon, first_action: first, perception_prefix: allCanon.slice(0, i) } };
}

function noBlindNavRetry(rows, args, ctx) {
  const prior = ctx?.prior;
  const idx = args.prior_index ?? 0;
  const forbidden = new Set(args.forbidden_canonical || ['goto', 'move']);
  const priorLine = priorAssistantMcLine(prior, idx);
  if (!priorLine) return { pass: true, evidence: { note: 'no_prior_mc_line' } };
  const priorSim = simulateMcLine(priorLine);
  const seq = canonicalsFromRows(rows);
  if (!seq.length) return { pass: false, evidence: { reason: 'no_mc_emitted' } };
  const first = seq[0];
  const firstRow = rows.find((r) => (r.canonical_name || r.sim?.canonical_name) === first);
  const firstLine = firstRow?.line || '';
  const firstSim = simulateMcLine(firstLine.startsWith('mc ') ? firstLine : `mc ${firstLine}`);
  const sameVerb = first === priorSim.canonical_name && forbidden.has(first);
  const sameBody =
    sameVerb &&
    JSON.stringify(parseBody(firstSim.simulated_request?.body)) ===
      JSON.stringify(parseBody(priorSim.simulated_request?.body));
  const pass = !(sameVerb && (sameBody || !priorSim.simulated_request?.body));
  return {
    pass,
    evidence: {
      prior_line: priorLine,
      first_emitted: first,
      repeated_blind_retry: !pass,
    },
  };
}

function repairOrEscalate(rows, args) {
  const repair = new Set(
    args.repair_verbs || ['deck', 'place', 'level_ground', 'clear_strip', 'build_stairs', 'tunnel', 'fell_tree', 'mark', 'move', 'through', 'goto_near'],
  );
  const perception = new Set(args.perception_allowed || ['observe', 'scene', 'map', 'standing', 'reachable']);
  const maxP = args.max_perception ?? 1;
  const seq = canonicalsFromRows(rows);
  let i = 0;
  let pCount = 0;
  while (i < seq.length && perception.has(seq[i]) && pCount < maxP) {
    pCount++;
    i++;
  }
  if (i >= seq.length) return { pass: false, evidence: { seq, reason: 'no_action_after_perception' } };
  const first = seq[i];
  const pass = repair.has(first);
  return { pass, evidence: { seq, first_meaningful: first } };
}

function bboxOverlapAreaVerb(body, forbiddenBbox) {
  const o = parseBody(body);
  const x1 = Number(o.x1 ?? o.x);
  const x2 = Number(o.x2 ?? o.x);
  const z1 = Number(o.z1 ?? o.z);
  const z2 = Number(o.z2 ?? o.z);
  if (![x1, x2, z1, z2].every(Number.isFinite)) return false;
  const fb = forbiddenBbox;
  const minX = Math.min(fb.x1, fb.x2);
  const maxX = Math.max(fb.x1, fb.x2);
  const minZ = Math.min(fb.z1, fb.z2);
  const maxZ = Math.max(fb.z1, fb.z2);
  const minY = Math.min(fb.y1 ?? fb.y ?? -64, fb.y2 ?? fb.y ?? 320);
  const maxY = Math.max(fb.y1 ?? fb.y ?? -64, fb.y2 ?? fb.y ?? 320);
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
    for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
      if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
        const y = Number(o.y ?? o.target_y ?? fb.y1);
        if (y >= minY && y <= maxY) return true;
      }
    }
  }
  return false;
}

function forbiddenBboxForAreaVerbs(rows, args) {
  const verbs = new Set(args.verbs || ['deck', 'level_ground', 'clear_strip']);
  const fb = args.forbidden_bbox;
  if (!fb) return { pass: false, evidence: { reason: 'missing_forbidden_bbox' } };
  for (const r of rows) {
    const c = r.canonical_name || r.sim?.canonical_name;
    if (!verbs.has(c)) continue;
    if (bboxOverlapAreaVerb(r.sim?.simulated_request?.body, fb)) {
      return { pass: false, evidence: { verb: c, line: r.line, forbidden_bbox: fb } };
    }
  }
  return { pass: true, evidence: {} };
}

function dryRunBeforeExecute(rows, args) {
  const verbs = new Set(args.verbs || ['level_ground', 'deck']);
  let sawDryRun = false;
  let sawExecute = false;
  for (const r of rows) {
    const c = r.canonical_name || r.sim?.canonical_name;
    if (!verbs.has(c)) continue;
    const o = parseBody(r.sim?.simulated_request?.body);
    if (o.dry_run === true || o.dry_run === 'true') sawDryRun = true;
    if (o.execute === true || o.execute === 'true') sawExecute = true;
  }
  if (sawExecute && !sawDryRun) {
    return { pass: false, evidence: { reason: 'execute_without_dry_run', sawExecute, sawDryRun } };
  }
  if (!sawDryRun && rows.some((r) => verbs.has(r.canonical_name || r.sim?.canonical_name))) {
    const first = rows.find((r) => verbs.has(r.canonical_name || r.sim?.canonical_name));
    const o = parseBody(first?.sim?.simulated_request?.body);
    if (o.execute !== true && o.dry_run !== true) {
      return { pass: false, evidence: { reason: 'expected_dry_run_first', first_verb: first?.sim?.canonical_name } };
    }
  }
  return { pass: true, evidence: { sawDryRun, sawExecute } };
}

const HANDLERS = {
  defense_class_action_first: defenseClassActionFirst,
  next_action_hint_followed: nextActionHintFollowed,
  world_shaping_action_first: worldShapingActionFirst,
  no_blind_nav_retry: noBlindNavRetry,
  repair_or_escalate: repairOrEscalate,
  forbidden_bbox_for_area_verbs: forbiddenBboxForAreaVerbs,
  dry_run_before_execute: dryRunBeforeExecute,
};

/**
 * @param {object[]} simulatedRequests rows from gradeExpect
 * @param {object[]} patternSpecs from scenario YAML
 * @param {{ prior?: object[] }} ctx
 */
export function runPatterns(simulatedRequests, patternSpecs, ctx = {}) {
  const trace = [];
  let pass = true;
  const rows = simulatedRequests || [];
  for (const spec of patternSpecs || []) {
    const type = spec.type;
    const id = spec.id || type;
    const fn = HANDLERS[type];
    if (!fn) {
      pass = false;
      trace.push({ matcher: `pattern:${id}`, status: 'fail', evidence: { reason: 'unknown_pattern_type', type } });
      continue;
    }
    const sub = fn(rows, spec.args || {}, ctx);
    if (!sub.pass) pass = false;
    trace.push({
      matcher: `pattern:${id}`,
      status: sub.pass ? 'pass' : 'fail',
      evidence: sub.evidence,
    });
  }
  return { pass, trace };
}
