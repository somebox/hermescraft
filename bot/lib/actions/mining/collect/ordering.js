/**
 * @param {object} opts
 * @param {import('mineflayer').Bot} opts.b
 * @param {string} opts.blockName
 * @param {number} opts.count
 * @param {Vec3[]} opts.found — original discovery list (for errors / hints)
 */
export function collectOrderingPhase({
  b,
  blockName,
  count,
  found,
  isTrunkHarvest,
}) {
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
      response: {
        ok: false,
        error: {
          code: 'NO_VISIBLE_BLOCKS',
          message: `No safely reachable ${blockName} found (all candidates were below the bot).`,
          observed_state: {
            requested_block: blockName,
            requested_count: count,
            mined_count: 0,
            candidates_found: found.length,
            candidates_safely_reachable: 0,
          },
          retry_safe: false,
        },
      },
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
  let initialPerpAnchor = Math.floor(b.entity.position[perpAxis]);
  let perpDirection = 1;
  const initialYAnchor = Math.floor(b.entity.position.y);
  const stripSort = (list) => {
    const botStrip = Math.floor(b.entity.position[stripAxis]);
    return list.slice().sort((a, c) => {
      const ay = Math.abs(a.y - initialYAnchor);
      const cy = Math.abs(c.y - initialYAnchor);
      if (ay !== cy) return ay - cy;
      const apRaw = (a[perpAxis] - initialPerpAnchor) * perpDirection;
      const cpRaw = (c[perpAxis] - initialPerpAnchor) * perpDirection;
      const ap = apRaw >= 0 ? apRaw : 1000 - apRaw;
      const cp = cpRaw >= 0 ? cpRaw : 1000 - cpRaw;
      if (ap !== cp) return ap - cp;
      const as = Math.abs(a[stripAxis] - botStrip);
      const cs = Math.abs(c[stripAxis] - botStrip);
      if (as !== cs) return as - cs;
      return a.y - c.y;
    });
  };

  const dryCandidates = safe.filter((pos) => !isFlooded(pos));
  if (dryCandidates.length === 0) {
    return {
      ok: false,
      response: {
        ok: false,
        error: {
          code: 'TARGET_IN_WATER',
          message: `All ${safe.length} ${blockName} candidates are in/under water — bot would drown trying to mine them. Drain the pond first, approach from a dry side, or look for a drier deposit.`,
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
      },
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
