import { extractMcLines } from '../benchmark/grading.mjs';
import { simulateMcLine } from '../benchmark/cli-simulate.mjs';
import { gradeShellExpect } from './lib/shell-lines.mjs';

const CLI_ONLY = new Set([
  'commands',
  'help',
  'dashboard',
  'anchors',
  'batch',
  'screenshot_meta',
]);

const DEFAULT_ORDER_IGNORE = new Set([
  'status',
  'observe',
  'read_chat',
  'task',
  'goals',
  'inventory',
]);

export function parseBody(body) {
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

function stableBodyKey(body) {
  return JSON.stringify(body, Object.keys(body).sort());
}

function coordsFromBody(body, keys = ['x', 'y', 'z']) {
  const o = parseBody(body);
  const c = {};
  for (const k of keys) {
    if (o[k] != null) c[k] = Number(o[k]);
  }
  return Object.keys(c).length === keys.length ? c : null;
}

function inBbox(coord, bbox) {
  if (!coord || !bbox) return false;
  const { x1, y1, z1, x2, y2, z2 } = bbox;
  const x = coord.x;
  const y = coord.y;
  const z = coord.z;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const minZ = Math.min(z1, z2);
  const maxZ = Math.max(z1, z2);
  return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
}

function matchWhere(body, where) {
  const o = parseBody(body);
  for (const [key, spec] of Object.entries(where)) {
    if (spec && typeof spec === 'object' && spec.optional) continue;
    if (!(key in o)) return false;
    const val = o[key];
    if (spec == null || typeof spec !== 'object') {
      if (val !== spec) return false;
      continue;
    }
    if (spec.type === 'integer' || spec.type === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n)) return false;
      if (spec.min != null && n < spec.min) return false;
      if (spec.max != null && n > spec.max) return false;
      continue;
    }
    if (spec.type === 'string') {
      if (typeof val !== 'string') return false;
      continue;
    }
    if (spec.regex) {
      if (!new RegExp(spec.regex, 'i').test(String(val))) return false;
      continue;
    }
    if (spec.oneOf) {
      if (!spec.oneOf.includes(val)) return false;
      continue;
    }
  }
  return true;
}

function linesToSimulated(content) {
  const mcLines = extractMcLines(content);
  return mcLines.map((ln) => ({ line: ln, sim: simulateMcLine(ln) }));
}

function extractChatLines(content) {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('mc '));
}

/**
 * @returns {{ pass: boolean, trace: object[], simulated_requests: object[], mc_lines: string[], chat_lines: string[] }}
 */
export function gradeExpect(content, expect, options = {}) {
  const surface = options.surface || (expect?.shell_commands ? 'shell' : 'mc');
  if (surface === 'shell') {
    return gradeShellExpect(content, expect);
  }
  const trace = [];
  const tc = expect?.tool_calls || {};
  const rows = linesToSimulated(content);
  const mc_lines = rows.map((r) => r.line);
  const chat_lines = extractChatLines(content);
  const simulated_requests = rows.map((r) => ({
    canonical_name: r.sim.canonical_name,
    parse_ok: r.sim.parse_ok,
    simulated_request: r.sim.simulated_request,
    raw: r.line,
  }));

  let pass = true;

  const canonicals = rows.map((r) => r.sim.canonical_name).filter(Boolean);

  if (tc.max_lines != null && mc_lines.length > tc.max_lines) {
    pass = false;
    trace.push({
      matcher: 'max_lines',
      status: 'fail',
      evidence: { count: mc_lines.length, max: tc.max_lines },
    });
  } else if (tc.max_lines != null) {
    trace.push({ matcher: 'max_lines', status: 'pass', evidence: { count: mc_lines.length } });
  }

  if (tc.require_parse_ok) {
    const bad = rows.filter((r) => r.sim.known_command && !r.sim.parse_ok);
    if (bad.length) {
      pass = false;
      trace.push({ matcher: 'require_parse_ok', status: 'fail', evidence: { bad: bad.map((b) => b.line) } });
    } else {
      trace.push({ matcher: 'require_parse_ok', status: 'pass', evidence: {} });
    }
  }

  for (const f of tc.forbidden_canonical || []) {
    const hit = canonicals.includes(f);
    if (hit) {
      pass = false;
      trace.push({ matcher: 'forbidden_canonical', status: 'fail', evidence: { forbidden: f, emitted: canonicals } });
    } else {
      trace.push({ matcher: 'forbidden_canonical', status: 'pass', evidence: { forbidden: f } });
    }
  }

  const reqAny = tc.required_canonical_any || [];
  if (reqAny.length) {
    const matched = reqAny.find((n) => canonicals.includes(n));
    if (!matched) {
      pass = false;
      trace.push({ matcher: 'required_canonical_any', status: 'fail', evidence: { required: reqAny, emitted: canonicals } });
    } else {
      trace.push({ matcher: 'required_canonical_any', status: 'pass', evidence: { matched } });
    }
  }

  for (const r of tc.required_canonical_all || []) {
    if (!canonicals.includes(r)) {
      pass = false;
      trace.push({ matcher: 'required_canonical_all', status: 'fail', evidence: { missing: r } });
    } else {
      trace.push({ matcher: 'required_canonical_all', status: 'pass', evidence: { matched: r } });
    }
  }

  for (const rule of tc.required_body || []) {
    const verb = rule.verb;
    const hit = rows.find((r) => r.sim.canonical_name === verb && matchWhere(r.sim.simulated_request?.body, rule.where || {}));
    if (!hit) {
      pass = false;
      trace.push({ matcher: 'required_body', status: 'fail', evidence: { verb, where: rule.where } });
    } else {
      trace.push({
        matcher: 'required_body',
        status: 'pass',
        evidence: { verb, body: parseBody(hit.sim.simulated_request?.body) },
      });
    }
  }

  for (const rule of tc.forbidden_body || []) {
    const verb = rule.verb;
    const hit = rows.find((r) => r.sim.canonical_name === verb && matchWhere(r.sim.simulated_request?.body, rule.where || {}));
    if (hit) {
      pass = false;
      trace.push({ matcher: 'forbidden_body', status: 'fail', evidence: { verb, line: hit.line } });
    } else {
      trace.push({ matcher: 'forbidden_body', status: 'pass', evidence: { verb } });
    }
  }

  for (const rule of tc.forbidden_coord_in_bbox || []) {
    if (!rule.bbox) continue;
    const verbs = new Set(rule.verbs || []);
    const keys = rule.body_keys || ['x', 'y', 'z'];
    for (const r of rows) {
      if (verbs.size && !verbs.has(r.sim.canonical_name)) continue;
      const coord = coordsFromBody(r.sim.simulated_request?.body, keys);
      if (coord && inBbox(coord, rule.bbox)) {
        pass = false;
        trace.push({
          matcher: 'forbidden_coord_in_bbox',
          status: 'fail',
          evidence: { line: r.line, coord, bbox: rule.bbox },
        });
        break;
      }
    }
    if (pass) trace.push({ matcher: 'forbidden_coord_in_bbox', status: 'pass', evidence: {} });
  }

  if (tc.order?.sequence?.length) {
    const ignore = new Set(tc.order.ignore || [...DEFAULT_ORDER_IGNORE]);
    const horizon = tc.order.horizon ?? 20;
    const filtered = rows
      .map((r) => r.sim.canonical_name)
      .filter((c) => c && !ignore.has(c))
      .slice(0, horizon);
    const seq = tc.order.sequence;
    let idx = 0;
    for (const c of filtered) {
      if (c === seq[idx]) idx++;
      if (idx >= seq.length) break;
    }
    if (idx < seq.length) {
      pass = false;
      trace.push({
        matcher: 'order',
        status: 'fail',
        evidence: { expected: seq, seen: filtered },
      });
    } else {
      trace.push({ matcher: 'order', status: 'pass', evidence: { sequence: seq } });
    }
  }

  const rep = tc.max_repeats_of_same_call;
  if (rep?.enabled) {
    const max = rep.max ?? 1;
    const scope = rep.scope || ['canonical', 'body'];
    const counts = new Map();
    for (const r of rows) {
      const parts = [r.sim.canonical_name];
      if (scope.includes('body')) parts.push(stableBodyKey(parseBody(r.sim.simulated_request?.body)));
      const key = parts.join('|');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const over = [...counts.entries()].filter(([, n]) => n > max);
    if (over.length) {
      pass = false;
      trace.push({ matcher: 'max_repeats_of_same_call', status: 'fail', evidence: { over } });
    } else {
      trace.push({ matcher: 'max_repeats_of_same_call', status: 'pass', evidence: { max } });
    }
  }

  for (const rule of tc.arg_regex_fallback || []) {
    const verb = rule.verb;
    const re = new RegExp(rule.arg_regex, 'i');
    const hit = rows.some(
      (r) =>
        r.sim.canonical_name === verb &&
        re.test(r.line.replace(/^mc\s+/, '')),
    );
    if (!hit) {
      pass = false;
      trace.push({ matcher: 'arg_regex_fallback', status: 'fail', evidence: { verb } });
    } else {
      trace.push({ matcher: 'arg_regex_fallback', status: 'pass', evidence: { verb } });
    }
  }

  for (const needle of expect?.chat_contains_any || []) {
    const hit = chat_lines.some((l) => l.toLowerCase().includes(String(needle).toLowerCase()));
    if (!hit) {
      pass = false;
      trace.push({ matcher: 'chat_contains_any', status: 'fail', evidence: { needle } });
    } else {
      trace.push({ matcher: 'chat_contains_any', status: 'pass', evidence: { needle } });
    }
  }

  for (const pat of expect?.chat_contains_regex || []) {
    const re = new RegExp(pat, 'i');
    const hit = chat_lines.some((l) => re.test(l));
    if (!hit) {
      pass = false;
      trace.push({ matcher: 'chat_contains_regex', status: 'fail', evidence: { pat } });
    } else {
      trace.push({ matcher: 'chat_contains_regex', status: 'pass', evidence: { pat } });
    }
  }

  return { pass, trace, simulated_requests, mc_lines, chat_lines };
}

export { CLI_ONLY };
export { runPatterns } from './lib/patterns.mjs';
