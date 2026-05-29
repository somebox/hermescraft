import { Vec3 } from 'vec3';
import { RELOCATABLE_INFRASTRUCTURE, suggestedToolForBlock, isDigProtected } from '../../runtime/dig-tools.js';
import { entitiesAtBlockingCell } from '../../shared/entity-blocking.js';
import { placementCellInsight } from '../../shared/placement-insight.js';

export function createInspectQueries({ ctx, ensureBot }) {
  return {
  /**
   * F45.6: Inspect a single cell — what's the block, can it be dug, is it
   * relocatable, what tool should be used, and which entities (players /
   * mobs) overlap that cell. Use proactively to avoid place-fail-then-recover.
   */
  async inspect({ x, y, z }) {
    const b = ensureBot();
    if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
      return {
        ok: false,
        error: {
          code: 'INVALID_COORD',
          message: 'mc inspect requires numeric x, y, z',
          retry_safe: false,
        },
      };
    }
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
        coord: { x: ix, y: iy, z: iz },
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
