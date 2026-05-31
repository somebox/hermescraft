import { ok, fail } from '../shared/action-contract.js';
import { clearPlaybookContext, setPlaybookContext } from '../runtime/playbook-context.js';

/**
 * Playbook phase context — mc playbook phase set|clear (telemetry on ctx.runtime).
 */
export function createPlaybookActions(services) {
  const { state: ctx } = services;

  return {
    async playbook_phase_set({
      playbook_id,
      phase,
      sub_playbook_id,
      sub_phase,
    }) {
      if (!playbook_id || !phase) {
        return fail('INVALID_VALUE', 'playbook_phase_set requires playbook_id and phase', { retry_safe: false });
      }
      const r = setPlaybookContext(ctx, {
        playbook_id: String(playbook_id),
        phase: String(phase),
        ...(sub_playbook_id ? { sub_playbook_id: String(sub_playbook_id) } : {}),
        ...(sub_phase ? { sub_phase: String(sub_phase) } : {}),
      });
      if (!r.ok) {
        return fail(r.code, r.message, { retry_safe: false });
      }
      return ok({ data: r.data, result: `playbook ${playbook_id} phase ${phase}` });
    },

    async playbook_phase_clear() {
      clearPlaybookContext(ctx);
      return ok({ result: 'playbook context cleared' });
    },
  };
}
