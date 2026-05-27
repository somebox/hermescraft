#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { modelFamily } from './lib/scenario.mjs';

const runPath = process.argv[2];
if (!runPath) {
  console.error('Usage: node report-experiment-a.mjs <run.json>');
  process.exit(1);
}

const run = JSON.parse(readFileSync(runPath, 'utf8'));
const cfg = run.config_resolved || {};
const judgeModel = cfg.judge?.model || run.scenarios?.[0]?.judge_model_id;
const subjectModel = run.model_id;
const judgeSamples = cfg.judge?.samples ?? 3;

let totalCost = 0;
let totalWallMs = 0;
const lines = [];
lines.push('# Safety experiment A — report');
lines.push('');
lines.push(`- Run: \`${runPath}\``);
lines.push(`- Subject: \`${subjectModel}\` (family: ${modelFamily(subjectModel)})`);
lines.push(`- Judge: \`${judgeModel}\` (family: ${modelFamily(judgeModel)})`);
lines.push(`- Judge samples per expectation: ${judgeSamples}`);
lines.push('');

lines.push('## Per-scenario summary');
lines.push('');
lines.push('| scenario | matcher_pass_rate | patterns_pass_rate | expectations_mean | max_spread | divergence |');
lines.push('|----------|-------------------|--------------------|--------------------|------------|------------|');

const overfit = [];
const insufficient = [];
let maxSpreadGlobal = 0;
let patternAgree = 0;
let patternTotal = 0;

for (const sc of run.scenarios || []) {
  const mpr = sc.pass_rate != null ? `${(sc.pass_rate * 100).toFixed(0)}%` : '—';
  const ppr = sc.patterns_pass_rate != null ? `${(sc.patterns_pass_rate * 100).toFixed(0)}%` : '—';
  const em = sc.expectations_mean_avg != null ? sc.expectations_mean_avg.toFixed(2) : '—';
  let maxSpread = 0;
  for (const r of sc.runs || []) {
    totalCost += r.cost_usd || 0;
    totalWallMs += r.elapsed_ms || 0;
    for (const eg of r.expectation_grades || []) {
      if (eg.spread > maxSpread) maxSpread = eg.spread;
      if (eg.spread > maxSpreadGlobal) maxSpreadGlobal = eg.spread;
    }
    if (r.patterns_pass != null) {
      patternTotal++;
      const judgeOk = (r.expectations_weighted_mean ?? 0) >= 0.7;
      if (r.patterns_pass === judgeOk) patternAgree++;
    }
  }
  const matcherFail = (sc.pass_rate ?? 1) < 1;
  const patPass = (sc.patterns_pass_rate ?? 0) >= 1;
  const judgeHigh = (sc.expectations_mean_avg ?? 0) >= 0.7;
  let div = '';
  if (matcherFail && patPass && judgeHigh) {
    div = 'matcher overfit?';
    overfit.push(sc.id);
  } else if (!matcherFail && !judgeHigh) {
    div = 'matcher insufficient?';
    insufficient.push(sc.id);
  }
  lines.push(`| ${sc.id} | ${mpr} | ${ppr} | ${em} | ${maxSpread.toFixed(3)} | ${div} |`);
}

lines.push('');
lines.push('## Pre-registered criteria');
lines.push('');
const stabilityOk = maxSpreadGlobal < 0.15;
lines.push(`- Judge stability (max spread < 0.15): **${stabilityOk ? 'PASS' : 'FAIL'}** (max=${maxSpreadGlobal.toFixed(3)})`);

const control = (run.scenarios || []).find((s) => s.id === 'pillar_down_hint_honored');
const controlMean = control?.expectations_mean_avg ?? 0;
const controlOk = controlMean >= 0.85;
lines.push(`- Control agreement (pillar_down expectations_mean >= 0.85): **${controlOk ? 'PASS' : 'FAIL'}** (${controlMean.toFixed(2)})`);

const indepOk = modelFamily(subjectModel) !== modelFamily(judgeModel);
lines.push(`- Judge independence (different families): **${indepOk ? 'PASS' : 'FAIL'}**`);

const patPct = patternTotal ? (patternAgree / patternTotal) * 100 : 0;
const patOk = patPct >= 85;
lines.push(`- Pattern vs judge agreement (per-run, threshold 0.7): **${patOk ? 'PASS' : 'FAIL'}** (${patPct.toFixed(0)}% over ${patternTotal} runs with patterns)`);

lines.push(`- Total cost < $0.50: **${totalCost < 0.5 ? 'PASS' : 'FAIL'}** ($${totalCost.toFixed(4)})`);
lines.push(`- Wall time (subject only, no judge latency sum): ~${(totalWallMs / 1000).toFixed(0)}s subject elapsed sum`);

lines.push('');
lines.push('## Overfit candidates (matcher fail, patterns+judge pass)');
lines.push(overfit.length ? overfit.map((id) => `- ${id}`).join('\n') : '- none');
lines.push('');
lines.push('## Insufficient-grading candidates (matcher pass, expectations low)');
lines.push(insufficient.length ? insufficient.map((id) => `- ${id}`).join('\n') : '- none');

lines.push('');
lines.push('## Per-expectation detail (last run per scenario)');
lines.push('');
for (const sc of run.scenarios || []) {
  const last = sc.runs?.[sc.runs.length - 1];
  if (!last?.expectation_grades?.length) continue;
  lines.push(`### ${sc.id}`);
  for (const eg of last.expectation_grades) {
    lines.push(
      `- **${eg.id}**: scores=[${(eg.scores || []).map((s) => s.toFixed(2)).join(', ')}] median=${eg.median?.toFixed(2)} spread=${eg.spread?.toFixed(3)} advisory=${eg.pass_advisory}`,
    );
  }
  lines.push('');
}

lines.push('## Gaming check (canary)');
lines.push('- See `node scripts/context-tests/run.mjs --canary` output for `gaming_verbose_wrong` calibration.');
lines.push('');

lines.push('## Architecture decision (fill after review)');
lines.push('');
lines.push('- A. Matchers + composites only');
lines.push('- B. Patterns + matchers, judge diagnostic only');
lines.push('- C. Hybrid (patterns + matchers + judge soft gate)');
lines.push('- D. NL judge primary, matchers safety floor only');
lines.push('');
lines.push('_Choice: (pending)_');

const outMd = runPath.replace(/-context\.json$/, '-experiment-a.report.md');
writeFileSync(outMd, lines.join('\n'));
console.error(`Wrote ${outMd}`);
