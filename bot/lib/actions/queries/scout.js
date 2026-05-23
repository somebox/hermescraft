import { Vec3 } from 'vec3';
import { FALLING_BLOCK_NAMES } from '../../runtime/dig-tools.js';
import { fail } from '../../shared/action-contract.js';
import { AIR_NAMES } from '../_block-sets.js';

export function createScoutQueries({ ctx, ensureBot, fairPlay }) {
  const { hasLineOfSight, eyePosition } = fairPlay;

  return {
  async scout({ x, y, z, radius, block }) {
    const b = ensureBot();
    const r = Math.min(Math.max(parseInt(String(radius ?? 8), 10) || 8, 1), 16);
    const me = b.entity.position;
    const cx = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(me.x);
    const cy = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(me.y);
    const cz = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(me.z);
    const center = new Vec3(cx, cy, cz);

    // Optional target-block lookup: validate now so an UNKNOWN_BLOCK
    // failure doesn't waste the hazard scan that follows.
    let blockName = null;
    let blockType = null;
    if (block !== undefined && block !== null && String(block).length > 0) {
      blockName = String(block);
      blockType = ctx.world.mcData.blocksByName[blockName];
      if (!blockType) {
        return fail(
          'UNKNOWN_BLOCK',
          `Unknown block "${blockName}". Check spelling (e.g. dirt, coal_ore, oak_log).`,
          { observed_state: { requested_block: blockName }, retry_safe: false },
        );
      }
    }

    const lavaPositions = b.findBlocks({
      matching: (block) => block.name === 'lava' || block.name === 'flowing_lava',
      maxDistance: r,
      count: 50,
      point: center,
    });
    const waterPositions = b.findBlocks({
      matching: (block) => block.name === 'water' || block.name === 'flowing_water',
      maxDistance: r,
      count: 50,
      point: center,
    });
    const fallingPositions = b.findBlocks({
      matching: (block) => FALLING_BLOCK_NAMES.has(block.name),
      maxDistance: r,
      count: 50,
      point: center,
    });
    const bedrockPositions = b.findBlocks({
      matching: (block) => block.name === 'bedrock',
      maxDistance: r,
      count: 1,
      point: center,
    });

    const fmtPos = (p) => ({ x: p.x, y: p.y, z: p.z });
    const lava = lavaPositions.map((p) => {
      const blk = b.blockAt(p);
      const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
      const level = props.level !== undefined ? Number(props.level) : 0;
      return { ...fmtPos(p), source: level === 0, dist: Math.round(p.distanceTo(center) * 10) / 10 };
    });
    const water = waterPositions.map((p) => ({ ...fmtPos(p), dist: Math.round(p.distanceTo(center) * 10) / 10 }));
    const falling = fallingPositions.map((p) => {
      const blk = b.blockAt(p);
      return { ...fmtPos(p), name: blk?.name || 'unknown', dist: Math.round(p.distanceTo(center) * 10) / 10 };
    });
    let bedrock = null;
    if (bedrockPositions.length) {
      const bp = bedrockPositions[0];
      bedrock = { ...fmtPos(bp), dist: Math.round(bp.distanceTo(center) * 10) / 10 };
    }

    // Hostile mobs — common Minecraft hostile types within the radius.
    // Known limitation: in Multiverse non-default worlds, mineflayer's
    // entity tracker may report empty even when mobs are nearby. Use
    // mc scene as a fallback when scout reports 0 hostile.
    const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'pillager', 'vindicator', 'evoker', 'drowned', 'husk', 'stray', 'phantom', 'cave_spider', 'silverfish', 'endermite', 'blaze', 'ghast', 'magma_cube', 'slime', 'wither_skeleton', 'piglin', 'piglin_brute', 'zoglin', 'hoglin']);
    const hostile = [];
    for (const e of Object.values(b.entities)) {
      if (!e.position || !HOSTILE.has(e.name)) continue;
      const d = e.position.distanceTo(center);
      if (d > r) continue;
      hostile.push({ name: e.name, x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z), dist: Math.round(d * 10) / 10 });
    }
    hostile.sort((a, b) => a.dist - b.dist);

    const counts = { lava: lava.length, water: water.length, falling: falling.length, hostile: hostile.length };

    // Target-block density + verdict (when --block was set).
    // Buckets:
    //   exposed_visible      — has air above AND raycast LOS from bot eye
    //   exposed_buried       — has air above but no LOS (need to walk around)
    //   surface_under_liquid — air slot is water/lava (would flood when broken)
    //   fully_buried         — no air above (need to dig down or sideways)
    // Centroid is the mean of exposed-visible candidates (or any
    // exposed if none are visible) — what the agent walks toward when
    // verdict says move_to.
    let target = null;
    if (blockType) {
      const targetPositions = b.findBlocks({
        matching: blockType.id,
        maxDistance: r,
        count: 200,
        point: center,
      });
      const WATER_NAMES = new Set(['water', 'flowing_water']);
      const LAVA_NAMES = new Set(['lava', 'flowing_lava']);
      const buckets = {
        exposed_visible: 0,
        exposed_buried: 0,
        surface_under_liquid: 0,
        fully_buried: 0,
      };
      const exposedVisible = [];
      const exposedAny = [];
      const eye = (typeof eyePosition === 'function') ? eyePosition() : null;
      for (const p of targetPositions) {
        const above = b.blockAt(p.offset(0, 1, 0));
        const aboveName = above?.name || 'air';
        if (LAVA_NAMES.has(aboveName) || WATER_NAMES.has(aboveName)) {
          buckets.surface_under_liquid++;
          continue;
        }
        if (!AIR_NAMES.has(aboveName)) {
          buckets.fully_buried++;
          continue;
        }
        exposedAny.push(p);
        const losOk = eye && typeof hasLineOfSight === 'function'
          ? hasLineOfSight(eye, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 })
          : true;
        if (losOk) {
          buckets.exposed_visible++;
          exposedVisible.push(p);
        } else {
          buckets.exposed_buried++;
        }
      }

      // Centroid: prefer visible candidates; fall back to any exposed.
      const centroidSrc = exposedVisible.length > 0 ? exposedVisible : exposedAny;
      let centroid = null;
      if (centroidSrc.length > 0) {
        let sx = 0, sy = 0, sz = 0;
        for (const p of centroidSrc) { sx += p.x; sy += p.y; sz += p.z; }
        centroid = {
          x: Math.round(sx / centroidSrc.length),
          y: Math.round(sy / centroidSrc.length),
          z: Math.round(sz / centroidSrc.length),
        };
      }

      // Verdict — what the agent should do next.
      // Order matters: unsafe trumps everything, then not_enough,
      // then mine_here vs move_to based on centroid proximity to bot.
      // Threshold of 4 exposed-visible is small enough to start a
      // batch (mc collect's batchSize=Math.min(count,20) but we want
      // to start with a healthy pool, not waste a call on 1-2 blocks).
      const totalExposed = buckets.exposed_visible + buckets.exposed_buried;
      const MIN_TO_MINE = 4;
      const NEAR_HORIZ_DIST = 3;  // L1 horizontal manhattan
      let verdict;
      let verdict_detail = null;
      if (counts.hostile >= 2) {
        verdict = 'unsafe';
        verdict_detail = `${counts.hostile} hostile mobs in r=${r}`;
      } else if (counts.lava >= 1) {
        verdict = 'unsafe';
        verdict_detail = `lava within r=${r}`;
      } else if (targetPositions.length === 0) {
        verdict = 'not_enough';
        verdict_detail = `no ${blockName} in r=${r}`;
      } else if (buckets.exposed_visible < MIN_TO_MINE && totalExposed < MIN_TO_MINE) {
        verdict = 'not_enough';
        verdict_detail = `only ${totalExposed} exposed ${blockName} (buried: ${buckets.fully_buried}, under-liquid: ${buckets.surface_under_liquid})`;
      } else if (centroid) {
        const horiz = Math.abs(centroid.x - Math.floor(me.x))
                    + Math.abs(centroid.z - Math.floor(me.z));
        verdict = horiz <= NEAR_HORIZ_DIST ? 'mine_here' : 'move_to';
        if (verdict === 'move_to') {
          verdict_detail = `centroid at ${centroid.x},${centroid.y},${centroid.z} (~${horiz} blocks away)`;
        }
      } else {
        verdict = 'not_enough';
        verdict_detail = `${targetPositions.length} ${blockName} but none with clean access`;
      }

      target = {
        block: blockName,
        total_found: targetPositions.length,
        counts: buckets,
        centroid,
        verdict,
        ...(verdict_detail ? { verdict_detail } : {}),
      };
    }

    const summary = [
      counts.lava ? `${counts.lava} lava` : null,
      counts.water ? `${counts.water} water` : null,
      counts.falling ? `${counts.falling} falling-block` : null,
      counts.hostile ? `${counts.hostile} hostile (${hostile[0].name} at ${hostile[0].dist})` : null,
      bedrock ? `bedrock at ${bedrock.dist}` : null,
    ].filter(Boolean).join(', ') || 'all clear';
    const targetSummary = target
      ? ` | ${target.block}: ${target.verdict}${target.verdict_detail ? ` (${target.verdict_detail})` : ''}, visible=${target.counts.exposed_visible} buried=${target.counts.fully_buried}`
      : '';

    return {
      ok: true,
      data: {
        center: { x: cx, y: cy, z: cz },
        radius: r,
        lava,
        water,
        falling_blocks: falling,
        bedrock,
        hostile_mobs: hostile,
        counts,
        ...(target ? { target } : {}),
      },
      result: `Scout r=${r} from ${cx},${cy},${cz}: ${summary}${targetSummary}`,
    };
  },
  };
}
