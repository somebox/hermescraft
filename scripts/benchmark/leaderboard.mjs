#!/usr/bin/env node
/**
 * Render LEADERBOARD.md from benchmark run JSON.
 *
 * Default: merge results from the latest JSON in each runs/<model_slug>/ directory.
 * Also supports --run <path> (single file) or --model <id-or-slug> (latest in that dir).
 *
 * See runs-layout.mjs for directory naming.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import {
  collectLatestPerModelMainRuns,
  latestJsonPathInDir,
  resolveModelSlug,
} from './runs-layout.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = join(ROOT, 'scripts/benchmark');
const RUNS_DIR = join(HERE, 'runs');

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function semanticOf(r) {
  if (typeof r.semantic_score === 'number') return r.semantic_score;
  return r.pass ? 1 : 0;
}

function accumParse(r, bucket) {
  if (typeof r.parse_ok_rate !== 'number') return;
  bucket.parse_sum += r.parse_ok_rate;
  bucket.parse_n++;
}

/** @param {Record<string, unknown>[]} runs */
function mergeTaskGroups(runs) {
  const s = new Set();
  for (const r of runs) {
    const tg = r.task_groups;
    if (!Array.isArray(tg)) continue;
    for (const g of tg) if (typeof g === 'string') s.add(g);
  }
  return [...s].sort();
}

/**
 * @returns {{ run: Record<string, unknown>, sources: string[], merged: boolean }}
 */
function loadRunPayload() {
  const runArg = arg('--run');
  if (runArg) {
    const p = isAbsolute(runArg) ? runArg : join(RUNS_DIR, runArg);
    const run = JSON.parse(readFileSync(p, 'utf8'));
    return { run, sources: [p], merged: false };
  }

  const modelArg = arg('--model');
  if (modelArg) {
    const slug = resolveModelSlug(modelArg, RUNS_DIR);
    const dir = join(RUNS_DIR, slug);
    const p = latestJsonPathInDir(dir);
    if (!p) {
      console.error(`No JSON runs in ${dir}`);
      process.exit(1);
    }
    const run = JSON.parse(readFileSync(p, 'utf8'));
    return { run, sources: [p], merged: false };
  }

  const latest = collectLatestPerModelMainRuns(RUNS_DIR);
  if (latest.length) {
    const runs = latest.map((x) => JSON.parse(readFileSync(x.path, 'utf8')));
    /** @type {Record<string, unknown>[]} */
    const mergedResults = [];
    for (const r of runs) {
      const res = r.results;
      if (Array.isArray(res)) mergedResults.push(...res);
    }

    const shell = runs[0];
    const run = {
      ...shell,
      task_groups: mergeTaskGroups(runs),
      results: mergedResults,
      models_snapshot: latest.map((x) => ({ model_id: x.model_id, path: x.path })),
    };
    delete run.model_id;
    delete run.model_label;
    return { run, sources: latest.map((x) => x.path), merged: true };
  }

  let legacy;
  try {
    legacy = readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(RUNS_DIR, f));
  } catch {
    legacy = [];
  }
  if (legacy.length) {
    const p = legacy[legacy.length - 1];
    const run = JSON.parse(readFileSync(p, 'utf8'));
    return { run, sources: [p], merged: false };
  }

  console.error(
    'No runs found under scripts/benchmark/runs/<model_slug>/. Run scripts/benchmark/run.mjs or pass --run.',
  );
  process.exit(1);
}

const { run, sources, merged } = loadRunPayload();

const gitSha =
  typeof run.git_sha === 'string' ? run.git_sha : 'unknown';

// Aggregate per (model, group)
const agg = {};
for (const r of run.results) {
  const k = `${r.model}/${r.group}`;
  if (!agg[k]) {
    agg[k] = {
      model: r.model,
      group: r.group,
      pass: 0,
      total: 0,
      cost: 0,
      time: 0,
      errors: 0,
      sem_sum: 0,
      parse_sum: 0,
      parse_n: 0,
    };
  }
  agg[k].total++;
  if (r.pass) agg[k].pass++;
  if (r.error) agg[k].errors++;
  agg[k].cost += r.cost_usd || 0;
  agg[k].time += r.elapsed_ms || 0;
  agg[k].sem_sum += semanticOf(r);
  accumParse(r, agg[k]);
}

// Per-model totals
const byModel = {};
for (const v of Object.values(agg)) {
  if (!byModel[v.model]) {
    byModel[v.model] = {
      model: v.model,
      pass: 0,
      total: 0,
      cost: 0,
      time: 0,
      errors: 0,
      sem_sum: 0,
      parse_sum: 0,
      parse_n: 0,
    };
  }
  byModel[v.model].pass += v.pass;
  byModel[v.model].total += v.total;
  byModel[v.model].cost += v.cost;
  byModel[v.model].time += v.time;
  byModel[v.model].errors += v.errors;
  byModel[v.model].sem_sum += v.sem_sum;
  byModel[v.model].parse_sum += v.parse_sum;
  byModel[v.model].parse_n += v.parse_n;
}

const overall = Object.values(byModel)
  .map((m) => ({
    ...m,
    acc: m.pass / m.total,
    sem_avg: m.sem_sum / m.total,
    parse_avg: m.parse_n ? m.parse_sum / m.parse_n : null,
    avg_ms: m.time / m.total,
    cost_per_call: m.cost / m.total,
  }))
  .sort(
    (a, b) =>
      b.acc - a.acc ||
      b.sem_avg - a.sem_avg ||
      (a.parse_avg != null && b.parse_avg != null ? b.parse_avg - a.parse_avg : 0) ||
      a.cost_per_call - b.cost_per_call,
  );

const lines = [];
lines.push('# mc benchmark leaderboard');
lines.push('');
lines.push(`Run timestamp: \`${run.timestamp}\` (git ${gitSha.slice(0, 7)})`);
if (merged) {
  lines.push(`Sources: **merged latest per model** (${sources.length} JSON files)`);
  for (const s of sources) lines.push(`- \`${s}\``);
} else {
  lines.push(`Source: \`${sources[0]}\``);
}
lines.push(`Cheatsheet: ${run.cheatsheet_bytes} bytes`);
lines.push(`Task groups: ${(run.task_groups || []).join(', ')}`);
lines.push('');
lines.push('## Overall ranking');
lines.push('');
lines.push('| # | Model | Accuracy | Sem avg | Parse OK | Errors | Cost/call | Avg latency |');
lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
overall.forEach((m, i) => {
  const acc = (m.acc * 100).toFixed(0) + '%';
  const sem = (m.sem_avg * 100).toFixed(0) + '%';
  const parse =
    m.parse_avg != null ? `${(m.parse_avg * 100).toFixed(0)}%` : '—';
  const cost = m.cost_per_call < 0.0001 ? 'free' : `$${m.cost_per_call.toFixed(5)}`;
  const ms = `${m.avg_ms.toFixed(0)}ms`;
  lines.push(
    `| ${i + 1} | \`${m.model}\` | ${m.pass}/${m.total} (${acc}) | ${sem} | ${parse} | ${m.errors} | ${cost} | ${ms} |`,
  );
});
lines.push('');
lines.push('## Per-group breakdown');
lines.push('');
const groups = [...new Set(Object.values(agg).map((v) => v.group))].sort();
for (const g of groups) {
  lines.push(`### ${g}`);
  lines.push('');
  lines.push('| Model | Accuracy | Sem avg | Parse OK | Cost/call | Avg latency |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  const rows = Object.values(agg)
    .filter((v) => v.group === g)
    .map((v) => ({
      ...v,
      acc: v.pass / v.total,
      sem_avg: v.sem_sum / v.total,
      parse_avg: v.parse_n ? v.parse_sum / v.parse_n : null,
      avg: v.time / v.total,
      cpc: v.cost / v.total,
    }))
    .sort((a, b) => b.acc - a.acc || b.sem_avg - a.sem_avg);
  for (const r of rows) {
    const acc = (r.acc * 100).toFixed(0) + '%';
    const sem = (r.sem_avg * 100).toFixed(0) + '%';
    const parse = r.parse_avg != null ? `${(r.parse_avg * 100).toFixed(0)}%` : '—';
    const cost = r.cpc < 0.0001 ? 'free' : `$${r.cpc.toFixed(5)}`;
    lines.push(
      `| \`${r.model}\` | ${r.pass}/${r.total} (${acc}) | ${sem} | ${parse} | ${cost} | ${r.avg.toFixed(0)}ms |`,
    );
  }
  lines.push('');
}

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
console.error(
  `Top model: ${overall[0] ? `${overall[0].model} (${(overall[0].acc * 100).toFixed(0)}% acc, sem ${(overall[0].sem_avg * 100).toFixed(0)}%)` : 'n/a'}`,
);
