#!/usr/bin/env node
/**
 * Render scripts/benchmark/runs/<latest>.json → scripts/benchmark/LEADERBOARD.md.
 *
 * Run after `node scripts/benchmark/run.mjs`. Lists each model's accuracy
 * + cost + latency per task group, sorted by accuracy then cost.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = join(ROOT, 'scripts/benchmark');
const RUNS_DIR = join(HERE, 'runs');

const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

const runFile = arg('--run') ||
  readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort().pop();
if (!runFile) {
  console.error('No runs in scripts/benchmark/runs/. Run scripts/benchmark/run.mjs first.');
  process.exit(1);
}
const run = JSON.parse(readFileSync(join(RUNS_DIR, runFile), 'utf8'));

// Aggregate per (model, group)
const agg = {};
for (const r of run.results) {
  const k = `${r.model}/${r.group}`;
  if (!agg[k]) agg[k] = { model: r.model, group: r.group, pass: 0, total: 0, cost: 0, time: 0, errors: 0 };
  agg[k].total++;
  if (r.pass) agg[k].pass++;
  if (r.error) agg[k].errors++;
  agg[k].cost += r.cost_usd || 0;
  agg[k].time += r.elapsed_ms || 0;
}

// Per-model totals
const byModel = {};
for (const v of Object.values(agg)) {
  if (!byModel[v.model]) byModel[v.model] = { model: v.model, pass: 0, total: 0, cost: 0, time: 0, errors: 0 };
  byModel[v.model].pass += v.pass;
  byModel[v.model].total += v.total;
  byModel[v.model].cost += v.cost;
  byModel[v.model].time += v.time;
  byModel[v.model].errors += v.errors;
}

const overall = Object.values(byModel)
  .map((m) => ({
    ...m,
    acc: m.pass / m.total,
    avg_ms: m.time / m.total,
    cost_per_call: m.cost / m.total,
  }))
  .sort((a, b) => b.acc - a.acc || a.cost_per_call - b.cost_per_call);

const lines = [];
lines.push('# mc benchmark leaderboard');
lines.push('');
lines.push(`Run: \`${run.timestamp}\` (git ${run.git_sha.slice(0, 7)})`);
lines.push(`Cheatsheet: ${run.cheatsheet_bytes} bytes`);
lines.push(`Task groups: ${run.task_groups.join(', ')}`);
lines.push('');
lines.push('## Overall ranking');
lines.push('');
lines.push('| # | Model | Accuracy | Errors | Cost/call | Avg latency |');
lines.push('|---|---|---:|---:|---:|---:|');
overall.forEach((m, i) => {
  const acc = (m.acc * 100).toFixed(0) + '%';
  const cost = m.cost_per_call < 0.0001 ? 'free' : `$${m.cost_per_call.toFixed(5)}`;
  const ms = `${m.avg_ms.toFixed(0)}ms`;
  lines.push(`| ${i + 1} | \`${m.model}\` | ${m.pass}/${m.total} (${acc}) | ${m.errors} | ${cost} | ${ms} |`);
});
lines.push('');
lines.push('## Per-group breakdown');
lines.push('');
const groups = [...new Set(Object.values(agg).map((v) => v.group))].sort();
for (const g of groups) {
  lines.push(`### ${g}`);
  lines.push('');
  lines.push('| Model | Accuracy | Cost/call | Avg latency |');
  lines.push('|---|---:|---:|---:|');
  const rows = Object.values(agg).filter((v) => v.group === g)
    .map((v) => ({ ...v, acc: v.pass / v.total, avg: v.time / v.total, cpc: v.cost / v.total }))
    .sort((a, b) => b.acc - a.acc);
  for (const r of rows) {
    const acc = (r.acc * 100).toFixed(0) + '%';
    const cost = r.cpc < 0.0001 ? 'free' : `$${r.cpc.toFixed(5)}`;
    lines.push(`| \`${r.model}\` | ${r.pass}/${r.total} (${acc}) | ${cost} | ${r.avg.toFixed(0)}ms |`);
  }
  lines.push('');
}

// Failed tasks list (helpful for diagnosing regressions)
const fails = run.results.filter((r) => !r.pass).map((r) => `${r.group}/${r.task_id} on ${r.model}`);
if (fails.length) {
  lines.push('## Failed tasks');
  lines.push('');
  for (const f of fails) lines.push(`- ${f}`);
  lines.push('');
}

const outPath = join(HERE, 'LEADERBOARD.md');
writeFileSync(outPath, lines.join('\n'));
console.error(`Wrote ${outPath}`);
console.error(`Top model: ${overall[0]?.model} (${(overall[0].acc * 100).toFixed(0)}% acc, $${overall[0].cost_per_call.toFixed(5)}/call)`);
