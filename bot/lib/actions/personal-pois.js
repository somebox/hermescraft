/**
 * Personal POI actions — `mc poi_add`, `pois`, `go_poi`, `unpoi`,
 * `poi_update`, `poi_check_torch`.
 *
 * Modeled on `marks.js` but tailored to private waypoints with optional
 * sign_at + torch_at linkage. The data layer lives in
 * `bot/lib/runtime/personal-pois.js`; this module is the action surface.
 *
 * Stores are intentionally separate from fleet marks (`locations.js`).
 * A POI named `spider_hill` and a mark named `spider_hill` are
 * different things and may coexist.
 */
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import {
  OperationTimeoutError,
  NoProgressError,
  ACTION_CAPS_MS,
  pathfindGotoNear,
  timeoutError,
} from './_helpers.js';
import { ok, fail } from '../shared/action-contract.js';

const { goals: _goals } = pathfinderPkg;

const TORCH_BLOCK_NAMES = new Set(['torch', 'wall_torch']);

/**
 * Parse an optional sign_at / torch_at coord from action body. Accepts:
 *   - { sign_at: { x, y, z } }     (object form)
 *   - { sign_at_x, sign_at_y, sign_at_z }  (flattened form from CLI)
 *
 * Returns null when none of those are present, or { x, y, z } when all
 * three coords resolve to finite integers. Throws on partial coords so
 * the caller surfaces an explicit error envelope.
 */
function parseLinkedCoord(body, prefix) {
  const obj = body[prefix];
  if (obj && typeof obj === 'object') {
    const x = Number(obj.x);
    const y = Number(obj.y);
    const z = Number(obj.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
    }
    throw new Error(`${prefix} must have finite x,y,z`);
  }
  const fx = body[`${prefix}_x`];
  const fy = body[`${prefix}_y`];
  const fz = body[`${prefix}_z`];
  if (fx == null && fy == null && fz == null) return null;
  const x = Number(fx);
  const y = Number(fy);
  const z = Number(fz);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(`${prefix} requires all three coords; got ${prefix}_x=${fx} ${prefix}_y=${fy} ${prefix}_z=${fz}`);
  }
  return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
}

/**
 * createPersonalPoiActions — POI CRUD verbs registered alongside marks.
 */
export function createPersonalPoiActions(deps) {
  const {
    ctx,
    config,
    ensureBot,
    posObj,
    loadPersonalPois,
    savePersonalPois,
    addPersonalPoi,
    flagPoiTorchMissing,
    clearPoiTorchMissing,
    buildPersonalPoisListApi,
    services,
  } = deps;

  return {
    /**
     * poi_add — declare a POI. Default position is bot's standing cell;
     * pass --at X Y Z for a remote landmark. Optional sign_at / torch_at
     * record the linked in-world anchor blocks (set when the agent has
     * also placed a sign / torch nearby; null otherwise).
     */
    async poi_add(body) {
      ensureBot();
      const name = body.name != null ? String(body.name).trim() : '';
      if (!name) return fail('INVALID_ARGS', 'Missing POI name', { retry_safe: false });

      // Resolve coords: explicit --at takes precedence, else bot foot pos.
      let at;
      if (body.at && typeof body.at === 'object') {
        at = {
          x: Number(body.at.x),
          y: Number(body.at.y),
          z: Number(body.at.z),
        };
      } else if (body.x != null || body.y != null || body.z != null) {
        at = { x: Number(body.x), y: Number(body.y), z: Number(body.z) };
      } else {
        at = posObj();
      }
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) {
        return fail('INVALID_ARGS', 'poi_add: x,y,z must be finite', { retry_safe: false });
      }

      let sign_at = null;
      let torch_at = null;
      try {
        sign_at = parseLinkedCoord(body, 'sign_at');
        torch_at = parseLinkedCoord(body, 'torch_at');
      } catch (e) {
        return fail('INVALID_ARGS', String(e.message || e), { retry_safe: false });
      }

      const stored = addPersonalPoi({
        name,
        x: at.x,
        y: at.y,
        z: at.z,
        kind: body.kind != null ? String(body.kind) : null,
        sign_at,
        torch_at,
        note: body.note != null ? String(body.note) : '',
        agent_owner: config?.mc?.username ?? null,
      });

      return ok({
        result: `Saved POI '${name}' at ${stored.x},${stored.y},${stored.z}`,
        data: { poi: stored },
      });
    },

    /**
     * poi_update — patch metadata without moving the POI. Use this to
     * link a previously-anonymous POI to a sign/torch coord after the
     * fact, or to update kind/note.
     */
    async poi_update(body) {
      ensureBot();
      const name = body.name != null ? String(body.name) : '';
      if (!name) return fail('INVALID_ARGS', 'Missing POI name', { retry_safe: false });
      const pois = loadPersonalPois();
      if (!pois[name]) return ok({ result: `No POI '${name}'` });
      const p = pois[name];
      const now = new Date().toISOString();
      if (body.kind !== undefined) p.kind = body.kind === null ? null : String(body.kind);
      if (body.note !== undefined) p.note = String(body.note);
      try {
        if (body.sign_at !== undefined || body.sign_at_x !== undefined) {
          p.sign_at = parseLinkedCoord(body, 'sign_at');
        }
        if (body.torch_at !== undefined || body.torch_at_x !== undefined) {
          p.torch_at = parseLinkedCoord(body, 'torch_at');
        }
      } catch (e) {
        return fail('INVALID_ARGS', String(e.message || e), { retry_safe: false });
      }
      p.last_seen = now;
      savePersonalPois(pois);
      return ok({ result: `Updated POI '${name}'`, data: { poi: p } });
    },

    /**
     * pois — list all POIs with distance from the bot. Mirrors `mc marks`
     * output for consistency; agents can scan the textual lines or
     * consume the `data.pois` array.
     */
    async pois() {
      ensureBot();
      const list = buildPersonalPoisListApi();
      if (!list.length) return ok({ result: 'No saved POIs', data: { pois: [] } });
      const lines = list.map((e) => {
        const torchTag = e.torch_missing_since ? ' ⚠TORCH-MISSING' : '';
        const signTag = e.sign_at ? ` sign@(${e.sign_at.x},${e.sign_at.y},${e.sign_at.z})` : '';
        return `${e.stale ? '⚠ STALE ' : ''}${e.name}: ${e.x},${e.y},${e.z} (${e.distance_m}m)${
          e.kind ? ` [${e.kind}]` : ''
        }${signTag}${torchTag}${e.note ? ` — ${e.note}` : ''}`;
      });
      return ok({ result: lines.join('\n'), data: { pois: list } });
    },

    /**
     * go_poi — navigate to a POI. Mirrors the `go_mark` pathfind flow
     * (configurable navigateToTarget vs raw pathfindGotoNear). Updates
     * `last_visited` and `visit_count` on arrival.
     */
    async go_poi({ name }) {
      const pois = loadPersonalPois();
      if (!pois[name]) return ok({ result: `No POI '${name}'` });
      const p = pois[name];
      const b = ensureBot();
      const navigateToTarget = services?.getActions?.()?._navigateToTarget;
      if (config?.behaviors?.navMoveResolve === true && typeof navigateToTarget === 'function') {
        const nav = await navigateToTarget({ x: p.x, y: p.y, z: p.z, near: 2, mark: name });
        if (!nav?.ok) return nav;
        p.last_visited = new Date().toISOString();
        p.visit_count = (p.visit_count || 0) + 1;
        savePersonalPois(pois);
        return ok({
          result: `Arrived at POI '${name}' (${p.x},${p.y},${p.z})`,
          data: { poi: pois[name], via: 'navigateToTarget' },
        });
      }
      try {
        await pathfindGotoNear(b, _goals, p.x, p.y, p.z, 2, {
          opName: 'go_poi',
          capMs: ACTION_CAPS_MS.go_mark,
        });
      } catch (err) {
        try { b.pathfinder.setGoal(null); } catch { /* ignore */ }
        if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
          return timeoutError('go_poi', ACTION_CAPS_MS.go_mark, {
            poi: name,
            target: { x: p.x, y: p.y, z: p.z },
            current: {
              x: b.entity.position.x,
              y: b.entity.position.y,
              z: b.entity.position.z,
            },
          }, `Could not reach POI '${name}'. Path may be blocked.`);
        }
        if (err instanceof NoProgressError || err.code === 'NAV_NO_PROGRESS') {
          return fail('NAV_NO_PROGRESS', `Stalled while heading to POI '${name}' — bot stopped moving.`, {
            observed_state: {
              poi: name,
              target: { x: p.x, y: p.y, z: p.z },
              stalled_position: err.info?.stalled_position,
              current: {
                x: b.entity.position.x,
                y: b.entity.position.y,
                z: b.entity.position.z,
              },
            },
            next_action_hint: 'mc escape   # try a non-pathfinder escape first',
            retry_safe: false,
          });
        }
        throw err;
      }
      p.last_visited = new Date().toISOString();
      p.visit_count = (p.visit_count || 0) + 1;
      savePersonalPois(pois);
      return ok({
        result: `Arrived at POI '${name}' (${p.x},${p.y},${p.z})`,
        data: { poi: pois[name] },
      });
    },

    /**
     * unpoi — delete a POI by name.
     */
    async unpoi({ name }) {
      const pois = loadPersonalPois();
      if (!pois[name]) return ok({ result: `No POI '${name}'` });
      delete pois[name];
      savePersonalPois(pois);
      return ok({ result: `Deleted POI '${name}'` });
    },

    /**
     * poi_check_torch — read the block at `torch_at` and flag/clear the
     * `torch_missing_since` field. No-op when the POI has no torch_at
     * linkage. Returns the current torch status so the agent can decide
     * to re-place via `mc place_torch` or escalate via `mc chat`.
     */
    async poi_check_torch({ name }) {
      const b = ensureBot();
      const pois = loadPersonalPois();
      if (!pois[name]) return ok({ result: `No POI '${name}'` });
      const p = pois[name];
      if (!p.torch_at) {
        return ok({
          result: `POI '${name}' has no linked torch_at; nothing to check.`,
          data: { poi: p, torch_status: 'unlinked' },
        });
      }
      const { x, y, z } = p.torch_at;
      const block = b.blockAt(new Vec3(x, y, z));
      const blockName = block?.name ?? null;
      const present = blockName != null && TORCH_BLOCK_NAMES.has(blockName);

      if (present) {
        clearPoiTorchMissing(name);
        return ok({
          result: `POI '${name}' torch present (${blockName} at ${x},${y},${z}).`,
          data: { poi: loadPersonalPois()[name], torch_status: 'present', observed_block: blockName },
        });
      }

      flagPoiTorchMissing(name);
      const refreshed = loadPersonalPois()[name];
      return ok({
        result: `POI '${name}' torch MISSING at ${x},${y},${z} (block is '${blockName ?? 'unloaded'}'). Decide: mc place_torch ${x} ${y} ${z}, or mc chat "<bot>: missing torch at ${name}".`,
        data: {
          poi: refreshed,
          torch_status: 'missing',
          observed_block: blockName,
          torch_missing_since: refreshed.torch_missing_since,
        },
        next_action_hint: `mc place_torch ${x} ${y} ${z}`,
      });
    },
  };
}
