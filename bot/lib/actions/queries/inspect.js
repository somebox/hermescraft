import { Vec3 } from 'vec3';
import { RELOCATABLE_INFRASTRUCTURE, suggestedToolForBlock, isDigProtected } from '../../runtime/dig-tools.js';
import { entitiesAtBlockingCell } from '../../shared/entity-blocking.js';
import { placementCellInsight } from '../../shared/placement-insight.js';
import { blockRef } from '../../shared/typed-nouns.js';

function resolveInspectCoords(body, locations) {
  const mk = body?.mark ?? body?.at_mark;
  if (mk && locations?.load) {
    const locs = locations.load();
    const m = locs[String(mk)];
    if (!m) {
      return {
        err: {
          ok: false,
          error: {
            code: 'UNKNOWN_MARK',
            message: `Unknown mark '${mk}'`,
            retry_safe: false,
          },
        },
      };
    }
    return { x: m.x, y: m.y, z: m.z, mark: String(mk) };
  }
  const x = body?.x;
  const y = body?.y;
  const z = body?.z;
  if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
    return {
      err: {
        ok: false,
        error: {
          code: 'INVALID_COORD',
          message: 'mc inspect requires numeric x, y, z or --mark <name>',
          retry_safe: false,
        },
      },
    };
  }
  return { x: Number(x), y: Number(y), z: Number(z) };
}

export function createInspectQueries({ ctx, ensureBot, locations }) {
  return {
  /**
   * F45.6: Inspect a single cell — what's the block, can it be dug, is it
   * relocatable, what tool should be used, and which entities (players /
   * mobs) overlap that cell. Use proactively to avoid place-fail-then-recover.
   */
  async inspect(body) {
    const b = ensureBot();
    const resolved = resolveInspectCoords(body || {}, locations);
    if (resolved.err) return resolved.err;
    const { x, y, z, mark } = resolved;
    const ix = Math.floor(Number(x));
    const iy = Math.floor(Number(y));
    const iz = Math.floor(Number(z));
    const cellPos = new Vec3(ix, iy, iz);
    const blk = b.blockAt(cellPos);
    const blockName = blk?.name || 'unknown';
    const hardness = (typeof blk?.hardness === 'number') ? blk.hardness : null;
    const boundingBox = blk?.boundingBox || null;
    const isAir = blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air';
    const placement = placementCellInsight(blockName, { x: ix, y: iy, z: iz }, ctx);
    const isDiggable = !isAir && !isDigProtected(blockName, { x: ix, y: iy, z: iz }, ctx);
    const isRelocatable = RELOCATABLE_INFRASTRUCTURE.has(blockName);
    const suggestedTool = isAir ? null : suggestedToolForBlock(blockName);

    // Entities that block placement (players/mobs). Drops/projectiles omitted —
    // same rules as mc place TARGET_ENTITY_OCCUPIED pre-flight.
    const blocking = entitiesAtBlockingCell(b.entities, ix, iy, iz, { exclude: b.entity });
    const entitiesAt = blocking.map((e) => ({
      type: e.type || null,
      name: e.name || null,
      username: e.username || null,
      position: { x: e.position.x, y: e.position.y, z: e.position.z },
    }));

    const occupied = (!isAir) || entitiesAt.length > 0;
    let result = `Block at ${ix},${iy},${iz}: ${blockName}`;
    if (placement.blocks_placement && placement.placement_hint) {
      result += ` — ${placement.placement_hint}`;
    } else if (entitiesAt.length) {
      result += ` (${entitiesAt.length} entity${entitiesAt.length > 1 ? 'ies' : ''} here)`;
    }
    return {
      ok: true,
      data: {
        ...(mark ? { mark } : {}),
        coord: { x: ix, y: iy, z: iz },
        block_ref: blockRef(
          { name: blockName, x: ix, y: iy, z: iz },
          {
            x: b.entity.position.x,
            y: b.entity.position.y,
            z: b.entity.position.z,
          },
        ),
        block: {
          name: blockName,
          is_air: isAir,
          is_diggable: isDiggable,
          is_relocatable: isRelocatable,
          is_protected: !isAir && !isDiggable,
          suggested_tool: suggestedTool,
          hardness,
          bounding_box: boundingBox,
          blocks_placement: placement.blocks_placement === true,
          ...(placement.placement_hint ? { placement_hint: placement.placement_hint } : {}),
        },
        entities_at: entitiesAt,
        occupied,
      },
      result,
    };
  },
  };
}
