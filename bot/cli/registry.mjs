/** @typedef {{ name:string, aliases?: string[], category:string, method:'GET'|'POST'|'DELETE', path?: string, pathFn?: (p:Record<string,unknown>) => string, bodyFn?: (p:Record<string,unknown>) => string | null | undefined, kind?: 'http', description?: string, usage?: string, examples?: string[], argSchema?: import('./args.mjs').ArgSpec[], customParse?: boolean }} CmdDef */

const CAT = [
  'platform',
  'observe',
  'movement',
  'world',
  'craft',
  'combat',
  'social',
  'memory',
  'task',
  'goals',
];

/** @returns {CmdDef} */
function g(name, category, aliases, rest) {
  return { name, aliases, category, ...rest };
}

const empty = '{}';

/** @type {CmdDef[]} */
export const RAW_COMMAND_DEFS = [
  g(
    'status',
    'observe',
    ['state', 's'],
    { method: 'GET', path: '/status', description: 'Full game snapshot', examples: ['mc status', 'mc status --json'] },
  ),
  g('observe', 'observe', ['snapshot'], {
    method: 'GET',
    path: '/observe',
    description: 'Goals + task + alerts snapshot',
    examples: ['mc observe'],
  }),
  g('alerts', 'observe', [], { method: 'GET', path: '/alerts', description: 'Typed alerts', examples: ['mc alerts'] }),
  g('discover', 'observe', ['disc'], {
    method: 'POST',
    path: '/action/discover',
    argSchema: [
      { key: 'category', type: 'string', required: true },
      { key: 'radius', type: 'number', default: 32, min: 1, max: 256 },
    ],
    bodyFn: (p) => JSON.stringify({ category: p.category, radius: Number(p.radius ?? 32) }),
    description: 'Scan for category (logs/wood/food/etc)',
    usage: 'mc discover CATEGORY [RADIUS]',
    examples: [`mc discover logs 48`, `mc discover '{"category":"food","radius":32}'`],
  }),
  g('craft_plan', 'observe', ['cp'], {
    method: 'POST',
    path: '/action/craft_plan',
    argSchema: [
      { key: 'item', type: 'string', required: true },
      { key: 'count', type: 'number', default: 1, min: 1, max: 64 },
    ],
    bodyFn: (p) => JSON.stringify({ item: p.item, count: Number(p.count ?? 1) }),
    description: 'Dependency check crafting plan',
    usage: 'mc craft_plan ITEM [COUNT]',
    examples: ['mc craft_plan oak_planks 4'],
  }),
  g('logistics', 'observe', ['log'], { method: 'GET', path: '/logistics', description: 'Logistics rollup', examples: ['mc logistics'] }),
  g('inventory', 'observe', ['inv', 'i'], { description: 'List items in bot inventory', method: 'GET', path: '/inventory', examples: ['mc inventory'] }),
  g('nearby', 'observe', ['n'], {
    description: 'List nearby blocks/entities within radius',
    method: 'GET',
    pathFn: (p) => `/nearby?radius=${encodeURIComponent(Number(p.radius) || 32)}`,
    argSchema: [{ key: 'radius', type: 'number', default: 32 }],
    examples: ['mc nearby 48'],
  }),
  g('map', 'observe', ['m'], {
    description: 'Compact ASCII map of nearby terrain',
    method: 'GET',
    pathFn: (p) => `/map?radius=${encodeURIComponent(Number(p.radius) || 16)}`,
    argSchema: [{ key: 'radius', type: 'number', default: 16 }],
    examples: ['mc map 16'],
  }),
  g('look', 'observe', ['survey'], { description: 'What the bot is currently facing', method: 'GET', path: '/look', examples: ['mc look'] }),
  g('scene', 'observe', ['perceive', 'vision'], {
    description: 'Visible entities + landmarks in vision range',
    method: 'GET',
    pathFn: (p) => `/scene?range=${encodeURIComponent(Number(p.range ?? p.radius) || 16)}`,
    argSchema: [{ key: 'range', type: 'number', default: 16 }],
    examples: ['mc scene 16'],
  }),
  g('screenshot_meta', 'observe', ['ss_meta'], {
    method: 'GET',
    path: '/health',
    description:
      'Reserved for paired screenshot + state for vision; handled in CLI only until wired to HTTP.',
    examples: ['mc screenshot_meta'],
  }),

  /* Social / chat */
  g('chat', 'social', ['say'], {
    description: 'Public chat message',
    method: 'POST',
    path: '/action/chat',
    argSchema: [{ key: 'message', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ message: p.message }),
    examples: ['mc chat Hello'],
  }),
  g('read_chat', 'social', ['messages', 'msg'], {
    description: 'Recent public chat messages',
    method: 'GET',
    pathFn: (p) => `/chat?count=${encodeURIComponent(Number(p.count) || 20)}`,
    argSchema: [{ key: 'count', type: 'number', default: 20 }],
  }),
  g('overhear', 'social', ['overheard', 'eavesdrop'], {
    description: 'Recent chat from other bots/players (filtered)',
    method: 'GET',
    pathFn: (p) => `/overhear?count=${encodeURIComponent(Number(p.count) || 20)}`,
    argSchema: [{ key: 'count', type: 'number', default: 20 }],
  }),
  g('social', 'social', [], { description: 'Social state: nearby players + interactions', method: 'GET', path: '/social' }),

  /* Movement */
  g('move', 'movement', ['mv'], {
    description: 'Smart non-destructive navigation to X Y Z. Like mc goto but if the path is blocked by a door/gate, automatically opens it (mc through, closes behind) and continues. Up to MAX_DOORS legs. Never digs. Use this instead of mc goto when navigating buildings.',
    method: 'POST',
    path: '/action/move',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        x: Number(p.x),
        y: Number(p.y),
        z: Number(p.z),
        ...(p.max_doors !== undefined ? { max_doors: Number(p.max_doors) } : {}),
        ...(p.door ? { door: p.door } : {}),
      }),
    usage: 'mc move X Y Z [--max-doors N] [--door GX GY GZ]',
    examples: [
      'mc move 100 64 -200',
      'mc move 0 65 6 --max-doors 3',
      'mc move 0 65 6 --door 0 65 2',
    ],
  }),
  g('goto', 'movement', ['go', 'g'], {
    description: 'Walk to absolute block coordinates (raw pathfinder; no door handling). Prefer mc move for general navigation — mc goto is for open spaces and power-user cases.',
    method: 'POST',
    path: '/action/goto',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.mark ? { mark: String(p.mark).replace(/^@/, '') } : {}),
        x: p.x,
        y: p.y,
        z: p.z,
      }),
    usage: 'mc goto X Y Z',
    examples: [`mc goto 100 64 -200`],
  }),
  g('goto_near', 'movement', ['near'], {
    description: 'Walk to within RANGE blocks of target',
    method: 'POST',
    path: '/action/goto_near',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
      { key: 'range', type: 'number', default: 2 },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.mark ? { mark: String(p.mark).replace(/^@/, '') } : {}),
        x: p.x,
        y: p.y,
        z: p.z,
        range: p.range,
      }),
    usage: 'mc goto_near X Y Z [RANGE]',
  }),
  g('follow', 'movement', ['f'], {
    description: 'Follow a player by name',
    method: 'POST',
    path: '/action/follow',
    argSchema: [{ key: 'player', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ player: p.player }),
  }),
  g('look_at', 'movement', [], {
    description: 'Turn the bot to face X Y Z',
    method: 'POST',
    path: '/action/look',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('stop', 'movement', [], { description: 'Cancel current movement task', method: 'POST', path: '/action/stop', bodyFn: () => empty }),

  /* Mining / gather */
  g('collect', 'world', ['mine', 'c'], {
    description: 'Find + mine N of a block type within radius',
    method: 'POST',
    path: '/action/collect',
    argSchema: [
      { key: 'block', type: 'string', required: true },
      { key: 'count', type: 'number', default: 1, min: 1, max: 64 },
    ],
    bodyFn: (p) => JSON.stringify({ block: p.block ?? p.name, count: p.count }),
    usage: 'mc collect BLOCK [COUNT]',
  }),
  g('dig', 'world', ['d'], {
    description: 'Break the block at X Y Z (single block, raw — no hazard checks). Prefer mc safe_dig for general use.',
    method: 'POST',
    path: '/action/dig',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.mark ? { mark: String(p.mark).replace(/^@/, '') } : {}),
        x: p.x,
        y: p.y,
        z: p.z,
      }),
  }),
  g('scout', 'observe', [], {
    description: 'Hazard observation in a radius around X Y Z (or bot position). Read-only — lists lava cells (with source/flowing flag), water, falling-block columns (sand/gravel/anvil/concrete_powder), bedrock proximity, and hostile mobs. Use before mining at depth.',
    method: 'POST',
    path: '/action/scout',
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.x !== undefined ? { x: Number(p.x) } : {}),
        ...(p.y !== undefined ? { y: Number(p.y) } : {}),
        ...(p.z !== undefined ? { z: Number(p.z) } : {}),
        ...(p.radius !== undefined ? { radius: Number(p.radius) } : {}),
      }),
    argSchema: [
      { key: 'x', type: 'number' },
      { key: 'y', type: 'number' },
      { key: 'z', type: 'number' },
      { key: 'radius', type: 'number', default: 8 },
    ],
    usage: 'mc scout [X Y Z] [RADIUS]',
    examples: [
      'mc scout',
      'mc scout 0 -50 0 8',
    ],
  }),
  g('safe_dig', 'world', ['sd'], {
    description: 'Hazard-aware dig: pre-checks for adjacent lava (HAZARD_LAVA), digging-the-floor-under-self (HAZARD_FALL), and suffocation by a falling-block column above (HAZARD_SUFFOCATE). Returns ok:false on hazard without swinging. Use --force to skip checks (delegates to mc dig).',
    method: 'POST',
    path: '/action/safe_dig',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        x: Number(p.x),
        y: Number(p.y),
        z: Number(p.z),
        ...(p.force ? { force: true } : {}),
      }),
    usage: 'mc safe_dig X Y Z [--force]',
    examples: [
      'mc safe_dig 0 64 5',
      'mc safe_dig 0 64 5 --force',
    ],
  }),
  g('pillar_step', 'world', ['tower', 'pillar'], {
    method: 'POST',
    path: '/action/pillar_step',
    description: 'Climb upward by placing blocks underfoot. Use count to climb multiple blocks in one call (max 64).',
    argSchema: [
      { key: 'block', type: 'string' },
      { key: 'count', type: 'number', description: 'blocks to climb (default 1, max 64)' },
      {
        key: 'jump',
        type: 'string',
        description: 'true|false — jump after placing (default true)',
      },
    ],
    bodyFn: (p) => {
      // If the first positional looked like a number, the parser put it in
      // `block` ("5"). Re-route numeric `block` to `count` so users can write
      // `mc pillar_step 5` as a shorthand for `mc pillar_step cobblestone 5`.
      let block = p.block;
      let count = p.count;
      if (block !== undefined && count === undefined && /^\d+$/.test(`${block}`)) {
        count = Number(block);
        block = undefined;
      }
      return JSON.stringify({
        ...(block ? { block } : {}),
        ...(count ? { count: Number(count) } : {}),
        ...(p.jump !== undefined && `${p.jump}`.trim() !== ''
          ? {
              jump: p.jump === true || `${p.jump}`.toLowerCase() === 'true' || `${p.jump}` === '1',
            }
          : {}),
      });
    },
    examples: [`mc pillar_step`, `mc pillar_step 5`, `mc pillar_step cobblestone 10`, `mc pillar_step dirt 20`],
  }),
  g('pickup', 'world', ['p'], { description: 'Walk to + collect a nearby item drop', method: 'POST', path: '/action/pickup', bodyFn: () => empty }),
  g('find_blocks', 'world', ['find', 'fb'], {
    description: 'Locate blocks of TYPE within radius (no mining)',
    method: 'POST',
    path: '/action/find_blocks',
    argSchema: [
      { key: 'block', type: 'string', required: true },
      { key: 'radius', type: 'number', default: 32 },
      { key: 'count', type: 'number', default: 10 },
    ],
    bodyFn: (p) => JSON.stringify({ block: p.block, radius: p.radius, count: p.count }),
    usage: 'mc find_blocks BLOCK [RADIUS] [COUNT]',
  }),
  g('find_entities', 'world', ['fe'], {
    description: 'Locate entities of TYPE within radius',
    method: 'POST',
    path: '/action/find_entities',
    argSchema: [
      { key: 'type', type: 'string', default: '' },
      { key: 'radius', type: 'number', default: 32 },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.type ? { type: p.type } : {}),
        radius: p.radius ?? 32,
      }),
    usage: 'mc find_entities [TYPE] [RADIUS]',
  }),
  /** Server-side pending-command queue ({@link GET /commands}) — aliases match legacy `cmds`/`queue`. */
  g('cmds', 'social', ['queue', 'command_queue'], {
    method: 'GET',
    path: '/commands',
    description: `Pending slash-command queue from chat (HermesCraft). Prefer \`mc commands\` (plan) for CLI registry.`,
    examples: [`mc cmds`],
  }),

  /* Craft */
  g('craft', 'craft', ['cr'], {
    description: 'Craft ITEM [COUNT] using inventory + nearby crafting table',
    method: 'POST',
    path: '/action/craft',
    argSchema: [
      { key: 'item', type: 'string', required: true },
      { key: 'count', type: 'number', default: 1, min: 1, max: 64 },
    ],
    bodyFn: (p) => JSON.stringify({ item: p.item, count: p.count }),
    usage: 'mc craft ITEM [COUNT]',
  }),
  g('recipes', 'craft', ['recipe', 'r'], {
    description: 'List craftable items given current inventory',
    method: 'POST',
    path: '/action/recipes',
    argSchema: [{ key: 'item', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ item: p.item }),
  }),
  g('smelt', 'craft', ['sm'], {
    description: 'Smelt INPUT [COUNT] in nearby furnace (foreground)',
    method: 'POST',
    path: '/action/smelt',
    argSchema: [
      { key: 'input', type: 'string', required: true },
      { key: 'fuel', type: 'string', default: '' },
      { key: 'count', type: 'number', default: 1, min: 1 },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        input: p.input,
        count: Number(p.count) || 1,
        ...(p.fuel ? { fuel: p.fuel } : {}),
      }),
    usage: 'mc smelt INPUT [FUEL] [COUNT]   # synchronous; blocks ~12s per item',
  }),
  g('bg_smelt', 'task', ['bsm'], {
    description: 'Background smelt batch',
    method: 'POST',
    path: '/task/smelt',
    argSchema: [
      { key: 'input', type: 'string', required: true },
      { key: 'fuel', type: 'string', default: '' },
      { key: 'count', type: 'number', default: 1, min: 1 },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        input: p.input,
        count: Number(p.count) || 1,
        ...(p.fuel ? { fuel: p.fuel } : {}),
      }),
    usage: 'mc bg_smelt INPUT [FUEL] [COUNT]   # background; returns task_id, poll mc task',
  }),

  /* Combat */
  g('attack', 'combat', ['kill', 'a'], {
    description: 'Single attack on TARGET (one swing)',
    method: 'POST',
    path: '/action/attack',
    bodyFn: (p) => (p.target ? JSON.stringify({ target: p.target }) : empty),
    argSchema: [{ key: 'target', type: 'string', default: '' }],
  }),
  g('fight', 'combat', [], {
    description: 'Fight loop on TARGET until dead or HP threshold',
    method: 'POST',
    path: '/action/fight',
    bodyFn: (p) =>
      JSON.stringify({
        target: p.target ?? '',
        retreat_health: Number(p.retreat_health ?? 6),
        duration: Number(p.duration ?? 30),
      }),
    argSchema: [
      { key: 'target', type: 'string', default: '' },
      { key: 'retreat_health', type: 'number', default: 6 },
      { key: 'duration', type: 'number', default: 30 },
    ],
    usage: 'mc fight [TARGET] [RETREAT_HEALTH] [DURATION]',
  }),
  g('bg_fight', 'task', [], {
    description: 'Background fight loop',
    method: 'POST',
    path: '/task/fight',
    bodyFn: (p) =>
      JSON.stringify({
        target: p.target ?? '',
        retreat_health: Number(p.retreat_health ?? 6),
        duration: Number(p.duration ?? 30),
      }),
    argSchema: [
      { key: 'target', type: 'string', default: '' },
      { key: 'retreat_health', type: 'number', default: 6 },
      { key: 'duration', type: 'number', default: 30 },
    ],
  }),
  g('flee', 'combat', [], {
    method: 'POST',
    path: '/action/flee',
    bodyFn: (p) => {
      const hasDest = !!(p.to || p.mark);
      const dist = Number(
        hasDest ? (p.distance !== undefined ? p.distance : 16) : p.distance ?? 16,
      );
      return JSON.stringify({
        distance: dist,
        ...(hasDest ? { to: String(p.to || p.mark).replace(/^@/, '') } : {}),
      });
    },
    argSchema: [
      { key: 'distance', type: 'number', default: 16 },
      { key: 'to', type: 'string', default: '' },
      { key: 'mark', type: 'string', default: '' },
    ],
    description:
      `Flee distance (number) or flee --to mark. Plan: mc flee --to @home (supports --to; legacy: mc flee 16)`,
    usage: 'mc flee [DISTANCE] [--to MARK]',
    customParse: true,
  }),

  /* reactive layer mode (Layer 2) */
  g('mode', 'combat', [], {
    method: 'POST',
    path: '/action/mode',
    bodyFn: (p) => JSON.stringify(p.name ? { name: p.name } : {}),
    argSchema: [{ key: 'name', type: 'string', default: '' }],
    description: 'Set reactive mode: normal | guard | hold. No arg = report current mode.',
    examples: ['mc mode', 'mc mode guard', 'mc mode normal', 'mc mode hold'],
  }),

  /* reactive layer combat skill (Layer 2) */
  g('combat_skill', 'combat', ['skill'], {
    method: 'POST',
    path: '/action/combat_skill',
    bodyFn: (p) => JSON.stringify(p.value !== undefined && p.value !== '' ? { value: p.value } : {}),
    argSchema: [{ key: 'value', type: 'string', default: '' }],
    description: 'Per-agent combat skill 0..1 (soldier≈0.9, default 0.5, farmer≈0.2). No arg = report current.',
    examples: ['mc combat_skill', 'mc combat_skill 0.9', 'mc combat_skill 0.2'],
  }),

  /* eat / equip */
  g('eat', 'combat', ['e'], { description: 'Eat the best food in inventory', method: 'POST', path: '/action/eat', bodyFn: () => empty }),
  g('feed_mob', 'world', ['feed', 'use_on_mob'], {
    method: 'POST',
    path: '/action/feed_mob',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        target: p.target,
        ...(p.item ? { item: p.item } : {}),
      }),
    description: 'Right-click mob with held item (breeding food, bucket on cow, etc.)',
    usage: 'mc feed_mob TARGET [ITEM]  OR  mc feed_mob TARGET --item ITEM',
    examples: ['mc feed_mob chicken', 'mc feed_mob cow --item wheat', 'mc feed_mob cow wheat'],
  }),
  g('equip', 'world', ['eq'], {
    description: 'Equip ITEM to hand or armor SLOT',
    method: 'POST',
    path: '/action/equip',
    argSchema: [
      { key: 'item', type: 'string', required: true },
      { key: 'slot', type: 'string', default: 'hand' },
    ],
    bodyFn: (p) => JSON.stringify({ item: p.item ?? p.name, slot: p.slot }),
    usage: 'mc equip ITEM [SLOT]',
  }),
  g('unequip', 'world', ['uneq'], {
    method: 'POST',
    path: '/action/unequip',
    argSchema: [
      { key: 'slot', type: 'string', default: 'hand' },
    ],
    bodyFn: (p) => JSON.stringify({ slot: p.slot }),
    description: 'Clear main hand (or slot). Use before chopping logs without an axe.',
    examples: ['mc unequip', 'mc unequip off-hand'],
  }),

  /* build */
  g('place', 'world', ['pl'], {
    description: 'Place a block at X Y Z (block from hand)',
    method: 'POST',
    path: '/action/place',
    argSchema: [
      { key: 'block', type: 'string', required: true },
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        block: p.block ?? p.name,
        x: p.x,
        y: p.y,
        z: p.z,
      }),
    usage: 'mc place BLOCK X Y Z',
  }),
  g('fill', 'world', [], {
    description: 'Fill an axis-aligned box with BLOCK',
    method: 'POST',
    path: '/task/place_fill',
    bodyFn: (p) =>
      JSON.stringify({
        block: String(p.block),
        x1: Number(p.x1),
        y1: Number(p.y1),
        z1: Number(p.z1),
        x2: Number(p.x2),
        y2: Number(p.y2),
        z2: Number(p.z2),
        hollow: !!p.hollow,
      }),
    argSchema: [
      { key: 'block', type: 'string', required: true },
      { key: 'x1', type: 'number', required: true },
      { key: 'y1', type: 'number', required: true },
      { key: 'z1', type: 'number', required: true },
      { key: 'x2', type: 'number', required: true },
      { key: 'y2', type: 'number', required: true },
      { key: 'z2', type: 'number', required: true },
      { key: 'hollow', type: 'boolean', default: false },
    ],
    usage: 'mc fill BLOCK X1 Y1 Z1 X2 Y2 Z2 [HOLLOW]',
  }),

  /* Sprint 5 — Building primitives. mc wall is sugar over place_fill that
   * enforces a vertical-height guard (y1 != y2) and follows the action
   * contract (data + structured errors). */
  g('fence', 'world', [], {
    description: 'Build a fence enclosure (rectangle perimeter at one Y) of BLOCK between two corners. Optional --gate DIR (north|south|east|west) places a matching fence_gate at the midpoint of that side. Min 3×3.',
    method: 'POST',
    path: '/action/fence',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        block: String(p.block),
        x1: Number(p.x1),
        z1: Number(p.z1),
        x2: Number(p.x2),
        z2: Number(p.z2),
        ...(p.gate ? { gate: String(p.gate) } : {}),
        ...(p.y !== undefined ? { y: Number(p.y) } : {}),
      }),
    usage: 'mc fence BLOCK X1 Z1 X2 Z2 [--gate DIR] [--y Y]',
    examples: [
      'mc fence oak_fence -3 -3 3 3 --gate south',
      'mc fence spruce_fence 10 10 14 16',
    ],
  }),

  g('dig_pit', 'world', [], {
    description: 'Dig a W×L×D pit at corner (X, Z). Top of pit defaults to bot Y - 1 (the surface block); pit floor ends up at top - D. Use mc build_stairs separately to add stairs out. Max 256 columns × 16 depth.',
    method: 'POST',
    path: '/action/dig_pit',
    bodyFn: (p) =>
      JSON.stringify({
        x: Number(p.x),
        z: Number(p.z),
        w: Number(p.w),
        l: Number(p.l),
        d: Number(p.d),
        ...(p.top_y !== undefined ? { top_y: Number(p.top_y) } : {}),
      }),
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
      { key: 'w', type: 'number', required: true },
      { key: 'l', type: 'number', required: true },
      { key: 'd', type: 'number', required: true },
      { key: 'top_y', type: 'number' },
    ],
    usage: 'mc dig_pit X Z W L D [TOP_Y]',
    examples: [
      'mc dig_pit 0 0 3 3 3',
      'mc dig_pit 100 200 5 5 4 64',
    ],
  }),

  g('level', 'world', [], {
    description: 'Flatten a rectangle to target Y: dig solid blocks above Y (up to 8 by default), and fill any air gaps at Y with a leveling block. Auto-picks a fill block from {dirt, cobblestone, stone} unless BLOCK is given. Below Y is not touched. Max 256 columns.',
    method: 'POST',
    path: '/action/level',
    bodyFn: (p) =>
      JSON.stringify({
        x1: Number(p.x1),
        z1: Number(p.z1),
        x2: Number(p.x2),
        z2: Number(p.z2),
        y: Number(p.y),
        ...(p.block ? { block: String(p.block) } : {}),
        ...(p.up !== undefined ? { up: Number(p.up) } : {}),
      }),
    argSchema: [
      { key: 'x1', type: 'number', required: true },
      { key: 'z1', type: 'number', required: true },
      { key: 'x2', type: 'number', required: true },
      { key: 'z2', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'block', type: 'string' },
      { key: 'up', type: 'number' },
    ],
    usage: 'mc level X1 Z1 X2 Z2 Y [BLOCK] [UP]',
    examples: [
      'mc level 0 0 4 4 64',
      'mc level -3 -3 3 3 64 dirt',
    ],
  }),

  g('build_stairs', 'world', [], {
    description: 'Build an ascending triangular ramp of BLOCK in cardinal DIR for LEN steps. Each column i is filled from the floor up to height i, so column 1 is 1 block tall, column 2 is 2 blocks, etc. The bot walks up the ramp as it builds. Total blocks = LEN*(LEN+1)/2; LEN is capped at 16.',
    method: 'POST',
    path: '/action/build_stairs',
    bodyFn: (p) =>
      JSON.stringify({
        block: String(p.block),
        direction: String(p.direction),
        length: Number(p.length),
        ...(p.x !== undefined ? { x: Number(p.x) } : {}),
        ...(p.y !== undefined ? { y: Number(p.y) } : {}),
        ...(p.z !== undefined ? { z: Number(p.z) } : {}),
      }),
    argSchema: [
      { key: 'block', type: 'string', required: true },
      { key: 'direction', type: 'string', required: true },
      { key: 'length', type: 'number', required: true },
      { key: 'x', type: 'number' },
      { key: 'y', type: 'number' },
      { key: 'z', type: 'number' },
    ],
    usage: 'mc build_stairs BLOCK DIR LEN [X Y Z]',
    examples: [
      'mc build_stairs cobblestone north 4',
      'mc build_stairs oak_planks east 6 0 65 0',
    ],
  }),

  g('path', 'world', [], {
    description: 'Convert dirt/grass/podzol/coarse_dirt/mycelium/rooted_dirt to dirt_path inside an axis-aligned rectangle, using a shovel. Default Y is bot Y-1 (the floor). Skips columns that are already path, non-dirt, or covered by a non-air block above.',
    method: 'POST',
    path: '/action/path',
    bodyFn: (p) =>
      JSON.stringify({
        x1: Number(p.x1),
        z1: Number(p.z1),
        x2: Number(p.x2),
        z2: Number(p.z2),
        ...(p.y !== undefined ? { y: Number(p.y) } : {}),
      }),
    argSchema: [
      { key: 'x1', type: 'number', required: true },
      { key: 'z1', type: 'number', required: true },
      { key: 'x2', type: 'number', required: true },
      { key: 'z2', type: 'number', required: true },
      { key: 'y', type: 'number' },
    ],
    usage: 'mc path X1 Z1 X2 Z2 [Y]',
    examples: [
      'mc path -3 0 3 0',
      'mc path 10 10 14 14 64',
    ],
  }),

  g('through', 'world', [], {
    description: 'Pass through a fence_gate, door, or trapdoor: opens it, walks to the far side, closes it behind. Destination defaults to 2 blocks past the gate on the opposite side from the bot.',
    method: 'POST',
    path: '/action/through',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        gx: Number(p.gx),
        gy: Number(p.gy),
        gz: Number(p.gz),
        ...(p.dx !== undefined ? { dx: Number(p.dx) } : {}),
        ...(p.dy !== undefined ? { dy: Number(p.dy) } : {}),
        ...(p.dz !== undefined ? { dz: Number(p.dz) } : {}),
      }),
    usage: 'mc through GX GY GZ [DX DY DZ]',
    examples: [
      'mc through 0 65 2',
      'mc through 0 65 2 0 65 5',
    ],
  }),

  g('wall', 'world', [], {
    description: 'Build a wall (vertical line/rect) of BLOCK between two corners. y1 must differ from y2.',
    method: 'POST',
    path: '/action/wall',
    bodyFn: (p) =>
      JSON.stringify({
        block: String(p.block),
        x1: Number(p.x1),
        y1: Number(p.y1),
        z1: Number(p.z1),
        x2: Number(p.x2),
        y2: Number(p.y2),
        z2: Number(p.z2),
      }),
    argSchema: [
      { key: 'block', type: 'string', required: true },
      { key: 'x1', type: 'number', required: true },
      { key: 'y1', type: 'number', required: true },
      { key: 'z1', type: 'number', required: true },
      { key: 'x2', type: 'number', required: true },
      { key: 'y2', type: 'number', required: true },
      { key: 'z2', type: 'number', required: true },
    ],
    usage: 'mc wall BLOCK X1 Y1 Z1 X2 Y2 Z2',
    examples: [
      'mc wall cobblestone 0 65 0 0 67 4',
      'mc wall oak_planks -3 65 -3 -3 67 3',
    ],
  }),

  g('dig_area', 'world', ['da', 'clear_area'], {
    method: 'POST',
    path: '/action/dig_area',
    description:
      'Mine diggable blocks in an axis-aligned box (high Y first; optional stand-block nudge per layer). Max 500 blocks.',
    usage: 'mc dig_area X1 Y1 Z1 X2 Y2 Z2',
    examples: ['mc dig_area 100 64 -200 102 61 -198', 'mc dig_area \'{"x1":10,"y1":70,"z1":0,"x2":10,"y2":67,"z2":0,"pickup":true}\''],
    argSchema: [
      { key: 'x1', type: 'number', required: true },
      { key: 'y1', type: 'number', required: true },
      { key: 'z1', type: 'number', required: true },
      { key: 'x2', type: 'number', required: true },
      { key: 'y2', type: 'number', required: true },
      { key: 'z2', type: 'number', required: true },
      { key: 'pickup', type: 'boolean', default: true },
      { key: 'abort_on_fail', type: 'boolean', default: false },
      { key: 'clear_stand', type: 'boolean', default: true },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        x1: Number(p.x1),
        y1: Number(p.y1),
        z1: Number(p.z1),
        x2: Number(p.x2),
        y2: Number(p.y2),
        z2: Number(p.z2),
        pickup: p.pickup !== false,
        abort_on_fail: p.abort_on_fail === true,
        clear_stand: p.clear_stand !== false,
      }),
  }),
  g('tunnel', 'world', ['mine_tunnel'], {
    method: 'POST',
    path: '/action/tunnel',
    description:
      'Dig a straight tunnel using repeated dig_area slices (industrial corridor primitive).',
    usage: 'mc tunnel X Y Z DIR LENGTH [WIDTH] [HEIGHT]',
    examples: ['mc tunnel 367 53 -593 north 16 2 3', 'mc tunnel \'{"direction":"east","length":12}\''],
    argSchema: [
      { key: 'x', type: 'number', default: null },
      { key: 'y', type: 'number', default: null },
      { key: 'z', type: 'number', default: null },
      { key: 'direction', type: 'string', required: true },
      { key: 'length', type: 'number', default: 12 },
      { key: 'width', type: 'number', default: 2 },
      { key: 'height', type: 'number', default: 3 },
      { key: 'pickup', type: 'boolean', default: true },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.x !== null && p.x !== undefined ? { x: Number(p.x) } : {}),
        ...(p.y !== null && p.y !== undefined ? { y: Number(p.y) } : {}),
        ...(p.z !== null && p.z !== undefined ? { z: Number(p.z) } : {}),
        direction: String(p.direction),
        length: Number(p.length ?? 12),
        width: Number(p.width ?? 2),
        height: Number(p.height ?? 3),
        pickup: p.pickup !== false,
      }),
  }),
  g('stair_down', 'world', ['mine_stairs', 'stairs_down'], {
    method: 'POST',
    path: '/action/stair_down',
    description:
      'Dig a descending staircase (one down per forward step) for reliable mine routes.',
    usage: 'mc stair_down DIR [LENGTH] [X Y Z] [WIDTH] [HEIGHT]',
    examples: ['mc stair_down north', 'mc stair_down north 20', 'mc stair_down north 12 367 53 -593 1 3', 'mc stair_down \'{"direction":"west","length":10}\''],
    argSchema: [
      { key: 'direction', type: 'string', required: true },
      { key: 'length', type: 'number', default: 12 },
      { key: 'x', type: 'number', default: null },
      { key: 'y', type: 'number', default: null },
      { key: 'z', type: 'number', default: null },
      { key: 'width', type: 'number', default: 1 },
      { key: 'height', type: 'number', default: 3 },
      { key: 'pickup', type: 'boolean', default: true },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.x !== null && p.x !== undefined ? { x: Number(p.x) } : {}),
        ...(p.y !== null && p.y !== undefined ? { y: Number(p.y) } : {}),
        ...(p.z !== null && p.z !== undefined ? { z: Number(p.z) } : {}),
        direction: String(p.direction),
        length: Number(p.length ?? 12),
        width: Number(p.width ?? 1),
        height: Number(p.height ?? 3),
        pickup: p.pickup !== false,
      }),
  }),
  g('stair_up', 'world', ['stairs_up', 'escape'], {
    method: 'POST',
    path: '/action/stair_up',
    description:
      'Dig an ascending staircase (one up per forward step). Places floor blocks over voids. Use to escape deep caves safely.',
    usage: 'mc stair_up DIR [LENGTH] [X Y Z] [WIDTH] [HEIGHT]',
    examples: ['mc stair_up north', 'mc stair_up north 20', 'mc stair_up east 30 350 -4 -567 1 3'],
    argSchema: [
      { key: 'direction', type: 'string', required: true },
      { key: 'length', type: 'number', default: 12 },
      { key: 'x', type: 'number', default: null },
      { key: 'y', type: 'number', default: null },
      { key: 'z', type: 'number', default: null },
      { key: 'width', type: 'number', default: 1 },
      { key: 'height', type: 'number', default: 3 },
      { key: 'pickup', type: 'boolean', default: true },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.x !== null && p.x !== undefined ? { x: Number(p.x) } : {}),
        ...(p.y !== null && p.y !== undefined ? { y: Number(p.y) } : {}),
        ...(p.z !== null && p.z !== undefined ? { z: Number(p.z) } : {}),
        direction: String(p.direction),
        length: Number(p.length ?? 12),
        width: Number(p.width ?? 1),
        height: Number(p.height ?? 3),
        pickup: p.pickup !== false,
      }),
  }),
  g('terrain_top', 'world', ['ttop', 'surface_y'], {
    method: 'POST',
    path: '/action/terrain_top',
    description: 'Top solid block in column(s): highest non-air, non-fluid from sky down (optional square radius).',
    examples: ['mc terrain_top 120 -45', 'mc terrain_top 120 -45 12'],
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
      { key: 'radius', type: 'number', default: 0, min: 0, max: 32 },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        x: Number(p.x),
        z: Number(p.z),
        radius: Number(p.radius ?? 0),
      }),
  }),
  g('interact', 'world', ['use_block'], {
    description: 'Right-click block at X Y Z (door/lever/button)',
    method: 'POST',
    path: '/action/interact',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('close', 'world', [], { description: 'Close currently-open container', method: 'POST', path: '/action/close_screen', bodyFn: () => empty }),

  g('use', 'world', ['u'], { description: 'Activate held item (right-click in air)', method: 'POST', path: '/action/use', bodyFn: () => empty }),

  g('surface', 'world', ['swim_up'], {
    description: 'Swim up to the water surface. Hold jump until head is in air or 30s elapses. No-op if not in water.',
    method: 'POST',
    path: '/action/surface',
    bodyFn: () => empty,
    usage: 'mc surface',
    examples: ['mc surface'],
  }),

  g('bucket_fill', 'world', ['fill_bucket'], {
    description: 'Fill an empty bucket from a water/lava source block at X Y Z. Returns NOT_A_SOURCE if the block is flowing (level > 0).',
    method: 'POST',
    path: '/action/bucket_fill',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }),
    usage: 'mc bucket_fill X Y Z',
    examples: ['mc bucket_fill 10 64 -3', 'mc bucket_fill -5 65 0'],
  }),

  g('bucket_empty', 'world', ['empty_bucket', 'pour'], {
    description: 'Place water/lava from a filled bucket at X Y Z. Auto-picks water_bucket or lava_bucket from inventory. Target must be air/grass/replaceable.',
    method: 'POST',
    path: '/action/bucket_empty',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }),
    usage: 'mc bucket_empty X Y Z',
    examples: ['mc bucket_empty 3 65 0', 'mc bucket_empty -2 64 5  # pour water onto lava — produces stone/cobble/obsidian'],
  }),

  g('till', 'world', ['hoe'], {
    description: 'Convert dirt/grass at X Y Z into farmland. Auto-equips any hoe (wooden/stone/iron/etc.). Returns NO_HOE / NOT_TILLABLE / OUT_OF_RANGE.',
    method: 'POST',
    path: '/action/till',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }),
    usage: 'mc till X Y Z',
    examples: ['mc till 5 64 10', 'mc till 0 64 0'],
  }),

  g('plant', 'world', ['sow'], {
    description: 'Plant a seed/sapling at X Y Z. ITEM must be in inventory (wheat_seeds, beetroot_seeds, carrot, potato, *_sapling, sugar_cane, melon_seeds, pumpkin_seeds). The block at (X,Y-1,Z) must be farmland (for farm crops) or dirt/grass (for saplings/sugar_cane).',
    method: 'POST',
    path: '/action/plant',
    argSchema: [
      { key: 'item', type: 'string', required: true },
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ item: String(p.item), x: Number(p.x), y: Number(p.y), z: Number(p.z) }),
    usage: 'mc plant ITEM X Y Z',
    examples: ['mc plant wheat_seeds 5 65 10', 'mc plant oak_sapling 0 65 0'],
  }),

  g('bonemeal', 'world', [], {
    description: 'Apply bone meal to a crop or sapling at X Y Z. Accelerates growth (or fully matures via PaperMCP fallback if mineflayer activation silently no-ops). Returns NO_BONEMEAL / NOT_GROWABLE / BONEMEAL_FAILED.',
    method: 'POST',
    path: '/action/bonemeal',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }),
    usage: 'mc bonemeal X Y Z',
    examples: ['mc bonemeal 5 65 10'],
  }),

  g('harvest', 'world', [], {
    description: 'Harvest mature crops in axis-aligned rectangle (X1,Z1)-(X2,Z2) at Y (defaults to bot foot Y). Skips immature crops and reports them. Picks up drops.',
    method: 'POST',
    path: '/action/harvest',
    argSchema: [
      { key: 'x1', type: 'number', required: true },
      { key: 'z1', type: 'number', required: true },
      { key: 'x2', type: 'number', required: true },
      { key: 'z2', type: 'number', required: true },
      { key: 'y', type: 'number', required: false },
    ],
    bodyFn: (p) => JSON.stringify({
      x1: Number(p.x1), z1: Number(p.z1), x2: Number(p.x2), z2: Number(p.z2),
      ...(p.y !== undefined ? { y: Number(p.y) } : {}),
    }),
    usage: 'mc harvest X1 Z1 X2 Z2 [Y]',
    examples: ['mc harvest 0 0 4 4 65', 'mc harvest -2 -2 2 2'],
  }),
  g('toss', 'world', ['drop'], {
    description: 'Drop ITEM [COUNT] from inventory',
    method: 'POST',
    path: '/action/toss',
    bodyFn: (p) =>
      JSON.stringify({
        item: p.item ?? p.name,
        ...(p.count !== undefined ? { count: Number(p.count) } : {}),
      }),
    argSchema: [
      { key: 'item', type: 'string', required: true },
      { key: 'count', type: 'number', default: null },
    ],
    usage: 'mc toss ITEM [COUNT]',
  }),

  g('sleep', 'world', ['bed'], {
    method: 'POST',
    path: '/action/sleep_bed',
    bodyFn: () => empty,
    description: 'Find a nearby bed (up to 32 blocks), navigate to it, and sleep. Sets your spawn point.',
  }),
  g('set_home', 'world', ['sethome'], {
    method: 'POST',
    path: '/action/set_home',
    description: 'Set your respawn point. Uses server command if available, otherwise finds a bed to sleep in. Call this at your base before going deep underground.',
    usage: 'mc set_home [X Y Z]',
    examples: ['mc set_home', 'mc set_home 367 66 -606'],
    argSchema: [
      { key: 'x', type: 'number', required: false },
      { key: 'y', type: 'number', required: false },
      { key: 'z', type: 'number', required: false },
    ],
    bodyFn: (p) => JSON.stringify({
      ...(p.x !== undefined ? { x: Number(p.x) } : {}),
      ...(p.y !== undefined ? { y: Number(p.y) } : {}),
      ...(p.z !== undefined ? { z: Number(p.z) } : {}),
    }),
  }),
  g('wait', 'world', ['w'], {
    description: 'Pause N seconds (no-op until timeout)',
    method: 'POST',
    path: '/action/wait',
    argSchema: [{ key: 'seconds', type: 'number', default: 5 }],
    bodyFn: (p) => JSON.stringify({ seconds: Number(p.seconds ?? 5) }),
  }),

  /* chat_to / whisper */
  g('chat_to', 'social', [], {
    description: 'Direct chat to PLAYER',
    method: 'POST',
    path: '/action/chat_to',
    argSchema: [
      { key: 'player', type: 'string', required: true },
      { key: 'message', type: 'string', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ player: p.player, message: p.message }),
  }),
  g('whisper', 'social', ['dm', 'tell', 'private'], {
    description: 'Whisper (private) to PLAYER',
    method: 'POST',
    path: '/action/whisper',
    argSchema: [
      { key: 'player', type: 'string', required: true },
      { key: 'message', type: 'string', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ player: p.player, message: p.message }),
  }),

  /* death / respawn */
  g('deaths', 'observe', [], { description: 'Recent death events', method: 'GET', path: '/deaths' }),
  g('deathpoint', 'movement', [], { description: 'Walk to most recent death location', method: 'POST', path: '/action/deathpoint', bodyFn: () => empty }),
  g('respawn', 'world', [], {
    method: 'POST',
    path: '/action/respawn',
    description: 'Kill and respawn at spawn point. Use when hopelessly stuck underground with no tools or resources to escape. All inventory is dropped at the death location.',
    usage: 'mc respawn yes',
    examples: ['mc respawn yes'],
    argSchema: [
      { key: 'confirm', type: 'string', required: true, description: 'Must be "yes" to confirm' },
    ],
    bodyFn: (p) => JSON.stringify({ confirm: p.confirm }),
  }),

  /* chest */
  g('chest', 'world', ['list_container'], {
    description: 'Open + list a chest at X Y Z or @MARK',
    method: 'POST',
    path: '/action/list_container',
    argSchema: [
      { key: 'x', type: 'number', required: false },
      { key: 'y', type: 'number', required: false },
      { key: 'z', type: 'number', required: false },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.mark ? { mark: String(p.mark).replace(/^@/, '') } : {}),
        ...((p.x !== undefined && p.y !== undefined && p.z !== undefined) ? { x: p.x, y: p.y, z: p.z } : {}),
      }),
    usage: 'mc chest X Y Z  OR  mc chest @MARK',
    customParse: true,
  }),
  g('deposit', 'world', [], {
    method: 'POST',
    path: '/action/deposit',
    argSchema: [
      { key: 'item', type: 'string', required: true },
      { key: 'count', type: 'number', default: 0 },
      { key: 'x', type: 'number', required: false },
      { key: 'y', type: 'number', required: false },
      { key: 'z', type: 'number', required: false },
      { key: 'items', type: 'json', required: false },
      { key: 'mark', type: 'string', default: '' },
    ],
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.items ? { items: p.items } : { item: p.item, count: p.count ?? 0 }),
        ...(p.mark ? { mark: String(p.mark).replace(/^@/, '') } : {}),
        ...(p.x !== undefined ? { x: p.x, y: p.y, z: p.z } : {}),
      }),
    description: 'Deposit items into a chest (count=0 means all).',
    usage: 'mc deposit ITEM COUNT X Y Z  OR  mc deposit ITEM COUNT MARK  OR  mc deposit ITEM @MARK',
    examples: ['mc deposit oak_log 16 364 65 -597', 'mc deposit oak_log 0 materials_chest', 'mc deposit oak_log @materials_chest'],
  }),
  g('withdraw', 'world', [], {
    method: 'POST',
    path: '/action/withdraw',
    argSchema: [
      { key: 'item', type: 'string', required: false },
      { key: 'count', type: 'number', default: 0 },
      { key: 'x', type: 'number', required: false },
      { key: 'y', type: 'number', required: false },
      { key: 'z', type: 'number', required: false },
      { key: 'items', type: 'json', required: false },
      { key: 'mark', type: 'string', default: '' },
    ],
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.items ? { items: p.items } : { item: p.item, count: p.count ?? 0 }),
        ...(p.mark ? { mark: String(p.mark).replace(/^@/, '') } : {}),
        ...(p.x !== undefined ? { x: p.x, y: p.y, z: p.z } : {}),
      }),
    description: 'Withdraw items from a chest (count=0 means all).',
    usage: 'mc withdraw ITEM COUNT X Y Z  OR  mc withdraw ITEM COUNT MARK  OR  mc withdraw ITEM @MARK',
    examples: ['mc withdraw iron_ingot 5 100 64 -200', 'mc withdraw iron_ingot 0 materials_chest'],
  }),
  g('chest_search', 'world', ['cs', 'find_in_chests'], {
    method: 'POST',
    path: '/action/chest_search',
    argSchema: [
      { key: 'item', type: 'string', required: true },
      { key: 'max_results', type: 'number', default: 10 },
      { key: 'exact', type: 'boolean', default: true },
    ],
    bodyFn: (p) => JSON.stringify({
      item: p.item,
      max_results: Number(p.max_results) || 10,
      exact: p.exact !== false,
    }),
    description: 'Search known chest snapshots (cached from prior list/deposit/withdraw) for an item across all marks. No chest is opened — returns marks + counts. Workers should use this BEFORE deciding which chest to walk to.',
    usage: 'mc chest_search ITEM [MAX_RESULTS]',
    examples: ['mc chest_search iron_ingot', 'mc chest_search oak_planks 5'],
  }),

  /* marks */
  g('mark', 'memory', [], {
    description: 'Save current position as named mark',
    method: 'POST',
    path: '/action/mark',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        name: p.name,
        note: p.note ?? '',
        ...(p.category !== undefined ? { category: p.category } : {}),
        ...(p.radius !== undefined ? { radius: p.radius } : {}),
        ...(p.mode !== undefined ? { mode: p.mode } : {}),
        ...(p.stale !== undefined ? { stale: p.stale } : {}),
        ...(p.at && typeof p.at === 'object' ? { at: p.at } : {}),
        ...(p.at_mark ? { at_mark: p.at_mark } : {}),
      }),
    usage: 'mc mark NAME [NOTE]',
  }),
  g('marks', 'memory', [], { description: 'List all marks', method: 'POST', path: '/action/marks', bodyFn: () => empty }),
  g('mark_update', 'memory', ['mark-up', 'mu'], {
    description: 'Move existing MARK to current position',
    method: 'POST',
    path: '/action/mark_update',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        name: p.name,
        ...(p.note !== undefined && p.note !== '' ? { note: p.note } : {}),
        ...(p.category !== undefined ? { category: p.category } : {}),
        ...(p.radius !== undefined ? { radius: p.radius } : {}),
        ...(p.mode !== undefined ? { mode: p.mode } : {}),
        ...(p.stale !== undefined ? { stale: p.stale } : {}),
      }),
  }),
  g('go_mark', 'memory', [], {
    description: 'Walk to a saved mark',
    method: 'POST',
    path: '/action/go_mark',
    argSchema: [{ key: 'name', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ name: p.name }),
    usage: 'mc go_mark NAME',
  }),
  g('unmark', 'memory', [], {
    description: 'Delete a mark by name',
    method: 'POST',
    path: '/action/unmark',
    argSchema: [{ key: 'name', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ name: p.name }),
  }),

  /* Goals */
  g('goals', 'goals', [], { description: 'List active goals with urgency', method: 'GET', path: '/goals' }),
  g('goal_add', 'goals', [], {
    description: 'Add a new goal (id + metric + thresholds)',
    method: 'POST',
    path: '/goals',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ goal: p.goal }),
  }),
  g('goal_set', 'goals', [], {
    description: 'Set goal field (priority, target, etc.)',
    method: 'POST',
    path: '/goals/update',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
  }),
  g('goal_remove', 'goals', ['goal_rm'], { description: 'Remove goal by id', method: 'DELETE', pathFn: (p) => `/goals/${encodeURIComponent(String(p.id))}`, customParse: true }),
  g('goal_status', 'goals', ['gs'], {
    description: 'Detail status of a single goal',
    method: 'GET',
    pathFn: (p) => `/goals/${encodeURIComponent(String(p.id))}`,
    customParse: true,
  }),
  g('goal_presets', 'goals', [], { description: 'List built-in goal presets', method: 'GET', path: '/goal-presets' }),
  g('goal_load', 'goals', ['load_goals'], {
    description: 'Load a goal preset (miner/builder/etc.)',
    method: 'POST',
    path: '/goals/load-preset',
    argSchema: [{ key: 'preset', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ preset: p.preset }),
  }),

  /* task */
  g('task_start', 'task', ['tstart'], {
    description: 'Start named background task with args',
    method: 'POST',
    path: '/task/start',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
  }),
  g('task', 'task', ['task_status'], { description: 'Status of background task by id', method: 'GET', path: '/task', examples: [`mc task`] }),
  g('task_pause', 'task', [], { description: 'Pause running task', method: 'POST', path: '/task/pause', bodyFn: () => empty }),
  g('task_resume', 'task', [], {
    description: 'Resume paused task',
    method: 'POST',
    path: '/task/resume',
    argSchema: [{ key: 'lease_seconds', type: 'number', default: 45 }],
    bodyFn: (p) => JSON.stringify({ lease_seconds: Number(p.lease_seconds ?? 45) }),
  }),
  g('task_history', 'task', ['tasks_done'], {
    description: 'List recent task runs',
    method: 'GET',
    path: '/task/history',
  }),
  g('checkpoint', 'task', ['chk'], {
    description: 'Set agent decision checkpoint',
    method: 'GET',
    path: '/checkpoint',
  }),
  g('checkpoint_respond', 'task', ['cpr'], {
    description: 'Respond to a pending checkpoint',
    method: 'POST',
    path: '/task/checkpoint-respond',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ decision: p.decision, lease_seconds: p.lease_seconds }),
  }),

  /* background */
  g('bg_collect', 'task', [], {
    description: 'Background mine N of BLOCK',
    method: 'POST',
    path: '/task/collect',
    argSchema: [
      { key: 'block', type: 'string', required: true },
      { key: 'count', type: 'number', default: 1 },
    ],
    bodyFn: (p) => JSON.stringify({ block: p.block ?? p.name, count: p.count }),
    usage: 'mc bg_collect BLOCK [COUNT]',
  }),
  g('bg_goto', 'task', [], {
    description: 'Background walk to X Y Z',
    method: 'POST',
    path: '/task/goto',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
    usage: 'mc bg_goto X Y Z',
  }),
  g('cancel', 'task', [], {
    description: 'Cancel current task',
    method: 'POST',
    path: '/task/cancel',
    bodyFn: () => empty,
  }),

  /* advanced combat*/
  g('sneak', 'combat', [], {
    description: 'Toggle sneak (crouch)',
    method: 'POST',
    path: '/action/sneak',
    bodyFn: (p) =>
      JSON.stringify({
        enable: !(p.enable === 'off' || p.enable === 'false' || p.enable === false || p.enable === '0'),
      }),
    argSchema: [{ key: 'enable', type: 'string', default: 'true' }],
  }),
  g('shield', 'combat', ['block'], {
    description: 'Raise shield (block) for SECONDS',
    method: 'POST',
    path: '/action/shield_block',
    argSchema: [{ key: 'duration', type: 'number', default: 3 }],
    bodyFn: (p) => JSON.stringify({ duration: Number(p.duration ?? 3) }),
  }),
  g('shoot', 'combat', ['bow'], {
    description: 'Fire bow at TARGET (must hold bow + arrows)',
    method: 'POST',
    path: '/action/shoot',
    argSchema: [
      { key: 'target', type: 'string', default: '' },
      { key: 'predict', type: 'boolean', default: true },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.target ? { target: p.target } : {}),
        predict: p.predict !== undefined ? !!p.predict : true,
      }),
    customParse: true,
  }),
  g('sprint_attack', 'combat', ['sa'], {
    description: 'Sprint into TARGET for knockback hit',
    method: 'POST',
    path: '/action/sprint_attack',
    bodyFn: (p) => (p.target ? JSON.stringify({ target: p.target }) : empty),
    argSchema: [{ key: 'target', type: 'string', default: '' }],
  }),
  g('crit', 'combat', ['critical'], {
    description: 'Jump-attack TARGET for critical-hit damage',
    method: 'POST',
    path: '/action/critical_hit',
    bodyFn: (p) => (p.target ? JSON.stringify({ target: p.target }) : empty),
    argSchema: [{ key: 'target', type: 'string', default: '' }],
  }),
  g('strafe', 'combat', [], {
    description: 'Sidestep TARGET while attacking',
    method: 'POST',
    path: '/action/strafe',
    customParse: true,
    bodyFn: (p) => JSON.stringify({
      ...(p.target ? { target: p.target } : {}),
      direction: p.direction,
      duration: p.duration,
    }),
  }),
  g('combo', 'combat', [], {
    description: 'Pre-defined attack sequence on TARGET',
    method: 'POST',
    path: '/action/combo',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.target ? { target: p.target } : {}),
        style: p.style,
      }),
  }),
  g('bg_combo', 'task', [], {
    description: 'Background combo attack sequence',
    method: 'POST',
    path: '/task/combo',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.target ? { target: p.target } : {}),
        style: p.style,
      }),
  }),
  g('bg_strafe', 'task', [], {
    description: 'Background strafe loop',
    method: 'POST',
    path: '/task/strafe',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.target ? { target: p.target } : {}),
        direction: p.direction,
        duration: p.duration,
      }),
  }),

  /* smelt extras */
  g('smelt_start', 'craft', ['sstart'], {
    description: 'Begin background smelt task (returns task id)',
    method: 'POST',
    path: '/action/smelt_start',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        input: p.input,
        count: Number(p.count ?? 1),
        ...(p.fuel ? { fuel: p.fuel } : {}),
      }),
    usage: 'mc smelt_start INPUT [FUEL] [COUNT]',
  }),
  g('furnace_check', 'craft', ['fc'], {
    description: 'Status of a specific furnace (input/output/fuel)',
    method: 'POST',
    path: '/action/furnace_check',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('furnace_take', 'craft', ['ft'], {
    description: 'Withdraw smelted output from furnace',
    method: 'POST',
    path: '/action/furnace_take',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('furnaces', 'observe', [], { description: 'List known furnace marks + smelt status', method: 'GET', path: '/furnaces' }),

  /* team */
  g('team_chat', 'social', ['tc'], {
    description: 'Chat to current team channel',
    method: 'POST',
    path: '/action/team_chat',
    argSchema: [{ key: 'message', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ message: p.message }),
  }),
  g('team_status', 'social', ['ts'], { description: 'Current team membership + roster', method: 'POST', path: '/action/team_status', bodyFn: () => empty }),
  g('rally', 'social', [], {
    description: 'Move all team bots to current position',
    method: 'POST',
    path: '/action/rally',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        x: p.x,
        y: p.y,
        z: p.z,
        ...(p.message ? { message: p.message } : {}),
      }),
  }),
  g('report', 'social', [], {
    description: 'Submit a status report (event-based)',
    method: 'POST',
    path: '/action/report',
    argSchema: [{ key: 'message', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ message: p.message }),
  }),
  g('set_team', 'social', [], {
    description: 'Join named team channel',
    method: 'POST',
    path: '/action/set_team',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        team: p.team,
        role: p.role,
        ...(p.teammates?.length ? { teammates: p.teammates } : {}),
      }),
  }),

  g('sounds', 'observe', [], { description: 'Recent footstep / mob sounds', method: 'GET', path: '/sounds' }),
  g('stats', 'observe', [], { description: 'Bot session stats (uptime, errors, etc.)', method: 'GET', path: '/stats' }),
  g('fair_play', 'observe', [], {
    description: 'Toggle reaction-delay preamble (fair-play vs instant)',
    method: 'POST',
    path: '/action/set_fair_play',
    bodyFn: (p) =>
      JSON.stringify({
        enabled: !(p.enabled === 'off' || p.enabled === 'false' || p.enabled === '0'),
      }),
    argSchema: [{ key: 'enabled', type: 'string', default: 'true' }],
  }),

  g('connect', 'observe', ['reconnect'], { description: 'Reconnect bot to server', method: 'POST', path: '/connect', bodyFn: () => empty }),
  g('health', 'observe', ['h'], { description: 'HP/food/effects summary', method: 'GET', path: '/health' }),

  g('complete_command', 'social', ['done'], {
    description: 'Mark a queued command as complete',
    method: 'POST',
    path: '/action/complete_command',
    argSchema: [{ key: 'index', type: 'number', default: 0 }, { key: 'message', type: 'string' }],
    bodyFn: (p) => JSON.stringify({ index: Number(p.index ?? 0), ...(p.message ? { message: p.message } : {}) }),
  }),

  g('acknowledge_command', 'social', ['ack'], {
    description: 'Acknowledge receipt of a queued command',
    method: 'POST',
    path: '/action/acknowledge_command',
    argSchema: [{ key: 'index', type: 'number', default: 0 }, { key: 'plan', type: 'string' }],
    bodyFn: (p) => JSON.stringify({ index: Number(p.index ?? 0), ...(p.plan ? { plan: p.plan } : {}) }),
  }),

  g('cancel_command', 'social', ['reject'], {
    description: 'Cancel a pending queued command',
    method: 'POST',
    path: '/action/cancel_command',
    argSchema: [{ key: 'index', type: 'number', default: 0 }, { key: 'reason', type: 'string' }],
    bodyFn: (p) => JSON.stringify({ index: Number(p.index ?? 0), ...(p.reason ? { reason: p.reason } : {}) }),
  }),

  /** Any background task POST /task/ACTION + JSON — use \`mc bg collect '{"block":"oak_log"}'\`. */
  g('bg', 'task', ['bg_any'], {
    method: 'POST',
    path: '/task/__REPLACE__',
    customParse: true,
    description: `POST /task/ACTION — first arg action name; rest merged JSON.`,
    examples: [`mc bg collect '{"block":"oak_log","count":3}'`],
  }),

  /* Platform */
  g('commands', 'platform', [], { customParse: true, description: `Dump CLI registry metadata as JSON.` }),
  g('help', 'platform', [], { customParse: true, description: `Human-readable grouped help.` }),
  g(
    'batch',
    'platform',
    [],
    {
      description: 'Run multiple mc calls in one invocation',
      customParse: true,
      examples: [`mc batch status goals inventory`, `mc batch "nearby 32" observe`],
    },
  ),

  /** URL echo only — same as bash */
  g('dashboard', 'platform', ['dash'], {
    description: 'Open the bot dashboard URL',
    kind: 'http',
    customParse: true,
    method: 'GET',
    path: '/__noop__',
  }),

  /** Replaced bash helpers — composites implemented in dispatcher */
  g('anchors', 'observe', [], { description: 'Known anchor marks', customParse: true, category: 'observe', aliases: [], method: 'GET', path: '/__anchors__' }),

  // ── Reminders ──
  g('remind', 'task', [], {
    method: 'POST',
    path: '/action/remind',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
    description: 'Set a periodic reminder (surfaced in mc observe)',
    examples: ['mc remind "check wheat farm" 20', 'mc remind "restock food" 15 --mark wheat_farm'],
  }),
  g('reminders', 'task', ['list_reminders'], {
    method: 'POST',
    path: '/action/list_reminders',
    bodyFn: () => empty,
    description: 'List all active reminders',
    examples: ['mc reminders'],
  }),
  g('unremind', 'task', ['rm_remind'], {
    method: 'POST',
    path: '/action/unremind',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ id: p.id }),
    description: 'Remove a reminder by id',
    examples: ['mc unremind 1'],
  }),
];

export const CATEGORY_ORDER = CAT;

/**
 * Alias lookup keyed by lowercase command names and aliases.
 * @param {typeof RAW_COMMAND_DEFS} [defs]
 */
export function buildAliasMap(defs = RAW_COMMAND_DEFS) {
  /** @type {Record<string, { def: CmdDef, canonicalName: string }>} */
  const by = {};
  for (const d of defs) {
    const canonical = d.name;
    const names = new Set([canonical, ...(d.aliases || []).filter(Boolean)]);
    for (const n of names) {
      const k = String(n).toLowerCase();
      if (by[k]) throw new Error(`Duplicate CLI command alias: ${n}`);
      by[k] = { def: d, canonicalName: canonical };
    }
  }
  return by;
}

export function resolveCommand(raw, aliasMap = buildAliasMap()) {
  const k = String(raw || '').toLowerCase();
  return aliasMap[k] ?? null;
}
