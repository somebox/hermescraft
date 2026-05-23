/** Structured `[sail_to <phase>]` logging helpers for sail_to phases. */

export function createSailDiagnostics(bindings) {
  const { ensureBot, log, Vec3 } = bindings;

  const sailLog = (phase, ...kvs) => {
    const head = `[sail_to ${phase}]`;
    const body = kvs.join(' ');
    try { log(`${head} ${body}`); } catch { /* logger always available, defensive */ }
  };
  const fmtPos = (p) => p && Number.isFinite(p.x)
    ? `(${p.x.toFixed ? p.x.toFixed(1) : p.x},${p.y.toFixed ? p.y.toFixed(1) : p.y},${p.z.toFixed ? p.z.toFixed(1) : p.z})`
    : String(p);
  const blockName = (px, py, pz) => {
    try {
      const b = ensureBot();
      const blk = b.blockAt(new Vec3(Math.floor(px), Math.floor(py), Math.floor(pz)));
      return blk?.name || 'unknown';
    } catch { return 'unknown'; }
  };
  const fmtFootHead = (p) => p
    ? `foot=${blockName(p.x, p.y, p.z)} head=${blockName(p.x, p.y + 1, p.z)} below=${blockName(p.x, p.y - 1, p.z)}`
    : 'foot=? head=? below=?';

  return { sailLog, fmtPos, blockName, fmtFootHead };
}
