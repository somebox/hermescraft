import { ok } from '../../shared/action-contract.js';

export function createSocialHandlers(deps) {
  const { ctx, rememberSocialEvent } = deps;

  return {
    async complete_command({ index = 0, message }) {
      if (ctx.social.commandQueue.length === 0) return ok({ result: 'No commands in queue.' });
      const pending = ctx.social.commandQueue.filter(c => c.status === 'pending' || c.status === 'acknowledged');
      if (index >= pending.length) return ok({ result: 'No pending command at that index.' });
      const cmd = pending[index];
      cmd.status = 'completed';
      cmd.completed_at = Date.now();
      rememberSocialEvent({ actor: cmd.from, kind: 'completed_command', channel: cmd.channel || 'direct', message: cmd.command });
      const reply = message || `Done: "${cmd.command}"`;
      return ok({ result: reply });
    },

    async acknowledge_command({ index = 0, plan }) {
      const pending = ctx.social.commandQueue.filter(c => c.status === 'pending');
      if (pending.length === 0) return ok({ result: 'No pending commands to acknowledge.' });
      if (index >= pending.length) return ok({ result: 'No pending command at that index.' });
      const cmd = pending[index];
      cmd.status = 'acknowledged';
      cmd.acknowledged_at = Date.now();
      if (plan) cmd.plan = plan;
      rememberSocialEvent({ actor: cmd.from, kind: 'acknowledged_command', channel: cmd.channel || 'direct', message: cmd.command });
      return ok({ result: `Acknowledged: "${cmd.command}"${plan ? ` — plan: ${plan}` : ''}` });
    },

    async cancel_command({ index = 0, reason }) {
      const active = ctx.social.commandQueue.filter(c => c.status === 'pending' || c.status === 'acknowledged');
      if (active.length === 0) return ok({ result: 'No active commands to cancel.' });
      if (index >= active.length) return ok({ result: 'No command at that index.' });
      const cmd = active[index];
      cmd.status = 'cancelled';
      cmd.cancelled_at = Date.now();
      cmd.cancel_reason = reason || 'cancelled by bot';
      rememberSocialEvent({ actor: cmd.from, kind: 'cancelled_command', channel: cmd.channel || 'direct', message: cmd.command });
      return ok({ result: `Cancelled: "${cmd.command}"${reason ? ` — ${reason}` : ''}` });
    },
  };
}
