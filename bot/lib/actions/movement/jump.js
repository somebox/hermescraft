/**
 * F32 (task #66, v45): `mc jump` — brief jump primitive.
 *
 * @param {object} deps
 */
export function createJump({ ensureBot, posObj }) {
  return async function jump({ hold_ms } = {}) {
    const b = ensureBot();
    const holdMs = Math.max(100, Math.min(2000, parseInt(String(hold_ms ?? 400), 10) || 400));
    const before = posObj();
    try {
      b.setControlState('jump', true);
      await new Promise((r) => setTimeout(r, holdMs));
    } finally {
      try { b.setControlState('jump', false); } catch {}
    }
    const after = posObj();
    const dy = Math.round((after.y - before.y) * 10) / 10;
    return {
      ok: true,
      command: 'jump',
      data: { before, after, dy },
      result: `Jumped${dy > 0 ? ` (Δy=+${dy})` : dy < 0 ? ` (Δy=${dy}, ended lower — probably fell)` : ' (no vertical change)'}.`,
    };
  };
}
