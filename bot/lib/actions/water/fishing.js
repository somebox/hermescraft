import { pathfindGotoNear, ACTION_CAPS_MS } from '../_helpers.js';
import { fail } from './_contract.js';

const FISH_ROD_NAMES = ['fishing_rod'];

// Items that can come out of vanilla fishing (fish, junk, treasure).
const FISH_LOOT = [
  // fish
  'cod', 'salmon', 'pufferfish', 'tropical_fish',
  // junk
  'bowl', 'leather', 'leather_boots', 'rotten_flesh', 'stick',
  'string', 'water_bottle', 'bone', 'ink_sac', 'tripwire_hook',
  // treasure
  'enchanted_book', 'name_tag', 'nautilus_shell', 'saddle',
  'fishing_rod', 'bow', 'lily_pad',
];

/** @typedef {{ ensureBot: () => import('mineflayer').Bot; goals: any; sleep: (ms: number) => Promise<void>; log: (m: string) => void }} FishDeps */

/**
 * Cast a fishing rod into nearby water, wait for a bite, reel in,
 * and pick up the drops. Returns the inventory delta as the catch.
 * Action contract: NO_ROD, NO_WATER, FISH_TIMEOUT, INTERRUPTED.
 *
 * Phase 4a: moved verbatim from legacy water.js factory closure.
 *
 * @param {FishDeps} deps
 */
export function createFishHandlers({ ensureBot, goals, sleep, log }) {

  const inventoryAt = (b) =>
    b.inventory.items().reduce((acc, it) => {
      acc[it.name] = (acc[it.name] || 0) + it.count;
      return acc;
    }, /** @type {Record<string, number>} */ ({}));

  function findRod(b) {
    for (const name of FISH_ROD_NAMES) {
      const it = b.inventory.items().find((i) => i.name === name);
      if (it) return it;
    }
    return null;
  }

  // Find the closest water source block within `radius` of the bot. Prefers
  // blocks with sky access (Java needs open sky for treasure but fish work
  // regardless). Returns the Block or null.
  function findWaterNearby(b, radius = 6) {
    const me = b.entity.position.floored();
    let best = null;
    let bestDist = Infinity;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          const p = me.offset(dx, dy, dz);
          const blk = b.blockAt(p);
          if (!blk || blk.name !== 'water') continue;
          const props = blk.getProperties?.() || {};
          if (props.level !== undefined && Number(props.level) !== 0) continue;
          const d = me.distanceTo(p);
          if (d < bestDist) { best = blk; bestDist = d; }
        }
      }
    }
    return best;
  }

  async function fish({ timeout_seconds = 60 } = {}) {
    const b = ensureBot();

    const rod = findRod(b);
    if (!rod) {
              return fail('NO_ROD', 'No fishing_rod in inventory.', {
          observed_state: { rods: b.inventory.items().filter((i) => i.name.includes('rod')).map((i) => i.name) },
          retry_safe: false,
        });
    }

    const water = findWaterNearby(b, 6);
    if (!water) {
              return fail('NO_WATER', 'No water source within 6 blocks. Move next to a pond or lake.', { retry_safe: false });
    }

    const CAST_DISTANCE = 7;
    const wx = water.position.x + 0.5;
    const wz = water.position.z + 0.5;
    const wy = water.position.y;
    const me0 = b.entity.position;
    let toBotX = me0.x - wx;
    let toBotZ = me0.z - wz;
    const toBotLen = Math.max(0.001, Math.hypot(toBotX, toBotZ));
    const stanceX = Math.round(wx + (toBotX / toBotLen) * CAST_DISTANCE);
    const stanceZ = Math.round(wz + (toBotZ / toBotLen) * CAST_DISTANCE);
    const stanceY = wy + 1;
    try {
      await pathfindGotoNear(b, goals, stanceX, stanceY, stanceZ, 1, { opName: 'fish_stance', capMs: ACTION_CAPS_MS.reach });
    } catch {
              return fail('OUT_OF_RANGE', 'pathfind to fishing stance failed', { retry_safe: false });
    }

    try { await b.equip(rod, 'hand'); } catch (err) {
              return fail('INTERRUPTED', `equip rod failed: ${err.message}`, { retry_safe: true });
    }

    const me = b.entity.position;
    const dx = wx - me.x;
    const dz = wz - me.z;
    const yaw = Math.atan2(-dx, dz);
    const pitch = 0;
    try { await b.look(yaw, pitch, true); } catch {}
    await sleep(500);
    log(`[fish] stance=(${stanceX},${stanceY},${stanceZ}) yaw=${yaw.toFixed(2)} pitch=${pitch.toFixed(2)}`);

    const before = inventoryAt(b);

    const fishPromise = b.fish().catch((err) => ({ _err: err }));
    const timeoutPromise = sleep(timeout_seconds * 1000).then(() => ({ _timeout: true }));
    const winner = await Promise.race([fishPromise, timeoutPromise]);

    if (winner && winner._timeout) {
      try { b.activateItem(); } catch {}
      await sleep(500);
              return fail('FISH_TIMEOUT', `No bite within ${timeout_seconds}s. Try again or move to a sunnier spot (rain + open sky speed up bites).`, { retry_safe: true });
    }
    if (winner && winner._err) {
              return fail('INTERRUPTED', `fishing cancelled: ${winner._err.message}`, { retry_safe: true });
    }

    await sleep(1500);

    const after = inventoryAt(b);
    const gained = {};
    for (const name of FISH_LOOT) {
      const delta = (after[name] || 0) - (before[name] || 0);
      if (delta > 0) gained[name] = delta;
    }
    for (const [name, count] of Object.entries(after)) {
      if (gained[name]) continue;
      const delta = count - (before[name] || 0);
      if (delta > 0 && !FISH_LOOT.includes(name)) gained[name] = delta;
    }

    if (Object.keys(gained).length === 0) {
              return fail('UNCHANGED', 'Reeled in but no item appeared in inventory — drop may have despawned or fallen out of reach.', { retry_safe: true });
    }

    return {
      ok: true,
      command: 'fish',
      data: {
        caught: gained,
        water_block: [Math.floor(water.position.x), Math.floor(water.position.y), Math.floor(water.position.z)],
      },
    };
  }

  return { fish };
}
