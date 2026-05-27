import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseArgv, isPiped } from './util.mjs';
import { DATA_DIR, REPO_ROOT } from '../lib/paths.mjs';
import { listScenarioFiles, loadScenario } from '../lib/scenario.mjs';
import { TEMPLATES, hasTodoMarkers } from '../lib/templates.mjs';

const DRAFTS = join(DATA_DIR, '_drafts');
const ARCHIVE = join(DATA_DIR, '_archive');
const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(__dirname, '..', 'verify-fixtures.mjs');

export function runScenario(argv) {
  const { positional, flags, opts } = parseArgv(argv);
  const sub = positional[0];
  if (sub === 'new') {
    const id = positional[1];
    const template = opts.template || 'bare';
    const profile = opts.profile || 'prompts/landfolk/flint.md';
    if (!id) {
      console.error('Usage: context-tuner scenario new <id> --template=... [--profile=...]');
      process.exit(1);
    }
    const fn = TEMPLATES[template];
    if (!fn) {
      console.error(`Unknown template: ${template}`);
      process.exit(1);
    }
    mkdirSync(DRAFTS, { recursive: true });
    const path = join(DRAFTS, `${id}.yaml`);
    writeFileSync(path, fn(id, profile));
    console.log(path);
    console.error('next: edit file, then context-tuner scenario validate ' + id);
    return;
  }
  if (sub === 'list') {
    const files = listScenarioFiles({ includeDrafts: true });
    const ids = files.map((f) => loadScenario(f).raw.id);
    if (isPiped() || flags.has('json')) {
      if (opts.json || flags.has('json')) console.log(JSON.stringify(ids));
      else for (const id of ids) console.log(id);
      return;
    }
    for (const id of ids) console.log(id);
    return;
  }
  if (sub === 'show') {
    const id = positional[1];
    const path = findScenarioPath(id);
    if (!path) process.exit(1);
    process.stdout.write(readFileSync(path, 'utf8'));
    return;
  }
  if (sub === 'validate') {
    const id = positional[0];
    if (id === '--all' || flags.has('all')) {
      const r = spawnSync('node', [VERIFY], { cwd: REPO_ROOT, encoding: 'utf8' });
      if (r.stdout) process.stderr.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.status !== 0) process.exit(2);
      for (const f of listScenarioFiles({ includeDrafts: true })) {
        const text = readFileSync(f, 'utf8');
        if (hasTodoMarkers(text)) {
          console.error(`TODO markers remain: ${f}`);
          process.exit(2);
        }
      }
      console.error('validate: OK (fixtures + no TODO)');
      return;
    }
    const path = findScenarioPath(id);
    if (!path) process.exit(1);
    const text = readFileSync(path, 'utf8');
    if (hasTodoMarkers(text)) {
      console.error('TODO markers remain');
      process.exit(2);
    }
    const r = spawnSync('node', [VERIFY], { cwd: REPO_ROOT });
    process.exit(r.status === 0 ? 0 : 2);
  }
  if (sub === 'archive') {
    const id = positional[1];
    const path = findScenarioPath(id);
    if (!path) process.exit(1);
    mkdirSync(ARCHIVE, { recursive: true });
    renameSync(path, join(ARCHIVE, `${id}.yaml`));
    console.error(`archived ${id}`);
    return;
  }
  printScenarioHelp();
  process.exit(1);
}

function findScenarioPath(id) {
  for (const f of listScenarioFiles({ includeDrafts: true })) {
    try {
      if (loadScenario(f).raw.id === id) return f;
    } catch {
      /* skip */
    }
  }
  console.error(`Scenario not found: ${id}`);
  return null;
}

function printScenarioHelp() {
  console.error(`scenario new <id> --template=error-recovery|policy-rule|stuck-escalation|bare
scenario list|show|validate [<id>|--all]|archive <id>`);
}
