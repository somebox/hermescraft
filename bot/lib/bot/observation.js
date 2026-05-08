import { scoreGoals } from '../goals/engine.js';
import { refreshLeaseCheckpoint, taskToApi } from '../goals/tasks.js';
import { summarizeSocialGraph } from '../shared/chat.js';

export function createObservation(deps) {
  const { ctx, ensureBot, fmt, posObj, loadLocations, filterEntitiesFairPlay, buildSceneSummary, fireDueReminders, FAIR_PLAY, itemStr } = deps;

  function getGoalsScoreboard() {
    if (!ctx.bot || !ctx.botReady || !ctx.mcData) return { scored: [], context: null };
    const { scored, context, deficitSince } = scoreGoals(ctx.bot, ctx.mcData, ctx.goalsStore, ctx.chestSnapshots);
    ctx.goalsStore.deficitSince = deficitSince;
    return { scored, context };
  }

  function buildTypedAlerts() {
    if (!ctx.bot || !ctx.botReady) return [];
    const list = [];
    const pos = ctx.bot.entity.position;
    const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned', 'phantom', 'husk', 'stray'];
    const ents = Object.values(ctx.bot.entities || {}).filter((e) => e !== ctx.bot.entity && e.position);
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
    for (const s of ctx.soundEvents.slice(-5)) {
      list.push({
        type: 'sound',
        kind: s.type,
        direction: s.direction,
        distance: s.distance,
      });
    }
    if (ctx.bot.entity.isInWater) {
      list.push({ type: 'hazard', kind: 'water', message: 'submerged' });
    }
    return list;
  }

  /** Keywords → coarse topics for dashboard ("Hermes wants chickens" vs scored goals store). */
  function buildDashboardSignals() {
    const pending = ctx.commandQueue
      .filter((c) => c.status === 'pending')
      .slice(0, 10)
      .map((c) => ({
        from: c.from,
        command: c.command,
        channel: c.channel || null,
        status: 'pending',
      }));
    const active = ctx.commandQueue
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
    const merged = [...ctx.chatLog, ...ctx.overheardLog].sort((a, b) => (b.time || 0) - (a.time || 0));
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

  function briefState() {
    if (!ctx.bot || !ctx.botReady) return null;

    // Grab recent chat so AI sees messages that arrived during action.
    // Player messages use a longer window (2 min) so they survive long-running actions.
    // Nearby broadcasts are capped at 2 most recent to reduce cascade noise.
    const now = Date.now();
    const playerMsgs = ctx.chatLog
      .filter(m => now - m.time < 120000 && m.from !== ctx.bot.username && m.from !== 'Server');
    const directMsgs = playerMsgs.filter(m => m.private || m.whisper);
    const broadcastMsgs = playerMsgs.filter(m => !m.private && !m.whisper).slice(-3);
    const recentChat = [...directMsgs, ...broadcastMsgs]
      .sort((a, b) => a.time - b.time)
      .map(m => ({
        from: m.from,
        message: m.message,
        ago: Math.round((now - m.time) / 1000) + 's',
        ...(m.private || m.whisper ? { direct: true } : {}),
      }));

    // Grab active commands (pending or acknowledged)
    const pending = ctx.commandQueue.filter(c => c.status === 'pending');
    const acknowledged = ctx.commandQueue.filter(c => c.status === 'acknowledged');

    const state = {
      health: fmt(ctx.bot.health),
      food: ctx.bot.food,
      position: posObj(),
      holding: ctx.bot.heldItem?.name || 'empty',
      time: ctx.bot.time.timeOfDay,
      isDay: ctx.bot.time.timeOfDay < 12000,
    };

    // Nearby utility blocks — so the AI knows what resources are at hand
    try {
      const utilIds = ['crafting_table', 'furnace', 'chest', 'anvil', 'smithing_table', 'enchanting_table']
        .map(n => ctx.mcData.blocksByName[n]?.id).filter(id => id != null);
      const found = ctx.bot.findBlocks({ matching: utilIds, maxDistance: 16, count: 10 });
      if (found.length > 0) {
        state.nearby_utilities = found.slice(0, 6).map(p => {
          const bl = ctx.bot.blockAt(p);
          return { name: bl?.name || '?', x: p.x, y: p.y, z: p.z };
        });
      }
    } catch { /* ignore */ }

    if (recentChat.length > 0) state.new_chat = recentChat;
    if (pending.length > 0) {
      state.player_requests = pending.slice(0, 5).map(c => ({
        from: c.from,
        request: c.command,
        channel: c.channel,
        ago: Math.round((now - c.time) / 1000) + 's',
        hint: 'Use mc acknowledge_command to confirm, mc complete_command when done, or mc cancel_command if impossible.',
      }));
    }
    if (acknowledged.length > 0) {
      state.active_tasks = acknowledged.slice(0, 5).map(c => ({
        from: c.from,
        task: c.command,
        plan: c.plan || null,
        since: Math.round((now - (c.acknowledged_at || c.time)) / 1000) + 's',
      }));
    }
    const recentSocial = ctx.socialEvents.filter((entry) => now - entry.time < 60000).slice(-3)
      .map((entry) => `${entry.actor} ${entry.kind} via ${entry.channel}`);
    if (recentSocial.length > 0) state.social = recentSocial;

    // Water hazard — surfaces immediately so agent can react
    if (ctx.bot.entity.isInWater) {
      state.hazard = 'SUBMERGED in water — mc stop then mc jump to swim up, navigate to shore';
    }

    // Repeated-failure loop detection
    const recent3 = ctx.actionHistory.slice(-3);
    if (recent3.length === 3 && recent3.every(e => e.status !== 'done' && e.action === recent3[0].action)) {
      state.action_loop = `You've tried "${recent3[0].action}" 3 times and failed — check mc inventory first, then try something different`;
    }

    // Show count of overheard messages (other agents' private conversations)
    const recentOverheard = ctx.overheardLog.filter(m => now - m.time < 60000).length;
    if (recentOverheard > 0) state.overheard_nearby = recentOverheard;
    if (ctx.currentTask && ctx.currentTask.status === 'stuck') state.task_stuck = ctx.currentTask.error;
    if (ctx.currentTask && ctx.currentTask.status === 'running') {
      state.task = { action: ctx.currentTask.action, elapsed: Math.round((Date.now() - ctx.currentTask.started) / 1000) + 's' };
    } else if (ctx.currentTask && ctx.currentTask.status === 'done') {
      state.task_done = ctx.currentTask.result?.result || 'completed';
    } else if (ctx.currentTask && ctx.currentTask.status === 'error') {
      state.task_error = ctx.currentTask.error;
    }

    refreshLeaseCheckpoint(ctx.currentTask);
    const tapi = taskToApi(ctx.currentTask);
    if (tapi?.needs_checkpoint) state.checkpoint_due = true;

    if (ctx.bot && ctx.mcData) {
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

    try {
      const locs = loadLocations();
      if (locs.spawn?.x !== undefined && locs.spawn?.y !== undefined && locs.spawn?.z !== undefined) {
        state.spawn_point = { x: locs.spawn.x, y: locs.spawn.y, z: locs.spawn.z };
      }
    } catch {
      /* ignore */
    }

    if (ctx.hardcoreDead) state.hardcore_dead = true;

    if (ctx.lastDeath) {
      const ageS = Math.round((now - ctx.lastDeath.time) / 1000);
      state.death_recent = ageS < 900;
      state.last_death_age_s = ageS;
      state.death_death_number = ctx.lastDeath.deathNumber;
      state.seconds_until_despawn_approx = Math.max(0, ITEM_DESPAWN_APPROX_SECONDS - ageS);
    }

    if (ctx.lastDamageEvent && now - ctx.lastDamageEvent.ts < 20000) {
      state.damage_telemetry = {
        last_damage: ctx.lastDamageEvent.amount,
        hp_after: ctx.lastDamageEvent.hp,
        seconds_ago: Math.round((now - ctx.lastDamageEvent.ts) / 1000),
      };
    }

    return state;
  }

  function buildObservePayload() {
    const brief = briefState();
    const { scored, context } = getGoalsScoreboard();
    refreshLeaseCheckpoint(ctx.currentTask);
    const task = taskToApi(ctx.currentTask);
    const alerts = buildTypedAlerts();
    const inv = ctx.bot && ctx.botReady ? ctx.bot.inventory.items() : [];
    const invSummary = {};
    for (const i of inv) {
      invSummary[i.name] = (invSummary[i.name] || 0) + i.count;
    }
    const dueReminders = fireDueReminders();

    // Compact nearby marks for situational awareness
    let nearbyMarks;
    try {
      const locs = loadLocations();
      const botPos = ctx.bot?.entity?.position;
      if (botPos && locs) {
        nearbyMarks = Object.entries(locs)
          .map(([name, l]) => {
            const dist = Math.round(Math.sqrt((botPos.x - l.x) ** 2 + (botPos.y - l.y) ** 2 + (botPos.z - l.z) ** 2));
            return { name, x: l.x, y: l.y, z: l.z, note: l.note || undefined, dist };
          })
          .filter(m => m.dist < 200)
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 10);
      }
    } catch { /* ignore */ }

    const payload = {
      ok: true,
      time: ctx.bot?.time?.timeOfDay,
      is_day: ctx.bot ? ctx.bot.time.timeOfDay < 12000 : null,
      state: brief,
      goals: scored.slice(0, 12),
      goals_context: context,
      goals_plan_hints: buildGoalsPlanHints(scored),
      task,
      alerts,
      inventory_summary: invSummary,
      chest_snapshots: ctx.chestSnapshots,
      nearby_marks: nearbyMarks?.length ? nearbyMarks : undefined,
      dashboard_signals: buildDashboardSignals(),
      last_api_error: ctx.lastApiError,
      recent_actions: [...ctx.actionHistory].reverse(),
    };
    if (dueReminders.length) payload.reminders_due = dueReminders;
    return payload;
  }

  function buildLogisticsPayload() {
    const { scored } = getGoalsScoreboard();
    const inv = ctx.bot && ctx.botReady ? ctx.bot.inventory.items() : [];
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
      chest_snapshots: ctx.chestSnapshots,
      marks: loadLocations(),
    };
  }

  function getFullState() {
    const b = ensureBot();
    const pos = b.entity.position;
    const inv = b.inventory.items();
    const time = b.time.timeOfDay;

    // Nearby entities (fair-play filtered)
    const rawEntities = Object.values(b.entities)
      .filter(e => e !== b.entity && e.position.distanceTo(pos) < (ctx.fairPlayMode ? FAIR_PLAY.LOS_ENTITY_RANGE : 24));
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
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    // What we're looking at
    const scene = buildSceneSummary({ range: 16 });
    const target = b.blockAtCursor?.(5);
    const lookingAt = target ? { name: target.name, position: posObj(target.position) } : null;

    // Biome
    const biome = b.blockAt(pos)?.biome?.name || 'unknown';

    // Unread chat
    const unreadChat = ctx.chatLog.length > 0 ? ctx.chatLog.slice(-5).map(m => ({
      from: m.from, message: m.message,
      ago: Math.round((Date.now() - m.time) / 1000) + 's',
    })) : [];

    return {
      health: fmt(b.health),
      maxHealth: 20,
      food: b.food,
      saturation: fmt(b.foodSaturation),
      position: posObj(),
      dimension: b.game?.dimension?.replace('minecraft:', '') || 'overworld',
      biome,
      time: time,
      isDay: time < 12000,
      timePhase: time < 6000 ? 'morning' : time < 12000 ? 'afternoon' : time < 18000 ? 'evening' : 'night',
      holding: ctx.bot.heldItem ? itemStr(ctx.bot.heldItem) : 'empty',
      experience: { level: b.experience?.level || 0 },
      inventory: inv.map(i => ({ name: i.name, count: i.count })),
      inventoryCount: inv.length,
      nearbyBlocks,
      notableBlocks,
      nearbyEntities: entities,
      nearbyPlayers: entities.filter(e => e.kind === 'player').map(p => ({ name: p.username || p.type, distance: p.distance, position: p.position })),
      lookingAt,
      unreadChat: unreadChat.length > 0 ? unreadChat : undefined,
      deaths: ctx.deathLog.length,
      lastDeath: ctx.lastDeath ? { position: ctx.lastDeath.position, seconds_ago: Math.round((Date.now()-ctx.lastDeath.time)/1000) } : null,
      onGround: b.entity.onGround,
      isRaining: b.isRaining,
      isSneaking: ctx.isSneaking,
      // Fair play: sound events (directional hints without exact positions)
      sounds: ctx.soundEvents.length > 0 ? ctx.soundEvents.slice(-5) : undefined,
      scene,
      social_summary: summarizeSocialGraph(ctx.socialGraph),
      // Team info
      team: ctx.teamConfig.team ? {
        name: ctx.teamConfig.team,
        role: ctx.teamConfig.role,
        rallyPoint: ctx.teamConfig.rallyPoint,
        recentTeamChat: ctx.teamConfig.teamChat.slice(-3),
      } : undefined,
      // Combat stats
      combatStats: (ctx.combatStats.kills + ctx.combatStats.deaths > 0) ? ctx.combatStats : undefined,
      // Active furnaces
      activeFurnaces: ctx.activeFurnaces.length > 0 ? ctx.activeFurnaces.map(f => ({
        position: { x: f.x, y: f.y, z: f.z },
        input: f.input,
        estimatedDone: f.estimatedDone ? Math.max(0, Math.round((f.estimatedDone - Date.now()) / 1000)) + 's' : 'unknown',
      })) : undefined,
      fairPlay: ctx.fairPlayMode,
      hardcore: ctx.bot.game?.hardcore || false,
      permanentlyDead: ctx.hardcoreDead,
    };
  }

  function getInventory() {
    const b = ensureBot();
    const items = b.inventory.items();
    if (items.length === 0) return { items: [], summary: 'empty' };

    const categories = {};
    items.forEach(item => {
      const n = item.name;
      let cat = 'other';
      if (n.includes('pickaxe') || n.includes('_axe') || n.includes('shovel') || n.includes('hoe') || n === 'shears' || n === 'flint_and_steel') cat = 'tools';
      else if (n.includes('sword') || n.includes('bow') || n === 'crossbow' || n === 'trident') cat = 'weapons';
      else if (n.includes('helmet') || n.includes('chestplate') || n.includes('leggings') || n.includes('boots') || n === 'shield') cat = 'armor';
      else if (n.includes('cooked') || n.includes('bread') || n.includes('apple') || n.includes('steak') || n.includes('porkchop') || n.includes('chicken') || n.includes('salmon') || n.includes('potato') || n === 'mushroom_stew') cat = 'food';
      else if (n.includes('ingot') || n.includes('diamond') || n.includes('coal') || n.includes('redstone') || n.includes('lapis') || n.includes('stick') || n.includes('string') || n.includes('flint') || n.includes('blaze') || n.includes('ender_pearl')) cat = 'materials';
      else if (ctx.mcData?.blocksByName[n]) cat = 'blocks';

      if (!categories[cat]) categories[cat] = [];
      categories[cat].push({ name: n, count: item.count });
    });

    return { categories, totalSlots: items.length };
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

    // Notable blocks in wider radius
    const blockTypes = {};
    const scanR = Math.min(radius, 16); // block scan limited for performance
    for (let dx = -scanR; dx <= scanR; dx += 2) {
      for (let dy = -8; dy <= 8; dy++) {
        for (let dz = -scanR; dz <= scanR; dz += 2) {
          const block = b.blockAt(pos.offset(dx, dy, dz));
          if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'stone' && block.name !== 'dirt' && block.name !== 'grass_block' && block.name !== 'deepslate') {
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
    }

    const blocks = Object.entries(blockTypes)
      .sort((a, c) => c[1].count - a[1].count)
      .slice(0, 25)
      .map(([name, info]) => ({ name, count: info.count, nearest: info.nearest }));

    return { entities, blocks, scanRadius: scanR };
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
