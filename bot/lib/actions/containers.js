import { Vec3 } from 'vec3';
import { raceWithTimeout, timeoutError, OperationTimeoutError, ACTION_CAPS_MS, ensureWithinReach } from './_helpers.js';

// ─ Phase-2 chest contract helpers (see docs/phase-2/action-contracts.md mc chest) ─

/**
 * Open a container at the body's resolved coords. Returns either
 *   { ok:true, chest, block, x, y, z }   on success, OR
 *   { ok:false, error: {...} }            for structured failures.
 *
 * Failure codes:
 *   NO_MARK         body.mark refers to a name that doesn't exist in marks file
 *   MISSING_COORDS  no x/y/z, no mark, and no @at provided
 *   NO_CONTAINER    block at coords is not a chest/barrel/shulker (or air)
 *   OUT_OF_RANGE    distance > 4.5 and pathfind threw
 *   INTERRUPTED     openContainer threw (server reject, anti-grief, mid-flight)
 */
async function openContainerStructured(deps, body) {
  const { ensureBot, goals, resolveContainerCoords, isContainerBlock, findNearbyContainer, flagMarkStale, clearMarkStale } = deps;
  const b = ensureBot();

  let coords;
  try {
    coords = resolveContainerCoords(body);
  } catch (err) {
    const msg = /** @type {Error} */ (err).message;
    if (/Unknown mark/i.test(msg)) {
      return {
        ok: false,
        error: {
          code: 'NO_MARK',
          message: msg,
          observed_state: { requested_mark: body.mark || body.at_mark || null },
          retry_safe: false,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'MISSING_COORDS',
        message: msg,
        observed_state: { body_keys: Object.keys(body || {}) },
        retry_safe: false,
      },
    };
  }
  const { ix, iy, iz } = coords;

  const block = findNearbyContainer(b, ix, iy, iz);
  if (!block || !isContainerBlock(block)) {
    const markName = body.mark || body.at_mark || '';
    if (markName) flagMarkStale(markName, 'no container found at location');
    return {
      ok: false,
      error: {
        code: 'NO_CONTAINER',
        message: `No chest/container found near ${ix},${iy},${iz}${markName ? ` (mark '${markName}' flagged stale)` : ''}`,
        observed_state: {
          requested_coord: { x: ix, y: iy, z: iz },
          requested_mark: markName || null,
          block_at_target: block ? block.name : null,
        },
        next_action_hint: markName
          ? `mc unmark ${markName}; verify with mc scene or mc find_blocks chest 8`
          : 'mc scene to confirm the block at these coords; chest may have been broken',
        retry_safe: false,
      },
    };
  }

  const x = block.position.x, y = block.position.y, z = block.position.z;
  // F55.3: uniform reach precheck with wallclock cap. Replaces uncapped
  // pathfinder.goto() that could hang 10-15s on hard paths during G21 v6
  // chest interactions.
  const reach = await ensureWithinReach({ bot: b, goals }, { x, y, z }, {
    range: 4.5,
    observed: { container_position: { x, y, z } },
  });
  if (!reach.ok) return reach;

  let chest;
  try {
    chest = await b.openContainer(block);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'INTERRUPTED',
        message: `Failed to open container at ${x},${y},${z}: ${/** @type {Error} */(err).message}`,
        observed_state: { chest_position: { x, y, z }, mineflayer_error: /** @type {Error} */(err).message },
        retry_safe: true,
      },
    };
  }
  if (body.mark) clearMarkStale(body.mark);
  return { ok: true, chest, block, x, y, z };
}

/**
 * Resolve a request for an item name against a list of items.
 * Returns:
 *   { ok:true, match: {name, total_count, slots} }     — exact name match found
 *   { ok:true, match: {name, total_count, slots} }     — exactly 1 substring match
 *   { ok:false, code: 'NOT_FOUND', candidates: [] }
 *   { ok:false, code: 'AMBIGUOUS', candidates: [...]} — multiple substring matches; force exact
 *
 * exact match always wins. Substring fallback is resolved only when there's
 * exactly one — otherwise return AMBIGUOUS so the worker can disambiguate.
 */
function resolveItemRef(items, requested) {
  const q = String(requested || '').toLowerCase();
  if (!q) return { ok: false, code: 'NOT_FOUND', candidates: [] };
  const exact = items.filter((i) => i.name === q);
  if (exact.length > 0) {
    const total = exact.reduce((s, i) => s + i.count, 0);
    return {
      ok: true,
      match: { name: exact[0].name, total_count: total, slots: exact.map((i) => ({ count: i.count, slot: i.slot })), match_kind: 'exact' },
    };
  }
  const subs = items.filter((i) => i.name.includes(q));
  // Group by name (multiple stacks of same item name are NOT ambiguous; different names ARE).
  const namesSet = new Set(subs.map((i) => i.name));
  if (namesSet.size === 0) {
    return { ok: false, code: 'NOT_FOUND', candidates: items.map((i) => i.name).slice(0, 30) };
  }
  if (namesSet.size > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS',
      candidates: [...namesSet],
      message: `"${requested}" matches multiple items: ${[...namesSet].join(', ')}. Use the exact name to disambiguate.`,
    };
  }
  // Exactly one distinct name in subs (e.g. multiple stacks of "oak_planks" via "planks" query)
  const name = [...namesSet][0];
  const total = subs.reduce((s, i) => s + i.count, 0);
  return {
    ok: true,
    match: { name, total_count: total, slots: subs.map((i) => ({ count: i.count, slot: i.slot })), match_kind: 'substring_unique' },
  };
}

function inventorySnapshot(b) {
  return b.inventory.items().reduce((acc, it) => {
    acc[it.name] = (acc[it.name] || 0) + it.count;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));
}

function containerSnapshot(items) {
  return items.reduce((acc, it) => {
    acc[it.name] = (acc[it.name] || 0) + it.count;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));
}

function diffInventory(before, after) {
  const delta = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d !== 0) delta[k] = d;
  }
  return delta;
}

export function createContainerActions(deps) {
  const { ctx, config, ensureBot, goals, fmt, posObj, sleep, log, loadLocations, saveLocations, flagMarkStale, clearMarkStale, resolveMarkPlaceFromBody, resolveContainerCoords, normalizeDepositWithdrawItems, buildMarksListApi, isContainerBlock, findNearbyContainer, snapshotChestAtPosition, rememberSocialEvent, saveReminders, getMyName } = deps;
  return {

    // ── Container Interaction ─────────────────────────

    async list_container(body) {
      const b = ensureBot();
      const opened = await openContainerStructured(deps, body);
      if (!opened.ok) return opened;
      const { chest, x, y, z, block } = opened;
      const containerKind = block.name;

      const items = chest.containerItems();
      snapshotChestAtPosition(x, y, z, items);
      const summary = items.length > 0 ? items.map(i => `${i.name}x${i.count}`).join(', ') : '(empty)';
      try { chest.close(); } catch {}
      const total = items.reduce((s, i) => s + i.count, 0);

      return {
        ok: true,
        data: {
          container_kind: containerKind,
          position: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) },
          total_items: total,
          slots: items.map((i) => ({ name: i.name, count: i.count, slot: i.slot })),
          item_counts: containerSnapshot(items),
        },
        // Legacy fields for older callers (goal engine, dashboard).
        result: `Container: ${summary}`,
        container: {
          position: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) },
          total,
          items: items.map((i) => ({ name: i.name, count: i.count })),
        },
      };
    },

    async deposit(body) {
      const b = ensureBot();
      const opened = await openContainerStructured(deps, body);
      if (!opened.ok) return opened;
      const { chest, x, y, z, block } = opened;
      const containerKind = block.name;

      let itemsNorm;
      try {
        itemsNorm = normalizeDepositWithdrawItems(body);
      } catch (err) {
        try { chest.close(); } catch {}
        return {
          ok: false,
          error: {
            code: 'MISSING_ITEMS',
            message: /** @type {Error} */(err).message,
            observed_state: { body_keys: Object.keys(body || {}) },
            retry_safe: false,
          },
        };
      }

      const inventoryBefore = inventorySnapshot(b);
      const containerBefore = containerSnapshot(chest.containerItems());

      const steps = [];
      const ambiguous = [];
      const not_found = [];
      // Capture container state INSIDE the try (chest open) and inventory
      // state AFTER chest.close (mineflayer syncs window→bot.inventory only
      // on close — sampling inventory while the window is open returns the
      // pre-open snapshot).
      let containerAfter = null;
      let after = null;
      try {
        for (const req of itemsNorm) {
          const ref = resolveItemRef(b.inventory.items(), req.item);
          if (!ref.ok) {
            if (ref.code === 'AMBIGUOUS') {
              ambiguous.push({ item: req.item, candidates: ref.candidates });
              steps.push(`skip ${req.item} (ambiguous: ${ref.candidates.join(', ')})`);
            } else {
              not_found.push(req.item);
              steps.push(`skip ${req.item} (missing in inventory)`);
            }
            continue;
          }
          const targetCount =
            req.count && req.count > 0 ? Math.min(req.count, ref.match.total_count) : ref.match.total_count;
          // mineflayer chest.deposit(itemType,...) handles multi-slot transfers.
          // We need the itemType id — pull from any one of the slots' actual items.
          const liveSlot = b.inventory.items().find((i) => i.name === ref.match.name);
          await chest.deposit(liveSlot.type, null, targetCount);
          steps.push(`deposited ${targetCount}x ${ref.match.name}`);
        }

        after = chest.containerItems();
        snapshotChestAtPosition(x, y, z, after);
        containerAfter = containerSnapshot(after);
      } finally {
        try { chest.close(); } catch {}
      }

      // Sample inventoryAfter AFTER chest.close() so the window→inventory sync has happened.
      // Brief await so mineflayer can flush the close packet.
      await sleep(50);
      const inventoryAfter = inventorySnapshot(b);
      const totalAfter = after.reduce((s, i) => s + i.count, 0);
      const inventory_delta = diffInventory(inventoryBefore, inventoryAfter);
      const container_delta = diffInventory(containerBefore, containerAfter);

      {
        // Soft failure if requests came in but NOTHING moved at all.
        const movedAnything = Object.values(inventory_delta).some((v) => v < 0);
        if (!movedAnything && (ambiguous.length > 0 || not_found.length > 0)) {
          return {
            ok: false,
            error: {
              code: ambiguous.length > 0 ? 'AMBIGUOUS_ITEM' : 'ITEM_NOT_FOUND',
              message: ambiguous.length > 0
                ? `Deposit blocked — ambiguous item references: ${ambiguous.map((a) => `${a.item}→[${a.candidates.join(', ')}]`).join('; ')}`
                : `Deposit blocked — items not in inventory: ${not_found.join(', ')}`,
              observed_state: {
                container_kind: containerKind,
                container_position: { x, y, z },
                ambiguous,
                not_found,
                inventory_before: inventoryBefore,
              },
              next_action_hint: ambiguous.length > 0
                ? 'Re-run with the exact item name (e.g. oak_planks instead of planks)'
                : 'mc inventory to check what you actually have',
              retry_safe: false,
            },
          };
        }

        return {
          ok: true,
          data: {
            container_kind: containerKind,
            container_position: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) },
            inventory_delta,
            container_delta,
            container_inventory_after: containerAfter,
            container_slots_after: after.map((i) => ({ name: i.name, count: i.count, slot: i.slot })),
            container_total_after: totalAfter,
            steps,
            ambiguous_skipped: ambiguous,
            not_found_skipped: not_found,
          },
          result: `Deposit: ${steps.join('; ') || '(nothing moved)'}`,
        };
      }
    },

    async withdraw(body) {
      const b = ensureBot();
      const opened = await openContainerStructured(deps, body);
      if (!opened.ok) return opened;
      const { chest, x, y, z, block } = opened;
      const containerKind = block.name;

      let itemsNorm;
      try {
        itemsNorm = normalizeDepositWithdrawItems(body);
      } catch (err) {
        try { chest.close(); } catch {}
        return {
          ok: false,
          error: {
            code: 'MISSING_ITEMS',
            message: /** @type {Error} */(err).message,
            observed_state: { body_keys: Object.keys(body || {}) },
            retry_safe: false,
          },
        };
      }

      const inventoryBefore = inventorySnapshot(b);
      const containerBefore = containerSnapshot(chest.containerItems());

      const steps = [];
      const ambiguous = [];
      const not_found = [];
      let containerAfter = null;
      let after = null;

      try {
        for (const req of itemsNorm) {
          const ref = resolveItemRef(chest.containerItems(), req.item);
          if (!ref.ok) {
            if (ref.code === 'AMBIGUOUS') {
              ambiguous.push({ item: req.item, candidates: ref.candidates });
              steps.push(`skip ${req.item} (ambiguous in chest: ${ref.candidates.join(', ')})`);
            } else {
              not_found.push(req.item);
              steps.push(`skip ${req.item} (not in chest)`);
            }
            continue;
          }
          const targetCount =
            req.count && req.count > 0 ? Math.min(req.count, ref.match.total_count) : ref.match.total_count;
          const liveItem = chest.containerItems().find((i) => i.name === ref.match.name);
          await chest.withdraw(liveItem.type, null, targetCount);
          steps.push(`withdrew ${targetCount}x ${ref.match.name}`);
        }

        after = chest.containerItems();
        snapshotChestAtPosition(x, y, z, after);
        containerAfter = containerSnapshot(after);
      } finally {
        try { chest.close(); } catch {}
      }

      // Sample inventoryAfter AFTER chest.close() — see deposit comment for why.
      await sleep(50);
      const inventoryAfter = inventorySnapshot(b);
      const totalAfter = after.reduce((s, i) => s + i.count, 0);
      const inventory_delta = diffInventory(inventoryBefore, inventoryAfter);
      const container_delta = diffInventory(containerBefore, containerAfter);

      {
        const movedAnything = Object.values(inventory_delta).some((v) => v > 0);
        if (!movedAnything && (ambiguous.length > 0 || not_found.length > 0)) {
          return {
            ok: false,
            error: {
              code: ambiguous.length > 0 ? 'AMBIGUOUS_ITEM' : 'ITEM_NOT_FOUND',
              message: ambiguous.length > 0
                ? `Withdraw blocked — ambiguous item references: ${ambiguous.map((a) => `${a.item}→[${a.candidates.join(', ')}]`).join('; ')}`
                : `Withdraw blocked — items not in chest: ${not_found.join(', ')}`,
              observed_state: {
                container_kind: containerKind,
                container_position: { x, y, z },
                ambiguous,
                not_found,
                container_before: containerBefore,
              },
              next_action_hint: ambiguous.length > 0
                ? 'Re-run with the exact item name (e.g. oak_planks instead of planks)'
                : 'mc list_container to see what is actually in this chest',
              retry_safe: false,
            },
          };
        }

        return {
          ok: true,
          data: {
            container_kind: containerKind,
            container_position: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) },
            inventory_delta,
            container_delta,
            container_inventory_after: containerAfter,
            container_slots_after: after.map((i) => ({ name: i.name, count: i.count, slot: i.slot })),
            container_total_after: totalAfter,
            steps,
            ambiguous_skipped: ambiguous,
            not_found_skipped: not_found,
          },
          result: `Withdraw: ${steps.join('; ') || '(nothing moved)'}`,
        };
      }
    },

    // ── chest_search: search known chest snapshots across marks ──
    // Phase-2 §8 extension. Solves the "find X across N chests without
    // opening each one" problem. Only searches snapshots already populated
    // by prior list/deposit/withdraw — there is no auto-walk-and-scan here
    // (worker decides that).
    async chest_search(body) {
      const b = ensureBot();
      const requested = String(body?.item || '').toLowerCase();
      if (!requested) {
        return {
          ok: false,
          error: {
            code: 'MISSING_ITEM',
            message: 'chest_search requires an item argument.',
            observed_state: { body_keys: Object.keys(body || {}) },
            retry_safe: false,
          },
        };
      }
      const maxResults = Math.max(1, Math.min(50, Number(body.max_results) || 10));
      const exactPreferred = body.exact !== false; // default true; pass {exact:false} to allow substring
      const botPos = b.entity.position;

      const matches = [];
      for (const [markName, snap] of Object.entries(ctx.chestSnapshots || {})) {
        if (!snap?.items?.length) continue;
        const containerItems = snap.items.map((i) => ({ name: i.name, count: i.count, slot: -1 }));
        const ref = resolveItemRef(containerItems, requested);
        if (!ref.ok && ref.code === 'AMBIGUOUS' && !exactPreferred) {
          // include all sub-name matches
          for (const cand of ref.candidates) {
            const subItems = containerItems.filter((i) => i.name === cand);
            const total = subItems.reduce((s, i) => s + i.count, 0);
            if (total > 0) matches.push({ mark: markName, position: snap.position, item: cand, count: total, last_seen: snap.last_seen, distance: snap.position ? Math.round(botPos.distanceTo(new Vec3(snap.position.x, snap.position.y, snap.position.z)) * 10) / 10 : null });
          }
          continue;
        }
        if (!ref.ok) continue;
        matches.push({
          mark: markName,
          position: snap.position,
          item: ref.match.name,
          count: ref.match.total_count,
          match_kind: ref.match.match_kind,
          last_seen: snap.last_seen,
          distance: snap.position ? Math.round(botPos.distanceTo(new Vec3(snap.position.x, snap.position.y, snap.position.z)) * 10) / 10 : null,
        });
      }
      matches.sort((a, c) => (a.distance ?? Infinity) - (c.distance ?? Infinity));
      const top = matches.slice(0, maxResults);

      return {
        ok: true,
        data: {
          requested_item: requested,
          match_count: matches.length,
          matches: top,
          chests_scanned: Object.keys(ctx.chestSnapshots || {}).length,
        },
        result: matches.length > 0
          ? `Found ${requested} in ${matches.length} chest(s); nearest @ ${top[0].mark} (${top[0].count}x, ${top[0].distance}m)`
          : `${requested} not found in any of ${Object.keys(ctx.chestSnapshots || {}).length} chest snapshots`,
      };
    },

    // ── Coordinate Memory ────────────────────────────

    async mark(body) {
      ensureBot();
      const name = body.name != null ? String(body.name).trim() : '';
      if (!name) throw new Error('Missing mark name');
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
      return {
        result: `Saved '${name}' at ${l.x}, ${l.y}, ${l.z}`,
        data: { mark: l },
      };
    },

    async mark_update(body) {
      ensureBot();
      const name = body.name != null ? String(body.name) : '';
      if (!name) throw new Error('Missing mark name');
      const locs = loadLocations();
      if (!locs[name]) return { result: `No location '${name}'` };

      const m = locs[name];
      const now = new Date().toISOString();
      if (body.note !== undefined) m.note = String(body.note);
      if (body.category !== undefined) m.category = body.category === null ? null : String(body.category);
      if (body.radius !== undefined) m.radius = Number(body.radius);
      if (body.mode !== undefined) m.mode = body.mode === null ? null : String(body.mode);
      if (body.stale !== undefined) m.stale = Boolean(body.stale);
      if (body.at || body.at_mark) {
        const alt = resolveMarkPlaceFromBody(body, locs);
        if (!alt) throw new Error('Invalid at/at_mark for relocation');
        m.x = alt.x;
        m.y = alt.y;
        m.z = alt.z;
      }
      m.updated = now;
      saveLocations(locs);
      return { result: `Updated '${name}'`, data: { mark: m } };
    },

    async marks() {
      const b = ensureBot();
      const list = buildMarksListApi();
      if (!list.length) return { result: 'No saved locations', data: { marks: [] } };
      const lines = list.map((e) =>
        `${e.stale ? '⚠ STALE ' : ''}${e.name}: ${e.x},${e.y},${e.z} (${e.distance_m}m)${
          e.note ? ` — ${e.note}` : ''
        }${e.category ? ` [${e.category}]` : ''}${
          e.stale_reason ? ` (${e.stale_reason})` : ''
        }`,
      );
      return { result: lines.join('\n'), data: { marks: list } };
    },

    async go_mark({ name }) {
      const locs = loadLocations();
      if (!locs[name]) return { result: `No location '${name}'` };
      const l = locs[name];
      const b = ensureBot();
      try {
        await raceWithTimeout(
          b.pathfinder.goto(new goals.GoalNear(l.x, l.y, l.z, 2)),
          ACTION_CAPS_MS.go_mark,
          'go_mark',
        );
      } catch (err) {
        if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
          try { b.pathfinder.setGoal(null); } catch { /* ignore */ }
          return timeoutError('go_mark', ACTION_CAPS_MS.go_mark, {
            mark: name,
            target: { x: l.x, y: l.y, z: l.z },
            current: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
          }, `Could not reach mark '${name}'. Path may be blocked.`);
        }
        throw err;
      }
      l.last_visited = new Date().toISOString();
      l.visit_count = (l.visit_count || 0) + 1;
      saveLocations(locs);
      return { result: `Arrived at '${name}' (${l.x},${l.y},${l.z})`, data: { mark: locs[name] } };
    },

    async unmark({ name }) {
      const locs = loadLocations();
      if (!locs[name]) return { result: `No location '${name}'` };
      delete locs[name];
      saveLocations(locs);
      return { result: `Deleted '${name}'` };
    },

    // ── Fire-and-Forget Smelting ─────────────────────

    async smelt_start({ input, fuel, count = 1 }) {
      const b = ensureBot();
      const isFurnace = block =>
        block.name === 'furnace' || block.name === 'lit_furnace' ||
        block.name === 'blast_furnace' || block.name === 'smoker';

      let furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
      if (!furnaceBlock) {
        furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 32 });
        if (furnaceBlock) {
          const fp = furnaceBlock.position;
          await b.pathfinder.goto(new goals.GoalNear(fp.x, fp.y, fp.z, 3));
          furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
        }
      }
      if (!furnaceBlock) throw new Error('No furnace within 32 blocks. Place one first (craft furnace from 8 cobblestone).');

      const inputItem = b.inventory.items().find(i => i.name === input);
      if (!inputItem) throw new Error(`No ${input} in inventory. Withdraw it from a chest first.`);

      const furnace = await b.openFurnace(furnaceBlock);

      // Clear finished output so it doesn't block new input
      const existingOutput = furnace.outputItem();
      if (existingOutput) await furnace.takeOutput();
      const existingInput = furnace.inputItem();
      if (existingInput && existingInput.name !== input) await furnace.takeInput();

      const qty = Math.min(count, inputItem.count, 64);
      await furnace.putInput(inputItem.type, null, qty);

      if (!furnace.fuelItem()) {
        const fuelNames = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick', 'lava_bucket', 'blaze_rod'];
        const fuelItem = fuel
          ? b.inventory.items().find(i => i.name === fuel)
          : b.inventory.items().find(i => fuelNames.includes(i.name));
        if (!fuelItem) { furnace.close(); throw new Error('No fuel available.'); }
        const fuelPer = fuelItem.name === 'coal_block' ? 80 : fuelItem.name.includes('coal') || fuelItem.name === 'charcoal' ? 8 : fuelItem.name === 'blaze_rod' ? 12 : fuelItem.name === 'lava_bucket' ? 100 : 1.5;
        const fuelNeeded = Math.ceil(qty / fuelPer);
        await furnace.putFuel(fuelItem.type, null, Math.min(fuelNeeded, fuelItem.count));
      }

      furnace.close();

      const fp = furnaceBlock.position;
      const eta = Date.now() + qty * 10000;
      ctx.activeFurnaces.push({
        x: fp.x, y: fp.y, z: fp.z,
        input, count: qty, startTime: Date.now(), estimatedDone: eta,
      });

      const minutes = Math.ceil(qty * 10 / 60);
      const collected = existingOutput ? ` Collected ${existingOutput.count}x ${existingOutput.name} from furnace.` : '';
      return { result: `Loaded ${qty} ${input} into furnace at ${fp.x},${fp.y},${fp.z}. ETA: ~${minutes} min.${collected} Go do something else!` };
    },

    async furnace_check({ x, y, z }) {
      const b = ensureBot();
      const furnaceBlock = b.blockAt(new Vec3(x, y, z));
      if (!furnaceBlock || (!furnaceBlock.name.includes('furnace') && furnaceBlock.name !== 'smoker' && furnaceBlock.name !== 'blast_furnace'))
        throw new Error(`No furnace at ${x},${y},${z}`);

      if (b.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
        await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      }
      const furnace = await b.openFurnace(furnaceBlock);
      const inputItem = furnace.inputItem();
      const fuelItem = furnace.fuelItem();
      const outputItem = furnace.outputItem();
      furnace.close();

      return {
        result: `Furnace at ${x},${y},${z}: ` +
          `Input: ${inputItem ? `${inputItem.name} x${inputItem.count}` : 'empty'} | ` +
          `Fuel: ${fuelItem ? `${fuelItem.name} x${fuelItem.count}` : 'empty'} | ` +
          `Output: ${outputItem ? `${outputItem.name} x${outputItem.count}` : 'empty'} | ` +
          `Status: ${outputItem ? 'output ready!' : inputItem ? 'smelting...' : 'idle'}`,
        ready: !!outputItem,
        output: outputItem ? { name: outputItem.name, count: outputItem.count } : null,
      };
    },

    async furnace_take({ x, y, z }) {
      const b = ensureBot();
      const furnaceBlock = b.blockAt(new Vec3(x, y, z));
      if (!furnaceBlock) throw new Error(`No block at ${x},${y},${z}`);

      if (b.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
        await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      }
      const furnace = await b.openFurnace(furnaceBlock);
      const output = furnace.outputItem();
      if (!output) { furnace.close(); return { result: 'Furnace has no output ready yet.' }; }
      await furnace.takeOutput();

      const remaining = furnace.inputItem();
      furnace.close();

      ctx.activeFurnaces = ctx.activeFurnaces.filter(f => !(f.x === x && f.y === y && f.z === z));

      return { result: `Collected ${output.name} x${output.count} from furnace.${remaining ? ` (${remaining.count} ${remaining.name} still being smelted)` : ''}` };
    },

    // ── Team System ──────────────────────────────────

    async team_chat({ message }) {
      const b = ensureBot();
      if (!ctx.teamConfig.team) throw new Error('Not assigned to a team. Use /action/set_team first.');

      for (const mate of ctx.teamConfig.teammates) {
        b.chat(`/msg ${mate} [${ctx.teamConfig.team.toUpperCase()}] ${message}`);
        await sleep(100);
      }
      ctx.teamConfig.teamChat.push({ time: Date.now(), from: config.mc.username, message });
      if (ctx.teamConfig.teamChat.length > 50) ctx.teamConfig.teamChat.shift();
      return { result: `[${ctx.teamConfig.team}] Sent to ${ctx.teamConfig.teammates.length} teammates: ${message}` };
    },

    async team_status() {
      const b = ensureBot();
      if (!ctx.teamConfig.team) return { result: 'Not on a team.' };

      const teammates = [];
      for (const name of ctx.teamConfig.teammates) {
        const entity = Object.values(b.entities).find(e => e.username === name);
        if (entity) {
          teammates.push({
            name,
            distance: fmt(entity.position.distanceTo(b.entity.position)),
            position: posObj(entity.position),
            health: entity.health ?? '?',
          });
        } else {
          teammates.push({ name, distance: '?', position: 'not visible', health: '?' });
        }
      }

      return {
        result: `Team ${ctx.teamConfig.team.toUpperCase()} | Role: ${ctx.teamConfig.role} | Rally: ${ctx.teamConfig.rallyPoint ? `${ctx.teamConfig.rallyPoint.x},${ctx.teamConfig.rallyPoint.y},${ctx.teamConfig.rallyPoint.z}` : 'none'}`,
        teammates,
      };
    },

    async rally({ x, y, z, message }) {
      const b = ensureBot();
      if (!ctx.teamConfig.team) throw new Error('Not on a team.');
      ctx.teamConfig.rallyPoint = { x: Math.round(x), y: Math.round(y), z: Math.round(z) };

      const msg = message || `Rally at ${ctx.teamConfig.rallyPoint.x},${ctx.teamConfig.rallyPoint.y},${ctx.teamConfig.rallyPoint.z}!`;
      for (const mate of ctx.teamConfig.teammates) {
        b.chat(`/msg ${mate} [RALLY] ${msg}`);
        await sleep(100);
      }
      return { result: `Rally point set and announced to team: ${msg}` };
    },

    async report({ message }) {
      const b = ensureBot();
      if (!ctx.teamConfig.team) throw new Error('Not on a team.');
      const pos = posObj();
      const fullMsg = `[INTEL] ${message} (at ${pos.x},${pos.y},${pos.z})`;
      for (const mate of ctx.teamConfig.teammates) {
        b.chat(`/msg ${mate} ${fullMsg}`);
        await sleep(100);
      }
      return { result: `Report sent to team: ${fullMsg}` };
    },

    async set_team({ team, role, teammates }) {
      ctx.teamConfig.team = team;
      ctx.teamConfig.role = role || 'warrior';
      ctx.teamConfig.teammates = teammates || [];
      return { result: `Assigned to team ${team} as ${role}. Teammates: ${teammates?.join(', ') || 'none'}` };
    },

    // ── Fair Play Toggle ─────────────────────────────

    async set_fair_play({ enabled }) {
      ctx.fairPlayMode = !!enabled;
      return { result: `Fair play mode: ${ctx.fairPlayMode ? 'ON (LOS, sound, reaction delay)' : 'OFF (god-mode perception)'}` };
    },

    // ── Reminders ────────────────────────────────────

    async remind({ note, interval_minutes, mark }) {
      const n = (note || '').trim();
      if (!n) throw new Error('remind needs a "note" string');
      let mins = parseFloat(interval_minutes);
      if (!Number.isFinite(mins) || mins < 1) mins = 20;
      const id = ctx.remindersNextId++;
      const entry = { id, note: n, interval_ms: mins * 60000, created: Date.now(), last_fired: 0 };
      if (mark) entry.mark = String(mark).trim();
      ctx.reminders.push(entry);
      saveReminders();
      return { result: `Reminder #${id} set: "${n}" every ${mins} min${entry.mark ? ` (mark: ${entry.mark})` : ''}`, id };
    },

    async list_reminders() {
      if (!ctx.reminders.length) return { result: 'No reminders set.', reminders: [] };
      const lines = ctx.reminders.map(r => {
        const minAgo = Math.round((Date.now() - (r.last_fired || r.created)) / 60000);
        return `#${r.id}: "${r.note}" every ${Math.round(r.interval_ms / 60000)} min (${minAgo} min since last)${r.mark ? ` [mark: ${r.mark}]` : ''}`;
      });
      return { result: lines.join('\n'), reminders: ctx.reminders };
    },

    async unremind({ id }) {
      const idx = ctx.reminders.findIndex(r => r.id === Number(id));
      if (idx === -1) throw new Error(`No reminder with id ${id}`);
      const removed = ctx.reminders.splice(idx, 1)[0];
      saveReminders();
      return { result: `Removed reminder #${removed.id}: "${removed.note}"` };
    },
  };
}
