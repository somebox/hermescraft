#!/usr/bin/env node
/**
 * Re-score saved run outputs with judge ON vs OFF mc context (no subject re-run).
 * Usage: node compare-judge-context.mjs <path-to-context.json> [--samples 3]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeExpectations } from './judge.mjs';
import { buildJudgeContext } from './lib/judge-context.mjs';
import { loadScenario, scenarioExpectations } from './lib/scenario.mjs';
import { REPO_ROOT, DATA_DIR } from './lib/paths.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const runPath = resolve(process.argv[2] || '');
const samplesArg = process.argv.indexOf('--samples');
const samples = samplesArg >= 0 ? Number(process.argv[samplesArg + 1]) : 3;

if (!runPath || !existsSync(runPath)) {
  console.error('Usage: node compare-judge-context.mjs <run.json> [--samples N]');
  process.exit(1);
}

let OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const sec = join(REPO_ROOT, 'secrets.yaml');
if (!OPENROUTER_KEY && existsSync(sec)) {
  const m = readFileSync(sec, 'utf8').match(/openrouter_api_key:\s*(\S+)/);
  if (m) OPENROUTER_KEY = m[1].trim();
}
if (!OPENROUTER_KEY) {
  console.error('Need OPENROUTER_API_KEY');
  process.exit(1);
}

const run = JSON.parse(readFileSync(runPath, 'utf8'));
const judgeModelId = run.config_resolved?.judge?.model || 'google/gemini-2.5-flash-lite';
const cheatsheet = readFileSync(join(REPO_ROOT, 'docs/mc-cheatsheet.md'), 'utf8');

const contextOff = '';
const contextConventions = buildJudgeContext({
  judgeCfg: { context_mode: 'mc_conventions', include_cheatsheet: false },
  cheatsheet,
});
const contextFull = buildJudgeContext({
  judgeCfg: { context_mode: 'mc_conventions', include_cheatsheet: true, cheatsheet_max_chars: 8000 },
  cheatsheet,
});

function scenarioById(id) {
  const path = join(DATA_DIR, `${id}.yaml`);
  return loadScenario(path).raw;
}

console.log(`Re-judging ${runPath}`);
console.log(`Judge: ${judgeModelId}, samples=${samples}`);
console.log(
  `Context: OFF | conventions (${contextConventions.length} chars) | full (${contextFull.length} chars)\n`,
);

const rows = [];

for (const sc of run.scenarios || []) {
  const raw = scenarioById(sc.id);
  const expectations = scenarioExpectations(raw);
  if (!expectations.length) continue;

  let offMeans = [];
  let convMeans = [];
  let fullMeans = [];
  for (const r of sc.runs || []) {
    if (!r.raw_output) continue;
    const base = {
      apiKey: OPENROUTER_KEY,
      modelId: judgeModelId,
      scenarioDescription: raw.description,
      agentOutput: r.raw_output,
      simulatedRequests: r.simulated_requests,
      expectations,
      samples,
      concurrency: 4,
    };
    const off = await judgeExpectations({ ...base, judgeContext: contextOff });
    const conv = await judgeExpectations({ ...base, judgeContext: contextConventions });
    const full = await judgeExpectations({ ...base, judgeContext: contextFull });
    offMeans.push(off.weighted_mean);
    convMeans.push(conv.weighted_mean);
    fullMeans.push(full.weighted_mean);
    console.error(
      `  ${sc.id} run ${r.n}: off=${off.weighted_mean?.toFixed(2)} conv=${conv.weighted_mean?.toFixed(2)} full=${full.weighted_mean?.toFixed(2)}`,
    );
  }
  const avg = (arr) => arr.filter((x) => x != null).reduce((a, b) => a + b, 0) / Math.max(1, arr.filter((x) => x != null).length);
  rows.push({
    id: sc.id,
    off: avg(offMeans),
    conv: avg(convMeans),
    full: avg(fullMeans),
  });
}

console.log('\n| scenario | no ctx | conventions | + cheatsheet | Δ conv | Δ full |');
console.log('|----------|--------|-------------|--------------|--------|--------|');
for (const r of rows) {
  const dConv = r.conv - r.off;
  const dFull = r.full - r.off;
  console.log(
    `| ${r.id} | ${r.off?.toFixed(2)} | ${r.conv?.toFixed(2)} | ${r.full?.toFixed(2)} | ${dConv >= 0 ? '+' : ''}${dConv?.toFixed(2)} | ${dFull >= 0 ? '+' : ''}${dFull?.toFixed(2)} |`,
  );
}
