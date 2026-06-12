#!/usr/bin/env node
/**
 * mc command benchmark — score LLMs on composing mc commands correctly.
 *
 * Realistic mode (default) sends the same shape of prompt a production
 * Hermes agent gets: SOUL persona + skill + cheatsheet + /observe snapshot.
 *
 * --syntax-only    cheatsheet only (ablation; older simpler shape)
 * --models a,b     filter to specific models
 * --tasks direct,challenges   filter to specific task groups (comma-separated)
 * --persona F      alt persona file
 * --skill F        alt skill file
 * --observe F      alt observe fixture
 * --serial         disable per-task model parallelism
 * --timeout-ms N   abort OpenRouter request after N ms (default: models.json
 *                  timeout_ms or 120000). Counts full client wait including
 *                  response body download (see elapsed_ms below).
 *
 * Writes one file per model: runs/<model_slug>/<stamp>-realistic.json
 * (slug rules in runs-layout.mjs). Same suite timestamp across models in one invocation.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  enrichWithSimulation,
  extractMcLines,
  gradeChallenge,
  gradeComposition,
  gradeDirect,
} from './grading.mjs';
import { extractReportedBilling, summarizeRunBilling } from './billing-extract.mjs';
import { slugFromModelId } from './runs-layout.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = join(ROOT, 'scripts/benchmark');
const RUNS_DIR = join(HERE, 'runs');
mkdirSync(RUNS_DIR, { recursive: true });

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (flag) => argv.includes(flag);

const REALISTIC = !has('--syntax-only');
const PARALLEL = !has('--serial');

const SECRETS = '/Users/foz/hermescraft/secrets.yaml';
const keyMatch = readFileSync(SECRETS, 'utf8').match(/openrouter_api_key:\s*(\S+)/);
if (!keyMatch) {
  console.error('No openrouter_api_key');
  process.exit(1);
}
const OPENROUTER_KEY = keyMatch[1].trim();

const modelsCfg = JSON.parse(readFileSync(join(HERE, 'models.json'), 'utf8'));

const timeoutArg = arg('--timeout-ms');
let TIMEOUT_MS = 120000;
if (timeoutArg != null) {
  const n = Number(timeoutArg);
  if (Number.isFinite(n) && n > 0) TIMEOUT_MS = n;
} else if (typeof modelsCfg.timeout_ms === 'number' && modelsCfg.timeout_ms > 0) {
  TIMEOUT_MS = modelsCfg.timeout_ms;
}

const filterModels = arg('--models')?.split(',').map((s) => s.trim());
/** Models with enabled !== false, unless --models explicitly lists them (then always run). */
const models = modelsCfg.models.filter((m) => {
  const selected =
    !filterModels || filterModels.includes(m.label) || filterModels.includes(m.id);
  if (!selected) return false;
  if (filterModels) return true;
  return m.enabled !== false;
});
if (!models.length) {
  console.error('No models selected');
  process.exit(1);
}

const skippedBecauseDisabled = modelsCfg.models.filter((m) => {
  if (m.enabled !== false) return false;
  const explicit =
    filterModels &&
    (filterModels.includes(m.label) || filterModels.includes(m.id));
  return !explicit;
}).length;

const filterTasks = arg('--tasks')?.split(',').map((s) => s.trim());
const taskFiles = readdirSync(join(HERE, 'tasks')).filter((f) => f.endsWith('.json'));
/** @type {Record<string, unknown[]>} */
const taskGroups = {};
for (const f of taskFiles) {
  const groupName = f.replace(/\.json$/, '');
  if (filterTasks && !filterTasks.includes(groupName)) continue;
  taskGroups[groupName] = JSON.parse(readFileSync(join(HERE, 'tasks', f), 'utf8'));
}

const sortedGroupNames = Object.keys(taskGroups).sort();
if (!sortedGroupNames.length) {
  console.error('No task groups selected (check --tasks filter)');
  process.exit(1);
}

const cheatsheet = readFileSync(join(ROOT, 'docs/reference/mc-cheatsheet.md'), 'utf8');

let persona = '',
  skill = '',
  observeJson = '';
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
    try {
      pretty = JSON.stringify(JSON.parse(observeJson), null, 2);
    } catch {
      pretty = observeJson;
    }
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
  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/foz/hermescraft',
        'X-Title': 'mc benchmark',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const elapsed = Date.now() - t0;
    const name = /** @type {{ name?: string }} */ (e).name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { error: `timeout after ${TIMEOUT_MS}ms`, elapsed_ms: elapsed };
    }
    return { error: String(/** @type {{ message?: string }} */ (e).message || e), elapsed_ms: elapsed };
  }
  if (!res.ok) {
    const text = await res.text();
    const elapsed = Date.now() - t0;
    return { error: `${res.status}: ${text.slice(0, 300)}`, elapsed_ms: elapsed };
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    const elapsed = Date.now() - t0;
    return {
      error: `response JSON parse failed: ${/** @type {{ message?: string }} */ (e).message || e}`,
      elapsed_ms: elapsed,
    };
  }
  const elapsed = Date.now() - t0;
  const choice = data.choices?.[0];
  const usage = data.usage ?? choice?.usage ?? null;
  return {
    content: choice?.message?.content?.trim() ?? '',
    usage,
    elapsed_ms: elapsed,
    response_id: data.id ?? null,
    response_model: data.model ?? null,
    finish_reason: choice?.finish_reason ?? null,
    native_finish_reason: choice?.native_finish_reason ?? null,
  };
}

/**
 * @returns {{ usd: number|null, basis: string|null }}
 */
function computeCostDetails(model, usage) {
  if (!usage) return { usd: null, basis: null };
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
    return { usd: usage.cost, basis: 'openrouter.usage.cost' };
  }
  const upstream = usage.cost_details?.upstream_inference_cost;
  if (typeof upstream === 'number' && Number.isFinite(upstream)) {
    return { usd: upstream, basis: 'openrouter.usage.cost_details.upstream_inference_cost' };
  }
  const inM = (usage.prompt_tokens || 0) / 1e6;
  const outM = (usage.completion_tokens || 0) / 1e6;
  const est = inM * (model.cost_per_1m_in || 0) + outM * (model.cost_per_1m_out || 0);
  return { usd: est, basis: 'estimated_models_json' };
}

function gradeTask(groupName, task, content) {
  /** @type {Record<string, unknown>} */
  let base;
  if (groupName === 'direct') base = gradeDirect(content, task.correct);
  else if (groupName === 'composition')
    base = gradeComposition(
      content,
      task.correct_lines_required,
      task.scoring,
      /** @type {string[][] | undefined} */ (task.correct_line_groups),
    );
  else if (groupName === 'challenges') base = gradeChallenge(content, task);
  else
    base = {
      pass: false,
      error: `unknown group ${groupName}`,
      mc_lines: extractMcLines(content),
      semantic_score: 0,
      parse_ok_rate: null,
    };

  if (groupName === 'challenges') return /** @type {Record<string, unknown>} */ (base);
  if (base.error) return /** @type {Record<string, unknown>} */ (base);

  return enrichWithSimulation(/** @type {Parameters<typeof enrichWithSimulation>[0]} */ (base), content);
}

let gitSha = 'unknown';
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
if (sha.status === 0) gitSha = sha.stdout.toString().trim();

const suiteTimestamp = new Date().toISOString();

const totalCalls =
  sortedGroupNames.reduce((sum, g) => sum + taskGroups[g].length, 0) * models.length;
let completedCalls = 0;
const startTime = Date.now();

const suiteModelsMeta = models.map((m) => ({ id: m.id, label: m.label }));

const firstGroup = sortedGroupNames[0];
const firstTask = taskGroups[firstGroup][0];
const samplePromptLen = buildPrompt(firstTask.task).length;

console.error('');
console.error('══════════════════════════════════════════════════════════════════');
console.error('  HermesCraft — mc command benchmark (OpenRouter)');
console.error('══════════════════════════════════════════════════════════════════');
console.error(`  Started:      ${suiteTimestamp}`);
console.error(`  Git SHA:      ${gitSha}`);
console.error(`  Repo:         ${ROOT}`);
console.error(`  Secrets:      ${SECRETS}`);
console.error(
  `  Mode:         ${REALISTIC ? 'realistic (persona + skill + observe + cheatsheet)' : 'syntax-only (cheatsheet)'}`,
);
console.error(
  `  Concurrency:  ${PARALLEL ? 'parallel — one API queue per model' : 'serial — single in-flight request'}`,
);
console.error(`  Timeout:      ${TIMEOUT_MS}ms per request (--timeout-ms or models.json timeout_ms)`);
console.error(`  Runs dir:     ${RUNS_DIR}  (per-model subdirs, see runs-layout.mjs)`);
console.error('──────────────────────────────────────────────────────────────────');
console.error('  Prompt footprint (bytes)');
console.error(`    cheatsheet:  ${cheatsheet.length}`);
if (REALISTIC) {
  console.error(`    persona:     ${persona.length}`);
  console.error(`    skill:       ${skill.length}`);
  console.error(`    observe:     ${observeJson.length}`);
}
console.error(
  `    sample user prompt + scaffolding (task "${firstTask.id}" in ${firstGroup}): ${samplePromptLen}`,
);
console.error('──────────────────────────────────────────────────────────────────');
console.error(`  Models (${models.length})`);
for (let i = 0; i < models.length; i++) {
  const m = models[i];
  const tin = m.cost_per_1m_in ?? 0;
  const tout = m.cost_per_1m_out ?? 0;
  console.error(
    `    ${String(i + 1).padStart(2)}  ${m.label.padEnd(34)}  $${tin}/$${tout} per 1M in/out`,
  );
  console.error(`        ${m.id}`);
}
console.error('──────────────────────────────────────────────────────────────────');
console.error('  Task groups');
for (const g of sortedGroupNames) {
  console.error(`    ${g.padEnd(14)} ${taskGroups[g].length} tasks`);
}
console.error(`  Total OpenRouter calls: ${totalCalls}`);
if (skippedBecauseDisabled > 0) {
  console.error(
    `  Skipped:      ${skippedBecauseDisabled} model(s) with enabled=false (use --models to force one)`,
  );
}
console.error('══════════════════════════════════════════════════════════════════');
console.error('');
console.error(
  'Live progress: `… requesting` lines fire immediately; completion lines include grading + HTTP RTT (until response body is read — not provider inference-only timing).',
);
console.error('');

async function runTaskOnModel(groupName, task, model) {
  const prompt = buildPrompt(task.task);
  console.error(`    … requesting  ${groupName}/${task.id}  (${model.label})`);
  const r = await callOR(model.id, prompt);
  const usage = r.usage;
  const { usd: cost, basis: cost_basis } = computeCostDetails(model, usage);
  const reported = extractReportedBilling(usage);

  /** @type {Record<string, unknown>} */
  let result = {
    group: groupName,
    task_id: task.id,
    category: task.category,
    model: model.label,
    elapsed_ms: r.elapsed_ms,
    usage,
    tokens_reported: reported.tokens_reported,
    cost_reported_usd: reported.cost_reported_usd,
    upstream_inference_cost_usd: reported.upstream_inference_cost_usd,
    cost_usd: cost,
    cost_basis: r.error ? null : cost_basis,
    output: r.content,
    response_id: r.response_id,
    response_model: r.response_model,
    finish_reason: r.finish_reason,
    native_finish_reason: r.native_finish_reason,
  };

  if (r.error) {
    result = {
      ...result,
      pass: false,
      error: r.error,
      semantic_score: 0,
      parse_ok_rate: null,
    };
  } else {
    const graded = gradeTask(groupName, task, r.content);
    Object.assign(result, graded);
  }

  completedCalls++;
  const elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(0);
  const tag = result.pass ? 'PASS' : 'FAIL';
  const sem =
    result.semantic_score != null ? ` sem=${Number(result.semantic_score).toFixed(2)}` : '';
  console.error(
    `  [${completedCalls}/${totalCalls} ${elapsedTotal}s] ${tag.padEnd(4)}  ${groupName}/${task.id} on ${model.label.padEnd(28)} ${r.elapsed_ms}ms RTT  $${(cost ?? 0).toFixed(5)}${sem}`,
  );
  return result;
}

async function runModelTaskList(model) {
  const out = [];
  for (const groupName of sortedGroupNames) {
    const tasks = taskGroups[groupName];
    for (const task of tasks) {
      const row = await runTaskOnModel(groupName, task, model);
      out.push(row);
    }
  }
  return out;
}

/** @type {Awaited<ReturnType<typeof runModelTaskList>>[]} */
let perModelResults;
if (PARALLEL) {
  perModelResults = await Promise.all(models.map((m) => runModelTaskList(m)));
} else {
  perModelResults = [];
  for (const model of models) {
    perModelResults.push(await runModelTaskList(model));
  }
}

const stamp = suiteTimestamp.replace(/[:.]/g, '-');
const suffix = REALISTIC ? '-realistic' : '-syntax';
const writtenPaths = [];
for (let i = 0; i < models.length; i++) {
  const model = models[i];
  const results = /** @type {Record<string, unknown>[]} */ (perModelResults[i]);
  const modelSlug = slugFromModelId(model.id);
  const modelDir = join(RUNS_DIR, modelSlug);
  mkdirSync(modelDir, { recursive: true });
  const outPath = join(modelDir, `${stamp}${suffix}.json`);
  const modelRun = {
    timestamp: suiteTimestamp,
    model_id: model.id,
    model_label: model.label,
    suite_models: suiteModelsMeta,
    git_sha: gitSha,
    realistic: REALISTIC,
    parallel: PARALLEL,
    request_timeout_ms: TIMEOUT_MS,
    cheatsheet_bytes: cheatsheet.length,
    persona_bytes: persona.length,
    skill_bytes: skill.length,
    observe_bytes: observeJson.length,
    task_groups: sortedGroupNames,
    results,
    usage_totals: summarizeRunBilling(results),
  };
  writeFileSync(outPath, JSON.stringify(modelRun, null, 2));
  writtenPaths.push(outPath);
}

console.error('');
for (const p of writtenPaths) console.error(`Wrote ${p}`);
console.error(`Total wallclock: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

const allResultsFlat = perModelResults.flat();
const summary = {};
for (const r of allResultsFlat) {
  const k = `${r.group}/${r.model}`;
  if (!summary[k]) {
    summary[k] = {
      pass: 0,
      total: 0,
      cost: 0,
      time: 0,
      sem_sum: 0,
      parse_sum: 0,
      parse_n: 0,
    };
  }
  summary[k].total++;
  if (r.pass) summary[k].pass++;
  summary[k].cost += r.cost_usd || 0;
  summary[k].time += r.elapsed_ms || 0;
  if (typeof r.semantic_score === 'number') summary[k].sem_sum += r.semantic_score;
  if (typeof r.parse_ok_rate === 'number') {
    summary[k].parse_sum += r.parse_ok_rate;
    summary[k].parse_n++;
  }
}
console.error('\n=== Summary ===');
for (const [k, v] of Object.entries(summary).sort()) {
  const pct = ((v.pass / v.total) * 100).toFixed(0);
  const avgSem = v.total ? (v.sem_sum / v.total).toFixed(2) : 'n/a';
  const avgParse = v.parse_n ? ((v.parse_sum / v.parse_n) * 100).toFixed(0) + '%' : 'n/a';
  console.error(
    `  ${k.padEnd(45)}  ${v.pass}/${v.total}  (${pct}%)  sem_avg=${avgSem}  parse_ok=${avgParse}  ~$${v.cost.toFixed(4)}  ${(v.time / v.total).toFixed(0)}ms/call`,
  );
}
