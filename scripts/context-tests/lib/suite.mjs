import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readYamlFile } from './yaml.mjs';
import { DATA_DIR } from './paths.mjs';

const SUITES_DIR = join(DATA_DIR, 'suites');

export function listSuiteFiles() {
  if (!existsSync(SUITES_DIR)) return [];
  return readdirSync(SUITES_DIR)
    .filter((n) => n.endsWith('.yaml'))
    .map((n) => join(SUITES_DIR, n))
    .sort();
}

export function loadSuiteFile(filePath) {
  const raw = readYamlFile(filePath);
  const id = raw.id || filePath.replace(/\.yaml$/, '').split('/').pop();
  const scenarios = raw.scenarios || [];
  return { filePath, id, scenarios };
}

export function loadSuitePreset(preset) {
  const path = join(SUITES_DIR, `${preset}.yaml`);
  if (!existsSync(path)) throw new Error(`Suite preset not found: ${preset}`);
  return loadSuiteFile(path);
}

/** Normalize config.suite into filter shape for filterScenarios */
export function resolveSuiteFromConfig(suiteCfg) {
  if (!suiteCfg) return { scenarios: 'all' };
  if (suiteCfg.preset) {
    const s = loadSuitePreset(suiteCfg.preset);
    return { scenarios: s.scenarios };
  }
  if (suiteCfg.scenarios) return suiteCfg;
  return suiteCfg;
}
