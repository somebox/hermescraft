#!/usr/bin/env node
/**
 * Eval grammar v1 (flat) vs v2 (categorical) on production OpenRouter models.
 *
 * Usage: node scripts/eval-grammar/run.mjs
 *
 * Reads:  scripts/eval-grammar/tasks.json
 *         docs/mc-cheatsheet.md       (v1 = flat)
 *         docs/mc-cheatsheet-v2.md    (v2 = categorical)
 * Writes: scripts/eval-grammar/results.json
 *
 * Cost is a few cents — DeepSeek + Nemotron at ~12 tasks × 2 grammars each.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = join(ROOT, 'scripts/eval-grammar');

// API key from homelab secrets.yaml
const SECRETS = '/Users/foz/homelab/secrets.yaml';
const secretsText = readFileSync(SECRETS, 'utf8');
const keyMatch = secretsText.match(/openrouter_api_key:\s*(\S+)/);
if (!keyMatch) {
  console.error('No openrouter_api_key found in secrets.yaml');
  process.exit(1);
}
const OPENROUTER_KEY = keyMatch[1].trim();

const MODELS = [
  { id: 'deepseek/deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'nemotron-120b' },
];

const tasks = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const cheatsheetV1 = readFileSync(join(ROOT, 'docs/mc-cheatsheet.md'), 'utf8');
const cheatsheetV2 = readFileSync(join(ROOT, 'docs/mc-cheatsheet-v2.md'), 'utf8');

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
  // For prediction tasks: show only a partial cheatsheet so we can see if
  // the model predicts the missing parallel verbs.
  const sections = cheatsheetV2.split(/\n## /);
  const head = sections[0];
  if (label === 'MINE_ONLY') {
    const mine = sections.find((s) => s.startsWith('mine —'));
    return head + '\n## ' + mine;
  }
  if (label === 'GOAL_ONLY') {
    // Keep only plan goal verbs from the plan section
    const planSec = sections.find((s) => s.startsWith('plan —'));
    const goalLines = planSec.split('\n').filter((l) =>
      l.startsWith('## ') || l.startsWith('plan —') || l.includes('mc plan goal') || !l.startsWith('- '),
    );
    return head + '\n## plan — goals only\n\n' + goalLines.filter((l) => !l.startsWith('plan —')).join('\n');
  }
  return cheatsheetV2;
}

async function callOR(model, prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
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
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OR ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

function gradeOutput(output, correctList) {
  // Extract any line starting with `mc ` from the output, regardless of
  // surrounding prose or fencing. This tolerates models that explain before
  // emitting the command (e.g. nemotron) as long as the right command IS
  // somewhere in the output.
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

const results = [];

for (const task of tasks.direct) {
  for (const model of MODELS) {
    for (const grammar of ['v1', 'v2']) {
      const cheatsheet = grammar === 'v1' ? cheatsheetV1 : cheatsheetV2;
      const correct = grammar === 'v1' ? task.v1_correct : task.v2_correct;
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
        console.error(`  → ${grade.pass ? 'PASS' : 'FAIL'} (${grade.matchType})`);
      } catch (e) {
        results.push({ kind: 'direct', task_id: task.id, grammar, model: model.label, error: String(e.message || e), pass: false });
        console.error(`  → ERROR: ${e.message}`);
      }
    }
  }
}

for (const task of tasks.prediction) {
  // Prediction is v2-only — flat grammar has no parallelism to predict from.
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
      console.error(`  → ${grade.pass ? 'PASS' : 'FAIL'} (${grade.matchType})`);
    } catch (e) {
      results.push({ kind: 'prediction', task_id: task.id, grammar: 'v2-partial', model: model.label, error: String(e.message || e), pass: false });
      console.error(`  → ERROR: ${e.message}`);
    }
  }
}

writeFileSync(join(HERE, 'results.json'), JSON.stringify(results, null, 2));
console.error(`\nWrote ${results.length} results to scripts/eval-grammar/results.json`);

// Summary
const summary = {};
for (const r of results) {
  const key = `${r.kind}/${r.grammar}/${r.model}`;
  if (!summary[key]) summary[key] = { pass: 0, fail: 0, total: 0 };
  summary[key].total++;
  if (r.pass) summary[key].pass++;
  else summary[key].fail++;
}
console.error('\n=== SUMMARY ===');
for (const [k, v] of Object.entries(summary).sort()) {
  const pct = ((v.pass / v.total) * 100).toFixed(0);
  console.error(`  ${k.padEnd(45)}  ${v.pass}/${v.total}  (${pct}%)`);
}
