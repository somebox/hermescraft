# HermesCraft dashboard

Standalone fleet UI served by `dashboard/server.js` (default port **3000**). It polls each bot’s HTTP API (`/health`, `/observe?lean=true`) and optional Hermes Kanban Bridge (`HERMES_KANBAN_BASE`).

The legacy per-bot `bot/dashboard.html` and `GET /dashboard` on bot API ports are removed. Use this command center only (`mc dashboard` prints its URL).

## Run

From repo root:

```bash
chmod +x start-dashboard.sh   # once
./start-dashboard.sh
```

Open `http://127.0.0.1:3000`.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `DASHBOARD_PORT` | `3000` | Aggregator listen port |
| `DASHBOARD_URL` | `http://127.0.0.1:3000` | Full URL for `mc dashboard` (override for LAN) |
| `BOT_HOST` | `127.0.0.1` | Host for bot APIs (same machine as bots in typical LAN setups) |
| `HERMES_KANBAN_BASE` | `http://127.0.0.1:27124` | [Hermes Kanban Bridge](https://github.com/GumbyEnder/hermes-kanban) REST API |
| `OPENROUTER_API_KEY` | — | Optional; else read from `secrets.yaml` (`openrouter_api_key`). Header balance/usage use [GET /api/v1/key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key) (`limit_remaining`, `usage`, `usage_daily`); falls back to `/api/v1/credits` if needed. |
| `WORLD_MAP_BASE_URL` | — | Overrides `worldMap.baseUrl` in `data/agent-registry.json` (Dynmap / Squaremap web UI) |
| `BOT_DISCOVERY_PORT_MIN` | `3000` | Low end of local port scan for Hermes bot `/health` (dashboard port excluded) |
| `BOT_DISCOVERY_PORT_MAX` | `3024` | High end of port scan |
| `BOT_DISCOVERY_PORTS` | — | Comma-separated extra API ports to probe (e.g. `3010,3011`) |

### Agents and players (discovery)

**Agents** in the left column come from `data/agent-registry.json` plus any **discovered** Hermes bots: each fleet poll probes `BOT_DISCOVERY_*` ports on `BOT_HOST` for `GET /health` with `{ ok, username }` (same shape as landfolk bots). A connected body on a port that is not already used by the registry (e.g. **Steward** on `:3005`) is polled like a registry agent — goals, FPV, Mind, and detail work without adding a registry row.

**Players** are built from bot `/nearby` (Minecraft `username`) and Squaremap/Dynmap marker JSON for the selected world. Names that match any registry or discovered agent MC username stay in **Agents**, not **Players**.

Registry rows remain the place for stable metadata (kanban board mapping, default world, viewer overrides). Discovery is for bodies that are online but not listed yet.

## FPV (prismarine-viewer)

No extra **Minecraft/Paper plugins** are required: the viewer streams from the **mineflayer bot** already connected to your server.

1. Start each bot with **`VIEWER_PORT`** set (Landfolk: **`api_port + 1000`**, e.g. 3001 → 4001). `scripts/run-landfolk-bots.sh` and `scripts/landfolk-control.sh` do this.
2. Match **`viewer_port`** in `data/agent-registry.json` to the same ports (so the dashboard builds the iframe URL).
3. Open the **FPV** tab, select an **online** agent.
4. If the iframe is blank: check the bot log for `prismarine-viewer` errors and confirm `curl http://127.0.0.1:4001` returns HTML on the bot host.
5. Remote browser: set dashboard **`BOT_HOST`** to the machine running the bots so `http://BOT_HOST:viewer_port` is reachable (firewall permitting).

Each Landfolk bot uses **`VIEWER_PORT = api_port + 1000`** when started via `scripts/landfolk-control.sh` or `run-landfolk-bots.sh` (Flint → **4002**, not 4001). Port **4001** is only Steve/Gatherer on API **3001**. Select the agent whose bot is actually running, then open FPV.

If the iframe is blank but the viewer URL works in a new tab, use **Open FPV in new tab** under the FPV panel.

If you **disable** the viewer for a bot, unset `VIEWER_PORT` for that process and set `"viewer_port": null` for that agent in the registry so the dashboard does not point at a dead port.

## Minecraft server

Nothing special on the MC side beyond normal **offline/online** access for the bot account.

- **Roster:** `data/agent-registry.json` — agents (Steve companion + Landfolk workers), default world, world list.
- Tune `world` per agent when using Multiverse; the dashboard filters the left list to **online** agents in the selected world.

### Map tab (terrain iframe)

The center tabs are **Map**, **FPV**, and **Kanban**. **Map** embeds the Squaremap / Dynmap-style web UI in an iframe when `worldMap` is configured (e.g. `http://192.168.1.202:8123/?world=minecraft_overworld&zoom=4`). The world selector drives the iframe `world` query param via `worldMap.hermesToTileWorld` in the registry (Hermes world name → plugin key such as `minecraft_overworld`). Pan/zoom inside the iframe are not readable by the dashboard (one-way control).

Configure in `data/agent-registry.json`:

```json
"worldMap": {
  "baseUrl": "http://192.168.1.202:8123",
  "hermesToTileWorld": {
    "world": "minecraft_overworld",
    "landfolk-test": "minecraft_landfolk-test"
  },
  "iframeDefaults": { "zoom": 4 },
  "tile": { "minZoom": 0, "maxZoom": 3, "tileSize": 512 }
}
```

The dashboard proxies CORS-blocked JSON for future use:

- `GET /api/map/config` — mapping + tile defaults for the browser
- `GET /api/map/settings` — upstream `tiles/settings.json` (world list)
- `GET /api/map/players?world=<hermesWorld>` — upstream player markers JSON

Tile images do not need CORS; only `fetch()` from the browser does.

### Squaremap / Dynmap (optional — server-side 2D tiles)

Install a tile map plugin on **Paper/Folia** (Squaremap, Dynmap, etc.). Point `worldMap.baseUrl` at its HTTP port. If the UI is only on LAN, use the LAN IP in the registry so browsers on other machines can load the iframe and tiles.

1. Match plugin version to your Minecraft version.
2. Enable worlds and wait for initial renders.
3. Restrict exposure on untrusted networks (reverse proxy, auth).

Hermes does not ship the plugin; it only links and proxies JSON when configured.

#### Map zoom (Squaremap)

The dashboard iframe does **not** cap zoom — limits come from **Squaremap on the Minecraft server**. The UI reads `http://<map-host>/tiles/<tile-world>/settings.json` (exposed on `GET /api/map/config` as `worldZoomByHermes`) and shows the current range under the map.

Example for `minecraft_overworld` today:

```json
"zoom": { "def": 3, "max": 3, "extra": 2 }
```

- **`max`** — highest zoom level with native tiles (sharp). Raise this in Squaremap’s world config on the **MC server** (under `plugins/squaremap/`, world-specific settings; exact file layout depends on Squaremap version), then run a **full render** for that world so new zoom levels exist (`/squaremap fullrender <world>` or the plugin’s equivalent).
- **`extra`** — additional “overzoom” steps beyond `max` (scaled tiles, less sharp). Safe to bump if you only need a bit more pinch-zoom without re-rendering.
- **`iframeDefaults.zoom`** in `agent-registry.json` — **starting** zoom when the dashboard loads the iframe (clamped to `max + extra`). Use e.g. `"zoom": 5` to open closer when `max` 3 and `extra` 2 allow UI zoom 5.

The registry `worldMap.tile.maxZoom` field is for a possible future native Leaflet map in Hermes; it does **not** change Squaremap’s iframe.

## Kanban (steward ops)

The center **Kanban** tab reads cards from [Hermes Kanban Bridge](https://github.com/GumbyEnder/hermes-kanban) (`HERMES_KANBAN_BASE`, default `http://127.0.0.1:27124`) when it is running. If the bridge is down, the dashboard **falls back** to `hermes kanban --board <id> list --json` on the same machine (requires `hermes` on `PATH`, same board as `hermes kanban list`).

Configure in `data/agent-registry.json`:

```json
"defaultKanbanBoardId": "landfolk-ops",
"kanbanBoardIdsByWorld": {
  "world": "landfolk-ops",
  "landfolk-test": "default"
}
```

- **World** selector picks the board via `kanbanBoardIdsByWorld`, with fallback to `defaultKanbanBoardId`.
- **Board** dropdown can override (stored in browser localStorage).
- **Refresh** reloads cards; **Nudge dispatch** runs `hermes kanban --board <id> dispatch` on the dashboard host (one pass — does not decompose triage; use `hermes gateway start` for auto-decompose).
- Click a card for title, assignee, and body in the right **Details** panel.
- With an **agent** selected, the **Kanban** section in Details shows that agent’s best-matching card (prefer **running**, then ready/todo) by **assignee** name. **Show full card** opens the Kanban tab and selects the card.

Verify:

```bash
curl -s 'http://127.0.0.1:27124/boards' | jq '.boards[].id'
curl -s 'http://127.0.0.1:3000/api/kanban?world=world' | jq '.ok, .boardId, (.tasks | length)'
```

Kanban data for the dashboard uses `fetchBoardWithFallback` in `dashboard/lib/kanban.js`: it tries the Hermes kanban HTTP bridge at `HERMES_KANBAN_BASE` first, then falls back to `hermes kanban … --json` CLI if the bridge is down or returns an error. Board list endpoints use the same pattern via `fetchBoardsListWithFallback`.

Hermes’s native kanban UI (if enabled) is separate from this command center (`http://127.0.0.1:9119` in steward docs).

## Detail panel: goals and mind

The right **Details** pane combines bot truth (goals engine, tasks, observe) with a read-only tail of the Hermes LLM session.

### Goals stack

- Full scored goals come from the bot: `GET /api/agent/<name>/goals` proxies `GET /goals?full=true` on that bot’s API port.
- The UI shows urgency-sorted rows with progress toward `target_ok`, deficit time, and up to four **strategy** chips from each goal’s `strategies_available` preset field.
- Fleet poll still uses lean observe for position/task; goals refresh about every 8s while an agent stays selected.

Verify (bot online on port 3001, name Steve):

```bash
curl -s 'http://127.0.0.1:3001/goals?full=true' | jq '.data.goals[0].id, .data.goals[0].urgency'
curl -s 'http://127.0.0.1:3000/api/agent/Steve/goals' | jq '.ok, (.goals | length)'
```

### Mind stream (Hermes session — like `watch-agent.py`)

- Reasoning, tools, and prompts are **not** on the bot API; they live in Hermes session JSON under `HERMES_HOME/sessions/session_*.json`.
- The dashboard picks the active home like `scripts/watch-agent.py --auto`: newest session between `~/.hermes-landfolk-<name>` and `~/.hermes/profiles/<name>` (kanban workers). Override landfolk home with `hermes_home` in `data/agent-registry.json`.
- `GET /api/agent/<name>/cognition?tail=1&limit=24` returns the last turns: **USER**, reasoning (**·**), **AGENT** text, **⚙** tool calls, **← / ✗** tool output (same parsing as `watch-agent.py`).
- Chat strip: **In-game** — chat heard by the **selected online agent** (`new_chat` from observe) plus world lines from that bot. **Mind** — Hermes tail; empty when no agent selected or agent offline. Poll every **5s** on the Mind tab.

Compare with CLI:

```bash
scripts/watch-agent.py --agent flint --auto --tail 20
curl -s 'http://127.0.0.1:3000/api/agent/Flint/cognition?tail=1&limit=24' | jq '.home_label, .session, [.turns[].kind]'
```

### Live strip and activity (fleet poll)

The **live strip** is at the top of the lower **Log** pane (below Map / FPV / Kanban) and shows equipped item, position, world clock and motion, task, vitals, and related telemetry. The right panel shows agent name with online/world/model badges, in-game session, **Goals**, inventory, **recent actions**, and **reactive** log lines.

## Sanity checks

```bash
node --check dashboard/server.js
cd dashboard && npm test
bash -n start-dashboard.sh
```
