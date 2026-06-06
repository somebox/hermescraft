/**
 * mc verify — predicate verb for card done-ness checks.
 *
 * Workers call this before kanban_complete to self-verify their card's
 * success_when clause; @overseer calls this against an epic's
 * metadata.acceptance items. Distinguishes "we evaluated, answer is no"
 * (ok:true, satisfied:false) from "we couldn't evaluate" (ok:false).
 *
 * Spec: docs/architecture/mc-verify-spec.md
 *
 * Session 2 minimum (this file):
 *   - inventory_contains <item> [min_count=1]
 *   - chest_contains <mark> <item> [min_count=1]  (requires bot adjacent to chest)
 *
 * Future: at_mark, region_empty, region_filled, chest_delta.
 */

import { Vec3 } from 'vec3';

import { ok, fail } from '../shared/action-contract.js';

export function createVerifyActions(services) {
  const { state: ctx, ensureBot } = services;

  return {
    /**
     * Single-entry dispatcher. Body shape:
     *   { kind: "inventory_contains", item: "cobblestone", min_count: 4 }
     *   { kind: "chest_contains", mark: "storage", item: "cobblestone", min_count: 4 }
     */
    async verify(body) {
      const kind = String(body?.kind || '').toLowerCase();
      if (!kind) {
        return fail('MISSING_ARG', 'mc verify requires a kind', { retry_safe: false });
      }

      switch (kind) {
        case 'inventory_contains':
          return verifyInventoryContains(ensureBot, body);
        case 'chest_contains':
          return verifyChestContains(ensureBot, services, body);
        default:
          return fail(
            'UNKNOWN_KIND',
            `mc verify: kind '${kind}' not recognized. Known: inventory_contains, chest_contains. See docs/architecture/mc-verify-spec.md`,
            { retry_safe: false }
          );
      }
    },
  };
}

function verifyInventoryContains(ensureBot, body) {
  const item = String(body?.item || '').trim();
  if (!item) {
    return fail('MISSING_ARG', "verify inventory_contains requires 'item'", { retry_safe: false });
  }
  const minCount = Math.max(1, Number(body?.min_count) || 1);

  const b = ensureBot();
  const items = b.inventory.items();
  let observedCount = 0;
  for (const it of items) {
    if (it && it.name === item) {
      observedCount += it.count || 0;
    }
  }

  return ok({
    data: {
      kind: 'inventory_contains',
      satisfied: observedCount >= minCount,
      observed: { item, count: observedCount },
      expected: { item, min_count: minCount },
    },
  });
}

async function verifyChestContains(ensureBot, services, body) {
  const item = String(body?.item || '').trim();
  const mark = String(body?.mark || '').trim();
  if (!item) {
    return fail('MISSING_ARG', "verify chest_contains requires 'item'", { retry_safe: false });
  }
  if (!mark) {
    return fail('MISSING_ARG', "verify chest_contains requires 'mark'", { retry_safe: false });
  }
  const minCount = Math.max(1, Number(body?.min_count) || 1);

  // Resolve mark → coords via services.locations
  const locations = services.locations;
  if (!locations || typeof locations.load !== 'function') {
    return fail(
      'READ_FAILED',
      'locations service unavailable; cannot resolve mark',
      { retry_safe: true }
    );
  }
  const all = locations.load() || {};
  const m = all[mark];
  if (!m || typeof m.x !== 'number') {
    return fail(
      'MARK_NOT_FOUND',
      `mark '${mark}' not found via /marks`,
      {
        observed_state: { requested_mark: mark },
        retry_safe: false,
      }
    );
  }

  // Worker must be adjacent to the chest — no auto-walk in verify.
  const b = ensureBot();
  const botPos = b.entity.position;
  const dist = Math.sqrt(
    (botPos.x - m.x) ** 2 + (botPos.y - m.y) ** 2 + (botPos.z - m.z) ** 2
  );
  const MAX_OPEN_DIST = 4;
  if (dist > MAX_OPEN_DIST) {
    return fail(
      'NOT_ADJACENT',
      `bot is ${dist.toFixed(1)} blocks from :${mark}: (max ${MAX_OPEN_DIST}); navigate closer before verify chest_contains`,
      {
        observed_state: { bot_pos: { x: botPos.x, y: botPos.y, z: botPos.z }, mark_pos: { x: m.x, y: m.y, z: m.z }, dist },
        retry_safe: false,
        next_action_hint: `mc move @${mark}`,
      }
    );
  }

  // Find block at mark coords. findNearbyContainer is the same path
  // mc deposit/withdraw/list use — it handles Vec3 + tolerates the
  // chunk-cache vs server-truth lag the chest-snapshot system covers.
  const findNearbyContainer = services.findNearbyContainer;
  let blockAt;
  if (typeof findNearbyContainer === 'function') {
    blockAt = findNearbyContainer(b, m.x, m.y, m.z);
  } else {
    blockAt = b.blockAt(new Vec3(m.x, m.y, m.z));
  }
  if (!blockAt) {
    return fail('READ_FAILED', `unable to read block at :${mark}: (chunk unloaded?)`, { retry_safe: true });
  }
  const name = blockAt.name || '';
  if (!/chest|barrel|shulker_box/.test(name)) {
    return fail(
      'BLOCK_NOT_CHEST',
      `block at :${mark}: is '${name}', not a chest/barrel`,
      {
        observed_state: { mark_pos: { x: m.x, y: m.y, z: m.z }, block_name: name },
        retry_safe: false,
      }
    );
  }

  // Open container, read items, close. ensureWithinReach handles the
  // pathfind+face step that openContainer assumes (mineflayer's openContainer
  // calls block.position.floored() internally — if we got here from a stale
  // chunk view, the block object's .position can be a plain {x,y,z} object,
  // which is the source of the pos.floored TypeError in earlier attempts).
  let container;
  try {
    container = await b.openContainer(blockAt);
  } catch (err) {
    return fail('READ_FAILED', `could not open container at :${mark}: ${err && err.message || err}`, { retry_safe: true });
  }

  let observedCount = 0;
  try {
    const items = (container.containerItems && container.containerItems()) || [];
    for (const it of items) {
      if (it && it.name === item) {
        observedCount += it.count || 0;
      }
    }
  } finally {
    try { await container.close(); } catch {}
  }

  return ok({
    data: {
      kind: 'chest_contains',
      satisfied: observedCount >= minCount,
      observed: {
        mark,
        coords: { x: m.x, y: m.y, z: m.z },
        item,
        count: observedCount,
      },
      expected: { item, min_count: minCount },
    },
  });
}
