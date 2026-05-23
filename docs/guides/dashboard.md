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

## FPV (prismarine-viewer)

No extra **Minecraft/Paper plugins** are required: the viewer streams from the **mineflayer bot** already connected to your server.

1. Start each bot with **`VIEWER_PORT`** set (Landfolk: **`api_port + 1000`**, e.g. 3001 → 4001). `scripts/run-landfolk-bots.sh` and `scripts/landfolk-control.sh` do this.
2. Match **`viewer_port`** in `data/agent-registry.json` to the same ports (so the dashboard builds the iframe URL).
3. Open the **FPV** tab, select an **online** agent.
4. If the iframe is blank: check the bot log for `prismarine-viewer` errors and confirm `curl http://127.0.0.1:4001` returns HTML on the bot host.
5. Remote browser: set dashboard **`BOT_HOST`** to the machine running the bots so `http://BOT_HOST:viewer_port` is reachable (firewall permitting).

If you **disable** the viewer for a bot, unset `VIEWER_PORT` for that process and set `"viewer_port": null` for that agent in the registry so the dashboard does not point at a dead port.

## Minecraft server

Nothing special on the MC side beyond normal **offline/online** access for the bot account.

- **Roster:** `data/agent-registry.json` — agents (Steve companion + Landfolk workers), default world, world list.
- Tune `world` per agent when using Multiverse; the dashboard filters the left list to **online** agents in the selected world.

### Map tab: Tactical vs Terrain

| Sub-tab | Source | Purpose |
|---------|--------|---------|
| **Tactical** | Hermes fleet + POIs | Low-fidelity X/Z canvas; click to select agents/POIs |
| **Terrain** | Dynmap / Squaremap-style web UI | Full tile map in an iframe when `worldMap` is configured |

**Tactical** does not load map tiles. **Terrain** embeds the plugin UI (e.g. `http://192.168.1.202:8123/?world=minecraft_overworld&zoom=4`). The world selector drives the iframe `world` query param via a single mapping table in the registry (`worldMap.hermesToTileWorld`: Hermes world name → plugin key such as `minecraft_overworld`). Pan/zoom inside the iframe are not readable by the dashboard (one-way control); native Leaflet against `/tiles/{world}/{z}/{x}_{y}.png` is the path when you need bidirectional state or Hermes overlays.

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

### Mind stream (Hermes thinking)

- Reasoning and tool calls are **not** on the bot API; they live in Hermes `HERMES_HOME/sessions/session_*.json`.
- Default home per agent: `~/.hermes-landfolk-<nameLower>` (same as `scripts/landfolk-control.sh`). Override with optional `hermes_home` on that agent in `data/agent-registry.json` (supports `~/…` paths).
- Dashboard: `GET /api/agent/<name>/cognition?limit=15&cursor=N` reads the **most recently updated** Hermes session file under that agent’s `HERMES_HOME` (by JSON `last_updated`, not directory mtime alone), then returns truncated turns (`think`, `say`, `tool`, `tool_result`) from message index `cursor` onward.
- Chat strip sub-tabs: **In-game** (Minecraft chat from fleet observe) | **Mind** (last few Hermes `think` / `say` lines from the active session tail). Mind is **empty** when no bots are online or the selected agent is offline. It refreshes at most every **5s** while the Mind tab is open and only re-renders when the tail text changes (no auto-scroll carousel). `GET …/cognition?tail=1&limit=8` returns the last turns from the most recently updated session file.

Verify:

```bash
curl -s 'http://127.0.0.1:3000/api/agent/Steve/cognition?limit=5' | jq '.ok, .session, (.turns | length)'
```

### Live strip and activity (fleet poll)

The **live strip** sits directly under Map / Kanban / FPV (not pinned to the viewport bottom) and shows equipped item, position, world clock and motion, task, vitals, and related telemetry. The right panel shows agent name with online/world/model badges, in-game session, **Goals**, inventory, **recent actions**, and **reactive** log lines.

## Sanity checks

```bash
node --check dashboard/server.js
cd dashboard && npm test
bash -n start-dashboard.sh
```
