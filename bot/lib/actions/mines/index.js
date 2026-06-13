import { ok, fail } from '../../shared/action-contract.js';
import { normalizeMineId, POINT_KINDS } from '../../runtime/mines/index.js';

/**
 * Mine registry verbs — the agent interface to the flat annotated mine
 * registry (ctx.runtime.mines). Reads surface mines + points with distances;
 * writes register a mine, drop annotated points, and set lifecycle status.
 *
 * The reactive hazard path (dig breach) writes danger points directly via
 * the store, not through these verbs.
 */
export function createMinesActions(deps) {
  const { ctx, ensureBot, posObj } = deps;

  function requireStore() {
    const store = ctx.runtime?.mines;
    if (!store) return { error: fail('UNAVAILABLE', 'Mine registry not initialized', { retry_safe: true }) };
    return { store };
  }

  function botPos() {
    const bot = ctx.world?.bot;
    if (!bot?.entity?.position) return null;
    const p = posObj ? posObj(bot.entity.position) : bot.entity.position;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }

  function resolvePos(body) {
    if (body.x != null && body.y != null && body.z != null) {
      const x = Number(body.x), y = Number(body.y), z = Number(body.z);
      if ([x, y, z].every(Number.isFinite)) return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
    }
    return botPos();
  }

  return {
    async mine_open(body) {
      ensureBot();
      const got = requireStore();
      if (got.error) return got.error;
      const id = normalizeMineId(body.id);
      if (!id) return fail('INVALID_ID', 'mine_open requires an id (e.g. mc mine_open iron_north north 12 iron_ore)', { retry_safe: false });
      const entrance = resolvePos(body);
      if (!entrance) return fail('NO_POSITION', 'Bot position unknown and no X Y Z given', { retry_safe: true });
      const mine = got.store.open({
        id,
        entrance,
        dir: body.dir || null,
        target_y: body.target_y != null ? Number(body.target_y) : null,
        resource: body.resource || null,
        by: ctx.config?.mc?.username || null,
      });
      return ok({
        result: `Mine "${id}" open — entrance ${entrance.x},${entrance.y},${entrance.z} (${mine.entrances.length} route${mine.entrances.length > 1 ? 's' : ''} to surface)`,
        data: { mine },
      });
    },

    async mine_note(body) {
      ensureBot();
      const got = requireStore();
      if (got.error) return got.error;
      const id = normalizeMineId(body.id);
      if (!id) return fail('INVALID_ID', 'mine_note requires a mine id', { retry_safe: false });
      if (!got.store.get(id)) {
        return fail('MINE_NOT_FOUND', `No mine "${id}" — open it first with mc mine_open ${id}`, { retry_safe: false });
      }
      const kind = String(body.kind || '').toLowerCase();
      if (!POINT_KINDS.has(kind)) {
        return fail('INVALID_KIND', `kind must be one of: ${[...POINT_KINDS].join(', ')}`, { retry_safe: false });
      }
      const pos = resolvePos(body);
      if (!pos) return fail('NO_POSITION', 'Bot position unknown and no X Y Z given', { retry_safe: true });
      let point;
      try {
        point = got.store.addPoint(id, {
          kind,
          pos,
          tags: body.tags || [],
          note: body.note || '',
          dir: body.dir || null,
          target_y: body.target_y != null ? Number(body.target_y) : null,
          resource: body.resource || null,
          qty_estimate: body.qty != null ? Number(body.qty) : null,
          hazard: body.hazard || null,
          sealed: body.sealed === true || body.sealed === 'true',
          by: ctx.config?.mc?.username || null,
        });
      } catch (e) {
        return fail('INVALID_ARGS', String(e.message || e), { retry_safe: false });
      }
      return ok({
        result: `Noted ${kind} "${point.id}" at ${pos.x},${pos.y},${pos.z} in mine "${id}"`,
        data: { point },
      });
    },

    async mine_status(body) {
      const got = requireStore();
      if (got.error) return got.error;
      const id = normalizeMineId(body.id);
      const mine = id ? got.store.get(id) : null;
      if (!mine) return fail('MINE_NOT_FOUND', `No mine "${id}"`, { retry_safe: false });
      try {
        const updated = got.store.setStatus(id, String(body.status));
        return ok({ result: `Mine "${id}" status → ${updated.status}`, data: { mine: updated } });
      } catch (e) {
        return fail('INVALID_ARGS', String(e.message || e), { retry_safe: false });
      }
    },

    async mine_list(body) {
      const got = requireStore();
      if (got.error) return got.error;
      const rows = got.store.listForApi({ botPos: botPos() });
      return ok({
        result: rows.length ? `${rows.length} mine(s)` : 'No mines registered',
        data: { mines: rows },
      });
    },

    async mine_show(body) {
      const got = requireStore();
      if (got.error) return got.error;
      const id = normalizeMineId(body.id);
      const rows = got.store.listForApi({ botPos: botPos() });
      const mine = rows.find((m) => m.id === id);
      if (!mine) return fail('MINE_NOT_FOUND', `No mine "${id}"`, { retry_safe: false });
      const frontiers = mine.points.filter((p) => p.kind === 'frontier' && p.status === 'open');
      return ok({
        result: `Mine "${id}" (${mine.status}): ${mine.points.length} point(s), ${frontiers.length} open frontier(s)`,
        data: { mine },
      });
    },

    async mine_resume(body) {
      const got = requireStore();
      if (got.error) return got.error;
      const id = normalizeMineId(body.id);
      const mine = got.store.get(id);
      if (!mine) return fail('MINE_NOT_FOUND', `No mine "${id}"`, { retry_safe: false });
      const here = botPos();
      const open = (mine.points || []).filter((p) => p.kind === 'frontier' && p.status === 'open');
      if (!open.length) {
        return fail('NO_OPEN_FRONTIER', `Mine "${id}" has no open frontier to resume — dig a new descent or tunnel`, {
          retry_safe: false,
        });
      }
      // Nearest open frontier by horizontal distance (a mine is a column;
      // the bot may be on the surface far above the workings).
      const withDist = open.map((p) => ({
        point: p,
        dist: here ? Math.round(Math.hypot(p.pos.x - here.x, p.pos.z - here.z)) : null,
      }));
      withDist.sort((a, b) => (a.dist ?? 9999) - (b.dist ?? 9999));
      const best = withDist[0];
      const p = best.point;
      const goto = `mc goto_near ${p.pos.x} ${p.pos.y} ${p.pos.z} 1`;
      const tunnel = p.dir
        ? `mc tunnel ${p.pos.x} ${p.pos.y} ${p.pos.z} ${p.dir} 16`
        : null;
      return ok({
        result: `Resume mine "${id}" at frontier ${p.id} (${p.pos.x},${p.pos.y},${p.pos.z}`
          + `${p.dir ? `, heading ${p.dir}` : ''}${best.dist != null ? `, ~${best.dist} blocks away` : ''}). ${goto}`,
        data: {
          frontier: p,
          open_frontiers: open.length,
          next_actions: [goto, ...(tunnel ? [tunnel] : [])],
        },
      });
    },

    async mine_remove(body) {
      const got = requireStore();
      if (got.error) return got.error;
      const id = normalizeMineId(body.id);
      if (!got.store.get(id)) return fail('MINE_NOT_FOUND', `No mine "${id}"`, { retry_safe: false });
      const confirmed = body.confirm === true || body.confirm === 'true';
      if (!confirmed) {
        return fail('MISSING_CONFIRM', `Refusing to remove mine "${id}" (loses its discovery state) without confirm=true`, {
          next_action_hint: `mc mine_remove ${id} --confirm`,
          retry_safe: true,
        });
      }
      got.store.removeById(id);
      return ok({ result: `Removed mine "${id}"`, data: { id } });
    },

    async mine_reload(body) {
      const got = requireStore();
      if (got.error) return got.error;
      got.store.reload();
      const n = got.store.list().length;
      return ok({ result: `Reloaded mine registry from disk — ${n} mine(s)`, data: { count: n } });
    },
  };
}
