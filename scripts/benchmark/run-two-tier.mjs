#!/usr/bin/env node
/**
 * Two-tier (decompose + execute) eval.
 *
 * Hypothesis: a high-level "decomposer" agent that produces step descriptions
 * + a low-level "executor" agent that turns each step into one mc command
 * is more accurate on multi-step tasks than a single agent doing both.
 *
 * Why we expect this to work: the realistic-context benchmark showed that
 * adding SOUL + skill + observe to the prompt drops accuracy on direct
 * tasks (DeepSeek 100% → 80%, Nemotron 100% → 73%). If we strip that
 * heavy context out of the command-emission step, we should recover the
 * cheatsheet-only accuracy on each step.
 *
 * Pipeline:
 *
 *   composition task
 *      │
 *      ▼
 *   DECOMPOSER (sees full realistic prompt: persona + skill + observe + cheatsheet)
 *      │   prompt: "Output a numbered list of single-action steps."
 *      │   output: "1. Place cobblestone at (5,65,5)\n2. ..."
 *      ▼
 *   EXECUTOR (sees ONLY cheatsheet + one step)  ← parallelizable per step
 *      │   prompt: "<step description> → produce the mc command."
 *      │   output: mc place 5 65 5 cobblestone
 *      ▼
 *   chain of mc commands
 *
 * Score: same composition grading. All required lines must be present
 * across the chain.
 *
 * Usage:
 *   node scripts/benchmark/run-two-tier.mjs --models deepseek-v4-flash,gemma-4-31b-it
 *   node scripts/benchmark/run-two-tier.mjs --decomposer gemma-4-31b-it --executor deepseek-v4-flash
 *
 * If --decomposer / --executor not given, both roles use each model in --models.
 * That gives same-model two-tier (vs single-shot of the same model).
 *
 * Mixed-model mode (decomposer = capable, executor = cheap) is the
 * production-relevant configuration to evaluate.
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
const explicitDecomposer = arg('--decomposer');
const explicitExecutor = arg('--executor');

function findModel(label) {
  return modelsCfg.models.find((m) => m.label === label || m.id === label);
}

const sameModelPairs = (filterModels || []).map((label) => {
  const m = findModel(label);
  if (!m) throw new Error(`unknown model: ${label}`);
  return { decomposer: m, executor: m, label };
});

const explicitPair = explicitDecomposer && explicitExecutor
  ? { decomposer: findModel(explicitDecomposer), executor: findModel(explicitExecutor), label: `${explicitDecomposer}->${explicitExecutor}` }
  : null;

const pairs = explicitPair ? [explicitPair] : sameModelPairs;
if (!pairs.length) {
  console.error('No model pairs. Use --models a,b or --decomposer X --executor Y');
  process.exit(1);
}

const taskFile = join(HERE, 'tasks/composition.json');
const tasks = JSON.parse(readFileSync(taskFile, 'utf8'));

const cheatsheet = readFileSync(join(ROOT, 'docs/mc-cheatsheet.md'), 'utf8');
const persona = readFileSync(join(HERE, 'fixtures/persona-flint.md'), 'utf8');
const skill = readFileSync(join(HERE, 'fixtures/skill-survival.md'), 'utf8');
const observeJson = readFileSync(join(HERE, 'fixtures/observe-flint.json'), 'utf8');
let observePretty;
try { observePretty = JSON.stringify(JSON.parse(observeJson), null, 2); } catch { observePretty = observeJson; }

function buildDecomposerPrompt(task) {
  return `# Persona

${persona}

# Skill: minecraft-survival

${skill}

# Available \`mc\` commands (reference only — DO NOT emit these)

${cheatsheet}

# Current game state

\`\`\`json
${observePretty}
\`\`\`

# Your job: PLAN ONLY — a different worker executes

You are the high-level planner. A separate low-level executor worker will turn each of your steps into one mc command. Your output is plain English step descriptions, NOT mc commands.

Format requirements (strict):
- Numbered list: "1. ... 2. ... 3. ..."
- Each line is ONE concrete physical action ("Place a cobblestone block at (5, 65, 5)").
- Do NOT include "mc", backticks, code, or any CLI syntax.
- Do NOT explain or add commentary outside the numbered list.

CORRECT plan example for "build a single-block torch tower at (10, 65, 10)":

1. Place a cobblestone block at (10, 65, 10).
2. Place a torch on top of the cobblestone block at (10, 66, 10).

INCORRECT (forbidden — do NOT do this):

\`mc place cobblestone 10 65 10\`
\`mc place torch 10 66 10\`

# Task

${task}`;
}

function buildExecutorPrompt(stepDescription) {
  return `You operate a Minecraft bot via the \`mc\` CLI. Given ONE concrete step, output the EXACT mc command.

# Available commands

${cheatsheet}

# Output format

Reply with ONLY the mc command inside a fenced code block. No prose.

\`\`\`
mc some_verb arg1 arg2
\`\`\`

# Step

${stepDescription}`;
}

async function callOR(modelId, prompt, maxTokens) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/foz/hermescraft',
      'X-Title': 'mc benchmark two-tier',
    },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.1 }),
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

function parseSteps(decomposerOutput) {
  // Match numbered lines (1. 2. 3.) and bullets.
  const lines = decomposerOutput.split('\n');
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*])\s*(.+)$/);
    if (m) steps.push(m[1].trim());
  }
  return steps;
}

function gradeChain(commands, requiredLines, scoring) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const partialArgsOk = scoring && scoring.includes('partial_args_ok');
  const matched = [];
  for (const required of requiredLines) {
    const r = norm(required);
    let hit = false;
    for (const line of commands) {
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
  return { pass: matched.every(Boolean), matched };
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
  mode: 'two-tier',
  pairs: pairs.map((p) => ({ label: p.label, decomposer: p.decomposer.label, executor: p.executor.label })),
  results: [],
};

const totalCalls = pairs.length * tasks.length;
let completed = 0;
const startTime = Date.now();
console.error(`Two-tier eval: ${pairs.length} model pairs × ${tasks.length} composition tasks`);
console.error(`Pairs: ${pairs.map((p) => p.label).join(', ')}\n`);

for (const pair of pairs) {
  // Run all tasks in parallel for this pair
  const taskPromises = tasks.map(async (task) => {
    // Step 1: decomposer
    const decResp = await callOR(pair.decomposer.id, buildDecomposerPrompt(task.task), 600);
    if (decResp.error) {
      return { task_id: task.id, pair: pair.label, error: `decomposer: ${decResp.error}`, pass: false };
    }
    const steps = parseSteps(decResp.content);

    // Step 2: executor on each step (parallel)
    const stepResponses = await Promise.all(
      steps.map((s) => callOR(pair.executor.id, buildExecutorPrompt(s), 200)),
    );
    const stepCommands = stepResponses.flatMap((r) => r.error ? [] : extractMcLines(r.content));

    // Grade
    const grade = gradeChain(stepCommands, task.correct_lines_required, task.scoring);

    const decCost = computeCost(pair.decomposer, decResp.usage) ?? 0;
    const execCost = stepResponses.reduce((sum, r) => sum + (computeCost(pair.executor, r.usage) ?? 0), 0);

    completed++;
    const elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(0);
    console.error(
      `  [${completed}/${totalCalls} ${elapsedTotal}s] ${grade.pass ? 'PASS' : 'FAIL'}  ${task.id} on ${pair.label}` +
      `   ${steps.length} steps, $${(decCost + execCost).toFixed(5)}`,
    );

    return {
      pair: pair.label,
      task_id: task.id,
      decomposer_output: decResp.content,
      decomposed_steps: steps,
      step_responses: stepResponses.map((r, i) => ({
        step: steps[i],
        output: r.error ? `<error: ${r.error}>` : r.content,
        elapsed_ms: r.elapsed_ms,
        usage: r.usage,
      })),
      step_commands: stepCommands,
      ...grade,
      cost_usd: decCost + execCost,
      decomposer_cost: decCost,
      executor_cost: execCost,
      total_steps: steps.length,
    };
  });
  const results = await Promise.all(taskPromises);
  run.results.push(...results);
}

const stamp = run.timestamp.replace(/[:.]/g, '-');
const outPath = join(RUNS_DIR, `${stamp}-two-tier.json`);
writeFileSync(outPath, JSON.stringify(run, null, 2));
console.error(`\nWrote ${outPath}`);
console.error(`Total wallclock: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

// Summary
const summary = {};
for (const r of run.results) {
  if (!summary[r.pair]) summary[r.pair] = { pass: 0, total: 0, cost: 0 };
  summary[r.pair].total++;
  if (r.pass) summary[r.pair].pass++;
  summary[r.pair].cost += r.cost_usd || 0;
}
console.error('=== Two-tier summary ===');
for (const [k, v] of Object.entries(summary).sort()) {
  const pct = ((v.pass / v.total) * 100).toFixed(0);
  console.error(`  ${k.padEnd(45)}  ${v.pass}/${v.total}  (${pct}%)  ~$${v.cost.toFixed(4)}`);
}
