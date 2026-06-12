# Impact: where the new model touches the codebase

Status: **design exploration** (2026-06-05). Companion to [`target.md`](target.md). Grouped by area, not by file.

For a **runtime inventory** (scripts, ticks, APIs, agent-visible tools), see [`components.md`](components.md). This doc focuses on **what changes** when the target model lands.

The MVP is a **rewrite**, not an adaptation. Most existing infra scripts won't be patched into the new model — new code lives alongside them, and old code retires when the new path proves out. This doc maps which surfaces are affected, what the new model does there, and what we keep from today vs replace.

---

## A. Orchestration

**Today:**
- [`scripts/kanban`](../../scripts/kanban) — 1957-line Python facade for kanban DB reads + CLI shell-outs. Operators write cards through it; Steward writes cards through it.
- [`scripts/steward-chat-listener.py`](../../scripts/steward-chat-listener.py) — picks up Steward's in-game chat triggers, optionally invokes `hermes kanban decompose`.
- [`scripts/steward-supervisor.py`](../../scripts/steward-supervisor.py) — polls blocked cards, spawns Steward workers.
- [`scripts/landfolk-dispatcher.sh`](../../scripts/landfolk-dispatcher.sh) — shell loop running `landfolk gate-check` + `kanban dispatch` per tick when `dispatch_in_gateway: false`.
- [`scripts/auto-stuck-check.py`](../../scripts/auto-stuck-check.py) — watches progress logs for stuck patterns, escalates via `kanban_comment`.

**New model:**
- `@planner` (Hermes profile, bot-less) reads triage cards + goals + chat, parses `@mention` DSL bodies, emits typed intents.
- `@dispatcher` (Hermes profile or script, bot-less) applies **lexicographic bind** rules and writes `kanban_create` calls with `assignee=<agent>` and `metadata.bot=<bot>` ([`board-dynamics.md`](board-dynamics.md)).
- Hermes embedded dispatcher claims cards by `assignee` (loads the agent profile). For bot-bound cards, our spawn layer reads `metadata.bot` and injects MC env at worker spawn (see Section F).
- WS event stream replaces polling for fault detection — `gave_up`, `respawn_guarded`, `stale`, `crashed` are first-class events ([ref](hermes-v0.15-reference.md#kanban--task_events-kinds)).
- `landfolk` plugin's `gate-check` + `post_tool_call` hook stays, **extended to read `metadata.bot`** instead of `assignee` for per-bot mutex.

**MVP:**
- **Rewrite:** card creation (Steward → `@planner` + `@dispatcher`), worker spawn pipeline (`landfolk-dispatcher.sh` → Hermes embedded + our spawn layer for bot-bound cards), stuck detection (polling scripts → WS event handler in `@dispatcher`).
- **Keep:** `scripts/kanban` facade for ad-hoc operator card writes; the `landfolk` plugin (extend for `metadata.bot` mutex).
- **Retire on success:** `steward-supervisor.py`, `steward-chat-listener.py`, `landfolk-dispatcher.sh`, `auto-stuck-check.py`.

---

## B. Bot fleet management

**Today:**
- [`scripts/landfolk`](../../scripts/landfolk) — supervises Mineflayer bot processes (start, stop, restart, watchdog heartbeats).
- [`scripts/landfolk-control.sh`](../../scripts/landfolk-control.sh) — engine that landfolk drives.
- Each bot is a Hermes profile (`~/.hermes/profiles/flint/`) with `MC_API_URL` hardcoded in `.env`.
- Bots expose HTTP APIs at `http://localhost:<port>/api/*` (player state, marks, inventory). Workers call this via `mc <verb>`.
- Marks live in [`data/locations-<bot>.json`](../../data/) per bot + shared [`data/locations-base.json`](../../data/). Served from `/api/marks`.

**New model:**
- Bots are **no longer Hermes profiles**. They're registry entries (`data/bots/<bot>.yaml`) with port, username, description, optional role hints. See [`workspaces.md`](workspaces.md).
- Mineflayer process supervision is **unchanged** — `scripts/landfolk` still starts/stops the bot processes. The processes themselves don't care about the kanban model.
- A new consumer: `@dispatcher` polls `/api/players`, `/api/marks`, per-bot status every ~60s and maintains `data/agents/dispatcher/fleet-state.yaml`.
- Marks system stays as a system primitive. Long-term direction is [`../specs/world/marks-sign-anchored.md`](../specs/world/marks-sign-anchored.md) — independent of the agent model.

**MVP:**
- **Keep entirely:** `scripts/landfolk` + `landfolk-control.sh` + bot HTTP API + marks system. The Mineflayer supervision layer is real work that's separate from the kanban model.
- **Rewrite:** `scripts/setup-landfolk-profiles.sh` — creates **agent** Hermes profiles (one per agent) and writes the `data/bots/*.yaml` registry. Today's per-bot profiles (`flint`, `mason`, etc.) get retired during the migration window.
- **Add:** `@dispatcher` polling consumer. New HTTP load (~1 call/min per bot for a few endpoints). Bot APIs should handle this; verify during pilot.
- **Add (design):** host data API for **recall** (`POST/GET …/recall/*`) and operations state — see [`data-api.md`](data-api.md). Bot HTTP endpoints stay; recall is worker-written, not a mirror of `/observe`.

---

## C. Profiles, skills, SOULs, and state continuity

**Today:**
- Profiles: 5 bot profiles (`flint`, `mason`, `gatherer`, `barley`, `steward`) — each owns MC binding + worker sessions + memory + skills + SOUL.
- [`scripts/setup-landfolk-profiles.sh`](../../scripts/setup-landfolk-profiles.sh) installs `kanban-worker` + per-role minecraft-* skills into each bot profile's `skills/`.
- Skill bundles + companion skills live in [`skills/`](../../skills/) (source tree).
- SOULs live in [`prompts/landfolk/`](../../prompts/landfolk/) (source tree). [`prompts/landfolk/worker.md`](../../prompts/landfolk/worker.md) is the base worker SOUL.
- Workers leave `[run_state]` YAML blocks in `kanban_comment` for checkpointing. Memory continues via the bot profile's `memories/MEMORY.md`.
- Per-card metadata is freeform — no canonical handoff schema.

**New model:**
- Profiles: ~10 **agent** profiles (`miner`, `navigator`, `crafter`, `builder`, `soldier`, `farmer`, `planner`, `dispatcher`, `overseer`, …). No bot profiles.
- Each agent's profile holds its provider keys, model preference, SOUL, skill bundle + companions, cross-bot memory.
- **Skills + SOULs move from source tree into workspace.** New homes: `data/workspace/reference/skills/agent-X.md` and `data/workspace/reference/souls/<agent>.md`. The deploy script reads from there and installs into each profile. Changes go through `[MR]` cards on the back-office board (approved by operator for these paths because they affect agent behavior).
- Workers spawn with `kanban_create(skills=[agent-X, minecraft-Y])`; Hermes dispatcher passes through `--skills <name>` per the v0.15 surface ([ref](hermes-v0.15-reference.md#skills)).
- Workers' first action becomes `skill_view(<first skill in array>)` instead of hardcoded `kanban-worker`. The base SOUL adapts (one SOUL fragment shared across agents, plus per-agent SOUL fragments).
- Handoff metadata is canonical per agent: each bundle declares its `handoff` schema (see `agent-navigator.md` Section 7). The next agent's preflight reads it.
- Hermes v0.15 worker session metadata persistence replaces some of `[run_state]` — but the checkpoint pattern stays useful during long phases for crash recovery within a single card.

**MVP:**
- **Rewrite:** `scripts/setup-landfolk-profiles.sh` — creates the agent profiles + bot registry; sources skills + SOULs from `data/workspace/reference/`. Migrates any salvageable memory from today's bot profiles into the relevant agent profiles (case-by-case decision).
- **Rewrite:** the base worker SOUL (`data/workspace/reference/souls/worker.md` post-migration) — read the first skill from the card's skills array, load it, work the card. Smaller and tighter than today.
- **Move:** existing `skills/` → `data/workspace/reference/skills/`; existing `prompts/landfolk/` → `data/workspace/reference/souls/`.
- **Coexist:** `[run_state]` checkpoint pattern stays for in-card crash recovery. Completion metadata uses the new canonical schemas per agent.
- **New:** `data/workspace/` (the team's shared brain) with the five-domain layout + `OWNERS.yaml`.

---

## D. Dashboard

**Today:**
- [`dashboard/`](../../dashboard/) (Node/Express) renders the kanban board, agent paths, world map.
- Cards display: title, status, assignee, priority. No agent / skill array shown distinctly.
- Bot status via parsing landfolk log files + `pgrep`-style introspection.

**New model:**
- Cards surface their agent (assignee) AND bot (metadata.bot) — e.g. a `miner` card driving **`pip`**, not a card titled like the old bot assignee.
- Bot lanes as swimlanes: what each bot is doing now, what's queued for them (grouped by `metadata.bot`, not assignee).
- Fleet state panel: live view of `data/agents/dispatcher/fleet-state.yaml` + `/api/plugins/kanban/inspect`.
- Pulse view: last N WS events for live activity.
- Optional: epic collapse, dependency graph for one selected epic.

**MVP:**
- **Add to existing dashboard:** bot-lane swimlane view + fleet-state panel + (agent, bot) chips on each card. Source data is v0.15 REST + WS endpoints ([ref](hermes-v0.15-reference.md#kanban--rest-surface-and-websocket-events)) + our `fleet-state.yaml`.
- **Replace:** log-parsing introspection with `/api/plugins/kanban/workers/active` and `/api/plugins/kanban/inspect`.
- **Defer:** dependency graph view, epic collapse — useful but not load-bearing for the MVP.
- **No backend changes required.** Dashboard reads from v0.15 REST + our `fleet-state.yaml`.

---

## E. Genesis, establish, and goals

**Today:**
- `scripts/establish-*` (multiple) seed initial cards with prose bodies. Steward decomposes during the establish run.
- [`data/base-goals.yaml`](../../data/base-goals.yaml) defines world-scope goals; Steward consumes.
- [`scripts/establish-seed-cards.py`](../../scripts/establish-seed-cards.py) writes the seed batch.

**New model:**
- Genesis card bodies can use `@mention` DSL — `@planner` parses them deterministically.
- Prose bodies continue to work — they fall through to native auto-decompose (if enabled) or to `@planner`'s playbook library.
- `data/base-goals.yaml` is consumed by `@planner` (no change to the goals file itself).

**MVP:**
- **Coexist:** keep prose card bodies for things that don't benefit from DSL routing. Add `@mention` bodies for chains that do.
- **No rewrite of establish scripts** unless a specific establish run needs explicit `@mention` graphs.
- **`@planner` falls back** to today's prose-decompose path for cards without `@mention` lines.

---

## G. Agent runtime access (new isolation layer)

**Today:**
- Workers spawn with `cwd` at or near the project root. The `terminal` and `file` tools can read/write anywhere the OS user permits.
- We've seen agents make mid-flight modifications to source files. Sometimes useful (bug fixes), sometimes harmful (unexpected consequences).
- No path allowlist is enforced.

**New model:**
- Five-layer access model (see [`workspaces.md`](workspaces.md)):
  1. Framework (`bot/`, `plugins/`, `scripts/`, `dashboard/`) — invisible to agents at runtime.
  2. Distributed commands (`bin/`) — installed read-only to each profile's PATH.
  3. Profile content (`~/.hermes/profiles/<agent>/`) — Hermes-managed, deployed from source/workspace.
  4. Shared workspace (`data/workspace/`) — read freely; write per OWNERS.yaml; scripts changes via `[MR]`.
  5. Agent home (`~/.hermes/profiles/<agent>/`) — Hermes-mediated.
- Workers spawn with `cwd = data/workspace/` (or a worktree of it for back-office work).
- `pre_tool_call` hook in the landfolk plugin enforces a path allowlist on the `file` and `terminal` tools: read+write only in `data/workspace/` and `~/.hermes/profiles/<agent>/`; blocked elsewhere. Reads to `bin/` and `data/bots/*.yaml` permitted.

**MVP:**
- **New:** `pre_tool_call` hook for path-allowlist enforcement (lands in the `landfolk` plugin alongside existing `post_tool_call`).
- **New:** worker spawn sets `cwd = data/workspace/`. (Today's spawn happens in `landfolk-control.sh` with explicit env; the new spawn layer in Section F handles cwd too.)
- **Defer:** container sandboxing (`terminal.backend: docker` / `singularity`). Add when MR-based enforcement is in place and we want a second line of defense.

---

## F. The spawn pipeline (new customization)

**Today:**
- Worker spawn happens in two paths:
  - Embedded dispatcher (`kanban.dispatch_in_gateway: true`) — Hermes spawns directly, picks up env from gateway process + profile `.env`.
  - Standalone dispatcher (`landfolk-dispatcher.sh`) — shell loop uses explicit `env MC_API_URL=… MC_USERNAME=… hermes …` to invoke a worker with the bot's MC binding.

**Validated (W1 wheat capstone, `w1-1780879052`):** Hermes kanban spawn **strips `MC_*` from the parent env** at the worker boundary (upstream `kanban_db.py` scrub). Dispatcher exports and `terminal.env_passthrough` do not reliably leave `MC_API_URL` / `MC_USERNAME` in the worker shell. **Profile `.env` is loaded after scrub** and is the working channel for single-bot trials: duplicate the same body’s `MC_*` in each execute-role profile via [`setup-role-profiles.sh`](../../prototypes/agent-arch/setup-role-profiles.sh). Wrapper-on-PATH + SOUL Turn-1 instructions **failed** (agents do not auto-run SOUL; PATH never included profile `bin/`). Pre-trial gate: [`smoke-worker-env.sh`](../../scripts/smoke-worker-env.sh). Postmortem: [`data/postmortems/wheat-capstone/w1-1780879052/`](../../data/postmortems/wheat-capstone/w1-1780879052/). **Not fleet-safe** — per-card body still needs Section F spawn seam ([`spawn-with-bot.sh`](../../scripts/colony-validation/spawn-with-bot.sh) or plugin hook).

**New model:**
- For **bot-less cards** (no `metadata.bot`): Hermes embedded dispatcher handles spawn natively. Loads agent profile, no MC env needed.
- For **bot-bound cards** (`metadata.bot` set): we need MC env injected at spawn. v0.15 has **no native `pre_spawn` hook** for per-card env modification. Resolution: a small spawn layer (extension to `landfolk` plugin's gate-check, or a thin wrapper) reads `metadata.bot`, looks up `data/bots/<bot>.yaml`, and injects `MC_API_URL` + `MC_USERNAME` before delegating to Hermes worker spawn. The agent profile's `config.yaml` declares `env_passthrough: [MC_API_URL, MC_USERNAME]`.

**MVP:**
- **Build:** the spawn layer for bot-bound cards. Small and bounded; pattern is consistent with what `landfolk-control.sh` already does today.
- **Two operating modes:**
  - Bot-less cards → embedded Hermes dispatcher (no changes).
  - Bot-bound cards → our spawn layer (reads card metadata, injects env, spawns worker on agent profile).
- Either mode can be selected dynamically per card based on whether `metadata.bot` is set.

---

## Cross-cutting: what we keep vs replace

| Surface | Keep | Replace | Retire when |
|---|---|---|---|
| Mineflayer process supervision (`scripts/landfolk`) | ✓ |  |  |
| Bot HTTP API + marks | ✓ |  |  |
| `landfolk` plugin (mutex, extended for `metadata.bot`) | ✓ (extend) |  |  |
| Hermes embedded dispatcher (bot-less cards) | ✓ |  |  |
| `scripts/kanban` facade (ad-hoc CLI) | partial | (Steward-paths) | When `@planner` covers Steward's writes |
| Worker base SOUL |  | (smaller, generic) |  |
| Bot Hermes profiles (`~/.hermes/profiles/flint/` etc.) |  | (registry entries in `data/bots/`) | When agent profiles ship + spawn layer works |
| Agent Hermes profiles |  | (NEW: one per agent) |  |
| Spawn pipeline for bot-bound cards |  | (NEW: env injection layer) | Stand-in: [`spawn-with-bot.sh`](../../scripts/colony-validation/spawn-with-bot.sh); wire into live dispatch per [`bots-and-mc.md`](bots-and-mc.md) § Fleet binding |
| Fleet status snapshot | [`scripts/roster.py`](../../scripts/roster.py), dashboard `GET /api/fleet`, dispatcher yaml | (NEW: `PUT …/operations/fleet-state`) | When single writer ships ([`data-api.md`](data-api.md) § Fleet state record) |
| `scripts/setup-landfolk-profiles.sh` |  | (rewrite: agent profiles + bot registry; sources skills/SOULs from workspace) |  |
| Skill bundles | (move from `skills/` to `data/workspace/reference/skills/`) |  | After workspace migration |
| SOULs | (move from `prompts/landfolk/` to `data/workspace/reference/souls/`) |  | After workspace migration |
| Path-allowlist enforcement |  | (NEW: pre_tool_call hook in landfolk plugin) | When workers move to new profiles |
| Per-bot marks files | ✓ |  | When sign-anchored placemarks land |
| Steward profile + SOUL |  | (dissolved into bot-less agents) | When `@planner` + `@dispatcher` + `@overseer` ship |
| `landfolk-dispatcher.sh` |  | (Hermes embedded + spawn layer) | After v0.15.2 upgrade stabilizes |
| `steward-supervisor.py` |  | (WS event handler in `@dispatcher`) | After `@dispatcher` ships |
| `steward-chat-listener.py` |  | (`@sentinel` or chat-adapter) | After `@sentinel` ships |
| `auto-stuck-check.py` |  | (v0.15 native events + `@dispatcher` WS handler) | After WS subscriber pattern proves out |

---

## Profile lifecycle (today → target)

| Today | Target | Migration |
|---|---|---|
| `~/.hermes/profiles/flint/` (bot profile) | `data/bots/pip.yaml` | Flint → **Pip** ([`bot-roster.md`](bot-roster.md)) |
| `~/.hermes/profiles/mason/` | `data/bots/mox.yaml` | Mason → **Mox** |
| `~/.hermes/profiles/gatherer/` | `data/bots/zee.yaml` | Gatherer → **Zee** |
| `~/.hermes/profiles/barley/` | `data/bots/bix.yaml` | Barley → **Bix** |
| `~/.hermes/profiles/steward/` | (retired) or `data/bots/glim.yaml` | Steward player → **Glim** optional; orchestration → bot-less agents |
| (no profile) | `~/.hermes/profiles/miner/` (NEW) | Created by deploy script with miner SOUL, skills, model preference |
| (no profile) | `~/.hermes/profiles/navigator/` (NEW) | same pattern |
| (no profile) | `~/.hermes/profiles/crafter/` (NEW) | same |
| (no profile) | `~/.hermes/profiles/builder/` (NEW) | same |
| (no profile) | `~/.hermes/profiles/planner/` (NEW) | bot-less; agent skill bundle (`agent-planner.md`) drives the parser |
| (no profile) | `~/.hermes/profiles/dispatcher/` (NEW) | bot-less; runs the affinity scorer + fleet polling |
| (no profile) | `~/.hermes/profiles/overseer/` (NEW) | bot-less; triggered on epic root promotions |
| (no profile) | `~/.hermes/profiles/sentinel/` (NEW) | bot-less; cron-triggered watches |
| (no profile) | `~/.hermes/profiles/engineer/` (NEW) | bot-less; tooling maintenance (speculative) |

---

## Migration posture

**Build alongside, switch when ready.** New agent profiles come up alongside today's bot profiles. Initial dispatch mode is **advisory** — `@dispatcher` scores and comments, doesn't bind. Once scoring is trusted, it starts writing typed cards. Once typed cards work, today's bot profiles gradually retire.

**No big-bang.** Each layer flips from old to new independently:
- Worker SOUL update + first agent profile (`navigator`) can ship right after the v0.15.2 upgrade — the spawn layer reads `metadata.bot` and injects MC env from the bot registry; the rest of the fleet still uses today's bot profiles.
- One pilot card with `assignee=navigator` + `metadata.bot=pip` validates the end-to-end loop.
- `@dispatcher` advisory mode runs without touching the rest of the fleet.
- Full migration of bot profiles → bot registry is the last step, not the first.

This posture matches the [README's](README.md) next-steps list and is consistent with the v0.15.2 upgrade plan at [`../platform/hermes-upgrade-0.15-runbook.md`](../platform/hermes-upgrade-0.15-runbook.md).
