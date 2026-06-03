# landfolk Hermes plugin — kanban orchestration cleanup

> ## ⚠ Status update — 2026-06-02: under deprecation
>
> This plugin is being retired in favour of upstream-native Hermes capabilities (`kanban_create(parents=[…])` for serialisation, `--idempotency-key` for dedup, gateway-embedded dispatcher for spawning). See [`data/postmortems/establish-2026-06-02/ARCHITECTURE-FINDINGS.md`](../../data/postmortems/establish-2026-06-02/ARCHITECTURE-FINDINGS.md) for what we verified and [procedural-planning.md Phase 6](procedural-planning.md#phase-6--upstream-alignment) for the migration plan.
>
> **Key finding:** the plugin's `post_tool_call` hooks were never registered with Hermes (`ctx.register_hook(...)` is missing — compare disk-cleanup or langfuse plugins). The only enforcement path was `hermes landfolk gate-check`, which only fires when `scripts/landfolk-dispatcher.sh` calls it once per tick. That script was not running during the 2026-06-02 establish run, so the plugin's mutex code was dormant. Workers got spawned by the gateway-embedded dispatcher (despite the `dispatch_in_gateway: false` config) with no per-assignee guard. The dual-claim symptom we kept seeing is the documented failure mode when these layers fight.
>
> The historical content below is preserved as a record of *why* we did what we did. Don't extend it; if you find yourself reaching for it, check the migration plan first.

**Status:** Phase 1 orchestrator **complete** (2026-05-31). Shipped 2026-05-27 (`73ab8cf`); Phases A–D closed without a dedicated 6h lab soak — production evidence from genesis `g-2026-05-30-3` (6h 21m) substituted (see [Phase D verification](#phase-d-verification-2026-05-31)). Supersedes `kanban-flow-cleanup.md` (deleted). Next plugin work: [Plan A — mark-drift](#plan-a--mark-drift-detector), [Plan B — kanban_yield](#plan-b--kanban_yield).
**Owner:** re44 + steward
**Companion docs:**
- [steward-out-of-game.md](../archive/steward-out-of-game.md) — future Steward runtime model (webhook-driven, no in-game body). Orthogonal; not blocked by this plan.
- [../guides/hermes-platform.md](../guides/hermes-platform.md) — broader Hermes platform integration practices.

## Goal

Build a single Hermes plugin named `landfolk` (`plugins/landfolk/` in this repo, symlinked to `~/.hermes/plugins/landfolk`) that owns landfolk-specific extensions to the Hermes platform. The first subsystem (`orchestrator/`) enforces a per-assignee concurrency cap on the `landfolk-ops` kanban board, replacing three independent userland mutex layers with one cohesive plugin.

Subsequent subsystems (mc tools, compressor, memory provider, chat-bridge platform adapter, detector cron jobs) are scoped in this doc's backlog and live under `plugins/landfolk/landfolk/<subsystem>/` when implemented.

The architectural invariant from `kanban-flow-cleanup.md` carries forward:

> We do not patch Hermes. Hermes is updated regularly upstream and any local edits will be clobbered. We provide our extensions via the supported plugin / platform-adapter / hook surfaces. Agents express landfolk behaviour through tools, skills, prompts, and now this plugin; Hermes is the platform.

## Background — the three problems we're solving

### Problem 1: Hermes has no per-assignee concurrency cap

v0.14's stock `kanban.max_spawn` is a **global** cap across the whole board. The dispatcher's ready-card selector is `WHERE status='ready' AND claim_lock IS NULL ORDER BY priority DESC, created_at ASC` — no filter on whether the assignee already has a running card. Within one dispatcher tick, claims are serialized per profile, but **across consecutive ticks** a long-running worker can have a second worker spawned beside it on the same bot body. The two workers race for control of the same Mineflayer process, the bot walks in circles, and sessions corrupt (NaN coords, `invalid_player_movement` kicks, `Pos:null,66,null` packets).

For Minecraft, **profile = body**. We need exactly one worker per profile at any time.

Upstream tracking:
- [NousResearch/hermes-agent#29034](https://github.com/NousResearch/hermes-agent/issues/29034) — "Kanban defaults can auto-launch unbounded paid worker swarms"
- [NousResearch/hermes-agent#28805](https://github.com/NousResearch/hermes-agent/issues/28805) — "no config key for a worker concurrency cap (`max_spawn` only reachable via CLI)"

### Problem 2: The current workaround overloads `task_links`

Three independent enforcement layers exist today:

1. **Steward SOUL** (`prompts/landfolk/steward.md:79-126`) — every planning cycle Steward counts `{ready, running}` per assignee. If >1, she `hermes kanban block <id> "queue-mutex: <profile> busy with <other>"` the excess. Releases when the bot frees up.
2. **Worker SOUL** (`skills/kanban-worker.md:225-279`) — before `kanban_create --assignee X`, workers check if X already has a non-done card; if yes, pass `parents=[in_flight_id]` so the new card parks in `todo` until X is free.
3. **Dispatcher pre-flight** (`scripts/landfolk-dispatcher.sh:65-322`) — 322 lines of Python embedded in bash. Every 60s tick scans `{running, ready, todo}` cards grouped by assignee. For any group >1, **creates a SERIAL `task_links` chain** A→B→C. Hermes' `claim_task` then demotes children back to `todo` if their parent isn't done.

All three encode "mutex within a bot's queue" as parent→child edges in `task_links`. The same edge set is also supposed to express real domain prerequisites ("flint mines iron → mason crafts pickaxe"). Once the two intents are mixed, you cannot tell at read-time which edge is which. Reassignment cleanup becomes heuristic and lossy.

Real bugs this has produced:

| Commit | Symptom |
|---|---|
| [`1995335`](https://github.com/somebox/homelab/commit/1995335) | Initial dispatcher per-assignee mutex (the workaround itself). |
| [`198151e`](https://github.com/somebox/homelab/commit/198151e) | `t_cda2e6d8` stranded `ready` for 8033s (2.2h) because a `claim_lock=orch_continuous:steward` survived reassignment to flint. Hermes' built-in `release_stale_claims` only handles `running` tasks; ready locks never expire. |
| [`338cccd`](https://github.com/somebox/homelab/commit/338cccd) | Steward reassigned 6 cards flint→mason for load-balancing; mason couldn't pick any up because the pre-reassignment mutex chains still pointed at flint's running work. Fix: heuristic prune of cross-assignee edges, **explicitly accepting occasional false-positive prune of real cross-bot domain deps** as the cost of unjamming mutex artifacts. |

### Problem 3: The `blocked` column is overloaded

Analysis of 126 historical block events on the live `landfolk-ops` board (2026-05-25 → 2026-05-26):

| Category | Count | % | What it really means |
|---|---:|---:|---|
| `queue-mutex` | 40 | 32% | Self-inflicted mutex workaround. **Vanishes with this plan.** |
| Iteration-budget-exhausted (90/90, 150/150, 50/50) | 39 | 31% | Worker hit max-turns. Called `kanban_block` because that was the only terminal verb available. **NOT a real blocker** — should be "make partial progress, please respawn me." |
| `spawn_failed` (bot-down, server unreachable) | 8 | 6% | Operational — bot process died between spawn and first action. |
| `stuck` (physically stuck in-game) | 6 | 5% | Rescue case; needs human or peer bot. |
| `manual` (operator re-blocked) | 4 | 3% | re44 stopped a card mid-flight. |
| `prerequisite_missing` | 3 | 2% | Real domain dependency discovered in-flight. |
| `help-needed` | 3 | 2% | The form blocks *should* take. |
| crashed / timeout / no_reason | 4 | 3% | misc framework noise |
| `other` (terrain blockers, dep chain breaks, "cannot reach", spec confusion) | 19 | 15% | Genuinely varied; one-off. |

**~63% of blocks are noise we created or noise the framework forced.** The 32% queue-mutex band vanishes. The 31% iteration-budget band points at a separate fix (smaller cards + custom `kanban_yield` tool — backlog).

The user-visible problem: when re44 looks at the blocked column, they can't tell at a glance whether each card needs (a) a human decision, (b) terrain work, (c) more time/budget, (d) a stuck-bot rescue, (e) an upstream fix, or (f) is self-cleaning mutex noise. Steward has to triage every block, which is itself heavy work.

## Architecture

```
                ┌────────────────────────────────────────┐
                │  Operator (re44) / In-game chat        │
                └───────────────┬────────────────────────┘
                                │
                ┌───────────────▼────────────────────────┐
                │  Hermes Gateway (UNMODIFIED)           │
                │  - kanban CLI dispatcher (out-of-proc) │
                │  - kanban.dispatch_in_gateway: false   │
                │  - kanban.auto_decompose: false        │
                └───────────────┬────────────────────────┘
                                │
                ┌───────────────▼────────────────────────┐
                │  scripts/landfolk-dispatcher.sh        │
                │  every 60s tick:                       │
                │   1. hermes landfolk gate-check        │◄── NEW (this plan)
                │   2. hermes kanban dispatch --max 3    │
                └───────────────┬────────────────────────┘
                                │
        ┌───────────────────────┼────────────────────────┐
        │                       │                        │
  ┌─────▼─────┐           ┌─────▼─────┐            ┌─────▼─────┐
  │  Steward  │           │   Flint   │            │   Mason   │
  │ continuous│           │  kanban   │            │  kanban   │
  │ (≥60s)    │           │  worker   │            │  worker   │
  └───────────┘           │ ephemeral │            │ ephemeral │
                          └───────────┘            └───────────┘
                                         each worker calls kanban_complete
                                         / kanban_block, triggering plugin's
                                         post_tool_call observers
```

Two enforcement layers, both narrow:

**1. Out-of-process gate-check** (`hermes landfolk gate-check`). Runs every dispatcher tick **in the same shell tick** as `hermes kanban dispatch`, immediately before it. The dispatcher script (`scripts/landfolk-dispatcher.sh`) sequences:

```bash
hermes landfolk gate-check --board "$BOARD"   # 1. enforce invariant
hermes kanban     --board "$BOARD" dispatch   # 2. spawn workers
```

That ordering matters: between gate-check finishing and dispatch starting, only milliseconds pass, so the window where a stray ready card could be claimed by the dispatcher without being parked is bounded by the duration of one CLI invocation. Cross-tick state (parked cards, orchestrator locks) survives via `claim_lock`, so the next tick keeps the invariant whether or not anything happens in between.

Idempotent SQL pass:
- Release stale orchestrator parks (reassignment leftovers, expired TTLs).
- Park `assignee=steward` ready cards with `claim_lock=orch_continuous:steward` so the dispatcher skips them.
- Release `claim_lock=mutex_park:<assignee>` from parked cards whose assignee is now idle (no running, no non-parked head).
- For each non-orchestrator assignee with cards in `{ready, running}`:
  - Sort by `running first, priority DESC, created_at ASC`.
  - The first running card (or first non-`[CHAT_REQUEST]` non-locked ready card) is the head — leave it alone.
  - For all other ready siblings: write `claim_lock=mutex_park:<assignee>` so the dispatcher skips them. Status stays `ready` so they remain visible in the queue.
  - `[CHAT_REQUEST]` cards are exempt — kept claim_lock-free alongside any running sibling.
- For each non-orchestrator assignee with no active card, promote the highest-priority `todo` (parents-done) to `ready`.

This catches **every** path to ready: `recompute_ready` cascades, Steward's `terminal`-shelled-out CLI writes, manual SQL, dashboard drag-drop. Plugin hooks alone cannot see all of these (the dispatcher's internal `recompute_ready` calls don't go through the tool layer).

**2. `post_tool_call` observer hooks**. Run inline as workers finish; saves the ≤60s wait for the next gate-check tick:
- `kanban_complete` / `kanban_block` → call `promote_next_for(assignee, conn)` to bring the next-best todo forward immediately.
- `kanban_create` / `kanban_unblock` → if the just-touched card landed in `ready` and the assignee was already busy, demote to `todo`.
- `kanban_archive` → scan children of the archived task; comment a warning on any that were waiting on it.

**Crucially, no `pre_tool_call` blocking.** Tool calls always succeed; demote-after is the policy. Rationale: blocking forces agents to handle tool errors, which breaks Steward's continuous-loop reasoning and burns iteration budget on retries.

The two layers don't conflict — hooks are an *acceleration* of the gate-check policy, never a separate enforcement. The gate-check is the source of truth.

### Why a plugin (not another patch / not a separate daemon)

| Alternative | Why rejected |
|---|---|
| Patch `~/.hermes/hermes-agent/hermes_cli/kanban_db.py` | Architectural invariant: no Hermes patches. They get clobbered on `hermes update`. |
| Standalone Python daemon | We already have one (the dispatcher's inline 322 lines). The plugin path gives us proper enable/disable, hook integration, CLI subcommands, and a future home for related subsystems. |
| Shell hooks in `~/.hermes/config.yaml` | Per-event subprocess spawn cost. Less discoverable than a plugin with a YAML manifest. Useful for one-off integrations, not for a multi-subsystem extension. |
| Platform adapter (the chat-bridge's home) | Adapters bridge a single messaging platform. Not a fit for cron-like enforcement. Future chat-bridge subsystem inside this plugin uses the adapter pattern. |

## Scope (this rollout)

**In scope:**
1. Build the `landfolk` plugin skeleton: manifest, register hooks, register CLI, smoke test.
2. Implement the `orchestrator/` subsystem completely: gate-check CLI, promote helpers, post-hook observers.
3. Switch `landfolk-dispatcher.sh` to call `hermes landfolk gate-check`. Delete the 322-line inline Python.
4. Strip the per-bot-mutex passes from Steward and worker SOULs.
5. Add new SOUL/skill patterns (first-turn spec review, in-place blocker resolution, smaller-card discipline).
6. Documentation: this file lives; `kanban-flow-cleanup.md` deleted.

**Out of scope (backlog at end of doc):**
- `mc_tools/` subsystem (register `mc_*` as native Hermes tools)
- `compressor/` subsystem (mc-aware token reduction)
- `memory/` subsystem (mc-aware memory provider)
- `mc_chat_adapter/` platform adapter (bot chat → Steward as gateway messages)
- `detectors/` subsystem (cron-script-only board health probes)
- `kanban_yield` custom tool (partial-completion signal for iteration-budget case)
- Steward out-of-game cutover — tracked separately in [steward-out-of-game.md](../archive/steward-out-of-game.md)
- Steward migration to bundled `kanban-orchestrator` skill (separate small change)

## Design decisions (locked)

| Tag | Decision | Rationale |
|---|---|---|
| **D1** | Plugin name `landfolk` (not `landfolk-orchestrator`, not `landfolk-lanes`) | Single namespace for everything coming. "Lanes" in v0.14 means dashboard visualization — using it for a concurrency primitive would mislead. |
| **D2** | Plugin lives at `plugins/landfolk/` in this repo, symlinked to `~/.hermes/plugins/landfolk` | Single source of truth in git; edits live instantly; PRs reviewable. Matches the pattern of `scripts/` and `skills/`. |
| **D3** | Hook policy: `post_tool_call` observer-only; **no `pre_tool_call` blocking** | Blocking forces Steward and workers to handle tool errors, breaks reasoning flow, burns iteration budget on retries. Gate-check tick (≤60s lag) is enforcement; hooks accelerate the common case. |
| **D4** | Mutex mechanism: **`claim_lock=mutex_park:<assignee>`** on excess ready cards (status stays `ready`), NOT `task_links` chain construction and NOT status-demote to `todo` | Eliminates the link-overload bug class. `task_links` returns to expressing real domain prerequisites only. Status-demote was the original choice but lost to `recompute_ready` auto-promoting parent-less todos on every `kanban list` call (discovered live on first install). claim_lock parking mirrors the existing orchestrator-park mechanism, is recompute_ready-safe, and keeps cards visible in the ready column so operators see the queue. |
| **D5** | Out-of-process gate-check is the primary enforcement layer | Catches every path to `ready` — including dispatcher-internal `recompute_ready` cascades that hooks cannot see. |
| **D6** | `[CHAT_REQUEST]` cards exempt from the cap | Title-prefix match. Whisper-driven operator interaction shouldn't queue behind worker tasks. Greppable; no priority-threshold debates. |
| **D7** | Orchestrator-park retains `claim_lock=orch_continuous:steward` mechanism, migrated into the plugin | Steward's own cards must never be dispatcher-spawned. The existing pattern works; consolidating it into the plugin removes one of the dispatcher's responsibilities. |
| **D8** | SOUL/skill workflow patterns ride alongside the plugin code, not behind a feature flag | First-turn review, in-place resolution, smaller-card discipline are doctrine the agents implement. No framework change required. |
| **D9** | Iteration-budget-exhausted blocks remain a known problem; `kanban_yield` is designed-not-built | The 39 historical events are the second-biggest block category. A custom tool is the right fix but adds plugin scope; first verify the mutex-demote model in production. |

## The per-assignee invariant

**Rule.** For every assignee `A` in the assignable roster (i.e. excluding `default` / `re44` / `librarian`-style non-spawnable identifiers and excluding orchestrator profiles):

```
count(tasks WHERE assignee=A AND status IN ('ready','running') AND NOT is_chat_request) ≤ 1
```

**Exemptions.**
- Orchestrator profiles (currently just `steward`) — their `ready` cards are claim_locked `orch_continuous:<profile>`, the dispatcher skips them, the orchestrator processes them via her own loop (or via the future steward-out-of-game webhook). Multiple ready cards for an orchestrator are allowed.
- `[CHAT_REQUEST]` cards — title prefix match; cards with this prefix keep `ready` status even when a sibling is `running`. They represent operator-driven interruption lanes.

**Violation detection.** The gate-check pass enumerates assignees with cards in `{ready, running}`; for each it sorts by `status='running' first`, then `priority DESC`, then `created_at ASC`; keeps the head; demotes the rest (subject to exemptions).

**Detection inputs:**
- Read: `tasks.assignee`, `tasks.status`, `tasks.priority`, `tasks.created_at`, `tasks.title`, `tasks.claim_lock`
- Read: `task_links` (for "are parents done?" before promoting `todo`)
- Write: `UPDATE tasks SET status='todo'` for demotion, `UPDATE tasks SET status='ready'` for promotion, `INSERT INTO task_events (kind='demoted'/'promoted', payload)` for audit trail

## Gate-check pass (plain English)

Each tick, before `hermes kanban dispatch`:

1. **Release stale orchestrator parks.**
   - Any `claim_lock LIKE 'orch_continuous:%'` where the assignee is no longer in the orchestrator profile set → release the lock.
   - Any orch_continuous lock with `claim_expires < now()` → release. (Defensive; we re-apply the lock with a fresh TTL each tick.)
   - Log a `mutex: released N stale orchestrator claim_lock(s)` line if any released.

2. **Park orchestrator-assigned ready cards.**
   - For each `tasks.status='ready' AND assignee IN orchestrator_profiles AND claim_lock IS NULL`:
     - Set `claim_lock='orch_continuous:<assignee>'`, `claim_expires = now() + 3600`.
   - The dispatcher's `WHERE claim_lock IS NULL` filter skips these.

3. **Enforce the cap per non-orchestrator assignee.**
   - For each distinct lowercased `assignee` where `assignee` has any card in `{ready, running}` and `assignee NOT IN orchestrator_profiles`:
     - Select that assignee's cards in `{ready, running}` ordered by `(running first, priority DESC, created_at ASC)`.
     - Compute `keep_ids`:
       - If any card is `running`: keep the running card and any `[CHAT_REQUEST]` cards. All other `ready` siblings → demote to `todo`.
       - If no card is `running`: keep the head + any `[CHAT_REQUEST]` cards.
     - For each card not in `keep_ids` whose status is `ready`: `UPDATE tasks SET status='todo'`, insert `task_events(kind='demoted')`.

4. **Promote next-best todo for idle assignees.**
   - For each non-orchestrator assignee with NO `{ready, running}` card after the demote pass:
     - Find the highest-priority `todo` card for that assignee whose parents are all `done`/`archived`.
     - `UPDATE tasks SET status='ready'`, insert `task_events(kind='promoted', payload={by:'landfolk-orchestrator', reason:'assignee_free'})`.

5. **Commit and emit a single log line.**
   - Format: `[HH:MM:SS] orch: promoted=N demoted=N orch_parked=N orch_released=N`
   - Only log if any counter is nonzero; otherwise stay silent. Dispatcher's separate heartbeat handles the "still alive" signal.

## Hooks — what they do and what they don't

### `post_tool_call` observers

| Trigger | Action | Why |
|---|---|---|
| `kanban_complete` | Look up the completed card's assignee; call `promote_next_for(assignee, conn)` | Worker just freed up. Promote the next ready card now instead of waiting up to 60s for the gate-check tick. |
| `kanban_block` | Same as complete — call `promote_next_for(assignee, conn)` | Bot is back to idle; pull the next card. |
| `kanban_create` | If the new card landed in `ready` and the assignee already has a `running` or `ready` sibling, demote to `todo` | Catches Steward's create-while-busy without making her handle a tool error. |
| `kanban_unblock` | Same as create — if landing into `ready` while assignee busy, demote to `todo` | Same rationale. |
| `kanban_archive` | Find children of the archived task. For each child whose only undone parent was the archived one, post a `kanban_comment` noting "parent archived without completion; verify preconditions" | Surfaces broken dependency chains before the child worker burns turns discovering them. |

### What hooks explicitly do NOT do

- **Block tool calls.** No `pre_tool_call` returning `{action:"block"}`. Tools always succeed.
- **Modify return values.** Hooks are observers; they don't rewrite `kanban_create`'s `{ok, task_id, status}` envelope even if they immediately demote the card.
- **Replace the gate-check.** Steward's CLI calls (via `terminal` tool, e.g. `hermes kanban block ...`) never enter the kanban tool layer. The dispatcher's `recompute_ready` cascades (called inside `complete_task` / `claim_task` / `specify_triage_task` / `decompose_triage_task` / its own tick) don't fire tool-call hooks. The gate-check covers all of these.

### Hook coverage table

| Path to `ready` | Hooks fire? | Gate-check covers? |
|---|---|---|
| `kanban_create` (no parents, agent-called) | Yes | Yes |
| `kanban_unblock` (agent-called) | Yes | Yes |
| `kanban_complete` → internal `recompute_ready` promotes a sibling | No (hook fires on complete, but the promotion is a side-effect inside the same connection) | Yes |
| `claim_task` → internal `recompute_ready` | No (no tool involved) | Yes |
| CLI `hermes kanban unblock <id>` (via Steward's `terminal` tool) | Only `terminal` hook fires; kanban-specific hook does not | Yes |
| Manual SQL / dashboard drag-drop | No | Yes |
| Dispatcher tick's `recompute_ready` | No | Yes (gate-check runs *before* dispatch each tick) |

## SOUL / skill changes

The plugin removes mutex code from agent SOULs and replaces it with new doctrinal patterns that emerged from the live-board analysis. None of these require framework changes.

### Worker SOUL (`skills/kanban-worker.md`)

**Removed (lines ~225-279):** the entire "Creating cards: one-in-flight per assignee (`--parent` rule)" section. Replacement note (~3 lines):

> **Per-assignee concurrency is automatic.** The `landfolk` plugin's gate-check enforces ≤1 ready/running per assignee. Just `kanban_create` normally; if the assignee is busy, the card parks in `todo` automatically and is promoted when the bot frees up. No `--parent` chaining required.

**Added — First-turn spec review.** On every claim, before doing real work:

1. `kanban_show` and read the card body.
2. Judge clarity: are the inputs named (coords/marks)? Are acceptance criteria specific? Is the assignee a fit for the work?
3. If clearly underspec'd:
   - `kanban_comment(body="clarification-needed: <specific question>")`
   - `kanban_reassign(steward)`
   - Exit before burning iteration budget on a wrong-shaped task.
4. If clear, proceed.

Targets the cluster of "started, hit confusion, blocked after burning 50 turns" failures.

**Added — In-place blocker resolution.** When a small obstacle is discovered on-site with materials in hand:

- Place a missing block; fill a small cave; clear a one-tile blockage.
- Comment what you did on the card so Steward can see the deviation.
- Only bounce to `blocked` when the in-place fix would take >20 turns or requires materials you don't have.

Targets the cluster of "discovered terrain blocker → blocked → Steward triages → new card → walk back → resume" round-trips.

### Steward SOUL (`prompts/landfolk/steward.md`)

**Removed (lines ~79-126):** the "Per-bot mutex — ONE card past `todo` per assignee" section. Replacement note (~3 lines):

> **Per-bot mutex is automatic.** The `landfolk` plugin enforces ≤1 card in `{ready, running}` per assignee every dispatcher tick. Create, specify, reassign normally; the plugin demotes excess back to `todo` and promotes the next-best when a bot frees up. `[CHAT_REQUEST]` cards are exempt and run alongside the bot's current work.

**Added — Smaller-card discipline.** When creating a SUPPLY/CONSTRUCT card with a quantity:

- 32 units or less → one card.
- 33-96 units → split into chunks of 32. Each chunk is its own card with the same assignee.
- 97+ → discuss with re44 first.

The pattern prevents the iteration-budget-exhausted-as-block failure mode (39 of 126 historical blocks). Workers complete chunks within their max-turn budget; the gate-check promotes the next chunk as each completes.

## Plugin layout

```
plugins/landfolk/                          # source-of-truth in this repo
├── plugin.yaml
├── __init__.py                            # register(ctx) wires every subsystem
├── README.md
└── landfolk/
    ├── orchestrator/                      # PHASE 1 — this rollout
    │   ├── __init__.py
    │   ├── config.py                      # env-driven knobs, constants
    │   ├── gate.py                        # gate_check(conn): the idempotent SQL pass
    │   ├── promote.py                     # promote_next_for, has_active_card, is_chat_request
    │   ├── hooks.py                       # post_tool_call observers
    │   ├── cli.py                         # `hermes landfolk gate-check`
    │   └── log.py                         # dispatcher-log writer
    ├── mc_tools/                          # PLACEHOLDER — see backlog
    ├── compressor/                        # PLACEHOLDER — see backlog
    ├── memory/                            # PLACEHOLDER — see backlog
    └── _shared/                           # cross-subsystem helpers (mc terminology, etc.)
        └── __init__.py
└── tests/
    ├── conftest.py                        # temp SQLite kanban DB fixture
    ├── test_promote.py
    ├── test_gate.py
    └── test_hooks.py
```

Symlinked at install time:

```bash
ln -sfn "$REPO_ROOT/plugins/landfolk" "$HOME/.hermes/plugins/landfolk"
hermes plugins enable landfolk
```

The symlink + enable step is added to `scripts/setup-landfolk-profiles.sh` as an idempotent action.

## Plugin manifest (`plugin.yaml`)

```yaml
name: landfolk
version: 0.1.0
description: |
  Landfolk Minecraft project Hermes integrations. Phase 1: per-assignee
  kanban concurrency for the landfolk-ops board. Future phases: mc tools,
  context compressor, memory provider, chat-bridge platform adapter.
author: jeremy@somebox.com
kind: standalone
hooks:
  - post_tool_call
```

`kind: standalone` = opt-in via `plugins.enabled` in `~/.hermes/config.yaml`. No auto-load.

## Configuration

Env vars read at plugin init:

| Var | Default | Purpose |
|---|---|---|
| `LANDFOLK_BOARD` | `landfolk-ops` | Board the gate-check operates on |
| `LANDFOLK_DISABLE_GATE` | unset (active) | Set to `1` to skip the gate-check pass (incident kill switch) |
| `LANDFOLK_DISABLE_HOOKS` | unset (active) | Set to `1` to skip the post_tool_call handlers |
| `LANDFOLK_ORCH_PROFILES` | `steward` | Comma-separated list of orchestrator profiles (cards auto-parked) |
| `LANDFOLK_LOG` | `/tmp/hermescraft/dispatcher.log` | Where the gate-check writes its single-line tick output |

The kill switches let us disable the plugin's enforcement without uninstalling — useful during incident response.

## Phased migration

### Phase A — Build & install (no behavior change)

- Create `plugins/landfolk/` source tree per layout above.
- Implement `orchestrator/` modules.
- Unit tests against a temp SQLite DB.
- Manual install: symlink + `hermes plugins enable landfolk`.
- **`landfolk-dispatcher.sh` unchanged** — old mutex still active. Plugin runs alongside as no-op (gate-check not yet wired in).
- Smoke-test for 1-2 in-game sessions; confirm hooks load without errors via gateway log.

**Gate to Phase B:** unit tests pass, hooks observed firing on live worker completions, no crashes.

### Phase B — Switch dispatcher to the plugin's gate-check

- Edit `scripts/landfolk-dispatcher.sh`: delete `enforce_assignee_mutex()` (lines 65-322) and its call site. Replace tick body with:
  ```bash
  hermes landfolk gate-check --board "$BOARD" 2>>"$LOG_FILE" || echo "[$ts] gate-check FAILED" >>"$LOG_FILE"
  out=$(hermes kanban --board "$BOARD" dispatch --max "$MAX" 2>&1)
  # ... rest unchanged
  ```
- Steward and worker SOULs still carry legacy mutex passes (belt-and-braces).
- Verify ~260-line net delete from dispatcher.

**Gate to Phase C:** functional test (see below) passes; 4-hour live soak with 2 active bots shows no card stranded > 2 ticks.

### Phase C — Strip SOUL mutex passes + add new doctrine

- `prompts/landfolk/steward.md` — remove "Per-bot mutex" section; insert automation note; add "Smaller-card discipline" section.
- `skills/kanban-worker.md` — remove `--parent` rule section; insert automation note; add "First-turn spec review" and "In-place blocker resolution" sections.
- Run `scripts/setup-landfolk-profiles.sh --apply-config` to push prompt updates into `~/.hermes/profiles/`.

**Gate to Phase D:** soak with 3-4 active bots over a full afternoon shows no per-assignee race, no reassignment-stranded cards, iteration-budget block events trending down.

### Phase D — Documentation and cleanup (closed 2026-05-31)

- Append devlog entry pointing at this doc + commit refs — see `docs/planning/devlog.md` (2026-05-27 PM + 2026-05-31 closeout).
- Delete `docs/features/kanban-flow-cleanup.md` — **done** (`62a500d`, file absent from tree).
- **`task_links` mutex-artifact audit** — **not run as a recorded repo step.** Optional one-shot on live `landfolk-ops` DB when convenient (SQL in acceptance criteria below). Plugin no longer creates same-assignee mutex edges; survivors are historical only.
- **6-hour soak gate** — **not re-run in lab.** Substituted by genesis `g-2026-05-30-3` postmortem (`data/genesis-runs/g-2026-05-30-3/findings/`): 6h 21m, **0** cards in `blocked`, no `queue-mutex:` block pattern, Mason self-recovered nav without reassignment-strand class recurrence.

## Phase D verification (2026-05-31)

Evidence reviewed from git history and devlog (no new long soak executed).

| Acceptance item | Evidence |
|---|---|
| Plugin + `orchestrator/` + tests | `73ab8cf`, `plugins/landfolk/tests/` (`test_gate.py`, `test_hooks.py`, `test_promote.py`) |
| Dispatcher uses gate-check only | `scripts/landfolk-dispatcher.sh` ~140 lines; **no** `enforce_assignee_mutex` / inline mutex Python |
| SOUL/skill mutex retired | `prompts/landfolk/steward.md`, `skills/kanban-worker.md` — plugin `mutex_park` / automation notes; first-turn spec review + in-place resolution present |
| `kanban-flow-cleanup.md` removed | Deleted; content folded into this doc per devlog 2026-05-27 |
| Docs shipped | `62a500d` (plugin shipped, steward-out-of-game archived), `006237b` (fleet-prefix marks + chat adapter categories) |
| Production soak substitute | `g-2026-05-30-3` findings: gate-check + hooks in use; blocked column empty for recipe stall (card stayed `ready`, not `blocked`) |
| **`task_links` audit** | **Open optional** — no commit/log of SQL audit; run manually if board predates plugin |
| **`hermes update` survival** | Not re-verified on 2026-05-31; symlink + enable in `setup-landfolk-profiles.sh` remains the post-upgrade step |

**D9 gate (build `kanban_yield`):** mutex model treated as verified for planning purposes — proceed with [Plan B](#plan-b--kanban_yield).

## Test strategy

### Unit (Phase A gate)

```bash
cd plugins/landfolk && python -m pytest tests/ -v
```

Expected coverage:

**`test_promote.py`:**
- Promotes lone `todo` for idle assignee.
- Ordering: high-priority before low-priority; same priority, oldest `created_at` first.
- Skips card with undone parent.
- No-op when assignee already has ready/running.
- Idempotent (running twice = same result).

**`test_gate.py`:**
- 1 running + 3 ready for flint → 2 demoted, 1 ready remains.
- 0 running + 4 ready for flint → 3 demoted.
- Steward has 1 ready, claim_lock NULL → claim_lock becomes `orch_continuous:steward`.
- Steward's `orch_continuous` lock survives reassignment to flint → lock released by next gate-check.
- `[CHAT_REQUEST]` card stays ready when sibling is running.
- Second call is no-op (idempotency).
- `LANDFOLK_DISABLE_GATE=1` → gate-check is a no-op.

**`test_hooks.py`:**
- Post-hook after `kanban_complete` promotes next-best for that assignee.
- Post-hook after `kanban_create` with busy assignee demotes the new card.
- Post-hook after `kanban_archive` warns children waiting on the archived parent.
- `LANDFOLK_DISABLE_HOOKS=1` → handlers are no-ops.

### Functional (Phase B gate)

1. `scripts/landfolk start` — gateway + dispatcher up.
2. `hermes kanban --board landfolk-ops create "[BUILD] test" --assignee flint --priority 1` × 4 in quick succession.
3. Wait one dispatcher tick (60s). Expected: `hermes kanban list --assignee flint --status ready` returns exactly 1; the other 3 in `todo`.
4. Wait for the running worker to complete. The next dispatcher tick promotes exactly 1 of the 3 remaining todos.
5. Tail `/tmp/hermescraft/dispatcher.log` for the `orch: promoted=1 demoted=2` shape.
6. Archive one of the remaining todos; confirm the post_tool_call hook posts the "parent archived" warning comment on any of its children.

### Soak (Phase D gate)

6-hour live session with 3-4 active bots:

- Zero `queue-mutex:` block events in `task_events` (the workaround has been fully retired).
- No card stranded `ready` > 2 dispatcher ticks (post-hoc query on `task_events` ordering).
- No `claim_lock` value other than fresh `orch_continuous:*` or live worker claims.
- Iteration-budget-exhausted block events drop materially vs. baseline (smaller-card discipline working).
- No new reassignment-stranded cards (the class of bug `338cccd` fixed; this plan removes the root cause).

## Risks and what to watch for

| Risk | Mitigation |
|---|---|
| `recompute_ready` race vs. post-hook write | `kanban_complete` runs `recompute_ready` inside its own connection BEFORE the post-hook fires. Our post-hook opens a fresh connection; WAL means the read sees the just-committed state. Document the dependency; smoke-test with rapid completion bursts. |
| Between-tick race window (external write between gate-check and dispatch) | Mitigated by sequencing gate-check **in the same shell tick** as `hermes kanban dispatch`, with milliseconds between them. A direct SQL write or dashboard drag-drop that lands a new unlocked-ready card in that gap could be claimed by the dispatcher in the same tick before our next gate-check runs. Hermes v0.14's per-tick per-profile claim serialization caps the damage to one new worker per profile per tick; the next gate-check (60s later) re-asserts the invariant. Closing this fully would require a Hermes `pre_kanban_dispatch` hook (does not exist in v0.14). Accept the gap; soak monitors `task_events` for any double-spawn evidence. |
| `[CHAT_REQUEST]` interaction with `kanban.max_spawn=3` | Allowing chat-requests to ride alongside a running card means the global cap can bind under unusual load. Accepted trade-off — chat-requests are operator-driven and rare. |
| Plugin loaded but Hermes upgrade changes hook signatures | All handlers accept `**kwargs` for forward compatibility. Plugin hooks log exceptions and never crash the agent loop. |
| Phase B ships before plugin code is on every host | `hermes landfolk gate-check` errors out and the dispatcher logs `gate-check FAILED` each tick but keeps running. Verify Phase A install is done on every host before Phase B. |
| Steward continues using `terminal` shell-out for kanban writes | Her writes are caught by the gate-check tick (≤60s lag), not by hooks. Acceptable. Future small change: migrate Steward to bundled `kanban-orchestrator` skill so her writes flow through hooks. |
| Legacy task_links artifacts persist after Phase B | Audit query in Phase D. Survivors hand-checked and unlinked individually. The class of bug (cross-assignee chain edges) can't appear in new artifacts because the plugin doesn't create them. |

## Backlog (future plugin subsystems)

Each is a future change to this plugin, not a separate plugin. The shared `_shared/` helpers grow to support them.

### `mc_tools/` — register `mc_*` primitives as native Hermes tools

Today every `mc_*` call is shelled via the `terminal` tool + `bin/mc`. The `terminal` tool's per-call overhead (subprocess spawn, env setup, shell parse) is meaningful. Custom tools registered via `ctx.register_tool()` would:
- Live inside the agent's process; near-zero call overhead.
- Carry typed schemas Hermes can validate without round-tripping.
- Surface in `mc commands` introspection alongside built-in tools.
- Allow per-tool `pre_tool_call` gating (e.g. region protection, refusal of in-progress duplicate).

### `compressor/` — mc-aware context engine

Token-cheapen Minecraft observations before they enter the LLM context. Candidates:
- `mc nearby` output: collapse repeated-block runs to `stone ×142` rather than listing each cell.
- Block list responses: summarize.
- `mc scene` output: prioritize by relevance to the current task.

Plugged in as a Hermes context engine plugin (`plugins/context_engine/landfolk-compressor`). Single-select; competes with the default engine.

### `memory/` — mc-aware memory provider

Auto-surface mc-specific facts into MEMORY.md context:
- Active marks (chests, sites, hazards) relevant to the bot's current task.
- Recent region observations.
- Inventory deltas across runs.

Plugged in as a Hermes memory provider plugin. Single-select; competes with the default memory provider.

### `mc_chat_adapter/` — platform adapter

Polls each bot's `/chat` endpoint (or subscribes via SSE if added later). On `@steward` mentions or `help-needed:` block patterns, builds a `MessageEvent` and `await self.handle_message(event)` routing to Steward as a normal gateway message.

Three canonical message categories the adapter routes to Steward:

- **Mark proposals** — worker chats `@steward propose chest_food at 361,65,-583` (or whisper variant). Becomes a `[CHAT_REQUEST]` card on Steward's queue, or routes to her continuous loop directly. Steward verifies in-game and updates the shared marks file (`data/locations-base.json`) — the authoritative source for fleet-prefix marks (see Glossary: *Fleet-prefix mark*). Workers writing those names privately is treated as proposal-only.
- **Rescue requests** — worker's `mc rescue_request` output picked up as a synthesized message. The adapter is the unified intake even when the underlying mechanism is structured.
- **Help-needed blocks** — worker block messages prefixed `help-needed:` synthesized into a chat-style event so they're observable through the same pipeline as live chat.

Replaces the standalone `landfolk-chat-bridge.py` proposed in [steward-out-of-game.md](../archive/steward-out-of-game.md). Steward's outbound becomes an rcon `say` via a helper. Detector cron jobs send their signals through the same adapter (synthesized system messages) or directly via `hermes kanban` CLI calls. The shared-marks file becomes one of Steward's write surfaces alongside the kanban DB.

### `detectors/` — cron-script-only board health probes

- `stranded-cards.py` — every 10 min — finds cards with offline assignees; comments + optionally reassigns.
- `base-inventory-deficit.py` — every 5 min — runs `scripts/base-inventory.py --json`; files `[SUPPLY]` cards on deficit.
- `stale-blocks.py` — every 4 hr — finds blocks older than 6h that aren't `queue-mutex:`; comments or files `[HEALTH]`.
- `mark-drift.py` — every 30 min — scans every `data/locations-*.json` for fleet-prefix marks (`chest_*`, `base_*`, etc.). When a name has divergent coords across bots and no matching entry in `data/locations-base.json`, files a `[HEALTH] reconcile <mark>` card for Steward with the conflicting per-bot coords + timestamps. Steward verifies in-game and writes the canonical entry to `locations-base.json`; the next read by each bot picks it up.

Each is a Hermes `cron --no-agent` job pointing at `hermes landfolk detect <name>`. Zero LLM cost.

### `kanban_yield` custom tool — partial-completion signal

The 31% iteration-budget-exhausted-as-block class needs a real terminal verb that isn't `complete` (would resolve dependents) and isn't `block` (signals human attention). Design:

```python
kanban_yield(
    progress: dict,  # {"delivered": 60, "target": 120, "next_action": "..."}
    summary: str,    # one-line human-readable
)
```

Worker exits cleanly. Card status stays `ready` (so the dispatcher respawns next tick) or moves to a new `paused` status (TBD — adds to VALID_STATUSES, may need framework change). Run history records the yield. Next worker reads the progress and continues.

Designed here; **ready to build** after Phase D closeout (D9). See [Plan B](#plan-b--kanban_yield).

---

## Plan A — mark-drift detector

**Goal:** Surface fleet-prefix mark coord drift across bots and route Steward to reconcile into `data/locations-base.json` — without LLM cost.

**Existing code to reuse**

| Piece | Location | Role |
|---|---|---|
| Prefix list + merge rules | `bot/lib/runtime/locations.js` (`FLEET_MARK_PREFIXES`, `mergeMarks`) | Must stay in sync with detector |
| Manual reconciler | `scripts/reconcile-marks.py` | `scan_private_marks()`, `load_shared()`, conflict grouping by name → coord → owners |
| Chest mark aggregation | `scripts/base-inventory.py` `load_chest_marks()` | Shared-wins + `(shadowed)` reporting pattern for private vs `locations-base.json` |
| Steward workflow | This doc glossary *Fleet-prefix mark*; genesis `[RECONCILE]` + `reconcile-marks.py --auto` in `docs/features/genesis-boot.md` | Operator/Steward writes canonical shared file |

**Gap:** `mark-drift.py` and `hermes landfolk detect <name>` are **specified** (backlog § `detectors/`) but **not implemented**. No file under `plugins/landfolk/landfolk/detectors/`.

**Proposed implementation (incremental)**

1. **`scripts/mark-drift.py`** (repo script first, plugin CLI later)
   - Import or duplicate `scan_private_marks` / `is_fleet_mark` / `coord_of` from `reconcile-marks.py` (extract shared module `scripts/lib/locations_fleet.py` if both scripts need it).
   - For each fleet mark name:
     - If **missing from shared** and ≥2 bots agree on one coord → emit `info: consensus candidate` (reconcile can promote with `--auto`).
     - If **missing from shared** and **multiple coords** among privates → `drift: conflict`.
     - If **present in shared** and any private coord **≠ shared** → `drift: shadowed mismatch` (informational; shared already wins at read).
   - Output modes: `--json` for cron, `--file-card` → `scripts/kanban add "[HEALTH] reconcile lt_foo" ...` (or print suggested command for human).
2. **Tests:** `scripts/tests/test_mark_drift.py` with temp `data/locations-*.json` fixtures (mirror reconcile tests if any; add if missing).
3. **Plugin slice (optional second PR):** `plugins/landfolk/landfolk/detectors/mark_drift.py` + extend `cli.py` with `hermes landfolk detect mark-drift --dry-run` calling the same library; Hermes `cron --no-agent` entry documented in plugin README.
4. **Do not auto-write `locations-base.json` from the detector** — keep Steward/human/`reconcile-marks.py` as writers (authority pattern unchanged).

**Success criteria:** Running detector on a tree copy of `g-2026-05-30-3` mark files produces zero false conflicts on `chest_system` / shared `lt_*`, and flags duplicate `craft_table_*` only if we extend scope (out of scope for v1 — fleet prefixes only).

---

## Plan B — `kanban_yield`

**Goal:** Let workers exit at iteration budget with **partial progress** without using `kanban_block` (which reads as “human triage”) or `kanban_complete` (which closes the card and fires dependents).

**Problem evidence:** ~31% of historical blocks were iteration-budget exhaustion (`landfolk-plugin.md` § Problem 3). Smaller-card discipline (Steward SOUL) reduces frequency but does not replace a **continue** terminal.

**Existing surfaces**

| Surface | Location | Behavior today |
|---|---|---|
| Worker proxy | `scripts/wb` | `wb close` → `hermes kanban complete`; `wb block` / `wb escalate` → `hermes kanban block` |
| Facade | `scripts/kanban` | `complete` / `block` shell out to `hermes kanban` |
| Plugin hooks | `plugins/landfolk/landfolk/orchestrator/hooks.py` | `_PROMOTE_TRIGGERS = {kanban_complete, kanban_block}` → promote next todo / release mutex park |
| Card body trailers | `scripts/kanban` `_append_trailer` / worker-board-proxy meta cols | Progress could live in body trailer or `task_events.payload` |

**Design choices (locked for planning)**

1. **Worker-facing verb:** `wb yield "<summary>" --delivered N --target M` (and optional `--next "..."`) before a Hermes-native tool exists. Workers already use `wb` per Commit A (`docs/features/worker-board-proxy.md`).
2. **Kanban semantics (prefer no Hermes fork):**
   - **Option B1 (recommended):** `kanban_comment` with structured trailer `yield: {"delivered":60,"target":120,...}` + `kanban_reassign` same assignee OR leave card **`running`** and exit session — requires dispatcher/session to end worker without `complete`. Investigate whether Hermes worker exit on max-turns already leaves card `running` (then yield = comment + clean exit only).
   - **Option B2:** New Hermes status `paused` — needs upstream `VALID_STATUSES` change; heavier.
   - **Option B3:** Plugin `register_tool('kanban_yield', ...)` that writes `task_events(kind='yielded')`, updates body trailer, sets status **`ready`** with progress comment, releases worker — hook treats `kanban_yield` like `kanban_block` for **promote** (assignee free) but Steward board filters `yielded` events separately from `blocked`.
3. **Plugin hook:** Add `kanban_yield` to `_PROMOTE_TRIGGERS` (same as complete/block) so the next chunk/card promotes. Do **not** add to block reason taxonomy for stale-block detector.
4. **Next worker:** `wb context` / first-turn spec review reads latest `yield:` trailer or `task_events` payload and continues from `next_action`.
5. **Skill doc:** `skills/kanban-worker.md` — “At max turns with partial delivery, `wb yield ...` not `wb block iteration exhausted`.”

**Investigation tasks before coding**

- Confirm Hermes behavior when a worker session hits `--max-turns` without terminal verb (status of active card).
- Read `hermes_cli/kanban_db.py` `block_task` / `complete_task` for whether a third event kind can be added from plugin SQL only.
- Prototype `wb yield` as comment + structured trailer + `hermes kanban` subprocess; measure whether gate-check respawns same card on next tick (desired for chunk cards).

**Success criteria:** Synthetic card with target 128, worker yields at 64 → card not in `blocked`, Steward board shows progress, next spawn continues same card body without duplicate SUPPLY card.

---

## Acceptance criteria

- ✅ `plugins/landfolk/` exists with the layout above; all `orchestrator/` modules implemented; unit tests pass.
- ✅ `hermes plugins list` shows `landfolk` as enabled.
- ✅ `hermes landfolk gate-check --board landfolk-ops` runs in <500ms on a board with ≤200 cards.
- ✅ `landfolk-dispatcher.sh` no longer contains `enforce_assignee_mutex` (or `prune_cross_assignee_chain_edges`, or related Python). Line count net-reduced by ~260.
- ✅ `prompts/landfolk/steward.md` no longer contains a "Per-bot mutex" section.
- ✅ `skills/kanban-worker.md` no longer contains a `--parent` rule section; has new "First-turn spec review" and "In-place blocker resolution" sections.
- ✅ Functional test passes: 4 rapid-fire create-for-flint → 1 ready / 3 todo after one tick. *(Not re-run 2026-05-31; last verified at Phase B gate.)*
- ✅ 6-hour soak: zero `queue-mutex:` blocks; no stranded ready; no reassignment-strand class. *(Substituted by `g-2026-05-30-3` findings — not a dedicated lab soak.)*
- ✅ `docs/features/kanban-flow-cleanup.md` deleted; `docs/README.md` index points at this doc; devlog entries through 2026-05-31.
- ☐ Optional: `task_links` same-assignee active-edge audit on live DB (SQL in Phase D section above).
- ✅ `hermes update` (when next run) does not break landfolk operations — plugin survives upgrade; only post-update step is re-symlink if `~/.hermes/plugins/` was overwritten.

## Critical file references

| Topic | File |
|---|---|
| Live kanban DB | `~/.hermes/kanban/boards/landfolk-ops/kanban.db` |
| Hermes kanban core | `~/.hermes/hermes-agent/hermes_cli/kanban_db.py` (`recompute_ready` ~line 1829, `claim_task` ~1862, dispatcher loop ~3982) |
| Hermes plugin loader | `~/.hermes/hermes-agent/hermes_cli/plugins.py` (`VALID_HOOKS` ~line 128, `register()` API ~line 287) |
| Reference plugin | `~/.hermes/hermes-agent/plugins/disk-cleanup/` (post-hook + CLI subcommand template) |
| Current mutex code (to delete) | `scripts/landfolk-dispatcher.sh:65-322` |
| Steward SOUL (mutex to remove, smaller-card to add) | `prompts/landfolk/steward.md:79-126` |
| Worker SOUL (--parent to remove, review/in-place to add) | `skills/kanban-worker.md:225-279` |
| Setup script (symlink + enable) | `scripts/setup-landfolk-profiles.sh` |
| Companion future-work doc (archived) | `docs/archive/steward-out-of-game.md` — body-less Steward proposal, parked 2026-05-27 |
| Block-event analysis source | The kanban DB `task_events` table; query in §Problem 3 |

## Glossary

- **Lane** — Hermes v0.14 term for (assignee + spawn mechanism + lifecycle terminator). In our project, one lane per bot profile. Distinct from the dashboard's "Lanes by profile" visualization.
- **Orchestrator profile** — A profile whose role is board planning rather than ready-card execution. Currently just `steward`. Cards assigned to orchestrators are auto-parked by the gate-check so the dispatcher doesn't try to spawn a worker for them.
- **`[CHAT_REQUEST]` card** — A card filed by the chat-bridge daemon (or its future plugin replacement) representing an operator whisper to a worker. Exempt from the per-assignee cap because the operator wants the bot to respond immediately, not after its current task finishes.
- **Gate-check tick** — One run of `hermes landfolk gate-check`, fired by the dispatcher loop before `hermes kanban dispatch` each 60s. Idempotent SQL pass.
- **Mutex park** — `claim_lock=mutex_park:<assignee>` written to an excess ready card by the gate-check or post-hook. The card stays in `ready` status (visible in the queue) but the dispatcher's `WHERE claim_lock IS NULL` selector skips it. The next gate-check tick releases the lock when the assignee's active card finishes, making the parked card eligible to be claimed. Re-evaluated every tick — if a parked card's priority is bumped above the current head's priority (via SQL or dashboard), the gate-check swaps them on the next tick: releases the parked card's lock and parks the now-outranked head.
- **Orchestrator park** — `claim_lock=orch_continuous:<assignee>` written to ready cards assigned to an orchestrator profile (steward). Same mechanism as mutex park, different prefix so release logic stays separable. The orchestrator processes her own queue out-of-band; the dispatcher must never spawn a worker for her.
- **Status demote** — Original design (rejected during Phase A live test): flip excess ready cards back to `todo`. Hermes' `recompute_ready` runs inside `kanban_list` (and many other paths) and re-promotes any parent-less todo to ready on every call, undoing the demote within milliseconds. Replaced by mutex park.
- **Fleet-prefix mark** — A mark name beginning with a reserved prefix denoting shared base infrastructure: `chest_*` (base chests), `base_*` (base landmarks), `lt_*` (long-term sites). Workers may write these to their private `data/locations-<bot>.json` but the entry is treated as a *proposal*, not authoritative. The canonical coordinate lives in `data/locations-base.json`, written only by Steward — either directly during her continuous loop or in response to a worker chat proposal routed through the `mc_chat_adapter`. Every bot reads private + shared at startup and on mark lookup; shared takes precedence for fleet-prefix names. Drift between private and shared is surfaced by the `mark-drift.py` detector and resolved by Steward filing a `[HEALTH] reconcile <mark>` card and writing the verified entry to `locations-base.json`. Same authority pattern as orchestrator-park cards: shared fleet state, single writer, observer detectors.
