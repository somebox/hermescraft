#!/usr/bin/env node
/**
 * mc command benchmark — score LLMs on composing mc commands correctly.
 *
 * Realistic mode (default) sends the same shape of prompt a production
 * Hermes agent gets: SOUL persona + skill + cheatsheet + /observe snapshot.
 *
 * --syntax-only    cheatsheet only (ablation; older simpler shape)
 * --models a,b     filter to specific models
 * --tasks direct   filter to specific task groups
 * --persona F      alt persona file
 * --skill F        alt skill file
 * --observe F      alt observe fixture
 * --serial         disable per-task model parallelism
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
const has = (flag) => argv.includes(flag);

const REALISTIC = !has('--syntax-only');
const PARALLEL = !has('--serial');

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

let persona = '', skill = '', observeJson = '';
if (REALISTIC) {
  const personaFile = arg('--persona') || join(HERE, 'fixtures/persona-flint.md');
  const skillFile = arg('--skill') || join(HERE, 'fixtures/skill-survival.md');
  const observeFile = arg('--observe') || join(HERE, 'fixtures/observe-flint.json');
  persona = readFileSync(personaFile, 'utf8');
  skill = readFileSync(skillFile, 'utf8');
  observeJson = readFileSync(observeFile, 'utf8');
}

function buildPrompt(task) {
  const sections = [];
  if (REALISTIC) {
    sections.push('# Persona\n\n' + persona);
    sections.push('# Skill: minecraft-survival\n\n' + skill);
  }
  sections.push('# Available `mc` commands\n\n' + cheatsheet);
  if (REALISTIC) {
    let pretty;
    try { pretty = JSON.stringify(JSON.parse(observeJson), null, 2); } catch { pretty = observeJson; }
    sections.push('# Current game state (mc observe output)\n\n```json\n' + pretty + '\n```');
  }
  sections.push(`# Output format

Reply with ONLY the mc command(s) inside a fenced code block. No prose, no explanation, no preamble.

\`\`\`
mc some_verb arg1 arg2
\`\`\`

Use ONLY verb names that appear in the cheatsheet.`);
  sections.push('# Task\n\n' + task);
  return sections.join('\n\n');
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

const totalCalls = Object.values(taskGroups).reduce((sum, t) => sum + t.length, 0) * models.length;
let completedCalls = 0;
const startTime = Date.now();

const run = {
  timestamp: new Date().toISOString(),
  git_sha: gitSha,
  realistic: REALISTIC,
  parallel: PARALLEL,
  cheatsheet_bytes: cheatsheet.length,
  persona_bytes: persona.length,
  skill_bytes: skill.length,
  observe_bytes: observeJson.length,
  models: models.map((m) => ({ id: m.id, label: m.label })),
  task_groups: Object.keys(taskGroups),
  results: [],
};

console.error(`Mode: ${REALISTIC ? 'realistic' : 'syntax-only'}  parallel: ${PARALLEL}`);
console.error(`Models: ${models.map((m) => m.label).join(', ')}`);
console.error(`Tasks:  ${Object.entries(taskGroups).map(([g, t]) => g + '=' + t.length).join(', ')}`);
console.error(`Total calls: ${totalCalls}`);
console.error('');

async function runTaskOnModel(groupName, task, model) {
  const prompt = buildPrompt(task.task);
  const r = await callOR(model.id, prompt);
  let grade;
  if (r.error) grade = { pass: false, error: r.error };
  else if (groupName === 'direct') grade = gradeDirect(r.content, task.correct);
  else if (groupName === 'composition') grade = gradeComposition(r.content, task.correct_lines_required, task.scoring);
  else grade = { pass: false, error: `unknown group ${groupName}` };
  const cost = computeCost(model, r.usage);
  const result = {
    group: groupName, task_id: task.id, category: task.category, model: model.label,
    ...grade, elapsed_ms: r.elapsed_ms, usage: r.usage, cost_usd: cost, output: r.content,
  };
  completedCalls++;
  const elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(0);
  const tag = grade.pass ? 'PASS' : 'FAIL';
  console.error(`  [${completedCalls}/${totalCalls} ${elapsedTotal}s] ${tag.padEnd(4)}  ${groupName}/${task.id} on ${model.label.padEnd(28)} ${r.elapsed_ms}ms  $${(cost ?? 0).toFixed(5)}`);
  return result;
}

// Concurrency model:
//   PARALLEL (default): each MODEL runs its tasks serially in its own thread,
//     and different models run concurrently with each other. This avoids
//     per-key rate-limit (Novita 429s on DeepSeek when we burst 4-wide) while
//     still finishing in roughly max(per-model wallclock) instead of the sum.
//   --serial: one call at a time across everything.
async function runModelTaskList(model) {
  const out = [];
  for (const [groupName, tasks] of Object.entries(taskGroups)) {
    for (const task of tasks) {
      const r = await runTaskOnModel(groupName, task, model);
      out.push(r);
    }
  }
  return out;
}

if (PARALLEL) {
  // One queue per model; queues run concurrently.
  const perModelResults = await Promise.all(models.map((m) => runModelTaskList(m)));
  for (const arr of perModelResults) run.results.push(...arr);
} else {
  for (const model of models) {
    const arr = await runModelTaskList(model);
    run.results.push(...arr);
  }
}

const stamp = run.timestamp.replace(/[:.]/g, '-');
const outPath = join(RUNS_DIR, `${stamp}${REALISTIC ? '-realistic' : '-syntax'}.json`);
writeFileSync(outPath, JSON.stringify(run, null, 2));
console.error(`\nWrote ${outPath}`);
console.error(`Total wallclock: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

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
  console.error(`  ${k.padEnd(45)}  ${v.pass}/${v.total}  (${pct}%)  ~$${v.cost.toFixed(4)}  ${(v.time / v.total).toFixed(0)}ms/call`);
}
