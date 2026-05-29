/**
 * Optional one-shot mc retrace when goto/move stalls upward (HERMES_NAV_AUTO_RETRACE).
 */

/**
 * @param {object} opts
 * @param {Record<string, any>} opts.ctx
 * @param {{ behaviors?: { navAutoRetraceOnStall?: boolean } }} [opts.config]
 * @param {number} opts.targetY
 * @param {number} opts.currentY
 * @param {() => Promise<any>} opts.retrace
 */
export async function maybeAutoRetraceOnStall({ ctx, config, targetY, currentY, retrace }) {
  if (!config?.behaviors?.navAutoRetraceOnStall) return null;
  if (targetY - currentY <= 0) return null;
  const steps = ctx?.runtime?.lastDugSteps?.steps;
  if (!Array.isArray(steps) || steps.length < 2) return null;
  const prior = ctx.runtime.navAttempt || {};
  if (prior.retraceTried) return null;
  ctx.runtime.navAttempt = { retraceTried: true, ts: Date.now() };
  try {
    return await retrace();
  } catch {
    return null;
  }
}
