/**
 * mc feedback — tooling-friction capture (proc-nav-1781014144 cross-cutting).
 *
 * Workers log one-liners when a tool fights them ("reachable said yes but
 * goto failed"). Lines append to data/runtime/feedback-<username>.jsonl;
 * the trial runner collects them by run_id into the postmortem dir.
 */
import fs from 'fs';
import path from 'path';

import { ok, fail } from '../shared/action-contract.js';

export function createFeedbackActions(services) {
  const { state: ctx, config } = services;

  function feedbackPath() {
    const dataDir = ctx.runtime?.dataDir;
    if (!dataDir) return null;
    const username = String(config?.mc?.username || ctx.world?.bot?.username || 'unknown').toLowerCase();
    return path.join(dataDir, 'runtime', `feedback-${username}.jsonl`);
  }

  return {
    async feedback({ note, tag } = {}) {
      const n = (note || '').trim();
      if (!n) {
        return fail('INVALID_ARGS', 'feedback needs a "note" string — one line describing the tooling friction', { retry_safe: false });
      }
      const filePath = feedbackPath();
      if (!filePath) {
        return fail('NOT_READY', 'feedback store unavailable (no data dir configured)', { retry_safe: true });
      }
      const p = ctx.world?.bot?.entity?.position;
      const entry = {
        ts: new Date().toISOString(),
        bot: config?.mc?.username || ctx.world?.bot?.username || null,
        note: n,
        tag: tag ? String(tag).trim() : null,
        run_id: process.env.RUN_ID || null,
        position: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null,
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
      return ok({ result: `Feedback logged${entry.tag ? ` [${entry.tag}]` : ''}: "${n}"`, file: filePath });
    },
  };
}
