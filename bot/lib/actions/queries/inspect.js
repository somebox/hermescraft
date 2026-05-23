import { Vec3 } from 'vec3';
import { RELOCATABLE_INFRASTRUCTURE, suggestedToolForBlock, isDigProtected } from '../../runtime/dig-tools.js';

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
    const isDiggable = !isAir && !isDigProtected(blockName, { x: ix, y: iy, z: iz }, ctx);
    const isRelocatable = RELOCATABLE_INFRASTRUCTURE.has(blockName);
    const suggestedTool = isAir ? null : suggestedToolForBlock(blockName);

    // Entities occupying this cell (foot or head). 1.8-block tall entities
    // occupy floor(ey) and floor(ey)+1.
    const entitiesAt = [];
    for (const e of Object.values(b.entities || {})) {
      if (!e || !e.position) continue;
      const ex = Math.floor(e.position.x);
      const ez = Math.floor(e.position.z);
      const ey = Math.floor(e.position.y);
      if (ex !== ix || ez !== iz) continue;
      if (ey !== iy && ey + 1 !== iy) continue;
      entitiesAt.push({
        type: e.type || null,
        name: e.name || null,
        username: e.username || null,
        position: { x: e.position.x, y: e.position.y, z: e.position.z },
      });
    }

    const occupied = (!isAir) || entitiesAt.length > 0;
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
        },
        entities_at: entitiesAt,
        occupied,
      },
      result: `Block at ${ix},${iy},${iz}: ${blockName}${entitiesAt.length ? ` (${entitiesAt.length} entity${entitiesAt.length > 1 ? 'ies' : ''} here)` : ''}`,
    };
  },
  };
}
