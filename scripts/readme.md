# HermesCraft scripts

Operational and launcher glue. The supported entry point for the Landfolk
sub-project is **`scripts/landfolk`** — one CLI for the whole session
(players + daemons + kanban hygiene).

## `scripts/landfolk` — single CLI

One verb taxonomy, one roster file (`/tmp/hermescraft/active-players`,
upgraded automatically from the old `active-profiles`), one state dir
(`/tmp/hermescraft/state/`, migrated from `session-state/` on first run).

| Verb | Purpose |
|------|---------|
| `start [--players a,b,c] [--mode kanban\|continuous] [--without daemons]` | Bring players + daemons up |
| `stop  [--players a,b,c] [--keep daemons] [--with-gateway] [--no-reclaim]` | Tear down; reclaims running kanban cards by default |
| `enable <player> [--mode ...]` | Add one player to the roster and start it |
| `disable <player>` | Reclaim its cards, stop it, prune from roster |
| `restart <target>` | `<player>` \| `players` \| `daemons` \| `listener` \| `supervisor` \| `pauser` \| `gateway` \| `all` |
| `status [--json]` | MC reachability + per-player health + daemons + gateway + roster |
| `logs [agents\|<player>\|listener\|supervisor\|pauser\|gateway]` | Aggregated agent stream (default) or one-component tail |
| `chat <player> "<msg>"` | Send in-game chat through the bot's HTTP API |
| `fix <issue> [args]` | `reconnect <p>` \| `clean` \| `tp <p> x y z` \| `unstick <p>` |
| `players list \| show <player>` | Roster + per-player port/role/model resolution |
| `defaults` | Print the plan `start` would use with no flags |

**Modes (per player):**
- `auto` (**default**) — picks per role: `orchestrator` → `continuous`, anything else → `kanban`.
- `kanban` — bot + connect-only watchdog; **no agent**. Kanban gateway workers drive the bot per card.
- `continuous` — bot + full watchdog + always-on Hermes agent loop.

**Sticky roster.** `enable <p>` and `disable <p>` modify the roster
durably; `stop` does NOT clear it (use `stop --clear-roster` to wipe).
`start` brings up whatever's in the roster (or seeds from
`PLAYERS_DEFAULT` if empty).

**Defaults** (`scripts/landfolk defaults` prints these on demand):

- `PLAYERS_DEFAULT=flint,mason,steward` (only used when roster is empty)
- `LANDFOLK_DEFAULT_MODE=auto`
- daemons on by default: `listener` only (`supervisor` and `pauser` opt in via `landfolk restart` or flags)
- gateway: started by `landfolk start` by default; use `--no-gateway` to leave running gateway untouched
- `MC_HOST=192.168.1.202`, `LOG_DIR=/tmp/hermescraft`

`scripts/landfolk-session.sh` is a deprecation shim that forwards old verbs.
`scripts/landfolk-control.sh` is the **internal engine** (per-bot lifecycle:
bot + watchdog + optional Hermes agent). It's still callable for debug,
but day-to-day use goes through `scripts/landfolk`.

## Configuration model

- **`data/agent-models.json`** — canonical roster: `agents` (name → model,
  provider, optional `api_port`, `role`), `defaults`, `landfolk.base_api_port`.
- **`scripts/resolve-agent-model.py`** — single resolver; subcommands:
  `agent-names`, `api-port`, `roster-lines`, `defaults`, `entrypoint`.
  All other scripts (including `landfolk`) consult it for ports and models
  instead of hardcoding them.
- **Identity and goals** — character text in `prompts/landfolk/`;
  `SOUL-landfolk.md` copied into each agent's `HERMES_HOME`; goal *presets*
  live under `data/goal-presets/` and merge into per-username goal files
  under `data/` when agents run `mc goal_load`.

## Supporting scripts

| Script | Role |
|--------|------|
| `resolve-agent-model.py` | Port and model/provider resolution from JSON + env. |
| `landfolk-control.sh` | Internal engine: per-bot start/stop/status, watchdog, optional agent. Supports `--no-agent` for kanban mode. |
| `landfolk-logs-aggregate.py` | Multi-profile session-log tailer used by `landfolk logs`. |
| `analyze-progress-logs.sh` | Read-only summaries over watchdog progress JSONL. |
| `run-landfolk-agent.sh` | Thin Hermes launcher once a bot is listening on a known port. |
| `setup-landfolk-profiles.sh` | Phase 2 workers + steward ops: profiles, `landfolk-ops` board, kanban config; `--solo-flint` for one-bot testing; `--apply-config` to refresh SOUL/skills/max_turns only (see `docs/design/phase-3/steward-mvp.md`). |
| `inactive-cards-pauser.py` / `steward-supervisor.py` / `steward-chat-listener.py` | Optional operator daemons; listener starts with `landfolk start`, supervisor/pauser via `restart` or flags. |
| `ledger-update.py` | Fold completed ops-board task metadata into `data/ops/logistics-ledger.yaml`. |
| `blueprint-plan.py` | GrabCraft URL → build plan JSON (substitutions, phases); steward skill `minecraft-steward-blueprint-plan`. |
| `watch-agent.py` | Tail Hermes session JSON for any Landfolk agent (`--agent flint`, etc.). |
| `cleanup-locations.py` | Remove accumulated `death_*` marks from `data/locations-*.json` (see `--keep-recent-deaths`). |

## Other launchers (repo root)

- `hermescraft.sh` / `start-steve.sh` — Steve companion (single bot)
- `start-gatherer.sh` — goal-directed Gatherer only
- `start-landfolk.sh` — multi-agent Landfolk from `agent-models.json` roster
- `scripts/run-landfolk-bots.sh` — bare bot bodies (no watchdog or agent)

Prefer `scripts/landfolk` for a supervised session.

## Minecraft server expectations

- Java server (Paper **1.21.x** or compatible with your Mineflayer pin) at `MC_HOST:MC_PORT`.
- **Offline bots**: `online-mode=false` where applicable; Spigot/Paper **`connection-throttle: 0`** in `bukkit.yml` to avoid reconnect storms with bot clients.
- **PaperMCP** (optional): plugin + `PAPERMCP_*` env if world actions should run console commands through the bridge.
- **`server/start.sh`**: in-repo helper to run a local Paper stack; align game version with `bot/package.json` dependencies.
