/**
 * Tunables for fair-play perception (LOS, sound cues, scan density).
 */
export const FAIR_PLAY = Object.freeze({
  LOS_ENTITY_RANGE: 48, // max entity detection range with LOS
  SNEAK_DETECT_RANGE: 8, // sneaking players only detected this close
  SOUND_MINE_RADIUS: 16, // mining sound radius
  SOUND_SPRINT_RADIUS: 8, // sprinting sound radius
  SOUND_WALK_RADIUS: 4, // walking sound radius
  SOUND_SNEAK_RADIUS: 1, // sneaking sound radius
  REACTION_MIN_MS: 100,
  REACTION_MAX_MS: 300,
  BLOCK_SCAN_RANGE: 16, // limited block scan (was 64 in find_blocks)
  // Extra virtual ray headings (no turning) so scene / memory see behind the bot.
  SCAN_YAW_PANS: 6,
  // mc collect + find_entities fair-play: physically turn, merge LOS hits.
  LOOK_SWEEP_HEADINGS: 5,
  LOOK_SETTLE_MS: 45,
  // Eye-height geometry. PHYSICAL_EYE_HEIGHT is a real player's eye (aim
  // points, head-above-water). The fair-play *sensor* eye is reduced by
  // FAIRPLAY_EYE_FACTOR (a parity nerf). FAIRPLAY_EYE_HEIGHT_DEFAULT is the
  // product for a default-height bot — a literal for sites that are not
  // entity-height-aware (see goto_near; fair-play charter asymmetry #1).
  PHYSICAL_EYE_HEIGHT: 1.62,
  FAIRPLAY_EYE_FACTOR: 0.85,
  FAIRPLAY_EYE_HEIGHT_DEFAULT: 1.377, // = PHYSICAL_EYE_HEIGHT * FAIRPLAY_EYE_FACTOR
});
