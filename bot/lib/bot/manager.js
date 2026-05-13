/** Mineflayer connect/events/reconnect/hardcore + stuck watchdog. */

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

/** Delay before reconnect; `attempts` matches ctx.reconnectAttempts before increment. */
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
  } = deps;

  /**
   * Connect to Minecraft. Overlapping calls share one attempt; already-spawned bots no-op unless opts.force.
   * @param {{ force?: boolean }} [opts]
   */
  function createBot(opts = {}) {
    const force = opts.force === true;
    // Same TCP session can briefly lack entity or isAlive during death screen — never spawn a second mineflayer bot.
    if (!force && ctx.bot && ctx.botReady) {
      if (ctx.bot.entity || ctx.bot.isAlive === false) {
        return Promise.resolve(ctx.bot);
      }
    }

    if (force) {
      const p = Promise.resolve(ctx.connectPromise)
        .catch(() => {})
        .then(() => sleep(300))
        .then(() => runConnectAttempt(true))
        .finally(() => {
          if (ctx.connectPromise === p) ctx.connectPromise = null;
        });
      ctx.connectPromise = p;
      return p;
    }

    if (!ctx.connectPromise) {
      const attempt = runConnectAttempt(false).finally(() => {
        if (ctx.connectPromise === attempt) ctx.connectPromise = null;
      });
      ctx.connectPromise = attempt;
    }
    return ctx.connectPromise;
  }

  function runConnectAttempt(force) {
    return new Promise((resolve, reject) => {
      void (async () => {
        try {
          if (ctx.bot && (force || !ctx.botReady)) {
            ctx.suppressEndReconnect = true;
            try {
              ctx.bot.quit();
            } catch {}
            ctx.bot = null;
            ctx.botReady = false;
            await sleep(1000);
          }
        } catch (e) {
          ctx.suppressEndReconnect = false;
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

        ctx.bot = botInstance;

        const cleanupFailedAttempt = () => {
          try {
            botInstance.quit();
          } catch {}
          if (ctx.bot === botInstance) ctx.bot = null;
          ctx.botReady = false;
          ctx.suppressEndReconnect = false;
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

          ctx.mcData = minecraftData(ctx.bot.version);
        loadGoalsFromDisk();
        loadReminders();

        ctx.bot.loadPlugin(pathfinder);
        ctx.bot.loadPlugin(armorManager);
        ctx.bot.loadPlugin(autoEatLoader);
        ctx.bot.loadPlugin(collectBlock);

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
        const moves = new Movements(ctx.bot);
        moves.allowSprinting = true;
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
        moves.allowParkour = String(process.env.BOT_ALLOW_PARKOUR ?? 'false').toLowerCase() === 'true';
        moves.canDig = false;
        moves.scafoldingBlocks = [];

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
        for (const name of protectedBlocks) {
          const block = ctx.mcData.blocksByName[name];
          if (block) moves.blocksCantBreak.add(block.id);
        }

        ctx.bot.pathfinder.setMovements(moves);

        ctx.bot.autoEat.options = {
          priority: 'foodPoints',
          startAt: 14,
          bannedFood: [],
        };

        ctx.bot.on('chat', (username, message) => {
          if (username === ctx.bot.username) return;
          handleChat(username, message).catch((e) => log(`Chat handler error: ${e.message}`));
        });

        ctx.bot.on('whisper', (username, message) => {
          if (username === ctx.bot.username) return;
          ctx.chatLog.push({ time: Date.now(), from: username, message, whisper: true });
          if (ctx.chatLog.length > ctx.MAX_LOG) ctx.chatLog.shift();
          log(`[Whisper] <${username}> ${message}`);
          ctx.commandQueue.push({
            time: Date.now(),
            from: username,
            command: message,
            originalMessage: message,
            status: 'pending',
          });
          if (ctx.commandQueue.length > ctx.MAX_QUEUE) ctx.commandQueue.shift();
        });

        ctx.bot.on('health', () => {
          if (ctx.bot.health < ctx.lastHealth) {
            const damage = ctx.lastHealth - ctx.bot.health;
            ctx.combatStats.damageTaken += damage;
            ctx.lastDamageEvent = {
              amount: Math.round(damage * 100) / 100,
              hp: Math.round(ctx.bot.health * 100) / 100,
              ts: Date.now(),
            };
            log(`Took ${damage.toFixed(1)} damage (HP: ${ctx.bot.health.toFixed(1)})`);
          }
          ctx.lastHealth = ctx.bot.health;
        });

        ctx.bot.on('blockBreakProgressObserved', (block, destroyStage, entity) => {
          if (entity && entity !== ctx.bot.entity) {
            addSoundEvent('mining', block.position, FAIR_PLAY.SOUND_MINE_RADIUS);
          }
        });

        botInstance._soundCheckInterval = setInterval(() => {
          if (!ctx.bot || !ctx.botReady) return;
          Object.values(botInstance.entities).forEach((e) => {
            if (e === ctx.bot.entity || !e.position) return;
            const vel = e.velocity;
            if (!vel) return;
            const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
            if (speed > 0.2) addSoundEvent('sprinting', e.position, FAIR_PLAY.SOUND_SPRINT_RADIUS);
            else if (speed > 0.05) addSoundEvent('walking', e.position, FAIR_PLAY.SOUND_WALK_RADIUS);
          });
        }, 2000);

        ctx.bot.on('death', () => {
          ctx.combatStats.deaths++;
          ctx.lastDeath = {
            time: Date.now(),
            position: posObj(),
            inventory: ctx.bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
            deathNumber: ctx.deathLog.length + 1,
          };
          const entry = { time: Date.now(), position: posObj() };
          ctx.deathLog.push(entry);
          const locs = loadLocations();
          locs[`death_${ctx.deathLog.length}`] = { ...posObj(), saved: new Date().toISOString() };
          saveLocations(locs);

          if (ctx.bot.game?.hardcore || ctx.hardcoreDead) {
            ctx.hardcoreDead = true;
            log('☠ HARDCORE DEATH! This character is PERMANENTLY DEAD. No reconnect.');
            ctx.chatLog.push({
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

          if (ctx.currentTask?.status === 'running') {
            ctx.currentTask.status = 'cancelled';
            ctx.currentTask.error = 'Interrupted by player death';
            pushTaskHistoryRecord(ctx.currentTask, 'cancelled');
          }

          // mineflayer auto-respawns once from health.js; some servers/packet timing need a retry.
          const nudgeMs = [0, 200, 500, 1200, 2500, 5000, 8000];
          for (const ms of nudgeMs) {
            setTimeout(() => {
              if (ctx.bot !== botInstance || ctx.hardcoreDead) return;
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
          if (ctx.bot !== botInstance) return;
          try {
            botInstance.pathfinder?.setGoal?.(null);
          } catch {}
          ctx.reconnectAttempts = 0;
        });

        ctx.bot.on('kicked', (reason) => {
          log(`Kicked: ${JSON.stringify(reason)}`);
          ctx.botReady = false;
        });

        ctx.bot.on('end', (reason) => {
          log(`Disconnected: ${reason}`);
          ctx.botReady = false;
          ctx.positionHistory = [];
          const skipReconnect = ctx.suppressEndReconnect;
          if (ctx.suppressEndReconnect) ctx.suppressEndReconnect = false;

          try {
            if (botInstance._soundCheckInterval) {
              clearInterval(botInstance._soundCheckInterval);
              botInstance._soundCheckInterval = null;
            }
          } catch {}

          if (skipReconnect) {
            log('Reconnect timer skipped — session replacement already in flight.');
          }

          if (ctx.hardcoreDead) {
            log('☠ Hardcore death — staying disconnected. RIP.');
            return;
          }

          if (skipReconnect) return;

          const delay = reconnectBackoffMs(ctx.reconnectAttempts);
          ctx.reconnectAttempts++;
          log(`Reconnecting in ${delay / 1000}s (attempt ${ctx.reconnectAttempts})...`);
          setTimeout(() => {
            log('Attempting reconnect...');
            createBot().catch((e) => log(`Reconnect failed: ${e.message}`));
          }, delay);
        });

        ctx.botReady = true;
        ctx.reconnectAttempts = 0;
        const spawnLocs = loadLocations();
        if (!spawnLocs.spawn) {
          spawnLocs.spawn = { ...posObj(), saved: new Date().toISOString() };
          saveLocations(spawnLocs);
        }
        log(
          `Connected! Spawned at ${fmt(ctx.bot.entity.position.x)}, ${fmt(ctx.bot.entity.position.y)}, ${fmt(ctx.bot.entity.position.z)}`,
        );
        resolve(ctx.bot);
        });
      })();
    });
  }

  function startStuckWatchdog(intervalMs = 5000) {
    return setInterval(() => {
      if (!ctx.bot || !ctx.botReady) return;
      const pos = ctx.bot.entity.position;
      ctx.positionHistory.push({ time: Date.now(), x: pos.x, y: pos.y, z: pos.z });
      ctx.positionHistory = ctx.positionHistory.filter((p) => Date.now() - p.time < 60000);

      if (
        ctx.currentTask &&
        ctx.currentTask.status === 'running' &&
        STUCK_MOVEMENT_ACTIONS.includes(ctx.currentTask.action) &&
        !ctx.syncActionInFlight
      ) {
        const old = ctx.positionHistory.find((p) => Date.now() - p.time > STUCK_IDLE_MS);
        if (old) {
          const dist = Math.sqrt((pos.x - old.x) ** 2 + (pos.y - old.y) ** 2 + (pos.z - old.z) ** 2);
          if (dist < 2) {
            try {
              ctx.bot.pathfinder.setGoal(null);
            } catch {}
            try {
              ctx.bot.stopDigging();
            } catch {}
            try {
              ctx.bot.clearControlStates();
            } catch {}
            ctx.currentTask.status = 'stuck';
            ctx.currentTask.error = `Stuck at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} — try a different approach`;
            pushTaskHistoryRecord(ctx.currentTask, 'stuck');
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
      if (ctx.syncActionInFlight && SYNC_STUCK_ACTIONS.has(ctx.syncActionName)) {
        const old = ctx.positionHistory.find((p) => Date.now() - p.time > SYNC_STUCK_IDLE_MS);
        if (old) {
          const dxz = Math.hypot(pos.x - old.x, pos.z - old.z);
          if (dxz < 0.5) {
            const now = Date.now();
            // Log + unstick at most once every 5s per stuck-streak.
            if (!ctx._lastSyncStuckLogAt || now - ctx._lastSyncStuckLogAt > 5000) {
              ctx._lastSyncStuckLogAt = now;

              // Track repeated activations at the same spot. v33 demonstrated
              // a terrain wedge (mined-out deposit, 1-block depression) where
              // the basic re-centre wiggle wasn't enough — every neighbour cell
              // required a jump to escape and pathfinder wasn't issuing one.
              // After 3 stuck events within 30s at the same spot, escalate:
              // cancel pathfinder goal + sustained jump+forward burst.
              if (!Array.isArray(ctx._stuckActivations)) ctx._stuckActivations = [];
              ctx._stuckActivations = ctx._stuckActivations
                .filter((s) => now - s.time < 30000);
              const sameSpot = ctx._stuckActivations
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
              log(`STUCK (sync) ${ctx.syncActionName}: no horizontal movement (${dxz.toFixed(2)}m) in ${(SYNC_STUCK_IDLE_MS/1000)|0}s at ${pos.x.toFixed(1)},${pos.y.toFixed(0)},${pos.z.toFixed(1)}${offCentre ? ` (off-centre ${offDist.toFixed(2)}m)` : ''}${escalate ? ` [${sameSpot.length + 1} same-spot activations]` : ''} — ${mode}`);

              // Always: clear active pathfinder commands. Frees the bot
              // from whatever direction pathfinder was pushing toward.
              try { ctx.bot.clearControlStates(); } catch {}

              if (escalate) {
                // Terrain wedge: cancel the pathfinder goal entirely and
                // step BACK briefly (jump+back). Pathfinder was pressing
                // FORWARD into whatever obstacle wedged the bot; going
                // back disengages from it. Jump covers the "in a hole"
                // case where vertical clearance is also needed. Combining
                // both handles wall-wedge AND hole-wedge geometries.
                // 500ms is enough for a 1-block step + jump arc.
                try { ctx.bot.pathfinder.setGoal(null); } catch {}
                try {
                  ctx.bot.setControlState('jump', true);
                  ctx.bot.setControlState('back', true);
                  setTimeout(() => {
                    try {
                      ctx.bot.setControlState('jump', false);
                      ctx.bot.setControlState('back', false);
                    } catch {}
                  }, 500);
                } catch {}
                // Reset activation tracking — the escalation will either
                // free the bot or the next stuck-streak starts fresh.
                ctx._stuckActivations = [];
              } else if (offCentre) {
                // Step toward cell centre. mineflayer's setControlState
                // moves relative to current yaw, so we use lookAt + brief
                // forward step to nudge the bot back to (.5, .5).
                try {
                  const target = ctx.bot.entity.position.offset(-offX, 0, -offZ);
                  ctx.bot.lookAt(target, true).then(() => {
                    try { ctx.bot.setControlState('forward', true); } catch {}
                    setTimeout(() => {
                      try { ctx.bot.setControlState('forward', false); } catch {}
                    }, 250);
                  }).catch(() => {});
                } catch {}
                ctx._stuckActivations.push({ x: pos.x, z: pos.z, time: now });
              } else {
                // Centred but stuck — likely vertical (block above
                // hitbox). Brief jump as before.
                try {
                  ctx.bot.setControlState('jump', true);
                  setTimeout(() => { try { ctx.bot.setControlState('jump', false); } catch {} }, 250);
                } catch {}
                ctx._stuckActivations.push({ x: pos.x, z: pos.z, time: now });
              }
            }
          } else if (ctx._lastSyncStuckLogAt) {
            // Made progress — clear the streak.
            ctx._lastSyncStuckLogAt = null;
            ctx._stuckActivations = [];
          }
        }
      }

      if ((!ctx.currentTask || ctx.currentTask.status !== 'running') && !ctx.syncActionInFlight) {
        const recent = ctx.positionHistory.filter((p) => Date.now() - p.time < 8000);
        if (recent.length >= 3) {
          const allSameSpot = recent.every(
            (p) =>
              Math.abs(p.x - recent[0].x) < 1.5 && Math.abs(p.z - recent[0].z) < 1.5,
          );
          if (allSameSpot && !ctx.bot.entity.onGround) {
            try {
              ctx.bot.clearControlStates();
            } catch {}
            try {
              ctx.bot.pathfinder.setGoal(null);
            } catch {}
            log('Jump-stuck detected — cleared controls');
          }
        }
      }
    }, intervalMs);
  }

  return { createBot, startStuckWatchdog };
}
