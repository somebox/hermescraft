# HermesCraft Command Center — New Dashboard

## Context

The existing dashboard (`bot/dashboard.html`, ~2700 lines, served by every bot at `/dashboard`) is a fleet view that polls each bot's HTTP API. It works but its model is "one HTML file embedded in every Mineflayer process, polled across ports" — that makes it awkward to add cross-cutting features that don't belong to any one bot (OpenRouter balance, Hermes usage, world-level maps, click-through FPV streaming).

We're replacing it with a single standalone aggregator service. Same data on the per-bot side (the bot HTTP API stays as-is — it's already rich), but a new process owns the fleet view, talks to OpenRouter and Hermes' usage API directly, and embeds the live world views: a Paper-server squaremap (world overview) and per-bot `prismarine-viewer` 3D FPV in the center pane, and a small `mineflayer-radar` tile inside the right-pane details. The server runs Multiverse-Core (worlds confirmed: `landfolk-test`, `testflat`, `world`, `world_nether`, `world_the_end`), and bots can be in different worlds — so the dashboard has a world selector that scopes the map and the player list.

Layout is three panes: a **left player list with quick stats**, a **center area that switches between Map / Kanban / Player FPV**, and a **right details pane** whose contents depend on what the user has clicked (player, point-of-interest marker, or kanban card). Hermes kanban is read from `~/.hermes/kanban.db` (SQLite) for v1.

User decisions locked: replace dashboard.html outright, standalone aggregator on a fixed port, vanilla HTML/JS no build step, FPV+squaremap+radar all in, cost panel = OpenRouter balance + per-agent live spend rate.

## Alignment with the refactored bot codebase

This plan assumes the **post-2026 refactor** layout of `bot/lib/` (navigation: [`docs/architecture-map.md`](architecture-map.md); history: [`docs/archive/refactor-plan-2026.md`](archive/refactor-plan-2026.md)).

| Topic | Implication for the dashboard effort |
|--------|--------------------------------------|
| **Source of truth** ([`docs/MC_AGENT_BOUNDARIES.md`](MC_AGENT_BOUNDARIES.md)) | Live world state, marks, inventory, tasks, and operational memory come from **each bot’s HTTP API**. The aggregator adds fleet UX and talks to OpenRouter / Hermes analytics for **cost and usage**; it must not treat Hermes as the only copy of world truth. |
| **Sliced runtime state** ([`docs/architecture-map.md`](architecture-map.md) — *State slices*) | Server code owns `world`, `social`, `tasks`, `goals`, etc. via `bot/lib/server/state.js` (`FIELD_SLICE_MAP`). The dashboard only sees the **HTTP JSON** contract (`/observe`, `/marks`, …), not slices. When debugging or extending observe payloads, follow `bot/lib/runtime/observation.js` (`briefState`, `buildObservePayload`); avoid mentally mapping UI fields to a flat `ctx`. |
| **Layering P8** ([`docs/reference/engineering-patterns.md`](patterns.md)) | Viewer/radar hooks belong in **`lib/runtime/manager.js`** (spawn lifecycle), not in action handlers. The aggregator is a **separate Node process**: integrate only via HTTP + external APIs, not by importing `bot/lib`. |
| **Action contract P9** ([`docs/phase-2/action-contracts.md`](phase-2/action-contracts.md), [`docs/reference/engineering-patterns.md`](patterns.md)) | v1 mostly **GET**-drives the UI. If later work surfaces `POST /action/*` results or task/history JSON in the dashboard, use the same `ok` / `error.code` / `retry_safe` envelope as every `mc` handler — no parallel invented shapes. |
| **Conventions P14 + module budget P16** ([`docs/reference/engineering-patterns.md`](patterns.md)) | Any edit under `bot/lib/**` should pass `node scripts/check-conventions.mjs`. New bot-side code should respect the ≤500 LOC rule for `bot/lib` (or `// @size-exempt:`); the new `dashboard/` tree is outside that tree but should stay modular for the same reason. |
| **Mock parity P20** | If Phase 9 or follow-ons add tests that build **`createMockServices()`** / touch `SERVICES_KEYS`, keep **[`bot/lib/server/mock-services.js`](../../bot/lib/server/mock-services.js)** aligned with **[`bot/lib/server/services.js`](../../bot/lib/server/services.js)**. |
| **Testing** ([`docs/testing.md`](testing.md)) | After **`http-app.js`** or **`manager.js`** changes, keep **Tier 1** green (`cd bot && npm test`). Prefer a **Tier 3** smoke on a live bot when runtime/HTTP behavior might regress. Phase 9 updates (`listener-health.test.js`, …) are part of that gate. |

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
  paper:8080     ◄── squaremap plugin (multi-world overview, iframed)
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
- `hermescraft/dashboard/lib/kanban.js` — read-only SQLite client for `~/.hermes/kanban.db` (uses `better-sqlite3`, opened with `readonly: true, fileMustExist: true`). Returns rows grouped by status for the center-pane board, plus a `getTask(id)` for the right-pane details view. Pinned columns: `id, title, status, assignee, board, created_at, updated_at` (schema reference: `~/.hermes/hermes-agent/hermes_cli/kanban_db.py:80-180`).
- `hermescraft/data/agent-registry.json` — extends existing `data/agent-models.json` shape with `api_port`, `viewer_port`, `radar_port`, `role`, `model`.
- `hermescraft/start-dashboard.sh` — launcher (port + env wiring; mirrors `start-steve.sh` style).
- `hermescraft/docs/dashboard.md` — operational notes (how to run, squaremap install, port map).

## Files to modify

- `hermescraft/bot/lib/runtime/manager.js` — opt-in viewer + radar startup inside the **existing** `bot.once('spawn', …)` handler (same place the bot is fully wired after connect). Read `VIEWER_PORT` and `RADAR_PORT`; if set, load `prismarine-viewer` and `mineflayer-radar` there — do **not** add a separate top-level hook in `bot/server.js`. Both stay no-ops when env unset → zero impact on civilization-mode (7 bots × 3 ports each would be too many).
- `hermescraft/bot/package.json` — add `prismarine-viewer` and `mineflayer-radar` to deps.
- `hermescraft/bot/lib/server/http-app.js:402-410` — replace `/dashboard` handler with a 302 to the aggregator URL (default `http://localhost:3000`), configurable via `DASHBOARD_URL` env var. Keeps `mc dashboard` working.
- `hermescraft/bin/mc` (CLI's `dashboard` subcommand at `bot/cli/`) — point to `DASHBOARD_URL` instead of `${bot}/dashboard`.
- `hermescraft/scripts/run-landfolk-bots.sh` — export `VIEWER_PORT=$((4000 + i))` and `RADAR_PORT=$((5000 + i))` per bot.
- `hermescraft/landfolk.sh` — same env additions in the per-name launch block (lines 22-28, 103).
- `hermescraft/civilization.sh` — leave viewer/radar OFF by default (too many ports for 7 bots); add `--with-viewer` flag for opt-in.
- `hermescraft/README.md` — add dashboard section pointing to `docs/dashboard.md`.
- `docker/minecraft/docker-compose.yml` (in `homelab` repo) — expose port 8080 for squaremap web tiles.

## Port allocation convention

| Service              | Port range | Notes                                |
|----------------------|------------|--------------------------------------|
| Bot HTTP API         | 3001–3007  | existing                             |
| prismarine-viewer    | 4001–4007  | new, per-bot, env-gated              |
| mineflayer-radar     | 5001–5007  | new, per-bot, env-gated              |
| squaremap web tiles  | 8080       | Paper plugin, single instance        |
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
│                  │ │  Map: squaremap iframe        │    │ Selected: Steve    │
│ ┌──────────────┐ │ │   ?world=<selected>           │    │ ─────────────────  │
│ │ Steve   ◄sel │ │ │   markers: bots + POIs        │    │ Model: Sonnet 4    │
│ │ ❤9 🍗7       │ │ │                               │    │ World: landfolk... │
│ │ oak_log      │ │ │  Kanban: swim lanes by status │    │ Spend: $0.12/hr    │
│ │ chopping     │ │ │   (todo · ready · running ·   │    │ Pos: 372, 65,-591  │
│ ├──────────────┤ │ │    blocked · done)            │    │ Holding: oak_log   │
│ │ Reed         │ │ │   from ~/.hermes/kanban.db    │    │ Task: bg_collect   │
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

World selector: All · world · landfolk-test · testflat · world_nether · world_the_end
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
| Click player in left list            | `player`         | Player details         | FPV tab targets that bot     |
| Click bot marker on map              | `player`         | Player details         | FPV tab targets that bot     |
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

**`/api/kanban` payload** (refreshed every 5s when center tab = Kanban, otherwise on-demand):

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

**`/api/poi`** — points of interest aggregated from each bot's `/marks` endpoint, deduped by `(world, name)`, merged with proximity hints. Right-pane POI details: name, world, x/y/z, note, last-visited-by (which bot's marks list contains it).

**Per-bot fetches** (parallel, per tick): `GET /observe?lean=true` provides most of the per-agent fields above. The payload is built in `bot/lib/runtime/observation.js` (`briefState()`, `buildObservePayload()`), reading sliced state as described in **`docs/architecture-map.md`** — *State slices*. For `holding` and equipment we may need to also hit `/inventory` if the lean observe payload proves insufficient — confirm during implementation. For human players, we get presence + position from any nearby bot's `/nearby`.

**OpenRouter** — `GET https://openrouter.ai/api/v1/credits` with `Authorization: Bearer $OPENROUTER_API_KEY`. Returns `{ data: { total_credits, total_usage } }`. Polled every 60s, cached.

**Hermes usage** — `GET http://<hermes-web-host>/api/analytics/usage` (web_server.py:2803-2850). Returns daily/by-model aggregates. To get per-agent spend rate: group sessions by model, map model → agent via `data/agent-models.json`, compute USD spent in trailing 5 min × 12 → USD/hr. Caveat: model-to-agent mapping is ambiguous when two agents share a model (e.g. both Steve and Reed on `claude-sonnet-4`). Document this limitation in v1; v2 can inject agent name into Hermes session metadata.

**Multiverse / world tracking** — at startup, aggregator runs `mv list` via PaperMCP `minecraft_execute_command` to populate `/api/worlds`. Every 30s it runs `mv where <bot_name>` for each online bot to refresh the world cache. The bot's own `bot.game.dimension` (already in `/observe`) is reported alongside as `dimension`. For human players, world is detected from any nearby bot's `/social` or via `mv where <human>` when needed. Frontend world selector filters `agents[]` and `humans[]` client-side by `world === selected` (or shows all when "All" is chosen). Squaremap iframe `src` updates to `?world=<selected>` (or hides when "All").

## Squaremap setup (one-time, manual)

1. Download `squaremap-paper-mc1.21.4-*.jar` from https://github.com/jpenilla/squaremap/releases.
2. `scp` to `ubuntu-host:/opt/stacks/minecraft/data/plugins/`.
3. Add `8080:8080` to ports in `docker/minecraft/docker-compose.yml`.
4. `./scripts/deploy-service.sh minecraft --restart` (from homelab repo).
5. Configure `data/plugins/squaremap/config.yml`: `WEB_ADDRESS: 0.0.0.0`, `LIVE_PLAYER_TRACKER.ENABLED: true`. Squaremap enumerates all worlds Paper has loaded — so Multiverse worlds (`landfolk-test`, `testflat`, `world`, `world_nether`, `world_the_end`) appear automatically with no extra config.
6. Trigger first render for each world: `/squaremap fullrender <world>` via rcon — at minimum `world`, `landfolk-test`, `testflat`.
7. Document in `docs/minecraft.md` and `hermescraft/docs/dashboard.md`.

## Frontend implementation notes

- Single `index.html` with `<script type="module" src="/static/app.js">`.
- `app.js` polls `/api/fleet` every 2s, `/api/worlds` every 30s, and `/api/kanban` every 5s while the Kanban tab is visible. Renders imperatively (no framework). Use template literals + `replaceChildren()` for tile updates.
- Global app state: `{ world: string|'all', selection: {kind, id} | null, centerTab: 'map'|'kanban'|'fpv' }`. Persisted in `localStorage`. Selection drives both right-pane content and (for `kind==='player'`) the FPV iframe src.
- **Left pane (player list)**: rows show name, ❤/🍗 bars, holding, one-line task status. Filtered by selected world (or all). Selected row gets an accent border. Clicking a row sets `selection = {kind:'player', id:name}`.
- **Center tabs**: simple top-of-pane tab strip. Each tab is a separate `<section>`, only one visible.
  - **Map**: `<iframe src="http://<paper-host>:8080/?world=<selected>">`. When "All" is selected, leave squaremap on its default world (it has its own world picker). Bot/player position dots come from squaremap's own live-player-tracker. POIs overlaid as DOM markers on top of the iframe using percentage positioning from `/api/poi` (best-effort; if alignment is brittle, skip overlay for v1 and only render POIs in a sidebar list).
  - **Kanban**: 5-7 column swim-lane board (triage · todo · ready · running · blocked · done · archived). Each card shows title + assignee + status icon. Click → `selection = {kind:'task', id}` and right pane switches.
  - **FPV**: `<iframe id="fpv">` with `src = http://<bot-host>:<viewer_port>` derived from `selection`. Greyed placeholder when no player selected or selection is a human.
- **Right pane**: switches on `selection.kind`. Player details pulls from `/api/fleet` entry + `/inventory` + `/marks` + recent `/observe` extras. Includes the per-bot mineflayer-radar mini-iframe (~250×180). POI details from `/api/poi`. Task details from `/api/kanban/:id`.
- **Chat strip**: docked at the bottom of the right pane, collapsible. Merges `state.new_chat` from each bot's `/observe`, dedupes by (from, message, second-precision ts), shows last 30 with world-tag prefix (e.g. `[lt]`, `[w]`). Toggle to filter to current world.
- Spend rate per player surfaced in left-pane row footer and in right-pane details.

## Reuse from existing code

- Color palette and badge styles: copy from `bot/dashboard.html:8-60` (CSS custom properties).
- Chat merge logic shape: existing `state.new_chat` already pre-merges direct + overheard messages per-bot (`buildObservePayload` in `bot/lib/runtime/observation.js`); just union across bots.
- Fair-play perception is already applied server-side in `/observe` — frontend doesn't re-filter.
- `briefState()` in `bot/lib/runtime/observation.js` gives a card-sized summary per bot (health, food, position, holding, task, top_goal, recent action). This is the per-card data source.

## What is intentionally dropped from the current dashboard

User chose "Replace it" not "Replace, keep deep-dive modal", so v1 has no per-agent reasoning-log modal. The following lose their dedicated UI:

- Reasoning log (`auto_action_log`) — still available via direct `curl bot:3001/observe`, not surfaced in UI.
- Action stats / error rate per 5m — same.
- Task history (last 50) — same.
- Raw observe JSON debug pane — same.

If any of these turn out to be load-bearing during use, we add them back as a per-card "details" drawer in v1.1. Document in `docs/dashboard.md` how to fetch them via curl in the meantime.

## v1 scope cut

Out of scope for v1, explicitly:

- Kanban write actions (create/move/edit tasks). v1 is read-only; right-pane shows details but no buttons. v2 adds POST endpoints that shell out to `hermes kanban`.
- Per-bot reasoning log / action stats modal.
- POI marker overlay on squaremap iframe — if alignment is brittle (iframe coordinate translation), fall back to a POI list inside the Map tab. Squaremap's own player tracker covers live bot positions.
- Per-model `$/Mtok` reference cards.
- Cumulative session cost in headline (per-row only).
- Bot discovery via port-scan fallback (registry file is required for v1).
- Civilization-mode FPV/radar (env-gated off; only landfolk mode gets it in v1).

## Implementation phases

Each phase is independently testable — the dashboard is usable at the end of every phase, with strictly more features than the previous one. Easiest/lowest-risk first; the heaviest dependencies (server-side plugin install, native npm builds) are pushed late so a stumble there doesn't block earlier wins. The old `bot/dashboard.html` stays live and reachable at `bot:3001/dashboard` until the very last phase, so we always have a fallback.

### Phase 1 — Skeleton: aggregator, left pane, right pane player details

**Goal:** standalone dashboard at `http://localhost:3000` that lists every online bot with live stats, and shows player details on click. No center pane content yet (just "Map / Kanban / FPV — coming" placeholders). No bot changes. No external deps.

**Build:**
- `dashboard/server.js` — minimal HTTP server: serves `index.html` + static files; `/api/fleet` polls each bot's `/observe?lean=true` in parallel every 2s and merges.
- `dashboard/lib/registry.js` + `data/agent-registry.json` — agent roster.
- `dashboard/lib/poll.js` — parallel poller with timeouts and online/offline flagging.
- `dashboard/index.html` + `static/app.js` + `static/style.css` — three-pane layout, left list, right details pane (player kind only), center placeholder.
- `dashboard/start-dashboard.sh` — launcher.

**Test:**
- `./scripts/run-landfolk-bots.sh <PORT>` then `./start-dashboard.sh`. Open `http://localhost:3000`.
- Left pane shows 5 bots with health/food/holding/task; offline bots greyed.
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
- Header dropdown: All + each world from `/api/worlds`.
- Left-pane filter by selected world; selection state persisted.

**Test:**
- `mv list` matches dropdown contents.
- All 5 landfolk bots show `world: landfolk-test` (or wherever they spawned).
- `mv tp Steve testflat` via rcon → within 30s, Steve's row moves to `testflat` filter.
- Selecting "All" shows every bot regardless of world.

### Phase 4 — Center pane: Map tab (squaremap)

**Goal:** center pane Map tab embeds squaremap; switching world selector retargets the iframe.

**Build (server-side):**
- Install squaremap Paper plugin on ubuntu-host minecraft container (see "Squaremap setup" section above).
- Expose port 8080 in `docker/minecraft/docker-compose.yml`.
- Trigger `fullrender` for `world`, `landfolk-test`, `testflat`.

**Build (dashboard):**
- Center Map tab: `<iframe src="http://<paper-host>:8080/?world=<selected>">`.
- World selector change updates iframe src.

**Test:**
- Map renders, all five worlds reachable via the dropdown.
- Bot positions show up as squaremap's own live-player markers.
- Switching worlds in the header updates the iframe within one second.
- If `X-Frame-Options: DENY` appears, document and add `/api/squaremap/*` proxy in phase 4.1.

### Phase 5 — Per-bot radar in right pane

**Goal:** right pane player details include the bot's mineflayer-radar mini-tile.

**Build:**
- `bot/package.json` — add `mineflayer-radar`.
- `bot/lib/runtime/manager.js` — env-gated `RADAR_PORT` opt-in: inside the existing `bot.once('spawn', …)` callback, call `bot.loadPlugin(require('mineflayer-radar'))` when `RADAR_PORT` is set (after spawn so the live `bot` instance is available).
- `scripts/run-landfolk-bots.sh`, `landfolk.sh` — set `RADAR_PORT=$((5000 + i))` per bot.
- Right pane: add `<iframe class="radar-mini" src="http://<bot-host>:<radar_port>">` (~250×180) when selected entity is a bot with a radar port.

**Test:**
- `./start-steve.sh` with no env → no port 5001 listening; nothing breaks.
- With `RADAR_PORT=5001` → `curl localhost:5001` returns the radar page; clicking Steve in the dashboard shows his radar mini-iframe.

### Phase 6 — Per-bot FPV in center pane

**Goal:** center pane FPV tab streams the currently-selected bot's first-person view.

**Build:**
- `bot/package.json` — add `prismarine-viewer`.
- `bot/lib/runtime/manager.js` — env-gated `VIEWER_PORT` opt-in in the **same** `bot.once('spawn', …)` path as phase 5: `await import('prismarine-viewer').then(({ mineflayer }) => mineflayer(bot, { port, firstPerson: true }))` when `VIEWER_PORT` is set.
- `scripts/run-landfolk-bots.sh`, `landfolk.sh` — set `VIEWER_PORT=$((4000 + i))`.
- Center FPV tab: `<iframe id="fpv">` whose `src` comes from `selection.viewer_port`; greyed placeholder when no bot selected or selection is a human.

**Test:**
- `VIEWER_PORT=4001 ./start-steve.sh` → `curl localhost:4001` returns the prismarine-viewer page.
- Select Steve in left pane → center FPV tab → live 3D view of Steve's surroundings updates as he moves.
- Selection = human (re44) → FPV tab shows "no FPV for human players" placeholder.

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

### Phase 8 — Kanban tab + POI overlay + task details

**Goal:** center Kanban tab renders the Hermes kanban board; clicking a card opens task details in the right pane. POIs aggregated for map markers.

**Build:**
- `dashboard/package.json` adds `better-sqlite3` (fallback: `sql.js` if native build is unhappy).
- `dashboard/lib/kanban.js` — read-only open of `~/.hermes/kanban.db`; group by status; pin to documented columns; fail-soft on schema drift.
- `/api/kanban` (5s poll while tab visible) + `/api/kanban/:id` endpoints.
- `dashboard/lib/poi.js` + `/api/poi` — union of each bot's `/marks`, deduped by (world, name).
- Center Kanban tab: swim lanes (triage · todo · ready · running · blocked · done · archived). Card click → `selection = {kind:'task', id}` → right pane shows task details.
- Right pane: POI details mode (clicking a POI in the Map tab POI sidebar list).

**Test:**
- Kanban tab renders all current tasks grouped correctly.
- Click a task → right pane shows title, body/spec, comments, event timeline.
- Create a task via `hermes kanban create ...` → appears within 5s.
- Schema drift sim: rename a column in a sandbox DB → dashboard renders "kanban schema changed" instead of crashing.

### Phase 9 — Retire the old dashboard

**Goal:** old `bot/dashboard.html` and `/dashboard` endpoint redirect to the new aggregator; `mc dashboard` CLI opens the new URL.

**Build:**
- `bot/lib/server/http-app.js:402-410` — replace `/dashboard` handler with `302` → `${DASHBOARD_URL:-http://localhost:3000}`.
- `bin/mc` `dashboard` subcommand → opens `$DASHBOARD_URL`.
- Delete `bot/dashboard.html` from the codebase (git history retains it).
- `bot/test/integration/listener-health.test.js` — update or remove the `dashboardHtmlPath` mock: it assumes the old static `/dashboard` handler; after the 302, the test should assert redirect behavior (or stop stubbing that path).
- `bot/test/dashboard-reasoning-format.test.js` — drop or repoint.
- `docs/dashboard.md` — operational notes (running, port map, squaremap install, troubleshooting).
- `hermescraft/README.md` — point at `docs/dashboard.md`.

**Test:**
- `curl -I localhost:3001/dashboard` → `302 Location: http://localhost:3000`.
- `mc dashboard` opens browser at the new URL.
- `cd bot && npm test` passes.
- `node --check bot/server.js`, `bash -n` on all touched shell scripts.

### Phase ordering rationale

| Phase | New deps | Server-side change | Risk | Visible value |
|-------|---------|--------------------|------|---------------|
| 1     | none    | no                 | low  | functional dashboard |
| 2     | none    | no                 | low  | balance number |
| 3     | none    | no (uses PaperMCP) | low  | world filter |
| 4     | none    | **squaremap install** | med | the map |
| 5     | `mineflayer-radar` | no       | low  | radar tiles |
| 6     | `prismarine-viewer` | no      | med (port/asset weight) | the FPV |
| 7     | none    | no                 | low  | $/hr per agent |
| 8     | `better-sqlite3` | no        | med (native build) | kanban |
| 9     | none    | no                 | low  | cleanup |

## Risks & landmines

- **prismarine-viewer in headless Node**: it bundles a Three.js WebGL renderer for the browser side, but server-side it just streams world state. Confirm it works in itzg/minecraft-server's network setup (the bots are on Mac, not server-side, so this is fine — but worth a smoke test on the first run).
- **Port pressure**: 5 bots × 3 ports each = 15 ports for landfolk; manageable. Civilization (7 bots) intentionally skips viewer/radar to avoid 21 ports.
- **OpenRouter `/credits` rate limit**: 60s poll cadence is conservative. If the endpoint changes shape, fail soft (show "—" not crash).
- **Hermes usage attribution ambiguity**: two agents on the same model → can't split their spend. Note in `docs/dashboard.md`; v2 fix is injecting agent name into session metadata.
- **squaremap CSP**: some Paper plugin web servers set `X-Frame-Options: DENY` which would block the iframe. If so, fall back to a link-out tile or proxy through the aggregator (`/api/squaremap/*` strips the header).
- **Schema drift on `/observe`**: the aggregator should fail soft if any expected field is missing (treat as `null`, don't crash the page).
- **`mv where` parsing**: `mv where` output is human-formatted with color codes (e.g. `[34mlandfolk-test - [32mNORMAL`). Strip ANSI + parse the world name. If the command format changes in a future Multiverse update, fall back to mapping via `bot.game.dimension` + a per-bot launch-time `MC_WORLD` env var.
- **World-change latency**: world tracking is on a 30s refresh; teleports won't appear instantly. Acceptable for v1. v2 could subscribe to PaperMCP events if/when streaming is supported.
- **Kanban schema drift**: pinning to `id, title, status, assignee, board, created_at, updated_at` columns means a Hermes upgrade that renames columns will break the panel. The aggregator should catch `SQLITE_ERROR: no such column` and render a degraded "kanban schema changed — see logs" message rather than crash.
- **better-sqlite3 native build**: adding it means `npm install` needs a build toolchain on whatever host runs the aggregator. Documented as a prereq. (Alternative: `sql.js` pure-WASM, slower but no native deps — keep in pocket.)
