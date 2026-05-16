// @size-exempt: container ops + shared openContainerStructured helper
import { Vec3 } from 'vec3';
import { ensureWithinReach } from './_helpers.js';

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
  const { ensureBot, goals, resolveContainerCoords, isContainerBlock, findNearbyContainer, flagMarkStale, clearMarkStale, hasLineOfSight, eyePosition } = deps;
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

  // F64: line-of-sight guard. Vanilla mineflayer allows openContainer
  // through walls as long as the chest coords are within reach radius;
  // bots routinely opened chests they couldn't actually see. Raycast
  // from bot eye to each face of the chest cell; refuse if every face
  // is occluded. Mirrors the F45.3 guard already in mc place.
  if (typeof hasLineOfSight === 'function' && typeof eyePosition === 'function') {
    const eye = eyePosition();
    if (eye) {
      const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
      const faces = [
        { x: cx, y: cy, z: cz - 0.48 },
        { x: cx, y: cy, z: cz + 0.48 },
        { x: cx - 0.48, y: cy, z: cz },
        { x: cx + 0.48, y: cy, z: cz },
        { x: cx, y: cy - 0.48, z: cz },
        { x: cx, y: cy + 0.48, z: cz },
        { x: cx, y: cy, z: cz },
      ];
      if (!faces.some((p) => hasLineOfSight(eye, p))) {
        return {
          ok: false,
          error: {
            code: 'NO_LINE_OF_SIGHT',
            message: `Cannot see chest at ${x},${y},${z} — a block is between you and the container.`,
            observed_state: {
              container_position: { x, y, z },
              bot_position: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
              distance: Math.round(reach.distance * 10) / 10,
            },
            next_action_hint: `Open a door or navigate around the wall to gain line-of-sight. Try mc goto_near ${x} ${y} ${z} range=2.`,
            retry_safe: false,
          },
        };
      }
    }
  }

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

/**
 * createContainerActions — extracted from former lib/actions/containers.js (Phase 5 split).
 */
export function createContainerActions(deps) {
  const { ctx, config, ensureBot, goals, fmt, posObj, sleep, log, loadLocations, saveLocations, flagMarkStale, clearMarkStale, resolveMarkPlaceFromBody, resolveContainerCoords, normalizeDepositWithdrawItems, buildMarksListApi, isContainerBlock, findNearbyContainer, snapshotChestAtPosition, rememberSocialEvent, saveReminders, getMyName } = deps;
  return {
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
      for (const [markName, snap] of Object.entries(ctx.goals.chestSnapshots || {})) {
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
          chests_scanned: Object.keys(ctx.goals.chestSnapshots || {}).length,
        },
        result: matches.length > 0
          ? `Found ${requested} in ${matches.length} chest(s); nearest @ ${top[0].mark} (${top[0].count}x, ${top[0].distance}m)`
          : `${requested} not found in any of ${Object.keys(ctx.goals.chestSnapshots || {}).length} chest snapshots`,
      };
    },

    // ── Coordinate Memory ────────────────────────────

  };
}
