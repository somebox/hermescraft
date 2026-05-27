import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readYamlFile } from './yaml.mjs';
import { DATA_DIR, REPO_ROOT } from './paths.mjs';

export function sha256File(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return 'sha256:' + h.digest('hex').slice(0, 16);
}

export function listScenarioFiles({ includeDrafts = false } = {}) {
  const files = [];
  for (const name of readdirSync(DATA_DIR)) {
    if (!name.endsWith('.yaml') || name.startsWith('_')) continue;
    if (name === 'profile-skills.yaml') continue;
    files.push(join(DATA_DIR, name));
  }
  if (includeDrafts) {
    const drafts = join(DATA_DIR, '_drafts');
    if (existsSync(drafts)) {
      for (const name of readdirSync(drafts)) {
        if (name.endsWith('.yaml')) files.push(join(drafts, name));
      }
    }
  }
  return files.sort();
}

export function loadScenario(filePath) {
  const raw = readYamlFile(filePath);
  const sv = raw.schema_version ?? 1;
  if (sv !== 1 && sv !== 2) {
    throw new Error(`${filePath}: unsupported schema_version ${raw.schema_version}`);
  }
  return { filePath, raw, schema_version: sv };
}

/** @returns {import('./yaml.mjs').unknown[]} */
export function scenarioPatterns(raw) {
  return raw.patterns || [];
}

/** @returns {import('./yaml.mjs').unknown[]} */
export function scenarioExpectations(raw) {
  return raw.expectations || [];
}

/** `mc` (default) or `shell` for orchestrator output */
export function scenarioGradingSurface(raw) {
  if (raw.grading_surface === 'shell' || raw.grading_surface === 'mc') return raw.grading_surface;
  if (raw.profile_family === 'orchestrator') return 'shell';
  return 'mc';
}

/** Matcher block: v2 `matchers` or v1 `expect.tool_calls` / `expect.shell_commands` */
export function scenarioMatcherExpect(raw) {
  if (raw.matchers) {
    return { tool_calls: raw.matchers, chat_contains_any: raw.chat_contains_any, chat_contains_regex: raw.chat_contains_regex };
  }
  return raw.expect || {};
}

export function modelFamily(id) {
  if (!id || typeof id !== 'string') return 'unknown';
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(0, slash) : id.split('-')[0];
}

export function skillPaths(scenario) {
  const skills = scenario.skills || [];
  const out = [];
  for (const s of skills) {
    if (typeof s === 'string') out.push(resolve(REPO_ROOT, s));
    else if (s?.path) out.push(resolve(REPO_ROOT, s.path));
  }
  return out;
}

export function resolveScenarioPaths(scenario, promptOverrides, skillOverrides) {
  const profileRel = scenario.profile;
  let profilePath = resolve(REPO_ROOT, profileRel);
  if (promptOverrides?.has(profileRel)) profilePath = promptOverrides.get(profileRel);
  const observePath = scenario.observe ? resolve(REPO_ROOT, scenario.observe) : null;
  let memoryPath = null;
  let memoryInline = null;
  if (scenario.memory?.mode === 'fixture' && scenario.memory.path) {
    memoryPath = resolve(REPO_ROOT, scenario.memory.path);
  } else if (scenario.memory?.mode === 'inline') {
    memoryInline = scenario.memory.content || '';
  }
  let skillPathsResolved = skillPaths(scenario);
  if (skillOverrides?.size) {
    skillPathsResolved = skillPathsResolved.map((abs) => {
      for (const [from, to] of skillOverrides) {
        const fromAbs = resolve(REPO_ROOT, from);
        if (abs === fromAbs) return to;
      }
      return abs;
    });
  }
  return { profilePath, observePath, skillPaths: skillPathsResolved, memoryPath, memoryInline };
}

export function defaultRuns(contractLevel) {
  if (contractLevel === 'hard') return 5;
  if (contractLevel === 'soft') return 3;
  return 1;
}

export function filterScenarios(scenarios, suite) {
  if (!suite || suite.scenarios === 'all') return scenarios;
  if (Array.isArray(suite.scenarios)) {
    const ids = new Set(suite.scenarios);
    return scenarios.filter((s) => ids.has(s.raw.id));
  }
  if (suite.scenarios?.categories) {
    const cats = new Set(suite.scenarios.categories);
    return scenarios.filter((s) => cats.has(s.raw.category));
  }
  if (suite.scenarios?.contract_levels) {
    const levels = new Set(suite.scenarios.contract_levels);
    return scenarios.filter((s) => levels.has(s.raw.contract_level));
  }
  return scenarios;
}

/** Dot-path exists in object */
export function hasObservationField(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}
