/** @typedef {{ name:string, aliases?: string[], category:string, method:'GET'|'POST'|'DELETE', path?: string, pathFn?: (p:Record<string,unknown>) => string, bodyFn?: (p:Record<string,unknown>) => string | null | undefined, kind?: 'http', description?: string, usage?: string, examples?: string[], argSchema?: import('./args.mjs').ArgSpec[], customParse?: boolean }} CmdDef */

const CAT = [
  'platform',
  'perceive',
  'movement',
  'world',
  'building',
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
    'perceive',
    ['state', 's'],
    {
      method: 'GET',
      customParse: true,
      pathFn: (p) => (p.full ? '/status' : '/status?lean=true'),
      description: 'Self snapshot: position, HP, food, holding, supplies, nearby_entities, situation when stuck. World vision: mc scene / nearby / map. --full adds task_context, regions, chat hints.',
      examples: ['mc status', 'mc status --full', 'mc status --json'],
    },
  ),
  g('observe', 'perceive', ['snapshot'], {
    method: 'GET',
    // Default lean — trims full goal objects to {id, urgency, satisfied, gap},
    // last 5 recent_actions, drops plan_hints/dashboard_signals/action_stats.
    // ~80% smaller than full. Use `mc observe --full` for the verbose view.
    customParse: true,
    pathFn: (p) => (p.full ? '/observe' : '/observe?lean=true'),
    description: 'Goals + task + alerts snapshot (lean by default; --full for everything)',
    examples: ['mc observe', 'mc observe --full'],
  }),
  g('alerts', 'perceive', [], { method: 'GET', path: '/alerts', description: 'Typed alerts', examples: ['mc alerts'] }),
  g('discover', 'perceive', ['disc'], {
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
  g('craft_plan', 'craft', ['cp'], {
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
  g('logistics', 'perceive', ['log'], { method: 'GET', path: '/logistics', description: 'Logistics rollup', examples: ['mc logistics'] }),
  g('inventory', 'perceive', ['inv', 'i'], { description: 'List items in bot inventory', method: 'GET', path: '/inventory', examples: ['mc inventory'] }),
  g('nearby', 'perceive', ['n'], {
    description: 'List nearby blocks/entities within radius',
    method: 'GET',
    pathFn: (p) => `/nearby?radius=${encodeURIComponent(Number(p.radius) || 32)}`,
    argSchema: [{ key: 'radius', type: 'number', default: 32 , min: 1, max: 64}],
    examples: ['mc nearby 48'],
  }),
  g('map', 'perceive', ['m'], {
    description: 'Compact ASCII map of nearby terrain (radius default 12, max 16; larger values clamped).',
    method: 'GET',
    pathFn: (p) => `/map?radius=${encodeURIComponent(Number(p.radius) || 12)}`,
    argSchema: [{ key: 'radius', type: 'number', default: 12 , min: 1, max: 16}],
    examples: ['mc map', 'mc map 12'],
  }),
  g('look', 'perceive', ['survey'], { description: 'What the bot is currently facing', method: 'GET', path: '/look', examples: ['mc look'] }),
  g('scene', 'perceive', ['vision'], {
    description: 'Visible entities + landmarks in vision range. Lean by default (drops raw block-hit array). Use `mc scene --full` for ray-level detail.',
    method: 'GET',
    pathFn: (p) => {
      const range = encodeURIComponent(Number(p.range ?? p.radius) || 16);
      return p.full ? `/scene?range=${range}` : `/scene?range=${range}&lean=true`;
    },
    argSchema: [
      { key: 'range', type: 'number', default: 16 , min: 1, max: 32},
      { key: 'full', type: 'boolean', default: false },
    ],
    examples: ['mc scene 16', 'mc scene --full'],
  }),
  g('advise', 'perceive', [], {
    customParse: true,
    description:
      'Slow (~10–35s) intent-biased perception digest. Use when stuck, starting a new gather sub-goal, or locating something — not every tick. Requires --reason. Optional --target X,Y,Z attaches a route_preview (terrain probe along bot→target).',
    usage: 'mc advise --reason="find oak wood"',
    examples: [
      'mc advise --reason="find oak wood"',
      'mc advise --reason="blocked collecting wood"',
      'mc advise --reason="boat across the lake?" --target 1552,64,352',
      'mc advise --dry-run --reason="test"',
    ],
  }),
  g('screenshot_meta', 'perceive', ['ss_meta'], {
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
    examples: ["mc read_chat"],
    method: 'GET',
    pathFn: (p) => `/chat?count=${encodeURIComponent(Number(p.count) || 20)}`,
    argSchema: [{ key: 'count', type: 'number', default: 20 }],
  }),
  g('overhear', 'social', ['overheard', 'eavesdrop'], {
    description: 'Recent chat from other bots/players (filtered)',
    examples: ["mc overhear"],
    method: 'GET',
    pathFn: (p) => `/overhear?count=${encodeURIComponent(Number(p.count) || 20)}`,
    argSchema: [{ key: 'count', type: 'number', default: 20 }],
  }),
  g('social', 'social', [], {
    examples: ["mc social"],
 description: 'Social state: nearby players + interactions', method: 'GET', path: '/social' }),

  /* Movement */
  g('move', 'movement', ['mv'], {
    description: 'Smart non-destructive navigation to X Y Z. Like mc goto but if the path is blocked by a door/gate, automatically opens it (mc through, closes behind) and continues. Up to MAX_DOORS legs. Never digs. Refuses if pathfinder finds only a long detour (e.g., target is below you and the only route is back up via surface); pass --force to override. Use this instead of mc goto when navigating buildings.',
    method: 'POST',
    path: '/action/move',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.mark ? { mark: String(p.mark).replace(/^@/, '') } : {}),
        ...(p.x !== undefined ? { x: Number(p.x) } : {}),
        ...(p.y !== undefined ? { y: Number(p.y) } : {}),
        ...(p.z !== undefined ? { z: Number(p.z) } : {}),
        ...(p.near !== undefined ? { near: Number(p.near) } : {}),
        ...(p.raw ? { raw: true } : {}),
        ...(p.max_doors !== undefined ? { max_doors: Number(p.max_doors) } : {}),
        ...(p.door ? { door: p.door } : {}),
        ...(p.force ? { force: true } : {}),
      }),
    usage: 'mc move X Y Z | @mark | mark_name | :region:[/site] [--near N] [--raw] [--max-doors N] [--door GX GY GZ] [--force]',
    examples: [
      'mc move 100 64 -200',
      'mc move @base_anchor',
      'mc move 0 65 6 --max-doors 3',
      'mc move 0 65 6 --door 0 65 2',
      'mc move 50 30 -200 --force   # bypass detour check (long route accepted)',
      'mc move 100 64 -200 --raw    # raw pathfinder, no detour guard (water-refusal still applies)',
      'mc move :base1:              # region refs route through go_site (--raw is ignored here)',
    ],
  }),
  g('retrace', 'movement', [], {
    description:
      'Walk back along a recorded trail (reverse stand cells). Default: last mc stair_down trail. Pass --trail to prefer navigation breadcrumbs (falls back to stair_down when fewer than 2 crumbs).',
    method: 'POST',
    path: '/action/retrace',
    usage: 'mc retrace [--trail]',
    examples: ['mc retrace', 'mc retrace --trail', 'mc stair_down north 12', 'mc retrace'],
    argSchema: [
      {
        key: 'trail',
        type: 'boolean',
        default: false,
        description: 'walk nav-trail crumbs (use_trail); falls back to stair_down trail when thin',
      },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.trail === true || `${p.trail}`.toLowerCase() === 'true' || `${p.trail}` === '1'
          ? { use_trail: true }
          : {}),
      }),
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
    examples: ["mc goto_near X Y Z [RANGE]"],
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
    examples: ["mc follow"],
    method: 'POST',
    path: '/action/follow',
    argSchema: [{ key: 'player', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ player: p.player }),
  }),
  g('look_at', 'movement', [], {
    description: 'Turn the bot to face X Y Z',
    examples: ["mc look_at"],
    method: 'POST',
    path: '/action/look',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('stop', 'movement', [], {
    examples: ["mc stop"],
 description: 'Cancel current movement task', method: 'POST', path: '/action/stop', bodyFn: () => empty }),
  // F32 (task #66, v45): mc jump — brief jump primitive. Useful when
  // standing in 1-block water (surface to get head out), stepping onto
  // a 1-block ledge, or knocking a falling sand block. Default hold
  // 400ms; agent can override with --hold_ms for shorter/longer jumps.
  g('jump', 'movement', [], {
    description: 'Brief jump (default 400ms). Use to surface from shallow water or step up a 1-block ledge.',
    method: 'POST',
    path: '/action/jump',
    argSchema: [
      { key: 'hold_ms', type: 'number', required: false, default: 400 },
    ],
    bodyFn: (p) => JSON.stringify({ hold_ms: p.hold_ms }),
    examples: ['mc jump', 'mc jump 800'],
  }),

  /* Mining / gather */
  g('collect', 'world', ['mine', 'c'], {
    description: 'Find + mine N of a block type within radius',
    examples: ["mc collect BLOCK [COUNT]"],
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
    description: 'Break the block at X Y Z (single block, raw — no hazard checks). Refuses (SUPPORT_BLOCK) if a door or fence_gate sits directly above, or (STAIRCASE_EGRESS) if the block is a tread of your own mc stair_down staircase. Pass --force to override those guards AND to bypass the slow-dig refusal (bare-hand stone/cobble dig — slow but legal in MC, useful for trapped-bot escape when no pickaxe). Prefer mc safe_dig for general use.',
    method: 'POST',
    path: '/action/dig',
    customParse: true,
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.mark ? { mark: String(p.mark).replace(/^@/, '') } : {}),
        x: Number(p.x),
        y: Number(p.y),
        z: Number(p.z),
        ...(p.force ? { force: true } : {}),
      }),
    usage: 'mc dig X Y Z [--force]',
    examples: [
      'mc dig 0 64 5',
      'mc dig 0 64 5 --force',
    ],
  }),
  g('scout', 'perceive', [], {
    description: 'Hazard + (optional) target-block survey in a radius. Read-only. Always reports lava, water, falling-block columns, bedrock, and hostile mobs. When --block BLOCK is set, also counts exposed/buried/under-liquid candidates of that block, gives a centroid, and a verdict (mine_here|move_to|not_enough|unsafe). Use before mining at depth or to decide whether to relocate.',
    method: 'POST',
    path: '/action/scout',
    bodyFn: (p) =>
      JSON.stringify({
        ...(p.x !== undefined ? { x: Number(p.x) } : {}),
        ...(p.y !== undefined ? { y: Number(p.y) } : {}),
        ...(p.z !== undefined ? { z: Number(p.z) } : {}),
        ...(p.radius !== undefined ? { radius: Number(p.radius) } : {}),
        ...(p.block ? { block: String(p.block) } : {}),
      }),
    argSchema: [
      { key: 'x', type: 'number' },
      { key: 'y', type: 'number' },
      { key: 'z', type: 'number' },
      { key: 'radius', type: 'number', default: 8 , min: 1, max: 64},
      { key: 'block', type: 'string' },
    ],
    usage: 'mc scout [X Y Z] [RADIUS] [--block BLOCK]',
    examples: [
      'mc scout',
      'mc scout 0 -50 0 8',
      'mc scout --block coal_ore',
      'mc scout 100 64 100 12 --block dirt',
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
  g('pillar_up', 'world', ['pillar_step', 'tower', 'pillar'], {
    method: 'POST',
    path: '/action/pillar_step',
    description: 'Climb upward N blocks by jumping and placing a block underfoot each step (count = how many blocks to climb, max 64 — this is a multi-block climb, not a single step). Stops when it reaches a sky-open surface beside you. If genuinely trapped (4 walls + ceiling) it auto bare-hand digs the ceiling to keep going. With no pillar block in inventory it digs+captures the overhead block. Pass --force to also bare-hand slow-dig stone faster and to break protected/region blocks for the escape. Alias: pillar_step.',
    argSchema: [
      { key: 'block', type: 'string' },
      { key: 'count', type: 'number', description: 'blocks to climb (default 1, max 64)' , min: 1, max: 32},
      {
        key: 'jump',
        type: 'boolean',
        description: 'jump after placing (default true). Pass --no-jump or jump=false to disable.',
      },
      {
        key: 'force',
        type: 'boolean',
        description: 'bypass slow-dig refusal + region/global denylist + partial-block guard when genuinely stuck (default false)',
      },
    ],
    bodyFn: (p) => {
      // If the first positional looked like a number, the parser put it in
      // `block` ("5"). Re-route numeric `block` to `count` so users can write
      // `mc pillar_up 5` as a shorthand for `mc pillar_up cobblestone 5`.
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
        ...(p.force !== undefined && `${p.force}`.trim() !== ''
          ? {
              force: p.force === true || `${p.force}`.toLowerCase() === 'true' || `${p.force}` === '1',
            }
          : {}),
      });
    },
    examples: [
      `mc pillar_up 8`,
      `mc pillar_up cobblestone 10`,
      `mc pillar_up dirt 20`,
      `mc pillar_up 10 --force   # stuck underground: bare-hand dig through stone + pillar to surface`,
      `mc pillar_up   # single step (default count 1)`,
    ],
  }),
  g('pillar_down', 'world', ['descend', 'pillardown'], {
    method: 'POST',
    path: '/action/pillar_down',
    description: 'Descend a vertical pillar — mine the block directly underfoot, drop 1, repeat. Stops on bedrock, lava, or when surface is reached (multiple solid floor cells around the bot at the new level). Use when stuck on top of a 1×1 column you climbed with mc pillar_up.',
    argSchema: [
      { key: 'count', type: 'number', description: 'max blocks to descend (default 12, max 64)' , min: 1, max: 32},
      { key: 'pickup', type: 'boolean', description: 'pickup drops as you go (default true). Pass pickup=false to skip.' },
    ],
    bodyFn: (p) => JSON.stringify({
      ...(p.count !== undefined ? { count: Number(p.count) } : {}),
      ...(p.pickup !== undefined && `${p.pickup}`.trim() !== ''
        ? { pickup: p.pickup === true || `${p.pickup}`.toLowerCase() === 'true' || `${p.pickup}` === '1' }
        : {}),
    }),
    examples: [`mc pillar_down`, `mc pillar_down 8`, `mc pillar_down 20 pickup=false`],
  }),
  g('ladder', 'movement', [], {
    method: 'POST',
    path: '/action/ladder',
    description: 'Climb a ladder column the bot is already standing in. Direction "up" (default) climbs to top + exits forward; "down" descends to ground. Use --to to stop at a specific Y. Bot must already be on the ladder — pathfind there first with mc move.',
    argSchema: [
      { key: 'dir', type: 'string', description: 'up | down (default: up)' },
      { key: 'to', type: 'number', description: 'target Y (default: top/bottom of column)' },
      { key: 'exit', type: 'string', description: 'auto | none — auto-step off at top (default: auto for up)' },
      { key: 'timeout_ms', type: 'number', description: 'hard timeout (default 10000, max 60000)' },
    ],
    bodyFn: (p) => JSON.stringify({
      dir: p.dir ?? 'up',
      ...(p.to !== undefined ? { to: Number(p.to) } : {}),
      ...(p.exit !== undefined ? { exit: p.exit } : {}),
      ...(p.timeout_ms !== undefined ? { timeout_ms: Number(p.timeout_ms) } : {}),
    }),
    examples: [`mc ladder up`, `mc ladder down`, `mc ladder up to=72`, `mc ladder up exit=none to=70`],
  }),
  g('pickup', 'world', ['p'], {
    examples: ["mc pickup"],
 description: 'Walk to + collect a nearby item drop', method: 'POST', path: '/action/pickup', bodyFn: () => empty }),
  g('find_blocks', 'world', ['fb'], {
    description: 'Locate blocks of TYPE within radius (no mining)',
    examples: ["mc find_blocks BLOCK [RADIUS] [COUNT]"],
    method: 'POST',
    path: '/action/find_blocks',
    argSchema: [
      { key: 'block', type: 'string', required: true },
      { key: 'radius', type: 'number', default: 32 },
      { key: 'count', type: 'number', default: 10 , min: 1, max: 256},
    ],
    bodyFn: (p) => JSON.stringify({ block: p.block, radius: p.radius, count: p.count }),
    usage: 'mc find_blocks BLOCK [RADIUS] [COUNT]',
  }),
  g('find_entities', 'world', ['fe'], {
    description: 'Locate entities of TYPE within radius',
    examples: ["mc find_entities [TYPE] [RADIUS]"],
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
    examples: ["mc craft ITEM [COUNT]"],
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
    examples: ["mc recipes"],
    method: 'POST',
    path: '/action/recipes',
    argSchema: [{ key: 'item', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ item: p.item }),
  }),
  g('smelt', 'craft', ['sm'], {
    description: 'Smelt INPUT [COUNT] in nearby furnace (foreground)',
    examples: ["mc smelt INPUT [FUEL] [COUNT]   # synchronous; blocks ~12s per item"],
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
    examples: ["mc bg_smelt INPUT [FUEL] [COUNT]   # background; returns task_id, poll mc task"],
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
    examples: ["mc attack"],
    method: 'POST',
    path: '/action/attack',
    bodyFn: (p) => (p.target ? JSON.stringify({ target: p.target }) : empty),
    argSchema: [{ key: 'target', type: 'string', default: '' }],
  }),
  g('fight', 'combat', [], {
    description: 'Fight loop on TARGET until dead or HP threshold',
    examples: ["mc fight [TARGET] [RETREAT_HEALTH] [DURATION]"],
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
      { key: 'duration', type: 'number', default: 30 , min: 1, max: 600},
    ],
    usage: 'mc fight [TARGET] [RETREAT_HEALTH] [DURATION]',
  }),
  g('bg_fight', 'task', [], {
    description: 'Background fight loop',
    examples: ["mc bg_fight"],
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
      { key: 'duration', type: 'number', default: 30 , min: 1, max: 600},
    ],
  }),
  g('flee', 'combat', [], {
    examples: ["mc flee [DISTANCE] [--to MARK]"],

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
  g('eat', 'combat', ['e'], {
    examples: ["mc eat"],
 description: 'Eat the best food in inventory', method: 'POST', path: '/action/eat', bodyFn: () => empty }),
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
    examples: ["mc equip ITEM [SLOT]"],
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
    examples: ["mc place BLOCK X Y Z"],
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
    description: 'Fill an axis-aligned box with BLOCK. Synchronous: returns when the placement finishes (or partially fails). Max 32 cells per call — split larger areas into multiple calls. With overwrite=true, dig-then-fills any non-air cells in the box; default behavior only places in air (returns FILL_BLOCKED if cells are occupied).',
    method: 'POST',
    // Synchronous — was '/task/place_fill' (async, returned task_id and
    // chained calls hit "place_fill already running"). With the 32-cell
    // cap the call completes within typical CLI timeout windows.
    path: '/action/place_fill',
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
        ...(p.overwrite !== undefined ? { overwrite: p.overwrite === true || p.overwrite === 'true' || p.overwrite === '1' } : {}),
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
      { key: 'overwrite', type: 'boolean', default: false },
    ],
    usage: 'mc fill BLOCK X1 Y1 Z1 X2 Y2 Z2 [HOLLOW] [overwrite=true]',
    examples: [
      'mc fill cobblestone 360 64 -595 367 64 -595        # 8-cell row',
      'mc fill cobblestone 360 64 -595 367 64 -595 overwrite=true   # dig existing first',
    ],
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
      { key: 'w', type: 'number', required: true , min: 1, max: 64},
      { key: 'l', type: 'number', required: true , min: 1, max: 64},
      { key: 'd', type: 'number', required: true , min: 1, max: 16},
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

  g('level_ground', 'world', ['level-ground'], {
    description: 'Survey + flatten "lumpy" terrain to a single Y. Scans each column\'s top-solid, picks a target Y (median by default, --mode min|max alt), categorizes columns as hole/level/pillar, and reports a plan. Pass execute=true to do the work (delegates to mc level with up_range=max-pillar-height+1). Defaults to dry-run so you can review the plan before acting. Use to clean up scattered pillars + holes left by pillar_up churn or interrupted leveling sessions. Max 256 columns.',
    method: 'POST',
    path: '/action/level_ground',
    bodyFn: (p) =>
      JSON.stringify({
        x1: Number(p.x1),
        z1: Number(p.z1),
        x2: Number(p.x2),
        z2: Number(p.z2),
        ...(p.target !== undefined ? { target: Number(p.target) } : {}),
        ...(p.mode ? { mode: String(p.mode) } : {}),
        ...(p.block ? { block: String(p.block) } : {}),
        ...(p.execute !== undefined ? { execute: p.execute === true || p.execute === 'true' || p.execute === '1' } : {}),
      }),
    argSchema: [
      { key: 'x1', type: 'number', required: true },
      { key: 'z1', type: 'number', required: true },
      { key: 'x2', type: 'number', required: true },
      { key: 'z2', type: 'number', required: true },
      { key: 'target', type: 'number' },
      { key: 'mode', type: 'string' },
      { key: 'block', type: 'string' },
      { key: 'execute', type: 'string' },
    ],
    usage: 'mc level_ground X1 Z1 X2 Z2 [target=Y] [mode=median|min|max] [block=NAME] [execute=true]',
    examples: [
      'mc level_ground 360 -605 376 -589                     # dry-run, median Y',
      'mc level_ground 360 -605 376 -589 mode=min            # plan flatten-down (dig-only)',
      'mc level_ground 360 -605 376 -589 target=65 execute=true block=cobblestone',
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
      { key: 'length', type: 'number', required: true , min: 1, max: 64},
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
    description: 'Pass through a fence_gate, door, or trapdoor at GX GY GZ: opens it, walks to the far side, closes it behind. Destination defaults to 2 blocks past the gate on the opposite side from the bot. If the target is air (door missing/destroyed), returns NOT_A_DOOR with a hint to mc place a door from inventory. For just toggling without walking through, use mc interact X Y Z.',
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
      'Mine diggable blocks in an axis-aligned box (high Y first; optional stand-block nudge per layer). Max 32 blocks. Preserves your own mc stair_down staircase treads (skips them with a warning); pass --force to dig through (invalidates the retrace trail).',
    usage: 'mc dig_area X1 Y1 Z1 X2 Y2 Z2 [--force]',
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
      { key: 'force', type: 'boolean', default: false, description: 'dig through your own stair_down staircase treads (invalidates retrace trail)' },
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
        ...(p.force ? { force: true } : {}),
      }),
  }),
  g('tunnel', 'world', ['mine_tunnel'], {
    method: 'POST',
    path: '/action/tunnel',
    description:
      'Dig a straight tunnel using repeated dig_area slices (industrial corridor primitive). Preserves your own mc stair_down staircase treads (skips them with a warning) so you don\'t tunnel away your way back up; pass --force to dig through (invalidates the retrace trail).',
    usage: 'mc tunnel X Y Z DIR LENGTH [WIDTH] [HEIGHT] [--force]',
    examples: ['mc tunnel 367 53 -593 north 16 2 3', 'mc tunnel \'{"direction":"east","length":12}\''],
    argSchema: [
      { key: 'x', type: 'number', default: null },
      { key: 'y', type: 'number', default: null },
      { key: 'z', type: 'number', default: null },
      { key: 'direction', type: 'string', required: true },
      { key: 'length', type: 'number', default: 12 , min: 1, max: 128},
      { key: 'width', type: 'number', default: 2 , min: 1, max: 5},
      { key: 'height', type: 'number', default: 3 , min: 1, max: 5},
      { key: 'pickup', type: 'boolean', default: true },
      { key: 'force', type: 'boolean', default: false, description: 'tunnel through your own stair_down staircase treads (invalidates retrace trail)' },
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
        ...(p.force ? { force: true } : {}),
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
      { key: 'length', type: 'number', default: 12 , min: 1, max: 64},
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
  g('stair_up', 'world', ['stairs_up'], {
    method: 'POST',
    path: '/action/stair_up',
    description:
      'Dig an ascending staircase (one up per forward step). Places floor blocks over voids. Use to escape deep caves safely.',
    usage: 'mc stair_up DIR [LENGTH] [X Y Z] [WIDTH] [HEIGHT]',
    examples: ['mc stair_up north', 'mc stair_up north 20', 'mc stair_up east 30 350 -4 -567 1 3'],
    argSchema: [
      { key: 'direction', type: 'string', required: true },
      { key: 'length', type: 'number', default: 12 , min: 1, max: 64},
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
    description: 'Right-click the block at X Y Z. Toggle a door/trapdoor/fence_gate open or closed without walking through it (contrast: mc through actually traverses; mc use is for held items only).',
    examples: ["mc interact"],
    method: 'POST',
    path: '/action/interact',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('close', 'world', [], {
    examples: ["mc close"],
 description: 'Close currently-open container', method: 'POST', path: '/action/close_screen', bodyFn: () => empty }),

  g('edit_sign', 'world', ['sign_edit', 'write_sign'], {
    description: 'Write or edit sign text at X Y Z (front side by default). Uses Mineflayer bot.updateSign — works on newly-placed AND existing signs. 4 lines × 45 chars max. Pass multi-line text quoted with literal \\n separators.',
    method: 'POST',
    path: '/action/edit_sign',
    customParse: true,
    usage: 'mc edit_sign X Y Z "line1\\nline2\\nline3\\nline4" [--back]',
    examples: [
      'mc edit_sign 367 66 -593 ":base1:\\nintent=protect\\nsites=home,chest"',
      'mc edit_sign 367 66 -593 "Welcome to base" --back',
    ],
  }),

  g('use', 'world', ['u'], {
    examples: ["mc use"],
 description: 'Activate the HELD ITEM (eat food, shoot bow, place door wherever facing). Right-click in air. Does NOT target a block coord — for that use mc interact X Y Z, or mc through X Y Z to walk through a door.', method: 'POST', path: '/action/use', bodyFn: () => empty }),

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
    description: 'Harvest mature crops in axis-aligned rectangle (X1,Z1)-(X2,Z2) at Y. ARG ORDER: all 4 horizontal coords first, then optional Y at the END (never interleaved with X/Z). Y defaults to auto-detected from bot foot Y (probes foot-1/foot/foot+1, picks the row with most crops). Skips immature crops and reports them. Picks up drops.',
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

  g('verify_plot', 'world', ['farm_verify_plot'], {
    description: 'Verify construct plot: worksite coverage, terrain flatness, till readiness. Run before bulk till on kanban cards. Till is not region-guarded — failures here are spec/prep, not permission.',
    method: 'POST',
    path: '/action/verify_plot',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
    usage: 'mc verify_plot X1 Z1 X2 Z2 [--worksite ID] [--expect-y N] [--flat-max-delta N]',
    examples: [
      'mc verify_plot 365 -575 373 -567 --worksite wheat1 --expect-y 65',
    ],
  }),

  g('farm_status', 'world', ['plot_status', 'farm_scan'], {
    description: 'Plot status: counts per category (harvestable / planted_growing / tilled / empty_soil / unplantable / etc) + sample coords + next-action hint. Run once before deciding till/plant/harvest. With Y: probes that exact row; without Y: uses each column\'s topmost solid block.',
    method: 'POST',
    path: '/action/farm_status',
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
    usage: 'mc farm_status X1 Z1 X2 Z2 [Y]',
    examples: [
      'mc farm_status 355 -575 363 -567        # auto-Y per column',
      'mc farm_status 355 -575 363 -567 64     # probe Y=64 explicitly',
    ],
  }),

  g('till_area', 'world', ['till_rect'], {
    description: 'Till all columns in axis-aligned rectangle (max 81). Uses per-column surface Y unless optional Y hint is passed.',
    method: 'POST',
    path: '/action/till_area',
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
    usage: 'mc till_area X1 Z1 X2 Z2 [Y]',
    examples: ['mc till_area 365 -575 373 -567'],
  }),

  g('breed', 'world', [], {
    description: 'Feed 2 adult animals of SPECIES (chicken/cow/sheep/pig) to start breeding. Auto-picks a breeding item from inventory: wheat for cow/sheep, wheat_seeds for chicken (also pumpkin/melon/beetroot seeds), carrot/potato/beetroot for pig. Returns NO_FOOD, NO_PAIR, ANIMAL_ON_COOLDOWN.',
    method: 'POST',
    path: '/action/breed',
    argSchema: [{ key: 'species', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ species: String(p.species) }),
    usage: 'mc breed SPECIES',
    examples: ['mc breed chicken', 'mc breed cow', 'mc breed sheep'],
  }),

  g('shear', 'world', [], {
    description: 'Shear the nearest unsheared sheep within 8 blocks. Auto-equips shears, picks up wool drops. Returns NO_SHEARS, NO_SHEEP, SHEEP_ALREADY_SHEARED.',
    method: 'POST',
    path: '/action/shear',
    bodyFn: () => '{}',
    usage: 'mc shear',
    examples: ['mc shear'],
  }),

  g('milk_cow', 'world', ['milk'], {
    description: 'Fill an empty bucket with milk from the nearest cow within 8 blocks. Bot must have minecraft:bucket in inventory. Returns NO_BUCKET, NO_COW.',
    method: 'POST',
    path: '/action/milk_cow',
    bodyFn: () => '{}',
    usage: 'mc milk_cow',
    examples: ['mc milk_cow'],
  }),

  g('hunt', 'world', [], {
    description: 'Kill COUNT (default 1) nearest animals of SPECIES (chicken/cow/sheep/pig/rabbit). Auto-equips best weapon, runs pickup pass after. Returns NOTHING_TO_HUNT, UNSUPPORTED_SPECIES.',
    method: 'POST',
    path: '/action/hunt',
    argSchema: [
      { key: 'species', type: 'string', required: true },
      { key: 'count', type: 'number', default: 1 , min: 1, max: 64},
    ],
    bodyFn: (p) => JSON.stringify({ species: String(p.species), count: Number(p.count) || 1 }),
    usage: 'mc hunt SPECIES [COUNT]',
    examples: ['mc hunt chicken 3', 'mc hunt cow'],
  }),

  g('lure', 'world', [], {
    description: 'Walk to X Y Z holding the breeding item for SPECIES; vanilla AI makes nearby animals follow. Reports follower distance at arrival. Useful for returning escaped animals to a pen. Returns NO_FOOD, NO_ANIMAL.',
    method: 'POST',
    path: '/action/lure',
    argSchema: [
      { key: 'species', type: 'string', required: true },
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ species: String(p.species), x: Number(p.x), y: Number(p.y), z: Number(p.z) }),
    usage: 'mc lure SPECIES X Y Z',
    examples: ['mc lure chicken 5 65 5', 'mc lure cow 0 64 0'],
  }),

  g('fish', 'world', [], {
    description: 'Cast a fishing_rod into nearby water, wait for a bite (5-30s vanilla), reel in, and pick up the drop. Optional timeout_seconds (default 60). Returns NO_ROD, NO_WATER, FISH_TIMEOUT.',
    method: 'POST',
    path: '/action/fish',
    argSchema: [{ key: 'timeout_seconds', type: 'number', default: 60 , min: 1, max: 300}],
    bodyFn: (p) => JSON.stringify({ timeout_seconds: Number(p.timeout_seconds) || 60 }),
    usage: 'mc fish [TIMEOUT_SECONDS]',
    examples: ['mc fish', 'mc fish 90'],
  }),

  g('place_boat', 'world', [], {
    description: 'Place a boat (any *_boat in inventory) at water cell X Y Z. The target block must be water. Boats float on water surface; vanilla allows ridden mobs to be carried. Returns NO_BOAT, NO_WATER_AT_TARGET.',
    method: 'POST',
    path: '/action/place_boat',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }),
    usage: 'mc place_boat X Y Z',
    examples: ['mc place_boat 5 63 5'],
  }),

  g('board', 'world', ['mount'], {
    description: 'Mount the nearest boat within 6 blocks. Bot becomes the rider; movement verbs steer the boat. Returns NO_BOAT, ALREADY_MOUNTED, OUT_OF_RANGE.',
    method: 'POST',
    path: '/action/board',
    bodyFn: () => '{}',
    usage: 'mc board',
    examples: ['mc board'],
  }),

  g('disembark', 'world', ['dismount'], {
    description: 'Exit the current vehicle (boat). Returns NOT_MOUNTED if the bot isn\'t in a vehicle.',
    method: 'POST',
    path: '/action/disembark',
    bodyFn: () => '{}',
    usage: 'mc disembark',
    examples: ['mc disembark'],
  }),

  g('sail', 'world', [], {
    description: 'Sail the boat the bot is currently riding to X Y Z. Uses rider forward + look to steer; auto-stops within 2 blocks of target. Returns NOT_MOUNTED if not in a boat, OUT_OF_RANGE if the boat gets stuck/dismounted, TIMEOUT if not reached.',
    method: 'POST',
    path: '/action/sail',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
      { key: 'timeout_seconds', type: 'number', default: 60 },
    ],
    bodyFn: (p) => JSON.stringify({
      x: Number(p.x), y: Number(p.y), z: Number(p.z),
      ...(p.timeout_seconds !== undefined ? { timeout_seconds: Number(p.timeout_seconds) } : {}),
    }),
    usage: 'mc sail X Y Z [TIMEOUT_SECONDS]',
    examples: ['mc sail 0 64 20', 'mc sail -50 64 0 120'],
  }),

  g('sail_to', 'world', [], {
    description: 'Ferry service: plan + execute a full water journey to X Y Z in one call. Validates the water route (BFS), walks to entry shore, places a boat, sails, disembarks, walks the final land leg. Re-callable to resume from current position if interrupted. Returns NO_BOAT if no boat in inventory, NO_NAVIGABLE_ROUTE if the water doesn\'t reach the target, SAIL_FAILED / MOUNT_FAILED / etc. for phase-level failures.',
    method: 'POST',
    path: '/action/sail_to',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({
      x: Number(p.x), y: Number(p.y), z: Number(p.z),
    }),
    usage: 'mc sail_to X Y Z',
    examples: ['mc sail_to -300 63 -100', 'mc sail_to 1000 63 -800'],
  }),

  g('toss', 'world', ['drop'], {
    description: 'Drop ITEM [COUNT] from inventory',
    examples: ["mc toss ITEM [COUNT]"],
    method: 'POST',
    path: '/action/toss',
    bodyFn: (p) =>
      JSON.stringify({
        item: p.item ?? p.name,
        ...(p.count !== undefined ? { count: Number(p.count) } : {}),
      }),
    argSchema: [
      { key: 'item', type: 'string', required: true },
      { key: 'count', type: 'number', default: null , min: 1, max: 64},
    ],
    usage: 'mc toss ITEM [COUNT]',
  }),

  g('sleep', 'world', ['bed'], {
    method: 'POST',
    path: '/action/sleep_bed',
    bodyFn: () => empty,
    description: 'Find a nearby bed (up to 32 blocks), navigate to it, and sleep. Sets your spawn point.',
    examples: ["mc sleep"],
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
    description: 'Pause up to N seconds. Returns early when a chat message @-mentions you or arrives as direct/whisper. Pass --no-interrupt to disable chat-interrupt and wait the full duration regardless.',
    method: 'POST',
    path: '/action/wait',
    customParse: true,
    argSchema: [{ key: 'seconds', type: 'number', default: 5 , min: 0.1, max: 300}],
    bodyFn: (p) => JSON.stringify({
      seconds: Number(p.seconds ?? 5),
      ...(p['no-interrupt'] || p.no_interrupt ? { interrupt: false } : {}),
    }),
    usage: 'mc wait [SECONDS] [--no-interrupt]',
    examples: ['mc wait 10', 'mc wait 30 --no-interrupt'],
  }),
  g('is_sheltered', 'world', ['shelter_check', 'sealed'], {
    description: 'Pathfinder enclosure test — can the bot walk OUT of here? Mob pathfinding is symmetric, so if YES then mobs can walk IN. Pass walls=X1,Y1,Z1,X2,Y2,Z2 to also verify every perimeter cell of that box is filled (catches the "I forgot a wall block" failure).',
    method: 'POST',
    path: '/action/is_sheltered',
    customParse: true,
    argSchema: [{ key: 'radius', type: 'number', default: 20 , min: 1, max: 32}],
    bodyFn: (p) => {
      const out = { radius: Number(p.radius ?? 20) };
      if (p.walls && typeof p.walls === 'string') {
        const parts = p.walls.split(',').map((s) => Number(String(s).trim()));
        if (parts.length === 6 && parts.every(Number.isFinite)) {
          out.walls = { x1: parts[0], y1: parts[1], z1: parts[2], x2: parts[3], y2: parts[4], z2: parts[5] };
        }
      } else if (p.walls && typeof p.walls === 'object') {
        out.walls = p.walls;
      }
      return JSON.stringify(out);
    },
    examples: ['mc is_sheltered', 'mc is_sheltered radius=30', 'mc is_sheltered walls=-2,66,9,1,68,12'],
  }),
  g('inspect', 'world', ['block_at', 'cell_info'], {
    description: 'Inspect a single cell — block name, is_diggable, is_relocatable, suggested_tool, and entities standing in that cell. Use to plan place/dig without trial-and-error.',
    method: 'POST',
    path: '/action/inspect',
    argSchema: [
      { key: 'x', type: 'number', required: true, positional: true },
      { key: 'y', type: 'number', required: true, positional: true },
      { key: 'z', type: 'number', required: true, positional: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }),
    examples: ['mc inspect 10 64 -3'],
  }),
  g('reachable', 'world', ['standable', 'can_stand'], {
    description: 'Reachability pre-flight: can the bot STAND at (x,y,z)? Returns {target_standable, target_reason (ok|head_blocked|foot_blocked|no_foot_support), best_stand: {x,y,z,distance}}. If target_standable is false, use best_stand for your actual goto. Geometry-only — does not verify a path exists from your current position.',
    method: 'POST',
    path: '/action/reachable',
    argSchema: [
      { key: 'x', type: 'number', required: true, positional: true },
      { key: 'y', type: 'number', required: true, positional: true },
      { key: 'z', type: 'number', required: true, positional: true },
      { key: 'range', type: 'number', default: 3 , min: 1, max: 32},
    ],
    bodyFn: (p) => JSON.stringify({
      x: Number(p.x), y: Number(p.y), z: Number(p.z),
      range: Number(p.range ?? 3),
    }),
    examples: ['mc reachable 0 65 12', 'mc reachable 0 65 12 range=4'],
  }),
  g('standing', 'world', ['stand_state', 'where_am_i'], {
    description: 'Classify your current standing state. Returns {classification, blocked_dirs, open_dirs, cliff_dirs, step_down_dirs, head_blocked, foot_support, ceiling_within, wedge_offset, neighbor_status}. classification ∈ {open, alley, corner, trapped, three_walled, enclosure_inside, wedge, edge, on_pillar, in_air}. Use this BEFORE issuing a move/place/goto that might fail — if you are in a corner or trapped, sidestep to an open_dir first, or run `mc escape`. step_down_dirs are safe 1–3 block drops; treat them as walkable.',
    method: 'POST',
    path: '/action/standing',
    bodyFn: () => '{}',
    examples: ['mc standing'],
  }),
  g('escape', 'world', ['unstuck', 'free_me'], {
    description: 'Get unstuck. Reads your standing state and picks the right recovery: sidestep for corner/wedge/edge/three_walled; pillar up with cobble/dirt for trapped; wait for in_air. Returns {action_taken, from, to, classification_before, classification_after, success}. If trapped with ceiling, you need to mc dig first. If inside an enclosure, mc dig a wall.',
    method: 'POST',
    path: '/action/escape',
    bodyFn: () => '{}',
    examples: ['mc escape'],
  }),
  g('find', 'world', ['locate', 'where_is'], {
    description: 'Find a resource across inventory, known chests, and nearby blocks. Returns ranked sources (inventory first, then chests by distance, then visible blocks by distance). USE THIS BEFORE MINING — if cobblestone is in your inventory or a chest you already know about, don\'t go mine more. Returns {resource, total_available, sources: [{source, count, pos, distance, mark?}]}.',
    method: 'POST',
    path: '/action/find',
    argSchema: [
      { key: 'resource', type: 'string', required: true, positional: true },
      { key: 'scan_range', type: 'number', default: 32 , min: 1, max: 64},
      { key: 'max_results', type: 'number', default: 12 },
    ],
    bodyFn: (p) => JSON.stringify({
      resource: String(p.resource || ''),
      scan_range: Number(p.scan_range ?? 32),
      max_results: Number(p.max_results ?? 12),
    }),
    examples: ['mc find cobblestone', 'mc find oak_log scan_range=48', 'mc find iron_ingot'],
  }),
  g('is_empty', 'world', ['region_empty'], {
    description: 'Region predicate — is every cell in [x1..x2, y1..y2, z1..z2] air? Returns up to 32 non-empty cells. Capped at 1000 cells.',
    method: 'POST',
    path: '/action/is_empty',
    argSchema: [
      { key: 'x1', type: 'number', required: true, positional: true },
      { key: 'y1', type: 'number', required: true, positional: true },
      { key: 'z1', type: 'number', required: true, positional: true },
      { key: 'x2', type: 'number', required: true, positional: true },
      { key: 'y2', type: 'number', required: true, positional: true },
      { key: 'z2', type: 'number', required: true, positional: true },
    ],
    bodyFn: (p) => JSON.stringify({
      x1: Number(p.x1), y1: Number(p.y1), z1: Number(p.z1),
      x2: Number(p.x2), y2: Number(p.y2), z2: Number(p.z2),
    }),
    examples: ['mc is_empty 0 64 0 5 67 5'],
  }),
  g('is_filled', 'world', ['region_filled', 'is_built'], {
    description: 'Region predicate — is every cell in [x1..x2, y1..y2, z1..z2] filled with MATERIAL? Returns up to 32 mismatching cells. Capped at 1000 cells.',
    method: 'POST',
    path: '/action/is_filled',
    argSchema: [
      { key: 'x1', type: 'number', required: true, positional: true },
      { key: 'y1', type: 'number', required: true, positional: true },
      { key: 'z1', type: 'number', required: true, positional: true },
      { key: 'x2', type: 'number', required: true, positional: true },
      { key: 'y2', type: 'number', required: true, positional: true },
      { key: 'z2', type: 'number', required: true, positional: true },
      { key: 'material', type: 'string', required: true },
    ],
    bodyFn: (p) => JSON.stringify({
      x1: Number(p.x1), y1: Number(p.y1), z1: Number(p.z1),
      x2: Number(p.x2), y2: Number(p.y2), z2: Number(p.z2),
      material: String(p.material),
    }),
    examples: ['mc is_filled 0 64 0 3 64 3 material=cobblestone'],
  }),

  /* chat_to / whisper */
  g('chat_to', 'social', [], {
    description: 'Address PLAYER in public chat — equivalent to `mc chat "@PLAYER MSG"`. Visible to everyone; triggers wait-interrupt on the recipient (F55.5).',
    examples: ["mc chat_to"],
    method: 'POST',
    path: '/action/chat_to',
    argSchema: [
      { key: 'player', type: 'string', required: true },
      { key: 'message', type: 'string', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ player: p.player, message: p.message }),
  }),
  g('whisper', 'social', ['dm', 'tell', 'private'], {
    description: 'Address PLAYER in public chat — same as mc chat_to. Aliases retained for ergonomics, but no longer private (private /msg did not reliably reach partner bots; F55.6).',
    examples: ["mc whisper"],
    method: 'POST',
    path: '/action/whisper',
    argSchema: [
      { key: 'player', type: 'string', required: true },
      { key: 'message', type: 'string', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ player: p.player, message: p.message }),
  }),

  /* death / respawn */
  g('deaths', 'perceive', [], {
    examples: ["mc deaths"],
 description: 'Recent death events', method: 'GET', path: '/deaths' }),
  g('deathpoint', 'movement', [], {
    examples: ["mc deathpoint"],
 description: 'Walk to most recent death location', method: 'POST', path: '/action/deathpoint', bodyFn: () => empty }),
  g('respawn', 'world', [], {
    method: 'POST',
    path: '/action/respawn',
    description: 'LAST RESORT — kills the bot via /kill and respawns at spawn point. DESTROYS ALL INVENTORY at the death location. Do NOT use this to travel home; use `mc go_mark home` or `mc goto` instead. Refused while alive with HP > 6 unless force=yes is also passed — at full HP this is almost always a misuse. Reserved for hopelessly stuck cases with no other escape (deep cave-in, void edge, drowning loop with no placeable blocks).',
    usage: 'mc respawn yes [force=yes]',
    examples: ['mc respawn yes', 'mc respawn yes force=yes  # only when alive+healthy and TRULY stuck'],
    argSchema: [
      { key: 'confirm', type: 'string', required: true, description: 'Must be "yes" to confirm; this DROPS ALL ITEMS.' },
      { key: 'force', type: 'string', required: false, description: 'Pass "yes" to override the HP>6 safety guard when alive.' },
    ],
    bodyFn: (p) => JSON.stringify({ confirm: p.confirm, ...(p.force ? { force: p.force } : {}) }),
  }),

  /* chest */
  g('chest', 'world', ['list_container'], {
    description: 'Open + list a chest at X Y Z or @MARK',
    examples: ["mc chest X Y Z  OR  mc chest @MARK"],
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
      { key: 'count', type: 'number', default: 0 , min: 1, max: 64},
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
      { key: 'count', type: 'number', default: 0 , min: 1, max: 64},
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
      { key: 'max_results', type: 'number', default: 10 , min: 1, max: 50},
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
    examples: ["mc mark NAME [NOTE]"],
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
  g('marks', 'memory', [], {
    examples: ["mc marks"],
 description: 'List all marks', method: 'POST', path: '/action/marks', bodyFn: () => empty }),
  g('regions', 'memory', [], {
    description: 'List designated regions (optional --at x y z preview)',
    examples: ["mc regions"],
    method: 'GET',
    pathFn: (p) => (p.at ? `/regions?at=${encodeURIComponent(String(p.at))}` : '/regions'),
    customParse: true,
  }),
  g('regions_terrain', 'memory', ['regions-terrain'], {
    description: 'Per-column top solid survey for a region disc or --rect x1 z1 x2 z2. Use when authoring construct cards with fixed Y.',
    method: 'POST',
    path: '/action/regions_terrain',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
    usage: 'mc regions_terrain REGION_ID [--expect-y N] | mc regions_terrain --rect X1 Z1 X2 Z2 [--expect-y N]',
    examples: [
      'mc regions_terrain wheat1 --expect-y 65',
      'mc regions_terrain --rect 365 -575 373 -567 --expect-y 65',
    ],
  }),
  g('region_create', 'memory', ['region-create'], {
    description: 'Create unanchored region at bot position. PROFILE preset implies a default intent: base/farm/dock=protect (no ad-hoc dig/place), mine=resource (allow harvest). Override the default with --intent. Use --intent marker for a build-anchor that allows workers to dig+place inside.',
    usage: 'mc region_create <ID> <PROFILE> [--r N] [--y MIN..MAX] [--intent protect|resource|marker] [--shape column|sphere]',
    examples: [
      'mc region_create :base1: base --r 18 --y 58..120                          # implicit intent=protect (base default)',
      'mc region_create :hut3: base --r 5 --y 64..72 --intent marker             # marker = anchor only, no protection',
      'mc region_create :mine2: mine --r 8 --y 12..40 --intent resource --shape column',
    ],
    method: 'POST',
    path: '/action/region_create',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ id: p.id, profile: p.profile, r: p.r, y: p.y, intent: p.intent, shape: p.shape }),
  }),
  g('region_update_intent', 'memory', ['region-update-intent'], {
    description: 'Switch an existing region\'s intent in-place (protect↔resource↔marker). Preserves anchor, sites, shape, profile. Useful when you realized after region_create that the default intent blocks the work you need to do inside.',
    usage: 'mc region_update_intent <ID> <protect|resource|marker>',
    examples: [
      'mc region_update_intent :hut3: marker         # let the builder dig+place inside their own anchor region',
      'mc region_update_intent :hut3: protect        # re-protect once construction finishes',
    ],
    method: 'POST',
    path: '/action/region_update_intent',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ id: p.id, intent: p.intent }),
  }),
  g('regions_reload', 'memory', ['regions-reload', 'region-reload'], {
    description: 'Re-read regions JSON from disk and re-apply profile normalization. Use this after editing data/regions-world.json so live bots pick up the change without a restart. Returns the new region count + per-region (id, intent, profile, capabilities).',
    usage: 'mc regions_reload',
    examples: [
      'mc regions_reload                          # apply file edits to the in-memory cache',
    ],
    method: 'POST',
    path: '/regions/reload',
    bodyFn: () => '{}',
  }),
  g('region_remove', 'memory', ['region-remove'], {
    description: 'Remove region (requires --confirm). Usage: mc region_remove :base1: --confirm',
    usage: 'mc region_remove <ID> [--confirm]',
    examples: [
      'mc region_remove :base1: --confirm',
    ],
    method: 'POST',
    path: '/action/region_remove',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ id: p.id, confirm: p.confirm }),
  }),
  g('site_add', 'memory', ['site-add'], {
    description: 'Add named site to region. Usage: mc site_add :region:/sitename X Y Z',
    usage: 'mc site_add :region:/sitename X Y Z',
    examples: [
      'mc site_add :base1:/chest 365 65 -593',
    ],
    method: 'POST',
    path: '/action/site_add',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ ref: p.ref, x: p.x, y: p.y, z: p.z }),
  }),
  g('site_remove', 'memory', ['site-remove'], {
    description: 'Remove site from region',
    examples: ["mc site_remove"],
    method: 'POST',
    path: '/action/site_remove',
    customParse: true,
  }),
  g('check', 'building', [], {
    description: 'Dry-run region policy for dig/place',
    examples: ["mc check"],
    method: 'POST',
    path: '/action/check',
    customParse: true,
  }),
  g('blueprint', 'building', [], {
    description: 'Blueprint library: show, cell, layer, materials, verify, adopt, capture',
    usage:
      'mc blueprint show|cell|layer|materials|verify|adopt|capture <target> [flags]',
    examples: [
      'mc blueprint show :hut3:',
      'mc blueprint verify dystopian-hut-3 --level 5',
      'mc blueprint cell :hut3: --at 370 65 -608',
      'mc blueprint adopt :hut3: --at 370 65 -608 --note "approved chest"',
    ],
    method: 'POST',
    path: '/action/blueprint',
    customParse: true,
  }),
  g('construct', 'building', [], {
    description: 'Guided construct from region blueprint (Phase 2c)',
    examples: ["mc construct"],
    method: 'POST',
    path: '/action/construct',
    customParse: true,
  }),
  g('repair', 'building', [], {
    description: 'Repair region to blueprint or edit-log target',
    examples: ["mc repair"],
    method: 'POST',
    path: '/action/repair',
    customParse: true,
  }),
  g('task_context', 'task', ['task-context'], {
    description: 'Bind kanban card worksite grant for protect-region construction (set/clear/show)',
    usage: 'mc task_context set <worksite> [--card ID] [--expires-min N] | clear | show',
    examples: [
      'mc task_context set hut3                    # uses HERMES_KANBAN_TASK for card_id',
      'mc task_context set hut3 --card t_abc123 --expires-min 45',
      'mc task_context show',
      'mc task_context clear',
    ],
    customParse: true,
    path: '/task-context',
    bodyFn: (p) =>
      JSON.stringify({
        card_id: p.card_id,
        worksite_region: p.worksite_region,
        expires_at_ms: p.expires_at_ms,
        source: 'cli',
      }),
  }),
  g('playbook_phase_set', 'task', ['playbook-phase-set'], {
    description: 'Bind playbook_id + phase on server ctx.runtime for JSONL telemetry (requires task_context card)',
    usage: 'mc playbook phase set <playbook_id> <phase> [--sub-playbook ID] [--sub-phase NAME]',
    examples: [
      'mc playbook phase set wood.chop_tall_tree preflight',
      'mc playbook phase set wood.chop_tall_tree chop_loop',
    ],
    method: 'POST',
    path: '/action/playbook_phase_set',
    customParse: true,
    bodyFn: (p) =>
      JSON.stringify({
        playbook_id: p.playbook_id,
        phase: p.phase,
        ...(p.sub_playbook_id ? { sub_playbook_id: p.sub_playbook_id } : {}),
        ...(p.sub_phase ? { sub_phase: p.sub_phase } : {}),
      }),
  }),
  g('playbook_phase_clear', 'task', ['playbook-phase-clear'], {
    description: 'Clear playbook phase context after card complete/block',
    usage: 'mc playbook phase clear',
    examples: ['mc playbook phase clear'],
    method: 'POST',
    path: '/action/playbook_phase_clear',
    customParse: true,
    bodyFn: () => JSON.stringify({}),
  }),
  g('playbook', 'task', [], {
    description: 'Alias: mc playbook phase set|clear …',
    customParse: true,
    method: 'POST',
    path: '/action/playbook_phase_set',
    examples: ['mc playbook phase set wood.chop_tall_tree preflight', 'mc playbook phase clear'],
    bodyFn: (p) =>
      JSON.stringify({
        playbook_id: p.playbook_id,
        phase: p.phase,
        ...(p.sub_playbook_id ? { sub_playbook_id: p.sub_playbook_id } : {}),
        ...(p.sub_phase ? { sub_phase: p.sub_phase } : {}),
      }),
  }),
  g('mark_update', 'memory', ['mark-up', 'mu'], {
    description: 'Move existing MARK to current position',
    examples: ["mc mark_update"],
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
    examples: ["mc go_mark NAME"],
    method: 'POST',
    path: '/action/go_mark',
    argSchema: [{ key: 'name', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ name: p.name }),
    usage: 'mc go_mark NAME',
  }),
  g('reach', 'movement', [], {
    description: 'Short-hop router: move → goto → goto_near for playbook act rows',
    usage: 'mc reach X Y Z | mc reach @mark',
    examples: ['mc reach 100 64 200', 'mc reach @base_chest'],
    method: 'POST',
    path: '/action/reach',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
  }),
  g('go_site', 'memory', [], {
    description: 'Walk to a region anchor (:base1:) or named site (:base1:/tower). mc goto accepts the same ref syntax.',
    method: 'POST',
    path: '/action/go_site',
    argSchema: [{ key: 'ref', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ ref: p.ref }),
    usage: 'mc go_site :base1:/tower',
    examples: ['mc go_site :base1:', 'mc goto :base1:/gate'],
  }),
  g('unmark', 'memory', [], {
    description: 'Delete a mark by name',
    examples: ["mc unmark"],
    method: 'POST',
    path: '/action/unmark',
    argSchema: [{ key: 'name', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ name: p.name }),
  }),

  /* Goals */
  g('goals', 'goals', [], {
    examples: ["mc goals"],
 description: 'List active goals with urgency', method: 'GET', path: '/goals' }),
  g('goal_add', 'goals', [], {
    description: 'Add a new goal (id + metric + thresholds)',
    examples: ["mc goal_add"],
    method: 'POST',
    path: '/goals',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ goal: p.goal }),
  }),
  g('goal_set', 'goals', [], {
    description: 'Set goal field (priority, target, etc.)',
    examples: ["mc goal_set"],
    method: 'POST',
    path: '/goals/update',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
  }),
  g('goal_remove', 'goals', ['goal_rm'], {
    examples: ["mc goal_remove"],
 description: 'Remove goal by id', method: 'DELETE', pathFn: (p) => `/goals/${encodeURIComponent(String(p.id))}`, customParse: true }),
  g('goal_status', 'goals', ['gs'], {
    description: 'Detail status of a single goal',
    examples: ["mc goal_status"],
    method: 'GET',
    pathFn: (p) => `/goals/${encodeURIComponent(String(p.id))}`,
    customParse: true,
  }),
  g('goal_presets', 'goals', [], {
    examples: ["mc goal_presets"],
 description: 'List built-in goal presets', method: 'GET', path: '/goal-presets' }),
  g('goal_load', 'goals', ['load_goals'], {
    description: 'Load a goal preset (miner/builder/etc.)',
    examples: ["mc goal_load"],
    method: 'POST',
    path: '/goals/load-preset',
    argSchema: [{ key: 'preset', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ preset: p.preset }),
  }),

  /* task */
  g('task_start', 'task', ['tstart'], {
    description: 'Start named background task with args',
    examples: ["mc task_start"],
    method: 'POST',
    path: '/task/start',
    customParse: true,
    bodyFn: (p) => JSON.stringify(p),
  }),
  g('task', 'task', ['task_status'], {
    description: 'Activity status. Returns {task, sync, last}: task=async bg task if any, sync=currently-running synchronous action (mc place, mc collect, etc.), last=most recent completed action with status. If task and sync are both null, the bot is idle — check `last` to see what just finished.',
    method: 'GET',
    path: '/task',
    examples: [`mc task`],
  }),
  g('task_pause', 'task', [], {
    examples: ["mc task_pause"],
 description: 'Pause running task', method: 'POST', path: '/task/pause', bodyFn: () => empty }),
  g('task_resume', 'task', [], {
    description: 'Resume paused task',
    examples: ["mc task_resume"],
    method: 'POST',
    path: '/task/resume',
    argSchema: [{ key: 'lease_seconds', type: 'number', default: 45 , min: 1, max: 3600}],
    bodyFn: (p) => JSON.stringify({ lease_seconds: Number(p.lease_seconds ?? 45) }),
  }),
  g('task_history', 'task', ['tasks_done'], {
    description: 'List recent task runs',
    examples: ["mc task_history"],
    method: 'GET',
    path: '/task/history',
  }),
  g('checkpoint', 'task', ['chk'], {
    description: 'Set agent decision checkpoint',
    examples: ["mc checkpoint"],
    method: 'GET',
    path: '/checkpoint',
  }),
  g('checkpoint_respond', 'task', ['cpr'], {
    description: 'Respond to a pending checkpoint',
    examples: ["mc checkpoint_respond"],
    method: 'POST',
    path: '/task/checkpoint-respond',
    customParse: true,
    bodyFn: (p) => JSON.stringify({ decision: p.decision, lease_seconds: p.lease_seconds }),
  }),

  /* background */
  g('bg_collect', 'task', [], {
    description: 'Background mine N of BLOCK',
    examples: ["mc bg_collect BLOCK [COUNT]"],
    method: 'POST',
    path: '/task/collect',
    argSchema: [
      { key: 'block', type: 'string', required: true },
      { key: 'count', type: 'number', default: 1 , min: 1, max: 256},
    ],
    bodyFn: (p) => JSON.stringify({ block: p.block ?? p.name, count: p.count }),
    usage: 'mc bg_collect BLOCK [COUNT]',
  }),
  g('bg_goto', 'task', [], {
    description: 'Background walk to X Y Z',
    examples: ["mc bg_goto X Y Z"],
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
    examples: ["mc cancel"],
    method: 'POST',
    path: '/task/cancel',
    bodyFn: () => empty,
  }),

  /* advanced combat*/
  g('sneak', 'combat', [], {
    description: 'Toggle sneak (crouch)',
    examples: ["mc sneak"],
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
    examples: ["mc shield"],
    method: 'POST',
    path: '/action/shield_block',
    argSchema: [{ key: 'duration', type: 'number', default: 3 }],
    bodyFn: (p) => JSON.stringify({ duration: Number(p.duration ?? 3) }),
  }),
  g('shoot', 'combat', ['bow'], {
    description: 'Fire bow at TARGET (must hold bow + arrows)',
    examples: ["mc shoot"],
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
    examples: ["mc sprint_attack"],
    method: 'POST',
    path: '/action/sprint_attack',
    bodyFn: (p) => (p.target ? JSON.stringify({ target: p.target }) : empty),
    argSchema: [{ key: 'target', type: 'string', default: '' }],
  }),
  g('crit', 'combat', ['critical'], {
    description: 'Jump-attack TARGET for critical-hit damage',
    examples: ["mc crit"],
    method: 'POST',
    path: '/action/critical_hit',
    bodyFn: (p) => (p.target ? JSON.stringify({ target: p.target }) : empty),
    argSchema: [{ key: 'target', type: 'string', default: '' }],
  }),
  g('strafe', 'combat', [], {
    description: 'Sidestep TARGET while attacking',
    examples: ["mc strafe"],
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
    examples: ["mc combo"],
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
    examples: ["mc bg_combo"],
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
    examples: ["mc bg_strafe"],
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
    examples: ["mc smelt_start INPUT [FUEL] [COUNT]"],
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
    examples: ["mc furnace_check"],
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
    examples: ["mc furnace_take"],
    method: 'POST',
    path: '/action/furnace_take',
    argSchema: [
      { key: 'x', type: 'number', required: true },
      { key: 'y', type: 'number', required: true },
      { key: 'z', type: 'number', required: true },
    ],
    bodyFn: (p) => JSON.stringify({ x: p.x, y: p.y, z: p.z }),
  }),
  g('furnaces', 'perceive', [], {
    examples: ["mc furnaces"],
 description: 'List known furnace marks + smelt status', method: 'GET', path: '/furnaces' }),

  /* team */
  g('team_chat', 'social', ['tc'], {
    description: 'Chat to current team channel',
    examples: ["mc team_chat"],
    method: 'POST',
    path: '/action/team_chat',
    argSchema: [{ key: 'message', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ message: p.message }),
  }),
  g('team_status', 'social', ['ts'], {
    examples: ["mc team_status"],
 description: 'Current team membership + roster', method: 'POST', path: '/action/team_status', bodyFn: () => empty }),
  g('rally', 'social', [], {
    description: 'Move all team bots to current position',
    examples: ["mc rally"],
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
    examples: ["mc report"],
    method: 'POST',
    path: '/action/report',
    argSchema: [{ key: 'message', type: 'string', required: true }],
    bodyFn: (p) => JSON.stringify({ message: p.message }),
  }),
  g('set_team', 'social', [], {
    description: 'Join named team channel',
    examples: ["mc set_team"],
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

  g('sounds', 'perceive', [], {
    examples: ["mc sounds"],
 description: 'Recent footstep / mob sounds', method: 'GET', path: '/sounds' }),
  g('stats', 'perceive', [], {
    examples: ["mc stats"],
 description: 'Bot session stats (uptime, errors, etc.)', method: 'GET', path: '/stats' }),
  g('fair_play', 'platform', [], {
    description: 'Toggle reaction-delay preamble (fair-play vs instant)',
    examples: ["mc fair_play"],
    method: 'POST',
    path: '/action/set_fair_play',
    bodyFn: (p) =>
      JSON.stringify({
        enabled: !(p.enabled === 'off' || p.enabled === 'false' || p.enabled === '0'),
      }),
    argSchema: [{ key: 'enabled', type: 'string', default: 'true' }],
  }),

  g('connect', 'platform', ['reconnect'], {
    examples: ["mc connect"],
 description: 'Reconnect bot to server', method: 'POST', path: '/connect', bodyFn: () => empty }),
  g('health', 'perceive', ['h'], {
    examples: ["mc health"],
 description: 'HP/food/effects summary', method: 'GET', path: '/health' }),

  g('complete_command', 'social', ['done'], {
    description: 'Mark a queued command as complete',
    examples: ["mc complete_command"],
    method: 'POST',
    path: '/action/complete_command',
    argSchema: [{ key: 'index', type: 'number', default: 0 , min: 0, max: 100}, { key: 'message', type: 'string' }],
    bodyFn: (p) => JSON.stringify({ index: Number(p.index ?? 0), ...(p.message ? { message: p.message } : {}) }),
  }),

  g('acknowledge_command', 'social', ['ack'], {
    description: 'Acknowledge receipt of a queued command',
    examples: ["mc acknowledge_command"],
    method: 'POST',
    path: '/action/acknowledge_command',
    argSchema: [{ key: 'index', type: 'number', default: 0 , min: 0, max: 100}, { key: 'plan', type: 'string' }],
    bodyFn: (p) => JSON.stringify({ index: Number(p.index ?? 0), ...(p.plan ? { plan: p.plan } : {}) }),
  }),

  g('cancel_command', 'social', ['reject'], {
    description: 'Cancel a pending queued command',
    examples: ["mc cancel_command"],
    method: 'POST',
    path: '/action/cancel_command',
    argSchema: [{ key: 'index', type: 'number', default: 0 , min: 0, max: 100}, { key: 'reason', type: 'string' }],
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
  g('commands', 'platform', [], {
    examples: ["mc commands"],
 customParse: true, description: `Dump CLI registry metadata as JSON.` }),
  g('help', 'platform', [], {
    examples: ["mc help"],
 customParse: true, description: `Human-readable grouped help.` }),
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
    description: 'Print fleet command center URL (./start-dashboard.sh, default port 3000)',
    examples: ["mc dashboard"],
    kind: 'http',
    customParse: true,
    method: 'GET',
    path: '/__noop__',
  }),

  /** Replaced bash helpers — composites implemented in dispatcher */
  g('anchors', 'perceive', [], {
    examples: ["mc anchors"],
 description: 'Known anchor marks', customParse: true, category: 'perceive', aliases: [], method: 'GET', path: '/__anchors__' }),

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
