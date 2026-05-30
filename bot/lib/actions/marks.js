import pathfinderPkg from 'mineflayer-pathfinder';
import { raceWithTimeout, timeoutError, OperationTimeoutError, NoProgressError, ACTION_CAPS_MS, pathfindGotoNear } from './_helpers.js';
import { ok, fail } from '../shared/action-contract.js';

const { goals } = pathfinderPkg;

/**
 * createMarksActions — extracted from former lib/actions/containers.js (Phase 5 split).
 */
export function createMarksActions(deps) {
  const { ctx, config, ensureBot, goals, fmt, posObj, sleep, log, loadLocations, saveLocations, flagMarkStale, clearMarkStale, resolveMarkPlaceFromBody, resolveContainerCoords, normalizeDepositWithdrawItems, buildMarksListApi, isContainerBlock, findNearbyContainer, snapshotChestAtPosition, rememberSocialEvent, saveReminders, getMyName, services } = deps;
  return {
    async mark(body) {
      ensureBot();
      const name = body.name != null ? String(body.name).trim() : '';
      if (!name) return fail('INVALID_ARGS', 'Missing mark name', { retry_safe: false });
      const locsPre = loadLocations();
      const place = resolveMarkPlaceFromBody(body, locsPre) || posObj();
      const noteRaw = body.note != null ? String(body.note) : '';
      const now = new Date().toISOString();
      const locs = loadLocations();

      const prev = locs[name] || {};
      locs[name] = {
        x: Math.round(place.x),
        y: Math.round(place.y),
        z: Math.round(place.z),
        note: noteRaw,
        saved: prev.saved ?? now,
        updated: now,
        category:
          body.category !== undefined ? (body.category === null ? null : String(body.category)) : (prev.category ?? null),
        radius: body.radius !== undefined ? Number(body.radius) : (prev.radius ?? null),
        mode: body.mode !== undefined ? (body.mode === null ? null : String(body.mode)) : (prev.mode ?? null),
        stale: body.stale !== undefined ? Boolean(body.stale) : false,
        stale_reason: body.stale ? (prev.stale_reason ?? null) : null,
        last_visited: prev.last_visited ?? null,
        visit_count: typeof prev.visit_count === 'number' ? prev.visit_count : 0,
      };
      saveLocations(locs);
      const l = locs[name];
      return ok({
        result: `Saved '${name}' at ${l.x}, ${l.y}, ${l.z}`,
        data: { mark: l },
      });
    },

    async mark_update(body) {
      ensureBot();
      const name = body.name != null ? String(body.name) : '';
      if (!name) return fail('INVALID_ARGS', 'Missing mark name', { retry_safe: false });
      const locs = loadLocations();
      if (!locs[name]) return ok({ result: `No location '${name}'` });

      const m = locs[name];
      const now = new Date().toISOString();
      if (body.note !== undefined) m.note = String(body.note);
      if (body.category !== undefined) m.category = body.category === null ? null : String(body.category);
      if (body.radius !== undefined) m.radius = Number(body.radius);
      if (body.mode !== undefined) m.mode = body.mode === null ? null : String(body.mode);
      if (body.stale !== undefined) m.stale = Boolean(body.stale);
      if (body.at || body.at_mark) {
        const alt = resolveMarkPlaceFromBody(body, locs);
        if (!alt) return fail('INVALID_ARGS', 'Invalid at/at_mark for relocation', { retry_safe: false });
        m.x = alt.x;
        m.y = alt.y;
        m.z = alt.z;
      }
      m.updated = now;
      saveLocations(locs);
      return ok({ result: `Updated '${name}'`, data: { mark: m } });
    },

    async marks() {
      const b = ensureBot();
      const list = buildMarksListApi();
      if (!list.length) return ok({ result: 'No saved locations', data: { marks: [] } });
      const lines = list.map((e) =>
        `${e.stale ? '⚠ STALE ' : ''}${e.name}: ${e.x},${e.y},${e.z} (${e.distance_m}m)${
          e.note ? ` — ${e.note}` : ''
        }${e.category ? ` [${e.category}]` : ''}${
          e.stale_reason ? ` (${e.stale_reason})` : ''
        }`,
      );
      return ok({ result: lines.join('\n'), data: { marks: list } });
    },

    async go_mark({ name }) {
      const locs = loadLocations();
      if (!locs[name]) return ok({ result: `No location '${name}'` });
      const l = locs[name];
      const b = ensureBot();
      const navigateToTarget = services?.getActions?.()?.navigateToTarget;
      if (config?.behaviors?.navMoveResolve === true && typeof navigateToTarget === 'function') {
        const nav = await navigateToTarget({ x: l.x, y: l.y, z: l.z, near: 2, mark: name });
        if (!nav?.ok) return nav;
        l.last_visited = new Date().toISOString();
        l.visit_count = (l.visit_count || 0) + 1;
        saveLocations(locs);
        return ok({
          result: `Arrived at '${name}' (${l.x},${l.y},${l.z})`,
          data: { mark: locs[name], via: 'navigateToTarget' },
        });
      }
      try {
        await pathfindGotoNear(b, goals, l.x, l.y, l.z, 2, { opName: 'go_mark', capMs: ACTION_CAPS_MS.go_mark });
      } catch (err) {
        try { b.pathfinder.setGoal(null); } catch { /* ignore */ }
        if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
          return timeoutError('go_mark', ACTION_CAPS_MS.go_mark, {
            mark: name,
            target: { x: l.x, y: l.y, z: l.z },
            current: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
          }, `Could not reach mark '${name}'. Path may be blocked.`);
        }
        if (err instanceof NoProgressError || err.code === 'NAV_NO_PROGRESS') {
          return fail('NAV_NO_PROGRESS', `Stalled while heading to mark '${name}' — bot stopped moving for ${err.info?.no_progress_for_ms || '?'}ms. Path likely blocked by a 1-block lip, wedge, or sealed route.`, {
            observed_state: {
              mark: name,
              target: { x: l.x, y: l.y, z: l.z },
              stalled_position: err.info?.stalled_position,
              current: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
            },
            next_action_hint: 'mc escape   # try a non-pathfinder escape first',
            retry_safe: false,
          });
        }
        throw err;
      }
      l.last_visited = new Date().toISOString();
      l.visit_count = (l.visit_count || 0) + 1;
      saveLocations(locs);
      return ok({ result: `Arrived at '${name}' (${l.x},${l.y},${l.z})`, data: { mark: locs[name] } });
    },

    async unmark({ name }) {
      const locs = loadLocations();
      if (!locs[name]) return ok({ result: `No location '${name}'` });
      delete locs[name];
      saveLocations(locs);
      return ok({ result: `Deleted '${name}'` });
    },

    // ── Fire-and-Forget Smelting ─────────────────────

  };
}
