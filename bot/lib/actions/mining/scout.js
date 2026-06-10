// @size-exempt: scout find_blocks/find_entities oversized from legacy mining.js
import { bearingFromDelta, classifySector, angleDiffDegrees } from '../../shared/perception.js';
import { fail, ok } from '../../shared/action-contract.js';
import { annotateReachability } from '../_nav-helpers.js';
import { toolReadiness } from '../../runtime/inventory-hints.js';
import { blockRef } from '../../shared/typed-nouns.js';

// IMPORTANT: `find_blocks` uses raw `b.findBlocks` — an x-ray scan that
// doesn't gate on line-of-sight. That's deliberate: scout's job is to
// REPORT what exists, not to confirm reachability. `mc collect`, in
// contrast, applies a per-candidate LOS check (canSeeBotFacingFace) and
// will refuse to mine candidates whose bot-facing face is occluded
// (causes.behind_wall). So scout results are a SUPERSET of collect's
// minable set in fair-play mode.
//
// `fairPlayCollectNote` surfaces this mismatch to callers as a string
// suffix on the result message, mirroring discovery.js's trunk-harvest
// detection so the wording matches what collect will actually require:
//   - trunks (logs/stems) → fairPlayHarvestTrunkCandidates needs the
//     trunk in line-of-sight (historical "trunk in sight" wording)
//   - non-solid plants (grass/flowers/crops) → proximity search, no LOS
//     requirement, so we skip the note
//   - everything else (cobble, ore, stone, dirt) → raycast visibility
//     sweep, i.e. the bot must be able to see the block face
//
// Reachability is a SEPARATE concern, surfaced via `annotateReachability`
// in `find_blocks` (the `reachable` field on each location). A candidate
// can be reachable (pathfinder can navigate to within range) AND fail
// LOS (a block sits between bot eye and the candidate's face) — both
// checks must pass for collect to mine the cell.
const TRUNK_RE = /_log$|_stem$|^crimson_stem$|^warped_stem$/i;
export function fairPlayCollectNote(blockName, blockType) {
  if (TRUNK_RE.test(blockName)) return ' (scout; mc collect needs trunk in sight)';
  if (blockType && blockType.boundingBox !== 'block') return '';   // non-solid plant: proximity
  return ' (scout; mc collect needs line-of-sight to the block face)';
}

export function createScoutHandlers(deps) {
  const {
    ctx,
    ensureBot,
    fmt,
    posObj,
    resolveMiningBlockName,
    entitiesMatchingAfterLookSweep,
  } = deps;

  /**
   * Locate blocks of a given name within radius. Returns x-ray scan
   * results (no LOS gating); each entry carries `reachable` from BFS
   * pathfinding annotation. mc collect WILL re-check LOS at dig time and
   * reject candidates whose bot-facing face is occluded — see the note
   * suffix added in fair-play mode for the user-facing version of this.
   */
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
        const locations = annotateReachability(b, rawLocations, 512).map((loc) => {
          const origin = {
            x: b.entity.position.x,
            y: b.entity.position.y,
            z: b.entity.position.z,
          };
          return {
            ...loc,
            block_ref: blockRef(
              { name: blockName, x: loc.x, y: loc.y, z: loc.z },
              origin,
              {
                reachable: loc.reachable,
                ...(loc.approach_cell ? { approach_cell: loc.approach_cell } : {}),
              },
            ),
          };
        });
        const nReachable = locations.filter((l) => l.reachable).length;
    
        const fpNote = ctx.reactive.fairPlayMode ? fairPlayCollectNote(blockName, blockType) : '';
        const reachNote = nReachable === locations.length
          ? ''
          : ` — ${nReachable}/${locations.length} reachable`;
        // Pre-emptive tool-readiness check. Saves the agent a wasted walk +
        // dig attempt when scanning for blocks they can't mine. Adds a hint
        // string to the result message AND a structured tool_readiness
        // object to the data envelope so reasoning can branch deterministically.
        const toolStatus = toolReadiness(b, blockName);
        const toolNote = toolStatus?.hint ? ` — ${toolStatus.hint}` : '';
        return ok({
          result: `Found ${found.length} ${blockName}${fpNote}${reachNote}${toolNote}`,
          locations,
          tool_readiness: toolStatus,
        });
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
