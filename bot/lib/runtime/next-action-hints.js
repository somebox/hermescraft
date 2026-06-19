/**
 * Priority-ordered, deduped observe hints (parity with context-test fixtures).
 */

const DESTRUCTIVE_MC = /^\s*mc\s+(dig_area|tunnel|dig\b|build_stairs)/i;
const SAFE_MC = /^\s*mc\s+(move|goto_near|goto\b|check|go_site|go_mark|escape|stair_up|stair_down|reachable|scene|map)\b/i;

/** @param {string} line */
export function normalizeHintCommandLine(line) {
  if (typeof line !== 'string' || !line.trim()) return '';
  let s = line.trim();
  const hash = s.indexOf('  #');
  if (hash >= 0) s = s.slice(0, hash).trim();
  const semi = s.indexOf(';');
  if (semi >= 0) s = s.split(';').map((p) => p.trim()).find((p) => /^mc\s/i.test(p)) || s.slice(0, semi).trim();
  if (!/^mc\s/i.test(s) && /^suggested:/i.test(line)) return '';
  return s;
}

/** @param {string} line */
export function isDestructiveNavHint(line) {
  const cmd = normalizeHintCommandLine(line);
  return DESTRUCTIVE_MC.test(cmd);
}

/**
 * Lower score = earlier in list.
 * @param {string} line
 */
export function hintPriorityScore(line) {
  const cmd = normalizeHintCommandLine(line);
  if (!cmd) return 90;
  if (/^mc move\b/i.test(cmd)) return 0;
  if (/^mc goto_near\b/i.test(cmd)) return 1;
  if (/^mc goto\b/i.test(cmd)) return 2;
  if (/^mc (check|go_site|go_mark|escape)\b/i.test(cmd)) return 3;
  if (/^mc (stair_up|stair_down|reachable)\b/i.test(cmd)) return 4;
  if (/^mc (scene|map)\b/i.test(cmd)) return 5;
  if (DESTRUCTIVE_MC.test(cmd)) return 50;
  if (SAFE_MC.test(cmd)) return 10;
  return 20;
}

/**
 * @param {string[]} rawLines
 * @param {{ cap?: number, staleBrief?: boolean, briefRefreshRequired?: boolean }} [opts]
 * @returns {string[]}
 */
export function collectNextActionHints(rawLines, opts = {}) {
  const cap = Math.max(1, Math.min(5, opts.cap ?? 5));
  if (opts.staleBrief === true || opts.briefRefreshRequired === true) {
    return [];
  }
  const seen = new Set();
  const scored = [];
  for (const raw of rawLines) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const norm = normalizeHintCommandLine(raw);
    const key = norm.toLowerCase();
    if (!norm || seen.has(key)) continue;
    seen.add(key);
    scored.push({ raw: raw.trim(), score: hintPriorityScore(raw) });
  }
  scored.sort((a, b) => a.score - b.score || a.raw.localeCompare(b.raw));
  const safeFirst = scored.filter((e) => !isDestructiveNavHint(e.raw));
  const destructive = scored.filter((e) => isDestructiveNavHint(e.raw));
  const ordered = safeFirst.length ? [...safeFirst, ...destructive] : scored;
  return ordered.slice(0, cap).map((e) => e.raw);
}

/**
 * @param {{
 *   navHeader?: { suggested_hint?: string } | null,
 *   navBrief?: { paths?: Array<{ composite_hint?: string, verb?: string, args?: string, suggested?: boolean, blocked?: boolean, stale_after_mutation?: boolean }> } | null,
 *   navBriefStatus?: string | null,
 *   briefRefreshRequired?: boolean,
 * }} input
 */
export function buildObserveNextActionHints(input = {}) {
  const staleBrief = input.navBriefStatus === 'STALE_BRIEF';
  const refresh = input.briefRefreshRequired === true;
  const lines = [];
  const sh = input.navHeader?.suggested_hint;
  if (typeof sh === 'string' && sh.trim()) lines.push(sh.trim());

  const paths = input.navBrief?.paths;
  if (Array.isArray(paths)) {
    for (const row of paths) {
      if (row.stale_after_mutation) continue;
      if (row.blocked && !row.suggested) continue;
      const cmd = row.composite_hint || (row.verb && row.args ? `mc ${row.verb} ${row.args}` : null);
      if (typeof cmd === 'string' && cmd.trim()) lines.push(cmd.trim());
    }
  }

  return collectNextActionHints(lines, {
    cap: 5,
    staleBrief,
    briefRefreshRequired: refresh,
  });
}
