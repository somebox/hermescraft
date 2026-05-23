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
    return { ok: true, result: 'Stopped all actions.' };
  };
}
