# HermesCraft scripts

Operational and launcher glue. **Current direction** for multi-agent Landfolk is `landfolk-control.sh` plus `data/agent-models.json` and `resolve-agent-model.py`. Older root launchers remain for quick starts and backward compatibility; they do not define the consolidated config model.

## Design direction: `landfolk-control.sh`

Single orchestrator for the Landfolk cast: `start`, `stop`, `status`, `enable`, `disable` (and aliases). Intent:

- **Per agent**: start the bot (`node server.js` under `bot/`), wait for a healthy Minecraft connection, start the Hermes loop with the right `MC_API_URL` / `MC_USERNAME`, then attach a **watchdog** that polls health, task, and observe payloads—cancel stuck work, react to danger, and append structured progress lines (default under `/tmp/hermescraft`).
- **Single roster source**: agent names, per-agent `api_port`, `model`, `provider`, and roles come from `data/agent-models.json`, resolved through `scripts/resolve-agent-model.py` so ports and models do not drift across terminals.

Environment: typically `.env` at repo root for keys and shared defaults; control script sets Minecraft host/port and tuning knobs the bots and agents inherit.

## Configuration model

- **`data/agent-models.json`** — canonical roster: `agents` (name → model, provider, optional `api_port`, `role`), `defaults`, `landfolk.base_api_port` (and optional `entrypoints` for other flows).
- **`scripts/resolve-agent-model.py`** — one resolver for the repo; subcommands include `agent-names`, `api-port`, `roster-lines`, `defaults`, `entrypoint`. Other scripts should call this instead of hardcoding ports or models.
- **Identity and goals** — character text in `prompts/landfolk/`; `SOUL-landfolk.md` copied into each agent’s `HERMES_HOME`; goal *presets* live under `data/goal-presets/` and merge into per-username goal files under `data/` when agents run `mc goal_load`.

## Supporting scripts

| Script | Role |
|--------|------|
| `resolve-agent-model.py` | Port and model/provider resolution from JSON + env. |
| `analyze-progress-logs.sh` | Read-only summaries over watchdog progress JSONL. |
| `run-landfolk-agent.sh` | Thin Hermes launcher once a bot is listening on a known port. |
| `setup-landfolk-profiles.sh` | Phase 2 workers + steward ops: profiles, `landfolk-ops` board, kanban config; `--solo-flint` for one-bot testing; `--apply-config` to refresh SOUL/skills/max_turns only (see `docs/design/phase-3/steward-mvp.md`). |
| `ledger-update.py` | Fold completed ops-board task metadata into `data/ops/logistics-ledger.yaml`. |
| `blueprint-plan.py` | GrabCraft URL → build plan JSON (substitutions, phases); steward skill `minecraft-steward-blueprint-plan`. |
| `watch-agent.py` | Tail Hermes session JSON for any Landfolk agent (`--agent flint`, etc.). |
| `cleanup-locations.py` | Remove accumulated `death_*` marks from `data/locations-*.json` (see `--keep-recent-deaths`). |

Other files in `scripts/` (`run-landfolk-bots.sh`, etc.) support older split bot/agent workflows; prefer `landfolk-control.sh` when you want one supervised fleet.

## Other launchers (repo root)

- `hermescraft.sh` / `start-steve.sh` — Steve companion (single bot)
- `start-gatherer.sh` — goal-directed Gatherer only
- `start-landfolk.sh` — multi-agent Landfolk from `agent-models.json` roster
- `scripts/run-landfolk-bots.sh` — bot bodies only (Gatherer, Flint, Mason, Barley)

Prefer `landfolk-control.sh` for a supervised fleet with watchdogs.

## Minecraft server expectations

- Java server (Paper **1.21.x** or compatible with your Mineflayer pin) at `MC_HOST:MC_PORT`.
- **Offline bots**: `online-mode=false` where applicable; Spigot/Paper **`connection-throttle: 0`** in `bukkit.yml` to avoid reconnect storms with bot clients.
- **PaperMCP** (optional): plugin + `PAPERMCP_*` env if world actions should run console commands through the bridge.
- **`server/start.sh`**: in-repo helper to run a local Paper stack; align game version with `bot/package.json` dependencies.
