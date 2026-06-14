/**
 * @param {object} deps
 */
export function createStop({ ensureBot, ctx }) {
  return async function stop() {
    const b = ensureBot();
    b.pathfinder.setGoal(null);
    try { b.stopDigging(); } catch {}
    if (b.pvp) try { b.pvp.stop(); } catch {}
    ctx.tasks.cancelRequested = true;
    // Harness calls stop between tests with no active task; leave flag clear so
    // the next sync action (e.g. collect) is not treated as mid-cancel.
    if (!ctx.tasks.currentTask) {
      ctx.tasks.cancelRequested = false;
    }
    return { ok: true, result: 'Stopped all actions.' };
  };
}
