/** _sailToImpl: preflight → plan → execution (Phase 4a split). */

import { createSailDiagnostics } from './sail-diagnostics.js';
import { runSailPreflight } from './preflight.js';
import { runSailPlanRoute } from './plan.js';
import { runSailExecution } from './mount-safety.js';

/**
 * Mirrors legacy createWaterActions closure: binds every `_sailToImpl` free
 * variable from water/index.js.
 */
export function createSailToImpl(bindings) {
  const diag = createSailDiagnostics(bindings);

  return async function _sailToImpl({ x, y, z }) {
    const preflight = runSailPreflight(bindings, diag, { x, y, z });
    if (preflight.done) return preflight.result;

    const plan = await runSailPlanRoute(bindings, diag, preflight.state);
    if (plan.done) return plan.result;

    return runSailExecution(bindings, diag, preflight.state, plan);
  };
}
