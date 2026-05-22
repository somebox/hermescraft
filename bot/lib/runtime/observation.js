// @size-exempt: observe-payload builders + goal scoreboard + dashboard signals
import { Vec3 } from 'vec3';
import { scoreGoals } from '../goals/engine.js';
import { refreshLeaseCheckpoint, taskToApi } from '../goals/tasks.js';
import { summarizeSocialGraph, selectRecentChat } from '../shared/chat.js';
import { buildActionStats, classifyIdleReason } from '../server/diagnostics.js';

export function createObservation(deps) {
  const { ctx, ensureBot, fmt, posObj, loadLocations, filterEntitiesFairPlay, buildSceneSummary, fireDueReminders, FAIR_PLAY, itemStr } = deps;

  function getGoalsScoreboard() {
    if (!ctx.world.bot || !ctx.world.botReady || !ctx.world.mcData) return { scored: [], context: null };
    const { scored, context, deficitSince } = scoreGoals(ctx.world.bot, ctx.world.mcData, ctx.goals.goalsStore, ctx.goals.chestSnapshots);
    ctx.goals.goalsStore.deficitSince = deficitSince;
    return { scored, context };
  }

  function buildTypedAlerts() {
    if (!ctx.world.bot || !ctx.world.botReady) return [];
    const list = [];
    const pos = ctx.world.bot.entity.position;
    const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned', 'phantom', 'husk', 'stray'];
    const ents = Object.values(ctx.world.bot.entities || {}).filter((e) => e !== ctx.world.bot.entity && e.position);
    const visible = filterEntitiesFairPlay(ents);
    for (const e of visible) {
      if (e.type !== 'mob') continue;
      const name = (e.name || '').toLowerCase();
      if (!hostiles.some((h) => name.includes(h))) continue;
      const d = e.position.distanceTo(pos);
      const threat = Math.max(0, Math.min(1, 1 - d / 48));
      list.push({
        type: 'hostile',
        entity: e.name,
        distance_m: fmt(d),
        threat_score: Math.round(threat * 1000) / 1000,
      });
    }
    for (const s of ctx.runtime.soundEvents.slice(-5)) {
      list.push({
        type: 'sound',
        kind: s.type,
        direction: s.direction,
        distance: s.distance,
      });
    }
    if (ctx.world.bot.entity.isInWater) {
      list.push({ type: 'hazard', kind: 'water', message: 'submerged' });
    }
    return list;
  }

  /** Keywords → coarse topics for dashboard ("Hermes wants chickens" vs scored goals store). */
  function buildDashboardSignals() {
    const pending = ctx.social.commandQueue
      .filter((c) => c.status === 'pending')
      .slice(0, 10)
      .map((c) => ({
        from: c.from,
        command: c.command,
        channel: c.channel || null,
        status: 'pending',
      }));
    const active = ctx.social.commandQueue
      .filter((c) => c.status === 'acknowledged')
      .slice(0, 10)
      .map((c) => ({
        from: c.from,
        command: c.command,
        channel: c.channel || null,
        status: 'acknowledged',
        plan: c.plan || null,
      }));

    const topics = [
      {
        tag: 'farm',
        re: /\b(chicken|chickens|egg|eggs|coop|coops|farm(?:ing)?|feather|feathers|hay|wheat|barn)\b/i,
        label: 'Farm / chickens / crops',
      },
      {
        tag: 'build',
        re: /\b(build|wall|fence|roof|floor|cobble|pillar|place|structure|house)\b/i,
        label: 'Building / placement',
      },
      { tag: 'gather', re: /\b(wood|logs?|mine|gather|collect|strip|dig)\b/i, label: 'Gathering resources' },
      { tag: 'craft', re: /\b(craft|crafting|table|axe|pickaxe|recipe)\b/i, label: 'Crafting' },
      {
        tag: 'animals',
        re: /\b(cow|cows|pig|sheep|breed|breeding|mob(?:s)?)\b/i,
        label: 'Animals / breeding',
      },
    ];
    const seen = new Set();
    /** @type {{ tag: string, label: string, from?: string, snippet: string }[]} */
    const chat_topics = [];
    const merged = [...ctx.social.chatLog, ...ctx.social.overheardLog].sort((a, b) => (b.time || 0) - (a.time || 0));
    for (const line of merged.slice(0, 55)) {
      const text = line.message || '';
      for (const t of topics) {
        if (t.re.test(text) && !seen.has(t.tag)) {
          seen.add(t.tag);
          chat_topics.push({
            tag: t.tag,
            label: t.label,
            from: line.from,
            snippet: text.slice(0, 160),
          });
        }
      }
    }

    return {
      pending_commands: pending,
      active_tasks: active,
      chat_topics,
      disclaimer:
        'Topics come from recent chat keywords — not automatic goals. Load a preset or POST /goals to mirror agent plans into the Goals panel.',
    };
  }

  /** One line per active goal with strategies_available from preset/store (persisted "steps"). */
  function buildGoalsPlanHints(scored, limit = 8) {
    return scored
      .filter((g) => g.enabled !== false && !g.satisfied)
      .slice(0, limit)
      .map((g) => {
        const strat = Array.isArray(g.strategies_available)
          ? g.strategies_available.slice(0, 5).join(' · ')
          : '';
        return strat ? { id: g.id, line: `${g.id}: ${strat}` } : { id: g.id, line: `${g.id} (${g.metric})` };
      });
  }

  // Per-request coalesce for briefState's chat fetch. A single HTTP
  // response typically calls briefState() twice (chat-banner middleware +
  // final response state), and we want both to see the SAME batch of
  // new chat. Outside the coalesce window, the cursor advances so the
  // next HTTP response only surfaces messages that arrived since the
  // previous one — instead of re-emitting the same 120s window over
  // and over.
  let _briefChatBatchAt = 0;
  let _briefChatBatch = /** @type {any[] | null} */ (null);
  const _BRIEF_CHAT_COALESCE_MS = 200;

  function briefState() {
    if (!ctx.world.bot || !ctx.world.botReady) return null;

    // Grab recent chat so AI sees messages that arrived during action.
    // The cursor (ctx.social.lastChatBriefedTime) gates against the
    // chat that's already been shown to the agent on a prior response.
    // Within a 200ms window we reuse the same batch so chat-banner and
    // final-state see identical content.
    const now = Date.now();
    let recentChat;
    const reuse = _briefChatBatch !== null && (now - _briefChatBatchAt) < _BRIEF_CHAT_COALESCE_MS;
    if (reuse) {
      recentChat = _briefChatBatch;
    } else {
      const cursor = ctx.social.lastChatBriefedTime || 0;
      recentChat = selectRecentChat(
        ctx.social.chatLog,
        now,
        cursor,
        ctx.world.bot.username,
      );
      // Cache the batch for the coalesce window AND advance the cursor.
      // The cursor advance is "now-anchored" rather than "latest-message-
      // anchored" — any chat that arrives mid-flight will still surface
      // on the next response.
      _briefChatBatch = recentChat;
      _briefChatBatchAt = now;
      if (recentChat.length > 0) {
        ctx.social.lastChatBriefedTime = now;
      }
    }

    // Grab active commands (pending or acknowledged)
    const pending = ctx.social.commandQueue.filter(c => c.status === 'pending');
    const acknowledged = ctx.social.commandQueue.filter(c => c.status === 'acknowledged');

    const state = {
      health: fmt(ctx.world.bot.health),
      food: ctx.world.bot.food,
      position: posObj(),
      holding: ctx.world.bot.heldItem?.name || 'empty',
      // circuit-v16: explicit mount state for the brief view. Agent
      // would lose track of "I'm on a boat" between actions and try
      // mc move / mc board redundantly. Surface mounted at the top
      // level so every observe / status response shows it.
      ...(ctx.world.bot.vehicle ? {
        mounted: {
          vehicle: ctx.world.bot.vehicle.name || ctx.world.bot.vehicle.type || 'unknown',
          vehicle_id: ctx.world.bot.vehicle.id,
          hint: 'You are mounted. Use mc sail X Y Z to travel; mc disembark to dismount. Do NOT call mc board or mc move while mounted.',
        },
      } : {}),
      time: ctx.world.bot.time.timeOfDay,
      isDay: ctx.world.bot.time.timeOfDay < 12000,
    };
    // Surface combat tallies in the brief view so the agent can see at
    // a glance how dangerous the session has been (and whether it's
    // landing kills back). Both fields omitted when zero.
    if (ctx.team.combatStats?.kills > 0) state.kills = ctx.team.combatStats.kills;
    if (ctx.death.deathLog?.length > 0) state.deaths = ctx.death.deathLog.length;
    if (ctx.world.bot.isAlive === false) {
      state.respawn_pending = true;
    }

    // Nearby utility blocks — moved out of the default briefState to keep
    // every action response lean. Callers that need them should hit
    // `mc scene` or `mc nearby`. The observe endpoints (which DO want them)
    // reinstate via `_nearby_utilities` recomputation below.

    if (recentChat.length > 0) state.new_chat = recentChat;
    if (pending.length > 0) {
      // #103 context-trim: cap to 3 requests (was 5), drop per-request hint
      // (lift to array level once), truncate long requests to 140 chars.
      state.player_requests = pending.slice(0, 3).map(c => {
        const req = String(c.command || '');
        return {
          from: c.from,
          request: req.length > 140 ? req.slice(0, 137) + '...' : req,
          channel: c.channel,
          ago: Math.round((now - c.time) / 1000) + 's',
        };
      });
      if (pending.length > 0) {
        state.player_requests_hint = 'mc acknowledge_command / mc complete_command / mc cancel_command';
      }
    }
    if (acknowledged.length > 0) {
      state.active_tasks = acknowledged.slice(0, 5).map(c => ({
        from: c.from,
        task: c.command,
        plan: c.plan || null,
        since: Math.round((now - (c.acknowledged_at || c.time)) / 1000) + 's',
      }));
    }
    const recentSocial = ctx.social.socialEvents.filter((entry) => now - entry.time < 60000).slice(-3)
      .map((entry) => `${entry.actor} ${entry.kind} via ${entry.channel}`);
    if (recentSocial.length > 0) state.social = recentSocial;

    // Water hazard — surfaces immediately so agent can react
    if (ctx.world.bot.entity?.isInWater) {
      state.hazard = 'SUBMERGED in water — mc stop then mc jump to swim up, navigate to shore';
    }

    // Repeated-failure loop detection
    const recent3 = ctx.tasks.actionHistory.slice(-3);
    if (recent3.length === 3 && recent3.every(e => e.status !== 'done' && e.action === recent3[0].action)) {
      state.action_loop = `You've tried "${recent3[0].action}" 3 times and failed — check mc inventory first, then try something different`;
    }

    // Show count of overheard messages (other agents' private conversations)
    const recentOverheard = ctx.social.overheardLog.filter(m => now - m.time < 60000).length;
    if (recentOverheard > 0) state.overheard_nearby = recentOverheard;
    if (ctx.tasks.currentTask && ctx.tasks.currentTask.status === 'stuck') state.task_stuck = ctx.tasks.currentTask.error;
    if (ctx.tasks.currentTask && ctx.tasks.currentTask.status === 'running') {
      state.task = { action: ctx.tasks.currentTask.action, elapsed: Math.round((Date.now() - ctx.tasks.currentTask.started) / 1000) + 's' };
    } else if (ctx.tasks.currentTask && ctx.tasks.currentTask.status === 'done') {
      state.task_done = ctx.tasks.currentTask.result?.result || 'completed';
    } else if (ctx.tasks.currentTask && ctx.tasks.currentTask.status === 'error') {
      state.task_error = ctx.tasks.currentTask.error;
    }

    refreshLeaseCheckpoint(ctx.tasks.currentTask);
    const tapi = taskToApi(ctx.tasks.currentTask);
    if (tapi?.needs_checkpoint) state.checkpoint_due = true;

    if (ctx.world.bot && ctx.world.mcData) {
      try {
        const { scored } = getGoalsScoreboard();
        if (scored[0]) {
          state.top_goal = { id: scored[0].id, urgency: scored[0].urgency, satisfied: scored[0].satisfied };
        }
      } catch {
        /* ignore */
      }
    }

    // Death / spawn context for recovery agents (item despawn is heuristic)
    const ITEM_DESPAWN_APPROX_SECONDS = 300;

    // spawn_point moved out of the default briefState — it's static and
    // pads every action response. Callers needing it should hit
    // `/observe` or `mc marks` (where it's now surfaced as a nearby mark).

    if (ctx.death.hardcoreDead) state.hardcore_dead = true;

    if (ctx.death.lastDeath) {
      const ageS = Math.round((now - ctx.death.lastDeath.time) / 1000);
      state.death_recent = ageS < 900;
      state.last_death_age_s = ageS;
      state.death_death_number = ctx.death.lastDeath.deathNumber;
      state.seconds_until_despawn_approx = Math.max(0, ITEM_DESPAWN_APPROX_SECONDS - ageS);
    }

    if (ctx.death.lastDamageEvent && now - ctx.death.lastDamageEvent.ts < 20000) {
      state.damage_telemetry = {
        last_damage: ctx.death.lastDamageEvent.amount,
        hp_after: ctx.death.lastDamageEvent.hp,
        seconds_ago: Math.round((now - ctx.death.lastDamageEvent.ts) / 1000),
      };
    }

    return state;
  }

  function buildObservePayload(opts = {}) {
    const lean = opts.lean === true;
    const brief = briefState();
    const { scored, context } = getGoalsScoreboard();
    refreshLeaseCheckpoint(ctx.tasks.currentTask);
    const task = taskToApi(ctx.tasks.currentTask);
    const alerts = buildTypedAlerts();
    const inv = ctx.world.bot && ctx.world.botReady ? ctx.world.bot.inventory.items() : [];
    const invSummary = {};
    for (const i of inv) {
      invSummary[i.name] = (invSummary[i.name] || 0) + i.count;
    }
    const dueReminders = fireDueReminders();

    // Compact nearby marks for situational awareness
    let nearbyMarks;
    try {
      const locs = loadLocations();
      const botPos = ctx.world.bot?.entity?.position;
      if (botPos && locs) {
        nearbyMarks = Object.entries(locs)
          .map(([name, l]) => {
            const dist = Math.round(Math.sqrt((botPos.x - l.x) ** 2 + (botPos.y - l.y) ** 2 + (botPos.z - l.z) ** 2));
            return { name, x: l.x, y: l.y, z: l.z, note: l.note || undefined, dist };
          })
          .filter(m => m.dist < 200)
          .sort((a, b) => a.dist - b.dist)
          .slice(0, lean ? 5 : 10);
      }
    } catch { /* ignore */ }

    // Lean goals: just id/urgency/satisfied/gap, top 5. Full goals are
    // ~300B each with strategies/constraints/metadata — most calls don't
    // need that detail.
    const leanGoals = (gs) => gs.slice(0, 5).map((g) => ({
      id: g.id, urgency: g.urgency, satisfied: g.satisfied, gap: g.gap,
    }));

    // Lean mode: drop inventory_summary + chest_snapshots — Steve uses
    // `mc inventory` / `mc chest`/`mc chest_search` on demand. Full
    // observe (lean=false) still carries them for the dashboard +
    // debugging.
    const payload = {
      ok: true,
      time: ctx.world.bot?.time?.timeOfDay,
      is_day: ctx.world.bot ? ctx.world.bot.time.timeOfDay < 12000 : null,
      state: brief,
      goals: lean ? leanGoals(scored) : scored.slice(0, 12),
      ...(lean ? {} : { goals_context: context, goals_plan_hints: buildGoalsPlanHints(scored) }),
      task,
      alerts,
      ...(lean ? {} : { inventory_summary: invSummary, chest_snapshots: ctx.goals.chestSnapshots }),
      nearby_marks: nearbyMarks?.length ? nearbyMarks : undefined,
      ...(lean ? {} : { dashboard_signals: buildDashboardSignals() }),
      last_api_error: ctx.tasks.lastApiError,
      recent_actions: lean
        ? [...ctx.tasks.actionHistory].slice(-5).reverse()
        : [...ctx.tasks.actionHistory].reverse(),
      ...(lean ? {} : { action_stats_5m: buildActionStats(ctx) }),
      auto_action_log: ctx.reactive.autoActionLog ? [...ctx.reactive.autoActionLog].slice(lean ? -4 : -16) : [],
      idle_reason: classifyIdleReason(ctx),
    };
    if (dueReminders.length) payload.reminders_due = dueReminders;
    return payload;
  }

  function buildLogisticsPayload() {
    const { scored } = getGoalsScoreboard();
    const inv = ctx.world.bot && ctx.world.botReady ? ctx.world.bot.inventory.items() : [];
    const invSummary = {};
    for (const i of inv) {
      invSummary[i.name] = (invSummary[i.name] || 0) + i.count;
    }
    const deficits = scored.filter((g) => !g.satisfied && g.enabled !== false).map((g) => ({
      id: g.id,
      metric: g.metric,
      gap: g.gap,
      target_ok: g.target_ok,
      urgency: g.urgency,
    }));
    return {
      ok: true,
      inventory: invSummary,
      goals_deficits: deficits,
      chest_snapshots: ctx.goals.chestSnapshots,
      marks: loadLocations(),
    };
  }

  function getFullState(opts = {}) {
    const lean = opts.lean === true;
    const b = ensureBot();
    const pos = b.entity.position;
    const inv = b.inventory.items();
    const time = b.time.timeOfDay;

    // Nearby entities (fair-play filtered)
    const rawEntities = Object.values(b.entities)
      .filter(e => e !== b.entity && e.position.distanceTo(pos) < (ctx.reactive.fairPlayMode ? FAIR_PLAY.LOS_ENTITY_RANGE : 24));
    const visibleEntities = filterEntitiesFairPlay(rawEntities);
    const entities = visibleEntities
      .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
      .slice(0, 15)
      .map(e => ({
        type: e.name || e.mobType || e.displayName || 'unknown',
        kind: e.type || (e.username ? 'player' : 'mob'),
        username: e.username || undefined,
        distance: fmt(e.position.distanceTo(pos)),
        position: posObj(e.position),
        health: e.health ?? undefined,
      }));

    // Nearby blocks (scan 5-block radius, aggregate by type)
    const blockCounts = {};
    const notableBlocks = []; // specific blocks worth calling out
    for (let dx = -5; dx <= 5; dx++) {
      for (let dy = -3; dy <= 4; dy++) {
        for (let dz = -5; dz <= 5; dz++) {
          const block = b.blockAt(pos.offset(dx, dy, dz));
          if (block && block.name !== 'air' && block.name !== 'cave_air') {
            blockCounts[block.name] = (blockCounts[block.name] || 0) + 1;
            // Note ores and interesting blocks with positions
            if (block.name.includes('ore') || block.name === 'crafting_table' || 
                block.name === 'furnace' || block.name === 'chest' ||
                block.name.includes('log') || block.name === 'water' ||
                block.name === 'lava') {
              if (notableBlocks.length < 20) {
                notableBlocks.push({
                  name: block.name,
                  position: { x: block.position.x, y: block.position.y, z: block.position.z },
                });
              }
            }
          }
        }
      }
    }

    const nearbyBlocks = Object.entries(blockCounts)
      .sort((a, c) => c[1] - a[1])
      .slice(0, lean ? 6 : 20)
      .map(([name, count]) => ({ name, count }));

    // What we're looking at. Scene summary is the heavy hitter inside
    // /status (~2KB). In lean mode we still build the summary text but
    // drop the structured visible_block_hits/visible_entities arrays.
    const scene = buildSceneSummary({ range: lean ? 12 : 16 });
    const leanScene = lean && scene ? { summary: scene.summary, range: scene.range } : null;
    const target = b.blockAtCursor?.(5);
    const lookingAt = target ? { name: target.name, position: posObj(target.position) } : null;

    // Biome
    const biome = b.blockAt(pos)?.biome?.name || 'unknown';

    // Unread chat
    const unreadChat = ctx.social.chatLog.length > 0 ? ctx.social.chatLog.slice(-5).map(m => ({
      from: m.from, message: m.message,
      ago: Math.round((Date.now() - m.time) / 1000) + 's',
    })) : [];

    // Lean mode drops fields that rarely change or aren't needed by the
    // agent's per-turn decisions (dimension, maxHealth, isDay/timePhase
    // are all derivable from time; experience, fairPlay/hardcore/
    // permanentlyDead never change during a session). Cuts /status?lean
    // payload roughly in half.
    return {
      health: fmt(b.health),
      ...(lean ? {} : { maxHealth: 20 }),
      food: b.food,
      saturation: fmt(b.foodSaturation),
      position: posObj(),
      ...(lean ? {} : { dimension: b.game?.dimension?.replace('minecraft:', '') || 'overworld' }),
      ...(lean ? {} : { biome }),
      time: time,
      ...(lean ? {} : { isDay: time < 12000 }),
      ...(lean ? {} : { timePhase: time < 6000 ? 'morning' : time < 12000 ? 'afternoon' : time < 18000 ? 'evening' : 'night' }),
      holding: ctx.world.bot.heldItem ? itemStr(ctx.world.bot.heldItem) : 'empty',
      // circuit-v16: explicit mounted-state on /status so the agent
      // doesn't lose track of "I'm on a boat" between actions.
      ...(ctx.world.bot.vehicle ? {
        mounted: {
          vehicle: ctx.world.bot.vehicle.name || ctx.world.bot.vehicle.type || 'unknown',
          vehicle_id: ctx.world.bot.vehicle.id,
          hint: 'You are mounted. Use mc sail X Y Z to travel; mc disembark to dismount. Do NOT call mc board or mc move while mounted.',
        },
      } : {}),
      ...(lean ? {} : { experience: { level: b.experience?.level || 0 } }),
      inventory: inv.map(i => ({ name: i.name, count: i.count })),
      ...(lean ? {} : { inventoryCount: inv.length }),
      nearbyBlocks,
      ...(lean ? {} : { notableBlocks }),
      nearbyEntities: lean ? entities.slice(0, 5) : entities,
      ...(entities.some(e => e.kind === 'player') ? {
        nearbyPlayers: entities.filter(e => e.kind === 'player').map(p => ({ name: p.username || p.type, distance: p.distance, position: p.position })),
      } : {}),
      lookingAt,
      // F45.8: always present so the brain has a stable signal of "you have
      // unread messages" without needing to call /chat to know whether to ask.
      unreadChat: { count: unreadChat.length, recent: unreadChat.slice(-3) },
      ...(ctx.death.deathLog.length > 0 ? { deaths: ctx.death.deathLog.length } : {}),
      ...(ctx.death.lastDeath ? { lastDeath: { position: ctx.death.lastDeath.position, seconds_ago: Math.round((Date.now()-ctx.death.lastDeath.time)/1000) } } : {}),
      ...(lean ? {} : { onGround: b.entity.onGround }),
      ...(b.isRaining ? { isRaining: true } : {}),
      ...(ctx.team.isSneaking ? { isSneaking: true } : {}),
      // Fair play: sound events (directional hints without exact positions)
      ...(ctx.runtime.soundEvents.length > 0 ? {
        sounds: ctx.runtime.soundEvents.slice(lean ? -2 : -5),
      } : {}),
      scene: leanScene || scene,
      ...(lean ? {} : { social_summary: summarizeSocialGraph(ctx.social.socialGraph) }),
      // Team info
      ...(ctx.team.teamConfig.team ? {
        team: {
          name: ctx.team.teamConfig.team,
          role: ctx.team.teamConfig.role,
          rallyPoint: ctx.team.teamConfig.rallyPoint,
          recentTeamChat: ctx.team.teamConfig.teamChat.slice(-3),
        },
      } : {}),
      // Combat stats
      ...((ctx.team.combatStats.kills + ctx.team.combatStats.deaths > 0) ? { combatStats: ctx.team.combatStats } : {}),
      // Active furnaces
      ...(ctx.team.activeFurnaces.length > 0 ? {
        activeFurnaces: ctx.team.activeFurnaces.map(f => ({
          position: { x: f.x, y: f.y, z: f.z },
          input: f.input,
          estimatedDone: f.estimatedDone ? Math.max(0, Math.round((f.estimatedDone - Date.now()) / 1000)) + 's' : 'unknown',
        })),
      } : {}),
      ...(lean ? {} : { fairPlay: ctx.reactive.fairPlayMode }),
      ...(b.game?.hardcore ? { hardcore: true } : {}),
      ...(ctx.death.hardcoreDead ? { permanentlyDead: true } : {}),
    };
  }

  function getInventory() {
    const b = ensureBot();
    const items = b.inventory.items();
    if (items.length === 0) {
      return {
        items: [],
        summary: 'empty',
        advisories: ['inventory empty — no tools to mine, chop, or fight. craft basics first'],
      };
    }

    const categories = {};
    const toolWear = []; // F54.3: collect durability info for advisories
    items.forEach(item => {
      const n = item.name;
      let cat = 'other';
      if (n.includes('pickaxe') || n.includes('_axe') || n.includes('shovel') || n.includes('hoe') || n === 'shears' || n === 'flint_and_steel') cat = 'tools';
      else if (n.includes('sword') || n.includes('bow') || n === 'crossbow' || n === 'trident') cat = 'weapons';
      else if (n.includes('helmet') || n.includes('chestplate') || n.includes('leggings') || n.includes('boots') || n === 'shield') cat = 'armor';
      else if (n.includes('cooked') || n.includes('bread') || n.includes('apple') || n.includes('steak') || n.includes('porkchop') || n.includes('chicken') || n.includes('salmon') || n.includes('potato') || n === 'mushroom_stew') cat = 'food';
      else if (n.includes('ingot') || n.includes('diamond') || n.includes('coal') || n.includes('redstone') || n.includes('lapis') || n.includes('stick') || n.includes('string') || n.includes('flint') || n.includes('blaze') || n.includes('ender_pearl')) cat = 'materials';
      else if (ctx.world.mcData?.blocksByName[n]) cat = 'blocks';

      if (!categories[cat]) categories[cat] = [];
      categories[cat].push({ name: n, count: item.count });

      // F54.3: track wear on durable items so we can flag near-broken tools.
      // Mineflayer 1.21 surfaces damage via item.components (array of
      // {type,data}); legacy item.durability/nbt fallback for older versions.
      if (cat === 'tools' || cat === 'weapons' || cat === 'armor') {
        const max = item.maxDurability;
        if (max && max > 0) {
          let damage = 0;
          if (Array.isArray(item.components)) {
            const dmg = item.components.find((c) => c && c.type === 'damage');
            if (dmg && typeof dmg.data === 'number') damage = dmg.data;
          } else if (item.durability != null) {
            damage = item.durability;
          }
          const remaining = Math.max(0, max - damage);
          const pct = Math.max(0, Math.min(100, Math.round((remaining / max) * 100)));
          toolWear.push({ name: n, remaining, max, pct });
        }
      }
    });

    // F54.3: derive state-describing advisories. State only — no goal
    // semantics (which would be coordination, not primitive correctness).
    const advisories = [];
    const tools = categories.tools || [];
    const hasPickaxe = tools.some((t) => t.name.endsWith('_pickaxe'));
    const hasAxe = tools.some((t) => t.name.endsWith('_axe') && !t.name.endsWith('_pickaxe'));
    if (!hasPickaxe) advisories.push('no pickaxe — cannot mine stone/ore. craft wooden_pickaxe (3 planks + 2 sticks)');
    if (!hasAxe) advisories.push('no axe — wood chopping is slow without one. craft wooden_axe (3 planks + 2 sticks)');
    for (const td of toolWear) {
      if (td.pct <= 10) {
        advisories.push(`${td.name} near breaking (${td.remaining}/${td.max} durability, ${td.pct}%) — craft a spare`);
      }
    }

    return {
      categories,
      totalSlots: items.length,
      ...(advisories.length ? { advisories } : {}),
    };
  }

  function getNearby(radius = 32) {
    const b = ensureBot();
    const pos = b.entity.position;

    // Entities (fair-play filtered)
    const rawEnts = Object.values(b.entities)
      .filter(e => e !== b.entity && e.position.distanceTo(pos) < radius);
    const entities = filterEntitiesFairPlay(rawEnts)
      .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
      .slice(0, 20)
      .map(e => ({
        type: e.name || e.mobType || 'unknown',
        distance: fmt(e.position.distanceTo(pos)),
        position: posObj(e.position),
        health: e.health,
        kind: e.type, // 'mob', 'player', 'object', etc.
      }));

    // Notable blocks in wider radius.
    //
    // Phase-2 perception fix (BUG t_dc89c01b):
    //   - Iterate from the BOT'S FLOORED INTEGER coord (not pos.offset(dx)),
    //     so fractional bot X/Z (e.g. (0.5, _, 0.5) at the spawn platform)
    //     doesn't silently lose half of integer-X targets to Math.floor in
    //     blockAt. Stride 1 in dx/dz now covers every integer column.
    //   - Drop the common-block name exclusion (was: stone/dirt/grass_block/
    //     deepslate). Aggregation by name + nearest + top-25 already prevents
    //     flooding, and workers need to see deliberately placed terrain
    //     blocks (walls, dirt mounds, etc.). Air/cave_air/void_air still
    //     filtered (they're "no block").
    //   - Surface the truncation explicitly: requested_radius + truncated
    //     so callers know when scanRadius < radius.
    const blockTypes = {};
    const SCAN_RADIUS_CAP = 16;
    const scanR = Math.min(radius, SCAN_RADIUS_CAP);
    const ix = Math.floor(pos.x);
    const iy = Math.floor(pos.y);
    const iz = Math.floor(pos.z);
    for (let dx = -scanR; dx <= scanR; dx++) {
      for (let dy = -8; dy <= 8; dy++) {
        for (let dz = -scanR; dz <= scanR; dz++) {
          const block = b.blockAt(new Vec3(ix + dx, iy + dy, iz + dz));
          if (!block) continue;
          if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
          if (!blockTypes[block.name]) blockTypes[block.name] = { count: 0, nearest: null, nearestDist: Infinity };
          blockTypes[block.name].count++;
          const dist = pos.distanceTo(block.position);
          if (dist < blockTypes[block.name].nearestDist) {
            blockTypes[block.name].nearest = posObj(block.position);
            blockTypes[block.name].nearestDist = dist;
          }
        }
      }
    }

    const blocks = Object.entries(blockTypes)
      .sort((a, c) => c[1].count - a[1].count)
      .slice(0, 25)
      .map(([name, info]) => ({ name, count: info.count, nearest: info.nearest }));

    return {
      entities,
      blocks,
      scanRadius: scanR,
      requested_radius: radius,
      truncated: radius > SCAN_RADIUS_CAP,
    };
  }

  return {
    getGoalsScoreboard,
    buildTypedAlerts,
    buildDashboardSignals,
    buildGoalsPlanHints,
    briefState,
    buildObservePayload,
    buildLogisticsPayload,
    getFullState,
    getInventory,
    getNearby,
  };
}
