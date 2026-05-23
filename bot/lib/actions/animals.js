/** @size-exempt: all animal-handling verbs (breed/feed/shear/hunt/lure) share fair-play helpers */
/**
 * Animal husbandry verbs (Sprint 9): mc breed / shear / milk_cow / hunt / lure.
 *
 * Same Paper 1.21+ caveat as Sprints 7-8 may apply — mineflayer's b.useOn
 * against entities sometimes silently no-ops on Paper. Handlers try native
 * first, then fall back to PaperMCP server-side commands (data merge entity,
 * loot give, clear+give) to keep inventory + world state consistent.
 */

import { Vec3 } from 'vec3';
import { executeServerCommand, paperMcpConfig } from '../runtime/paper-mcp.js';

// Species → array of items in inventory that can breed them.
// First entry is the canonical choice when bot has multiple options.
const BREED_ITEMS = {
  chicken: ['wheat_seeds', 'pumpkin_seeds', 'melon_seeds', 'beetroot_seeds'],
  cow: ['wheat'],
  sheep: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
};

// Species → drop hints (informational only; vanilla server actually decides).
const HUNT_DROPS = {
  chicken: ['raw_chicken', 'feather'],
  cow: ['beef', 'leather'],
  sheep: ['mutton', 'white_wool'],
  pig: ['porkchop'],
  rabbit: ['rabbit', 'rabbit_hide'],
};

const SHEARS_NAMES = ['shears'];
const EMPTY_BUCKET = 'bucket';
const MILK_BUCKET = 'milk_bucket';

const REACH = 3.2;

export function createAnimalsActions(deps) {
  const { ctx, ensureBot, goals, sleep, log, getMyName, ACTIONS, filterEntitiesFairPlay } = deps;

  const inventoryAt = (b) =>
    b.inventory.items().reduce((acc, it) => {
      acc[it.name] = (acc[it.name] || 0) + it.count;
      return acc;
    }, /** @type {Record<string, number>} */ ({}));

  function findItemByName(b, name) {
    return b.inventory.items().find((i) => i.name === name) || null;
  }

  // List nearby animals of a species, sorted by distance. Uses fair-play
  // (excludes hidden / out-of-fov). Baby filtering is species-specific and
  // belongs in the caller, since the entity metadata field that carries
  // age varies by species and protocol version.
  function nearbyAnimals(b, species, radius = 16) {
    const me = b.entity.position;
    const raw = Object.values(b.entities).filter(
      (e) =>
        e &&
        e !== b.entity &&
        e.position &&
        e.type !== 'player' &&
        (e.name || '').toLowerCase() === species,
    );
    const visible = filterEntitiesFairPlay(raw);
    return visible
      .map((e) => ({ ent: e, dist: e.position.distanceTo(me) }))
      .filter((x) => x.dist <= radius)
      .sort((a, c) => a.dist - c.dist)
      .map((x) => x.ent);
  }

  // True if the entity *appears* to be a baby. Mineflayer surfaces an
  // `isBaby` boolean on most living entities; fall back to the Age data
  // value when available (negative on babies). Safer to over-include
  // (assume adult) than to wrongly exclude breeding candidates.
  function isBaby(e) {
    if (typeof e.isBaby === 'boolean') return e.isBaby;
    if (typeof e.metadata?.age === 'number') return e.metadata.age < 0;
    return false;
  }

  // Walk into useOn reach of an entity, chasing it as it moves. Animals
  // wander, so a one-shot pathfind to the entity's start position usually
  // misses. We loop: re-aim at the entity's CURRENT position, walk a few
  // blocks, check distance, repeat until reach or timeout. Returns true
  // when within REACH.
  async function walkToEntity(b, ent, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 12000;
    const start = Date.now();
    // Fast path: already in reach.
    if (b.entity.position.distanceTo(ent.position) <= REACH) return true;

    // Chase loop. Each iteration aims at the entity's latest position. We
    // use GoalNear with a small radius so the bot doesn't try to occupy
    // the entity's exact tile (which would fail). The pathfinder has its
    // own timeout, so each goto returns relatively quickly.
    while (Date.now() - start < timeoutMs) {
      // Re-resolve the entity in case it was killed mid-chase.
      const live = b.entities[ent.id];
      if (!live || !live.position) return false;
      const d = live.position.distanceTo(b.entity.position);
      if (d <= REACH) return true;

      try {
        // GoalNear radius=2 so the bot stops just outside push distance.
        // Radius=1 makes the bot crowd the animal, which pushes it into
        // walls — vanilla collision physics can clip animals through
        // fences when this happens repeatedly.
        await b.pathfinder.goto(
          new goals.GoalNear(live.position.x, live.position.y, live.position.z, 2),
        );
      } catch {
        // Pathfinder may bail if the goal moves; brief pause then retry.
        await sleep(200);
      }
      // Small settle so the next iteration sees the latest entity position.
      await sleep(150);
    }
    // Final reach check after the loop exits.
    const final = b.entities[ent.id];
    return !!(final && final.position && final.position.distanceTo(b.entity.position) <= REACH);
  }

  async function lookAtEntity(b, ent) {
    const hh = Math.min(ent.height || 1, 1.4);
    await b.lookAt(ent.position.offset(0, hh * 0.85, 0));
  }

  return {
    /**
     * Feed two adult animals of `species` to start breeding.
     * Action contract: NO_FOOD, NO_PAIR, ANIMAL_ON_COOLDOWN, OUT_OF_RANGE.
     */
    async breed({ species }) {
      const b = ensureBot();
      const s = String(species || '').trim().toLowerCase();
      if (!BREED_ITEMS[s]) {
        return { ok: false, error: {
          code: 'UNSUPPORTED_SPECIES',
          message: `Don't know how to breed "${s}". Supported: ${Object.keys(BREED_ITEMS).join(', ')}.`,
          retry_safe: false,
        }};
      }

      // Find breeding item — first match in priority order.
      const inv = inventoryAt(b);
      const chosen = BREED_ITEMS[s].find((name) => (inv[name] || 0) >= 2);
      if (!chosen) {
        return { ok: false, error: {
          code: 'NO_FOOD',
          message: `Need at least 2 of one breeding item for ${s}. Accepts: ${BREED_ITEMS[s].join(', ')}.`,
          observed_state: {
            required_any: BREED_ITEMS[s],
            have: BREED_ITEMS[s].reduce((a, k) => ({ ...a, [k]: inv[k] || 0 }), {}),
          },
          retry_safe: false,
        }};
      }

      const candidates = nearbyAnimals(b, s, 12).filter((e) => !isBaby(e));
      if (candidates.length < 2) {
        return { ok: false, error: {
          code: 'NO_PAIR',
          message: `Need 2 adult ${s} within 12 blocks. Found ${candidates.length}.`,
          observed_state: {
            species: s,
            found: candidates.length,
            positions: candidates.map((e) => [Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)]),
          },
          retry_safe: false,
        }};
      }

      // Filter out animals currently in love mode / breed cooldown if we can detect it.
      // Vanilla flag: entity.metadata[16] holds the in-love timer (LivingEntity DATA_IN_LOVE);
      // index varies across protocol versions — we don't gate on it here, vanilla server
      // will simply ignore the feed if the entity is on cooldown.
      const pair = candidates.slice(0, 2);
      const before = inventoryAt(b);

      const fedPositions = [];
      for (const ent of pair) {
        const ok = await walkToEntity(b, ent);
        if (!ok) {
          return { ok: false, error: {
            code: 'OUT_OF_RANGE',
            message: `pathfind to ${s} at ${ent.position} failed`,
            retry_safe: false,
          }};
        }
        const food = findItemByName(b, chosen);
        if (!food) break; // ran out mid-feed; covered by the post-check below
        try {
          await b.equip(food, 'hand');
        } catch (err) {
          return { ok: false, error: {
            code: 'INTERRUPTED',
            message: `equip ${chosen} failed: ${err.message}`,
            retry_safe: true,
          }};
        }
        await lookAtEntity(b, ent);
        await sleep(100);
        try { b.useOn(ent); } catch { /* swallow; verify via inv delta */ }
        await sleep(400);
        fedPositions.push([Math.floor(ent.position.x), Math.floor(ent.position.y), Math.floor(ent.position.z)]);
      }

      const after = inventoryAt(b);
      const consumed = (before[chosen] || 0) - (after[chosen] || 0);
      if (consumed < 2) {
        return { ok: false, error: {
          code: 'ANIMAL_ON_COOLDOWN',
          message: `Fed ${consumed} ${chosen} but server rejected one or both — animal likely in 5-min breed cooldown.`,
          observed_state: { consumed, species: s, fed_positions: fedPositions },
          retry_safe: true,
        }};
      }

      return {
        ok: true,
        command: 'breed',
        data: {
          species: s,
          food: chosen,
          consumed,
          fed_positions: fedPositions,
        },
      };
    },

    /**
     * Shear nearest unsheared sheep.
     * Action contract: NO_SHEARS, NO_SHEEP, SHEEP_ALREADY_SHEARED, OUT_OF_RANGE.
     */
    async shear() {
      const b = ensureBot();
      const shears = findItemByName(b, 'shears');
      if (!shears) {
        return { ok: false, error: {
          code: 'NO_SHEARS',
          message: 'No shears in inventory.',
          observed_state: { inventory_tools: b.inventory.items().filter((i) => i.name.includes('shear')).map((i) => i.name) },
          retry_safe: false,
        }};
      }

      const sheep = nearbyAnimals(b, 'sheep', 8);
      if (sheep.length === 0) {
        return { ok: false, error: {
          code: 'NO_SHEEP',
          message: 'No sheep within 8 blocks.',
          retry_safe: false,
        }};
      }

      // metadata[17] for sheep is a packed byte: bit 0x10 = sheared.
      const target = sheep.find((e) => {
        const meta = e.metadata?.[17];
        if (typeof meta !== 'number') return true; // unknown → try it
        return (meta & 0x10) === 0;
      });
      if (!target) {
        return { ok: false, error: {
          code: 'SHEEP_ALREADY_SHEARED',
          message: 'All nearby sheep are already sheared.',
          observed_state: { sheep_count: sheep.length },
          retry_safe: false,
        }};
      }

      // Equip shears once up front so the chase loop doesn't have to redo it.
      const before = inventoryAt(b);
      try { await b.equip(shears, 'hand'); } catch (err) {
        return { ok: false, error: { code: 'INTERRUPTED', message: `equip shears failed: ${err.message}`, retry_safe: true }};
      }

      // Chase + useOn retry loop. Sheep wander, so we re-chase on each
      // attempt. Up to 4 tries; each chase has its own 12s timeout via
      // walkToEntity. If the sheep escapes far enough, NO_SHEEP fires.
      const woolCountBefore = Object.entries(before).reduce((sum, [k, v]) => {
        if (k.endsWith('_wool') || k === 'wool') return sum + v;
        return sum;
      }, 0);
      let attemptedReach = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const live = b.entities[target.id];
        if (!live || !live.position) break; // sheep died or de-spawned
        const reached = await walkToEntity(b, live);
        if (!reached) continue;
        attemptedReach = true;
        await lookAtEntity(b, live);
        await sleep(120);
        try { b.useOn(live); } catch { /* swallow */ }
        await sleep(600);
        // Check if wool count went up — early exit on success.
        const probe = inventoryAt(b);
        const probeCount = Object.entries(probe).reduce((sum, [k, v]) => {
          if (k.endsWith('_wool') || k === 'wool') return sum + v;
          return sum;
        }, 0);
        if (probeCount > woolCountBefore) break;
      }
      if (!attemptedReach) {
        return { ok: false, error: { code: 'OUT_OF_RANGE', message: 'pathfind to sheep failed (sheep kept moving out of reach)', retry_safe: true }};
      }

      // Trigger a pickup pass for the dropped wool.
      try { await ACTIONS.pickup?.({ radius: 4 }); } catch { /* swallow */ }
      const after = inventoryAt(b);

      const woolGained = Object.entries(after).reduce((sum, [k, v]) => {
        if (k.endsWith('_wool') || k === 'wool') {
          return sum + Math.max(0, v - (before[k] || 0));
        }
        return sum;
      }, 0);

      let fallback = null;
      if (woolGained === 0) {
        // PaperMCP fallback: data merge entity to set Sheared=1, then loot give wool.
        const pmcp = paperMcpConfig();
        const username = getMyName?.();
        if (pmcp && username && target.id != null) {
          log(`[shear] native useOn produced no wool — PaperMCP fallback for sheep ${target.id}`);
          const r1 = await executeServerCommand(pmcp, `data merge entity ${target.uuid || ''} {Sheared:1b}`).catch(() => ({ ok: false }));
          const r2 = await executeServerCommand(pmcp, `give ${username} minecraft:white_wool 1`).catch(() => ({ ok: false }));
          if (r1.ok || r2.ok) fallback = 'papermcp_server_side';
          await sleep(300);
        }
      }

      const final = inventoryAt(b);
      const finalGained = Object.entries(final).reduce((sum, [k, v]) => {
        if (k.endsWith('_wool') || k === 'wool') {
          return sum + Math.max(0, v - (before[k] || 0));
        }
        return sum;
      }, 0);

      if (finalGained === 0) {
        return { ok: false, error: {
          code: 'UNCHANGED',
          message: 'Shear produced no wool — Paper may have rejected or sheep was already sheared.',
          observed_state: { sheep_meta: target.metadata?.[17] },
          retry_safe: true,
        }};
      }

      return {
        ok: true,
        command: 'shear',
        data: {
          sheep_pos: [Math.floor(target.position.x), Math.floor(target.position.y), Math.floor(target.position.z)],
          wool_gained: finalGained,
          ...(fallback ? { fallback } : {}),
        },
      };
    },

    /**
     * Milk nearest cow into an empty bucket.
     * Action contract: NO_BUCKET, NO_COW, OUT_OF_RANGE, UNCHANGED.
     */
    async milk_cow() {
      const b = ensureBot();
      const bucket = findItemByName(b, EMPTY_BUCKET);
      if (!bucket) {
        return { ok: false, error: {
          code: 'NO_BUCKET',
          message: 'No empty bucket in inventory.',
          observed_state: { buckets: b.inventory.items().filter((i) => i.name.includes('bucket')).map((i) => i.name) },
          retry_safe: false,
        }};
      }

      const cows = nearbyAnimals(b, 'cow', 8);
      if (cows.length === 0) {
        return { ok: false, error: { code: 'NO_COW', message: 'No cow within 8 blocks.', retry_safe: false }};
      }
      const cow = cows[0];

      const before = inventoryAt(b);
      try { await b.equip(bucket, 'hand'); } catch (err) {
        return { ok: false, error: { code: 'INTERRUPTED', message: `equip bucket failed: ${err.message}`, retry_safe: true }};
      }

      // Chase + useOn retry loop. Cows wander less than sheep but still
      // drift away during the look+useOn delay. Up to 3 attempts.
      let attemptedReach = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const live = b.entities[cow.id];
        if (!live || !live.position) break;
        const reached = await walkToEntity(b, live);
        if (!reached) continue;
        attemptedReach = true;
        await lookAtEntity(b, live);
        await sleep(120);
        try { b.useOn(live); } catch {}
        await sleep(500);
        const probe = inventoryAt(b);
        if ((probe[MILK_BUCKET] || 0) > (before[MILK_BUCKET] || 0)) break;
      }
      if (!attemptedReach) {
        return { ok: false, error: { code: 'OUT_OF_RANGE', message: 'pathfind to cow failed (cow kept moving out of reach)', retry_safe: true }};
      }
      await sleep(100);

      let after = inventoryAt(b);
      let fallback = null;
      const gotMilk = (after[MILK_BUCKET] || 0) - (before[MILK_BUCKET] || 0);
      if (gotMilk < 1) {
        const pmcp = paperMcpConfig();
        const username = getMyName?.();
        if (pmcp && username) {
          log(`[milk_cow] native useOn didn't produce milk — PaperMCP fallback`);
          const r1 = await executeServerCommand(pmcp, `clear ${username} minecraft:bucket 1`);
          const r2 = await executeServerCommand(pmcp, `give ${username} minecraft:milk_bucket 1`);
          if (r1.ok && r2.ok) fallback = 'papermcp_server_side';
          await sleep(300);
          after = inventoryAt(b);
        }
      }

      const finalMilk = (after[MILK_BUCKET] || 0) - (before[MILK_BUCKET] || 0);
      if (finalMilk < 1) {
        return { ok: false, error: { code: 'UNCHANGED', message: 'No milk_bucket appeared in inventory.', retry_safe: true }};
      }

      return {
        ok: true,
        command: 'milk_cow',
        data: {
          cow_pos: [Math.floor(cow.position.x), Math.floor(cow.position.y), Math.floor(cow.position.z)],
          milk_gained: finalMilk,
          ...(fallback ? { fallback } : {}),
        },
      };
    },

    /**
     * Kill N nearest animals of `species`. Reuses combat attack + pickup.
     * Action contract: NOTHING_TO_HUNT, UNSUPPORTED_SPECIES.
     */
    async hunt({ species, count = 1 }) {
      const b = ensureBot();
      const s = String(species || '').trim().toLowerCase();
      const wantedCount = Math.max(1, Math.min(16, Number(count) || 1));
      if (!HUNT_DROPS[s]) {
        return { ok: false, error: {
          code: 'UNSUPPORTED_SPECIES',
          message: `Don't know what ${s} drops. Supported: ${Object.keys(HUNT_DROPS).join(', ')}.`,
          retry_safe: false,
        }};
      }

      const before = inventoryAt(b);
      const killedPositions = [];

      for (let i = 0; i < wantedCount; i++) {
        const candidates = nearbyAnimals(b, s, 16);
        if (candidates.length === 0) break;
        const target = candidates[0];

        // Equip a weapon if we have one (anything that does damage)
        const weapons = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
                         'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe'];
        for (const w of weapons) {
          const it = b.inventory.items().find((i) => i.name === w);
          if (it) { try { await b.equip(it, 'hand'); } catch {} break; }
        }

        // Attack loop with re-chase: each swing re-resolves the entity and
        // re-paths if it moved out of reach. Stops when the entity is gone
        // or 12 swings have passed.
        let landed = false;
        for (let swing = 0; swing < 12; swing++) {
          const live = b.entities[target.id];
          if (!live) { landed = true; break; }
          if (live.position.distanceTo(b.entity.position) > REACH) {
            const reached = await walkToEntity(b, live, { timeoutMs: 4000 });
            if (!reached) continue;
          }
          await lookAtEntity(b, live);
          try { await b.attack(live); } catch {}
          await sleep(450);
        }
        if (landed) {
          killedPositions.push([Math.floor(target.position.x), Math.floor(target.position.y), Math.floor(target.position.z)]);
        }
      }

      // Multi-pass pickup: feathers especially can scatter farther than
      // meat when a chicken is killed mid-chase. Walk to each kill site
      // briefly to ensure all drops are inside pickup radius, then sweep.
      try {
        for (const [kx, ky, kz] of killedPositions.slice(0, 4)) {
          try {
            await b.pathfinder.goto(new goals.GoalNear(kx, ky, kz, 1));
          } catch {}
          await sleep(150);
          try { await ACTIONS.pickup?.({ radius: 5 }); } catch {}
        }
        // Final wide sweep at current position.
        try { await ACTIONS.pickup?.({ radius: 8 }); } catch {}
      } catch {}
      await sleep(300);

      const after = inventoryAt(b);
      const gained = {};
      for (const drop of HUNT_DROPS[s]) {
        const delta = (after[drop] || 0) - (before[drop] || 0);
        if (delta > 0) gained[drop] = delta;
      }

      if (killedPositions.length === 0) {
        return { ok: false, error: {
          code: 'NOTHING_TO_HUNT',
          message: `No ${s} within range to hunt.`,
          retry_safe: false,
        }};
      }

      return {
        ok: true,
        command: 'hunt',
        data: {
          species: s,
          requested: wantedCount,
          killed: killedPositions.length,
          killed_positions: killedPositions,
          inventory_gained: gained,
        },
      };
    },

    /**
     * Walk to (x,y,z) holding the species' breeding item; vanilla AI makes
     * animals follow within ~10 blocks. Reports follower distance at arrival.
     * Action contract: NO_FOOD, NO_ANIMAL, OUT_OF_RANGE.
     */
    async lure({ species, x, y, z }) {
      const b = ensureBot();
      const s = String(species || '').trim().toLowerCase();
      if (!BREED_ITEMS[s]) {
        return { ok: false, error: {
          code: 'UNSUPPORTED_SPECIES',
          message: `Don't know what ${s} eats. Supported: ${Object.keys(BREED_ITEMS).join(', ')}.`,
          retry_safe: false,
        }};
      }

      const inv = inventoryAt(b);
      const chosen = BREED_ITEMS[s].find((name) => (inv[name] || 0) >= 1);
      if (!chosen) {
        return { ok: false, error: {
          code: 'NO_FOOD',
          message: `Need at least 1 breeding item for ${s}. Accepts: ${BREED_ITEMS[s].join(', ')}.`,
          observed_state: {
            required_any: BREED_ITEMS[s],
            have: BREED_ITEMS[s].reduce((a, k) => ({ ...a, [k]: inv[k] || 0 }), {}),
          },
          retry_safe: false,
        }};
      }

      const candidates = nearbyAnimals(b, s, 16);
      if (candidates.length === 0) {
        return { ok: false, error: {
          code: 'NO_ANIMAL',
          message: `No ${s} within 16 blocks to lure.`,
          retry_safe: false,
        }};
      }
      const target = candidates[0];
      const startPos = [Math.floor(target.position.x), Math.floor(target.position.y), Math.floor(target.position.z)];

      // Hold breeding item — vanilla AI will path the animal toward us.
      const food = findItemByName(b, chosen);
      try { await b.equip(food, 'hand'); } catch (err) {
        return { ok: false, error: { code: 'INTERRUPTED', message: `equip ${chosen} failed: ${err.message}`, retry_safe: true }};
      }

      const dest = new Vec3(Number(x), Number(y), Number(z));
      try {
        await b.pathfinder.goto(new goals.GoalNear(dest.x, dest.y, dest.z, 1));
      } catch {
        return { ok: false, error: {
          code: 'OUT_OF_RANGE',
          message: `pathfind to (${x},${y},${z}) failed`,
          retry_safe: false,
        }};
      }

      // Tick the AI long enough for the animal to actually catch up.
      // Chickens walk at ~0.25 b/s, so 4 seconds buys ~1 block of progress.
      // Agents typically call lure multiple times to walk an animal across
      // longer distances; this is a sensible per-call settle time.
      await sleep(4000);

      const tracked = b.entities[target.id];
      const endPos = tracked
        ? [Math.floor(tracked.position.x), Math.floor(tracked.position.y), Math.floor(tracked.position.z)]
        : startPos;
      const dist = tracked
        ? tracked.position.distanceTo(dest)
        : new Vec3(...startPos).distanceTo(dest);

      return {
        ok: true,
        command: 'lure',
        data: {
          species: s,
          food: chosen,
          animal_start_pos: startPos,
          animal_end_pos: endPos,
          distance_from_target: Number(dist.toFixed(2)),
          followed: dist <= 3,
        },
      };
    },
  };
}
