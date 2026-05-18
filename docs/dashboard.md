# HermesCraft dashboard

Standalone fleet UI served by `dashboard/server.js` (default port **3000**). It polls each bot’s HTTP API (`/health`, `/observe?lean=true`) and optional Hermes Kanban Bridge (`HERMES_KANBAN_BASE`).

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
| `BOT_HOST` | `127.0.0.1` | Host for bot APIs (same machine as bots in typical LAN setups) |
| `HERMES_KANBAN_BASE` | `http://127.0.0.1:27124` | [Hermes Kanban Bridge](https://github.com/GumbyEnder/hermes-kanban) REST API |
| `OPENROUTER_API_KEY` | — | Optional; else read from `secrets.yaml` (`openrouter_api_key`) |

## FPV (prismarine-viewer)

No extra **Minecraft/Paper plugins** are required: the viewer streams from the **mineflayer bot** already connected to your server.

1. Start each bot with **`VIEWER_PORT`** set (Landfolk: **`api_port + 1000`**, e.g. 3001 → 4001). `landfolk.sh` and `scripts/run-landfolk-bots.sh` do this.
2. Match **`viewer_port`** in `data/agent-registry.json` to the same ports (so the dashboard builds the iframe URL).
3. Open the **FPV** tab, select an **online** agent.
4. If the iframe is blank: check the bot log for `prismarine-viewer` errors and confirm `curl http://127.0.0.1:4001` returns HTML on the bot host.
5. Remote browser: set dashboard **`BOT_HOST`** to the machine running the bots so `http://BOT_HOST:viewer_port` is reachable (firewall permitting).

If you **disable** the viewer for a bot, unset `VIEWER_PORT` for that process and set `"viewer_port": null` for that agent in the registry so the dashboard does not point at a dead port.

## Minecraft server

Nothing special on the MC side beyond normal **offline/online** access for the bot account. The Command Center schematic **Map** tab does not use Squaremap or any tile plugin; it only plots bots / POIs from Hermes data.

- **Roster:** `data/agent-registry.json` — agents, default world, world list, optional `kanbanBoardIdsByWorld` (board path per world, e.g. `Kanban/world.md`).
- Tune `world` per agent when using Multiverse; the dashboard filters the left list to **online** agents in the selected world.

### Squaremap (optional — server-side 2D tiles)

Hermes does not bundle Squaremap. If you want a browsable **world map in the browser** (tiles, pan/zoom), install and run it on the **Paper/Folia** server (or compatible fork).

1. **Compatibility** — Use a Squaremap build that matches your Minecraft version. [Squaremap on Modrinth](https://modrinth.com/plugin/squaremap) lists supported platforms (Paper/Folia) and versions.

2. **Install** — Download the plugin `.jar` and place it in the server’s `plugins/` folder.

3. **First start** — Restart the server. Squaremap creates `plugins/squaremap/` with `config.yml` and per-world settings under `plugins/squaremap/worlds/`.

4. **Web interface** — By default the plugin runs a small HTTP server (often **port 8080**). In `config.yml`, check the internal webserver `bind` address (`0.0.0.0` for all interfaces on LAN) and `port`. Open `http://<server-host>:<port>/` in a browser.

5. **Rendering** — Worlds render over time; large maps are heavy on first render. Ensure the target world is enabled and wait for tiles to appear.

6. **Security** — If the map is reachable from the internet, put it behind a reverse proxy with HTTPS and access control; do not expose an unauthenticated control surface.

7. **Using it with Hermes** — Keep Squaremap in a separate browser tab for now. The dashboard Map tab remains a tactical overview (positions + POIs). A future improvement could embed Squaremap via iframe using a configurable base URL.

## Sanity checks

```bash
node --check dashboard/server.js
bash -n start-dashboard.sh
```
