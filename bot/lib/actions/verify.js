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
 * Landed verbs:
 *   - inventory_contains <item> [min_count=1]
 *   - chest_contains <mark> <item> [min_count=1]    (bot must be adjacent)
 *   - at_mark <mark> [--near N | --block <id>] [from=X,Y,Z]
 *       Proximity defaults to the bot's position; `from` measures from an
 *       arbitrary point instead (fully remote — bot doesn't move). The
 *       --block mode is also remote: it reads the block at the mark's
 *       coords from wherever the bot stands (chunk must be loaded).
 *   - region_blocks <c1> <c2> <block> [min_count]   (count blocks in a box)
 *
 * Future: chest_delta, multi-kind region (all-of / any-of), entity_at.
 */

import { Vec3 } from 'vec3';

import { ok, fail } from '../shared/action-contract.js';

// Hard cap on region_blocks scan volume — prevents runaway scans on
// accidental world-sized boxes. 4096 = a 16×16×16 box, plenty for any
// realistic acceptance check.
const REGION_BLOCKS_MAX_VOLUME = 4096;

export function createVerifyActions(services) {
  const { state: ctx, ensureBot } = services;

  return {
    /**
     * Single-entry dispatcher. Body shape:
     *   { kind: "inventory_contains", item: "cobblestone", min_count: 4 }
     *   { kind: "chest_contains", mark: "storage", item: "cobblestone", min_count: 4 }
     *   { kind: "at_mark", mark: "field_south", near: 2 }
     *   { kind: "at_mark", mark: "water_source", block: "water" }
     *   { kind: "region_blocks",
     *     corner1: {x,y,z}, corner2: {x,y,z}, block: "farmland", min_count: 81 }
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
        case 'at_mark':
          return verifyAtMark(ensureBot, services, body);
        case 'region_blocks':
          return verifyRegionBlocks(ensureBot, body);
        default:
          return fail(
            'UNKNOWN_KIND',
            `mc verify: kind '${kind}' not recognized. Known: inventory_contains, chest_contains, at_mark, region_blocks. See docs/architecture/mc-verify-spec.md`,
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

// ── at_mark ─────────────────────────────────────────────────────────────
//
// Two modes:
//   1. Bot proximity: { kind: 'at_mark', mark, near: N } — satisfied if
//      bot is within N blocks of the mark. Default N=2.
//   2. Block-at-mark: { kind: 'at_mark', mark, block: <id> } — satisfied
//      if the block at the mark's coords matches the named id. For
//      water-source / sign / chest placement checks.
//
// The two modes are mutually exclusive — passing `block` switches modes.
function verifyAtMark(ensureBot, services, body) {
  const mark = String(body?.mark || '').trim();
  if (!mark) {
    return fail('MISSING_ARG', "verify at_mark requires 'mark'", { retry_safe: false });
  }

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

  const expectedBlock = body?.block ? String(body.block).trim() : null;
  const b = ensureBot();

  if (expectedBlock) {
    // Block-at-mark mode.
    const blockAt = b.blockAt(new Vec3(m.x, m.y, m.z));
    if (!blockAt) {
      return fail(
        'READ_FAILED',
        `unable to read block at :${mark}: (chunk unloaded?)`,
        { retry_safe: true }
      );
    }
    const observedName = blockAt.name || '';
    return ok({
      data: {
        kind: 'at_mark',
        mode: 'block',
        satisfied: observedName === expectedBlock,
        observed: {
          mark,
          coords: { x: m.x, y: m.y, z: m.z },
          block: observedName,
        },
        expected: { mark, block: expectedBlock },
      },
    });
  }

  // Proximity mode (default). Measures from the bot's position, or — with
  // `from` — from an arbitrary point, so a remote orchestrator can check
  // "is this mark within N of X,Y,Z" without the bot walking there
  // (proc-nav-1781014144: verification verbs that require bot presence
  // forced wasteful round-trips).
  const nearRaw = Number(body?.near);
  const near = Number.isFinite(nearRaw) ? Math.max(0, nearRaw) : 2;
  let origin = null;
  let mode = 'bot';
  if (body?.from != null) {
    const f = parseFromPoint(body.from);
    if (!f) {
      return fail(
        'INVALID_ARG',
        "verify at_mark: 'from' must be X,Y,Z (e.g. from=100,64,-200)",
        { observed_state: { from: body.from }, retry_safe: false }
      );
    }
    origin = f;
    mode = 'from';
  } else {
    const botPos = b.entity.position;
    origin = { x: botPos.x, y: botPos.y, z: botPos.z };
  }
  const dist = Math.sqrt(
    (origin.x - m.x) ** 2 + (origin.y - m.y) ** 2 + (origin.z - m.z) ** 2
  );
  return ok({
    data: {
      kind: 'at_mark',
      mode,
      satisfied: dist <= near,
      observed: {
        mark,
        ...(mode === 'from' ? { from: origin } : { bot_pos: origin }),
        coords: { x: m.x, y: m.y, z: m.z },
        dist,
      },
      expected: { mark, max_dist: near },
    },
  });
}

// Accepts {x,y,z} or "x,y,z"; returns {x,y,z} numbers or null.
function parseFromPoint(raw) {
  let c = raw;
  if (typeof c === 'string') {
    const parts = c.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 3) return null;
    c = { x: parts[0], y: parts[1], z: parts[2] };
  }
  if (typeof c !== 'object' || c === null) return null;
  const x = Number(c.x); const y = Number(c.y); const z = Number(c.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

// ── region_blocks ───────────────────────────────────────────────────────
//
// Count blocks of a specified kind inside an axis-aligned box. Used to
// verify tilled grids, planted crop coverage, wall fills, etc.
//
// Body: { kind: 'region_blocks', corner1: {x,y,z}, corner2: {x,y,z},
//         block: 'farmland', min_count: 81 }
//
// Returns satisfied iff observed >= min_count. Reports `scanned`
// (cells that returned a block) and `unreadable` (cells where blockAt
// returned null — usually unloaded chunks). If every cell is unreadable
// we return READ_FAILED rather than satisfied=false; otherwise we
// trust the partial scan and report the observed count.
function verifyRegionBlocks(ensureBot, body) {
  const c1 = body?.corner1;
  const c2 = body?.corner2;
  if (!c1 || !c2 || typeof c1.x !== 'number' || typeof c2.x !== 'number') {
    return fail(
      'MISSING_ARG',
      "verify region_blocks requires 'corner1' and 'corner2' coordinates",
      { retry_safe: false }
    );
  }
  const block = String(body?.block || '').trim();
  if (!block) {
    return fail(
      'MISSING_ARG',
      "verify region_blocks requires 'block'",
      { retry_safe: false }
    );
  }
  const minRaw = Number(body?.min_count);
  const minCount = Number.isFinite(minRaw) ? Math.max(0, minRaw) : 1;

  const xMin = Math.min(c1.x, c2.x), xMax = Math.max(c1.x, c2.x);
  const yMin = Math.min(c1.y, c2.y), yMax = Math.max(c1.y, c2.y);
  const zMin = Math.min(c1.z, c2.z), zMax = Math.max(c1.z, c2.z);

  const volume =
    (xMax - xMin + 1) * (yMax - yMin + 1) * (zMax - zMin + 1);
  if (volume > REGION_BLOCKS_MAX_VOLUME) {
    return fail(
      'VOLUME_TOO_LARGE',
      `region volume ${volume} exceeds max ${REGION_BLOCKS_MAX_VOLUME}; narrow the region`,
      {
        observed_state: { volume, max_volume: REGION_BLOCKS_MAX_VOLUME },
        retry_safe: false,
      }
    );
  }

  const b = ensureBot();
  let observedCount = 0;
  let scanned = 0;
  let unreadable = 0;
  for (let y = yMin; y <= yMax; y++) {
    for (let z = zMin; z <= zMax; z++) {
      for (let x = xMin; x <= xMax; x++) {
        const blk = b.blockAt(new Vec3(x, y, z));
        if (!blk) { unreadable++; continue; }
        scanned++;
        if (blk.name === block) observedCount++;
      }
    }
  }

  if (scanned === 0 && unreadable > 0) {
    return fail(
      'READ_FAILED',
      `region unreadable (${unreadable} cells; chunk unloaded?)`,
      {
        observed_state: { unreadable, scanned },
        retry_safe: true,
      }
    );
  }

  return ok({
    data: {
      kind: 'region_blocks',
      satisfied: observedCount >= minCount,
      observed: {
        block,
        count: observedCount,
        scanned,
        unreadable,
        region: {
          min: { x: xMin, y: yMin, z: zMin },
          max: { x: xMax, y: yMax, z: zMax },
        },
      },
      expected: { block, min_count: minCount },
    },
  });
}
