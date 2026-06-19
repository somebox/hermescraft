import { simulateMcLine } from './cli-simulate.mjs';

export function extractMcLines(content) {
  return content
    .split('\n')
    .map((l) => l.trim())
    .map((l) => l.replace(/^[`*\d.\s>-]+/, '').trim())
    .map((l) => l.replace(/`+$/, '').trim())
    .map((l) => l.split('`')[0].split(/\s+—\s+/)[0].trim())
    .filter((l) => l.startsWith('mc '));
}

export function gradeDirect(content, correctList) {
  const lines = extractMcLines(content);
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const line of lines) {
    for (const correct of correctList) {
      if (norm(line) === norm(correct)) return { pass: true, match: 'exact', mc_lines: lines };
      if (norm(line).startsWith(norm(correct))) return { pass: true, match: 'prefix', mc_lines: lines };
    }
  }
  return { pass: false, mc_lines: lines };
}

export function gradeCompositionMc(mcLines, requiredLines, scoring, correctLineGroups) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const partialArgsOk = scoring && scoring.includes('partial_args_ok');
  /** @type {string[][]} */
  const groups =
    Array.isArray(correctLineGroups) && correctLineGroups.length > 0
      ? correctLineGroups
      : (requiredLines || []).map((r) => [r]);

  const matched = [];
  for (const group of groups) {
    /** @type {string|null} */
    let satisfied = null;
    for (const required of group) {
      const r = norm(required);
      let found = false;
      for (const line of mcLines) {
        const l = norm(line);
        if (partialArgsOk) {
          const reqVerb = r.split(/\s+/).slice(0, 2).join(' ');
          if (l.startsWith(reqVerb)) {
            found = true;
            break;
          }
        } else if (l === r || l.startsWith(r)) {
          found = true;
          break;
        }
      }
      if (found) {
        satisfied = required;
        break;
      }
    }
    matched.push(satisfied);
  }
  return { pass: matched.every(Boolean), matched, mc_lines: mcLines };
}

/**
 * @param {string} content model output
 * @param {string[]} requiredLines fallback singles when `correctLineGroups` omitted
 * @param {string} scoring
 * @param {string[][] | undefined} correctLineGroups each inner array is alternatives (OR) for one slot
 */
export function gradeComposition(content, requiredLines, scoring, correctLineGroups) {
  return gradeCompositionMc(extractMcLines(content), requiredLines, scoring, correctLineGroups);
}

/**
 * @param {string} content model output
 * @param {Record<string, unknown>} task task row with `.challenge` rules
 */
export function gradeChallenge(content, task) {
  const ch = /** @type {Record<string, unknown>} */ (task.challenge || {});
  const lines = extractMcLines(content);
  const simulated_lines = lines.map((ln) => simulateMcLine(ln));
  const canonicals = simulated_lines.map((s) => s.canonical_name).filter(Boolean);

  const parse_ok_rate =
    lines.length === 0
      ? null
      : simulated_lines.filter((s) => s.parse_ok === true).length / lines.length;

  let pass = true;
  /** @type {string[]} */
  const reasons = [];

  const correct = /** @type {string[]|undefined} */ (ch.correct);
  if (correct?.length) {
    const sub = gradeDirect(content, correct);
    if (!sub.pass) {
      pass = false;
      reasons.push('reference_answer_mismatch');
    }
  }

  const correctLines = /** @type {string[]|undefined} */ (ch.correct_lines_required);
  const correctLineGroups = /** @type {string[][]|undefined} */ (ch.correct_line_groups);
  if (correctLines?.length || (correctLineGroups?.length ?? 0) > 0) {
    const scoring = typeof ch.scoring === 'string' ? ch.scoring : 'all_lines_present';
    const linesReq = correctLines?.length ? correctLines : correctLineGroups?.map((g) => g[0]) ?? [];
    const sub = gradeComposition(content, linesReq, scoring, correctLineGroups);
    if (!sub.pass) {
      pass = false;
      reasons.push('sequence_mismatch');
    }
  }

  for (const f of /** @type {string[]} */ (ch.forbidden_canonical || [])) {
    if (canonicals.includes(f)) {
      pass = false;
      reasons.push(`forbidden:${f}`);
    }
  }

  for (const r of /** @type {string[]} */ (ch.required_canonical_all || [])) {
    if (!canonicals.includes(r)) {
      pass = false;
      reasons.push(`missing:${r}`);
    }
  }

  const reqAny = /** @type {string[]|undefined} */ (ch.required_canonical_any);
  if (reqAny?.length) {
    const hit = reqAny.some((n) => canonicals.includes(n));
    if (!hit) {
      pass = false;
      reasons.push('required_any_missing');
    }
  }

  if (ch.require_parse_ok !== false && simulated_lines.some((s) => s.parse_ok === false)) {
    pass = false;
    reasons.push('cli_parse_error');
  }

  const maxLines = ch.max_mc_lines;
  if (maxLines != null && typeof maxLines === 'number' && lines.length > maxLines) {
    pass = false;
    reasons.push('too_many_lines');
  }

  let semantic_score = pass ? 1 : 0;
  if (!pass) {
    semantic_score = parse_ok_rate != null ? parse_ok_rate * 0.3 : 0;
    if (canonicals.length) semantic_score = Math.max(semantic_score, 0.12);
    if (correct?.length && gradeDirect(content, correct).pass) semantic_score = Math.max(semantic_score, 0.88);
    const reqAll = /** @type {string[]} */ (ch.required_canonical_all || []);
    if (reqAll.length && reqAll.every((r) => canonicals.includes(r)))
      semantic_score = Math.max(semantic_score, 0.55);
    if (correctLines?.length || (correctLineGroups?.length ?? 0) > 0) {
      const scoring = typeof ch.scoring === 'string' ? ch.scoring : 'all_lines_present';
      const linesReq = correctLines?.length ? correctLines : correctLineGroups?.map((g) => g[0]) ?? [];
      const slotCount =
        correctLineGroups?.length && correctLineGroups.length > 0
          ? correctLineGroups.length
          : (correctLines?.length ?? 0);
      const hits = gradeComposition(content, linesReq, scoring, correctLineGroups).matched?.filter(Boolean)
        .length ?? 0;
      const frac = slotCount ? hits / slotCount : 0;
      semantic_score = Math.max(semantic_score, frac * 0.5);
    }
  }

  return {
    pass,
    semantic_score,
    parse_ok_rate,
    mc_lines: lines,
    simulated_lines,
    challenge_reasons: reasons.length ? reasons : undefined,
  };
}

/**
 * Attach CLI simulation + coarse semantic score to direct/composition results.
 */
export function enrichWithSimulation(grade, content) {
  const lines = grade.mc_lines ?? extractMcLines(content || '');
  const simulated_lines = lines.map((ln) => simulateMcLine(ln));
  const parse_ok_rate =
    lines.length === 0 ? null : simulated_lines.filter((s) => s.parse_ok === true).length / lines.length;

  let semantic_score = grade.pass ? 1 : 0;
  if (!grade.pass) {
    if (!lines.length) semantic_score = 0;
    else {
      semantic_score = parse_ok_rate != null ? parse_ok_rate * 0.3 : 0;
      if (parse_ok_rate === 1) semantic_score = Math.max(semantic_score, 0.42);
      if (simulated_lines.some((s) => s.known_command)) semantic_score = Math.max(semantic_score, 0.12);
    }
  }

  return {
    ...grade,
    simulated_lines,
    parse_ok_rate,
    semantic_score,
  };
}
