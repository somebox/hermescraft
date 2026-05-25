/**
 * Build-info — what commit is this bot process running?
 *
 * Two sources, both optional, both surfaced in /health:
 *
 * 1. Spawn-time env vars (BUILD_COMMIT, BUILD_BRANCH, BUILD_DIRTY) — captured
 *    by landfolk-control.sh at the moment the bot was launched. Tells you
 *    EXACTLY what was on disk when the process started.
 *
 * 2. Current disk state, computed lazily on each /health call (cached for
 *    30s to avoid hammering git). Tells you what's on disk RIGHT NOW.
 *
 * Drift = spawn commit != disk commit (or spawn-clean → now-dirty). Drift
 * means: the source has changed since this bot started, and the running
 * process is serving stale behavior. Restart to pick up the new code.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SPAWN = {
  commit: (process.env.BUILD_COMMIT || '').trim() || null,
  branch: (process.env.BUILD_BRANCH || '').trim() || null,
  dirty: process.env.BUILD_DIRTY === '1' || process.env.BUILD_DIRTY === 'true' || null,
  capturedAt: (process.env.BUILD_CAPTURED_AT || '').trim() || null,
};

let _diskCache = { value: null, fetchedAt: 0 };
const DISK_CACHE_MS = 30_000;

function gitRead(args, fallback = null) {
  try {
    const out = execFileSync('git', args, { cwd: REPO_ROOT, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString('utf8').trim() || fallback;
  } catch {
    return fallback;
  }
}

function readDiskBuildInfo() {
  const now = Date.now();
  if (_diskCache.value && now - _diskCache.fetchedAt < DISK_CACHE_MS) {
    return _diskCache.value;
  }
  const commit = gitRead(['rev-parse', 'HEAD']);
  const branch = gitRead(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirtyCount = gitRead(['status', '--porcelain', '-uno']);
  // -uno: ignore untracked files; a dirty tracked file is what we care
  // about for "is the running code current?"
  const dirty = dirtyCount !== null ? dirtyCount.length > 0 : null;
  const value = commit ? { commit, branch, dirty } : null;
  _diskCache = { value, fetchedAt: now };
  return value;
}

/**
 * Returns:
 *   {
 *     spawn:        { commit, branch, dirty, capturedAt } | null,
 *     disk:         { commit, branch, dirty }            | null,
 *     drift:        boolean,                              // true if disk != spawn
 *     drift_reason: string | null,
 *   }
 *
 * Either side may be null if unavailable (env not exported, or `git` missing
 * / not in a repo). /health should tolerate either.
 */
export function getBuildInfo() {
  const spawn = SPAWN.commit ? SPAWN : null;
  const disk = readDiskBuildInfo();

  let drift = false;
  let driftReason = null;
  if (spawn && disk) {
    if (spawn.commit !== disk.commit) {
      drift = true;
      driftReason = `disk HEAD (${disk.commit.slice(0, 7)}) differs from spawn (${spawn.commit.slice(0, 7)})`;
    } else if (!spawn.dirty && disk.dirty) {
      drift = true;
      driftReason = 'disk is dirty but spawn was clean';
    }
  }

  return {
    spawn,
    disk,
    drift,
    drift_reason: driftReason,
  };
}
