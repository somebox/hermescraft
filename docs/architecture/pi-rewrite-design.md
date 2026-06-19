# Hermescraft on Pi: Rewrite Design

Status: **design proposal** — not committed, ready for review.

This doc describes what a hermescraft rewrite on top of Pi would look like, informed by three external sources:
- Pi's [extension API](https://pi.dev/docs/latest/extensions) (lifecycle events, tools, commands, session management)
- [dabit3's Pi layer tutorial](https://gist.github.com/dabit3/e97dbfe71298b1df4d36542aceb5f158) (composing pi-ai → pi-agent-core → pi-coding-agent → pi-tui)
- [pi-crew](https://github.com/baphuongna/pi-crew) (production multi-agent orchestration on Pi — task graphs, child processes, durable state)

The thesis: **pi-crew proves that sophisticated multi-agent orchestration on Pi is viable without touching Pi core.** We apply pi-crew's architecture patterns to the hermescraft problem space (Minecraft fleet management), keeping what maps cleanly and redesigning what doesn't.

---

## 1. What we learned from pi-crew

pi-crew is a Pi extension that coordinates teams of agents for software engineering tasks. It is the closest existing system to what hermescraft wants to build. Its architecture validates several design choices:

| pi-crew pattern | Hermescraft equivalent | Verdict |
|---|---|---|
| One child `pi` process per task | One card → one fresh worker | **Direct match** |
| Agent = markdown file (`agents/planner.md`) with YAML frontmatter (name, description, model, tools, systemPromptMode) | Agent = Hermes profile (SOUL + skills) | **Cleaner on Pi** — no profile directory needed |
| Task graph scheduler with dependency resolution | Epic parent-child chains + `--depends-on` | **Direct match** |
| Durable state on disk: `manifest.json` + `tasks.json` + `events.jsonl` | Kanban DB + ephemeral worker state | **Better** — every run is inspectable after the fact |
| Async/background runs with detached processes | Long mining/building tasks | **Direct match** — 30-min mine ops survive session shutdown |
| Worktree isolation per task | Back-office `[MR]` cards | **Same pattern** |
| Fleet widget + `/team-dashboard` command | `scripts/roster.py` + manual board checks | **Much better UX** |
| Extension layer stays thin; runtime does the work | Landfolk plugin does everything | **Better separation** |

### pi-crew's critical insight

> The extension layer should remain thin: user input is normalized into tool parameters, then delegated to runtime/state modules.

This is the opposite of hermescraft's current landfolk plugin, which embeds dispatch logic, mutex enforcement, and gate-checks inside a Paper plugin. On Pi, the extension registers tools and commands; the runtime (Node/TypeScript) handles orchestration.

---

## 2. Architecture: four layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 4: Pi TUI — human interface                                   │
│  Fleet widget, /fleet-dashboard, /fleet-status, bot health overlay   │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 3: Pi Extension — thin surface                                │
│  Registers: mc tool, kanban tools, recall tools, /fleet commands     │
│  Intercepts: tool_call (path allowlist), before_agent_start          │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 2: Runtime — orchestration engine (Node/TS)                   │
│  Bot registry, lease manager, dispatch scheduler, task graph runner  │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 1: State — durable storage                                    │
│  SQLite (kanban cards), JSONL (run manifests/events), bot leases     │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer 4: TUI (human interface)

Pi's TUI framework (`pi-tui`) provides components for real-time fleet status:
- **Fleet widget** — shows bot status (idle/busy/offline), current card, agent profile, lease holder
- **Active run panel** — progress bar, elapsed time, token count, cost
- **`/fleet-dashboard`** command — full-screen dashboard with bot lanes, kanban columns, recall stream tail
- **`/fleet-status`** command — text summary for non-interactive use
- **`/bot <name>`** command — inspect bot registry entry, lease state, last heartbeat

This replaces `scripts/roster.py`, `scripts/board-recent.py`, and manual kanban queries.

### Layer 3: Extension (thin surface)

The `hermescraft-pi` extension (~500 lines) registers:

**Tools** (LLM callable):
- `mc` — Mineflayer HTTP API wrapper (`mc goto`, `mc dig`, `mc scene`, etc.)
- `kanban_create` / `kanban_complete` / `kanban_block` / `kanban_comment`
- `recall_resource` / `recall_near` — query host recall stream
- `bot_checkout` / `bot_renew` / `bot_release` — bot lease lifecycle

**Commands** (user callable):
- `/fleet-status` — fleet snapshot
- `/fleet-dashboard` — full dashboard
- `/bot <name>` — bot inspection
- `/recall <subject>` — query recall stream

**Event interceptors**:
- `tool_call` — enforce path allowlist (agents can't read `bot/`, `plugins/`, `scripts/`, `dashboard/`)
- `before_agent_start` — inject MC env vars (`MC_API_URL`, `MC_USERNAME`) when `metadata.bot` is set
- `session_start` — load fleet widget, register bot providers

**Critical**: The extension does NOT contain dispatch logic. It provides the surface; the runtime (Layer 2) provides the orchestration.

### Layer 2: Runtime (orchestration engine)

This is a Node/TypeScript daemon (or cron-triggered script at MVP) that runs independently of Pi sessions. It is the spiritual successor to `@planner`, `@dispatcher`, and `@overseer`.

**Components:**

| Component | Responsibility | Maps from |
|---|---|---|
| **BotRegistry** | Read `data/bots/*.yaml`, expose HTTP API for status/health | `bots-and-mc.md` registry |
| **LeaseManager** | `checkout`/`renew`/`release` with `lease_version` fencing, ranking | `bot-lease.md` |
| **TaskScheduler** | Build task graph from epic, compute ready set, apply concurrency | `epic-lifecycle.md` |
| **DispatchEngine** | Lexicographic bind rules, maintenance card injection, rebind on bot death | `board-dynamics.md` |
| **RecallService** | Append-only host API, near-subject queries, inject bullets into card body | `data-api.md` |
| **RunExecutor** | Spawn child Pi processes, monitor JSONL output, capture artifacts | pi-crew's `child-pi.ts` |
| **Observer** | Parse child Pi stdout/stderr, update agent status, detect hangs/crashes | pi-crew's observer |

**Run flow** (informed by pi-crew's `executeTeamRun`):

```
Operator drops triage card
  │
  ▼
@planner agent (Pi session) parses @mention DSL → emits intents
  │
  ▼
DispatchEngine binds bot to each intent → writes kanban cards
  │
  ▼
TaskScheduler builds task graph (epic children + depends-on chains)
  │
  ▼
RunExecutor spawns child Pi per ready task:
  pi --skill agent-navigator --bot pip --mode json --goal "goto :mine_nw:"
  │
  ▼
Child Pi executes → calls mc tools → completes → kanban_complete
  │
  ▼
Observer captures result → updates task state → marks next tasks ready
  │
  ▼
(loop until all tasks terminal)
```

### Layer 1: State (durable storage)

Inspired by pi-crew's `.crew/state/` layout:

```
.hermescraft/
  state/
    runs/{runId}/
      manifest.json        # run metadata, goal, team, workflow, status
      tasks.json           # task graph with per-task status
      events.jsonl         # append-only run events
      agents/{taskId}/
        status.json        # agent progress, model, tool calls
        transcript.jsonl   # raw child Pi session
        output.log         # compact stdout/stderr
    bots/
      leases.jsonl         # bot lease history
      health.jsonl         # heartbeat events
    recall/
      events.jsonl         # recall stream append-only
      index.json           # subject/type clustered hints
  artifacts/
    {runId}/
      goal.md              # initial goal artifact
      prompts/{taskId}.md  # rendered task prompt
      results/{taskId}.txt # completion result
      handoffs/{taskId}.json # exit_pos, inv_delta, etc.
```

The kanban board itself stays in SQLite (Pi's `kanban_create` tool writes to it), but the orchestration state is JSONL for human inspectability.

---

## 3. Agent definitions: markdown files

pi-crew's `agents/planner.md` pattern replaces Hermes profiles. Each agent is a self-contained markdown file:

```markdown
---
name: navigator
description: Move bots between marks with obstacle avoidance
model: false                    # use Pi's default
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
tools: mc, kanban_complete, recall_near
---

You are a navigation specialist. Your job is to move a bot to a target mark
using the mc tool. You have access to: mc goto, mc scene, mc observe.

## Scope
- One navigation leg per card
- Start from current position or last exit_pos
- End at target mark with facing alignment

## Done criteria
- Bot is within 2 blocks of target mark
- Bot is facing the mark's required direction
- mc verify at_mark passes

## Stop criteria
- Bot health < 50%
- Nightfall without shelter
- Path blocked after 3 reroute attempts

## Handoff
On kanban_complete, include:
- exit_pos: [x, y, z]
- facing: "north" | "south" | "east" | "west"
- route_quality: "clear" | "partial" | "blocked"
```

**YAML frontmatter fields:**
- `name` — agent identifier (`navigator`, `miner`, `planner`)
- `description` — for agent selection / routing
- `model` — specific model override, or `false` for default
- `systemPromptMode` — `replace` (full SOUL) or `append`
- `inheritProjectContext` — whether to include `AGENTS.md` / `SYSTEM.md`
- `inheritSkills` — whether to auto-load matching skills
- `tools` — allowlist of tool names for this agent

This replaces:
- `~/.hermes/profiles/<agent>/SOUL.md` → the markdown body
- `~/.hermes/profiles/<agent>/skills/` → `--skill` flags
- `~/.hermes/profiles/<agent>/config.yaml` → YAML frontmatter

**Skill loading:** At spawn, the runtime passes `--skill agent-navigator --skill minecraft-navigation --skill minecraft-survival` to Pi. The agent's `tools` field further narrows via `pi.setActiveTools()`.

---

## 4. Mapping from current architecture

| Current (Hermes-based) | Pi-based rewrite | Port effort |
|---|---|---|
| `~/.hermes/profiles/<agent>/` (SOUL + skills + config) | `agents/<agent>.md` (YAML frontmatter + body) | **Low** — skills already markdown, SOUL becomes body |
| `data/bots/<bot>.yaml` | `data/bots/<bot>.yaml` (unchanged) | **None** — pure data |
| `skills/agent-*.md` (L2 bundles) | `skills/agent-*.md` (Pi skills) | **Low** — add YAML frontmatter, same body |
| `skills/minecraft-*.md` (L3 companions) | `skills/minecraft-*.md` (Pi skills) | **None** — already in Agent Skills format |
| `data/workspace/` (5 domains, OWNERS) | `data/workspace/` (unchanged) | **None** — pure data |
| `bot/cli/registry.mjs` (~181 mc verbs) | Extension `mc` tool with sub-commands | **Medium** — wrap HTTP calls, generate help |
| `plugins/landfolk/` (gate-check, mutex) | Extension `tool_call` interceptor + runtime LeaseManager | **Medium** — split between layers |
| `scripts/kanban` (SQLite facade) | Runtime kanban module + Pi `kanban_*` tools | **Medium** — same DB, new API surface |
| `scripts/roster.py` | `/fleet-status` command + fleet widget | **Low** — replace script with TUI |
| `@planner` (DSL parse, intent emit) | `agents/planner.md` + runtime task builder | **Medium** — same parser, new runtime |
| `@dispatcher` (bind, maint, rebind) | Runtime DispatchEngine | **Medium** — logic moves from script to daemon |
| `@overseer` (epic verify) | Runtime policy closeout | **Low** — simpler on Pi |
| `@navigator`, `@miner`, etc. | `agents/<agent>.md` + child Pi spawn | **Low** — definitions are simpler |
| Recall stream (host API) | Runtime RecallService + JSONL storage | **Medium** — same schema, new backend |
| `mc verify` predicates | Extension `mc` tool sub-command | **Low** — already structured |
| Two boards (`landfolk-ops`, `landfolk-backoffice`) | Same two boards; back-office spawns Pi in workspace cwd | **None** — unchanged concept |

---

## 5. What changes fundamentally

### 5.1 Worker spawn model

**Current:** Hermes worker spawns on a profile directory. The profile is persistent; skills are pre-installed.

**New:** Each card spawns a fresh `pi` process with `--skill` flags. The process is ephemeral; skills are loaded per invocation.

**Why this is better:**
- Pi's skill system is designed for exactly this (dynamic `skill_view` loading)
- No profile directory management
- Skills are versioned as markdown files in git, not installed into homes
- Agent "identity" is the markdown file + runtime env vars, not a directory

### 5.2 Orchestration ownership

**Current:** `@dispatcher` is a bot-less Hermes profile that runs as a worker on the kanban board.

**New:** DispatchEngine is a Node/TypeScript runtime daemon (or cron script at MVP). It does not run inside Pi. It watches the kanban DB, applies bind rules, and spawns Pi processes.

**Why this changes:** Pi has no persistent orchestration primitive. pi-crew solves this with an external runtime + extension combo. We follow the same pattern.

### 5.3 Session persistence

**Current:** Hermes sessions are opaque — the transcript is internal to Hermes.

**New:** Every child Pi session writes a `transcript.jsonl`. The parent runtime can read it for debugging, metrics, and forensics. Pi's `SessionManager` gives us this for free.

**Why this matters:** When a mining task fails after 20 minutes, you can open the transcript and see exactly what `mc` calls were made, what the bot observed, and where it went wrong.

### 5.4 Tool registration

**Current:** `mc` verbs are registered in a JavaScript module (`bot/cli/registry.mjs`). Agents discover them via a generated cheatsheet.

**New:** The extension registers one `mc` tool with a `verb` parameter. The tool description lists available verbs. The agent surface (which verbs to show) is controlled by `pi.setActiveTools()` per session.

**Why this is simpler:** One tool, one executor, one help text. The verb registry lives in the extension, not in a separate module.

---

## 6. Build order (MVP → scale)

### Phase 0: Foundation (week 1)
1. `hermescraft-pi` extension skeleton — registers `mc` tool with 5 core verbs (`goto`, `scene`, `observe`, `dig`, `place`)
2. `agents/navigator.md` — first agent definition
3. One manual spawn: `pi --skill agent-navigator --bot pip --mode json`
4. Measure: tokens, turns, time vs Hermes baseline

### Phase 1: One-card pipeline (week 2)
1. Runtime `RunExecutor` — spawns Pi child, captures JSONL output
2. Runtime `BotRegistry` — reads `data/bots/*.yaml`
3. `kanban_create`/`kanban_complete` tools in extension
4. End-to-end: operator writes card → runtime spawns Pi → bot moves → card completes

### Phase 2: Dispatch (week 3)
1. Runtime `TaskScheduler` — task graph with parent-child + depends-on
2. Runtime `DispatchEngine` — lexicographic bind, bot lease checkout/release
3. Epic support: `@planner` agent emits intents → scheduler builds graph → executor runs

### Phase 3: Fleet (week 4)
1. Fleet widget + `/fleet-status` command
2. Recall stream service + `recall_resource`/`recall_near` tools
3. `mc verify` predicates
4. URGENT card preemption

### Phase 4: Back-office (week 5)
1. `landfolk-backoffice` board support
2. Git worktree isolation for `[MR]` cards
3. `@engineer` agent definition

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Pi child process startup > 2s | High | Measure early (Phase 0). If too slow, use pi-crew's warm-pool pattern (pre-spawned idle workers) |
| Pi non-interactive mode immature | Medium | Use `--mode json` with explicit `--yes`. Fallback to `--mode print` if JSON has issues |
| Context token budget with L0+L1+L2+L3 | Medium | Pi's compaction is aggressive. Measure prompt size per agent. Trim skill bodies if needed |
| Extension runs in same Node as user Pi | Low | Extension is thin; runtime is separate process. No interference |
| Bot HTTP API latency affects tool calls | Low | `mc` tool has built-in timeout. Bot health check before spawn |
| One failed child Pi blocks epic | Medium | pi-crew's `needs_attention` status + retry logic. Epic doesn't block on single task failure |

---

## 8. Summary

Pi-crew demonstrates that everything hermescraft wants — multi-agent orchestration, task graphs, child worker processes, durable state, fleet dashboards — can be built **on top of** Pi without modifying Pi core.

The rewrite architecture is:
- **Pi** runs the cognition inside each card (skills, tools, LLM interaction)
- **Extension** provides the `mc` surface and path restrictions
- **Runtime** handles orchestration (dispatch, leasing, task scheduling)
- **State** lives on disk in inspectable JSONL/SQLite

What we keep from hermescraft:
- Bot registry (`data/bots/*.yaml`)
- Workspace structure (`data/workspace/` with 5 domains)
- Skill catalog (`skills/` — already Agent Skills format)
- Card semantics (`assignee`, `metadata.bot`, epic chains)
- Recall stream schema (subject, type, where, who)

What we drop:
- Hermes profile directories (`~/.hermes/profiles/`)
- Landfolk Paper plugin
- `scripts/landfolk-control.sh` spawn wrapper
- Per-bot Hermes homes

What we gain:
- Modern skill ecosystem (Agent Skills standard, `skill_view` dynamic loading)
- 20+ LLM providers via `pi-ai`
- Interactive TUI for debugging failed workers
- Session tree / branching for exploration
- pi