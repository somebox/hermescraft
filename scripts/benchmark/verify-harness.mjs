#!/usr/bin/env node
/**
 * Offline gate: every gold `mc …` line in tasks/*.json must parse via the same
 * logic as the bot CLI (`cli-simulate.mjs`). Run before spending on OpenRouter.
 *
 * Usage: node scripts/benchmark/verify-harness.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { simulateMcLine } from './cli-simulate.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)));
const TASKS_DIR = join(HERE, 'tasks');

/** Push composition-style rubric lines (handles OR-groups). */
function pushCompositionGold(lines, obj) {
  const groups = /** @type {unknown} */ (obj.correct_line_groups);
  const required = /** @type {unknown} */ (obj.correct_lines_required);
  if (Array.isArray(groups) && groups.length) {
    for (const g of groups) {
      if (Array.isArray(g)) lines.push(...g);
    }
  } else if (Array.isArray(required)) {
    lines.push(...required);
  }
}

/** @param {Record<string, unknown>} task */
function collectGoldLines(task) {
  /** @type {string[]} */
  const lines = [];
  const ch = /** @type {Record<string, unknown>|undefined} */ (task.challenge);
  if (Array.isArray(task.correct)) lines.push(...task.correct);
  pushCompositionGold(lines, task);
  if (ch && Array.isArray(ch.correct)) lines.push(...ch.correct);
  if (ch) pushCompositionGold(lines, ch);
  return lines;
}

let bad = 0;
const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json'));

for (const f of files.sort()) {
  const group = f.replace(/\.json$/, '');
  const tasks = JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf8'));
  for (const task of tasks) {
    const id = task.id;
    for (const line of collectGoldLines(task)) {
      const sim = simulateMcLine(line);
      if (!sim.parse_ok) {
        bad++;
        console.error(`FAIL  ${group}/${id}\n  line: ${line}\n  → ${sim.parse_error || 'parse_ok=false'}`);
      }
    }
  }
}

if (bad) {
  console.error(`\nverify-harness: ${bad} gold line(s) do not parse — fix tasks or registry before benchmarking.`);
  process.exit(1);
}

console.error(`verify-harness OK — all gold lines parse (${files.length} task files).`);
