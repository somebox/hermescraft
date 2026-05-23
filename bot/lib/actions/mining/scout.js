// @size-exempt: scout find_blocks/find_entities oversized from legacy mining.js
import { bearingFromDelta, classifySector, angleDiffDegrees } from '../../shared/perception.js';
import { fail, ok } from '../../shared/action-contract.js';
import { annotateReachability } from '../_nav-helpers.js';

export function createScoutHandlers(deps) {
  const {
    ctx,
    ensureBot,
    fmt,
    posObj,
    resolveMiningBlockName,
    entitiesMatchingAfterLookSweep,
  } = deps;

  async function find_blocks({ block, radius = 32, count = 10 }) {
        const b = ensureBot();
        const blockName = resolveMiningBlockName(block);
        const blockType = ctx.world.mcData.blocksByName[blockName];
        if (!blockType) {
          return fail('UNKNOWN_BLOCK', `Unknown block "${blockName}".`, { retry_safe: false });
        }
    
        const r = Math.min(Math.max(parseInt(String(radius), 10) || 32, 1), 96);
        const n = Math.min(Math.max(parseInt(String(count), 10) || 10, 1), 64);
        const baseYawDeg = (b.entity.yaw * 180) / Math.PI;
    
        const found = b
          .findBlocks({
            matching: blockType.id,
            maxDistance: r,
            count: n,
          })
          .map((p) => {
            const dx = p.x - b.entity.position.x;
            const dz = p.z - b.entity.position.z;
            const relDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
            return {
              position: { x: p.x, y: p.y, z: p.z },
              distance: fmt(b.entity.position.distanceTo(p)),
              bearing: bearingFromDelta(dx, dz),
              sector: classifySector(angleDiffDegrees(baseYawDeg, relDeg)),
            };
          });
    
        if (found.length === 0) {
          return ok({ result: `No ${blockName} found within ${r} blocks.`, locations: [] });
        }
    
        const rawLocations = found.map((entry) => ({
          x: entry.position.x,
          y: entry.position.y,
          z: entry.position.z,
          distance: entry.distance,
          bearing: entry.bearing,
          sector: entry.sector,
        }));
        // #92: enrich with reachability + approach_cell so the agent
        // doesn't burn 30s walking toward a buried/floating candidate.
        // Sorted reachable-first by annotateReachability. maxVisit=512
        // gives the BFS ~D=8-15 coverage in typical terrain — enough for
        // 32-block scan_range while keeping latency under ~200ms total.
        const locations = annotateReachability(b, rawLocations, 512);
        const nReachable = locations.filter((l) => l.reachable).length;
    
        const fpNote = ctx.reactive.fairPlayMode ? ` (scout; mc collect needs trunk in sight)` : '';
        const reachNote = nReachable === locations.length
          ? ''
          : ` — ${nReachable}/${locations.length} reachable`;
        return ok({ result: `Found ${found.length} ${blockName}${fpNote}${reachNote}`, locations });
  }

  async function find_entities({ type, radius = 32 }) {
        const b = ensureBot();
        const pos = b.entity.position;
        const r = Math.min(96, Math.max(4, parseInt(String(radius), 10) || 32));
    
        let raw;
        if (ctx.reactive.fairPlayMode) {
          raw = await entitiesMatchingAfterLookSweep(b, pos, r, type);
        } else {
          raw = Object.values(b.entities).filter((e) => e !== b.entity && e.position.distanceTo(pos) < r);
          if (type) {
            const tl = String(type).toLowerCase();
            raw = raw.filter(
              (e) =>
                (e.name || '').toLowerCase().includes(tl) ||
                (e.username || '').toLowerCase().includes(tl) ||
                (e.displayName || '').toLowerCase().includes(tl),
            );
          }
        }
    
        let entities = raw
          .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
          .slice(0, 20)
          .map((e) => ({
            type: e.username || e.name || e.displayName || 'unknown',
            distance: fmt(e.position.distanceTo(pos)),
            position: posObj(e.position),
            health: e.health ?? undefined,
          }));
    
        return {
          result: `Found ${entities.length} ${type || 'entities'}${ctx.reactive.fairPlayMode ? ' (look sweep)' : ''}`,
          locations: entities.map((e) => ({ ...e.position, distance: e.distance, type: e.type })),
          entities,
        };
  }

  return { find_blocks, find_entities };
}
