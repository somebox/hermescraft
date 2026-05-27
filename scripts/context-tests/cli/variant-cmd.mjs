import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { parseArgv } from './util.mjs';
import { REPO_ROOT, CONFIGS_DIR, DATA_DIR } from '../lib/paths.mjs';
import { loadScenario } from '../lib/scenario.mjs';
import { readYamlFile } from '../lib/yaml.mjs';
import { listScenarioFiles } from '../lib/scenario.mjs';

export function runVariant(argv) {
  const { positional, flags, opts } = parseArgv(argv);
  const sub = positional[0];
  if (sub === 'new') {
    const scenarioId = positional[1];
    const label = positional[2];
    if (!scenarioId || !label) {
      console.error('Usage: context-tuner variant new <scenario> <label> [--override path | --profile -]');
      process.exit(1);
    }
    const scPath = findScenarioPath(scenarioId);
    const { raw } = loadScenario(scPath);
    let overrideFrom = opts.override || raw.profile;
    let body = null;
    if (flags.has('profile-stdin') || opts.profile === '-' || flags.has('profile')) {
      body = readFileSync(0, 'utf8');
    }
    const expName = `prompts/experiments/${basename(overrideFrom).replace('.md', '')}-${label}.md`;
    const expAbs = join(REPO_ROOT, expName);
    mkdirSync(dirname(expAbs), { recursive: true });
    if (body != null) {
      writeFileSync(expAbs, body);
    } else if (existsSync(join(REPO_ROOT, overrideFrom))) {
      const src = readFileSync(join(REPO_ROOT, overrideFrom), 'utf8');
      writeFileSync(
        expAbs,
        `<!-- EXPERIMENT TODO: ${label} — edit hotspot for scenario ${scenarioId} -->\n${src}`,
      );
    } else {
      console.error(`Source not found: ${overrideFrom}`);
      process.exit(1);
    }
    const cfgPath = join(CONFIGS_DIR, 'experiments', `${label}.yaml`);
    const suitePreset = opts.suite || 'recovery-hints';
    const yaml = `inherits: ../default.yaml
label: ${label}
suite:
  preset: ${suitePreset}
overrides:
  prompts:
    "${overrideFrom}": "${expName}"
`;
    writeFileSync(cfgPath, yaml);
    console.log(cfgPath);
    console.error(`edit ${expName} then: context-tuner run ${cfgPath} --yes`);
    return;
  }
  if (sub === 'list') {
    const scenarioId = positional[1];
    const dir = join(CONFIGS_DIR, 'experiments');
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.yaml')) continue;
      const c = readYamlFile(join(dir, name));
      console.log(c.label || name.replace('.yaml', ''));
    }
    return;
  }
  console.error('variant new <scenario> <label> [--override path] [--profile -]');
  process.exit(1);
}

function findScenarioPath(id) {
  for (const f of listScenarioFiles({ includeDrafts: true })) {
    if (loadScenario(f).raw.id === id) return f;
  }
  console.error(`Scenario not found: ${id}`);
  process.exit(1);
}
