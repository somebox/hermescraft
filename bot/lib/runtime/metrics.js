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

function logDir() {
  return process.env.HERMESCRAFT_TMP || '/tmp/hermescraft';
}

function equipRecoveryLogPath() {
  return join(logDir(), 'mc-equip-recovery.jsonl');
}

/** @param {string} profile */
function navEventLogPath(profile) {
  const safe = String(profile || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(logDir(), `nav-${safe}.jsonl`);
}

const ensuredDirs = new Set();

async function ensureDir(path) {
  const d = dirname(path);
  if (ensuredDirs.has(d)) return;
  try {
    await mkdir(d, { recursive: true });
    ensuredDirs.add(d);
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
 * @param {Object<string, number>|null} [record.inv_snapshot]
 *   { item_name: count } for the bot's inventory at the moment of the event.
 *   Captured for `no_candidate` rows so the analyzer can decide whether the
 *   bot could have crafted the missing tool (comprehension gap) vs lacked
 *   the precursor materials (capability gap). May be null on capture failure.
 */
export function logEquipRecovery(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  // Fire-and-forget; ensure dir is best-effort.
  const path = equipRecoveryLogPath();
  ensureDir(path)
    .then(() => appendFile(path, line))
    .catch(() => { /* never block the dig path on logging */ });
}

/**
 * Append one sync-action nav telemetry row (v1 schema).
 *
 * @param {object} record
 * @param {string} record.profile
 * @param {string} record.actionName
 * @param {boolean} record.ok
 * @param {string} [record.error_code]
 * @param {string} [record.playbook_id]
 * @param {string} [record.phase]
 * @param {string} [record.sub_playbook_id]
 * @param {string} [record.sub_phase]
 * @param {string} [record.card_id]
 */
export function logNavEvent(record) {
  const line =
    JSON.stringify({
      schema_version: 1,
      ts: new Date().toISOString(),
      ...record,
    }) + '\n';
  const path = navEventLogPath(record.profile);
  ensureDir(path)
    .then(() => appendFile(path, line))
    .catch(() => { /* never block action path on logging */ });
}

export { navEventLogPath };
