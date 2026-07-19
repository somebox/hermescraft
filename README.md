# HermesCraft

```text
██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗███████╗ ██████╗██████╗  █████╗ ███████╗████████╗
██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝╚══██╔══╝
███████║█████╗  ██████╔╝██╔████╔██║█████╗  ███████╗██║     ██████╔╝███████║█████╗     ██║
██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ╚════██║██║     ██╔══██╗██╔══██║██╔══╝     ██║
██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████║╚██████╗██║  ██║██║  ██║██║        ██║
╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝        ╚═╝

Embodied Hermes agents for Minecraft.
One agent can feel like a companion.
Many agents can make a world feel alive.
```

HermesCraft lets you play Minecraft with Hermes agents as actual in-world players.

A Hermes agent can join your world, chat with you in Minecraft, follow you, gather resources, build, fight, remember what happened, and adapt over time. The same architecture also scales to multi-agent worlds, where many Hermes agents share the same server, privately message each other, and gradually become characters in the world.

Built for the Nous Hermes hackathon. This repository is a **fork** of the original HermesCraft author’s project: the **idea** is unchanged — Hermes agents as real Minecraft players, fair-play perception, and multi-agent worlds — but **`experiment/hermes-agents` is a deep rewrite**, not a polish pass on the upstream tree.

## What this project is

This project started as a fork of someone else's hackathon idea and has since evolved into a personal sandbox for exploring what it looks like to put Hermes LLM agents inside Minecraft as real, embodied players. It is not a benchmark, not a scripted NPC framework, and not a god-mode bot — it is a long-running experiment in agent behavior that a normal human player could plausibly share a world with.

### What it is, technically

Each character is a normal Hermes agent with its own `HERMES_HOME`, its own memory and session history, its own SOUL, and its own Mineflayer bot body. The Minecraft-specific surface is a single CLI on top of a thin HTTP layer:

```text
Hermes agent
  → mc CLI
  → bot HTTP API
  → Mineflayer body
  → Minecraft world
```

That same stack powers both a one-companion world and a small multi-agent one. There is no separate custom agent runtime — the project leans on Hermes primitives (kanban, skills, profiles, gateway dispatch) and adds a thin host layer for the Minecraft-specific bits.

### Why it tries to be different

Most Minecraft-AI projects fall into one of three buckets: benchmark agents, scripted NPCs, or bots with too much privileged information. This project is trying for something more useful and more believable.

It aims to be:

- **Embodied** — perception comes from the same line of sight, directional sound, and in-game chat a human has.
- **Fair-play** — no x-ray omniscience; entities are filtered by LOS and range; sensing is shaped by what the bot can actually see and hear.
- **Persistent** — memory, sessions, locations, and identity survive across runs.
- **Social** — public chat, private DMs, queued player commands, and the ability to overhear nearby conversation.
- **Usable** — a normal player should be able to drop one of these into a real world and have it feel like a friend, not a tool.

### Where the project is right now

The implementation here targets current Hermes (v0.15 kanban, skills, gateway dispatch, worker lanes) and is in the middle of an architecture migration. The early hackathon fleet was a long-lived Steward orchestrator plus four named workers (Gatherer, Flint, Mason, Barley) that each carried a large skill catalog. That worked as a demo; it did not hold up to longer runs.

The target is a sharper split.

- **Agents are expertise.** A `@miner`, `@navigator`, `@builder`, `@planner`, `@dispatcher`, or `@overseer` is a Hermes profile with skills, memory, and SOUL.
- **Bots are bodies.** A `pip`, `mox`, or `zee` is a Mineflayer process and a registry entry — not a Hermes profile.
- **Cards pair them for a bounded phase of work.** A card with `assignee=@miner metadata.bot=pip` spawns a fresh, narrow-scope worker for one phase and exits.

In practice this means smaller scope per invocation, narrower skill bundles, code-enforced backstops rather than prompt-enforced rules, and structured observation surfaces that answer the *current* decision instead of dumping raw world state. The canonical target statement is [`docs/architecture/target.md`](docs/architecture/target.md); the reading order lives in [`docs/architecture/README.md`](docs/architecture/README.md).

### What this project is deliberately not doing

The architecture is shaped as much by what is left out as by what is built.

- **No Steward monolith.** Planner, dispatcher, and overseer are split profiles with different jobs, not bundled back into a long-lived orchestrator bot.
- **No every-worker-loads-every-skill.** Skills are scoped per card and per profile; the full `mc` registry stays, but a specialist sees a generated small surface, not the whole thing.
- **No prose as the only enforcement layer.** The control plane enforces budgets, mutex, retries, and stop conditions. SOUL prose describes intent; the host layer enforces it.
- **No mark count as proof of progress.** Verification predicates and run artifacts are first-class. A worker claiming "done" is not the same as `mc verify` accepting the work.
- **No god-mode perception.** Sensing is shaped by what the bot can actually see, hear, and remember; `mc scene`, `mc look`, and `mc map` are fair-play by design.
- **No patches to Hermes core for Minecraft-specific body binding.** That lives in the host dispatcher, not in the upstream agent framework.

### What "working" looks like

A specialist card is doing its job when it beats the wide-worker baseline on:

- fewer tool errors per completed card,
- fewer turns to first useful action,
- lower context tokens at completion,
- fewer repeated identical or same-class failures,
- faster wall-clock completion for the same world outcome,
- better auditability — action logs, snapshots, and verification explain what happened.

For the colony as a whole, the bar is runs that go longer without operator diagnosis: site selection rejects bad pads before build cards, stock state stops oversupply and empty-chest churn, repeated tool-error loops auto-block or rescope, and `mc verify` catches impossible or superseded work before it churns the board.

### The longer view

Minecraft is the proving ground, not the endpoint. The longer-term question this project is exploring is whether the same Hermes architecture can support MiroFish-style agent societies — but in a physical sandbox world with terrain, resources, danger, geography, structures, and human players. If one agent can feel like a friend, and several can start to make a world feel inhabited, that is a strong foundation for persistent embodied AI.

## Documentation map

| Docs | Role |
|------|------|
| [`docs/README.md`](docs/README.md) | Full index |
| [`docs/guides/local-dev-setup.md`](docs/guides/local-dev-setup.md) | **Run the whole stack locally** (self-hosted Paper, no LAN/ssh) |
| [`docs/architecture/target.md`](docs/architecture/target.md) | Canonical target statement |
| [`docs/reference/`](docs/reference/) | `mc` cheatsheet, command reference, bot map |
| [`docs/specs/`](docs/specs/) | World, nav, kanban, agent DSL specs |
| [`docs/testing/`](docs/testing/) | Playbooks, procedural maps, context-tuner |
| [`docs/archive/`](docs/archive/) | Superseded phase-2/3 design and old `features/` (historical only) |

Maintainers: **`AGENTS.md`** + **`docs/architecture/`** for where the fleet is going; **`docs/guides/`** for what to run this week.

## Main modes

### Companion Mode

Run one Hermes agent as an in-world Minecraft friend.

What it can do today:
- chat with you in Minecraft
- follow you around
- help gather resources
- help build
- scout the area
- fight / flee / survive with you
- remember what happened across sessions
- adapt to your preferences over time

Good use cases:
- "follow me"
- "help me build a house"
- "gather wood while I mine stone"
- "come explore this cave with me"

### Landfolk Mode

Four worker characters plus optional Steve companion, for a player's LAN world.

Landfolk cast (`data/agent-models.json`):
- **Gatherer** — resource loops and chores
- **Flint** — stone, mining, caves
- **Mason** — building and structures
- **Barley** — food, animals, cooking

**Steve** is the companion (`prompts/landfolk/steve.md`, `./start-steve.sh` or `./hermescraft.sh`). Use `scripts/landfolk` (the single CLI for the Landfolk sub-project) to bring the cast online, off, or for partial roster changes; it manages bots, watchdogs, and the operator daemons in one place.

## Core features

### Embodied gameplay
- movement and pathfinding
- mining and collection
- crafting and smelting
- chest interaction
- combat and fleeing
- location marking and return
- background tasks so agents can keep checking chat while acting

### Fair-play perception
- line-of-sight filtering for entities
- directional sound hints
- `mc look` for natural-language surroundings
- `mc map` for ASCII spatial understanding
- `mc scene` for current-view fair-play scene summary
- `mc screenshot_meta` for screenshot + synchronized scene/state metadata

### Social systems
- public chat
- direct and group private messages
- overhearing nearby private conversation
- queued in-game commands from human players
- social summary / recent interaction state

### Persistent identity
- per-agent memory
- per-agent sessions
- per-agent prompts / SOUL
- per-agent saved locations

## Stable vs experimental

Most stable path today:
- **Steve companion:** `./start-steve.sh` or `./hermescraft.sh`
- **Landfolk fleet:** `scripts/landfolk` (one CLI; engine is `scripts/landfolk-control.sh`) + `data/agent-models.json`
- direct Hermes-per-agent launches when you want total control

If you want the most reliable behavior, use the launcher flows shown below.

## Prerequisites

- Node.js 18+
- Python 3
- Hermes CLI installed and authenticated
- Minecraft Java Edition
- optional: Java if you want to use the included Paper server flow

Setup:

```bash
cd ~/hermescraft
./setup.sh
```

## Quickstart

### Companion Mode

Fastest way to start one Minecraft buddy (Steve):

```bash
cd ~/hermescraft
./start-steve.sh
```

The script asks for your LAN port, starts Steve's bot body, then opens a terminal running Steve's Hermes brain.

If you already have a world open to LAN and want the generic single-agent flow instead:

```bash
cd ~/hermescraft
MC_PORT=<LAN_PORT> ./hermescraft.sh
```

(`hermescraft.sh` reads its default model from `data/agent-models.json` — currently `deepseek/deepseek-v4-flash` on openrouter. Override with `HERMES_MODEL=...` or `--model`. `--bot-only` skips the LLM and does not need a model. Be careful with premium models like `anthropic/claude-sonnet-4` — they are ~30× the cost of the default.)

Examples in chat:
- `hermes follow me`
- `hermes help me build here`
- `hermes gather oak logs`
- `hermes what do you see?`

### Landfolk Mode

Start bot bodies (Gatherer, Flint, Mason, Barley on API ports from ``data/agent-models.json``; **3004** reserved for Tester):

```bash
cd ~/hermescraft
./scripts/run-landfolk-bots.sh <LAN_PORT>
```

Or use the supervised fleet:

```bash
./scripts/landfolk start --players gatherer,flint,mason,barley --mode continuous
# kanban experiment (no per-agent Hermes loops; gateway workers drive the bots):
./scripts/landfolk start --players flint,mason,steward     # default mode=kanban
./scripts/landfolk status
./scripts/landfolk stop --with-gateway
```

Then launch Hermes brains per agent (example: Steve companion on port 3001 — do not run Steve and Gatherer on the same API port at once):

Example for Steve:

```bash
cd ~/hermescraft
PROMPT="$(cat prompts/landfolk/steve.md)" && \
HERMES_HOME="$HOME/.hermes-landfolk-steve" \
MC_API_URL="http://localhost:3001" \
MC_USERNAME="Steve" \
hermes chat --yolo -q "$PROMPT" -m claude-sonnet-4-20250514 --provider anthropic
```

You can use the helper script instead:

```bash
cd ~/hermescraft
./scripts/run-landfolk-agent.sh Steve 3001 prompts/landfolk/steve.md "$HOME/.hermes-landfolk-steve"
```

For Landfolk workers, use ports from ``data/agent-models.json`` (Gatherer 3001 … Barley 3008; **3004** reserved for Tester) and `prompts/landfolk/{gatherer-test,flint,mason,barley}.md` (Gatherer uses `gatherer-test.md`).

## Useful `mc` commands

Observation:

```bash
mc status
mc inventory
mc nearby 24
mc look
mc map 12          # radius clamped at 16
mc scene 16
mc social
mc read_chat
mc commands
mc advise --reason="find oak wood"   # slow digest; use when stuck (see docs/archive/guides/perception-digest.md)
```

Action:

```bash
mc bg_collect oak_log 5
mc bg_goto 100 64 100
mc follow Steve
mc craft stone_pickaxe
mc fight zombie
mc flee 16
mc chat "hello"
mc chat_to Flint "meet me by the cave"
# `mc whisper` is an alias for chat_to (public @-style line, not private DM)
```

Vision:

```bash
mc screenshot_meta
```

## Fairness and non-xray design

HermesCraft is intentionally trying to avoid god-mode behavior.

In fair-play mode:
- entities are filtered by line of sight and range
- sounds are directional hints rather than exact coordinates
- `mc scene` reports what is visible in the current view cone plus remembered nearby landmarks
- resource finding is biased toward visible blocks instead of omniscient scans
- agents are encouraged to admit uncertainty and reposition instead of bluffing

This matters for both believability and demo integrity.

## Repository guide

Primary files:
- `start-dashboard.sh` — fleet dashboard aggregator (see `docs/guides/dashboard-command-center.md`)
- `dashboard/` — standalone command-center UI (polls bot HTTP APIs + optional Kanban bridge)
- `scripts/landfolk` — single Landfolk CLI (start/stop/enable/disable/restart/status/logs/chat/fix/players)
- `scripts/landfolk-control.sh` — internal Landfolk engine (per-bot bot+watchdog+optional agent)
- `scripts/run-landfolk-bots.sh` — start Landfolk bot bodies (Gatherer–Barley)
- `scripts/run-landfolk-agent.sh` — launch one Landfolk Hermes brain cleanly
- `bot/server.js` — wiring entrypoint (~600 LOC): config, dependency injection, HTTP startup
- `bot/lib/actions/` — domain action modules (movement, mining, crafting, combat, building, containers, …)
- `bot/lib/runtime/` — Mineflayer-dependent gameplay (manager, fair-play, spatial, locations, dig-tools, observation)
- `bot/lib/server/` — HTTP infrastructure (config, state, http-app, action-registry)
- `bot/lib/shared/` — pure utilities (perception, resolver, chat, domains, schemas)
- `bot/lib/goals/` — goal engine and task management
- `bot/test/` — unit tests
- `bin/mc` — Node ESM CLI (`bot/cli/`) over the bot HTTP API (`--json`, `mc commands`, `mc batch`, etc.)
- `SOUL-minecraft.md` — companion behavior
- `SOUL-landfolk.md` — landfolk worker behavior (Gatherer, Flint, Mason, Barley)
- `prompts/` — character prompts
- `docs/` — [`docs/README.md`](docs/README.md); target direction [`docs/architecture/`](docs/architecture/); bot/`mc` [`docs/reference/`](docs/reference/); runbooks [`docs/guides/`](docs/guides/)
- `data/` — persistent per-bot data (goals, presets, locations, reminders)

Archived reference material: [`docs/archive/README.md`](docs/archive/README.md) (superseded design, old `features/` dumps, experiment notes). Do not add new canonical docs there.

Agent-facing cheat sheet (generated): [`docs/reference/mc-cheatsheet.md`](docs/reference/mc-cheatsheet.md). Regenerate after registry edits via `scripts/regenerate-artifacts.sh`.

## Testing

```bash
cd bot
npm test
```

Sanity checks:

```bash
node --check bot/server.js
bash -n hermescraft.sh
bash -n setup.sh
bash -n scripts/landfolk
bash -n scripts/landfolk-control.sh
bash -n server/start.sh
bash -n scripts/run-landfolk-agent.sh
bash -n start-dashboard.sh
```

## Known limitations

Current focus is early/mid-game survival, companion play, and small-society behavior — not full endgame autonomy.

Still rough:
- automated batch launchers need more hardening than direct per-agent launches
- building taste still benefits from screenshot + vision loops
- longer-term social simulation needs stronger town-level memory / replay tooling
- public clean-room reproducibility still depends on a reasonably configured local Hermes + Minecraft environment

## License

MIT
