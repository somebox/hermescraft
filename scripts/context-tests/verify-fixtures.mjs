#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listScenarioFiles, loadScenario, hasObservationField, scenarioGradingSurface } from './lib/scenario.mjs';
import { REPO_ROOT, DATA_DIR } from './lib/paths.mjs';
import { CLI_ONLY } from './grading.mjs';

const violations = [];

function checkScenario(filePath) {
  const { raw } = loadScenario(filePath);
  if (raw.profile && !existsSync(resolve(REPO_ROOT, raw.profile))) {
    violations.push(`${filePath}: missing profile ${raw.profile}`);
  }
  for (const s of raw.skills || []) {
    const p = typeof s === 'string' ? s : s.path;
    if (p && !existsSync(resolve(REPO_ROOT, p))) violations.push(`${filePath}: missing skill ${p}`);
  }
  if (raw.observe) {
    const op = resolve(REPO_ROOT, raw.observe);
    if (!existsSync(op)) violations.push(`${filePath}: missing observe ${raw.observe}`);
    else {
      let obs;
      try {
        obs = JSON.parse(readFileSync(op, 'utf8'));
      } catch (e) {
        violations.push(`${filePath}: observe JSON invalid: ${e.message}`);
        obs = null;
      }
      for (const field of raw.requires_observation_field || []) {
        if (obs && !hasObservationField(obs, field)) {
          violations.push(`${filePath}: observe missing field ${field}`);
        }
      }
    }
  }
  if (raw.memory?.mode === 'fixture' && raw.memory.path) {
    if (!existsSync(resolve(REPO_ROOT, raw.memory.path))) {
      violations.push(`${filePath}: missing memory fixture ${raw.memory.path}`);
    }
  }
  for (const rule of raw.expect?.tool_calls?.arg_regex_fallback || []) {
    if (rule.verb && !CLI_ONLY.has(rule.verb)) {
      violations.push(`${filePath}: arg_regex_fallback only for CLI-only verbs, got ${rule.verb}`);
    }
  }
  const surface = scenarioGradingSurface(raw);
  const hasMcMatchers = raw.expect?.tool_calls || raw.matchers;
  const hasShellMatchers = raw.expect?.shell_commands && Object.keys(raw.expect.shell_commands).length > 0;
  const hasPatterns = (raw.patterns || []).length > 0;
  const hasExpectations = (raw.expectations || []).length > 0;
  if (surface === 'shell') {
    if (!hasShellMatchers && !hasExpectations) {
      violations.push(`${filePath}: shell surface needs expect.shell_commands and/or expectations`);
    }
    if (hasPatterns) {
      violations.push(`${filePath}: patterns apply to mc surface only; remove or set grading_surface: mc`);
    }
  } else if (!hasMcMatchers && !hasPatterns && !hasExpectations) {
    violations.push(`${filePath}: need at least one grading track (matchers, patterns, or expectations)`);
  }
}

for (const f of listScenarioFiles()) checkScenario(f);

if (violations.length) {
  console.error('verify-fixtures failed:');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.error(`verify-fixtures: ${listScenarioFiles().length} scenarios OK`);
