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
  g('inventory', 'observe', ['inv', 'i'], { method: 'GET', path: '/inventory', examples: ['mc inventory'] }),
  g('nearby', 'observe', ['n'], {
    method: 'GET',
    pathFn: (p) => `/nearby?radius=${encodeURIComponent(Number(p.radius) || 32)}`,
    argSchema: [{ key: 'radius', type: 'number', default: 32 }],
    examples: ['mc nearby 48'],
  }),
  g('map', 'observe', ['m'], {
    method: 'GET',
    pathFn: (p) => `/map?radius=${encodeURIComponent(Number(p.radius) || 16)}`,
    argSchema: [{ key: 'radius', type: 'number', default: 16 }],
    examples: ['mc map 16'],
  }),
  g('look', 'observe', ['survey'], { method: 'GET', path: '/look', examples: ['mc look'] }),
  g('scene', 'observe', ['perceive', 'vision'], {
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
    method: 'POST',
    path: '/action/chat',
    argSchema: [{ key: 'message', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ message: p.message }),
    examples: ['mc chat Hello'],
  }),
  g('read_chat', 'social', ['messages', 'msg'], {
    method: 'GET',
    pathFn: (p) => `/chat?count=${encodeURIComponent(Number(p.count) || 20)}`,
    argSchema: [{ key: 'count', type: 'number', default: 20 }],
  }),
  g('overhear', 'social', ['overheard', 'eavesdrop'], {
    method: 'GET',
    pathFn: (p) => `/overhear?count=${encodeURIComponent(Number(p.count) || 20)}`,
    argSchema: [{ key: 'count', type: 'number', default: 20 }],
  }),
  g('social', 'social', [], { method: 'GET', path: '/social' }),

  /* Movement */
  g('goto', 'movement', ['go', 'g'], {
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
    method: 'POST',
    path: '/action/follow',
    argSchema: [{ key: 'player', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ player: p.player }),
  }),
  g('look_at', 'movement', [], {
    method: 'POST',
    path: '/action/look',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('stop', 'movement', [], { method: 'POST', path: '/action/stop', bodyFn: () => empty }),

  /* Mining / gather */
  g('collect', 'world', ['mine', 'c'], {
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
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.block ? { block: p.block } : {}),
        ...(p.count ? { count: Number(p.count) } : {}),
        ...(p.jump !== undefined && `${p.jump}`.trim() !== ''
          ? {
              jump: p.jump === true || `${p.jump}`.toLowerCase() === 'true' || `${p.jump}` === '1',
            }
          : {}),
      }),
    examples: [`mc pillar_step`, `mc pillar_step cobblestone 10`, `mc pillar_step dirt 20`],
  }),
  g('pickup', 'world', ['p'], { method: 'POST', path: '/action/pickup', bodyFn: () => empty }),
  g('find_blocks', 'world', ['find', 'fb'], {
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
    method: 'POST',
    path: '/action/recipes',
    argSchema: [{ key: 'item', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ item: p.item }),
  }),
  g('smelt', 'craft', ['sm'], {
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
    method: 'POST',
    path: '/action/attack',
    bodyFn: (p) => (p.target ? JSON.stringify({ target: p.target }) : empty),
    argSchema: [{ key: 'target', type: 'string', default: '' }],
  }),
  g('fight', 'combat', [], {
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

  /* eat / equip */
  g('eat', 'combat', ['e'], { method: 'POST', path: '/action/eat', bodyFn: () => empty }),
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
    method: 'POST',
    path: '/action/interact',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('close', 'world', [], { method: 'POST', path: '/action/close_screen', bodyFn: () => empty }),

  g('use', 'world', ['u'], { method: 'POST', path: '/action/use', bodyFn: () => empty }),
  g('toss', 'world', ['drop'], {
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
    method: 'POST',
    path: '/action/wait',
    argSchema: [{ key: 'seconds', type: 'number', default: 5 }],
    bodyFn: (p) => JSON.stringify({ seconds: Number(p.seconds ?? 5) }),
  }),

  /* chat_to / whisper */
  g('chat_to', 'social', [], {
    method: 'POST',
    path: '/action/chat_to',
    argSchema: [
      { key: 'player', type: 'string', required: true },
      { key: 'message', type: 'string', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ player: p.player, message: p.message }),
  }),
  g('whisper', 'social', ['dm', 'tell', 'private'], {
    method: 'POST',
    path: '/action/whisper',
    argSchema: [
      { key: 'player', type: 'string', required: true },
      { key: 'message', type: 'string', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ player: p.player, message: p.message }),
  }),

  /* death / respawn */
  g('deaths', 'observe', [], { method: 'GET', path: '/deaths' }),
  g('deathpoint', 'movement', [], { method: 'POST', path: '/action/deathpoint', bodyFn: () => empty }),
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

  /* marks */
  g('mark', 'memory', [], {
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
  g('marks', 'memory', [], { method: 'POST', path: '/action/marks', bodyFn: () => empty }),
  g('mark_update', 'memory', ['mark-up', 'mu'], {
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
    method: 'POST',
    path: '/action/go_mark',
    argSchema: [{ key: 'name', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ name: p.name }),
    usage: 'mc go_mark NAME',
  }),
  g('unmark', 'memory', [], {
    method: 'POST',
    path: '/action/unmark',
    argSchema: [{ key: 'name', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ name: p.name }),
  }),

  /* Goals */
  g('goals', 'goals', [], { method: 'GET', path: '/goals' }),
  g('goal_add', 'goals', [], {
    method: 'POST',
    path: '/goals',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ goal: p.goal }),
  }),
  g('goal_set', 'goals', [], {
    method: 'POST',
    path: '/goals/update',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
  }),
  g('goal_remove', 'goals', ['goal_rm'], { method: 'DELETE', pathFn: (p) => `/goals/${encodeURIComponent(String(p.id))}`, customParse: true }),
  g('goal_status', 'goals', ['gs'], {
    method: 'GET',
    pathFn: (p) => `/goals/${encodeURIComponent(String(p.id))}`,
    customParse: true,
  }),
  g('goal_presets', 'goals', [], { method: 'GET', path: '/goal-presets' }),
  g('goal_load', 'goals', ['load_goals'], {
    method: 'POST',
    path: '/goals/load-preset',
    argSchema: [{ key: 'preset', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ preset: p.preset }),
  }),

  /* task */
  g('task_start', 'task', ['tstart'], {
    method: 'POST',
    path: '/task/start',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
  }),
  g('task', 'task', ['task_status'], { method: 'GET', path: '/task', examples: [`mc task`] }),
  g('task_pause', 'task', [], { method: 'POST', path: '/task/pause', bodyFn: () => empty }),
  g('task_resume', 'task', [], {
    method: 'POST',
    path: '/task/resume',
    argSchema: [{ key: 'lease_seconds', type: 'number', default: 45 }],
    bodyFn: (p) => JSON.stringify({ lease_seconds: Number(p.lease_seconds ?? 45) }),
  }),
  g('task_history', 'task', ['tasks_done'], {
    method: 'GET',
    path: '/task/history',
  }),
  g('checkpoint', 'task', ['chk'], {
    method: 'GET',
    path: '/checkpoint',
  }),
  g('checkpoint_respond', 'task', ['cpr'], {
    method: 'POST',
    path: '/task/checkpoint-respond',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ decision: p.decision, lease_seconds: p.lease_seconds }),
  }),

  /* background */
  g('bg_collect', 'task', [], {
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
    method: 'POST',
    path: '/task/cancel',
    bodyFn: () => empty,
  }),

  /* advanced combat*/
  g('sneak', 'combat', [], {
    method: 'POST',
    path: '/action/sneak',
    bodyFn: (p) =>
      JSON.stringify({
        enable: !(p.enable === 'off' || p.enable === 'false' || p.enable === false || p.enable === '0'),
      }),
    argSchema: [{ key: 'enable', type: 'string', default: 'true' }],
  }),
  g('shield', 'combat', ['block'], {
    method: 'POST',
    path: '/action/shield_block',
    argSchema: [{ key: 'duration', type: 'number', default: 3 }],
    bodyFn: (p) => JSON.stringify({ duration: Number(p.duration ?? 3) }),
  }),
  g('shoot', 'combat', ['bow'], {
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
    method: 'POST',
    path: '/action/sprint_attack',
    bodyFn: (p) => (p.target ? JSON.stringify({ target: p.target }) : empty),
    argSchema: [{ key: 'target', type: 'string', default: '' }],
  }),
  g('crit', 'combat', ['critical'], {
    method: 'POST',
    path: '/action/critical_hit',
    bodyFn: (p) => (p.target ? JSON.stringify({ target: p.target }) : empty),
    argSchema: [{ key: 'target', type: 'string', default: '' }],
  }),
  g('strafe', 'combat', [], {
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
    method: 'POST',
    path: '/action/furnace_take',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('furnaces', 'observe', [], { method: 'GET', path: '/furnaces' }),

  /* team */
  g('team_chat', 'social', ['tc'], {
    method: 'POST',
    path: '/action/team_chat',
    argSchema: [{ key: 'message', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ message: p.message }),
  }),
  g('team_status', 'social', ['ts'], { method: 'POST', path: '/action/team_status', bodyFn: () => empty }),
  g('rally', 'social', [], {
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
    method: 'POST',
    path: '/action/report',
    argSchema: [{ key: 'message', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ message: p.message }),
  }),
  g('set_team', 'social', [], {
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

  g('sounds', 'observe', [], { method: 'GET', path: '/sounds' }),
  g('stats', 'observe', [], { method: 'GET', path: '/stats' }),
  g('fair_play', 'observe', [], {
    method: 'POST',
    path: '/action/set_fair_play',
    bodyFn: (p) =>
      JSON.stringify({
        enabled: !(p.enabled === 'off' || p.enabled === 'false' || p.enabled === '0'),
      }),
    argSchema: [{ key: 'enabled', type: 'string', default: 'true' }],
  }),

  g('connect', 'observe', ['reconnect'], { method: 'POST', path: '/connect', bodyFn: () => empty }),
  g('health', 'observe', ['h'], { method: 'GET', path: '/health' }),

  g('complete_command', 'social', ['done'], {
    method: 'POST',
    path: '/action/complete_command',
    argSchema: [{ key: 'index', type: 'number', default: 0 }, { key: 'message', type: 'string' }],
    bodyFn: (p) => JSON.stringify({ index: Number(p.index ?? 0), ...(p.message ? { message: p.message } : {}) }),
  }),

  g('acknowledge_command', 'social', ['ack'], {
    method: 'POST',
    path: '/action/acknowledge_command',
    argSchema: [{ key: 'index', type: 'number', default: 0 }, { key: 'plan', type: 'string' }],
    bodyFn: (p) => JSON.stringify({ index: Number(p.index ?? 0), ...(p.plan ? { plan: p.plan } : {}) }),
  }),

  g('cancel_command', 'social', ['reject'], {
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
      customParse: true,
      examples: [`mc batch status goals inventory`, `mc batch "nearby 32" observe`],
    },
  ),

  /** URL echo only — same as bash */
  g('dashboard', 'platform', ['dash'], {
    kind: 'http',
    customParse: true,
    method: 'GET',
    path: '/__noop__',
  }),

  /** Replaced bash helpers — composites implemented in dispatcher */
  g('anchors', 'observe', [], { customParse: true, category: 'observe', aliases: [], method: 'GET', path: '/__anchors__' }),

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
