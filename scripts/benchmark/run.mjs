#!/usr/bin/env node
/**
 * mc command benchmark — score LLMs on composing mc commands correctly.
 *
 * Run:    node scripts/benchmark/run.mjs [--models a,b] [--tasks direct,composition]
 * Output: scripts/benchmark/runs/<timestamp>.json
 *
 * Used for:
 *   1. Model selection — score every candidate, rank by accuracy/cost.
 *   2. Regression detection — compare a new run to the last; flag drops > 5pp.
 *   3. Pattern validation — when registry/cheatsheet changes, re-run.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = join(ROOT, 'scripts/benchmark');
const RUNS_DIR = join(HERE, 'runs');
mkdirSync(RUNS_DIR, { recursive: true });

const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

const SECRETS = '/Users/foz/homelab/secrets.yaml';
const keyMatch = readFileSync(SECRETS, 'utf8').match(/openrouter_api_key:\s*(\S+)/);
if (!keyMatch) { console.error('No openrouter_api_key'); process.exit(1); }
const OPENROUTER_KEY = keyMatch[1].trim();

const modelsCfg = JSON.parse(readFileSync(join(HERE, 'models.json'), 'utf8'));
const filterModels = arg('--models')?.split(',').map((s) => s.trim());
const models = modelsCfg.models.filter(
  (m) => !filterModels || filterModels.includes(m.label) || filterModels.includes(m.id),
);
if (!models.length) { console.error('No models selected'); process.exit(1); }

const filterTasks = arg('--tasks')?.split(',').map((s) => s.trim());
const taskFiles = readdirSync(join(HERE, 'tasks')).filter((f) => f.endsWith('.json'));
const taskGroups = {};
for (const f of taskFiles) {
  const groupName = f.replace(/\.json$/, '');
  if (filterTasks && !filterTasks.includes(groupName)) continue;
  taskGroups[groupName] = JSON.parse(readFileSync(join(HERE, 'tasks', f), 'utf8'));
}

const cheatsheet = readFileSync(join(ROOT, 'docs/mc-cheatsheet.md'), 'utf8');

function buildPrompt(task) {
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

async function callOR(modelId, prompt) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/foz/hermescraft',
      'X-Title': 'mc benchmark',
    },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: 600, temperature: 0.1 }),
  });
  const elapsed = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text();
    return { error: `${res.status}: ${text.slice(0, 300)}`, elapsed_ms: elapsed };
  }
  const data = await res.json();
  return { content: data.choices?.[0]?.message?.content?.trim() ?? '', usage: data.usage ?? null, elapsed_ms: elapsed };
}

function extractMcLines(content) {
  return content.split('\n').map((l) => l.trim()).map((l) => l.replace(/^[`*\d.\s>-]+/, '').trim()).filter((l) => l.startsWith('mc '));
}

function gradeDirect(content, correctList) {
  const lines = extractMcLines(content);
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const line of lines) {
    for (const correct of correctList) {
      if (norm(line) === norm(correct)) return { pass: true, match: 'exact' };
      if (norm(line).startsWith(norm(correct))) return { pass: true, match: 'prefix' };
    }
  }
  return { pass: false, mc_lines: lines };
}

function gradeComposition(content, requiredLines, scoring) {
  const lines = extractMcLines(content);
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const partialArgsOk = scoring && scoring.includes('partial_args_ok');
  const matched = [];
  for (const required of requiredLines) {
    const r = norm(required);
    let hit = false;
    for (const line of lines) {
      const l = norm(line);
      if (partialArgsOk) {
        const reqVerb = r.split(/\s+/).slice(0, 2).join(' ');
        if (l.startsWith(reqVerb)) { hit = true; break; }
      } else {
        if (l === r || l.startsWith(r)) { hit = true; break; }
      }
    }
    matched.push(hit ? required : null);
  }
  return { pass: matched.every(Boolean), matched, mc_lines: lines };
}

function computeCost(model, usage) {
  if (!usage) return null;
  const inM = (usage.prompt_tokens || 0) / 1e6;
  const outM = (usage.completion_tokens || 0) / 1e6;
  return inM * (model.cost_per_1m_in || 0) + outM * (model.cost_per_1m_out || 0);
}

let gitSha = 'unknown';
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
if (sha.status === 0) gitSha = sha.stdout.toString().trim();

const run = {
  timestamp: new Date().toISOString(),
  git_sha: gitSha,
  cheatsheet_bytes: cheatsheet.length,
  models: models.map((m) => ({ id: m.id, label: m.label })),
  task_groups: Object.keys(taskGroups),
  results: [],
};

for (const [groupName, tasks] of Object.entries(taskGroups)) {
  for (const task of tasks) {
    for (const model of models) {
      console.error(`[${groupName}] ${task.id} on ${model.label} ...`);
      const prompt = buildPrompt(task.task);
      const r = await callOR(model.id, prompt);
      let grade;
      if (r.error) grade = { pass: false, error: r.error };
      else if (groupName === 'direct') grade = gradeDirect(r.content, task.correct);
      else if (groupName === 'composition') grade = gradeComposition(r.content, task.correct_lines_required, task.scoring);
      else grade = { pass: false, error: `unknown group ${groupName}` };
      const cost = computeCost(model, r.usage);
      run.results.push({
        group: groupName, task_id: task.id, category: task.category, model: model.label,
        ...grade, elapsed_ms: r.elapsed_ms, usage: r.usage, cost_usd: cost, output: r.content,
      });
      console.error(`  → ${grade.pass ? 'PASS' : 'FAIL'}  ${r.elapsed_ms}ms  $${(cost ?? 0).toFixed(5)}`);
    }
  }
}

const stamp = run.timestamp.replace(/[:.]/g, '-');
const outPath = join(RUNS_DIR, `${stamp}.json`);
writeFileSync(outPath, JSON.stringify(run, null, 2));
console.error(`\nWrote ${outPath}`);

const summary = {};
for (const r of run.results) {
  const k = `${r.group}/${r.model}`;
  if (!summary[k]) summary[k] = { pass: 0, total: 0, cost: 0, time: 0 };
  summary[k].total++;
  if (r.pass) summary[k].pass++;
  summary[k].cost += r.cost_usd || 0;
  summary[k].time += r.elapsed_ms || 0;
}
console.error('\n=== Summary ===');
for (const [k, v] of Object.entries(summary).sort()) {
  const pct = ((v.pass / v.total) * 100).toFixed(0);
  console.error(`  ${k.padEnd(40)}  ${v.pass}/${v.total}  (${pct}%)  ~$${v.cost.toFixed(4)}  ${(v.time / v.total).toFixed(0)}ms/call`);
}
