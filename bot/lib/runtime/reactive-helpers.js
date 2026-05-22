/**
 * Pure helpers for the reactive layer's watchdog state machine.
 *
 * Extracted as pure functions so the cooldown progression, dry-reset
 * window, and idle-detection predicate are unit-testable without
 * booting a bot. See bot/test/reactive-watchdog.test.js.
 *
 * Context: circuit-v4 (2026-05-21) left the bot at 100% CPU for 6.5h
 * after the agent disconnected — the water-watchdog kept auto-firing
 * `mc escape` every 30s on a fixed cooldown with no awareness that
 * (a) the rescue chain was looping forever without resolution, and
 * (b) there was no agent left to rescue FOR. This module's three
 * helpers fix both gaps:
 *
 *   - `computeBackoffMs(fires)` — exponential cooldown so a runaway
 *     loop slows to ~1 fire / 5 min after a few attempts.
 *   - `shouldResetEscapeCounter(lastFootDryTs, now)` — clear the
 *     backoff once the bot has been dry for ≥2 min (problem actually
 *     solved, ready to react fast again).
 *   - `isAgentIdle(lastAgentCallTs, lastTaskActiveTs, now)` — true
 *     when no `mc <verb>` HTTP call has hit the bot in ≥5 min AND no
 *     task is running. The reactive tick uses this to skip non-
 *     critical decisions (combat, water-watchdog) while staying
 *     responsive to genuine emergencies (lava, drowning).
 */

/**
 * Exponential backoff for consecutive `auto_escape_water` fires.
 *
 * @param {number} consecutiveFires  number of consecutive auto-escapes
 *   since last `foot_in_water=false` reset (0 = first fire)
 * @returns {number} cooldown in milliseconds before the next auto-fire
 */
export function computeBackoffMs(consecutiveFires) {
  const steps = [30_000, 60_000, 120_000, 300_000];
  const n = Math.max(0, consecutiveFires | 0);
  return steps[Math.min(n, steps.length - 1)];
}

/**
 * True if the bot has been dry long enough to reset the consecutive-
 * fire counter. Sets a "problem solved" floor: if the bot got out of
 * water and stayed out for 2 min, the next auto-fire restarts from
 * cooldown step 0 (fast response).
 *
 * @param {number|null} lastFootDryTs  wall-clock ms of last tick with
 *   foot_in_water=false (0 / null = never been dry)
 * @param {number} now  wall-clock ms (typically Date.now())
 * @param {number} [windowMs=120000]  reset window
 * @returns {boolean}
 */
export function shouldResetEscapeCounter(lastFootDryTs, now, windowMs = 120_000) {
  if (!lastFootDryTs) return false;
  return (now - lastFootDryTs) >= windowMs;
}

/**
 * True if no agent has driven the bot in `idleMs` AND no task is
 * actively running. Reactive layer uses this gate to suspend non-
 * critical decisions so the bot doesn't burn CPU running rescue
 * loops with nobody to rescue for.
 *
 * Both timestamps treated as null/0 = "never seen" = fully idle.
 *
 * @param {number|null} lastAgentCallTs  wall-clock ms of last mc <verb> HTTP request
 * @param {number|null} lastTaskActiveTs  wall-clock ms of last currentTask.status==='running' observation
 * @param {number} now  wall-clock ms
 * @param {number} [idleMs=300000]  idle threshold (5 min default)
 * @returns {boolean}
 */
export function isAgentIdle(lastAgentCallTs, lastTaskActiveTs, now, idleMs = 300_000) {
  const agentIdle = !lastAgentCallTs || (now - lastAgentCallTs) >= idleMs;
  const taskIdle = !lastTaskActiveTs || (now - lastTaskActiveTs) >= idleMs;
  return agentIdle && taskIdle;
}

/**
 * Decide whether to auto-disembark a mounted bot that's taking damage
 * with low HP. Pure function — caller observes mount state, HP, damage
 * recency, and cooldown.
 *
 * Higher HP threshold (10, vs. 6 for general LOW_HP_FLEE) because a
 * mounted bot can't attack or eat — every hit is "free damage" and the
 * disembark + escape chain itself takes a couple of seconds. We want to
 * trigger BEFORE Steve is down to one heart.
 *
 * Cooldown prevents ping-pong: if the agent re-mounts immediately after
 * an auto-disembark, we don't trigger again for 30s. The agent gets a
 * `auto_disembark_low_hp` reactive event so it can change strategy.
 *
 * Hit live in circuit-v5h/v5i/v5j: Steve sailed 600+ blocks toward W1,
 * boat wedged at shore approach, drowned mob attacked the stationary
 * boat, Steve died with full inventory + the agent never had time to
 * react to the BOAT_STUCK envelope.
 *
 * @param {object} args
 * @param {boolean} args.mounted        b.vehicle is set
 * @param {number}  args.hp             current health (0-20)
 * @param {boolean} args.recentlyDamaged any damage in last ~5s
 * @param {number|null} args.lastAutoDisembarkTs  wall-clock ms, null if never
 * @param {number}  args.now            wall-clock ms (Date.now())
 * @param {number}  [args.hpThreshold=10]
 * @param {number}  [args.cooldownMs=30000]
 * @returns {boolean} true if reactive should trigger auto-disembark this tick
 */
/**
 * True if the bot is mounted AND a hostile mob is within range. Used
 * for the hostile_near_boat telemetry event — informs the agent that
 * the boat is under threat without forcing a reaction (the HP-based
 * shouldEmergencyDisembark handles the actual emergency).
 *
 * @param {object} args
 * @param {boolean} args.mounted
 * @param {{ name?: string, distance?: number } | null} args.closestHostile
 * @param {number} [args.range=5]
 * @returns {boolean}
 */
export function isHostileNearBoat({ mounted, closestHostile, range = 5 }) {
  if (!mounted) return false;
  if (!closestHostile) return false;
  const d = Number(closestHostile.distance);
  if (!Number.isFinite(d)) return false;
  return d <= range;
}

export function shouldEmergencyDisembark({
  mounted,
  hp,
  recentlyDamaged,
  lastAutoDisembarkTs,
  now,
  hpThreshold = 10,
  cooldownMs = 30_000,
}) {
  if (!mounted) return false;
  if (!recentlyDamaged) return false;
  if (typeof hp !== 'number' || hp > hpThreshold) return false;
  if (lastAutoDisembarkTs && (now - lastAutoDisembarkTs) < cooldownMs) return false;
  return true;
}

/**
 * Combat weapon priority — swords beat axes (faster swing → higher DPS),
 * and within each tier higher material wins. Used by reactive's
 * attackStep + decide() to pick the best weapon in inventory rather
 * than the first one slot order happens to surface.
 *
 * circuit-v11 (2026-05-22): reactive was using
 * `inventory.items().find(/sword|axe$/)` and grabbing whichever
 * weapon was in the lowest slot index — Steve had wooden_axe in
 * his inventory before iron_sword, so the reactive picked
 * wooden_axe for combat. With armor=0 vs a drowned that gave Steve
 * ~6 damage per hit; he dropped from hp=20 to hp=3 in seconds.
 */
export const WEAPON_PRIORITY = [
  'netherite_sword', 'diamond_sword', 'iron_sword',
  'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe',
  'stone_axe', 'golden_axe', 'wooden_axe',
];

const WEAPON_PATTERN = /(_sword|_axe)$/;

/**
 * Return the best weapon in `items` per WEAPON_PRIORITY.
 * @param {Array<{ name: string }>} items
 * @returns {object|null}
 */
export function pickBestWeapon(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  for (const name of WEAPON_PRIORITY) {
    const it = items.find((i) => i?.name === name);
    if (it) return it;
  }
  // Fallback: any item matching the WEAPON_PATTERN (covers modded
  // weapons or future variants the priority list misses).
  return items.find((i) => i?.name && WEAPON_PATTERN.test(i.name)) || null;
}
