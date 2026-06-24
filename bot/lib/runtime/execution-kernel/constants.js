/** Default pacing between bulk motor units (ms). */
export const INTER_CELL_MS = {
  remove: 80,
  add: 180,
};

/**
 * @param {'remove'|'add'} [mode]
 * @returns {number}
 */
export function interCellMsForMode(mode) {
  return mode === 'add' ? INTER_CELL_MS.add : INTER_CELL_MS.remove;
}

/** @returns {boolean} */
export function isExecKernelEnabled() {
  const on = (v) => v === '1' || v === 'true';
  return on(process.env.HERMES_EXEC_KERNEL)
    || on(process.env.HERMES_BULK_MOTOR);
}

/** @returns {boolean} */
export function motorJitterEnabled() {
  return process.env.HERMES_MOTOR_JITTER === '1' || process.env.HERMES_MOTOR_JITTER === 'true';
}

/**
 * @param {number} baseMs
 * @param {number} [seed]
 */
export function applyMotorJitter(baseMs, seed = 0) {
  if (!motorJitterEnabled() || baseMs <= 0) return baseMs;
  const jitter = (Math.abs(seed) % 41) - 20;
  return Math.max(0, baseMs + jitter);
}
