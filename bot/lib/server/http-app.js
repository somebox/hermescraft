/** @size-exempt: thin GET handlers + task control-plane + dispatchAction proxy */
/**
 * Mineflayer bot HTTP listener factory — extracted from server.js for readability and testing.
 */
import { dispatchAction, pushAction, recordActionOutcome, recordLastApiError } from './middleware/task-lifecycle.js';
import { probeRouteAlongLine, probeRouteCorridor } from './route-probe.js';
import { planWaterRoute, _internals as _waterRouteInternals } from '../runtime/water-route.js';
import { normalizeId } from '../runtime/regions/index.js';
import { buildRegionResolveArgs } from '../runtime/regions/policy-guard.js';
import { getBuildInfo } from '../runtime/build-info.js';
import { sceneToolNeeds } from '../runtime/inventory-hints.js';

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

export function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

/** @param {Record<string, any>} deps */
export function createBotHttpListener(deps) {
  const {
    config,
    ctx,
    spatial,
    actionRegistry,
    ensureBot,
    briefState,
    getFullState,
    buildMarksListApi,
    getInventory,
    getNearby,
    buildSceneSummary,
    summarizeSocialGraph,
    refreshLeaseCheckpoint,
    taskToApi,
    persistGoalsToDisk,
    listPresets,
    getGoalsScoreboard,
    buildObservePayload,
    buildTypedAlerts,
    buildLogisticsPayload,
    loadPreset,
    mergePresetIntoStore,
    createTaskRecord,
    pushTaskHistoryRecord,
    renewLease,
    createBot,
    viewerPort = null,
  } = deps;

  // Services proxy: dispatchAction expects a services-shaped container
  // (.state, .ensureBot, …). Until http-app itself moves to services-only,
  // we synthesize one from the legacy deps bag.
  const servicesProxy = { state: ctx, ensureBot };

  return async function botHttpListener(req, res) {

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${config.api.port}`);
  const path = url.pathname;

  try {
    // ── Mixed-method endpoints (do own dispatch; must be top-level) ────
    // These handle GET/POST/DELETE on the same path and live before the
    // method-specific branches so non-GET requests don't get swallowed
    // by the catch-all 404. Caught 2026-05-27: Mason's `mc task_context
    // set hut1` (POST) was returning "Unknown endpoint" because this
    // block lived inside the `if (req.method === 'GET')` branch — only
    // GET reached the handler; POST/DELETE fell through to the 404 at
    // line ~889. The verb is documented at registry.mjs:1716 and is the
    // worker pattern for protect-region worksite grants — without it,
    // every protect-intent region is unusable for build work.
    if (path === '/task-context') {
      const TASK_DEFAULT_MS = 30 * 60 * 1000;
      const TASK_MAX_MS = 4 * 60 * 60 * 1000;
      if (req.method === 'GET') {
        return respond(res, 200, { ok: true, data: { task_context: ctx.runtime.taskContext } });
      }
      if (req.method === 'DELETE') {
        ctx.runtime.taskContext = null;
        return respond(res, 200, { ok: true, data: { cleared: true } });
      }
      if (req.method === 'POST') {
        let body;
        try {
          body = await parseBody(req);
        } catch (e) {
          return respond(res, 400, { ok: false, error: { message: e.message } });
        }
        const cardId = String(body.card_id || body.card || '').trim();
        if (!cardId) {
          return respond(res, 400, {
            ok: false,
            error: { code: 'MISSING_CARD_ID', message: 'task-context requires card_id' },
          });
        }
        const now = Date.now();
        let expiresAt = now + TASK_DEFAULT_MS;
        if (body.expires_at_ms != null && Number.isFinite(Number(body.expires_at_ms))) {
          expiresAt = Number(body.expires_at_ms);
        } else if (body.expires_min != null && Number.isFinite(Number(body.expires_min))) {
          expiresAt = now + Number(body.expires_min) * 60 * 1000;
        }
        const maxExp = now + TASK_MAX_MS;
        if (expiresAt > maxExp) expiresAt = maxExp;
        if (expiresAt < now) expiresAt = now + TASK_DEFAULT_MS;
        const worksiteRaw = body.worksite_region ?? body.worksite ?? null;
        const worksite_region =
          worksiteRaw != null && String(worksiteRaw).trim() !== ''
            ? normalizeId(worksiteRaw)
            : null;
        ctx.runtime.taskContext = {
          card_id: cardId,
          worksite_region,
          expires_at: expiresAt,
          source: String(body.source || 'http'),
        };
        return respond(res, 200, { ok: true, data: { task_context: ctx.runtime.taskContext } });
      }
      return respond(res, 405, { ok: false, error: { message: 'Method not allowed' } });
    }

    // POST /regions/reload — re-read regions JSON from disk + re-apply
    // profile normalization. Lets the operator edit
    // data/regions-world.json (e.g. flip an intent or add a
    // capability_overrides block) and have the change take effect in
    // running bots without a restart. Caught 2026-05-27: file edits
    // were invisible to the in-memory cache, which is loaded once at
    // createRegionStore() time.
    if (path === '/regions/reload' && req.method === 'POST') {
      ensureBot();
      const store = ctx.runtime.regions;
      if (!store) {
        return respond(res, 503, { ok: false, error: { message: 'regions store not initialized' } });
      }
      store.reload();
      const regions = store.list();
      return respond(res, 200, {
        ok: true,
        data: {
          world: store.world,
          region_count: regions.length,
          regions: regions.map((r) => ({
            id: r.id,
            intent: r.intent,
            profile: r.profile,
            capabilities: r.capabilities,
          })),
        },
      });
    }

    // ── GET endpoints (observation) ──────────────
    if (req.method === 'GET') {
      if (path === '/health' || path === '/') {
        const alive = !ctx.world.bot || ctx.world.bot.isAlive !== false;
        const connected = !!(ctx.world.botReady && alive);
        const pos = connected && ctx.world.bot?.entity ? ctx.world.bot.entity.position : null;
        const boot = typeof ctx.world.bootTime === 'number' ? ctx.world.bootTime : Date.now();
        const sessionStart =
          typeof ctx.world.mcSessionStartedAt === 'number' ? ctx.world.mcSessionStartedAt : boot;
        const uptimeSec = Math.round((Date.now() - sessionStart) / 1000);
        let moveRate = null;
        const positionHistory = ctx.world.positionHistory || [];
        if (positionHistory.length >= 2) {
          const recent = positionHistory;
          const first = recent[0];
          const last = recent[recent.length - 1];
          const dt = (last.time - first.time) / 1000;
          if (dt > 2) {
            const dist = Math.sqrt((last.x - first.x) ** 2 + (last.z - first.z) ** 2);
            moveRate = +(dist / dt).toFixed(2);
          }
        }
        // Stuck detection: how long has the bot been within a 5-block radius
        // of its current position? If the oldest history sample within radius
        // is N minutes old AND the bot HAS moved before that (or history is
        // saturated), the agent has been spinning in the same area for N min.
        let stuckMinutes = null;
        let stuckWarning = null;
        if (connected && pos && positionHistory.length >= 4) {
          const STUCK_RADIUS = 5; // blocks
          const STUCK_THRESHOLD_MIN = 5;
          const now = Date.now();
          // Walk history backwards from newest; find the OLDEST sample still
          // within the radius. Everything between that and now is "stuck."
          let oldestInRadius = positionHistory[positionHistory.length - 1];
          for (let i = positionHistory.length - 1; i >= 0; i--) {
            const p = positionHistory[i];
            const d = Math.sqrt((pos.x - p.x) ** 2 + (pos.y - p.y) ** 2 + (pos.z - p.z) ** 2);
            if (d > STUCK_RADIUS) break;
            oldestInRadius = p;
          }
          stuckMinutes = +((now - oldestInRadius.time) / 60000).toFixed(1);
          if (stuckMinutes >= STUCK_THRESHOLD_MIN) {
            stuckWarning =
              `STUCK ${stuckMinutes}min at (${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}). ` +
              `Local iteration is failing. REQUIRED next action: ` +
              `(1) mc advise --reason="stuck ${stuckMinutes}min: <one-line what you tried>" --target ${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}, ` +
              `OR (2) kanban_block reason="stuck:<short>" with a kanban_comment naming what you need. ` +
              `Do NOT retry the same approach.`;
          }
        }
        return respond(res, 200, {
          ok: true,
          connected,
          username: config.mc.username,
          profile: config.agent.profile,
          model: config.agent.model || null,
          provider: config.agent.provider || null,
          server: `${config.mc.host}:${config.mc.port}`,
          viewer_port: viewerPort ?? null,
          uptime_sec: uptimeSec,
          session_started_at: connected && typeof ctx.world.mcSessionStartedAt === 'number'
            ? ctx.world.mcSessionStartedAt
            : null,
          holding: connected && ctx.world.bot?.heldItem ? ctx.world.bot.heldItem.name : null,
          position: pos ? { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) } : null,
          move_rate: moveRate,
          stuck_minutes: stuckMinutes,
          ...(stuckWarning ? { stuck_warning: stuckWarning } : {}),
          build: getBuildInfo(),
        });
      }

      if (path === '/status') {
        const lean = url.searchParams.get('lean') === 'true';
        // F51.2 / F58: the agent's `mc status` (GET /status) is its
        // explicit "I'm rethinking" — clear lastMoveFailed, the
        // escape-loop counter, and the stuck-cell registry so the next
        // position-dependent verb runs fresh.
        //
        // `?preserve=true` opts OUT for diagnostic callers (dashboard
        // poll, test-suite bot_trace, observability harnesses) that
        // need to read state without perturbing it. The agent never
        // sets this flag.
        const preserve = url.searchParams.get('preserve') === 'true';
        if (!preserve) {
          if (ctx.runtime.lastMoveFailed) ctx.runtime.lastMoveFailed = null;
          ctx.runtime.recentEscapes = [];
          ctx.runtime.recentStuckCells = [];
        }
        return respond(res, 200, { ok: true, data: getFullState({ lean }) });
      }

      if (path === '/marks') {
        ensureBot();
        return respond(res, 200, { ok: true, data: { marks: buildMarksListApi() } });
      }

      if (path === '/regions') {
        ensureBot();
        const store = ctx.runtime.regions;
        if (!store) {
          return respond(res, 200, { ok: true, data: { world: null, regions: [] } });
        }
        const botPos = ctx.world.bot?.entity?.position ?? null;
        let preview = null;
        const atParam = url.searchParams.get('at');
        if (atParam) {
          const parts = atParam.split(/[,\s]+/).map(Number);
          if (parts.length >= 3 && parts.every(Number.isFinite)) {
            const [x, y, z] = parts;
            preview = {
              at: { x, y, z },
              dig: store.resolve('dig', buildRegionResolveArgs(ctx, { ad_hoc: true }), { x, y, z }, 'cobblestone'),
              place: store.resolve('place', buildRegionResolveArgs(ctx, { ad_hoc: true }), { x, y, z }, 'dirt'),
            };
          }
        }
        return respond(res, 200, {
          ok: true,
          data: {
            world: store.world,
            regions: store.listForApi({ botPos }),
            regions_here: store.regionsHere(botPos),
            task_context: ctx.runtime.taskContext,
            preview,
          },
        });
      }

      if (path === '/inventory') {
        return respond(res, 200, { ok: true, data: getInventory() });
      }

      if (path === '/nearby') {
        const radius = parseInt(url.searchParams.get('radius') || '32', 10);
        const fairPlay = url.searchParams.get('fair_play') !== 'false';
        const entityLimit = parseInt(url.searchParams.get('entity_limit') || '20', 10);
        return respond(res, 200, {
          ok: true,
          data: getNearby(radius, { fairPlay, entityLimit }),
        });
      }

      // ASCII top-down map of surroundings.
      // Radius clamped: default 12, max 16. A 33×33 grid (r=16) is already
      // ~1k chars of payload — brains have called r=32 (65×65 ≈ 4k chars)
      // when stuck, blowing the token budget for no value. Cap loudly so
      // the prompt-side rule sticks.
      if (path === '/map') {
        const raw = parseInt(url.searchParams.get('radius') || '12');
        const radius = Math.max(4, Math.min(16, Number.isFinite(raw) ? raw : 12));
        const data = spatial.generateMap(radius);
        if (data && raw !== radius) data.radius_clamped_from = raw;
        return respond(res, 200, { ok: true, data });
      }

      // Narrative description of what you see (human-readable)
      if (path === '/look') {
        return respond(res, 200, { ok: true, data: spatial.generateLookAround() });
      }

      // Target-bearing terrain probe (task #6). Sample `samples` evenly-spaced
      // blocks along the bot→(to_x, to_y, to_z) line and classify each as
      // water / land / hazard / etc. Lets the advise LLM decide boat vs walk
      // from concrete data instead of inferring from the 32-block ASCII map.
      if (path === '/route_probe') {
        if (!ctx.world.bot || !ctx.world.bot.entity) {
          return respond(res, 200, { ok: false, error: 'bot_not_ready' });
        }
        const rawTx = url.searchParams.get('to_x');
        const rawTy = url.searchParams.get('to_y');
        const rawTz = url.searchParams.get('to_z');
        if (rawTx === null || rawTy === null || rawTz === null) {
          return respond(res, 400, { ok: false, error: 'route_probe requires numeric to_x, to_y, to_z' });
        }
        const toX = Number(rawTx);
        const toY = Number(rawTy);
        const toZ = Number(rawTz);
        if (![toX, toY, toZ].every(Number.isFinite)) {
          return respond(res, 400, { ok: false, error: 'route_probe requires numeric to_x, to_y, to_z' });
        }
        const samples = Number(url.searchParams.get('samples') || '20');
        const me = ctx.world.bot.entity.position;
        const start = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
        const end = { x: Math.floor(toX), y: Math.floor(toY), z: Math.floor(toZ) };
        // F42 (task #66, v55): /route_probe now ALSO runs the wider
        // corridor probe (centre + ±10b perpendicular lanes) so route
        // previews fed to mc advise catch water in the realistic detour
        // band, not just the straight line. The single-line result
        // stays in `samples` for back-compat; the corridor counts are
        // surfaced as `corridor` so the advise digester can see both.
        const lineResult = probeRouteAlongLine(ctx.world.bot, start, end, samples);
        const corridorResult = probeRouteCorridor(ctx.world.bot, start, end, Math.max(8, Math.floor(samples / 3)), 10);

        // F42 — recommend a walkable shore + nearest navigable water
        // when the route crosses water. The agent's natural next step
        // is "walk to the shore that gets you onto a boat" — but
        // computing it requires findBlocks + findEntryShore knowledge
        // that the LLM doesn't have. Provide it directly.
        //
        // F44 (task #66, v55): use the FIRST water sample on the
        // probe as the seed. findBlocks only sees loaded chunks
        // (typically 16-32b around the bot at startup), so it
        // returns mostly cave water at base and misses surface
        // water further along the route. The probe itself samples
        // the route line out to the target — those samples touch
        // chunks that load lazily and produce real surface-water
        // hits. For each water sample, surface its coord + the
        // closest dry cell at (sample.x±1, sample.y+1, sample.z±1)
        // as recommended_shore_stance (the agent's bg_goto target).
        let nearestNavigableWater = null;
        let recommendedShoreStance = null;
        const allSamples = [
          ...(lineResult?.samples || []),
          ...(corridorResult?.samples || []),
        ];
        const waterSamples = allSamples.filter((s) => s.classification === 'water');
        if (waterSamples.length > 0) {
          try {
            const b = ctx.world.bot;
            const startFx = Math.floor(me.x), startFz = Math.floor(me.z);
            // For each water sample, find its true Y (the sample may have
            // reported the route's interpolated y plus a "water_below_y"
            // indicating water lies below). Prefer the actual water cell.
            // F48 (task #66, v58): reject candidates whose Y is far
            // from the bot's current Y (5-block delta default). Caves
            // and underground pools — technically navigable but
            // unreachable from the surface — get filtered out.
            const startFy = Math.floor(me.y);
            const PROBE_MAX_Y_DELTA = 5;
            const waterCandidates = waterSamples.map((s) => {
              const wy = Number.isFinite(s.water_below_y) ? s.water_below_y : s.y;
              const dxz = Math.hypot(s.x - startFx, s.z - startFz);
              const dy = Math.abs(wy - startFy);
              const navClass = _waterRouteInternals.classifyCell(b, s.x, wy, s.z);
              return { x: s.x, y: wy, z: s.z, dxz, dy, navClass };
            }).filter((c) => c.dy <= PROBE_MAX_Y_DELTA);
            // Prefer cells that classify navigable; fall back to closest
            // water-sample if no nav cell in the probe (chunk timing).
            const navigable = waterCandidates.filter((c) => c.navClass === 'navigable');
            const pool = navigable.length > 0 ? navigable : waterCandidates;
            pool.sort((a, b2) => a.dxz - b2.dxz);
            const best = pool[0];
            if (best) {
              nearestNavigableWater = {
                x: best.x, y: best.y, z: best.z,
                distance: Math.round(best.dxz),
                ...(best.navClass !== 'navigable' ? { classify_note: best.navClass } : {}),
              };
              // Dry shore stance adjacent. maxRadius=1 ensures the
              // bot can place_boat from it without walking around.
              const stance = _waterRouteInternals.findEntryShore(
                b, { x: best.x, y: best.y, z: best.z }, { maxRadius: 1 },
              );
              if (stance) recommendedShoreStance = stance;
            }
          } catch {
            // blockAt may throw for unloaded chunks — degrade silently.
          }
        }

        // F46 (task #66, v56): always provide a walkable next-coord
        // when there's water on the route. The agent's natural next
        // action is `mc bg_goto <coord>` — handing it a water cell
        // (NAV_TARGET_UNSTANDABLE refusal) wastes a turn. Resolution:
        //   1. Prefer recommended_shore_stance (dry cell adjacent to
        //      water) when available.
        //   2. Else if nearest_navigable_water is set but no stance
        //      (chunks beyond bot's view distance), offer a coord
        //      30b toward the water from the bot — a partial-step
        //      that loads chunks and lets the next sail_to plan a
        //      real route.
        //   3. Else null — agent uses its own judgement.
        let nextWalkCoord = null;
        let nextWalkReason = null;
        if (recommendedShoreStance) {
          nextWalkCoord = recommendedShoreStance;
          nextWalkReason = 'walkable shore stance adjacent to navigable water';
        } else if (nearestNavigableWater) {
          // Step 30b from bot toward water. Y stays at bot's y so the
          // pathfinder can find ground.
          const wx = nearestNavigableWater.x, wz = nearestNavigableWater.z;
          const dx = wx - Math.floor(me.x);
          const dz = wz - Math.floor(me.z);
          const len = Math.hypot(dx, dz) || 1;
          const stepLen = Math.min(30, len - 4); // stop short by 4b
          nextWalkCoord = {
            x: Math.floor(me.x) + Math.round(dx / len * stepLen),
            y: Math.floor(me.y),
            z: Math.floor(me.z) + Math.round(dz / len * stepLen),
          };
          nextWalkReason = `partial step toward water at (${wx},${nearestNavigableWater.y},${wz}); load chunks, then re-call sail_to`;
        }
        return respond(res, 200, {
          ok: true,
          data: {
            start,
            end,
            ...lineResult,
            corridor: corridorResult,
            ...(nearestNavigableWater ? { nearest_navigable_water: nearestNavigableWater } : {}),
            ...(recommendedShoreStance ? { recommended_shore_stance: recommendedShoreStance } : {}),
            ...(nextWalkCoord ? { next_walk_coord: nextWalkCoord, next_walk_reason: nextWalkReason } : {}),
          },
        });
      }

      if (path === '/plan_water_route') {
        // Dry-run BFS water-route planner. Read-only; does NOT move the bot.
        // Useful for testing: hit it with from_x/y/z (default = bot's current
        // position) and to_x/y/z to inspect the route + waypoints + refusal.
        if (!ctx.world.bot || !ctx.world.bot.entity) {
          return respond(res, 200, { ok: false, error: 'bot_not_ready' });
        }
        const me = ctx.world.bot.entity.position;
        const num = (k, def) => {
          const v = url.searchParams.get(k);
          if (v === null) return def;
          const n = Number(v);
          return Number.isFinite(n) ? n : def;
        };
        const start = {
          x: num('from_x', Math.floor(me.x)),
          y: num('from_y', Math.floor(me.y)),
          z: num('from_z', Math.floor(me.z)),
        };
        const target = {
          x: num('to_x', NaN),
          y: num('to_y', NaN),
          z: num('to_z', NaN),
        };
        if (![target.x, target.y, target.z].every(Number.isFinite)) {
          return respond(res, 400, { ok: false, error: 'plan_water_route requires numeric to_x, to_y, to_z' });
        }
        const result = planWaterRoute(ctx.world.bot, start, target);
        return respond(res, 200, { start, target, plan: result });
      }

      if (path === '/scene') {
        const range = parseInt(url.searchParams.get('range') || '16');
        const lean = url.searchParams.get('lean') === 'true';
        const data = buildSceneSummary({ range: Math.min(range, 24) });
        // Pre-emptive tool-readiness across visible blocks. `tools_missing`
        // names categories the agent needs but doesn't carry — actionable
        // signal that mc scene used to surface only after the bot walked
        // to a candidate and tried to dig. Always-computed (cheap; just
        // an inventory scan + category lookup) but only emitted when
        // there's something to say.
        if (data?.visible_blocks?.length) {
          try {
            const needs = sceneToolNeeds(ensureBot(), data.visible_blocks);
            if (needs.tools_missing.length || needs.tools_ready.length) {
              data.tool_readiness = needs;
            }
          } catch { /* never let a hint feature break the scene response */ }
        }
        if (lean && data) {
          // Drop the heaviest fields: full ray-hit array and detailed entity
          // list. Keep summary, topology, aggregate visible_blocks, hazards,
          // looking_at, and short entity preview.
          const { visible_block_hits, visible_entities, ...rest } = data;
          rest.visible_entities = (visible_entities || []).slice(0, 4);
          return respond(res, 200, { ok: true, data: rest });
        }
        return respond(res, 200, { ok: true, data });
      }

      if (path === '/social') {
        return respond(res, 200, { ok: true, data: { summary: summarizeSocialGraph(ctx.social.socialGraph), recent_events: ctx.social.socialEvents.slice(-20) } });
      }

      if (path === '/chat') {
        const count = parseInt(url.searchParams.get('count') || '20');
        const clear = url.searchParams.get('clear') === 'true';
        const msgs = ctx.social.chatLog.slice(-count);
        if (clear) ctx.social.chatLog.length = 0;
        return respond(res, 200, { ok: true, data: { messages: msgs } });
      }

      if (path === '/overhear') {
        const count = parseInt(url.searchParams.get('count') || '20');
        const msgs = ctx.social.overheardLog.slice(-count);
        return respond(res, 200, { ok: true, data: { messages: msgs } });
      }

      if (path === '/deaths') {
        return respond(res, 200, { ok: true, data: {
          total: ctx.death.deathLog.length,
          last_death: ctx.death.lastDeath ? {
            ...ctx.death.lastDeath,
            seconds_ago: Math.round((Date.now() - ctx.death.lastDeath.time) / 1000),
            items_lost: ctx.death.lastDeath.inventory.map(i => `${i.name}x${i.count}`).join(', ')
          } : null
        }});
      }

      if (path === '/commands') {
        // Get pending commands queued by in-game chat
        const pending = ctx.social.commandQueue.filter(c => c.status === 'pending');
        return respond(res, 200, { ok: true, data: { commands: pending } });
      }

      if (path === '/sounds') {
        return respond(res, 200, { ok: true, data: { sounds: ctx.runtime.soundEvents.slice(-10) } });
      }

      if (path === '/team') {
        return respond(res, 200, { ok: true, data: ctx.team.teamConfig });
      }

      if (path === '/stats') {
        return respond(res, 200, { ok: true, data: ctx.team.combatStats });
      }

      if (path === '/furnaces') {
        return respond(res, 200, { ok: true, data: { furnaces: ctx.team.activeFurnaces.map(f => ({
          ...f,
          eta_seconds: f.estimatedDone ? Math.max(0, Math.round((f.estimatedDone - Date.now()) / 1000)) : null,
        })) } });
      }

      if (path === '/task') {
        // F46: /task now reports three independent slots so the brain
        // can tell "async bg task" from "sync action in flight" from
        // "what just finished":
        //   task — async ctx.tasks.currentTask (POST /task/start), null otherwise
        //   sync — currently-running synchronous /action/<name>, null otherwise
        //   last — most recent completed sync OR async action, null if never
        // Pre-F46 callers that only read data.task continue to work; the
        // sync/last fields are additive. The point is to kill the polling
        // spam from G21 v1 where Mason called `mc task` 22× after a
        // synchronous `mc fill` completed and got `{task: null}` every time.
        refreshLeaseCheckpoint(ctx.tasks.currentTask);
        const now = Date.now();
        const sync = ctx.tasks.syncActionInFlight
          ? {
              action: ctx.tasks.syncActionName,
              started_at_ms: ctx.tasks.syncActionStartedAt,
              elapsed_s: ctx.tasks.syncActionStartedAt
                ? Math.round((now - ctx.tasks.syncActionStartedAt) / 1000)
                : 0,
            }
          : null;
        const history = Array.isArray(ctx.tasks.actionHistory) ? ctx.tasks.actionHistory : [];
        const recent = history.length > 0 ? history[history.length - 1] : null;
        const last = recent
          ? {
              action: recent.action,
              status: recent.status,
              finished_at_ms: recent.finished_at,
              age_s: Math.round((now - recent.finished_at) / 1000),
              detail: recent.detail || null,
            }
          : null;
        return respond(res, 200, {
          ok: true,
          data: {
            task: ctx.tasks.currentTask ? taskToApi(ctx.tasks.currentTask) : null,
            sync,
            last,
          },
          state: briefState(),
        });
      }

      if (path === '/goals') {
        ensureBot();
        const { scored, context } = getGoalsScoreboard();
        persistGoalsToDisk();
        // #103 context-trim: lean by default — drop verbose fields the
        // agent rarely needs on every poll (strategies_available, metric,
        // constraints, time_in_deficit_s, enabled, note). Pass ?full=true
        // to get the original shape (dashboard still uses the rich form
        // via dashboard-specific endpoints if needed).
        const full = url.searchParams.get('full') === 'true' || url.searchParams.get('full') === '1';
        const goals = full ? scored : scored.map(g => ({
          id: g.id,
          current: g.current,
          target_min: g.target_min,
          target_ok: g.target_ok,
          gap: g.gap,
          priority: g.priority,
          urgency: g.urgency,
          satisfied: g.satisfied,
        }));
        return respond(res, 200, {
          ok: true,
          data: { goals, context },
        });
      }

      if (path === '/goal-presets' || path === '/goals/presets') {
        return respond(res, 200, { ok: true, data: { presets: listPresets() } });
      }

      const goalIdMatch = path.match(/^\/goals\/([^/]+)$/);
      if (goalIdMatch) {
        ensureBot();
        const gid = decodeURIComponent(goalIdMatch[1]);
        const g = ctx.goals.goalsStore.goals.find((x) => x.id === gid);
        if (!g) return respond(res, 404, { ok: false, error: `Goal not found: ${gid}` });
        const { scored } = getGoalsScoreboard();
        const detail = scored.find((x) => x.id === gid) || g;
        return respond(res, 200, { ok: true, data: { goal: detail } });
      }

      if (path === '/checkpoint') {
        ensureBot();
        return respond(res, 200, buildObservePayload());
      }

      if (path === '/observe') {
        ensureBot();
        const lean = url.searchParams.get('lean') === 'true';
        return respond(res, 200, buildObservePayload({ lean }));
      }

      if (path === '/alerts') {
        ensureBot();
        return respond(res, 200, { ok: true, data: { alerts: buildTypedAlerts() } });
      }

      if (path === '/logistics') {
        ensureBot();
        return respond(res, 200, buildLogisticsPayload());
      }

      if (path === '/task/history') {
        return respond(res, 200, { ok: true, data: { history: ctx.tasks.taskHistory } });
      }
    }

    // ── POST endpoints (actions) ────────────────
    if (req.method === 'POST') {
      const body = await parseBody(req);

      // Cancel current task
      if (path === '/task/cancel') {
        const b = ensureBot();
        b.pathfinder.setGoal(null);
        try { b.stopDigging(); } catch {}
        if (ctx.tasks.currentTask && (ctx.tasks.currentTask.status === 'running' || ctx.tasks.currentTask.status === 'stuck')) {
          ctx.tasks.currentTask.status = 'cancelled';
          pushTaskHistoryRecord(ctx.tasks.currentTask, 'cancelled');
        }
        return respond(res, 200, { ok: true, result: 'Task cancelled.', state: briefState() });
      }

      // Explicit task start with goal + lease.
      if (path === '/task/start') {
        const actionName = body.action;
        if (!actionName) {
          const available = actionRegistry.names().join(', ');
          return respond(res, 400, {
            ok: false,
            error: `Unknown or missing action. Available: ${available}`,
          });
        }
        const r = await dispatchAction(servicesProxy, actionName, body, {
          mode: 'task',
          actionRegistry, briefState, createTaskRecord, pushTaskHistoryRecord,
        });
        if (!r.ok) return respond(res, r.status, { ok: false, error: r.error, state: briefState() });
        return respond(res, r.status, r.response);
      }

      if (path === '/task/checkpoint-respond') {
        refreshLeaseCheckpoint(ctx.tasks.currentTask);
        const decision = String(body.decision || 'continue').toLowerCase();
        const leaseSeconds =
          body.lease_seconds != null ? parseFloat(body.lease_seconds) : 45;
        if (!ctx.tasks.currentTask || ctx.tasks.currentTask.status !== 'running') {
          return respond(res, 200, {
            ok: true,
            result: 'No running task to checkpoint.',
            state: briefState(),
          });
        }
        if (decision === 'cancel' || decision === 'abort') {
          try {
            const b = ensureBot();
            b.pathfinder.setGoal(null);
            try {
              b.stopDigging();
            } catch {}
          } catch {}
          ctx.tasks.currentTask.status = 'cancelled';
          pushTaskHistoryRecord(ctx.tasks.currentTask, 'cancelled');
          ctx.tasks.currentTask = null;
          return respond(res, 200, { ok: true, result: 'Task cancelled at checkpoint.', state: briefState() });
        }
        if (decision === 'continue' || decision === 'renew') {
          renewLease(ctx.tasks.currentTask, leaseSeconds > 0 ? leaseSeconds : 45);
          return respond(res, 200, {
            ok: true,
            result: `Lease renewed (${leaseSeconds}s).`,
            state: briefState(),
          });
        }
        renewLease(ctx.tasks.currentTask, leaseSeconds > 0 ? leaseSeconds : 45);
        return respond(res, 200, {
          ok: true,
          result: `Checkpoint noted (${decision}). Lease renewed.`,
          state: briefState(),
        });
      }

      if (path === '/task/pause') {
        ensureBot();
        if (ctx.tasks.currentTask && ctx.tasks.currentTask.status === 'running') {
          ctx.tasks.currentTask.checkpoint_status = 'pending';
        }
        return respond(res, 200, {
          ok: true,
          result: 'Checkpoint forced (pending).',
          state: briefState(),
        });
      }

      if (path === '/task/resume') {
        ensureBot();
        const ls = body.lease_seconds != null ? parseFloat(body.lease_seconds) : 45;
        if (ctx.tasks.currentTask && ctx.tasks.currentTask.status === 'running') {
          renewLease(ctx.tasks.currentTask, ls > 0 ? ls : 45);
          return respond(res, 200, {
            ok: true,
            result: 'Lease renewed.',
            state: briefState(),
          });
        }
        return respond(res, 200, {
          ok: true,
          result: 'No active task.',
          state: briefState(),
        });
      }

      // Goals API
      if (path === '/goals' && req.method === 'POST') {
        ensureBot();
        if (Array.isArray(body.goals)) {
          ctx.goals.goalsStore.goals = body.goals;
        } else if (body.goal) {
          const g = body.goal;
          const idx = ctx.goals.goalsStore.goals.findIndex((x) => x.id === g.id);
          if (idx >= 0) ctx.goals.goalsStore.goals[idx] = { ...ctx.goals.goalsStore.goals[idx], ...g };
          else ctx.goals.goalsStore.goals.push(g);
        }
        persistGoalsToDisk();
        return respond(res, 200, { ok: true, data: { count: ctx.goals.goalsStore.goals.length }, state: briefState() });
      }

      if (path === '/goals/update') {
        ensureBot();
        const id = body.id;
        if (!id) return respond(res, 400, { ok: false, error: 'Missing goal id' });
        const idx = ctx.goals.goalsStore.goals.findIndex((x) => x.id === id);
        if (idx < 0) return respond(res, 404, { ok: false, error: `Goal not found: ${id}` });
        const { id: _id, ...rest } = body;
        ctx.goals.goalsStore.goals[idx] = { ...ctx.goals.goalsStore.goals[idx], ...rest };
        persistGoalsToDisk();
        return respond(res, 200, { ok: true, data: { goal: ctx.goals.goalsStore.goals[idx] }, state: briefState() });
      }

      if (path === '/goals/load-preset') {
        ensureBot();
        const name = body.preset || body.name;
        if (!name) return respond(res, 400, { ok: false, error: 'Missing preset name' });
        const preset = loadPreset(name);
        if (!preset) return respond(res, 404, { ok: false, error: `Preset not found: ${name}` });
        ctx.goals.goalsStore = mergePresetIntoStore(ctx.goals.goalsStore, preset);
        persistGoalsToDisk();
        return respond(res, 200, {
          ok: true,
          result: `Loaded preset '${name}'`,
          data: { goals: ctx.goals.goalsStore.goals.length },
          state: briefState(),
        });
      }

      // Background task system: POST /task/ACTION runs async, returns task_id.
      const taskMatch = path.match(/^\/task\/(\w+)$/);
      if (taskMatch) {
        const actionName = taskMatch[1];
        // task #20: stamp "agent is driving" so the reactive layer
        // doesn't fall into the idle-CPU loop observed in circuit-v4.
        try { ctx.reactive._touchAgent?.(); } catch { /* defensive */ }
        const r = await dispatchAction(servicesProxy, actionName, body, {
          mode: 'task',
          actionRegistry, briefState, createTaskRecord, pushTaskHistoryRecord,
        });
        if (!r.ok) return respond(res, r.status, { ok: false, error: r.error, state: briefState() });
        return respond(res, r.status, r.response);
      }

      // Synchronous action: POST /action/ACTION (still supported for quick stuff)
      const actionMatch = path.match(/^\/action\/(\w+)$/);
      if (!actionMatch) {
        // Special: /connect — idempotent unless body.force=true (HermesCraft: avoid resetting TCP during handshake).
        if (path === '/connect') {
          const force = body?.force === true || body?.reconnect === true;
          try {
            await createBot(force ? { force: true } : {});
            const note =
              ctx.world.botReady && ctx.world.bot?.entity
                ? force
                  ? 'Reconnected (forced)'
                  : 'Connected'
                : 'Connecting';
            return respond(res, 200, {
              ok: true,
              connected: !!ctx.world.botReady,
              force: !!force,
              result: note,
              state: briefState(),
            });
          } catch (e) {
            const msg = (e && e.message) || String(e);
            return respond(res, 503, {
              ok: false,
              error: msg,
              state: briefState(),
            });
          }
        }
        return respond(res, 404, { ok: false, error: `Unknown endpoint: ${path}` });
      }

      const actionName = actionMatch[1];

      // F58: mc status is an explicit "I'm rethinking" — clear F51.2 flag,
      // F57.1 escape-loop counter, and F57.2 stuck-cell registry. Brain has
      // acknowledged the loop and is planning differently; don't hold prior
      // escapes against it for the next 90s.
      if (actionName === 'status') {
        if (ctx.runtime.lastMoveFailed) ctx.runtime.lastMoveFailed = null;
        ctx.runtime.recentEscapes = [];
        ctx.runtime.recentStuckCells = [];
      }

      // task #20: stamp "agent is driving" for the reactive idle gate.
      try { ctx.reactive._touchAgent?.(); } catch { /* defensive */ }
      const r = await dispatchAction(servicesProxy, actionName, body, {
        mode: 'sync',
        actionRegistry, briefState, createTaskRecord, pushTaskHistoryRecord,
      });
      if (!r.ok) return respond(res, r.status, { ok: false, error: r.error, state: briefState() });
      return respond(res, r.status, r.response);
    }

    if (req.method === 'DELETE') {
      const gm = path.match(/^\/goals\/([^/]+)$/);
      if (gm) {
        ensureBot();
        const gid = decodeURIComponent(gm[1]);
        const before = ctx.goals.goalsStore.goals.length;
        ctx.goals.goalsStore.goals = ctx.goals.goalsStore.goals.filter((x) => x.id !== gid);
        if (ctx.goals.goalsStore.goals.length === before) {
          return respond(res, 404, { ok: false, error: `Goal not found: ${gid}` });
        }
        persistGoalsToDisk();
        return respond(res, 200, { ok: true, result: `Removed goal ${gid}` });
      }
      return respond(res, 404, { ok: false, error: `Not found: DELETE ${path}` });
    }

    respond(res, 404, { ok: false, error: `Not found: ${req.method} ${path}` });

  } catch (err) {
    recordLastApiError(ctx, req.method, path, err);
    const am = path.match(/^\/action\/(\w+)$/);
    if (am) {
      pushAction(ctx, am[1], 'error', Date.now(), null, err.message);
      recordActionOutcome(ctx, am[1], 'error', err.message);
    }
    const msg = String(err.message || '');
    const status =
      /not connected|respawn in progress|dead —/i.test(msg) ? 503 : 400;
    respond(res, status, { ok: false, error: err.message, state: briefState() });
  }
  };
}


