# HermesCraft Command Center — New Dashboard

## Context

The existing dashboard (`bot/dashboard.html`, ~2700 lines, served by every bot at `/dashboard`) is a fleet view that polls each bot's HTTP API. It works but its model is "one HTML file embedded in every Mineflayer process, polled across ports" — that makes it awkward to add cross-cutting features that don't belong to any one bot (OpenRouter balance, Hermes usage, world-level maps, click-through FPV streaming).

We're replacing it with a single standalone aggregator service. Same data on the per-bot side (the bot HTTP API stays as-is — it's already rich), but a new process owns the fleet view, talks to OpenRouter and Hermes APIs directly, and embeds the live world views: a simple 2D coordinate map for world overview + POIs and per-bot `prismarine-viewer` 3D FPV in the center pane, plus a small `mineflayer-radar` tile inside the right-pane details. The server runs Multiverse-Core (worlds confirmed: `landfolk-test`, `testflat`, `world`, `world_nether`, `world_the_end`), and bots can be in different worlds — so the dashboard has a world selector that scopes the map and the player list.

Layout is three panes: a **left player list with quick stats**, a **center area that switches between Map / Kanban / Player FPV**, and a **right details pane** whose contents depend on what the user has clicked (player, point-of-interest marker, or kanban card). Hermes kanban is fetched from Hermes web API endpoints for v1.

User decisions locked: replace dashboard.html outright, standalone aggregator on a fixed port, vanilla HTML/JS no build step, FPV+radar+visual 2D POI map in v1, cost panel = OpenRouter balance + per-agent live spend rate.

## Post-refactor codebase context (added after `d2a1483` + `42631c6`)

The bot's `lib/` layer was decomposed for testability in commits `d2a1483` (Phases 1-7: services container + state slicing + world.js split + middleware extraction) and `42631c6` (Phase 10: conventions). Read `docs/architecture-map.md` for the navigation reference; key facts relevant to this plan:

- **Layered architecture (P8 — no upward calls)**:
  - `bot/lib/server/` — HTTP listener, dispatch, middleware, services container, sliced state
  - `bot/lib/runtime/` — Layer 2 reactive + perception (`observation.js`, `manager.js`, `reactive.js`, `paper-mcp.js`, …)
  - `bot/lib/actions/` — Layer 1 `mc <verb>` handlers, one per domain
  - `bot/lib/shared/` — domain-pure helpers (`action-contract.js`, `resolver.js`, etc.)
- **Services container** (`bot/lib/server/services.js`) — central DI with `state`, `ensureBot`, `resolver`, `craft`, `fairPlay`, `spatial`, `locations`, `social`, `utils`, `getActions`. Mock mirror in `mock-services.js`. `SERVICES_KEYS` exported for parity.
- **Sliced state** — `createBotState()` returns `{ config, world, social, tasks, runtime, goals, team, reminders, death, reactive }`. Field→slice mapping in `FIELD_SLICE_MAP` (exported from `bot/lib/server/state.js`). Internal access is now `ctx.world.bot`, `ctx.social.chatLog`, `ctx.tasks.taskHistory`, etc. — never the flat `ctx.bot` / `ctx.chatLog` of pre-refactor.
- **The `/observe` payload shape did NOT change.** All field names exposed over HTTP are stable; only internal ctx access patterns shifted. The dashboard aggregator polls HTTP and is unaffected by the slicing.
- **Middleware pipeline** — `dispatchAction` lives in `bot/lib/server/middleware/task-lifecycle.js`; pre/post lists declared in `pipeline.js`. Only relevant if we ever add new actions (we don't).
- **Module size budget (P16)** — `bot/lib/**/*.js` must stay under 500 LOC unless annotated `// @size-exempt: <reason>`. Our touch points (http-app.js, bot/server.js) are size-exempt already. The new dashboard service lives at `hermescraft/dashboard/` (outside `bot/lib/`) so P16 doesn't apply, but we'll keep modules small anyway.
- **Convention check** — `node scripts/check-conventions.mjs` must pass before commit. Enforces P3 (CLI descriptions), P4 (test fixtures), P16 (size budget), P20 (services/mock-services parity).
- **`npm test` defaults to `HERMES_VALIDATE=1`** — the dispatchAction validator now runs in CI. Touching dispatch code requires that validation pass; we don't, so this is informational.
- **`bot/lib/actions/world.js` is gone** — split in Phase 4 into `inventory.js` / `building.js` / `excavation.js` / `interaction.js` / `queries.js` / `lifecycle.js`. `bucket_fill`/`bucket_empty` moved into `water.js`. Doesn't change any HTTP endpoint, but the architecture-map's action-domain table is the canonical reference.

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  dashboard/server.js  (new Node process, fixed port 3000)         │
│  ──────────────────────────────────────────────────               │
│  • Reads data/agent-registry.json for bot roster                  │
│  • 2s poll loop: parallel GET /observe?lean=true on each bot      │
│  • 30s poll: PaperMCP `mv list` + `mv where <bot>` per bot        │
│  • 60s poll: OpenRouter /api/v1/credits                           │
│  • 60s poll: Hermes web server /api/analytics/usage               │
│  • 5s poll (kanban tab active): Hermes /api/kanban/*              │
│  • Serves single-page dashboard at /                              │
│  • Exposes /api/fleet merged JSON for the frontend                │
│  • Exposes /api/worlds for the world-selector dropdown            │
└───────────────────────────────────────────────────────────────────┘
        │ polls                       │ polls           │ polls
        ▼                             ▼                 ▼
  bot:3001-3007              openrouter.ai/api/v1   hermes-web:port
  (existing HTTP API)        /credits               /api/analytics/usage

  bot:4001-4007  ◄── prismarine-viewer (per-bot opt-in, iframed on click)
  bot:5001-5007  ◄── mineflayer-radar (per-bot opt-in, iframed in card)
  paper:25577    ◄── PaperMCP (multiverse `mv list` / `mv where` queries)
```

## Files to create

- `hermescraft/dashboard/server.js` — Node aggregator (HTTP server + poll loops). ~250 LOC.
- `hermescraft/dashboard/index.html` — single-page dashboard markup.
- `hermescraft/dashboard/static/app.js` — frontend polling + render (vanilla, ESM).
- `hermescraft/dashboard/static/style.css` — dark theme matching current dashboard.html palette (vars from `bot/dashboard.html:8-19`).
- `hermescraft/dashboard/lib/registry.js` — load agent roster from `data/agent-registry.json`.
- `hermescraft/dashboard/lib/openrouter.js` — `/api/v1/credits` client.
- `hermescraft/dashboard/lib/hermes-usage.js` — Hermes `/api/analytics/usage` client.
- `hermescraft/dashboard/lib/poll.js` — parallel fan-out poller for bot endpoints.
- `hermescraft/dashboard/lib/multiverse.js` — PaperMCP WS client; runs `mv list` once at startup + `mv where <bot>` per refresh; caches `bot_name → world_name`.
- `hermescraft/dashboard/lib/kanban.js` — Hermes API client for read-only kanban endpoints. Returns grouped task rows for the center-pane board, plus `getTask(id)` for the right-pane details view.
- `hermescraft/data/agent-registry.json` — extends existing `data/agent-models.json` shape with `api_port`, `viewer_port`, `radar_port`, `role`, `model`.
- `hermescraft/start-dashboard.sh` — launcher (port + env wiring; mirrors `start-steve.sh` style).
- `hermescraft/docs/dashboard.md` — operational notes (how to run, port map, world-board mapping).
- `hermescraft/dashboard/lib/map2d.js` — coordinate projection helpers for the v1 2D world map and POI markers.

## Files to modify

- `hermescraft/bot/server.js` — opt-in viewer + radar startup. Hook into the bot creation flow (the file ends with `httpServer.listen(...)` calling `createBot()` at line 644; `createBot()` is defined earlier in the same file). The cleanest hook is `bot.once('spawn', ...)` inside or right after the create flow, where the live bot instance is available. Read `VIEWER_PORT` and `RADAR_PORT` env vars; if set, `await import('prismarine-viewer')` and `bot.loadPlugin(require('mineflayer-radar'))`. Both stay no-ops when env unset → zero impact on civilization-mode (7 bots × 3 ports each would be too many). Note: `bot/server.js` is already `@size-exempt` (655 LOC), so adding ~20 LOC for the env-gated block is fine.
- `hermescraft/bot/package.json` — add `prismarine-viewer` and `mineflayer-radar` to deps.
- `hermescraft/bot/lib/server/http-app.js:322-330` — replace the `/dashboard` handler (currently reads `dashboardHtmlPath` and serves the HTML) with a 302 to the aggregator URL (default `http://127.0.0.1:3000` for on-host use), configurable via `DASHBOARD_URL` env var for LAN access. Keeps `mc dashboard` working. The file is `@size-exempt` (583 LOC); the change is net-shrinking.
- `hermescraft/bin/mc` (CLI's `dashboard` subcommand at `bot/cli/`) — point to `DASHBOARD_URL` instead of `${bot}/dashboard`.
- `hermescraft/scripts/run-landfolk-bots.sh` — export `VIEWER_PORT=$((4000 + i))` and `RADAR_PORT=$((5000 + i))` per bot.
- `hermescraft/landfolk.sh` — same env additions in the per-name launch block (lines 22-28, 103).
- `hermescraft/civilization.sh` — leave viewer/radar OFF by default (too many ports for 7 bots); add `--with-viewer` flag for opt-in.
- `hermescraft/README.md` — add dashboard section pointing to `docs/dashboard.md`.

## Port allocation convention

| Service              | Port range | Notes                                |
|----------------------|------------|--------------------------------------|
| Bot HTTP API         | 3001–3007  | existing                             |
| prismarine-viewer    | 4001–4007  | new, per-bot, env-gated              |
| mineflayer-radar     | 5001–5007  | new, per-bot, env-gated              |
| Dashboard aggregator | 3000       | new, single instance, fixed          |

## Dashboard layout (vanilla HTML, single page)

Three panes, fixed: **LEFT** = player list with quick stats. **CENTER** = tabbed switcher (Map / Kanban / Player FPV). **RIGHT** = context-driven details pane. A collapsible chat strip pins to the bottom of the right pane.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ HermesCraft Command Center  World:[landfolk-test ▾] ☀ $bal $/hr  live:5/5    │
├──────────────────┬──────────────────────────────────────┬────────────────────┤
│ LEFT             │ CENTER                               │ RIGHT              │
│ Players          │ ┌──[Map]─[Kanban]─[FPV: Steve]──┐    │ DETAILS            │
│ (filtered by     │ │                               │    │ (context-driven)   │
│  world)          │ │                               │    │                    │
│                  │ │  Map: simple 2D world plane   │    │ Selected: Steve    │
│ ┌──────────────┐ │ │   points: bots + humans + POI │    │ ─────────────────  │
│ │ Steve   ◄sel │ │ │   centered by world extents   │    │ Model: Sonnet 4    │
│ │ ❤9 🍗7       │ │ │                               │    │ World: landfolk... │
│ │ oak_log      │ │ │  Kanban: swim lanes by status │    │ Spend: $0.12/hr    │
│ │ chopping     │ │ │   (todo · ready · running ·   │    │ Pos: 372, 65,-591  │
│ ├──────────────┤ │ │    blocked · done)            │    │ Holding: oak_log   │
│ │ Reed         │ │ │   from Hermes API             │    │ Task: bg_collect   │
│ │ ❤7 🍗9 idle  │ │ │                               │    │ Top goal:          │
│ ├──────────────┤ │ │  FPV: prismarine-viewer       │    │   wood_supply      │
│ │ Moss   ❤10   │ │ │   for currently-selected bot  │    │ Recent actions:    │
│ ├──────────────┤ │ │   (greyed if no bot selected  │    │   • bg_collect ok  │
│ │ Flint        │ │ │    or selection is human)     │    │   • chat …         │
│ ├──────────────┤ │ │                               │    │ Inventory: ...     │
│ │ Ember        │ │ └───────────────────────────────┘    │ [Radar mini-tile]  │
│ ├──────────────┤ │                                      │ ─────────────────  │
│ │ re44  HUMAN  │ │                                      │ Chat (merged)      │
│ └──────────────┘ │                                      │  [t] Reed: ...     │
│                  │                                      │  [t] Moss: ...     │
│                  │                                      │  [w] Steve: ...    │
└──────────────────┴──────────────────────────────────────┴────────────────────┘

World selector: world · landfolk-test · testflat · world_nether · world_the_end
Center tabs:     Map (default) · Kanban · FPV
Right pane modes (mutually exclusive, set by what was clicked):
  • Player details  (click left-pane row or a map bot-marker)
  • POI details     (click a map POI / mark)
  • Kanban task     (click a card in the center kanban view)
  • Empty / fleet summary (when nothing is selected)
```

**Selection model** (single shared `selection` object, drives center FPV target + right pane content):

| User action                          | `selection.kind` | Right pane             | Center FPV tab               |
|--------------------------------------|------------------|------------------------|------------------------------|
| Click player in left list            | `player`         | Player details         | FPV tab derives port by selected player id |
| Click bot marker on map              | `player`         | Player details         | FPV tab derives port by selected player id |
| Click POI/mark on map                | `poi`            | POI details            | unchanged                    |
| Click kanban card                    | `task`           | Kanban task details    | unchanged                    |
| Switch center to FPV with no player  | (selection req'd)| highlight player list  | shows greyed placeholder     |
| Clear selection                      | `null`           | Fleet summary          | FPV greyed                   |

## Data flow

**`/api/fleet` payload** (built every 2s, served to frontend):

```jsonc
{
  "tick": 1234,
  "time": { "ticks": 12000, "is_day": true },
  "openrouter": { "balance_usd": 47.23, "usage_usd": 12.77 },
  "agents": [
    {
      "name": "Steve",
      "online": true,
      "model": "claude-sonnet-4",
      "api_port": 3001,
      "viewer_port": 4001,
      "radar_port": 5001,
      "world": "landfolk-test",
      "dimension": "minecraft:overworld",
      "health": 9, "food": 7,
      "position": { "x": 372, "y": 65, "z": -591 },
      "holding": "oak_log",
      "task": { "action": "bg_collect", "status": "running", "detail": "..." },
      "top_goal": { "id": "wood_supply", "satisfied": false },
      "recent_action": "...",
      "spend_rate_usd_per_hr": 0.12,
      "cumulative_session_usd": 1.47
    }
  ],
  "humans": [{ "name": "re44", "online": true, "world": "landfolk-test", "position": null }],
  "chat": [{ "from": "Reed", "message": "...", "ts": ..., "world": "landfolk-test" }]
}
```

**`/api/worlds` payload** (refreshed every 30s, served to frontend):

```jsonc
{
  "worlds": [
    { "name": "world",          "type": "NORMAL" },
    { "name": "landfolk-test",  "type": "NORMAL" },
    { "name": "testflat",       "type": "NORMAL" },
    { "name": "world_nether",   "type": "NETHER" },
    { "name": "world_the_end",  "type": "THE_END" }
  ]
}
```

Later build enhancement: include per-world live counts (`active_agents`, `humans`) in this payload so the world selector can show `world (3)` style badges.

**`/api/kanban` payload** (refreshed every 5s when center tab = Kanban, world-scoped):

```jsonc
{
  "tasks": [
    { "id": "t-001", "title": "Build fishing shack", "status": "running",
      "assignee": "Reed", "board": "landfolk", "updated_at": 1747... }
  ],
  "grouped": {
    "triage":   [...], "todo": [...], "ready": [...],
    "running":  [...], "blocked": [...], "done": [...], "archived": [...]
  }
}
```

**`/api/kanban/:id`** — single task detail for the right pane (title, body/spec, comments, links, full event timeline).

Kanban model: one board per world. The selected world determines which board is queried (for example `board=landfolk-test`). Workflow contract is API-driven (no hard permission enforcement in dashboard): bots read tasks, take the next task, add progress comments, and mark tasks as review-ready before steward/human closes them.

**`/api/poi`** — points of interest aggregated from each bot's `/marks` endpoint, deduped by `(world, name, x, y, z)` (with integer-rounded coordinates), merged with proximity hints. Right-pane POI details: name, world, x/y/z, note, last-visited-by (which bot's marks list contains it).

**Per-bot fetches** (parallel, per tick): `GET /observe?lean=true` provides 90% of the per-agent fields above (`bot/lib/runtime/observation.js:281`, `briefState()` at line 134). The payload shape is unchanged by the Phase 1-7 refactor — only internal ctx access patterns shifted (e.g. `ctx.world.bot.heldItem`, `ctx.social.chatLog`). For `holding` and equipment we may need to also hit `/inventory` if `state.holding` proves insufficient — confirm during implementation. For human players, we get presence + position from any nearby bot's `/nearby`.

**OpenRouter** — `GET https://openrouter.ai/api/v1/credits` with `Authorization: Bearer $OPENROUTER_API_KEY`. Returns `{ data: { total_credits, total_usage } }`. Polled every 60s, cached.

**Hermes usage** — `GET http://<hermes-web-host>/api/analytics/usage` (web_server.py:2803-2850). Returns daily/by-model aggregates. To get per-agent spend rate: group sessions by model, map model → agent via `data/agent-models.json`, compute USD spent in trailing 5 min × 12 → USD/hr. Caveat: model-to-agent mapping is ambiguous when two agents share a model (e.g. both Steve and Reed on `claude-sonnet-4`). Document this limitation in v1; v2 can inject agent name into Hermes session metadata.

**Multiverse / world tracking** — at startup, aggregator runs `mv list` via PaperMCP `minecraft_execute_command` to populate `/api/worlds`. Every 30s it runs `mv where <bot_name>` for each online bot to refresh the world cache. The bot's own `bot.game.dimension` (already in `/observe`) is reported alongside as `dimension`. For human players, world is inferred from aggregated `/nearby` observations first, with `mv where <human>` as fallback when unknown. Frontend world selector filters `agents[]` and `humans[]` client-side by `world === selected`, and the left pane only renders active (`online===true`) agents in the selected world.

## v1 map approach (simple 2D)

Map tab uses a simple 2D coordinate plane rendered in the dashboard (canvas or SVG), world-scoped to the selected world. It plots:

1. Active bot markers (`/api/fleet` positions).
2. Human markers when positions are known.
3. POI markers from `/api/poi`.

Projection is linear in x/z world coordinates, fitted to a moving viewport over recent positions + POIs in that world. If no coordinates are available for the selected world, show an explicit empty-state card.

## Frontend implementation notes

- Single `index.html` with `<script type="module" src="/static/app.js">`.
- `app.js` polls `/api/fleet` every 2s, `/api/worlds` every 30s, and `/api/kanban` every 5s while the Kanban tab is visible. Renders imperatively (no framework). Use template literals + `replaceChildren()` for tile updates.
- Global app state: `{ world: string, selection: {kind, id} | null, centerTab: 'map'|'kanban'|'fpv' }`. World defaults to `world` on first load, then follows `localStorage`. Selection drives both right-pane content and (for `kind==='player'`) the FPV iframe src.
- **Left pane (player list)**: rows show name, ❤/🍗 bars, holding, one-line task status. Filtered to active agents in the selected world only. Selected row gets an accent border. Clicking a row sets `selection = {kind:'player', id:name}`.
- **Center tabs**: simple top-of-pane tab strip. Each tab is a separate `<section>`, only one visible.
  - **Map**: simple 2D coordinate view (canvas/SVG) for selected world, rendering bots/humans/POIs as markers with click-through selection.
  - **Kanban**: 5-7 column swim-lane board (triage · todo · ready · running · blocked · done · archived). Each card shows title + assignee + status icon. Click → `selection = {kind:'task', id}` and right pane switches.
  - **FPV**: `<iframe id="fpv">` with `src = http://<bot-host>:<viewer_port>` derived by looking up the selected player id in `agents[]`. Greyed placeholder when no player selected or selection is a human.
- **Right pane**: switches on `selection.kind`. Player details pulls from `/api/fleet` entry + `/inventory` + `/marks` + recent `/observe` extras. Includes the per-bot mineflayer-radar mini-iframe (~250×180). POI details from `/api/poi`. Task details from `/api/kanban/:id`.
- **Kanban comments in dashboard**: read-only in v1 (view timeline/comments only; no comment form in dashboard UI).
- **Chat strip**: docked at the bottom of the right pane, collapsible. Merges `state.new_chat` from each bot's `/observe`, dedupes by (from, message, second-precision ts), shows last 30 with world-tag prefix (e.g. `[lt]`, `[w]`). Toggle to filter to current world.
- Spend rate per player surfaced in left-pane row footer and in right-pane details.

## Reuse from existing code

- Color palette and badge styles: copy from `bot/dashboard.html:8-60` (CSS custom properties).
- Chat merge logic shape: existing `state.new_chat` already pre-merges direct + overheard messages per-bot (`buildObservePayload` at `bot/lib/runtime/observation.js:281`); just union across bots.
- Fair-play perception is already applied server-side in `/observe` — frontend doesn't re-filter.
- `briefState()` at `bot/lib/runtime/observation.js:134` already gives a card-sized summary per bot (health, food, position, holding, task, top_goal, recent action). This is the per-card data source.
- `bot/lib/server/diagnostics.js` exposes `buildActionStats` + `classifyIdleReason` as pure functions — usable from the aggregator if we want a server-side action-stats panel without re-implementing the math.
- `docs/architecture-map.md` is the navigation reference for any future bot-side changes.

## What is intentionally dropped from the current dashboard

User chose "Replace it" not "Replace, keep deep-dive modal", so v1 has no per-agent reasoning-log modal. The following lose their dedicated UI:

- Reasoning log (`auto_action_log`) — still available via direct `curl bot:3001/observe`, not surfaced in UI.
- Action stats / error rate per 5m — same.
- Task history (last 50) — same.
- Raw observe JSON debug pane — same.

If any of these turn out to be load-bearing during use, we add them back as a per-card "details" drawer in v1.1. Document in `docs/dashboard.md` how to fetch them via curl in the meantime.

## v1 scope cut

Out of scope for v1, explicitly:

- Kanban status and description edits from dashboard UI. Steward controls these in Hermes; dashboard remains read-oriented for task state.
- Per-bot reasoning log / action stats modal.
- Per-model `$/Mtok` reference cards.
- Cumulative session cost in headline (per-row only).
- Bot discovery via port-scan fallback (registry file is required for v1).
- Civilization-mode FPV/radar (env-gated off; only landfolk mode gets it in v1).

## Implementation phases

Each phase is independently testable — the dashboard is usable at the end of every phase, with strictly more features than the previous one. Easiest/lowest-risk first; the heaviest dependencies (server-side plugin install, native npm builds) are pushed late so a stumble there doesn't block earlier wins. The old `bot/dashboard.html` stays live and reachable at `bot:3001/dashboard` until the very last phase, so we always have a fallback.

### Phase 1 — Skeleton: aggregator, left pane, right pane player details

**Goal:** standalone dashboard at `http://localhost:3000` that lists active bots in the selected world with live stats, and shows player details on click. No center pane content yet (just "Map / Kanban / FPV — coming" placeholders). No bot changes. No external deps.

**Build:**
- `dashboard/server.js` — minimal HTTP server: serves `index.html` + static files; `/api/fleet` polls each bot's `/observe?lean=true` in parallel every 2s and merges.
- `dashboard/lib/registry.js` + `data/agent-registry.json` — agent roster.
- `dashboard/lib/poll.js` — parallel poller with timeouts and online/offline flagging.
- `dashboard/index.html` + `static/app.js` + `static/style.css` — three-pane layout, left list, right details pane (player kind only), center placeholder.
- `dashboard/start-dashboard.sh` — launcher.

**Test:**
- `./scripts/run-landfolk-bots.sh <PORT>` then `./start-dashboard.sh`. Open `http://localhost:3000`.
- Left pane shows only online bots in the selected world with health/food/holding/task.
- Click a bot → right pane shows player details (model, pos, holding, task, top goal, recent actions, inventory summary).
- Selection persists in `localStorage` across reload.
- Sanity: `node --check dashboard/server.js`, `bash -n start-dashboard.sh`.

### Phase 2 — OpenRouter balance in header

**Goal:** header shows live balance + total usage from OpenRouter.

**Build:**
- `dashboard/lib/openrouter.js` — fetch `https://openrouter.ai/api/v1/credits` with `OPENROUTER_API_KEY` (loaded from `~/hermescraft/secrets.yaml`); cache 60s; fail soft to `—`.
- Add to `/api/fleet` payload.
- Header DOM: balance USD, total usage USD.

**Test:**
- Header shows real balance matching `https://openrouter.ai/settings/credits`.
- Kill internet → header shows `—` instead of crashing.

### Phase 3 — Multi-world awareness + world selector

**Goal:** world selector in the header filters the left pane and reports each bot's current world.

**Build:**
- `dashboard/lib/multiverse.js` — PaperMCP WS client: `mv list` once at startup (cache worlds), `mv where <bot>` per refresh (30s, parallel).
- Add `world` + `dimension` to per-agent entries in `/api/fleet`.
- Add `/api/worlds` endpoint.
- Header dropdown: each world from `/api/worlds` (default `world` on first load).
- Left-pane filter by selected world; selection state persisted.

**Test:**
- `mv list` matches dropdown contents.
- Landfolk bots show `world: landfolk-test` (or wherever they spawned).
- `mv tp Steve testflat` via rcon → within 30s, Steve's row moves to `testflat` filter.
- Switching world updates the left pane to only active agents in that world.
- Later build: world selector badges show per-world live player counts.

### Phase 4 — Center pane: Map tab (simple 2D POI map)

**Goal:** center pane Map tab shows a visual 2D map for the selected world with live markers for bots/humans/POIs.

**Build (dashboard):**
- `dashboard/lib/map2d.js` for world-coordinate projection and viewport fitting.
- Center Map tab canvas/SVG with marker layers for agents/humans/POIs.
- Marker clicks set `selection` (`player` or `poi`) and drive right pane.
- World selector change re-renders map with selected-world dataset.

**Test:**
- Map renders with visible markers for selected world.
- Click bot marker -> player details; click POI marker -> POI details.
- Switching worlds in the header updates map dataset within one second.

### Phase 5 — Per-bot radar in right pane

**Goal:** right pane player details include the bot's mineflayer-radar mini-tile.

**Build:**
- `bot/package.json` — add `mineflayer-radar`.
- `bot/server.js` — env-gated `RADAR_PORT` opt-in. Hook into the bot creation flow (e.g. `bot.once('spawn', ...)` inside `createBot()`) so the live `bot` instance can be passed to `bot.loadPlugin(require('mineflayer-radar'))`.
- `scripts/run-landfolk-bots.sh`, `landfolk.sh` — set `RADAR_PORT=$((5000 + i))` per bot.
- Right pane: add `<iframe class="radar-mini" src="http://<bot-host>:<radar_port>">` (~250×180) when selected entity is a bot with a radar port.

**Test:**
- `./start-steve.sh` with no env → no port 5001 listening; nothing breaks. Verify with `npm test` in `bot/` (no regressions).
- With `RADAR_PORT=5001` → `curl localhost:5001` returns the radar page; clicking Steve in the dashboard shows his radar mini-iframe.
- `node scripts/check-conventions.mjs` still green.

### Phase 6 — Per-bot FPV in center pane

**Goal:** center pane FPV tab streams the currently-selected bot's first-person view.

**Build:**
- `bot/package.json` — add `prismarine-viewer`.
- `bot/server.js` — env-gated `VIEWER_PORT` opt-in (alongside the radar opt-in from phase 5; same `bot.once('spawn', ...)` hook). `await import('prismarine-viewer').then(({ mineflayer }) => mineflayer(bot, { port, firstPerson: true }))`.
- `scripts/run-landfolk-bots.sh`, `landfolk.sh` — set `VIEWER_PORT=$((4000 + i))`.
- Center FPV tab: `<iframe id="fpv">` whose `src` is computed from selected player id -> `agents[]` entry -> `viewer_port`; greyed placeholder when no bot selected or selection is a human.

**Test:**
- `VIEWER_PORT=4001 ./start-steve.sh` → `curl localhost:4001` returns the prismarine-viewer page.
- Select Steve in left pane → center FPV tab → live 3D view of Steve's surroundings updates as he moves.
- Selection = human (re44) → FPV tab shows "no FPV for human players" placeholder.
- `node scripts/check-conventions.mjs` still green.

### Phase 7 — Hermes spend rate per agent

**Goal:** each player row + right-pane details show live USD/hr spend.

**Build:**
- `dashboard/lib/hermes-usage.js` — fetch `/api/analytics/usage` from Hermes web server every 60s.
- Map model → agent via `data/agent-models.json` (note: ambiguous when two agents share a model — document).
- Compute trailing-5-min USD × 12 → `spend_rate_usd_per_hr` per agent.
- Add to `/api/fleet`.
- Left-pane row footer + right pane: show spend rate.

**Test:**
- Header total spend rate updates as agents work.
- Active agent shows non-zero rate; idle agent trends to 0.
- Total in header ≈ sum of per-agent rates (within model-ambiguity caveat).

### Phase 8 — Kanban tab + task details

**Goal:** center Kanban tab renders the Hermes kanban board for the selected world; clicking a card opens task details in the right pane.

**Build:**
- `dashboard/lib/kanban.js` — Hermes API client for kanban list/detail endpoints; normalize responses into grouped lanes and query board-by-world.
- `/api/kanban` (5s poll while tab visible) + `/api/kanban/:id` proxy/transform endpoints.
- `dashboard/lib/poi.js` + `/api/poi` — union of each bot's `/marks`, deduped by `(world, name, x, y, z)` using integer-rounded coordinates.
- Center Kanban tab: swim lanes (triage · todo · ready · running · blocked · done · archived). Card click → `selection = {kind:'task', id}` → right pane shows task details.
- Workflow contract for v1: bots read tasks, pick next, add comments, and mark tasks review-ready; steward/human performs final close. No hard permission checks are enforced by dashboard code.
- Right pane: POI details mode (clicking a POI marker in the Map tab).

**Test:**
- Kanban tab renders all current tasks grouped correctly.
- Switching selected world swaps to that world's board.
- Click a task → right pane shows title, body/spec, comments, event timeline.
- Add comment via Hermes API -> comment appears in task details within 5s.
- Dashboard keeps comments read-only (no comment input control in UI).
- Hermes API failure sim (network/auth): kanban tab renders a degraded "kanban unavailable" state instead of crashing.

### Phase 9 — Retire the old dashboard

**Goal:** old `bot/dashboard.html` and `/dashboard` endpoint redirect to the new aggregator; `mc dashboard` CLI opens the new URL.

**Build:**
- `bot/lib/server/http-app.js:322-330` — replace `/dashboard` handler with `302` → `${DASHBOARD_URL:-http://127.0.0.1:3000}`. Drop the `dashboardHtmlPath` import (line 58) from the deps bag, and remove its construction in `bot/server.js:582`.
- `bot/cli/registry.mjs` — update the `mc dashboard` subcommand to open `$DASHBOARD_URL`. P3 requires a non-empty description; keep it descriptive.
- Delete `bot/dashboard.html` from the codebase (git history retains it).
- `bot/test/dashboard-reasoning-format.test.js` — drop or repoint to the aggregator.
- `docs/dashboard.md` — operational notes (running, port map, world-board mapping, troubleshooting).
- `hermescraft/README.md` — point at `docs/dashboard.md`.

**Test:**
- `curl -I localhost:3001/dashboard` → `302 Location: http://127.0.0.1:3000` (or configured `DASHBOARD_URL`).
- `mc dashboard` opens browser at the new URL.
- `cd bot && npm test` passes (with default `HERMES_VALIDATE=1`).
- `node scripts/check-conventions.mjs` passes (P3 description, P16 size budget).
- `node --check bot/server.js`, `bash -n` on all touched shell scripts.

### Phase ordering rationale

| Phase | New deps | Server-side change | Risk | Visible value |
|-------|---------|--------------------|------|---------------|
| 1     | none    | no                 | low  | functional dashboard |
| 2     | none    | no                 | low  | balance number |
| 3     | none    | no (uses PaperMCP) | low  | world filter |
| 4     | none    | no                 | low  | visual POI map |
| 5     | `mineflayer-radar` | no       | low  | radar tiles |
| 6     | `prismarine-viewer` | no      | med (port/asset weight) | the FPV |
| 7     | none    | no                 | low  | $/hr per agent |
| 8     | none    | no                 | med (Hermes API coupling) | kanban |
| 9     | none    | no                 | low  | cleanup |

## Risks & landmines

- **prismarine-viewer in headless Node**: it bundles a Three.js WebGL renderer for the browser side, but server-side it just streams world state. Confirm it works in itzg/minecraft-server's network setup (the bots are on Mac, not server-side, so this is fine — but worth a smoke test on the first run).
- **Port pressure**: 5 bots × 3 ports each = 15 ports for landfolk; manageable. Civilization (7 bots) intentionally skips viewer/radar to avoid 21 ports.
- **OpenRouter `/credits` rate limit**: 60s poll cadence is conservative. If the endpoint changes shape, fail soft (show "—" not crash).
- **Hermes usage attribution ambiguity**: two agents on the same model → can't split their spend. Note in `docs/dashboard.md`; v2 fix is injecting agent name into session metadata.
- **2D map projection drift**: a simple fitted x/z viewport can look jumpy if marker extents change rapidly. Mitigate with smoothed viewport bounds (lerp) and a reset-viewport control.
- **Schema drift on `/observe`**: the aggregator should fail soft if any expected field is missing (treat as `null`, don't crash the page).
- **`mv where` parsing**: `mv where` output is human-formatted with color codes (e.g. `[34mlandfolk-test - [32mNORMAL`). Strip ANSI + parse the world name. If the command format changes in a future Multiverse update, fall back to mapping via `bot.game.dimension` + a per-bot launch-time `MC_WORLD` env var.
- **World-change latency**: world tracking is on a 30s refresh; teleports won't appear instantly. Acceptable for v1. v2 could subscribe to PaperMCP events if/when streaming is supported.
- **Hermes kanban API coupling**: if Hermes changes kanban response shape or auth behavior, the dashboard kanban panel can degrade. Fail soft with "kanban unavailable" and keep map/player panes running.
