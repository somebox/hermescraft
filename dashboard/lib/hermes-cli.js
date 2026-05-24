import { spawn } from 'child_process';

/**
 * Run `hermes` CLI (must be on PATH). Used for kanban when bridge is down.
 * @param {string[]} args
 * @param {number} [timeoutMs]
 */
export function runHermesCli(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('hermes', args, { env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`hermes ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(stderr.trim() || stdout.trim() || `hermes exit ${code}`));
    });
  });
}
