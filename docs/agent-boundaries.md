# Hermes vs `mc` / bot server

Hermes (or any external LLM orchestrator) keeps **procedural notes**: what worked, retries, social strategy, and long-form reasoning. It should not be the only copy of **world truth**.

The **Mineflayer bot + HTTP API** (`bot/server.js`) is the source of truth for:

- Live world state: `GET /status`, `/nearby`, `/scene`, inventory, position, task, goals
- Operational memory: marks (`GET /marks`, `POST /action/mark`, `mark_update`), chest snapshots, deaths, task history
- Anything that must stay consistent if Hermes restarts or multiple tools call `mc` concurrently

CLI (`bin/mc` → `bot/cli/`): uniform transport, validation, JSON envelopes, introspection (`mc commands`). It does not embed strategy or multi-step plans beyond `mc batch`.

## Reliability (lightweight)

- HTTP client uses read vs action timeouts; **GET** retries on transient 5xx / network errors (`bot/cli/http.mjs`).
- `mc batch` caps concurrent sub-commands (see `MAX_BATCH` in `bot/cli/index.mjs`).

## Exploration and communication

Exploration heuristics and “when to notify players” remain **agent policy**: use `mc observe`, `mc discover`, and `mc chat` from the planner. The server exposes primitives only.

## World-edit policy

Preserve / protect zones are **not** fully enforced in the server yet. Use marks (e.g. category metadata) as **advisory** signals; higher-level policy belongs in the agent until server-side guards land.

## Regions

Region-based `dig` / `place` / `collect` syntax is not implemented in this rollout; use single-point actions or iterate from the agent.
