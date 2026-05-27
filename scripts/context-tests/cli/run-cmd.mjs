import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseArgv } from './util.mjs';
import { REPO_ROOT, DATA_DIR, CONFIGS_DIR } from '../lib/paths.mjs';
import { listScenarioFiles, loadScenario } from '../lib/scenario.mjs';
import { defaultConfigPath } from '../lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_MJS = join(__dirname, '..', 'run.mjs');

export function runRunCmd(argv) {
  const { positional, flags, opts } = parseArgv(argv);
  const target = positional[0];
  if (!target) {
    console.error('Usage: context-tuner run <scenario|suite|config> [--config experiment.yaml] [--runs=N] [--yes] [-q]');
    process.exit(1);
  }
  const args = [RUN_MJS];
  let configPath = defaultConfigPath();
  let suiteFile = null;

  const absTarget = isAbsolute(target) ? target : resolve(REPO_ROOT, target);

  if (target.endsWith('.yaml') && existsSync(absTarget)) {
    if (absTarget.includes(`${join('configs', 'experiments')}`) || absTarget.includes('experiments')) {
      configPath = absTarget;
    } else if (absTarget.includes(`${join('data', 'context-tests', 'suites')}`)) {
      suiteFile = absTarget;
    } else {
      configPath = absTarget;
    }
  } else {
    const sp = join(DATA_DIR, 'suites', `${target}.yaml`);
    if (existsSync(sp)) {
      suiteFile = sp;
    } else {
      const found = listScenarioFiles({ includeDrafts: true }).find((f) => {
        try {
          return loadScenario(f).raw.id === target;
        } catch {
          return false;
        }
      });
      if (found) {
        if (opts.config) {
          const extra = isAbsolute(opts.config) ? opts.config : resolve(REPO_ROOT, opts.config);
          if (existsSync(extra)) configPath = extra;
        }
        args.push('--config', configPath);
        args.push('--scenario-id', target);
        forwardFlags(args, flags, opts);
        return spawnRun(args, flags);
      }
      console.error(`Unknown target: ${target}`);
      process.exit(1);
    }
  }

  if (opts.config) {
    const extra = isAbsolute(opts.config) ? opts.config : resolve(REPO_ROOT, opts.config);
    if (existsSync(extra)) configPath = extra;
  }

  args.push('--config', configPath);
  if (suiteFile) args.push('--suite-file', suiteFile);
  forwardFlags(args, flags, opts);
  return spawnRun(args, flags);
}

function forwardFlags(args, flags, opts) {
  if (flags.has('quiet') || flags.has('q')) args.push('-q');
  if (flags.has('yes')) args.push('--yes');
  if (flags.has('no-judge')) args.push('--no-judge');
  if (opts.runs) args.push('--runs-override', opts.runs);
}

function spawnRun(args, flags) {
  const r = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}
