#!/usr/bin/env node
/**
 * Compare two benchmark runs — surface regressions and improvements.
 *
 * Usage:
 *   node scripts/benchmark/compare.mjs <base.json> <new.json>
 *   node scripts/benchmark/compare.mjs --model <openrouter-model-id>
 *        # compares the two most recent JSON files in runs/<slug>/
 *
 * Flags any (model, group) where accuracy dropped > 5pp from baseline, or
 * semantic score dropped > 0.05 (same scale as accuracy on 0–1 tasks).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  latestJsonPathInDir,
  listJsonBasenames,
  resolveModelSlug,
} from './runs-layout.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_DIR = join(ROOT, 'scripts/benchmark/runs');

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

let baseFile;
let newFile;
if (argv.length === 2 && !argv[0].startsWith('-')) {
  baseFile = resolve(argv[0]);
  newFile = resolve(argv[1]);
} else if (arg('--model')) {
  const slug = resolveModelSlug(arg('--model'), RUNS_DIR);
  const dir = join(RUNS_DIR, slug);
  const names = listJsonBasenames(dir);
  if (names.length < 2) {
    console.error(`Need at least 2 JSON files in ${dir}; found ${names.length}`);
    process.exit(1);
  }
  baseFile = join(dir, names[names.length - 2]);
  newFile = join(dir, names[names.length - 1]);
} else if (!argv.filter((a) => !a.startsWith('-')).length) {
  let legacy;
  try {
    legacy = readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(RUNS_DIR, f));
  } catch {
    legacy = [];
  }
  if (legacy.length >= 2) {
    baseFile = legacy[legacy.length - 2];
    newFile = legacy[legacy.length - 1];
  }
}

if (!baseFile || !newFile) {
  console.error(`Usage:
  node scripts/benchmark/compare.mjs <base.json> <new.json>
  node scripts/benchmark/compare.mjs --model <openrouter-model-id>
  (Or keep legacy flat *.json in runs/ — compares latest two.)`);
  process.exit(1);
}

const base = JSON.parse(readFileSync(baseFile, 'utf8'));
const next = JSON.parse(readFileSync(newFile, 'utf8'));

console.log(`Base:  ${base.timestamp}  (${baseFile})`);
console.log(`New:   ${next.timestamp}  (${newFile})`);
console.log('');

function semanticOf(r) {
  if (typeof r.semantic_score === 'number') return r.semantic_score;
  return r.pass ? 1 : 0;
}

function aggregate(run) {
  const agg = {};
  for (const r of run.results) {
    const k = `${r.model}/${r.group}`;
    if (!agg[k]) agg[k] = { pass: 0, total: 0, sem_sum: 0 };
    agg[k].total++;
    if (r.pass) agg[k].pass++;
    agg[k].sem_sum += semanticOf(r);
  }
  for (const v of Object.values(agg)) {
    v.acc = v.pass / v.total;
    v.sem_avg = v.sem_sum / v.total;
  }
  return agg;
}

const baseAgg = aggregate(base);
const nextAgg = aggregate(next);

const allKeys = new Set([...Object.keys(baseAgg), ...Object.keys(nextAgg)]);
const REGRESSION_THRESHOLD = 0.05; // 5pp accuracy
const SEM_REGRESSION_THRESHOLD = 0.05; // 5 points on 0–1 semantic scale

const regressions = [];
const semRegressions = [];
const improvements = [];
const stable = [];
for (const k of [...allKeys].sort()) {
  const b = baseAgg[k];
  const n = nextAgg[k];
  if (!b || !n) {
    console.log(`  ${k}  — only in ${b ? 'base' : 'new'}`);
    continue;
  }
  const deltaAcc = n.acc - b.acc;
  const deltaSem = n.sem_avg - b.sem_avg;
  const rowAcc = { key: k, base: b.acc, next: n.acc, delta: deltaAcc };
  const rowSem = { key: k, base: b.sem_avg, next: n.sem_avg, delta: deltaSem };
  if (deltaAcc < -REGRESSION_THRESHOLD) regressions.push(rowAcc);
  else if (deltaAcc > REGRESSION_THRESHOLD) improvements.push(rowAcc);
  else stable.push(rowAcc);

  if (deltaSem < -SEM_REGRESSION_THRESHOLD) semRegressions.push(rowSem);
}

const fmtRowAcc = (r) => {
  const b = (r.base * 100).toFixed(0).padStart(3) + '%';
  const n = (r.next * 100).toFixed(0).padStart(3) + '%';
  const d = (r.delta * 100 >= 0 ? '+' : '') + (r.delta * 100).toFixed(0).padStart(3) + 'pp';
  return `  ${r.key.padEnd(40)}  ${b} → ${n}  (${d})`;
};

const fmtRowSem = (r) => {
  const b = (r.base * 100).toFixed(0).padStart(3) + '%';
  const n = (r.next * 100).toFixed(0).padStart(3) + '%';
  const d = (r.delta * 100 >= 0 ? '+' : '') + (r.delta * 100).toFixed(0).padStart(3) + 'pp';
  return `  ${r.key.padEnd(40)}  ${b} → ${n}  (${d})`;
};

if (regressions.length) {
  console.log('ACCURACY REGRESSIONS (>5pp drop):');
  regressions.forEach((r) => console.log(fmtRowAcc(r)));
  console.log('');
}
if (semRegressions.length) {
  console.log('SEMANTIC REGRESSIONS (>5pp drop on semantic_score avg):');
  semRegressions.forEach((r) => console.log(fmtRowSem(r)));
  console.log('');
}
if (improvements.length) {
  console.log('Improvements (>5pp gain):');
  improvements.forEach((r) => console.log(fmtRowAcc(r)));
  console.log('');
}
console.log(`Stable accuracy buckets: ${stable.length} entries`);

const baseFails = new Set(base.results.filter((r) => !r.pass).map((r) => `${r.task_id}/${r.model}`));
const nextFails = new Set(next.results.filter((r) => !r.pass).map((r) => `${r.task_id}/${r.model}`));
const newlyFailed = [...nextFails].filter((k) => !baseFails.has(k));
const newlyPassing = [...baseFails].filter((k) => !nextFails.has(k));

if (newlyFailed.length) {
  console.log('\nNewly failing tasks:');
  newlyFailed.forEach((k) => console.log(`  - ${k}`));
}
if (newlyPassing.length) {
  console.log('\nNewly passing tasks:');
  newlyPassing.forEach((k) => console.log(`  + ${k}`));
}

process.exit(regressions.length > 0 || semRegressions.length > 0 ? 1 : 0);
