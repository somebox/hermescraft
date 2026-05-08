/** Mineflayer connect/events/reconnect/hardcore + stuck watchdog. */

/** Actions used by stuck watchdog when task.status === 'running'. */
export const STUCK_MOVEMENT_ACTIONS = [
  'goto',
  'goto_near',
  'follow',
  'collect',
  'fight',
  'flee',
  'go_mark',
  'deathpoint',
  'pickup',
  'sprint_attack',
  'strafe',
  'combo',
];

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

  async function createBot() {
    if (ctx.bot) {
      try {
        ctx.bot.quit();
      } catch {}
      ctx.bot = null;
      ctx.botReady = false;
      await sleep(1000);
    }

    return new Promise((resolve, reject) => {
      log(`Connecting to ${config.mc.host}:${config.mc.port} as ${config.mc.username}...`);

      ctx.bot = mineflayer.createBot({
        host: config.mc.host,
        port: config.mc.port,
        username: config.mc.username,
        auth: config.mc.auth,
      });

      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout — couldn't reach ${config.mc.host}:${config.mc.port}`));
      }, 30000);

      ctx.bot.once('spawn', () => {
        clearTimeout(timeout);
        ctx.mcData = minecraftData(ctx.bot.version);
        loadGoalsFromDisk();
        loadReminders();

        ctx.bot.loadPlugin(pathfinder);
        ctx.bot.loadPlugin(armorManager);
        ctx.bot.loadPlugin(autoEatLoader);
        ctx.bot.loadPlugin(collectBlock);

        const moves = new Movements(ctx.bot);
        moves.allowSprinting = true;
        moves.canDig = true;
        moves.allowParkour = true;

        // Prefer soft blocks for scaffolding (easier to mine back later)
        const scaffoldPreference = ['dirt', 'sand', 'gravel', 'netherrack', 'cobblestone'];
        moves.scafoldingBlocks = [];
        for (const name of scaffoldPreference) {
          const bl = ctx.mcData.blocksByName[name];
          if (bl) moves.scafoldingBlocks.push(bl.id);
        }

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

        ctx.bot._soundCheckInterval = setInterval(() => {
          if (!ctx.bot || !ctx.botReady) return;
          Object.values(ctx.bot.entities).forEach((e) => {
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
          log('DIED! Respawning...');
        });

        ctx.bot.on('kicked', (reason) => {
          log(`Kicked: ${JSON.stringify(reason)}`);
          ctx.botReady = false;
        });

        ctx.bot.on('end', (reason) => {
          log(`Disconnected: ${reason}`);
          ctx.botReady = false;
          ctx.positionHistory = [];
          if (ctx.bot?._soundCheckInterval) {
            clearInterval(ctx.bot._soundCheckInterval);
            ctx.bot._soundCheckInterval = null;
          }

          if (ctx.hardcoreDead) {
            log('☠ Hardcore death — staying disconnected. RIP.');
            return;
          }

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

      ctx.bot.on('error', (err) => {
        log(`Bot error: ${err.message}`);
      });
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
        STUCK_MOVEMENT_ACTIONS.includes(ctx.currentTask.action)
      ) {
        const old = ctx.positionHistory.find((p) => Date.now() - p.time > 10000);
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
            log('STUCK detected (10s no movement) — task cancelled');
          }
        }
      }

      if (!ctx.currentTask || ctx.currentTask.status !== 'running') {
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
