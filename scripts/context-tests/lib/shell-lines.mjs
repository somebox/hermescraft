/** Extract orchestrator-style shell command lines from model output (not mc). */

function normalizeLine(l) {
  return l
    .trim()
    .replace(/^[`*\d.\s>-]+/, '')
    .trim();
}

/**
 * Lines that look like Steward/orchestrator actions: hermes *, scripts/*, ./scripts/*
 */
export function extractShellCommandLines(content) {
  if (!content || typeof content !== 'string') return [];
  const prefixes = ['hermes ', 'scripts/', './scripts/'];
  return content
    .split('\n')
    .map(normalizeLine)
    .filter((l) => l && prefixes.some((p) => l.startsWith(p)));
}

/**
 * @param {string} content
 * @param {{ shell_commands?: object }} expect
 */
export function gradeShellExpect(content, expect) {
  const trace = [];
  const sc = expect?.shell_commands || {};
  const lines = extractShellCommandLines(content);
  let pass = true;

  if (sc.max_lines != null && lines.length > sc.max_lines) {
    pass = false;
    trace.push({ matcher: 'max_lines', status: 'fail', evidence: { count: lines.length, max: sc.max_lines } });
  } else if (sc.max_lines != null) {
    trace.push({ matcher: 'max_lines', status: 'pass', evidence: { count: lines.length } });
  }

  for (const sub of sc.forbidden_substrings || []) {
    const hit = lines.find((l) => l.includes(sub));
    if (hit) {
      pass = false;
      trace.push({ matcher: 'forbidden_substrings', status: 'fail', evidence: { forbidden: sub, line: hit } });
    } else {
      trace.push({ matcher: 'forbidden_substrings', status: 'pass', evidence: { forbidden: sub } });
    }
  }

  for (const reSrc of sc.forbidden_regex || []) {
    const re = new RegExp(reSrc, 'i');
    const hit = lines.find((l) => re.test(l));
    if (hit) {
      pass = false;
      trace.push({ matcher: 'forbidden_regex', status: 'fail', evidence: { pattern: reSrc, line: hit } });
    } else {
      trace.push({ matcher: 'forbidden_regex', status: 'pass', evidence: { pattern: reSrc } });
    }
  }

  for (const sub of sc.required_substrings_any || []) {
    const hit = lines.some((l) => l.includes(sub));
    if (!hit) {
      pass = false;
      trace.push({
        matcher: 'required_substrings_any',
        status: 'fail',
        evidence: { required: sub, emitted: lines },
      });
    } else {
      trace.push({ matcher: 'required_substrings_any', status: 'pass', evidence: { matched: sub } });
    }
  }

  for (const sub of sc.required_substrings_all || []) {
    const anyLine = lines.some((l) => l.includes(sub));
    if (!anyLine) {
      pass = false;
      trace.push({ matcher: 'required_substrings_all', status: 'fail', evidence: { required: sub } });
    } else {
      trace.push({ matcher: 'required_substrings_all', status: 'pass', evidence: { required: sub } });
    }
  }

  return {
    pass,
    trace,
    simulated_requests: lines.map((line) => ({ kind: 'shell', line })),
    mc_lines: [],
    shell_lines: lines,
    chat_lines: [],
  };
}
