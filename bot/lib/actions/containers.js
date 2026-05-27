// @size-exempt: container ops + shared openContainerStructured helper
import { Vec3 } from 'vec3';
import { ensureWithinReach } from './_helpers.js';
import { canSeeBlockFaces } from './_los.js';
import { fail } from '../shared/action-contract.js';

// Snapshots older than this surface with `stale: true` in chest_search and
// sort behind fresh hits. Override via MC_CHEST_STALE_HOURS env var.
const CHEST_SNAPSHOT_STALE_HOURS = Number(process.env.MC_CHEST_STALE_HOURS || 6);

/**
 * Remove every chestSnapshots entry whose `position` matches (ix,iy,iz).
 * Returns the list of removed keys (mark names or "x,y,z" strings).
 * Called when openContainerStructured confirms the chest is gone, so the
 * next chest_search doesn't keep returning the phantom location.
 */
export function evictChestSnapshotsAtPosition(snapshots, ix, iy, iz) {
  const removed = [];
  if (!snapshots) return removed;
  for (const [key, snap] of Object.entries(snapshots)) {
    const p = snap?.position;
    if (!p) continue;
    if (Math.floor(p.x) === ix && Math.floor(p.y) === iy && Math.floor(p.z) === iz) {
      removed.push(key);
      delete snapshots[key];
    }
  }
  return removed;
}

// ─ Phase-2 chest contract helpers (see docs/design/phase-2/action-contracts.md mc chest) ─

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
  const { ctx, ensureBot, goals, resolveContainerCoords, isContainerBlock, findNearbyContainer, flagMarkStale, clearMarkStale, hasLineOfSight, eyePosition, persistChestSnapshotsToDisk } = deps;

  /** Evict snapshots at (ix,iy,iz) and persist. Best-effort. */
  function evictAndPersist(ix, iy, iz) {
    const evicted = evictChestSnapshotsAtPosition(ctx?.goals?.chestSnapshots, ix, iy, iz);
    if (evicted.length && typeof persistChestSnapshotsToDisk === 'function') {
      try { persistChestSnapshotsToDisk(); } catch {}
    }
    return evicted;
  }
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
    const evicted = evictAndPersist(ix, iy, iz);
    return {
      ok: false,
      error: {
        code: 'NO_CONTAINER',
        message: `No chest/container found near ${ix},${iy},${iz}${markName ? ` (mark '${markName}' flagged stale)` : ''}${evicted.length ? `; evicted ${evicted.length} stale snapshot(s)` : ''}`,
        observed_state: {
          requested_coord: { x: ix, y: iy, z: iz },
          requested_mark: markName || null,
          block_at_target: block ? block.name : null,
          ...(evicted.length ? { evicted_snapshots: evicted } : {}),
        },
        next_action_hint: markName
          ? `mc unmark ${markName}; verify with mc scene or mc find_blocks chest 8`
          : (evicted.length
            ? `Snapshot evicted; chest was destroyed/moved. Re-discover with mc find_blocks chest 12 or skip this location.`
            : 'mc scene to confirm the block at these coords; chest may have been broken'),
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
  if (!canSeeBlockFaces(b, x, y, z, { hasLineOfSight, eyePosition })) {
    return fail(
      'NO_LINE_OF_SIGHT',
      `Cannot see chest at ${x},${y},${z} — a block is between you and the container.`,
      {
        observed_state: {
          container_position: { x, y, z },
          bot_position: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
          distance: Math.round(reach.distance * 10) / 10,
        },
        next_action_hint: `Open a door or navigate around the wall to gain line-of-sight. Try mc goto_near ${x} ${y} ${z} range=2.`,
        retry_safe: false,
      },
    );
  }

  let chest;
  try {
    chest = await b.openContainer(block);
  } catch (err) {
    // The block looked like a container to mineflayer's cached chunk view, but
    // the server never sent windowOpen. Common cause: stale chest snapshot at a
    // position where the chest was destroyed since mineflayer's chunk cache was
    // last reconciled. Evict any snapshot at this coord so chest_search stops
    // routing the bot back here; tradeoff is a re-scan on transient server lag.
    const evicted = evictAndPersist(x, y, z);
    return {
      ok: false,
      error: {
        code: 'INTERRUPTED',
        message: `Failed to open container at ${x},${y},${z}: ${/** @type {Error} */(err).message}${evicted.length ? `; evicted ${evicted.length} snapshot(s) at this position` : ''}`,
        observed_state: {
          chest_position: { x, y, z },
          mineflayer_error: /** @type {Error} */(err).message,
          ...(evicted.length ? { evicted_snapshots: evicted } : {}),
        },
        next_action_hint: evicted.length
          ? `Snapshot evicted. If the chest is genuinely there, re-discover with mc find_blocks chest 6 — otherwise abandon this location.`
          : undefined,
        retry_safe: !evicted.length,
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
 * Take two inventory snapshots ~1s apart and report any divergence.
 *
 * Why two snapshots? Mineflayer 4.37 + Paper 1.21.4 update local
 * inventory state OPTIMISTICALLY on window-clicks. The server can
 * reject some clicks (anti-cheat, partial-transfer, cursor-on-close
 * drop) and send SET_SLOT correction packets ~hundreds of ms later.
 * Observed 2026-05-27: flint withdraw oak_log×16 reported
 * `inventory_delta:{oak_log:16}` per the optimistic snapshot at
 * +50ms, but the actual server-confirmed state ~6s later showed only
 * 1 log. Sampling twice and reporting both states lets the caller
 * detect the divergence and treat the LATER number as authoritative.
 *
 * Returns `{ inventory, sync_warning?: {first, second, diverged_items} }`.
 */
async function verifiedInventorySnapshot(b, sleep, initialDelayMs = 500, verifyDelayMs = 1000) {
  await sleep(initialDelayMs);
  const first = inventorySnapshot(b);
  await sleep(verifyDelayMs);
  const second = inventorySnapshot(b);
  // Compute item-by-item divergence
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  /** @type {Record<string, {first:number, second:number, lost:number}>} */
  const diverged = {};
  for (const k of keys) {
    const a = first[k] || 0;
    const b2 = second[k] || 0;
    if (a !== b2) diverged[k] = { first: a, second: b2, lost: a - b2 };
  }
  const out = { inventory: second };
  if (Object.keys(diverged).length > 0) {
    out.sync_warning = {
      message:
        'Mineflayer/server inventory state diverged between optimistic and ' +
        'server-confirmed snapshots — items may have been dropped to the ' +
        'world on cursor-close or rejected by anti-cheat. Authoritative ' +
        'values are in `inventory_delta` (computed from the second snapshot).',
      diverged_items: diverged,
      first_snapshot_at_ms: initialDelayMs,
      second_snapshot_at_ms: initialDelayMs + verifyDelayMs,
    };
  }
  return out;
}

/**
 * Scan ``bot.entities`` for recently-dropped item entities within
 * ``maxDistance`` of the bot. Returns a compact list the caller can
 * include in the response so the agent knows where to walk to pick
 * up items that went to the world floor (cursor-on-close drop).
 *
 * Mineflayer's autopickup magnet has a ~1.5m radius; dropped items
 * outside that may need explicit `mc pickup` / `mc goto_near`.
 */
function nearbyDroppedItems(b, maxDistance = 4) {
  const out = [];
  try {
    const eyes = b.entity?.position;
    if (!eyes) return out;
    for (const e of Object.values(b.entities || {})) {
      if (!e || !e.position) continue;
      // mineflayer marks dropped items as `name === 'item'` or displayName='Item'.
      if (e.name !== 'item' && e.displayName !== 'Item') continue;
      const d = e.position.distanceTo(eyes);
      if (d > maxDistance) continue;
      // Try to extract the item id from metadata index 8 (1.16+) or 7.
      const meta = e.metadata?.[8] || e.metadata?.[7];
      const itemId = meta?.itemId;
      const count = meta?.itemCount ?? meta?.count ?? 1;
      out.push({
        position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
        distance: Math.round(d * 10) / 10,
        item_id: itemId ?? null,
        count,
      });
    }
  } catch {
    // best-effort; never throw from a response-shape helper
  }
  return out;
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
      // Two snapshots ~1s apart so we capture any server SET_SLOT
      // corrections that arrive after the optimistic mineflayer update;
      // see verifiedInventorySnapshot() for the rationale.
      const verified = await verifiedInventorySnapshot(b, sleep);
      const inventoryAfter = verified.inventory;
      const totalAfter = after.reduce((s, i) => s + i.count, 0);
      const inventory_delta = diffInventory(inventoryBefore, inventoryAfter);
      const container_delta = diffInventory(containerBefore, containerAfter);
      const dropped_nearby = verified.sync_warning ? nearbyDroppedItems(b) : [];

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
            ...(verified.sync_warning ? { sync_warning: verified.sync_warning } : {}),
            ...(dropped_nearby.length ? { dropped_nearby } : {}),
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
      // Two snapshots ~1s apart catches server SET_SLOT corrections that
      // arrive after mineflayer's optimistic local update. Critical for
      // withdraw because cursor-on-close drops + Paper anti-cheat both
      // produce divergence here; see verifiedInventorySnapshot().
      const verified = await verifiedInventorySnapshot(b, sleep);
      const inventoryAfter = verified.inventory;
      const totalAfter = after.reduce((s, i) => s + i.count, 0);
      const inventory_delta = diffInventory(inventoryBefore, inventoryAfter);
      const container_delta = diffInventory(containerBefore, containerAfter);
      const dropped_nearby = verified.sync_warning ? nearbyDroppedItems(b) : [];

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
            ...(verified.sync_warning ? { sync_warning: verified.sync_warning } : {}),
            ...(dropped_nearby.length ? { dropped_nearby } : {}),
          },
          result: `Withdraw: ${steps.join('; ') || '(nothing moved)'}${verified.sync_warning ? ' ⚠ inventory sync diverged — see sync_warning' : ''}`,
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
      const now = Date.now();
      const staleMs = CHEST_SNAPSHOT_STALE_HOURS * 3600 * 1000;

      function snapshotAge(snap) {
        const raw = snap?.at || snap?.last_seen;
        if (!raw) return { age_minutes: null, stale: true };
        const t = Date.parse(raw);
        if (!Number.isFinite(t)) return { age_minutes: null, stale: true };
        const ageMs = Math.max(0, now - t);
        return { age_minutes: Math.round(ageMs / 60000), stale: ageMs >= staleMs };
      }

      const matches = [];
      for (const [markName, snap] of Object.entries(ctx.goals.chestSnapshots || {})) {
        if (!snap?.items?.length) continue;
        const containerItems = snap.items.map((i) => ({ name: i.name, count: i.count, slot: -1 }));
        const ref = resolveItemRef(containerItems, requested);
        const age = snapshotAge(snap);
        const distance = snap.position ? Math.round(botPos.distanceTo(new Vec3(snap.position.x, snap.position.y, snap.position.z)) * 10) / 10 : null;
        if (!ref.ok && ref.code === 'AMBIGUOUS' && !exactPreferred) {
          // include all sub-name matches
          for (const cand of ref.candidates) {
            const subItems = containerItems.filter((i) => i.name === cand);
            const total = subItems.reduce((s, i) => s + i.count, 0);
            if (total > 0) matches.push({ mark: markName, position: snap.position, item: cand, count: total, last_seen: snap.last_seen, distance, ...age });
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
          distance,
          ...age,
        });
      }
      // Fresh hits before stale hits, then by distance. A stale entry can still
      // be the correct answer (worker may want to confirm) but should never beat
      // a fresh one — that's how the 10-hour phantom routed mason 67m.
      matches.sort((a, c) => {
        if (Boolean(a.stale) !== Boolean(c.stale)) return a.stale ? 1 : -1;
        return (a.distance ?? Infinity) - (c.distance ?? Infinity);
      });
      const top = matches.slice(0, maxResults);
      const staleCount = matches.filter((m) => m.stale).length;

      return {
        ok: true,
        data: {
          requested_item: requested,
          match_count: matches.length,
          match_count_stale: staleCount,
          stale_after_hours: CHEST_SNAPSHOT_STALE_HOURS,
          matches: top,
          chests_scanned: Object.keys(ctx.goals.chestSnapshots || {}).length,
        },
        result: matches.length > 0
          ? `Found ${requested} in ${matches.length} chest(s)${staleCount ? ` (${staleCount} stale)` : ''}; nearest @ ${top[0].mark} (${top[0].count}x, ${top[0].distance}m${top[0].stale ? `, STALE ${top[0].age_minutes}m old — verify` : ''})`
          : `${requested} not found in any of ${Object.keys(ctx.goals.chestSnapshots || {}).length} chest snapshots`,
      };
    },

    // ── Coordinate Memory ────────────────────────────

  };
}
