#!/usr/bin/env node
/**
 * Compare two benchmark runs — surface regressions and improvements.
 *
 * Usage:
 *   node scripts/benchmark/compare.mjs              # latest vs second-latest
 *   node scripts/benchmark/compare.mjs A.json B.json
 *
 * Flags any (model, group) where accuracy dropped > 5pp from baseline. This
 * is the gate to use after touching the registry, cheatsheet, or skill text:
 * if accuracy regressed, the change has unintended consequences.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_DIR = join(ROOT, 'scripts/benchmark/runs');

const argv = process.argv.slice(2);
let baseFile, newFile;
if (argv.length === 2) {
  [baseFile, newFile] = argv;
} else {
  const runs = readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort();
  if (runs.length < 2) {
    console.error('Need at least 2 runs to compare. Have:', runs.length);
    process.exit(1);
  }
  baseFile = join(RUNS_DIR, runs[runs.length - 2]);
  newFile = join(RUNS_DIR, runs[runs.length - 1]);
}

const base = JSON.parse(readFileSync(baseFile, 'utf8'));
const next = JSON.parse(readFileSync(newFile, 'utf8'));

console.log(`Base:  ${base.timestamp}  (git ${base.git_sha.slice(0, 7)})`);
console.log(`New:   ${next.timestamp}  (git ${next.git_sha.slice(0, 7)})`);
console.log('');

function aggregate(run) {
  const agg = {};
  for (const r of run.results) {
    const k = `${r.model}/${r.group}`;
    if (!agg[k]) agg[k] = { pass: 0, total: 0 };
    agg[k].total++;
    if (r.pass) agg[k].pass++;
  }
  for (const v of Object.values(agg)) v.acc = v.pass / v.total;
  return agg;
}

const baseAgg = aggregate(base);
const nextAgg = aggregate(next);

const allKeys = new Set([...Object.keys(baseAgg), ...Object.keys(nextAgg)]);
const REGRESSION_THRESHOLD = 0.05; // 5pp

const regressions = [];
const improvements = [];
const stable = [];
for (const k of [...allKeys].sort()) {
  const b = baseAgg[k];
  const n = nextAgg[k];
  if (!b || !n) {
    console.log(`  ${k}  — only in ${b ? 'base' : 'new'}`);
    continue;
  }
  const delta = n.acc - b.acc;
  const row = { key: k, base: b.acc, next: n.acc, delta };
  if (delta < -REGRESSION_THRESHOLD) regressions.push(row);
  else if (delta > REGRESSION_THRESHOLD) improvements.push(row);
  else stable.push(row);
}

const fmtRow = (r) => {
  const b = (r.base * 100).toFixed(0).padStart(3) + '%';
  const n = (r.next * 100).toFixed(0).padStart(3) + '%';
  const d = (r.delta * 100 >= 0 ? '+' : '') + (r.delta * 100).toFixed(0).padStart(3) + 'pp';
  return `  ${r.key.padEnd(40)}  ${b} → ${n}  (${d})`;
};

if (regressions.length) {
  console.log('REGRESSIONS (>5pp drop):');
  regressions.forEach((r) => console.log(fmtRow(r)));
  console.log('');
}
if (improvements.length) {
  console.log('Improvements (>5pp gain):');
  improvements.forEach((r) => console.log(fmtRow(r)));
  console.log('');
}
console.log(`Stable: ${stable.length} entries`);

// Specifically: which tasks newly failed?
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

process.exit(regressions.length > 0 ? 1 : 0);
