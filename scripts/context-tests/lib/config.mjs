import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readYamlFile } from './yaml.mjs';
import { CONFIGS_DIR } from './paths.mjs';

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return { ...base };
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === 'object' &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(configPath) {
  const abs = resolve(configPath);
  let raw = readYamlFile(abs);
  const chain = [abs];
  if (raw.inherits) {
    const parentAbs = resolve(dirname(abs), raw.inherits);
    if (!existsSync(parentAbs)) throw new Error(`inherits not found: ${parentAbs}`);
    const parentLoaded = loadConfig(parentAbs);
    raw = deepMerge(parentLoaded.resolved, { ...raw, inherits: undefined });
    chain.unshift(...parentLoaded.chain);
  }
  return { path: abs, resolved: raw, chain };
}

export function defaultConfigPath() {
  return join(CONFIGS_DIR, 'default.yaml');
}

/** Resolve prompt path overrides: map repo-relative paths to absolute */
export function resolvePromptOverrides(overrides, repoRoot) {
  if (!overrides?.prompts) return new Map();
  const m = new Map();
  for (const [from, to] of Object.entries(overrides.prompts)) {
    m.set(from, resolve(repoRoot, to));
  }
  return m;
}
