
import { ok, fail } from '../shared/action-contract.js';

/**
 * createRemindersActions — extracted from former lib/actions/containers.js (Phase 5 split).
 */
export function createRemindersActions(deps) {
  const { ctx, config, ensureBot, goals, fmt, posObj, sleep, log, loadLocations, saveLocations, flagMarkStale, clearMarkStale, resolveMarkPlaceFromBody, resolveContainerCoords, normalizeDepositWithdrawItems, buildMarksListApi, isContainerBlock, findNearbyContainer, snapshotChestAtPosition, rememberSocialEvent, saveReminders, getMyName } = deps;
  return {
    async remind({ note, interval_minutes, mark }) {
      const n = (note || '').trim();
      if (!n) return fail('INVALID_ARGS', 'remind needs a "note" string', { retry_safe: false });
      let mins = parseFloat(interval_minutes);
      if (!Number.isFinite(mins) || mins < 1) mins = 20;
      const id = ctx.reminders.remindersNextId++;
      const entry = { id, note: n, interval_ms: mins * 60000, created: Date.now(), last_fired: 0 };
      if (mark) entry.mark = String(mark).trim();
      ctx.reminders.reminders.push(entry);
      saveReminders();
      return ok({ result: `Reminder #${id} set: "${n}" every ${mins} min${entry.mark ? ` (mark: ${entry.mark})` : ''}`, id });
    },

    async list_reminders() {
      if (!ctx.reminders.reminders.length) return ok({ result: 'No reminders set.', reminders: [] });
      const lines = ctx.reminders.reminders.map(r => {
        const minAgo = Math.round((Date.now() - (r.last_fired || r.created)) / 60000);
        return `#${r.id}: "${r.note}" every ${Math.round(r.interval_ms / 60000)} min (${minAgo} min since last)${r.mark ? ` [mark: ${r.mark}]` : ''}`;
      });
      return ok({ result: lines.join('\n'), reminders: ctx.reminders.reminders });
    },

    async unremind({ id }) {
      const idx = ctx.reminders.reminders.findIndex(r => r.id === Number(id));
      if (idx === -1) return fail('NOT_FOUND', `No reminder with id ${id}`, { retry_safe: false });
      const removed = ctx.reminders.reminders.splice(idx, 1)[0];
      saveReminders();
      return ok({ result: `Removed reminder #${removed.id}: "${removed.note}"` });
    },
  };
}
