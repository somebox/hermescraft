import { existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgv } from './util.mjs';
import { REPO_ROOT, DATA_DIR, RUNS_DIR, CONFIGS_DIR } from '../lib/paths.mjs';
import { defaultConfigPath, loadConfig } from '../lib/config.mjs';

export function runDoctor(argv) {
  const { flags, opts } = parseArgv(argv);
  const checks = [];
  let ok = true;

  function add(name, pass, detail) {
    checks.push({ name, ok: pass, detail });
    if (!pass) ok = false;
  }

  let key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    const sec = join(REPO_ROOT, 'secrets.yaml');
    if (existsSync(sec)) {
      const m = readFileSync(sec, 'utf8').match(/openrouter_api_key:\s*(\S+)/);
      if (m) key = m[1].trim();
    }
  }
  add('openrouter_api_key', !!key, key ? 'set' : 'missing');

  add('data/context-tests', existsSync(DATA_DIR), DATA_DIR);
  try {
    accessSync(RUNS_DIR, constants.W_OK);
    add('runs writable', true, RUNS_DIR);
  } catch {
    add('runs writable', false, RUNS_DIR);
  }

  try {
    const { resolved } = loadConfig(defaultConfigPath());
    add('default config', true, defaultConfigPath());
    add(
      'judge conventions',
      resolved.judge?.context_mode === 'mc_conventions',
      String(resolved.judge?.context_mode),
    );
    add(
      'judge not same as subject',
      resolved.judge?.model !== resolved.models?.[0],
      `${resolved.models?.[0]} vs ${resolved.judge?.model}`,
    );
  } catch (e) {
    add('default config', false, e.message);
  }

  if (flags.has('json') || opts.json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.ok ? 'ok' : 'FAIL'}\t${c.name}\t${c.detail || ''}`);
    }
  }
  process.exit(ok ? 0 : 1);
}
