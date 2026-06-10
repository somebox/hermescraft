#!/usr/bin/env node
/**
 * Eval grammar: flat baseline (v1) vs archived categorical v2 vs tier-grouped live cheatsheet (v3).
 *
 * Usage: node scripts/eval-grammar/run.mjs [--timeout-ms 120000] [--grammars v1,v2,v3]
 *
 * Reads:  scripts/eval-grammar/tasks.json
 *         scripts/eval-grammar/fixtures/cheatsheet-flat-baseline.md  (v1)
 *         docs/archive/mc-cheatsheet-v2.md                           (v2)
 *         docs/reference/mc-cheatsheet.md                            (v3)
 * Writes: scripts/eval-grammar/results.json
 *
 * Requires OPENROUTER_API_KEY in secrets.yaml or env. Optional merge gate — bot tests are authoritative.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = join(ROOT, 'scripts/eval-grammar');
const RESULTS_FILE = join(HERE, 'results.json');

const SECRETS = join(ROOT, 'secrets.yaml');
function loadOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  if (existsSync(SECRETS)) {
    const secretsText = readFileSync(SECRETS, 'utf8');
    const keyMatch = secretsText.match(/openrouter_api_key:\s*(\S+)/);
    if (keyMatch) return keyMatch[1].trim();
  }
  return null;
}
const OPENROUTER_KEY = loadOpenRouterKey();

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const timeoutArg = arg('--timeout-ms');
let TIMEOUT_MS = 120000;
if (timeoutArg != null) {
  const n = Number(timeoutArg);
  if (Number.isFinite(n) && n > 0) TIMEOUT_MS = n;
}

const grammarsArg = arg('--grammars') || 'v1,v2,v3';
const GRAMMARS = grammarsArg.split(',').map((g) => g.trim()).filter(Boolean);

const MODELS = [
  { id: 'deepseek/deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'nemotron-120b' },
];

const tasks = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const cheatsheetV1 = readFileSync(join(HERE, 'fixtures/cheatsheet-flat-baseline.md'), 'utf8');
const cheatsheetV2 = readFileSync(join(ROOT, 'docs/archive/mc-cheatsheet-v2.md'), 'utf8');
const cheatsheetV3 = readFileSync(join(ROOT, 'docs/reference/mc-cheatsheet.md'), 'utf8');

function cheatsheetForGrammar(grammar) {
  if (grammar === 'v1') return cheatsheetV1;
  if (grammar === 'v2') return cheatsheetV2;
  if (grammar === 'v3') return cheatsheetV3;
  throw new Error(`unknown grammar ${grammar}`);
}

function correctForGrammar(task, grammar) {
  if (grammar === 'v2') return task.v2_correct;
  return task.v1_correct;
}

function buildPrompt(cheatsheet, task) {
  return `You are operating a Minecraft bot via the \`mc\` CLI. Output the EXACT mc command(s) to accomplish a task.

# Available commands

${cheatsheet}

# Output format

Reply with ONLY the mc command(s) inside a fenced code block. No prose, no explanation, no preamble. Example correct reply:

\`\`\`
mc some_verb arg1 arg2
\`\`\`

Use ONLY verb names that appear in the cheatsheet above.

# Task

${task}`;
}

function partialCheatsheetV2(label) {
  const sections = cheatsheetV2.split(/\n## /);
  const head = sections[0];
  if (label === 'MINE_ONLY') {
    const mine = sections.find((s) => s.startsWith('mine —'));
    return head + '\n## ' + mine;
  }
  if (label === 'GOAL_ONLY') {
    const planSec = sections.find((s) => s.startsWith('plan —'));
    const goalLines = planSec.split('\n').filter((l) =>
      l.startsWith('## ') || l.startsWith('plan —') || l.includes('mc plan goal') || !l.startsWith('- '),
    );
    return head + '\n## plan — goals only\n\n' + goalLines.filter((l) => !l.startsWith('plan —')).join('\n');
  }
  return cheatsheetV2;
}

async function callOR(model, prompt) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/foz/hermescraft',
        'X-Title': 'mc grammar eval',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OR ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (e) {
    const name = /** @type {{ name?: string }} */ (e).name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw Object.assign(new Error(`timeout after ${TIMEOUT_MS}ms`), { timed_out: true });
    }
    throw e;
  }
}

function gradeOutput(output, correctList) {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .map((l) => l.replace(/^[`*\d.\s>-]+/, '').trim())
    .filter((l) => l.startsWith('mc '));
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const line of lines) {
    for (const correct of correctList) {
      if (norm(line) === norm(correct)) return { pass: true, matchType: 'exact', match: correct };
      if (norm(line).startsWith(norm(correct))) return { pass: true, matchType: 'prefix', match: correct };
    }
  }
  return { pass: false, matchType: 'none', match: null, mc_lines: lines };
}

function persistResults(rows) {
  writeFileSync(RESULTS_FILE, JSON.stringify(rows, null, 2));
}

if (!OPENROUTER_KEY) {
  console.error('No OpenRouter key (secrets.yaml or OPENROUTER_API_KEY). Exiting without API calls.');
  console.error('Cheatsheet paths OK: v1 fixture, v2 archive, v3 live.');
  process.exit(0);
}

const results = [];
persistResults(results);
console.error(`HTTP timeout per request: ${TIMEOUT_MS}ms; grammars: ${GRAMMARS.join(', ')}\n`);

for (const task of tasks.direct) {
  for (const model of MODELS) {
    for (const grammar of GRAMMARS) {
      const cheatsheet = cheatsheetForGrammar(grammar);
      const correct = correctForGrammar(task, grammar);
      const prompt = buildPrompt(cheatsheet, task.task);
      console.error(`[${task.id}] ${grammar} / ${model.label} ...`);
      try {
        const output = await callOR(model.id, prompt);
        const grade = gradeOutput(output, correct);
        results.push({
          kind: 'direct',
          task_id: task.id,
          grammar,
          model: model.label,
          output,
          correct,
          ...grade,
        });
        persistResults(results);
        console.error(`  → ${grade.pass ? 'PASS' : 'FAIL'} (${grade.matchType})`);
      } catch (e) {
        const timedOut = /** @type {{ timed_out?: boolean }} */ (e).timed_out === true;
        results.push({
          kind: 'direct',
          task_id: task.id,
          grammar,
          model: model.label,
          correct,
          error: String(e.message || e),
          pass: false,
          ...(timedOut ? { timed_out: true, request_timeout_ms: TIMEOUT_MS } : {}),
        });
        persistResults(results);
        console.error(timedOut ? `  → TIMEOUT (${TIMEOUT_MS}ms)` : `  → ERROR: ${e.message}`);
      }
    }
  }
}

for (const task of tasks.prediction) {
  for (const model of MODELS) {
    const partial = partialCheatsheetV2(task.partial_cheatsheet_label);
    const prompt = buildPrompt(partial, task.task);
    console.error(`[predict ${task.id}] ${model.label} ...`);
    try {
      const output = await callOR(model.id, prompt);
      const grade = gradeOutput(output, task.v2_correct);
      results.push({
        kind: 'prediction',
        task_id: task.id,
        grammar: 'v2-partial',
        model: model.label,
        output,
        correct: task.v2_correct,
        ...grade,
      });
      persistResults(results);
      console.error(`  → ${grade.pass ? 'PASS' : 'FAIL'} (${grade.matchType})`);
    } catch (e) {
      const timedOut = /** @type {{ timed_out?: boolean }} */ (e).timed_out === true;
      results.push({
        kind: 'prediction',
        task_id: task.id,
        grammar: 'v2-partial',
        model: model.label,
        correct: task.v2_correct,
        error: String(e.message || e),
        pass: false,
        ...(timedOut ? { timed_out: true, request_timeout_ms: TIMEOUT_MS } : {}),
      });
      persistResults(results);
      console.error(timedOut ? `  → TIMEOUT (${TIMEOUT_MS}ms)` : `  → ERROR: ${e.message}`);
    }
  }
}

persistResults(results);
console.error(`\nFinished ${results.length} results → scripts/eval-grammar/results.json`);

const summary = {};
for (const r of results) {
  const key = `${r.kind}/${r.grammar}/${r.model}`;
  if (!summary[key]) summary[key] = { pass: 0, fail: 0, timeout: 0, total: 0 };
  summary[key].total++;
  if (r.pass) summary[key].pass++;
  else summary[key].fail++;
  if (r.timed_out) summary[key].timeout++;
}
console.error('\n=== SUMMARY ===');
for (const [k, v] of Object.entries(summary).sort()) {
  const pct = ((v.pass / v.total) * 100).toFixed(0);
  const to = v.timeout ? `  timeouts=${v.timeout}` : '';
  console.error(`  ${k.padEnd(45)}  ${v.pass}/${v.total}  (${pct}%)${to}`);
}
