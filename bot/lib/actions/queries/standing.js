import { standingState } from '../_nav-helpers.js';

export function createStandingQueries({ ensureBot }) {
  return {
  /**
   * F50.1: Classify the bot's current standing state. Returns the
   * classification ({open, alley, corner, trapped, three_walled,
   * enclosure_inside, wedge, edge, in_air}), the blocked/open cardinal
   * directions, and supporting detail (head_blocked, foot_support,
   * ceiling_within, wedge_offset). Building block for F50.2-50.8 — used
   * both internally (to enrich movement errors and decide escape
   * strategy) and externally (`mc standing` lets the brain self-check
   * before issuing a goto / place that's likely to fail).
   */
  async standing() {
    const b = ensureBot();
    const s = standingState(b);
    if (s.error === 'no_bot') {
      return { ok: false, error: { code: 'NO_BOT', message: 'bot not ready', retry_safe: true } };
    }
    let standingOnNote = '';
    if (s.standing_on?.significant) {
      standingOnNote = s.standing_on.is_entity
        ? ` on_entity:${s.standing_on.entity_name}`
        : ` on:${s.standing_on.name}@${s.standing_on.coord.x},${s.standing_on.coord.y},${s.standing_on.coord.z}`;
    }
    const resultMsg = `${s.classification} at ${s.cell.x},${s.cell.y},${s.cell.z} — blocked: [${s.blocked_dirs.join(',') || '-'}] open: [${s.open_dirs.join(',') || '-'}]${s.cliff_dirs.length ? ` cliff: [${s.cliff_dirs.join(',')}]` : ''}${s.head_blocked ? ' head_blocked' : ''}${s.foot_support === false ? ' no_foot_support' : ''}${s.ceiling_within !== null ? ` ceiling_at_+${s.ceiling_within}` : ''}${standingOnNote}`;
    return { ok: true, data: s, result: resultMsg };
  },
  };
}
