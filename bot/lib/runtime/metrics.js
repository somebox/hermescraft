/**
 * Lightweight per-bot metrics logging via JSONL append.
 *
 * Currently exposes:
 *   logEquipRecovery(record) — append one record to mc-equip-recovery.jsonl
 *
 * The append is async + fire-and-forget. We NEVER block the dig path on
 * logging — if the FS is full or the dir doesn't exist, the metric is
 * dropped silently. This is a counter for "did the recovery fire / did it
 * save the dig", not load-bearing telemetry.
 *
 * Records are read by scripts/analyze-equip-recovery.py.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const LOG_DIR = process.env.HERMESCRAFT_TMP || '/tmp/hermescraft';
const EQUIP_RECOVERY_LOG = join(LOG_DIR, 'mc-equip-recovery.jsonl');

let dirEnsured = false;

async function ensureDir(path) {
  if (dirEnsured) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    dirEnsured = true;
  } catch {
    /* ignore — appendFile will surface a clearer error if dir truly missing */
  }
}

/**
 * Log one equip-recovery event.
 *
 * @param {object} record
 * @param {string}  record.bot         — bot username (Flint/Mason/Steward/etc.)
 * @param {string}  record.block       — block name being dug (cobblestone, oak_log, …)
 * @param {string}  record.category    — "axe" | "pick" | "shovel" | "other"
 * @param {string}  record.result      — "saved" | "still_slow" | "no_candidate"
 *                                       — saved: re-equip brought ticks under cap, dig proceeds
 *                                       — still_slow: re-equip happened but tool tier insufficient
 *                                       — no_candidate: no tool of needed category in inventory
 * @param {string}  [record.before_held]   held name BEFORE recovery (often "empty hand" / "air")
 * @param {string}  [record.after_held]    held name AFTER  recovery (the candidate's name)
 * @param {number}  [record.before_ticks]  estimated dig ticks with original held
 * @param {number}  [record.after_ticks]   estimated dig ticks with re-equipped tool
 * @param {number}  [record.max_ticks]     the slow-dig cap that triggered the recovery
 */
export function logEquipRecovery(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  // Fire-and-forget; ensure dir is best-effort.
  ensureDir(EQUIP_RECOVERY_LOG)
    .then(() => appendFile(EQUIP_RECOVERY_LOG, line))
    .catch(() => { /* never block the dig path on logging */ });
}
