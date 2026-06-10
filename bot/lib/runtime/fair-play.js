import { Vec3 } from 'vec3';
import { FAIR_PLAY } from './fair-play-constants.js';
import {
  yawPitchToDir,
  bearingFromDelta,
  classifySector,
  angleDiffDegrees,
  makeBlockMemoryKey,
  summarizeVisibleBlocks,
  summarizeSceneText,
  formatStandingSituation,
} from '../shared/perception.js';
import { buildLandscapeContext } from '../shared/scene-landscape.js';
import { blockRef } from '../shared/typed-nouns.js';
import { filterPlacementBlockingEntities } from '../shared/entity-blocking.js';
import {
  nearbyPlacementBlockersFromHits,
  placementInsightForBlock,
} from '../shared/placement-insight.js';

/**
 * Fair-play LOS / scanning / sound bookkeeping wired to a mutable BotContext.
 *
 * @param {{
 *   ctx: Record<string, any>;
 *   ensureBot: () => import('mineflayer').Bot;
 *   fmt: (v: unknown) => unknown;
 *   posObj: (pos?: import('vec3').Vec3) => { x: number; y: number; z: number } | null;
 *   sleep: (ms: number) => Promise<void>;
 *   getMemoryHints: (limit?: number) => string[];
 *   getStandingState?: (bot: import('mineflayer').Bot) => Record<string, unknown>;
 * }} deps
 */
export function createFairPlaySuite(deps) {
  const { ctx, ensureBot, fmt, posObj, sleep, getMemoryHints, getStandingState } = deps;

  /**
   * Blocks that may sit between eyes and a trunk without blocking fair-play harvest LOS.
   */
  function isHarvestLosTransparentBlock(block, targetHarvestName = '') {
    if (!block) return true;
    if (block.boundingBox !== 'block') return true;
    const n = block.name;
    if (/air$/i.test(n) || n === 'void_air' || n === 'cave_air') return true;
    if (/(water|flowing_water|bubble_column|kelp|seagrass|^lily_pad$)/i.test(n)) return true;
    if (/flowing_lava|^lava$|^fire$|soul_fire/i.test(n)) return false;

    if (/_log$|_stem$|^crimson_stem$|^warped_stem$/i.test(n)) return n === targetHarvestName;

    if (/_leaves$/i.test(n)) return true;
    if (
      /vine|cave_vegetation|cave_vines|wart_block|sweet_berry|azalea|flowering_azalea|lichen|_sapling|spore_blossom|small_dripleaf|big_dripleaf|pitcher_pod|pink_petals|hanging_roots|turtle_egg|snow_layer|dead_bush|sunflower|coral|coral_fan|^bamboo|^cocoa/i.test(
        n,
      )
    )
      return true;
    if (/^(short_grass|tall_grass|large_fern|fern|grass)$/i.test(n)) return true;
    if (
      /tulip|dandelion|poppy|orchid|allium|azure|cornflower|oxeye|lily|torchflower|wither_rose|marigold|daisy/i.test(n) &&
      !/grass_block|flower_pot|wither_rose_bush/i.test(n)
    )
      return true;
    if (/_mushroom$|^brown_mushroom$|^red_mushroom$/i.test(n)) return true;
    if (/_carpet$/i.test(n)) return true;

    return false;
  }

  /** LOS from bot eyes toward log/stem voxel; foliage does not occlude; solids do. */
  function hasHarvestLineOfSightToWoodBlock(b, eye, bx, by, bz, harvestName) {
    if (!eye || !b) return false;
    const tcx = bx + 0.5;
    const tcy = by + 0.5;
    const tcz = bz + 0.5;
    const dx = tcx - eye.x;
    const dy = tcy - eye.y;
    const dz = tcz - eye.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(dist) || dist < 0.5) return true;
    const steps = Math.max(6, Math.ceil(dist * 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = eye.x + dx * t;
      const y = eye.y + dy * t;
      const z = eye.z + dz * t;
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const iz = Math.floor(z);
      if (ix === bx && iy === by && iz === bz) return true;
      const blk = b.blockAt(new Vec3(ix, iy, iz));
      if (!isHarvestLosTransparentBlock(blk, harvestName)) return false;
    }
    const last = b.blockAt(new Vec3(bx, by, bz));
    return !!(last && last.name === harvestName);
  }

  /** Scout + harvest LOS for mc collect when fair-play is on. */
  function fairPlayHarvestTrunkCandidates(blockTypeName, blockTypeId, batchSize, b) {
    const eye = eyePosition(b.entity);
    if (!eye) return [];

    const world = b.findBlocks({
      matching: blockTypeId,
      maxDistance: 28,
      count: batchSize * 24,
    });
    const botPos = b.entity.position;
    world.sort((a, c) => a.distanceTo(botPos) - c.distanceTo(botPos));

    const harvestable = [];
    for (const pos of world) {
      const target = b.blockAt(pos);
      if (!target || target.name !== blockTypeName) continue;
      const bfx = Math.floor(botPos.x);
      const bfy = Math.floor(botPos.y);
      const bfz = Math.floor(botPos.z);
      if (Math.abs(pos.x - bfx) < 1 && Math.abs(pos.z - bfz) < 1 && pos.y < bfy) continue;
      if (hasHarvestLineOfSightToWoodBlock(b, eye, pos.x, pos.y, pos.z, blockTypeName))
        harvestable.push(pos);
      if (harvestable.length >= batchSize * 6) break;
    }

    return harvestable.map((p) => new Vec3(p.x, p.y, p.z));
  }

  // #95: open doors / fence_gates / trapdoors report boundingBox='block'
  // (their FULL collision box including the closed extents). When OPEN
  // the actual collision is a thin sliver to the side that doesn't block
  // a typical eye-to-target raycast — Minecraft players can see through
  // and click through them just fine. Treat open ones as passable so
  // mc chest / mc place / mc attack don't false-positive on a door
  // between the bot and its target.
  //
  // Foliage / plants / leaves: same list as trunk harvest LOS — mc collect
  // discovery used hasHarvestLineOfSightToWoodBlock (leaves ok) but dig and
  // collect execute used this helper without foliage → "can't see log" with
  // only leaves in the way (boundingBox='block' on many leaf types).
  function isPassableForLOS(block) {
    if (!block) return true;
    if (isHarvestLosTransparentBlock(block, '')) return true;
    if (block.boundingBox !== 'block') return true;
    const name = block.name || '';
    if (!/(_door|_fence_gate|_trapdoor)$/.test(name)) return false;
    // Iron doors only open via redstone, not a click — but if they're
    // open in-state they're still passable for LOS purposes.
    try {
      const props = typeof block.getProperties === 'function' ? block.getProperties() : {};
      return props.open === true || props.open === 'true';
    } catch {
      return false;
    }
  }

  function hasLineOfSight(from, to) {
    if (!ctx.world.bot || !ctx.world.botReady) return false;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1) return true;
    const steps = Math.ceil(dist * 2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      const z = from.z + dz * t;
      const block = ctx.world.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
      if (block && !isPassableForLOS(block)) return false;
    }
    return true;
  }

  function canDetectEntity(entity) {
    if (!ctx.reactive.fairPlayMode || !ctx.world.bot || !ctx.world.botReady) return true;
    const pos = ctx.world.bot.entity.position;
    const dist = entity.position.distanceTo(pos);

    if (dist < 3) return true;

    const entitySneaking =
      entity.metadata?.[6] === 5 || entity.crouching || entity.pose === 'sneaking';
    if (entitySneaking && dist > FAIR_PLAY.SNEAK_DETECT_RANGE) return false;

    if (dist > FAIR_PLAY.LOS_ENTITY_RANGE) return false;

    const eyeHeight = ctx.world.bot.entity.height * 0.85;
    const eyePos = pos.offset(0, eyeHeight, 0);
    const targetCenter = entity.position.offset(0, (entity.height || 1.8) * 0.5, 0);

    if (!hasLineOfSight(eyePos, targetCenter)) return false;

    return true;
  }

  function filterEntitiesFairPlay(entities) {
    if (!ctx.reactive.fairPlayMode) return entities;
    return entities.filter((e) => canDetectEntity(e));
  }

  function eyePosition(entity = ctx.world.bot?.entity) {
    if (!entity?.position) return null;
    return entity.position.offset(0, (entity.height || 1.62) * 0.85, 0);
  }

  function raycastFirstSolid(origin, direction, maxDistance = 16, step = 0.75) {
    for (let distance = step; distance <= maxDistance; distance += step) {
      const sample = new Vec3(
        origin.x + direction.x * distance,
        origin.y + direction.y * distance,
        origin.z + direction.z * distance,
      );
      const block = ctx.world.bot.blockAt(new Vec3(Math.floor(sample.x), Math.floor(sample.y), Math.floor(sample.z)));
      if (block && block.boundingBox === 'block' && block.name !== 'air' && block.name !== 'cave_air') {
        return { block, distance };
      }
    }
    return null;
  }

  function rememberObservedBlock(entry) {
    ctx.reactive.observedBlocks.set(makeBlockMemoryKey(entry.position, entry.name), {
      ...entry,
      lastSeen: Date.now(),
    });
    if (ctx.reactive.observedBlocks.size > 200) {
      const oldest = [...ctx.reactive.observedBlocks.entries()]
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
        .slice(0, ctx.reactive.observedBlocks.size - 200);
      oldest.forEach(([key]) => ctx.reactive.observedBlocks.delete(key));
    }
  }

  function scanVisibleBlocks({
    range = 16,
    horizontalFov = 100,
    verticalFov = 36,
    horizontalRays = 7,
    verticalRays = 3,
    yawPans = 1,
  } = {}) {
    const b = ensureBot();
    const origin = eyePosition(b.entity);
    const hits = [];
    const seen = new Set();
    const baseYawDeg = (b.entity.yaw * 180) / Math.PI;
    const basePitchDeg = (b.entity.pitch * 180) / Math.PI;

    let panOffsetsDeg = [0];
    const yawPanCountRaw = Number(yawPans);
    const yawPanCount = Number.isFinite(yawPanCountRaw)
      ? Math.max(1, Math.min(12, Math.floor(yawPanCountRaw)))
      : 1;
    if (yawPanCount > 1) {
      panOffsetsDeg = Array.from({ length: yawPanCount }, (_, i) => (360 * i) / yawPanCount);
    }

    for (const panDeg of panOffsetsDeg) {
      for (let yi = 0; yi < verticalRays; yi++) {
        const pitchOffset =
          verticalRays === 1 ? 0 : -verticalFov / 2 + (verticalFov * yi) / (verticalRays - 1);
        for (let xi = 0; xi < horizontalRays; xi++) {
          const horizOffsetDeg =
            horizontalRays === 1 ? 0 : -horizontalFov / 2 + (horizontalFov * xi) / (horizontalRays - 1);

          const yaw = ((baseYawDeg + panDeg + horizOffsetDeg) * Math.PI) / 180;
          const pitch = ((basePitchDeg + pitchOffset) * Math.PI) / 180;
          const hit = raycastFirstSolid(origin, yawPitchToDir(yaw, pitch), range);
          if (!hit) continue;
          const key = `${hit.block.name}@${hit.block.position.x},${hit.block.position.y},${hit.block.position.z}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const dx = hit.block.position.x - b.entity.position.x;
          const dz = hit.block.position.z - b.entity.position.z;
          const bearing = bearingFromDelta(dx, dz);
          const relativeAngle = angleDiffDegrees(baseYawDeg, (Math.atan2(dx, -dz) * 180) / Math.PI);
          const sector = classifySector(relativeAngle);
          const entry = {
            name: hit.block.name,
            position: posObj(hit.block.position),
            distance: fmt(hit.distance),
            bearing,
            sector,
          };
          hits.push(entry);
          rememberObservedBlock(entry);
        }
      }
    }

    return hits.sort((a, b) => a.distance - b.distance);
  }

  function detectHazardsFromVisibleBlocks(blocks) {
    return blocks
      .filter((block) => ['lava', 'flowing_lava', 'fire', 'campfire'].includes(block.name))
      .slice(0, 5)
      .map((block) => `${block.name} ${block.sector} ${block.distance}m`);
  }

  function buildSceneSummary({ range = 16 } = {}) {
    const b = ensureBot();
    const visibleBlocks = ctx.reactive.fairPlayMode
      ? scanVisibleBlocks({ range, yawPans: FAIR_PLAY.SCAN_YAW_PANS })
      : scanVisibleBlocks({
          range: Math.min(range, 24),
          horizontalFov: 140,
          verticalFov: 50,
          horizontalRays: 9,
          verticalRays: 4,
          yawPans: 4,
        });
    const pos = b.entity.position;
    const visibleEntities = filterPlacementBlockingEntities(filterEntitiesFairPlay(
      Object.values(b.entities).filter(
        (entity) => entity !== b.entity && entity.position.distanceTo(pos) <= Math.min(range + 8, 24),
      ),
    ))
      .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
      .slice(0, 8)
      .map((entity) => ({
        type: entity.username || entity.name || entity.displayName || 'unknown',
        distance: fmt(entity.position.distanceTo(pos)),
        bearing: bearingFromDelta(entity.position.x - pos.x, entity.position.z - pos.z),
        kind: entity.type || (entity.username ? 'player' : 'mob'),
        health: entity.health ?? undefined,
      }));
    const lookingAtBlock = b.blockAtCursor?.(5);
    const lookingAtInsight = lookingAtBlock
      ? placementInsightForBlock(lookingAtBlock, ctx)
      : null;
    const lookingAt = lookingAtBlock
      ? {
        ...(lookingAtInsight || { name: lookingAtBlock.name }),
        position: posObj(lookingAtBlock.position),
      }
      : null;
    const nearby_placement_blockers = nearbyPlacementBlockersFromHits(visibleBlocks, ctx, {
      excludeCoord: lookingAt?.blocks_placement ? lookingAt.coord : null,
    });
    const hazards = detectHazardsFromVisibleBlocks(visibleBlocks);
    let landscape = null;
    try {
      landscape = buildLandscapeContext(b);
    } catch { /* never break scene */ }
    let topology = null;
    let standingLine = null;
    if (getStandingState) {
      try {
        topology = getStandingState(b);
        standingLine = formatStandingSituation(topology);
      } catch { /* never break scene */ }
    }
    let summary = summarizeSceneText({
      lookingAt,
      visibleBlocks,
      visibleEntities,
      hazards,
      sounds: ctx.runtime.soundEvents.slice(-5),
      memoryHints: getMemoryHints(),
      nearbyPlacementBlockers: nearby_placement_blockers,
    });
    if (standingLine) summary = `${standingLine} ${summary}`;
    if (landscape?.clause) summary = `${landscape.clause} — ${summary}`;

    const origin = {
      x: b.entity.position.x,
      y: b.entity.position.y,
      z: b.entity.position.z,
    };
    const visibleBlockHits = visibleBlocks.map((entry) => ({
      ...entry,
      block_ref: blockRef(
        {
          name: entry.name,
          x: entry.position.x,
          y: entry.position.y,
          z: entry.position.z,
        },
        origin,
      ),
    }));

    return {
      summary,
      ...(landscape ? { landscape } : {}),
      ...(topology ? { topology } : {}),
      visible_blocks: summarizeVisibleBlocks(visibleBlocks),
      visible_block_hits: visibleBlockHits,
      visible_entities: visibleEntities,
      hazards,
      looking_at: lookingAt,
      nearby_placement_blockers,
      sounds: ctx.runtime.soundEvents.slice(-5),
      memory_hints: getMemoryHints(),
      fair_play: ctx.reactive.fairPlayMode,
      range,
    };
  }

  function findVisibleBlocksByName(blockName, { range = 16, count = 10, yawPans } = {}) {
    const needle = String(blockName || '').toLowerCase();
    const pans = yawPans ?? (ctx.reactive.fairPlayMode ? FAIR_PLAY.SCAN_YAW_PANS : 1);
    return scanVisibleBlocks({ range, yawPans: pans })
      .filter((entry) => entry.name.toLowerCase() === needle)
      .slice(0, count);
  }

  async function collectVisibleHitsWithPhysicalLookSweep(
    b,
    scanOpts = {},
    { headings, settleMs } = {},
  ) {
    const startYaw = b.entity.yaw;
    const startPitch = b.entity.pitch;
    const n = Math.max(
      2,
      Math.min(12, Number(headings) || (ctx.reactive.fairPlayMode ? FAIR_PLAY.LOOK_SWEEP_HEADINGS : 4)),
    );
    const ms = Math.max(0, Math.min(250, Number(settleMs) || FAIR_PLAY.LOOK_SETTLE_MS));
    const seen = new Set();
    const all = [];

    const merge = () => {
      for (const entry of scanVisibleBlocks({ ...scanOpts, yawPans: 1 })) {
        const key = `${entry.name}@${entry.position.x},${entry.position.y},${entry.position.z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(entry);
      }
    };

    for (let i = 0; i < n; i++) {
      await b.look(startYaw + (2 * Math.PI * i) / n, startPitch, true);
      if (ms > 0) await sleep(ms);
      merge();
    }

    await b.look(startYaw, startPitch, true);
    if (ms > 0) await sleep(Math.min(ms, 40));

    return all.sort((a, c) => (parseFloat(String(a.distance)) || 0) - (parseFloat(String(c.distance)) || 0));
  }

  async function findVisibleBlocksByNameWithPhysicalSweep(
    blockName,
    { range = 16, count = 10, headings, settleMs } = {},
  ) {
    const needle = String(blockName || '').toLowerCase();
    const b = ensureBot();
    const hits = await collectVisibleHitsWithPhysicalLookSweep(
      b,
      { range, horizontalFov: 100, verticalFov: 50, horizontalRays: 7, verticalRays: 5 },
      { headings, settleMs },
    );
    return hits.filter((entry) => entry.name.toLowerCase() === needle).slice(0, count);
  }

  function entityLosDedupeKey(e) {
    if (e?.username && String(e.username).length > 0) return `player:${String(e.username).toLowerCase()}`;
    if (typeof e?.id === 'number') return `id:${e.id}`;
    const p = e?.position;
    if (!p) return `u:${Math.random().toFixed(8)}`;
    return `misc:${String(e?.name ?? 'mob')}:${Math.round(p.x * 10) / 10}:${Math.round(p.y * 10) / 10}:${Math.round(p.z * 10) / 10}`;
  }

  async function entitiesMatchingAfterLookSweep(b, pos, radius, typeFilter) {
    const startYaw = b.entity.yaw;
    const startPitch = b.entity.pitch;
    const n = Math.max(2, Math.min(12, FAIR_PLAY.LOOK_SWEEP_HEADINGS));
    const ms = Math.max(0, Math.min(250, FAIR_PLAY.LOOK_SETTLE_MS));
    const byKey = new Map();

    const consider = () => {
      let list = Object.values(b.entities).filter(
        (ent) => ent !== b.entity && ent.position && ent.position.distanceTo(pos) < radius,
      );
      if (typeFilter) {
        const t = typeFilter.toLowerCase();
        list = list.filter(
          (ent) =>
            (ent.name || '').toLowerCase().includes(t) ||
            (ent.username || '').toLowerCase().includes(t) ||
            (ent.displayName || '').toLowerCase().includes(t),
        );
      }
      filterEntitiesFairPlay(list).forEach((ent) => {
        const key = entityLosDedupeKey(ent);
        if (!byKey.has(key)) byKey.set(key, ent);
      });
    };

    consider();
    for (let i = 1; i < n; i++) {
      await b.look(startYaw + (2 * Math.PI * i) / n, startPitch, true);
      if (ms > 0) await sleep(ms);
      consider();
    }
    await b.look(startYaw, startPitch, true);
    if (ms > 0) await sleep(Math.min(ms, 40));

    return [...byKey.values()].sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));
  }

  function addSoundEvent(type, position, radius) {
    if (!ctx.world.bot || !ctx.world.botReady) return;
    const dist = ctx.world.bot.entity.position.distanceTo(position);
    if (dist > radius) return;

    const dx = position.x - ctx.world.bot.entity.position.x;
    const dz = position.z - ctx.world.bot.entity.position.z;
    const angle = (Math.atan2(dz, dx) * 180) / Math.PI;
    let dir;
    if (angle > -22.5 && angle <= 22.5) dir = 'east';
    else if (angle > 22.5 && angle <= 67.5) dir = 'southeast';
    else if (angle > 67.5 && angle <= 112.5) dir = 'south';
    else if (angle > 112.5 && angle <= 157.5) dir = 'southwest';
    else if (angle > 157.5 || angle <= -157.5) dir = 'west';
    else if (angle > -157.5 && angle <= -112.5) dir = 'northwest';
    else if (angle > -112.5 && angle <= -67.5) dir = 'north';
    else dir = 'northeast';

    ctx.runtime.soundEvents.push({
      time: Date.now(),
      type,
      direction: dir,
      distance: fmt(dist),
      approximate: true,
    });
    ctx.runtime.soundEvents = ctx.runtime.soundEvents.filter((e) => Date.now() - e.time < 30000).slice(-20);
  }

  async function reactionDelay() {
    if (!ctx.reactive.fairPlayMode) return;
    const delay =
      FAIR_PLAY.REACTION_MIN_MS +
      Math.random() * (FAIR_PLAY.REACTION_MAX_MS - FAIR_PLAY.REACTION_MIN_MS);
    await sleep(delay);
  }

  return {
    isHarvestLosTransparentBlock,
    hasHarvestLineOfSightToWoodBlock,
    fairPlayHarvestTrunkCandidates,
    hasLineOfSight,
    canDetectEntity,
    filterEntitiesFairPlay,
    eyePosition,
    raycastFirstSolid,
    rememberObservedBlock,
    scanVisibleBlocks,
    detectHazardsFromVisibleBlocks,
    buildSceneSummary,
    findVisibleBlocksByName,
    collectVisibleHitsWithPhysicalLookSweep,
    findVisibleBlocksByNameWithPhysicalSweep,
    entityLosDedupeKey,
    entitiesMatchingAfterLookSweep,
    addSoundEvent,
    reactionDelay,
  };
}
