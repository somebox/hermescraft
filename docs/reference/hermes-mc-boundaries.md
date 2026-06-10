# Hermes vs `mc` / bot server

Strategic framing (reflex-first control, taxi navigation, macro vs microscope): [`../architecture/embodied-control.md`](../architecture/embodied-control.md).

Hermes (or any external LLM orchestrator) keeps **procedural notes**: what worked, retries, social strategy, and long-form reasoning. It should not be the only copy of **world truth**.

The **Mineflayer bot + HTTP API** (`bot/server.js`) is the source of truth for:

- Live world state: `GET /status`, `/nearby`, `/scene`, inventory, position, task, goals
- Operational memory: marks (`GET /marks`, `POST /action/mark`, `mark_update`), chest snapshots, deaths, task history
- Anything that must stay consistent if Hermes restarts or multiple tools call `mc` concurrently

CLI (`bin/mc` → `bot/cli/`): uniform transport, validation, JSON envelopes, introspection (`mc commands`). It does not embed strategy or multi-step plans beyond `mc batch`. **Motor execution** (pathfind, collect chains, recovery) and **honest envelopes** belong here; agents compose verbs, macros, playbooks, and workspace scripts on top — see embodied-control doc above.

## Reliability (lightweight)

- HTTP client uses read vs action timeouts; **GET** retries on transient 5xx / network errors (`bot/cli/http.mjs`).
- `mc batch` caps concurrent sub-commands (see `MAX_BATCH` in `bot/cli/index.mjs`).

## Exploration and communication

Exploration heuristics and “when to notify players” remain **agent policy**: use `mc observe`, `mc discover`, and `mc chat` from the planner. The server exposes primitives only.

## World-edit policy

**Designated regions** are enforced server-side: dig, place, and bulk collect consult `bot/lib/runtime/regions/` and return `REGION_PROTECTED` / `REGION_OVERRIDE` envelopes. Spec: [`../specs/world/designated-regions.md`](../specs/world/designated-regions.md). Preview without editing: **`mc check`**.

Global block-name deny-lists (`isDigProtected`) still apply outside regions or when a region does not override them. Marks remain the coordinate/naming layer; region rows live in `data/regions-<world>.json`.
