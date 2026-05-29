import { fail } from '../../../shared/action-contract.js';

/**
 * Sorts the discovery output into a strip-mine-friendly order.
 *
 * @param {import('./index.js').CollectContext} cctx
 * @param {{ found: import('vec3').Vec3[], isTrunkHarvest: boolean }} phaseInputs
 */
export function collectOrderingPhase(cctx, { found, isTrunkHarvest }) {
  const { b, blockName, count } = cctx;
  const botPos = b.entity.position;
  // Only skip the bot's own foot block (digging it would drop the bot
  // into the hole on the same tick — useless). Everything else stays
  // visible: the agent decides.
  const safe = found.filter(pos => {
    if (Math.abs(pos.x - Math.floor(botPos.x)) < 1 &&
        Math.abs(pos.z - Math.floor(botPos.z)) < 1 &&
        pos.y < Math.floor(botPos.y)) return false;
    return true;
  });
  // Strict water-adjacency: a block is "flooded" if ANY of the 6
  // adjacent cells (up, down, N/S/E/W) is water — source OR flowing.
  const isFlooded = (pos) => {
    const NEIGHBOURS = [
      [0, 1, 0], [0, -1, 0],
      [1, 0, 0], [-1, 0, 0],
      [0, 0, 1], [0, 0, -1],
    ];
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nb = b.blockAt(pos.offset(dx, dy, dz));
      if (nb && (nb.name === 'water' || nb.name === 'flowing_water')) return true;
    }
    return false;
  };

  if (safe.length === 0) {
    return {
      ok: false,
      response: fail(
        'NO_VISIBLE_BLOCKS',
        `No safely reachable ${blockName} found (all candidates were below the bot).`,
        {
          observed_state: {
            requested_block: blockName,
            requested_count: count,
            mined_count: 0,
            candidates_found: found.length,
            candidates_safely_reachable: 0,
          },
          retry_safe: false,
        },
      ),
    };
  }

  // Strip-plane lock: anchor the dig to the Y level of the deepest
  // initially-visible candidate...
  const stripPlaneFloorY = isTrunkHarvest
    ? -Infinity
    : Math.min(
        Math.min(...safe.map((p) => p.y)),
        Math.floor(b.entity.position.y),
      );

  let stripAxis = 'x';
  let perpAxis = 'z';
  // Anchored at the bot's START position. INTENTIONALLY frozen across
  // refreshPool calls — preserves the direction-discipline of strip mining:
  // once the bot picks a perp direction at start, the sort keeps pulling
  // candidates forward in that direction even after the bot has walked
  // past the original anchor. Using current bot position here would let
  // the perp sort flip direction every time the pathfinder bounces back
  // (e.g. bot routed back to z=+2 to reach a hidden candidate, then sort
  // reorients toward z=0 instead of continuing forward to z=+5+). The
  // strip-axis tertiary key (`botStrip`) DOES use current bot position —
  // that's right because within a row the bot can move freely.
  let initialPerpAnchor = Math.floor(b.entity.position[perpAxis]);
  let perpDirection = 1;
  const initialYAnchor = Math.floor(b.entity.position.y);
  // Row-ordering: blocks are grouped into rows keyed by (Y-band, perp rank).
  // Rows are visited Y-layer by Y-layer, and within a layer in perp order
  // (the bot's own row first, then forward in perpDirection, then the
  // backward rows). Within each row the strip axis is swept MONOTONICALLY,
  // and the sweep direction ALTERNATES row-to-row (boustrophedon). That way
  // the bot finishes one row adjacent to the start of the next instead of
  // returning toward the anchor every row.
  //
  // Why this matters: the previous comparator ordered each row by absolute
  // strip-distance from the bot (|strip - botStrip|), which interleaves the
  // two sides of the bot (1, -1, 2, -2, …) and makes the bot cross back over
  // itself on every block. On a small patch that's a couple of wasted steps;
  // over a wide `mc collect stone 64` scan it is constant back-and-forth
  // travel that exhausts the wallclock budget before many blocks are mined.
  const perpRankOf = (p) => {
    const raw = (p[perpAxis] - initialPerpAnchor) * perpDirection;
    // Forward rows (raw >= 0) rank ahead of backward rows; ties broken so the
    // bot's own row (raw === 0) always comes first.
    return raw >= 0 ? raw : 1000 - raw;
  };
  const stripSort = (list) => {
    const botStrip = Math.floor(b.entity.position[stripAxis]);
    // 1. Bucket candidates into rows.
    /** @type {Map<string, { yBand: number, perpRank: number, items: any[] }>} */
    const rowMap = new Map();
    const rowsInOrder = [];
    for (const p of list) {
      const yBand = Math.abs(p.y - initialYAnchor);
      const perpRank = perpRankOf(p);
      const key = `${yBand}|${perpRank}`;
      let row = rowMap.get(key);
      if (!row) {
        row = { yBand, perpRank, items: [] };
        rowMap.set(key, row);
        rowsInOrder.push(row);
      }
      row.items.push(p);
    }
    // 2. Visit rows Y-layer first, then perp rank.
    rowsInOrder.sort((r1, r2) =>
      r1.yBand !== r2.yBand ? r1.yBand - r2.yBand : r1.perpRank - r2.perpRank);
    // 3. Sweep each row monotonically; alternate direction row-to-row. The
    //    first row starts from whichever strip end is nearer the bot so the
    //    opening hop is short, then the serpentine chains the rest.
    const out = [];
    let ascending = true;
    rowsInOrder.forEach((row, idx) => {
      row.items.sort((a, c) => (a[stripAxis] - c[stripAxis]) || (a.y - c.y));
      if (idx === 0) {
        const lo = row.items[0][stripAxis];
        const hi = row.items[row.items.length - 1][stripAxis];
        // Start nearer end: if the bot is closer to the high end, sweep down.
        ascending = Math.abs(lo - botStrip) <= Math.abs(hi - botStrip);
      }
      const ordered = ascending ? row.items : row.items.slice().reverse();
      for (const p of ordered) out.push(p);
      ascending = !ascending;
    });
    return out;
  };

  const dryCandidates = safe.filter((pos) => !isFlooded(pos));
  if (dryCandidates.length === 0) {
    return {
      ok: false,
      response: fail(
        'TARGET_IN_WATER',
        `All ${safe.length} ${blockName} candidates are in/under water — bot would drown trying to mine them. Drain the pond first, approach from a dry side, or look for a drier deposit.`,
        {
          observed_state: {
            requested_block: blockName,
            requested_count: count,
            mined_count: 0,
            candidates_dry: 0,
            candidates_flooded: safe.length,
            suggested_dry_search_radius: 32,
          },
          retry_safe: false,
        },
      ),
    };
  }

  let sorted;
  if (isTrunkHarvest) {
    const clusters = [];
    const assigned = new Set();
    for (let i = 0; i < safe.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [safe[i]];
      assigned.add(i);
      for (let j = i + 1; j < safe.length; j++) {
        if (assigned.has(j)) continue;
        const dx = Math.abs(safe[j].x - safe[i].x);
        const dz = Math.abs(safe[j].z - safe[i].z);
        if (dx <= 1 && dz <= 1) {
          cluster.push(safe[j]);
          assigned.add(j);
        }
      }
      cluster.sort((a, c) => a.y - c.y);
      clusters.push(cluster);
    }
    clusters.sort((a, c) => {
      const aBase = a[0];
      const cBase = c[0];
      const aD = Math.abs(aBase.x - botPos.x) + Math.abs(aBase.z - botPos.z);
      const cD = Math.abs(cBase.x - botPos.x) + Math.abs(cBase.z - botPos.z);
      return aD - cD;
    });
    sorted = clusters.flat();
  } else {
    const dryCands = safe.filter((p) => !isFlooded(p));

    if (dryCands.length >= 2) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of dryCands) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      stripAxis = (maxX - minX) >= (maxZ - minZ) ? 'x' : 'z';
    }
    perpAxis = stripAxis === 'x' ? 'z' : 'x';
    initialPerpAnchor = Math.floor(b.entity.position[perpAxis]);
    let posCount = 0;
    let negCount = 0;
    for (const p of dryCands) {
      const d = p[perpAxis] - initialPerpAnchor;
      if (d > 0) posCount += 1;
      else if (d < 0) negCount += 1;
    }
    perpDirection = negCount > posCount ? -1 : 1;

    sorted = stripSort(dryCands);
  }

  return {
    ok: true,
    value: {
      sorted,
      stripPlaneFloorY,
      stripSort,
      isFlooded,
      isTrunkHarvest,
    },
  };
}
