/**
 * Typed resolution for natural queries (axe, wood) vs exact Minecraft IDs (oak_log).
 * Uses mcData when present for exact IDs; inventory-aware for equip-style policies.
 */

/** @typedef {'best_available' | 'cheapest_craftable' | 'nearest_visible' | 'most_available' | 'exact_required'} ResolvePolicy */

export const RESOURCE_GROUPS = Object.freeze({
  logs: Object.freeze([
    'oak_log',
    'spruce_log',
    'birch_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'cherry_log',
    'mangrove_log',
    'pale_oak_log',
    'crimson_stem',
    'warped_stem',
  ]),
  planks: Object.freeze([
    'oak_planks',
    'spruce_planks',
    'birch_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'cherry_planks',
    'mangrove_planks',
    'pale_oak_planks',
    'crimson_planks',
    'warped_planks',
  ]),
  axes: Object.freeze([
    'netherite_axe',
    'diamond_axe',
    'iron_axe',
    'stone_axe',
    'golden_axe',
    'wooden_axe',
  ]),
  pickaxes: Object.freeze([
    'netherite_pickaxe',
    'diamond_pickaxe',
    'iron_pickaxe',
    'stone_pickaxe',
    'golden_pickaxe',
    'wooden_pickaxe',
  ]),
  stone: Object.freeze(['stone', 'cobblestone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite']),
});

const QUERY_ALIASES = Object.freeze({
  axe: { kind: 'tool_class', group: 'axes' },
  axes: { kind: 'tool_class', group: 'axes' },
  pick: { kind: 'tool_class', group: 'pickaxes' },
  pickaxe: { kind: 'tool_class', group: 'pickaxes' },
  wood: { kind: 'resource_group', group: 'logs' },
  log: { kind: 'resource_group', group: 'logs' },
  logs: { kind: 'resource_group', group: 'logs' },
  timber: { kind: 'resource_group', group: 'logs' },
  planks: { kind: 'resource_group', group: 'planks' },
  stone: { kind: 'resource_group', group: 'stone' },
});

const AXE_SCORE = Object.fromEntries(RESOURCE_GROUPS.axes.map((n, i) => [n, 100 - i]));
const PICK_SCORE = Object.fromEntries(RESOURCE_GROUPS.pickaxes.map((n, i) => [n, 100 - i]));

/**
 * @param {string} q
 */
function norm(q) {
  return String(q || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/**
 * @param {import('minecraft-data').IndexedData | null | undefined} mcData
 * @param {string} name
 */
export function isKnownBlock(mcData, name) {
  return !!(mcData?.blocksByName && mcData.blocksByName[name]);
}

/**
 * @param {import('minecraft-data').IndexedData | null | undefined} mcData
 * @param {string} name
 */
export function isKnownItem(mcData, name) {
  return !!(mcData?.itemsByName && mcData.itemsByName[name]);
}

/**
 * @param {{ name: string; count?: number }[]} inv
 * @param {readonly string[]} names
 */
function invCountsForNames(inv, names) {
  /** @type {Record<string, number>} */
  const tallies = {};
  for (const n of names) tallies[n] = 0;
  for (const it of inv) {
    if (names.includes(it.name)) tallies[it.name] = (tallies[it.name] || 0) + (it.count || 0);
  }
  return tallies;
}

/**
 * @param {object} opts
 * @param {import('minecraft-data').IndexedData | null | undefined} opts.mcData
 * @param {{ name: string; count?: number }[]} opts.inventory
 * @param {string} opts.query
 * @param {ResolvePolicy} [opts.policy]
 */
export function resolveInventoryItem(opts) {
  const { mcData, inventory, query } = opts;
  const policy = opts.policy || 'best_available';
  const q = norm(query);
  if (!q) return { ok: false, code: 'empty_query', message: 'Empty item query', candidates: [] };

  if (isKnownItem(mcData, q)) {
    const stack = inventory.find((i) => i.name === q);
    if (policy === 'exact_required' && !stack)
      return { ok: false, code: 'missing_item', message: `No ${q} in inventory`, candidates: [q] };
    return {
      ok: true,
      query,
      kind: 'exact_item',
      selected: { name: q, type: 'item', reason: 'exact_id', count: stack?.count ?? 0 },
      candidates: [{ name: q, score: 100, available: stack?.count ?? 0 }],
      ambiguity: false,
    };
  }

  const alias = QUERY_ALIASES[q];
  if (alias?.kind === 'tool_class') {
    const groupKey = /** @type {'axes'|'pickaxes'} */ (alias.group);
    const names = RESOURCE_GROUPS[groupKey];
    const tallies = invCountsForNames(inventory, [...names]);
    const candidates = names.map((name) => ({
      name,
      score: groupKey === 'axes' ? AXE_SCORE[name] : PICK_SCORE[name],
      available: tallies[name] || 0,
    }));

    const available = candidates.filter((c) => c.available > 0);
    if (policy === 'exact_required') {
      return {
        ok: false,
        code: 'ambiguous_query',
        message: `Use an exact item id (e.g. wooden_axe), not "${query}"`,
        candidates: [...names],
      };
    }
    if (!available.length)
      return {
        ok: false,
        code: 'missing_item',
        message: `No ${q} in inventory`,
        candidates: [...names],
      };

    available.sort((a, b) => b.score - a.score || b.available - a.available);
    const selected = available[0];
    return {
      ok: true,
      query,
      kind: 'tool_class',
      selected: { name: selected.name, type: 'item', reason: policy === 'best_available' ? 'best_available' : policy },
      candidates: available,
      ambiguity:
        available.length > 1 &&
        available[0].score === available[1].score &&
        available[0].available === available[1].available,
    };
  }

  if (alias?.kind === 'resource_group') {
    const g = /** @type {'logs'|'planks'|'stone'} */ (alias.group);
    const names = RESOURCE_GROUPS[g];
    if (policy === 'exact_required')
      return {
        ok: false,
        code: 'ambiguous_query',
        message: `"${query}" matches a resource group. Use a concrete block id.`,
        candidates: [...names],
      };
    const tallies = invCountsForNames(inventory, [...names]);
    const ranked = names
      .map((name) => ({ name, score: tallies[name] || 0, available: tallies[name] || 0 }))
      .filter((x) => x.available > 0)
      .sort((a, b) => b.available - a.available);
    if (!ranked.length)
      return {
        ok: false,
        code: 'missing_item',
        message: `No ${g} blocks in inventory`,
        candidates: [...names],
      };
    return {
      ok: true,
      query,
      kind: 'resource_group',
      selected: { name: ranked[0].name, type: 'item', reason: 'most_available' },
      candidates: ranked,
      ambiguity: ranked.length > 1 && ranked[0].available === ranked[1].available,
    };
  }

  return {
    ok: false,
    code: 'unknown_query',
    message: `Unknown item query "${query}"`,
    candidates: [],
  };
}

/**
 * @param {object} opts
 * @param {import('minecraft-data').IndexedData | null | undefined} opts.mcData
 * @param {string} opts.query
 * @param {ResolvePolicy} [opts.policy]
 */
export function resolveBlockQuery(opts) {
  const { mcData, query } = opts;
  const policy = opts.policy || 'exact_required';
  const q = norm(query);
  if (!q) return { ok: false, code: 'empty_query', message: 'Empty block query', candidates: [] };

  if (isKnownBlock(mcData, q)) {
    return {
      ok: true,
      query,
      kind: 'exact_block',
      selected: { name: q, type: 'block', reason: 'exact_id' },
      candidates: [{ name: q, score: 100 }],
      ambiguity: false,
    };
  }

  const alias = QUERY_ALIASES[q];
  if (alias?.kind === 'resource_group') {
    const g = /** @type {'logs'|'planks'|'stone'} */ (alias.group);
    const names = RESOURCE_GROUPS[g];
    if (policy === 'exact_required')
      return {
        ok: false,
        code: 'ambiguous_query',
        message: `"${query}" matches multiple blocks (${g}). Specify one id.`,
        candidates: [...names],
      };
    return {
      ok: true,
      query,
      kind: 'resource_group',
      selected: { name: names[0], type: 'block', reason: 'group_default_first' },
      candidates: names.map((name, i) => ({ name, score: 50 - i })),
      ambiguity: true,
    };
  }

  return {
    ok: false,
    code: 'unknown_block',
    message: `Unknown block "${query}"`,
    candidates: [],
  };
}

/**
 * @param {object} opts
 * @param {import('minecraft-data').IndexedData | null | undefined} opts.mcData
 * @param {string} opts.query
 * @param {ResolvePolicy} [opts.policy]
 */
export function resolveCraftTarget(opts) {
  const { mcData, query } = opts;
  const policy = opts.policy || 'exact_required';
  const q = norm(query);
  if (!q) return { ok: false, code: 'empty_query', message: 'Empty craft query', candidates: [] };

  if (isKnownItem(mcData, q))
    return {
      ok: true,
      query,
      kind: 'exact_item',
      selected: { name: q, type: 'item', reason: 'exact_id' },
      candidates: [{ name: q, score: 100 }],
      ambiguity: false,
    };

  const alias = QUERY_ALIASES[q];
  if (alias?.kind === 'tool_class') {
    const groupKey = /** @type {'axes'|'pickaxes'} */ (alias.group);
    const names = RESOURCE_GROUPS[groupKey];
    if (policy === 'exact_required')
      return {
        ok: false,
        code: 'ambiguous_query',
        message: `Craft target "${query}" is ambiguous — use an exact item id`,
        candidates: [...names],
      };
    const craftOrder = [...names].reverse();
    return {
      ok: true,
      query,
      kind: 'tool_class',
      selected: { name: craftOrder[0], type: 'item', reason: 'cheapest_craftable' },
      candidates: craftOrder.map((name, i) => ({ name, score: 50 - i })),
      ambiguity: false,
    };
  }

  return {
    ok: false,
    code: 'unknown_item',
    message: `Unknown craft target "${query}"`,
    candidates: [],
  };
}

export function resolveItemQuery(opts) {
  return resolveInventoryItem(opts);
}

export function resolveResourceGroup(query) {
  const q = norm(query);
  const alias = QUERY_ALIASES[q];
  if (alias?.kind !== 'resource_group') return { ok: false, group: null, members: [] };
  const g = /** @type {'logs'|'planks'|'stone'} */ (alias.group);
  return { ok: true, group: g, members: [...RESOURCE_GROUPS[g]] };
}
