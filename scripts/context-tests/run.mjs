#!/usr/bin/env node
/**
 * Context tests — Layer 1 runner.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { spawnSync } from 'node:child_process';
import { slugFromModelId } from '../benchmark/runs-layout.mjs';
import { extractReportedBilling } from '../benchmark/billing-extract.mjs';
import { loadConfig, defaultConfigPath } from './lib/config.mjs';
import { resolveAllOverrides, applyScenarioPatches } from './lib/overrides.mjs';
import { resolveSuiteFromConfig, loadSuiteFile } from './lib/suite.mjs';
import { compactScenarioRow, writeRunRecord } from './lib/run-record.mjs';
import {
  listScenarioFiles,
  loadScenario,
  resolveScenarioPaths,
  defaultRuns,
  filterScenarios,
  sha256File,
  scenarioMatcherExpect,
  scenarioGradingSurface,
  scenarioPatterns,
  scenarioExpectations,
  modelFamily,
} from './lib/scenario.mjs';
import { REPO_ROOT, RUNS_DIR, BENCHMARK_DIR } from './lib/paths.mjs';
import { buildTranscriptMessages, loadTextFiles } from './lib/prompt-builder.mjs';
import { gradeExpect, runPatterns } from './grading.mjs';
import { runJudge, judgeExpectations } from './judge.mjs';
import { wilsonLowerBound } from './lib/stats.mjs';
import { estimateTokens, estimateRunCostUsd } from './lib/preflight.mjs';
import { DEFAULT_OUTPUT_TOKENS, SCHEMA_VERSION } from './lib/constants.mjs';
import { buildJudgeContext } from './lib/judge-context.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (has('--canary')) {
  const r = spawnSync('node', [join(__dirname, 'canary', 'run.mjs')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

if (has('--verify-only')) {
  const r = spawnSync('node', [join(__dirname, 'verify-fixtures.mjs')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const configPath = arg('--config') || defaultConfigPath();
const runsOverrideCli = arg('--runs-override');
const noJudge = has('--no-judge');
const yesBudget = has('--yes');
const estimateOnly = has('--estimate-only');
const quiet = has('-q') || has('--quiet');

let OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const secretsPaths = [
  join(REPO_ROOT, 'secrets.yaml'),
  '/Users/foz/homelab/secrets.yaml',
];
if (!OPENROUTER_KEY) {
  for (const p of secretsPaths) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/openrouter_api_key:\s*(\S+)/);
    if (m) {
      OPENROUTER_KEY = m[1].trim();
      break;
    }
  }
}

const { resolved: cfgRaw } = loadConfig(configPath);
let cfg = { ...cfgRaw };
const suiteFileArg = arg('--suite-file');
if (suiteFileArg) {
  const s = loadSuiteFile(suiteFileArg.startsWith('/') ? suiteFileArg : join(REPO_ROOT, suiteFileArg));
  cfg = { ...cfg, suite: { scenarios: s.scenarios } };
}
const scenarioIdArg = arg('--scenario-id');
if (scenarioIdArg) {
  cfg = { ...cfg, suite: { scenarios: [scenarioIdArg] } };
}
const runsOverride =
  runsOverrideCli != null ? Number(runsOverrideCli) : cfg.runs_override != null ? Number(cfg.runs_override) : null;
const overrideMaps = resolveAllOverrides(cfg.overrides, REPO_ROOT);
const promptOverrides = overrideMaps.prompts;
const skillOverrides = overrideMaps.skills;
const cheatsheetOverridePath = overrideMaps.cheatsheetPath;

const modelsCfg = JSON.parse(readFileSync(join(BENCHMARK_DIR, 'models.json'), 'utf8'));
const modelIds = (cfg.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
const models = modelIds
  .map((id) => modelsCfg.models.find((m) => m.id === id || m.label === id))
  .filter(Boolean);

let scenarios = listScenarioFiles().map(loadScenario);
const suiteFilter = resolveSuiteFromConfig(cfg.suite);
scenarios = filterScenarios(scenarios, suiteFilter);
scenarios = scenarios.map((sc) => ({
  ...sc,
  raw: applyScenarioPatches(sc.raw, overrideMaps.scenarioPatches),
}));

const cheatsheetPath = cheatsheetOverridePath || join(REPO_ROOT, 'docs/reference/mc-cheatsheet.md');
const cheatsheet = readFileSync(cheatsheetPath, 'utf8');
const suiteName =
  cfg.suite?.preset || (Array.isArray(suiteFilter.scenarios) ? suiteFilter.scenarios.join(',') : null);
const label = cfg.label || null;
const budgetUsd = cfg.budget_usd ?? 0.5;
const temperature = cfg.temperature ?? 0.5;
const judgeEnabled = !noJudge && cfg.judge?.enabled !== false;
const judgeModelId = cfg.judge?.model || 'google/gemini-2.5-flash-lite';
const judgeSamples = cfg.judge?.samples ?? 3;
const judgeConcurrency = cfg.judge?.concurrency ?? 4;
const experimentId = cfg.experiment_id || null;

if (experimentId === 'safety-experiment-a' && models.length) {
  const subj = models[0].id;
  if (modelFamily(subj) === modelFamily(judgeModelId)) {
    console.error(`Experiment requires judge model in a different family than subject (${subj} vs ${judgeModelId})`);
    process.exit(1);
  }
}

let totalCalls = 0;
for (const sc of scenarios) {
  const runs =
    runsOverride ??
    sc.raw.runs ??
    defaultRuns(sc.raw.contract_level);
  totalCalls += runs * models.length;
}

const samplePromptLen = 12000;
const estUsd = estimateRunCostUsd({
  promptTokensPerCall: estimateTokens('x'.repeat(samplePromptLen)),
  outputTokensPerCall: DEFAULT_OUTPUT_TOKENS,
  calls: totalCalls,
  judgeCalls: judgeEnabled ? totalCalls : 0,
  modelInPer1m: models[0]?.cost_per_1m_in ?? 0.1,
  modelOutPer1m: models[0]?.cost_per_1m_out ?? 0.2,
  judgeInPer1m: 0.1,
  judgeOutPer1m: 0.2,
});

console.error(`Context tests: ${scenarios.length} scenarios × ${models.length} models, ~${totalCalls} calls, est ~$${estUsd.toFixed(3)}`);
if (estimateOnly) {
  console.log(JSON.stringify({ estimate_usd: estUsd, total_calls: totalCalls, budget_usd: budgetUsd }, null, 2));
  process.exit(0);
}
if (estUsd > budgetUsd && !yesBudget && totalCalls > 0) {
  console.error(`Estimated $${estUsd.toFixed(3)} exceeds budget $${budgetUsd}. Pass --yes to run.`);
  process.exit(1);
}
if (!OPENROUTER_KEY && totalCalls > 0) {
  console.error('No OPENROUTER_API_KEY');
  process.exit(1);
}

if (totalCalls === 0) {
  console.error('No scenarios/models to run');
  process.exit(0);
}

const verify = spawnSync('node', [join(__dirname, 'verify-fixtures.mjs')], { encoding: 'utf8' });
if (verify.status !== 0) {
  console.error(verify.stdout);
  console.error(verify.stderr);
  process.exit(verify.status ?? 1);
}

let gitSha = 'unknown';
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
if (sha.status === 0) gitSha = sha.stdout.toString().trim();

const suiteTimestamp = new Date().toISOString();

async function callModel(modelId, messages) {
  const t0 = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/foz/hermescraft',
        'X-Title': 'context-tests',
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        max_tokens: DEFAULT_OUTPUT_TOKENS,
        temperature,
      }),
      signal: AbortSignal.timeout(cfg.request_timeout_ms ?? 120000),
    });
    const elapsed_ms = Date.now() - t0;
    if (!res.ok) {
      return { outcome: 'model_error', error: `${res.status}`, elapsed_ms, content: '' };
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    return {
      outcome: 'pass_pending',
      content,
      usage: data.usage,
      elapsed_ms,
      finish_reason: data.choices?.[0]?.finish_reason,
    };
  } catch (e) {
    return { outcome: 'infra_error', error: String(e.message || e), elapsed_ms: Date.now() - t0, content: '' };
  }
}

function fixtureHashesForScenario(sc, paths) {
  const h = {
    profile: sha256File(paths.profilePath),
    skills: paths.skillPaths.map((p) => sha256File(p)),
    observe: paths.observePath ? sha256File(paths.observePath) : null,
    memory: paths.memoryPath ? sha256File(paths.memoryPath) : null,
  };
  return h;
}

let suiteHadFailures = false;
for (const model of models) {
  const scenarioResults = [];
  for (const sc of scenarios) {
    const raw = sc.raw;
    const paths = resolveScenarioPaths(raw, promptOverrides, skillOverrides);
    const persona = readFileSync(paths.profilePath, 'utf8');
    const skills = loadTextFiles(paths.skillPaths);
    const observeJson = paths.observePath ? readFileSync(paths.observePath, 'utf8') : '{}';
    const memoryInline = paths.memoryInline;
    const prior = raw.prior;
    const priorFormat = raw.prior_format || (prior?.length ? 'text' : 'snapshot');
    const mode = prior?.length ? 'transcript' : 'snapshot';
    const messages = buildTranscriptMessages({
      persona,
      skills,
      cheatsheet,
      observeJson,
      memoryInline,
      prior,
      priorFormat,
      userPrompt: raw.user_prompt,
    });
    const runsN = runsOverride ?? raw.runs ?? defaultRuns(raw.contract_level);
    const runRows = [];
    let matcherPass = 0;
    let matcherFail = 0;
    const ops = { model_error: 0, infra_error: 0, invalid_fixture: 0 };

    for (let n = 1; n <= runsN; n++) {
      const r = await callModel(model.id, messages);
      let outcome = r.outcome;
      let graded = null;
      if (outcome === 'pass_pending') {
        graded = gradeExpect(r.content, scenarioMatcherExpect(raw), {
          surface: scenarioGradingSurface(raw),
        });
        outcome = graded.pass ? 'pass' : 'matcher_fail';
        if (graded.pass) matcherPass++;
        else matcherFail++;
      } else if (outcome === 'model_error') ops.model_error++;
      else if (outcome === 'infra_error') ops.infra_error++;

      let patterns_result = null;
      const patternSpecs = scenarioPatterns(raw);
      if (
        scenarioGradingSurface(raw) === 'mc' &&
        graded?.simulated_requests &&
        patternSpecs.length
      ) {
        patterns_result = runPatterns(graded.simulated_requests, patternSpecs, { prior });
      }

      let expectation_grades = null;
      let judge_score = null;
      let judge_rationale = null;
      const expectations = scenarioExpectations(raw);
      if (judgeEnabled && expectations.length && r.content && modelFamily(model.id) !== modelFamily(judgeModelId)) {
        const judgeContext = buildJudgeContext({
          judgeCfg: cfg.judge,
          cheatsheet,
          scenarioJudgeContext: raw.judge_context,
        });
        const jg = await judgeExpectations({
          apiKey: OPENROUTER_KEY,
          modelId: judgeModelId,
          scenarioDescription: raw.description,
          agentOutput: r.content,
          simulatedRequests: graded?.simulated_requests,
          expectations,
          judgeContext,
          samples: judgeSamples,
          concurrency: judgeConcurrency,
        });
        expectation_grades = jg;
        judge_score = jg.weighted_mean;
      } else {
        const judgeCfg = raw.expect?.judge;
        if (judgeEnabled && judgeCfg?.enabled && r.content && judgeCfg.model !== model.id) {
          const j = await runJudge({
            apiKey: OPENROUTER_KEY,
            modelId: judgeCfg.model || judgeModelId,
            rubric: judgeCfg.rubric,
            description: raw.description,
            agentOutput: r.content,
          });
          if (!j.error) {
            judge_score = j.score;
            judge_rationale = j.rationale;
          }
        }
      }

      const reported = extractReportedBilling(r.usage);
      const judgeCost = expectation_grades?.total_cost_usd || 0;
      runRows.push({
        n,
        outcome,
        raw_output: r.content,
        mc_lines: graded?.mc_lines,
        simulated_requests: graded?.simulated_requests,
        chat_lines: graded?.chat_lines,
        matchers: graded?.trace,
        patterns: patterns_result?.trace,
        patterns_pass: patterns_result?.pass ?? null,
        expectation_grades: expectation_grades?.expectations,
        expectations_weighted_mean: expectation_grades?.weighted_mean ?? null,
        judge_score,
        judge_rationale,
        judge_cost_usd: judgeCost || undefined,
        elapsed_ms: r.elapsed_ms,
        cost_usd: (reported.cost_reported_usd || 0) + judgeCost,
        error: r.error,
      });
    }

    const denom = matcherPass + matcherFail;
    const pass_rate = denom ? matcherPass / denom : 0;
    const stable_pass =
      raw.contract_level === 'hard'
        ? pass_rate >= 4 / 5 && denom >= 3
        : raw.contract_level === 'soft'
          ? pass_rate >= 2 / 3
          : null;
    const judge_avg =
      runRows.filter((x) => x.judge_score != null).reduce((s, x) => s + x.judge_score, 0) /
      Math.max(1, runRows.filter((x) => x.judge_score != null).length);
    const patternRuns = runRows.filter((x) => x.patterns_pass != null);
    const patterns_pass_rate = patternRuns.length
      ? patternRuns.filter((x) => x.patterns_pass).length / patternRuns.length
      : null;
    const expMeans = runRows.map((x) => x.expectations_weighted_mean).filter((v) => v != null);
    const expectations_mean_avg = expMeans.length
      ? expMeans.reduce((a, b) => a + b, 0) / expMeans.length
      : null;

    scenarioResults.push({
      id: raw.id,
      category: raw.category,
      contract_level: raw.contract_level,
      mode,
      prior_format: priorFormat,
      source: raw.source,
      fixture_hashes: fixtureHashesForScenario(raw, paths),
      rendered_prompt: messages,
      runs: runRows,
      pass_rate,
      pass_rate_lb: wilsonLowerBound(matcherPass, denom),
      operational_failures: ops,
      stable_pass,
      judge_avg: Number.isFinite(judge_avg) ? judge_avg : null,
      patterns_pass_rate,
      expectations_mean_avg,
      judge_model_id: scenarioExpectations(raw).length ? judgeModelId : undefined,
    });
  }

  const slug = slugFromModelId(model.id);
  const modelDir = join(RUNS_DIR, slug);
  mkdirSync(modelDir, { recursive: true });
  const stamp = suiteTimestamp.replace(/[:.]/g, '-');
  const outPath = join(modelDir, `${stamp}-context.json`);
  const payload = {
    schema_version: SCHEMA_VERSION,
    timestamp: suiteTimestamp,
    git_sha: gitSha,
    config_path: configPath,
    config_resolved: cfg,
    model_id: model.id,
    fixture_hashes: {
      cheatsheet: sha256File(join(REPO_ROOT, 'docs/reference/mc-cheatsheet.md')),
      models_json: sha256File(join(BENCHMARK_DIR, 'models.json')),
    },
    scenarios: scenarioResults,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.error(`Wrote ${outPath}`);

  const inputHashes = {
    [cheatsheetPath.replace(REPO_ROOT + '/', '')]: sha256File(cheatsheetPath),
  };
  for (const sc of scenarioResults) {
    const fh = sc.fixture_hashes;
    if (fh?.profile) inputHashes[`profile:${sc.id}`] = fh.profile;
  }
  const compact = scenarioResults.map(compactScenarioRow);
  const runId = `r_${stamp}`;
  const { runId: writtenId } = writeRunRecord({
    runId,
    slug,
    stamp,
    gitSha,
    configPath,
    label,
    suiteName,
    resolvedConfig: cfg,
    subjectModel: model.id,
    judgeModel: judgeModelId,
    temperature,
    runsPerScenario: runsOverride ?? 3,
    judgeSamples,
    inputHashes,
    scenariosCompact: compact,
  });
  if (quiet) {
    console.log(writtenId);
  } else {
    console.error(`Run record ${writtenId}`);
  }
  if (compact.some((s) => s.verdict === 'fail')) suiteHadFailures = true;
}
process.exit(suiteHadFailures ? 3 : 0);
