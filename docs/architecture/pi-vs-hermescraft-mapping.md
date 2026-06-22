# Hermescraft on Pi: Architecture Mapping

Status: **design exploration** — not a migration plan, a thought experiment. Canonical direction: [`README.md`](README.md), [`target.md`](target.md).

**Question:** If we were building hermescraft today on top of Pi instead of Hermes v0.15, what would the architecture look like? Where do concepts map cleanly? Where do they diverge?

---

## 1. Pi in 30 seconds

Pi (`earendil-works/pi`) is a minimal coding-agent harness built around a single agent loop (~418 lines). One session = one LLM + one tool registry + one conversation stream. It is extended through:

| Pi concept | What it is |
|---|---|
| **Extension** | TypeScript module hooking lifecycle events (`session_start`, `tool_call`, `tool_result`, …) and registering tools/commands |
| **Skill** | Markdown file with YAML frontmatter (`name`, `description`, …) loaded into the system prompt on demand (`/skill:name` or auto-matched) |
| **Tool** | Function schema + executor registered via `pi.registerTool()`; LLM decides when to call |
| **Command** | Slash command (`/mycommand`) registered via `pi.registerCommand()`; user or extension invokes directly |
| **Session** | Persistent agent loop state (messages, context files, custom entries) — one per Pi invocation |

Pi ships with ~4 built-in tools (`read`, `edit`, `write`, `bash`). Everything else is opt-in via extensions or skills.

Multi-agent exists as **packages** (`pi-multiagent`, `pi-subagents`) where a parent session delegates to short-lived child processes. The parent remains the lead; child output is evidence, not instructions.

---

## 2. Hermescraft in 30 seconds

Hermescraft is a multi-agent system where cards (kanban tasks) pair **agents** (Hermes profiles with expertise) with **bots** (Minecraft bodies). Key concepts:

| Hermescraft concept | What it is |
|---|---|
| **Agent** | Hermes profile (`~/.hermes/profiles/<agent>/`) — SOUL, model, skills, memory. `@navigator`, `@miner`, `@planner`, … |
| **Bot** | Mineflayer process + registry entry (`data/bots/<bot>.yaml`). Remote-controlled via HTTP API |
| **Card** | Kanban task with `assignee=<agent>` and optional `metadata.bot=<bot>` |
| **Worker** | One card → one fresh Hermes spawn on the agent's profile, with MC env injected when bot-bound |
| **Dispatcher** | Bind rules, maintenance, rebind — maps cards to available bots |
| **Recall stream** | Append-only host API for cross-agent episodic memory (sightings, blockages, resources) |
| **Workspace** | Git-backed shared storage with five domains and `OWNERS.yaml` governance |

The architecture deliberately resets agent cognition at every card boundary: fresh context, narrow skill catalog, one phase per invocation.

---

## 3. Clean mappings

These concepts translate almost one-to-one.

### 3.1 Pi Extension = Hermescraft Plugin

Pi's extension system (TypeScript modules with `pi.on()` hooks) maps directly to the landfolk plugin concept. A `hermescraft-minecraft` extension would:

- Register `mc` tool wrapping Mineflayer HTTP API
- Register `kanban_create`, `kanban_complete`, `kanban_block` tools
- Register `recall_resource`, `recall_near` tools
- Intercept `tool_call` events to enforce the **reflex-first verb allowlist** (embodied-control policy)
- Manage bot lease lifecycle (`mc bot checkout/renew/release`)
- Register `/filechanges`, `/filechanges-accept`, `/filechanges-decline` commands

Pi's `pre_tool_call` hook is the natural place for the **path allowlist** (agents can't read `bot/`, `plugins/`, `scripts/`, `dashboard/`).

### 3.2 Pi Skill = Hermescraft Agent Bundle

Pi's skill format (`SKILL.md` with YAML frontmatter) is the **Agent Skills standard** that hermescraft already uses. Direct mapping:

| Hermescraft | Pi |
|---|---|
| `skills/kanban-worker.md` (L0) | Global skill loaded on every worker |
| `skills/minecraft-survival.md` (L1) | Skill loaded for all bot-bound execution |
| `skills/agent-navigator.md` (L2) | Skill `agent-navigator` — scoped to navigator cards |
| `skills/minecraft-navigation.md` (L3) | Companion skill, referenced from L2 |
| `data/workspace/reference/souls/<agent>.md` | Becomes the skill's system-prompt body or a separate prompt template |

Pi's `--skill <path>` flag and `skill_view` dynamic loading give exactly the **narrow catalog per card** hermescraft wants.

### 3.3 Pi Session = Hermescraft Card Worker

One Pi session is one agent loop with tools + state. This maps cleanly to one hermescraft card worker:

| Hermescraft worker | Pi session |
|---|---|
| Fresh context per spawn | Fresh Pi session per card |
| Narrow skill catalog (`skills=[...]`) | `--skill agent-miner --skill minecraft-mining` |
| Tool allowlist (agent surface) | `pi.setActiveTools([...])` in extension |
| MC env injection at spawn | Extension reads `metadata.bot`, sets env vars before loop |
| Complete → handoff metadata → exit | Session ends; custom entry written to session log |

The key insight: **Pi is already designed for the thing hermescraft wants most** — a fresh, narrow, skill-scoped agent invocation.

### 3.4 Pi `local-models` extension = Hermescraft bot registry

The `local-models.ts` extension in abhinand5's pi-setup shows how to register self-hosted endpoints as Pi providers. The same pattern works for bot bodies: a `hermescraft-bots` extension could register each bot registry entry as a "provider" the agent selects via `/model`, with the bot's HTTP endpoint as the base URL.

---

## 4. The gaps

These are architectural mismatches — not showstoppers, but places where Pi's design philosophy differs from hermescraft's needs.

### 4.1 Orchestration: Pi has no persistent dispatcher

Pi is designed for **interactive coding sessions** — one human, one agent, one terminal. Hermescraft needs **persistent orchestration**:

- `@planner` parsing DSL and emitting intents continuously
- `@dispatcher` ticking every N seconds, applying bind rules, handling bot death/rebind
- `@overseer` reviewing epic completion asynchronously
- URGENT cards preempting non-urgent work

Pi's `pi-multiagent` provides `agent_team` delegation, but it is:
- **Parent-centric**: parent remains lead; children are helpers
- **Evidence-based**: child output is evidence, not instructions to other agents
- **Short-lived**: children run one task and exit

Hermescraft's dispatcher is not a "helper" to a parent agent — it is an independent concern that binds bodies to cards without LLM involvement at MVP.

**Resolution:** Keep orchestration outside Pi. Pi runs the **worker** (card execution); an external lightweight system (Node/Python script or eventually a Pi extension daemon) runs the **orchestrator** (kanban board, dispatch tick, bot leasing).

### 4.2 Bot-body binding: Pi has no `metadata.bot` concept

Hermescraft's core trick is pairing an agent (expertise) with a bot (body) per card. Pi sessions don't have a "body" abstraction — they have a `cwd`, a model, and tools.

**Resolution:** Encode the body in the session environment. A wrapper script or extension:
1. Reads `metadata.bot` from the card
2. Looks up `data/bots/<bot>.yaml`
3. Sets `MC_API_URL` and `MC_USERNAME` as env vars
4. Spawns `pi --skill agent-miner` with those vars
5. The `mc` tool reads env vars to know which bot to control

This is identical to hermescraft's current "spawn injection layer" ([`target.md`](target.md)).

### 4.3 Session persistence: Pi sessions are TTY-oriented

Pi sessions are designed for interactive terminal use (TUI, user prompts, `ctrl+o` menus). Hermescraft workers are non-interactive — they run to completion without human input.

**Resolution:** Run Pi in **headless / CI mode**. Pi supports non-interactive modes (`--json`, `--yes`). The TUI components (`ctx.ui.select`, `ctx.ui.confirm`) would need fallback behavior when `!ctx.hasUI`.

### 4.4 Epic lifecycle: Pi has no parent-child card model

Hermescraft's epic model (parent card with children, `--epic` vs `--depends-on`, mass rebind on bot death) is built on Hermes v0.15's kanban primitives. Pi has no native kanban concept.

**Resolution:** Implement kanban as **tools** in the extension (`kanban_create`, `kanban_complete`, `kanban_block`) backed by the same SQLite DB. The epic logic lives in the external orchestrator, not in Pi.

### 4.5 Recall stream: Pi has no cross-session memory

Hermescraft's recall stream is append-only episodic memory shared across all agents. Pi sessions are isolated — one session does not read another's transcript.

**Resolution:** The `recall_resource` and `recall_near` tools query the host data API. This is external to Pi by design. The recall inject step (shifting bullets into card body before dispatch) happens in the orchestrator, before Pi spawns.

---

## 5. Proposed architecture: Pi for workers, external orchestrator for coordination

The cleanest split:

```
┌─────────────────────────────────────────────────────────────┐
│  ORCHESTRATION LAYER (external: Node/Python script)         │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │ @planner │  │ @dispatcher  │  │ @overseer          │   │
│  │ (LLM)    │  │ (script/LLM) │  │ (LLM or script)    │   │
│  └────┬─────┘  └──────┬───────┘  └─────────┬──────────┘   │
│       │               │                    │              │
│       └───────────────┼────────────────────┘              │
│                       ▼                                   │
│              Kanban board (SQLite)                        │
│              Bot lease DB (`~/.hermes/bot-leases.db`)     │
│              Recall stream (host API)                     │
└───────────────────────┬───────────────────────────────────┘
                        │ per-card spawn
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  WORKER LAYER (Pi sessions, one per card)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ @navigator   │  │ @miner       │  │ @crafter         │  │
│  │ pi session   │  │ pi session   │  │ pi session       │  │
│  │ --skill nav  │  │ --skill mine │  │ --skill craft    │  │
│  │ --bot pip    │  │ --bot pip    │  │ --bot pip        │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│  Each session:                                              │
│  - Loads agent skill bundle (L2) + companions (L3)          │
│  - Has `mc` tool wrapping Mineflayer HTTP API               │
│  - Has narrow `mc` verb allowlist (agent surface)           │
│  - Calls `kanban_complete` when done                        │
└─────────────────────────────────────────────────────────────┘
```

### What Pi handles (better than Hermes today)

- **Fresh, narrow worker context** — Pi's design philosophy matches hermescraft's "reset at card boundary" exactly
- **Skill system** — Agent Skills standard already used; `skill_view` dynamic loading is cleaner than Hermes' skill array
- **Extension ecosystem** — `mc` tool, `kanban` tools, `recall` tools, path allowlist hooks all live in one TypeScript extension
- **Model flexibility** — Pi's `@earendil-works/pi-ai` abstracts across 20+ providers; hermescraft is locked to whatever Hermes supports
- **TUI for debugging** — When a worker fails, a human can replay the Pi session interactively to diagnose

### What the orchestrator handles (same as today)

- Kanban board state and card lifecycle
- Bot lease management (checkout/renew/release)
- Dispatch tick and bind rules
- Epic parent-child relationships
- Recall inject (pre-dispatch context shaping)
- URGENT card preemption
- Fleet health monitoring

---

## 6. Concrete changes from current design

| Current (Hermes) | Pi-based | Impact |
|---|---|---|
| Hermes profile per agent (`~/.hermes/profiles/<agent>/`) | Pi skill per agent (`~/.pi/agent/skills/agent-<name>/`) + prompt template for SOUL | Skills become self-contained packages; SOUL is a prompt template |
| `kanban_create(skills=[...])` | `pi --skill agent-miner --skill minecraft-mining` | CLI flags instead of API call |
| `claim_lock` + `kanban_heartbeat` | Bot lease DB managed by orchestrator; Pi extension enforces via `mc bot checkout` | Same lease concept, different interface |
| `pre_spawn` hook for MC env injection | Extension or wrapper script sets env vars before `pi` spawn | Same spawn injection, different hook point |
| `landfolk` plugin gate-check | Pi extension `tool_call` interceptor | Same policy, different framework |
| `mc` verb registry (181 verbs) | Pi `mc` tool with sub-commands; agent surface generated from registry | Registry stays; Pi tool wraps it |
| `@mention` DSL parser in `@planner` | Same parser, but `@planner` is either an external script or a Pi session with `kanban_create` tool | Unchanged logic, different runtime |
| Two boards (`landfolk-ops`, `landfolk-backoffice`) | Same boards; back-office cards spawn Pi in workspace `cwd` with git worktree | Unchanged |

---

## 7. Open questions

1. **Pi session startup time** — Hermes worker spawn is fast (~1s). Pi TypeScript startup + skill loading + model connection may be slower. Does the per-card overhead matter?

2. **Context token budget** — Pi's system prompt includes loaded skills, extensions, and context files. With L0+L1+L2+L3 skills loaded, does the prompt exceed Hermescraft's target budget? Pi's compaction strategy differs from Hermes'.

3. **Non-interactive mode maturity** — Pi's `--json` and `--yes` modes are newer than the interactive TUI. Are they robust enough for hundreds of unattended worker spawns per day?

4. **Multi-model routing** — Hermescraft wants `@planner` on a strong model and `@miner` on a cheaper one. Pi supports per-session model selection (`--model`), but the orchestrator must manage this.

5. **Session persistence for handoff** — Hermescraft workers write handoff metadata (`exit_pos`, `inv_delta`) on `kanban_complete`. Pi sessions write custom entries via `pi.appendEntry()`. Is the ergonomics equivalent?

6. **Workspace tool integration** — Pi's built-in `read`/`edit`/`write` tools assume file-system access. Hermescraft's `pre_tool_call` allowlist restricts paths. Does Pi's tool implementation respect this, or does the extension need to shadow/replace the built-ins?

---

## 8. Summary

Pi is not a replacement for Hermescraft's **orchestration layer** (planner, dispatcher, kanban, bot leasing, recall stream). It is a strong candidate for the **worker runtime** (card execution, skill loading, tool calling, MC API interaction).

The architecture that falls out is:
- **Pi** = what runs inside each card (agent cognition, skills, `mc` tools)
- **External orchestrator** = what moves cards between states (dispatch, bind, epic lifecycle)

This is actually a cleaner separation than today's design, where Hermes handles both worker spawn and some orchestration primitives (kanban API, `claim_lock`). Pi's radical minimalism pushes the orchestration concern out of the agent framework entirely — which aligns with hermescraft's goal of keeping the dispatcher script-first at MVP.

If we were starting from scratch, the build order would be:
1. `hermescraft-minecraft` Pi extension (`mc` tool, verb allowlist, path restrictions)
2. Port `agent-navigator.md` to Pi skill format
3. One-card pilot: orchestrator spawns `pi --skill agent-navigator --bot pip`, measures tokens/turns/time vs Hermes baseline
4. If win: add `kanban_create`/`kanban_complete` tools, build dispatcher script, scale to full fleet

The risk is session startup overhead and non-interactive robustness. The reward is a modern skill ecosystem, model flexibility, and a TUI that humans actually want to use for debugging.
