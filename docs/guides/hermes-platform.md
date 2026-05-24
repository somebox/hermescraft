# Hermes Agent — developer guide (Landfolk)

This guide explains **Hermes Agent** as the orchestration layer for Landfolk: profiles, toolsets, memory, kanban, handoffs, and sessions. It is aimed at contributors who need to align prompts, skills, and ops with Hermes’ architecture—not at duplicating upstream reference docs or listing every Landfolk script.

**Boundary with the bot:** Hermes holds procedure, planning, and kanban coordination; live world state and marks live on the Mineflayer HTTP API and `bin/mc`. See [agent-boundaries.md](../agent-boundaries.md).

**Platform rule:** Do not patch the Hermes framework under `~/.hermes/hermes-agent/` (updates overwrite local edits). Extend behavior via profile config, skills, repo tools, and SOUL/prompts synced from this repository.

---

## Official Hermes documentation

Use these as the source of truth for flags, config keys, and behavior:

| Topic | Link |
|-------|------|
| Profiles | [user-guide/profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles) |
| Profile distributions | [user-guide/profile-distributions](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions) |
| Tools & toolsets | [user-guide/features/tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools) |
| Toolsets reference | [reference/toolsets-reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference) |
| Kanban | [user-guide/features/kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) |
| Kanban tutorial | [user-guide/features/kanban-tutorial](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-tutorial) |
| Worker lanes | [user-guide/features/kanban-worker-lanes](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes) |
| Persistent goals (`/goal`) | [user-guide/features/goals](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals) |
| Tips & best practices | [guides/tips](https://hermes-agent.nousresearch.com/docs/guides/tips) |
| SOUL.md | [guides/use-soul-with-hermes](https://hermes-agent.nousresearch.com/docs/guides/use-soul-with-hermes) |
| Plugins | [user-guide/features/plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins) |
| Dashboard / kanban UI | [user-guide/features/extending-the-dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard) |

---

## Mental model

```text
┌─────────────────────────────────────────────────────────────┐
│  Hermes Agent                                                │
│  profiles (HERMES_HOME) · sessions · memory · skills · SOUL  │
│  tool gateway (terminal, file, web, kanban_*, delegate_*)    │
│  gateway + embedded kanban dispatcher (~/.hermes/kanban.db)  │
└──────────────────────────┬──────────────────────────────────┘
                           │ terminal → bin/mc, scripts/
┌──────────────────────────▼──────────────────────────────────┐
│  Landfolk bot API (source of truth for world / inventory)    │
└─────────────────────────────────────────────────────────────┘
```

Three distinctions that matter daily:

1. **Profile vs workspace vs sandbox** — A [profile](https://hermes-agent.nousresearch.com/docs/user-guide/profiles#profiles-vs-workspaces-vs-sandboxing) is isolated Hermes *state* (`config.yaml`, sessions, memory). It is **not** filesystem isolation. Set `terminal.cwd` to the repo root for predictable tool paths; use Docker/SSH terminal backends only when you deliberately want execution isolation.

2. **Kanban vs `delegate_task`** — [Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban#kanban-vs-delegate_task) is a durable queue with named profiles, audit trail, block/unblock, and human-in-the-loop. `delegate_task` is a fork–join RPC inside one session. Use kanban for cross-role work that must survive restarts; use delegation for parallel research that folds back into the same conversation.

3. **Two board surfaces** — Humans and scripts use `hermes kanban …` (or `/kanban` in chat). **Workers use `kanban_*` tools**, not shell CLI—so kanban still works when the terminal backend is remote and `hermes` is not installed in the worker shell.

---

## Command cheat sheet

### Profiles

```bash
hermes profile list
hermes profile create flint --description "In-world mining via mc; kanban worker."
hermes profile describe flint --text "…"          # routing label for orchestrator/decomposer
hermes profile describe flint --auto              # LLM-generated from skills + model
hermes profile use steward                        # sticky default for bare `hermes` commands
hermes -p flint chat                              # explicit profile
flint chat                                        # alias in ~/.local/bin after create
hermes profile show flint
hermes update                                     # shared framework + bundled skills sync
```

### Chat & sessions

```bash
hermes chat
hermes -c                                         # continue last session
hermes -r "storage-farm-plan"                     # resume by title
hermes chat --toolsets "terminal,memory" -s my-skill
# In session: /title, /compress, /usage, /model, /skills, /verbose
```

### Kanban (operator / CI)

```bash
hermes kanban init
hermes gateway start                              # dispatcher runs inside gateway (default)
hermes kanban --board landfolk-ops stats
hermes kanban --board landfolk-ops list --assignee flint --status ready
hermes kanban create "Survey north ridge" --assignee flint --body "…"
hermes kanban show t_abc --json
hermes kanban assign t_abc mason
hermes kanban comment t_abc "Anchor: [370,65,-608] — put in body for downstream."
hermes kanban watch
hermes kanban dispatch --max 5                    # nudge without waiting for tick
hermes kanban context t_abc                       # preview worker_context
```

In an interactive session, `/kanban list` and friends work **mid-turn** without stopping the agent (board state is outside the running turn).

### Tools configuration

```bash
hermes tools                                      # interactive per-platform toolsets
hermes config set model.default anthropic/claude-sonnet-4
flint config set terminal.cwd /absolute/path/to/hermescraft
```

---

## Managing agents (profiles)

Each Landfolk bot-facing role (Steward, Flint, Mason, …) should be a **separate Hermes profile** under `~/.hermes/profiles/<name>/`:

| Artifact | Purpose |
|----------|---------|
| `config.yaml` | Model, `max_turns`, **toolsets**, kanban keys, `terminal.cwd`, env passthrough |
| `.env` | API keys, `MC_API_URL`, bot tokens |
| `SOUL.md` | Role, hard rules, kanban worker/orchestrator contract |
| `skills/` | Procedures (`kanban-worker`, `kanban-orchestrator`, repo gaming skills) |

**Descriptions matter for routing.** When using auto-decompose or an orchestrator that fans work out, set `hermes profile describe` text so the decomposer knows which profile owns which work—even if Landfolk prefers **manual** triage (see below).

**Orchestrator vs worker toolsets** ([tools doc](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools)): restrict workers to what they need (`terminal`, `memory`, task-scoped kanban); give the orchestrator `kanban`, `hermes-cli` or terminal for `hermes kanban …`, `file`, `web`, `skills` as required. CLI flags like `hermes chat --toolsets …` **override** profile defaults for that process—avoid giving a continuous orchestrator the same narrow flags as a one-shot worker.

**Continuous vs dispatched agents:** Stock Hermes kanban **dispatches one OS process per ready task** with `HERMES_KANBAN_TASK` set. Long-lived loops use `hermes chat --continue` in a dedicated session tree. Landfolk may pin `HERMES_HOME` per continuous agent while sharing one board DB via `HERMES_KANBAN_BOARD` / board path env—see [kanban-flow-cleanup.md](../features/kanban-flow-cleanup.md) for current conventions.

**Sync from repo:** After changing prompts or toolsets, run `scripts/setup-landfolk-profiles.sh` (or `--apply-config` for SOUL/toolsets only). Models and ports are listed in `data/agent-models.json`.

**Profile distributions:** Optional git-packaged agents ([profile distributions](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions)). Landfolk’s source of truth remains this repo plus the setup script; distributions are useful if you want the same SOUL/skill bundle on a second machine without hand-copying.

---

## Toolsets and capability boundaries

Hermes groups tools into **toolsets** enabled per profile or per chat invocation. Common sets for Landfolk-style setups:

| Toolset | Typical use |
|---------|-------------|
| `terminal` | `bin/mc`, `hermes kanban …`, repo scripts |
| `memory` | Session-to-session notes (not world state) |
| `kanban` | Orchestrator: `kanban_list`, `kanban_create`, `kanban_link`, … |
| `file` / `web` | Steward planning, docs, blueprint research |
| `skills` | Load `/minecraft-steward-survey` and gaming skills |
| `delegation` | `delegate_task` for parallel offline research |
| `hermes-cli` | Structured Hermes CLI from tools where enabled |

Workers spawned for a card get **task-scoped** kanban tools when `HERMES_KANBAN_TASK` is set, plus bundled **`kanban-worker`** skill (restored with `hermes skills reset kanban-worker --restore` if missing).

Pin extra skills on a single card: `hermes kanban create … --skill translation` or `kanban_create(..., skills=[…])`.

**Terminal backends:** Default `local` runs as your user—SOUL rules (“mc only”) are policy, not enforcement. For untrusted code paths, prefer Docker/SSH per [tips — security](https://hermes-agent.nousresearch.com/docs/guides/tips#use-docker-for-untrusted-code).

---

## SOUL, AGENTS.md, skills, and memory

Follow [Tips — context files](https://hermes-agent.nousresearch.com/docs/guides/tips#context-files) and [memory vs skills](https://hermes-agent.nousresearch.com/docs/guides/tips#memory-vs-skills-what-goes-where):

| Layer | Holds | Landfolk guidance |
|-------|--------|-------------------|
| **`AGENTS.md`** (repo root) | Project architecture, conventions | Loaded from `terminal.cwd`; keep concise |
| **`SOUL.md`** (per profile) | Personality, non-negotiable rules, kanban contract | Synced from `prompts/landfolk/*.md` |
| **Skills** (`skills/`) | Repeatable multi-step procedures | Steward survey/blueprint; `mc` patterns for workers |
| **Memory** (`memory` tool) | Preferences, “what we tried last cycle” | Not coordinates, chest contents, or marks—use `mc` |

**Prompt cache:** Avoid churning SOUL or system context mid-session; stable prefixes reduce cost ([tips — prompt cache](https://hermes-agent.nousresearch.com/docs/guides/tips#dont-break-the-prompt-cache)).

**Memory refresh:** Writes persist immediately but **appear in the system prompt on the next session**—plan continuity accordingly.

---

## Kanban architecture

### Lifecycle

Default columns include `triage` → `todo` → **`ready`** → `running` → `done` / `blocked`. The gateway dispatcher claims **`ready` tasks with an assignee** and spawns that profile.

Landfolk target flow (manual orchestration): **Steward assigns every card that should run**; workers finish in their [worker lane](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes) with `kanban_complete` or `kanban_block`. Prefer **`kanban.auto_decompose: false`** so triage stays with Steward instead of the framework decomposer—details in [kanban-flow-cleanup.md](../features/kanban-flow-cleanup.md).

Board slug for ops: **`landfolk-ops`** (separate SQLite under `~/.hermes/kanban/boards/` when using multi-board layout).

### Worker protocol (agents)

Bundled **`kanban-worker`** skill; typical tool order:

1. `kanban_show()` — read `worker_context`, parents, prior attempts, comments  
2. Work in `$HERMES_KANBAN_WORKSPACE` (or project `terminal.cwd` when using `dir:` workspace)  
3. `kanban_heartbeat(note=…)` during long jobs (stale reclaim if silent ~1h within default 4h window)  
4. **`kanban_complete(summary=…, metadata={…})`** or **`kanban_block(reason=…)`**

Exiting without complete/block while the task is still `running` is a **protocol violation** (task auto-blocks). Workers should not shell out to `hermes kanban` for lifecycle—use tools.

### Orchestrator protocol (agents)

Load **`kanban-orchestrator`** skill. Pattern: discover real profile names → `kanban_create` / `kanban_link` → step back; do not execute worker implementation. Fan-out example in the [kanban doc](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban#the-orchestrator-skill).

Steward skills in this repo (`minecraft-steward-survey`, `minecraft-steward-blueprint-plan`) assume orchestrator tools plus terminal access to `scripts/*.py` where needed.

### Handoff and evidence

Hermes stores durable handoff on the **run** row:

- **`summary`** — human-readable closeout; downstream parents expose this in child `kanban_show()`  
- **`metadata`** — JSON for machines (changed files, verification commands, risks)—[recommended shape](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban#recommended-handoff-evidence)

**Landfolk best practice (critical):** Put anything the **next worker must act on** in the **card body** (coordinates, worksite ids, chest marks, blueprint phase). Sibling-card comments are not a reliable contract—workers often never read them. This matches upstream “leave evidence for the next reader” but is stricter for multi-step Minecraft pipelines. See `skills/minecraft-steward-survey.md` for the postmortem pattern.

For QC, use structured block reasons (e.g. `review-required: …`) and audit notes via `kanban_comment` before `kanban_block` where your lane convention requires it.

### Workspaces

| Kind | When |
|------|------|
| `scratch` (default) | Ephemeral; wiped on complete |
| `dir:/abs/path` | Shared repo or ops dir—typical for Landfolk coding/survey artifacts |
| `worktree:` | Git worktree for code tasks |

### Humans in the loop

Pattern P5: worker `kanban_block` → human `/kanban comment` or dashboard → `unblock`. `/kanban` works from gateway chats with optional auto-notify on create.

---

## Sessions, goals, and idle behavior

| Mechanism | Scope | When to use |
|-----------|--------|-------------|
| **`hermes -c` / `--continue`** | Same profile session | Steward continuous loop |
| **`/goal`** | Multi-turn loop with judge in **one Hermes session** | Long CLI refactors, “process all triage cards” batch work ([goals doc](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals)) |
| **`mc goals`** | Bot HTTP API | Worker idle when no kanban card is active |

Precedence for workers: **active kanban card > steward orders > `mc goals`**.

`/goal` does not replace kanban; it keeps a single agent iterating until a judge marks done or turn budget pauses.

---

## Gateway, dashboard, and observability

- **`hermes gateway start`** — messaging bots (if configured) **and** kanban dispatcher (do not run deprecated `hermes kanban daemon` alongside gateway).  
- **`hermes dashboard`** — Kanban tab (plugin); board switcher when multiple boards exist.  
- **Fleet UI:** [dashboard.md](dashboard.md) (port 3000) may read kanban via bridge or CLI fallback—not a substitute for `hermes kanban` debugging.

Useful inspection:

```bash
hermes kanban runs t_abc
hermes kanban tail t_abc
hermes kanban log t_abc
```

---

## Best practices checklist (Landfolk + Hermes)

1. **Never patch** `~/.hermes/hermes-agent/`; express policy in SOUL, skills, and repo tools.  
2. **Separate concerns:** world truth on `mc`; Hermes memory for operator/process notes only ([agent-boundaries.md](../agent-boundaries.md)).  
3. **Profile isolation:** distinct toolsets for orchestrator vs workers; descriptions set for any automated routing.  
4. **Kanban handoffs:** inline body data for downstream workers; `summary` + `metadata` on complete; heartbeat on long `mc` tasks.  
5. **End every worker run** with `kanban_complete` or `kanban_block`.  
6. **Stable prompts** within a session; refresh profile sync after `hermes update`.  
7. **Prefer skills** over one-off mega-prompts; prefer repo scripts + skills over custom Hermes plugins unless you need CI-tested tools ([plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)).  
8. **Security:** allowlists for gateway bots; do not disable command approval on production hosts ([tips](https://hermes-agent.nousresearch.com/docs/guides/tips#security)).

### Ops: revert local Hermes kanban patches

If you previously patched `~/.hermes/hermes-agent/` for pull-router or custom kanban behavior, restore stock files and restart the gateway so Landfolk uses CLI + config only:

```bash
git -C ~/.hermes/hermes-agent checkout HEAD -- \
  gateway/run.py hermes_cli/kanban_db.py \
  hermes_cli/kanban_decompose.py tools/kanban_tools.py
hermes gateway run --replace
git -C ~/.hermes/hermes-agent diff HEAD   # should be empty
```

Then confirm `~/.hermes/config.yaml` has `kanban.auto_decompose: false` (re-run `scripts/setup-landfolk-profiles.sh` or `--apply-config`).

---

## Where Landfolk hooks Hermes (pointers only)

| Repo path | Hermes role |
|-----------|-------------|
| `prompts/landfolk/*.md` | SOUL source |
| `scripts/setup-landfolk-profiles.sh` | Push config/SOUL/skills into `~/.hermes/profiles` |
| `scripts/landfolk-control.sh` | Continuous loop, env pins (kanban DB/board, `MC_*`), PATH policy |
| `scripts/landfolk` | Operator start/stop, modes |
| `skills/minecraft-steward-*.md` | Orchestrator procedures |
| `skills/` (gaming) | Worker `mc` patterns |
| `bin/mc` | Worker in-world command surface |

Card schemas and ops conventions: [design/phase-3/steward-mvp.md](../design/phase-3/steward-mvp.md). Active kanban migration plan: [kanban-flow-cleanup.md](../features/kanban-flow-cleanup.md).

---

## Related reading

- [agent-boundaries.md](../agent-boundaries.md) — Hermes vs bot API  
- [kanban-flow-cleanup.md](../features/kanban-flow-cleanup.md) — stock dispatcher, manual triage, patch-free path  
- [design/phase-2/board.md](../design/phase-2/board.md) — historical Phase 2 board integration  
- [blueprints.md](../features/blueprints.md) — Steward-side blueprint planning (uses Hermes + scripts, not kanban primitives)
