/**
 * mc advise — client-side perception bundle + OpenRouter digest (Python).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mc-advise-cli.py');

/**
 * Pure helper: build the Python subprocess argv. Exported for unit
 * testing — the I/O-bound spawn path is too fiddly to test directly.
 *
 * @param {{ reason: string, apiBase: string, dryRun?: boolean, model?: string, kind?: string, target?: {x:number,y:number,z:number} }} opts
 * @returns {string[]} argv (first element is the script path)
 */
export function buildAdviseArgs(opts) {
  const { reason, apiBase, dryRun, model, kind, target } = opts;
  const args = [CLI_SCRIPT, '--reason', reason, '--api-url', apiBase];
  if (dryRun) args.push('--dry-run');
  if (model) args.push('--model', model);
  if (kind) args.push('--kind', kind);
  if (target && Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z)) {
    // F17 (task #55): use `--target=...` (single arg) instead of
    // `--target` + separate value. When the value starts with `-`
    // (negative coords like -300,63,-100), Python's argparse can
    // misread the value as another flag and bail with "expected
    // one argument." The `=` form is unambiguous in argparse.
    args.push(`--target=${target.x},${target.y},${target.z}`);
  }
  return args;
}

/**
 * @param {{ reason: string, apiBase: string, dryRun?: boolean, model?: string, kind?: string, target?: {x:number,y:number,z:number} }} opts
 * @returns {Promise<Record<string, unknown>>}
 */
export function runAdviseCli(opts) {
  const { kind } = opts;
  const args = buildAdviseArgs(opts);
  const timeoutMs = (kind || 'advise') === 'advise' ? 25_000 : 90_000;

  return new Promise((resolve, reject) => {
    const py = process.env.MC_ADVISE_PYTHON || 'python3';
    const child = spawn(py, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: REPO_ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        command: kind || 'advise',
        error: `ADVISE_TIMEOUT after ${timeoutMs / 1000}s (shell cap)`,
        error_type: 'timeout',
      });
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          resolve(JSON.parse(trimmed));
          return;
        } catch {
          /* fall through */
        }
      }
      resolve({
        ok: false,
        command: kind || 'advise',
        error: stderr.trim() || `advise backend exited ${code}`,
        error_type: 'backend_error',
        details: { exit_code: code, stdout: trimmed.slice(0, 400) },
      });
    });
  });
}
