// @size-exempt: createBot lifecycle + stuck watchdog kept together for shared closure
/** Mineflayer connect/events/reconnect/hardcore + stuck watchdog. */

import { Vec3 } from 'vec3';

/** Actions used by stuck watchdog when task.status === 'running'. */
/** Note: `collect` is excluded — mining often keeps feet within <2m for 10–20s while digging. */
export const STUCK_MOVEMENT_ACTIONS = [
  'goto',
  'goto_near',
  'follow',
  'fight',
  'flee',
  'go_mark',
  'deathpoint',
  'pickup',
  'sprint_attack',
  'strafe',
  'combo',
];

/** Min ms with almost no position change before declaring stuck (pathfinder can crawl in tight caves). */
const STUCK_IDLE_MS = 20000;

/**
 * Default pathfinder Movements tuning. Exported so tests can lock the
 * specific knobs we tune, and so users can override via env var.
 *
 * - liquidCost: 250 — heavy penalty so long water routes lose to any
 *   dry detour up to 250×N blocks longer (N = water cells crossed).
 *   Lets 1-2 block fords through (a 250-block detour for a 1-block
 *   ford is silly) but refuses 5+ block crossings (1250 detour budget
 *   is more than enough to find a long way around). Bumped from 50
 *   after circuit-v1 showed Steve preferring short water routes that
 *   physics then carried him into deep water.
 * - infiniteLiquidDropdownDistance: false — pathfinder default `true`
 *   lets the bot treat a drop into water of any depth as "safe", so it
 *   cheerfully routes over a cliff into a pond. False caps water drops
 *   at maxDropDown=4 like solid ground.
 * - avoidWater: depth-aware (default 'shallow'). Three modes:
 *     'hard'    — original strict behaviour: every water cell added to
 *                  blocksToAvoid. Refuses all water, including 1-block
 *                  river fords. Use for sensitive bots that should
 *                  never get wet.
 *     'shallow' — NEW DEFAULT (post-exp5). Wraps safeOrBreak to refuse
 *                  ONLY water cells where the block directly below
 *                  isn't solid (= deep water, drowning risk). Water
 *                  with solid floor below is wading: foot in water,
 *                  head in air, no drowning. liquidCost=50 still
 *                  applies, so long water paths get expensive vs.
 *                  short fords.
 *     'off'     — no avoidance, rely on liquidCost penalty only.
 *
 *   Why shallow is default: exp5 trace showed Steve couldn't cross a
 *   1-block river to reach W1 because pathfinder refused every water
 *   cell. The exp3 drowning incident was a DEEP-water case (open
 *   ocean swim, y=51 with water-on-water-on-water) — handled
 *   correctly by the new shallow mode because no solid floor existed.
 *
 *   Set env `BOT_AVOID_WATER=hard|shallow|off` to override.
 */
const AVOID_WATER_DEFAULT = (() => {
  const v = (process.env.BOT_AVOID_WATER || '').toLowerCase();
  if (v === 'hard' || v === 'strict') return 'hard';
  if (v === 'off' || v === 'false') return 'off';
  return 'shallow'; // default
})();

/**
 * Cumulative cap on how many blocks below the bot's CURRENT foot Y a
 * pathfind is allowed to terminate. Default 3.
 *
 * Round-A hyd2 trace: with avoidWater=true blocking water-routes, the
 * bot's `mc collect dirt` pathfind descended a natural slope from
 * y=64 down to y=60 to reach a dirt block at lower elevation.
 * Re-ascending took ~50 commands of trial-and-error. Capping the
 * search at 3 blocks of total descent (below the current foot Y)
 * forces the planner to either find a level alternative or return
 * NAV_BLOCKED with the bot still at start Y — so the brain can
 * decide whether to bridge, stair_down, or pivot.
 *
 * Override via env `BOT_MAX_CUMULATIVE_DROP_DOWN=<int>`. Set very
 * high (e.g. 256) to effectively disable.
 */
const MAX_CUMULATIVE_DROP_DOWN_DEFAULT = Number.isFinite(parseInt(process.env.BOT_MAX_CUMULATIVE_DROP_DOWN, 10))
  ? parseInt(process.env.BOT_MAX_CUMULATIVE_DROP_DOWN, 10)
  : 3;

/**
 * Soft-block allowlist (task #4). Pathfinder respects these as
 * obstacles by default; with `canDig=false` (hermescraft default,
 * read-only navigation) the bot can't break them, so dense forest
 * floors and grass meadows become impassable mazes. Real-world
 * footprint in exp6: Steve repeatedly stalled "under a tree" — the
 * leaves/grass at his head level blocked the move; canDig=false
 * meant pathfinder refused to even consider breaking them.
 *
 * These blocks have ~0 hardness, no useful drops (occasional
 * sapling/seed from leaves/grass), and don't represent player-built
 * structures — they're terrain noise. Allow pathfinder to auto-break
 * them at low cost (~3) even with canDig=false. The cost is non-zero
 * so a path that avoids leaves is still preferred — but a path that
 * goes through is no longer rejected outright.
 *
 * Override via opts.softBlocks if a specific bot needs a different
 * list (e.g. mushroom-fields biome wants to break mushrooms too).
 */
const SOFT_BLOCK_NAMES = Object.freeze([
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
  'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'mangrove_leaves',
  'azalea_leaves', 'flowering_azalea_leaves', 'pale_oak_leaves',
  'tall_grass', 'short_grass', 'grass', 'fern', 'large_fern',
  'dead_bush', 'vine', 'snow', 'snow_layer',
  'azalea', 'flowering_azalea',
  // Flowers + small mushrooms (replaceable; safe to break)
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'red_mushroom', 'brown_mushroom',
]);
const SOFT_BLOCK_COST = 3; // low but non-zero — prefer dry-clear routes if available

export const MOVEMENTS_TUNING = Object.freeze({
  allowSprinting: true,
  canDig: false,
  canOpenDoors: true,
  scafoldingBlocks: [],
  liquidCost: 250,
  infiniteLiquidDropdownDistance: false,
  avoidWater: AVOID_WATER_DEFAULT,
  maxCumulativeDropDown: MAX_CUMULATIVE_DROP_DOWN_DEFAULT,
  softBlocks: SOFT_BLOCK_NAMES,
  softBlockCost: SOFT_BLOCK_COST,
});

/**
 * Apply hermescraft's Movements knobs to a mineflayer-pathfinder Movements
 * instance. Separated from createBotManager so tests can lock the tuning
 * without booting a full bot.
 *
 * @param {object} moves   a mineflayer-pathfinder Movements instance
 * @param {object} mcData  mcData with blocksByName
 * @param {object} [opts]
 * @param {boolean} [opts.allowParkour=false]
 * @param {string[]} [opts.protectedBlocks]  block names to mark uncuttable
 */
export function applyMovementsTuning(moves, mcData, opts = {}) {
  moves.allowSprinting = MOVEMENTS_TUNING.allowSprinting;
  moves.allowParkour = opts.allowParkour ?? false;
  moves.canDig = MOVEMENTS_TUNING.canDig;
  moves.canOpenDoors = MOVEMENTS_TUNING.canOpenDoors;
  moves.scafoldingBlocks = MOVEMENTS_TUNING.scafoldingBlocks;
  if (typeof moves.liquidCost !== 'undefined') {
    moves.liquidCost = MOVEMENTS_TUNING.liquidCost;
  }
  if (typeof moves.infiniteLiquidDropdownDistance !== 'undefined') {
    moves.infiniteLiquidDropdownDistance = MOVEMENTS_TUNING.infiniteLiquidDropdownDistance;
  }
  // Water avoidance — depth-aware (not strict).
  //
  // Round-A exp3: avoidWater=true added water to blocksToAvoid, which
  // is a HARD reject of every water cell regardless of cost. That
  // prevented drowning but ALSO refused legitimate shallow fords (a
  // 1-block river crossing). The bot got stuck on cliff edges and
  // exp5 couldn't cross any water at all.
  //
  // New default (avoidWater === 'shallow' or true): wrap safeOrBreak
  // so a water cell is REFUSED iff the block directly below it isn't
  // solid (= deep water, bot's foot has no support = drowning risk).
  // Water cells WITH solid floor below (shallow wading) are accepted
  // at the liquidCost penalty (=50) — long detours over many water
  // cells get expensive; short fords get crossed.
  //
  // In Minecraft a 1-block-deep water cell with solid floor lets the
  // bot stand at Y+0.5 with foot in water but head in air — wading,
  // not swimming. No drowning. The depth check is the right proxy.
  //
  // BOT_AVOID_WATER values:
  //   'hard' or 'strict'  — original behaviour: all water in
  //                          blocksToAvoid, no fords allowed
  //   'shallow' or 'true' — new default: shallow fords allowed,
  //                          deep water refused
  //   'false' or 'off'    — no water avoidance, rely on liquidCost
  //                          penalty only (cheapest path through any
  //                          depth of water if dry costs more)
  const avoidWaterMode = (() => {
    const o = opts.avoidWater;
    if (o === 'hard' || o === 'strict') return 'hard';
    if (o === false || o === 'false' || o === 'off') return 'off';
    if (o === 'shallow' || o === true || o === 'true') return 'shallow';
    // default from MOVEMENTS_TUNING (env-derived, see top of file).
    // MOVEMENTS_TUNING.avoidWater is now a string: 'hard' | 'shallow' | 'off'.
    return MOVEMENTS_TUNING.avoidWater;
  })();
  if (avoidWaterMode === 'hard') {
    const waterBlock = mcData?.blocksByName?.water;
    if (waterBlock && moves.blocksToAvoid?.add) {
      moves.blocksToAvoid.add(waterBlock.id);
    }
  }
  // Combined safeOrBreak wrapper: soft-block allowlist (task #4) + water
  // depth check (commit 7b0539b). Both gates need to inspect a block at
  // the cost-evaluation point, so wrap once.
  const softBlocks = new Set(opts.softBlocks ?? MOVEMENTS_TUNING.softBlocks);
  const softBlockCost = opts.softBlockCost ?? MOVEMENTS_TUNING.softBlockCost;
  const needsWaterWrap = avoidWaterMode === 'shallow';
  const needsSoftBlockWrap = softBlocks.size > 0;
  if ((needsWaterWrap || needsSoftBlockWrap) && typeof moves.safeOrBreak === 'function' && !moves._safeOrBreakPatched) {
    const origSafeOrBreak = moves.safeOrBreak.bind(moves);
    moves.safeOrBreak = function (block, toBreak) {
      // Soft-block allowlist FIRST: short-circuit with auto-break.
      // Bypasses the canDig=false guard inside origSafeOrBreak (which
      // would otherwise return 100 for any breakable block when
      // canDig=false). Leaves/grass/ferns/flowers have ~0 hardness,
      // no valuable drops, and aren't player-built — safe to break
      // during navigation. See SOFT_BLOCK_NAMES at top of file.
      if (needsSoftBlockWrap && block && block.name && softBlocks.has(block.name)) {
        if (block.position && Array.isArray(toBreak)) {
          toBreak.push(block.position);
        }
        return softBlockCost;
      }
      // Water depth check (shallow mode).
      if (needsWaterWrap && block && block.position && (block.name === 'water' || block.name === 'flowing_water')) {
        let below;
        try {
          below = this.bot?.blockAt && this.bot.blockAt(new Vec3(block.position.x, block.position.y - 1, block.position.z));
        } catch { below = null; }
        const belowIsSolid = below && below.boundingBox === 'block' && below.name !== 'water' && below.name !== 'flowing_water' && below.name !== 'lava';
        if (!belowIsSolid) {
          return 100; // refuse: deep water (no solid floor)
        }
        // Shallow ford: fall through to original, which adds liquidCost.
      }
      return origSafeOrBreak(block, toBreak);
    };
    moves._safeOrBreakPatched = true;
    // Back-compat: keep the old flag so existing tests / external code
    // checking `_waterDepthPatched` doesn't break.
    moves._waterDepthPatched = true;
  }
  moves.avoidWaterMode = avoidWaterMode;
  moves.softBlocks = softBlocks;
  for (const name of opts.protectedBlocks ?? []) {
    const block = mcData?.blocksByName?.[name];
    if (block && moves.blocksCantBreak?.add) {
      moves.blocksCantBreak.add(block.id);
    }
  }

  // Cumulative-drop cap. See MOVEMENTS_TUNING.maxCumulativeDropDown
  // comment. We wrap `getLandingBlock` because it's the single
  // chokepoint for both `getMoveDown` (1-block step) and
  // `getMoveDropDown` (multi-block fall) — returning null aborts the
  // candidate neighbour. The cap is anchored to the bot's foot Y at
  // call time, NOT at Movements-construction time, so each new
  // pathfinder.goto() uses the current foot Y as its baseline.
  const maxCumulativeDropDown = opts.maxCumulativeDropDown ?? MOVEMENTS_TUNING.maxCumulativeDropDown;
  moves.maxCumulativeDropDown = maxCumulativeDropDown;
  if (typeof moves.getLandingBlock === 'function' && !moves._cumulativeDropPatched) {
    const originalGetLandingBlock = moves.getLandingBlock.bind(moves);
    moves.getLandingBlock = function (node, dir) {
      const landing = originalGetLandingBlock(node, dir);
      if (!landing || !landing.position) return landing;
      const footY = this.bot?.entity?.position?.y;
      if (typeof footY !== 'number') return landing; // defensive: no bot in test mocks
      const floorY = Math.floor(footY);
      if (landing.position.y < floorY - this.maxCumulativeDropDown) {
        return null;
      }
      return landing;
    };
    moves._cumulativeDropPatched = true;
  }
  return moves;
}

/** Delay before reconnect; `attempts` matches ctx.death.reconnectAttempts before increment. */
export function reconnectBackoffMs(attempts) {
  return Math.min(5000 * Math.pow(2, attempts), 60000);
}

/** Factory: returns createBot + startStuckWatchdog; wire deps from server.js. */
export function createBotManager(deps) {
  const {
    ctx,
    config,
    log,
    sleep,
    mineflayer,
    minecraftData,
    pathfinder,
    Movements,
    armorManager,
    autoEatLoader,
    collectBlock,
    FAIR_PLAY,
    handleChat,
    loadGoalsFromDisk,
    loadReminders,
    posObj,
    fmt,
    addSoundEvent,
    loadLocations,
    saveLocations,
    pushTaskHistoryRecord,
    viewerPort = null,
  } = deps;

  /**
   * Connect to Minecraft. Overlapping calls share one attempt; already-spawned bots no-op unless opts.force.
   * @param {{ force?: boolean }} [opts]
   */
  function createBot(opts = {}) {
    const force = opts.force === true;
    // Same TCP session can briefly lack entity or isAlive during death screen — never spawn a second mineflayer bot.
    if (!force && ctx.world.bot && ctx.world.botReady) {
      if (ctx.world.bot.entity || ctx.world.bot.isAlive === false) {
        return Promise.resolve(ctx.world.bot);
      }
    }

    if (force) {
      const p = Promise.resolve(ctx.world.connectPromise)
        .catch(() => {})
        .then(() => sleep(300))
        .then(() => runConnectAttempt(true))
        .finally(() => {
          if (ctx.world.connectPromise === p) ctx.world.connectPromise = null;
        });
      ctx.world.connectPromise = p;
      return p;
    }

    if (!ctx.world.connectPromise) {
      const attempt = runConnectAttempt(false).finally(() => {
        if (ctx.world.connectPromise === attempt) ctx.world.connectPromise = null;
      });
      ctx.world.connectPromise = attempt;
    }
    return ctx.world.connectPromise;
  }

  function runConnectAttempt(force) {
    return new Promise((resolve, reject) => {
      void (async () => {
        try {
          if (ctx.world.bot && (force || !ctx.world.botReady)) {
            ctx.death.suppressEndReconnect = true;
            try {
              ctx.world.bot.quit();
            } catch {}
            ctx.world.bot = null;
            ctx.world.botReady = false;
            await sleep(1000);
          }
        } catch (e) {
          ctx.death.suppressEndReconnect = false;
          reject(e);
          return;
        }

        log(`Connecting to ${config.mc.host}:${config.mc.port} as ${config.mc.username}...`);

        const botInstance = mineflayer.createBot({
          host: config.mc.host,
          port: config.mc.port,
          username: config.mc.username,
          auth: config.mc.auth,
        });

        ctx.world.bot = botInstance;

        const cleanupFailedAttempt = () => {
          try {
            botInstance.quit();
          } catch {}
          if (ctx.world.bot === botInstance) ctx.world.bot = null;
          ctx.world.botReady = false;
          ctx.death.suppressEndReconnect = false;
        };

        const connectMs =
          typeof config.mc.connectTimeoutMs === 'number' && config.mc.connectTimeoutMs > 0
            ? config.mc.connectTimeoutMs
            : 55000;
        const timeout = setTimeout(() => {
          cleanupFailedAttempt();
          reject(new Error(`Connection timeout — couldn't reach ${config.mc.host}:${config.mc.port}`));
        }, connectMs);

        const onEarlyReject = /** @type {(err: Error) => void} */ ((err) => {
          clearTimeout(timeout);
          cleanupFailedAttempt();
          reject(err instanceof Error ? err : new Error(String(err)));
        });

        botInstance.once('error', onEarlyReject);

        botInstance.once('spawn', () => {
          clearTimeout(timeout);
          botInstance.removeListener('error', onEarlyReject);
          botInstance.on('error', (err) => {
            log(`Bot error: ${err.message}`);
          });

          ctx.world.mcData = minecraftData(ctx.world.bot.version);
        loadGoalsFromDisk();
        loadReminders();

        ctx.world.bot.loadPlugin(pathfinder);
        ctx.world.bot.loadPlugin(armorManager);
        ctx.world.bot.loadPlugin(autoEatLoader);
        ctx.world.bot.loadPlugin(collectBlock);

        // Pathfinder is READ-ONLY navigation. No digging, no scaffolding,
        // no destructive side effects from "go from A to B". Agents must be
        // EXPLICIT about destruction via mc collect / mc dig / mc tunnel /
        // mc dig_area / mc place / mc wall / etc.
        //
        // Empirical (trap tests, 2026-05-10): with canDig=true we observed
        // pathfinder routing through whichever block was cheapest to break:
        //   - closed door room → broke the oak_door (protectedBlocks doesn't
        //     actually save it; pathfinder treated wooden door as cheap)
        //   - sealed cobble room → tunneled through the stone floor
        //   - open door → used the door (the only safe case)
        // canDig=false makes navigation strictly read-only; mc through is
        // the explicit door verb, mc tunnel/dig_area handle terrain.
        const moves = new Movements(ctx.world.bot);
        // F49: parkour expansion explodes the pathfinder search space
        // when a multi-block wall is between the bot and its target.
        // Mineflayer-pathfinder evaluates many parkour-over-the-top
        // sequences that can't possibly work (3-tall walls block
        // 1-block-jump parkour), exhausting the 5s think budget and
        // looping the goto. Repro: G21 v2 Mason at (2.5, 65, 12.7) with
        // a 4-wide 3-tall cobble wall at z=12; `goto_near` to (0,65,11)
        // hangs 15s with parkour on, succeeds in 8s at range=2 without.
        //
        // Default: OFF. Parkour helps when there's no easier route (e.g.
        // crossing a small ravine), but for typical G21 / build / mine
        // workflows the no-parkour search is faster AND more reliable.
        // Opt-in with BOT_ALLOW_PARKOUR=true if a specific test needs it.
        //
        // F66 (canOpenDoors=true), #85 (liquidCost), and the round-A
        // sustained-farm hydration-trap fix (liquidCost bump + no infinite
        // liquid drop) all live in applyMovementsTuning — see MOVEMENTS_TUNING.
        const protectedBlocks = [
          'oak_planks',
          'birch_planks',
          'spruce_planks',
          'dark_oak_planks',
          'jungle_planks',
          'acacia_planks',
          'oak_log',
          'birch_log',
          'spruce_log',
          'dark_oak_log',
          'jungle_log',
          'acacia_log',
          'stripped_oak_log',
          'stripped_birch_log',
          'stripped_spruce_log',
          'stripped_dark_oak_log',
          'glass',
          'glass_pane',
          'white_stained_glass',
          'white_stained_glass_pane',
          'oak_door',
          'birch_door',
          'spruce_door',
          'dark_oak_door',
          'iron_door',
          'oak_fence',
          'birch_fence',
          'spruce_fence',
          'dark_oak_fence',
          'oak_fence_gate',
          'birch_fence_gate',
          'spruce_fence_gate',
          'oak_stairs',
          'birch_stairs',
          'spruce_stairs',
          'cobblestone_stairs',
          'stone_stairs',
          'oak_slab',
          'birch_slab',
          'spruce_slab',
          'cobblestone_slab',
          'stone_slab',
          'cobblestone',
          'stone_bricks',
          'bricks',
          'smooth_stone',
          'crafting_table',
          'furnace',
          'chest',
          'barrel',
          'bookshelf',
          'torch',
          'wall_torch',
          'lantern',
          'ladder',
          'bed',
          'white_bed',
          'red_bed',
        ];
        applyMovementsTuning(moves, ctx.world.mcData, {
          allowParkour: deps.config?.behaviors?.allowParkour ?? false,
          protectedBlocks,
        });

        ctx.world.bot.pathfinder.setMovements(moves);

        ctx.world.bot.autoEat.options = {
          priority: 'foodPoints',
          startAt: 14,
          bannedFood: [],
        };

        ctx.world.bot.on('chat', (username, message) => {
          if (username === ctx.world.bot.username) return;
          handleChat(username, message).catch((e) => log(`Chat handler error: ${e.message}`));
        });

        ctx.world.bot.on('whisper', (username, message) => {
          if (username === ctx.world.bot.username) return;
          ctx.social.chatLog.push({ time: Date.now(), from: username, message, whisper: true });
          if (ctx.social.chatLog.length > ctx.social.MAX_LOG) ctx.social.chatLog.shift();
          log(`[Whisper] <${username}> ${message}`);
          ctx.social.commandQueue.push({
            time: Date.now(),
            from: username,
            command: message,
            originalMessage: message,
            status: 'pending',
          });
          if (ctx.social.commandQueue.length > ctx.social.MAX_QUEUE) ctx.social.commandQueue.shift();
        });

        ctx.world.bot.on('health', () => {
          if (ctx.world.bot.health < ctx.death.lastHealth) {
            const damage = ctx.death.lastHealth - ctx.world.bot.health;
            ctx.team.combatStats.damageTaken += damage;
            ctx.death.lastDamageEvent = {
              amount: Math.round(damage * 100) / 100,
              hp: Math.round(ctx.world.bot.health * 100) / 100,
              ts: Date.now(),
            };
            log(`Took ${damage.toFixed(1)} damage (HP: ${ctx.world.bot.health.toFixed(1)})`);
          }
          ctx.death.lastHealth = ctx.world.bot.health;
        });

        ctx.world.bot.on('blockBreakProgressObserved', (block, destroyStage, entity) => {
          if (entity && entity !== ctx.world.bot.entity) {
            addSoundEvent('mining', block.position, FAIR_PLAY.SOUND_MINE_RADIUS);
          }
        });

        botInstance._soundCheckInterval = setInterval(() => {
          if (!ctx.world.bot || !ctx.world.botReady) return;
          Object.values(botInstance.entities).forEach((e) => {
            if (e === ctx.world.bot.entity || !e.position) return;
            const vel = e.velocity;
            if (!vel) return;
            const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
            if (speed > 0.2) addSoundEvent('sprinting', e.position, FAIR_PLAY.SOUND_SPRINT_RADIUS);
            else if (speed > 0.05) addSoundEvent('walking', e.position, FAIR_PLAY.SOUND_WALK_RADIUS);
          });
        }, 2000);

        ctx.world.bot.on('death', () => {
          ctx.team.combatStats.deaths++;
          ctx.death.lastDeath = {
            time: Date.now(),
            position: posObj(),
            inventory: ctx.world.bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
            deathNumber: ctx.death.deathLog.length + 1,
          };
          const entry = { time: Date.now(), position: posObj() };
          ctx.death.deathLog.push(entry);
          const locs = loadLocations();
          locs[`death_${ctx.death.deathLog.length}`] = { ...posObj(), saved: new Date().toISOString() };
          saveLocations(locs);

          if (ctx.world.bot.game?.hardcore || ctx.death.hardcoreDead) {
            ctx.death.hardcoreDead = true;
            log('☠ HARDCORE DEATH! This character is PERMANENTLY DEAD. No reconnect.');
            ctx.social.chatLog.push({
              time: Date.now(),
              from: 'SYSTEM',
              message: 'YOU DIED IN HARDCORE MODE. You are permanently dead. Your story is over.',
              whisper: false,
            });
            return;
          }
          log('DIED! Clearing movement and nudging respawn…');

          // Stop pathfinder / digs so they do not block the client_command respawn packet.
          try {
            botInstance.pathfinder?.setGoal?.(null);
          } catch {}
          try {
            botInstance.stopDigging();
          } catch {}
          try {
            botInstance.clearControlStates();
          } catch {}

          if (ctx.tasks.currentTask?.status === 'running') {
            ctx.tasks.currentTask.status = 'cancelled';
            ctx.tasks.currentTask.error = 'Interrupted by player death';
            pushTaskHistoryRecord(ctx.tasks.currentTask, 'cancelled');
          }

          // mineflayer auto-respawns once from health.js; some servers/packet timing need a retry.
          const nudgeMs = [0, 200, 500, 1200, 2500, 5000, 8000];
          for (const ms of nudgeMs) {
            setTimeout(() => {
              if (ctx.world.bot !== botInstance || ctx.death.hardcoreDead) return;
              try {
                if (typeof botInstance.respawn === 'function' && botInstance.isAlive === false) {
                  botInstance.respawn();
                }
              } catch (e) {
                log(`Respawn nudge @${ms}ms failed: ${/** @type {Error} */ (e).message || e}`);
              }
            }, ms);
          }
        });

        // Fires again after death recovery (mineflayer health plugin) — clear any stale path goal.
        botInstance.on('spawn', () => {
          if (ctx.world.bot !== botInstance) return;
          if (ctx.world.mcSessionStartedAt == null) {
            ctx.world.mcSessionStartedAt = Date.now();
          }
          try {
            botInstance.pathfinder?.setGoal?.(null);
          } catch {}
          ctx.death.reconnectAttempts = 0;
        });

        ctx.world.bot.on('kicked', (reason) => {
          log(`Kicked: ${JSON.stringify(reason)}`);
          ctx.world.botReady = false;
        });

        ctx.world.bot.on('end', (reason) => {
          log(`Disconnected: ${reason}`);
          ctx.world.botReady = false;
          ctx.world.mcSessionStartedAt = null;
          ctx.world.positionHistory = [];
          const skipReconnect = ctx.death.suppressEndReconnect;
          if (ctx.death.suppressEndReconnect) ctx.death.suppressEndReconnect = false;

          try {
            botInstance.viewer?.close?.();
          } catch {}

          try {
            if (botInstance._soundCheckInterval) {
              clearInterval(botInstance._soundCheckInterval);
              botInstance._soundCheckInterval = null;
            }
          } catch {}

          if (skipReconnect) {
            log('Reconnect timer skipped — session replacement already in flight.');
          }

          if (ctx.death.hardcoreDead) {
            log('☠ Hardcore death — staying disconnected. RIP.');
            return;
          }

          if (skipReconnect) return;

          const delay = reconnectBackoffMs(ctx.death.reconnectAttempts);
          ctx.death.reconnectAttempts++;
          log(`Reconnecting in ${delay / 1000}s (attempt ${ctx.death.reconnectAttempts})...`);
          setTimeout(() => {
            log('Attempting reconnect...');
            createBot().catch((e) => log(`Reconnect failed: ${e.message}`));
          }, delay);
        });

        ctx.world.botReady = true;
        ctx.death.reconnectAttempts = 0;
        const spawnLocs = loadLocations();
        if (!spawnLocs.spawn) {
          spawnLocs.spawn = { ...posObj(), saved: new Date().toISOString() };
          saveLocations(spawnLocs);
        }
        log(
          `Connected! Spawned at ${fmt(ctx.world.bot.entity.position.x)}, ${fmt(ctx.world.bot.entity.position.y)}, ${fmt(ctx.world.bot.entity.position.z)}`,
        );

        if (viewerPort) {
          void import('prismarine-viewer')
            .then((mod) => {
              const mv = mod.mineflayer;
              if (typeof mv !== 'function') {
                log('prismarine-viewer: missing mineflayer export');
                return;
              }
              try {
                mv(botInstance, { port: viewerPort, firstPerson: true });
                log(`FPV prismarine-viewer → http://127.0.0.1:${viewerPort} (open from dashboard FPV tab)`);
              } catch (e) {
                log(`prismarine-viewer: ${/** @type {Error} */ (e).message || e}`);
              }
            })
            .catch((e) => log(`prismarine-viewer load: ${/** @type {Error} */ (e).message || e}`));
        }

        resolve(ctx.world.bot);
        });
      })();
    });
  }

  function startStuckWatchdog(intervalMs = 5000) {
    return setInterval(() => {
      if (!ctx.world.bot || !ctx.world.botReady) return;
      const pos = ctx.world.bot.entity.position;
      ctx.world.positionHistory.push({ time: Date.now(), x: pos.x, y: pos.y, z: pos.z });
      ctx.world.positionHistory = ctx.world.positionHistory.filter((p) => Date.now() - p.time < 60000);

      if (
        ctx.tasks.currentTask &&
        ctx.tasks.currentTask.status === 'running' &&
        STUCK_MOVEMENT_ACTIONS.includes(ctx.tasks.currentTask.action) &&
        !ctx.tasks.syncActionInFlight
      ) {
        const old = ctx.world.positionHistory.find((p) => Date.now() - p.time > STUCK_IDLE_MS);
        if (old) {
          const dist = Math.sqrt((pos.x - old.x) ** 2 + (pos.y - old.y) ** 2 + (pos.z - old.z) ** 2);
          if (dist < 2) {
            try {
              ctx.world.bot.pathfinder.setGoal(null);
            } catch {}
            try {
              ctx.world.bot.stopDigging();
            } catch {}
            try {
              ctx.world.bot.clearControlStates();
            } catch {}
            ctx.tasks.currentTask.status = 'stuck';
            ctx.tasks.currentTask.error = `Stuck at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} — try a different approach`;
            pushTaskHistoryRecord(ctx.tasks.currentTask, 'stuck');
            log(`STUCK detected (${STUCK_IDLE_MS / 1000}s no movement) — task cancelled`);
          }
        }
      }

      // Sync-action stuck detection + unstick. Movement-oriented sync
      // actions (collect, goto, pickup, etc.) sometimes wedge the bot
      // on a block corner — pathfinder thinks it's traveling, but
      // velocity is ~0. A short jump + clearControlStates usually
      // dislodges it without disrupting the broader action.
      //
      // Threshold is shorter than the BG-task watchdog (8s vs 20s)
      // because we want to unstick FAST during long mining sessions,
      // not just log after 20s. We also nudge BEFORE giving up so the
      // higher-level action can keep making progress.
      const SYNC_STUCK_ACTIONS = new Set([
        'collect', 'dig', 'dig_area', 'goto', 'goto_near', 'pickup',
        'follow', 'go_mark', 'fish', 'sail', 'hunt', 'lure', 'through',
        'place_fill', 'wall', 'tunnel',
      ]);
      const SYNC_STUCK_IDLE_MS = 8000;
      if (ctx.tasks.syncActionInFlight && SYNC_STUCK_ACTIONS.has(ctx.tasks.syncActionName)) {
        const old = ctx.world.positionHistory.find((p) => Date.now() - p.time > SYNC_STUCK_IDLE_MS);
        if (old) {
          const dxz = Math.hypot(pos.x - old.x, pos.z - old.z);
          if (dxz < 0.5) {
            const now = Date.now();
            // Log + unstick at most once every 5s per stuck-streak.
            if (!ctx.runtime._lastSyncStuckLogAt || now - ctx.runtime._lastSyncStuckLogAt > 5000) {
              ctx.runtime._lastSyncStuckLogAt = now;

              // Track repeated activations at the same spot. v33 demonstrated
              // a terrain wedge (mined-out deposit, 1-block depression) where
              // the basic re-centre wiggle wasn't enough — every neighbour cell
              // required a jump to escape and pathfinder wasn't issuing one.
              // After 3 stuck events within 30s at the same spot, escalate:
              // cancel pathfinder goal + sustained jump+forward burst.
              if (!Array.isArray(ctx.runtime._stuckActivations)) ctx.runtime._stuckActivations = [];
              ctx.runtime._stuckActivations = ctx.runtime._stuckActivations
                .filter((s) => now - s.time < 30000);
              const sameSpot = ctx.runtime._stuckActivations
                .filter((s) => Math.hypot(s.x - pos.x, s.z - pos.z) < 1.5);
              const escalate = sameSpot.length >= 2; // this would be the 3rd

              const cellCx = Math.floor(pos.x) + 0.5;
              const cellCz = Math.floor(pos.z) + 0.5;
              const offX = pos.x - cellCx;
              const offZ = pos.z - cellCz;
              const offDist = Math.hypot(offX, offZ);
              const offCentre = offDist > 0.2;

              const mode = escalate
                ? 'ESCALATE'
                : offCentre ? 'wiggling+recentre' : 'wiggling';
              log(`STUCK (sync) ${ctx.tasks.syncActionName}: no horizontal movement (${dxz.toFixed(2)}m) in ${(SYNC_STUCK_IDLE_MS/1000)|0}s at ${pos.x.toFixed(1)},${pos.y.toFixed(0)},${pos.z.toFixed(1)}${offCentre ? ` (off-centre ${offDist.toFixed(2)}m)` : ''}${escalate ? ` [${sameSpot.length + 1} same-spot activations]` : ''} — ${mode}`);

              // Always: clear active pathfinder commands. Frees the bot
              // from whatever direction pathfinder was pushing toward.
              try { ctx.world.bot.clearControlStates(); } catch {}

              if (escalate) {
                // Terrain wedge: cancel the pathfinder goal entirely and
                // step BACK briefly (jump+back). Pathfinder was pressing
                // FORWARD into whatever obstacle wedged the bot; going
                // back disengages from it. Jump covers the "in a hole"
                // case where vertical clearance is also needed. Combining
                // both handles wall-wedge AND hole-wedge geometries.
                // 500ms is enough for a 1-block step + jump arc.
                try { ctx.world.bot.pathfinder.setGoal(null); } catch {}
                try {
                  ctx.world.bot.setControlState('jump', true);
                  ctx.world.bot.setControlState('back', true);
                  setTimeout(() => {
                    try {
                      ctx.world.bot.setControlState('jump', false);
                      ctx.world.bot.setControlState('back', false);
                    } catch {}
                  }, 500);
                } catch {}
                // Reset activation tracking — the escalation will either
                // free the bot or the next stuck-streak starts fresh.
                ctx.runtime._stuckActivations = [];
              } else if (offCentre) {
                // Step toward cell centre. mineflayer's setControlState
                // moves relative to current yaw, so we use lookAt + brief
                // forward step to nudge the bot back to (.5, .5).
                try {
                  const target = ctx.world.bot.entity.position.offset(-offX, 0, -offZ);
                  ctx.world.bot.lookAt(target, true).then(() => {
                    try { ctx.world.bot.setControlState('forward', true); } catch {}
                    setTimeout(() => {
                      try { ctx.world.bot.setControlState('forward', false); } catch {}
                    }, 250);
                  }).catch(() => {});
                } catch {}
                ctx.runtime._stuckActivations.push({ x: pos.x, z: pos.z, time: now });
              } else {
                // Centred but stuck — likely vertical (block above
                // hitbox). Brief jump as before.
                try {
                  ctx.world.bot.setControlState('jump', true);
                  setTimeout(() => { try { ctx.world.bot.setControlState('jump', false); } catch {} }, 250);
                } catch {}
                ctx.runtime._stuckActivations.push({ x: pos.x, z: pos.z, time: now });
              }
            }
          } else if (ctx.runtime._lastSyncStuckLogAt) {
            // Made progress — clear the streak.
            ctx.runtime._lastSyncStuckLogAt = null;
            ctx.runtime._stuckActivations = [];
          }
        }
      }

      if ((!ctx.tasks.currentTask || ctx.tasks.currentTask.status !== 'running') && !ctx.tasks.syncActionInFlight) {
        const recent = ctx.world.positionHistory.filter((p) => Date.now() - p.time < 8000);
        if (recent.length >= 3) {
          const allSameSpot = recent.every(
            (p) =>
              Math.abs(p.x - recent[0].x) < 1.5 && Math.abs(p.z - recent[0].z) < 1.5,
          );
          if (allSameSpot && !ctx.world.bot.entity.onGround) {
            try {
              ctx.world.bot.clearControlStates();
            } catch {}
            try {
              ctx.world.bot.pathfinder.setGoal(null);
            } catch {}
            log('Jump-stuck detected — cleared controls');
          }
        }
      }
    }, intervalMs);
  }

  return { createBot, startStuckWatchdog };
}
