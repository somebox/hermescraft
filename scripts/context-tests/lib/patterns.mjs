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

const HANDLERS = {
  defense_class_action_first: defenseClassActionFirst,
  next_action_hint_followed: nextActionHintFollowed,
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
