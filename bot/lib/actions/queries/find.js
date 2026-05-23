import { Vec3 } from 'vec3';
import { annotateReachability } from '../_nav-helpers.js';

export function createFindQueries({ ctx, ensureBot }) {
  return {
  /**
   * F53.4: mc find <resource> — unified resource finder. Aggregates sources
   * the bot already has access to, so it doesn't run off to mine a thing
   * that's already in its inventory or in a known chest.
   *
   * Sources scanned (in order of "cheapness"):
   *   1. inventory   — items in the bot's own inventory (free, count only)
   *   2. chest       — chest snapshots populated by prior list/deposit/
   *                    withdraw calls (cheap; needs prior knowledge)
   *   3. block       — visible blocks of that name within scan_range
   *                    (medium; requires walking + digging)
   *
   * Returns a flat ranked list: [{source, name, count, pos, distance, ...}].
   * Distance is from the bot's current position (0 for inventory).
   *
   * The brain calls this BEFORE deciding to mine. If `inventory` count >=
   * needed, no trip required. If `chest` has it, mc goto + mc withdraw.
   * If only `block`, mc collect.
   */
  async find({ resource, scan_range = 32, max_results = 12 }) {
    const b = ensureBot();
    const target = String(resource || '').toLowerCase();
    if (!target) {
      return {
        ok: false,
        error: {
          code: 'MISSING_RESOURCE',
          message: 'mc find requires a resource name (e.g. mc find cobblestone).',
          retry_safe: false,
        },
      };
    }
    const scanR = Math.max(4, Math.min(64, Number(scan_range) || 32));
    const maxN = Math.max(1, Math.min(50, Number(max_results) || 12));
    const botPos = b.entity.position;
    const sources = [];

    // 1. Own inventory.
    try {
      const inv = b.inventory.items();
      const matching = inv.filter(it => it.name === target);
      const total = matching.reduce((s, it) => s + it.count, 0);
      if (total > 0) {
        sources.push({
          source: 'inventory',
          name: target,
          count: total,
          pos: null,
          distance: 0,
        });
      }
    } catch { /* ignore */ }

    // 2. Chest snapshots (per chest mark).
    try {
      for (const [markName, snap] of Object.entries(ctx.goals.chestSnapshots || {})) {
        if (!snap?.items?.length) continue;
        const matching = snap.items.filter(it => it.name === target);
        const total = matching.reduce((s, it) => s + it.count, 0);
        if (total > 0) {
          const dist = snap.position
            ? Math.round(botPos.distanceTo(new Vec3(snap.position.x, snap.position.y, snap.position.z)) * 10) / 10
            : null;
          sources.push({
            source: 'chest',
            mark: markName,
            name: target,
            count: total,
            pos: snap.position || null,
            distance: dist,
            last_seen: snap.last_seen || null,
          });
        }
      }
    } catch { /* ignore */ }

    // 3. Visible blocks of that name within scan_range. Use mc-data to
    //    resolve the block ID; if `target` is an item name (like cobblestone)
    //    it usually matches a block name too. For items only obtainable
    //    by smelting/crafting (e.g. iron_ingot), block search finds nothing
    //    and the brain learns to smelt/craft instead.
    try {
      const blockId = ctx.world.mcData?.blocksByName?.[target]?.id;
      if (blockId != null) {
        const positions = b.findBlocks({
          matching: blockId,
          maxDistance: scanR,
          count: maxN,
        });
        // #92: build raw locations, then annotate with reachability +
        // approach_cell so the brain doesn't pick a buried / floating
        // candidate it can't actually walk to. annotateReachability
        // sorts reachable-first.
        const rawLocs = positions.map((p) => ({
          x: p.x, y: p.y, z: p.z,
          distance: Math.round(botPos.distanceTo(p) * 10) / 10,
        }));
        const annotated = annotateReachability(b, rawLocs, 512);
        for (const loc of annotated) {
          sources.push({
            source: 'block',
            name: target,
            count: 1,
            pos: { x: loc.x, y: loc.y, z: loc.z },
            distance: loc.distance,
            approach_cell: loc.approach_cell || null,
            reachable: loc.reachable,
            unreachable_reason: loc.unreachable_reason || null,
          });
        }
      }
    } catch { /* ignore */ }

    // Rank: inventory (distance 0) first, then chests by distance, then
    // blocks by reachability (reachable-first), then by distance. The
    // reachability tiebreak matters: prior to the fix, an unreachable
    // closer candidate would sort ahead of a reachable farther one, so
    // agents reading sources[0] got pointed at a coord their pathfinder
    // would always refuse (round-2 in-game QA, the "blocks at 368,69,-622
    // reachable: false bfs_exhausted" loop).
    const order = { inventory: 0, chest: 1, block: 2 };
    const reachRank = (s) => (s.source === 'block' ? (s.reachable === true ? 0 : 1) : 0);
    sources.sort((a, c) => {
      const oa = order[a.source] ?? 9;
      const oc = order[c.source] ?? 9;
      if (oa !== oc) return oa - oc;
      const ra = reachRank(a);
      const rc = reachRank(c);
      if (ra !== rc) return ra - rc;
      return (a.distance ?? Infinity) - (c.distance ?? Infinity);
    });
    const top = sources.slice(0, maxN);

    const totalAvailable = sources.reduce((s, e) => s + (e.count || 0), 0);
    let resultMsg;
    if (top.length === 0) {
      resultMsg = `No ${target} found in inventory, ${Object.keys(ctx.goals.chestSnapshots || {}).length} chest snapshots, or visible within ${scanR}m. Try mining/crafting/smelting.`;
    } else {
      const parts = [];
      const invSrc = top.find(e => e.source === 'inventory');
      if (invSrc) parts.push(`inventory:${invSrc.count}`);
      const chests = top.filter(e => e.source === 'chest');
      if (chests.length > 0) parts.push(`chests:${chests.map(c => `${c.count}@${c.mark}(${c.distance}m)`).join(',')}`);
      const blocks = top.filter(e => e.source === 'block');
      if (blocks.length > 0) {
        // The block list is already reachable-first via annotateReachability,
        // so blocks[0] is the right candidate. But "nearest by distance" can
        // still be unreachable; surface BOTH the block's coord AND the
        // approach_cell the bot would actually walk to. Round-3 in-game QA
        // showed agents bg_goto'ing to the raw block coord (which is solid)
        // and failing NAV_TARGET_UNSTANDABLE every time.
        const firstReachable = blocks.find(b => b.reachable === true) || blocks[0];
        const nearestUnreachable = firstReachable.reachable === true
          ? blocks.find(b => b.reachable === false)
          : null;
        const ac = firstReachable.approach_cell;
        const acText = ac && firstReachable.reachable === true
          ? `, walk to ${ac.x},${ac.y},${ac.z}`
          : '';
        const reachText = firstReachable.reachable === false
          ? ` — unreachable (${firstReachable.unreachable_reason || 'unknown'})`
          : '';
        const np = firstReachable.pos;
        parts.push(`blocks:${blocks.length} (nearest @ ${np.x},${np.y},${np.z}${acText} ${firstReachable.distance}m${reachText})`);
        if (nearestUnreachable) {
          parts.push(`(${blocks.filter(b => b.reachable === false).length} unreachable: ${nearestUnreachable.unreachable_reason || 'unknown'})`);
        }
      }
      resultMsg = `Found ${target} — total available ${totalAvailable}. ${parts.join('; ')}.`;
    }

    return {
      ok: true,
      data: {
        resource: target,
        total_available: totalAvailable,
        sources: top,
        scan_range: scanR,
      },
      result: resultMsg,
    };
  },
  };
}
