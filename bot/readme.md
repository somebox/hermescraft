# HermesCraft bot server

HTTP API around a Mineflayer client: one Node process per in-world character. The bot is the source of truth for live state (inventory, position, marks, chest snapshots, deaths, task history). The agent—Hermes, another planner, or a human using `mc`—owns strategy and multi-step reasoning. The `mc` CLI layers capability, telemetry, and task control on top of HTTP; it does not embed planning.

See also: [docs/reference/hermes-mc-boundaries.md](../docs/reference/hermes-mc-boundaries.md), [docs/archive/MC_TARGET_ARCHITECTURE.md](../docs/archive/MC_TARGET_ARCHITECTURE.md).

## Design layers

From primitives upward (full rationale in `MC_TARGET_ARCHITECTURE.md`):

1. **Primitives** — observe, move, craft, combat, social, memory-shaped operations exposed as named actions.
2. **Task runtime** — background tasks with lifecycle, leases, pause/resume, checkpoints.
3. **Goal engine** — goals as measurable objectives with urgency, not linear scripts.
4. **Deliberation** — lease expiry, checkpoint flow, anti-thrash so bodies do not fight the planner.
5. **Agent intelligence** — creative and social reasoning runs outside the server on top of the above.

## Module layout

| Area | Role |
|------|------|
| `lib/actions/` | Domain action handlers: movement, mining, crafting, combat, world, containers. |
| `lib/runtime/` | Mineflayer lifecycle, observation snapshots, locations, fair-play, optional PaperMCP bridge. |
| `lib/server/` | HTTP routing, config load, single-process runtime state (`ctx`). |
| `lib/shared/` | Pure helpers: chat routing, perception, recipe math, schemas, resolver. |
| `lib/goals/` | Goal store, scoring, presets, task lease helpers. |
| `lib/*.js` (top-level) | Re-export barrels so older import paths stay stable. |
| `cli/` | `mc` CLI maps subcommands to HTTP; registry stays in sync with server actions via tests. |

Entry: `server.js` wires config, `ctx`, actions, observation, Mineflayer manager, and the HTTP listener. `mason-server.js` only `import`s `server.js` so launch scripts can use a profile-specific filename without copying code.

## Key decisions

- **One `ctx` bag** — dependency injection for the whole process; avoids hidden singletons.
- **Actions as async functions** — merged by domain (`createAllActions`), not deep class trees.
- **Sync vs background** — `/action/*` runs to completion; `/task/*` and related routes run long work with cancellation and conflict rules.
- **Fair-play default** — `FAIR_PLAY` on unless explicitly disabled: LOS, directional sound, visible-block bias so “what the bot knows” matches plausible perception.
- **Goals on the server** — scored from live state and chest snapshots; agents steer via `mc` / HTTP but do not own the canonical goal store.

## Configuration

| Kind | Variables |
|------|------------|
| Minecraft connection | `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH` (`offline` / `microsoft`), plus CLI `--mc-host`, `--mc-port`, `--username`, `--auth`. |
| HTTP | `API_PORT`, `--port`. |
| Fair-play | `FAIR_PLAY` (treat anything other than `false` as on). |
| Dashboard / ops | `AGENT_PROFILE`, `AGENT_MODEL`, `AGENT_PROVIDER`. |
| PaperMCP (optional console commands) | `PAPERMCP_TOKEN` (required to enable), `PAPERMCP_HOST`, `PAPERMCP_PORT`. |

`lib/server/config.js` parses the Mineflayer and API surface; other env vars are read where the features live.

## Requirements

- **Node** ≥ 18, ESM (`"type": "module"` in `package.json`).
- **Minecraft** Java server reachable at `MC_HOST:MC_PORT`, protocol compatible with the pinned Mineflayer / `minecraft-data` stack.
- **Install / test**: `npm install` and `npm test` from this directory.
