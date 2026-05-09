# Phase 1 — Experimentation Summary

**Run window:** 2026-05-09 (single afternoon, ~1h of active experimentation)
**Branch:** `experiment/hermes-agents` off `refactor`
**Hermes version:** v0.13.0 (2026.5.7), upgraded from v0.11.0 at start

This document synthesizes the three Phase 1 experiments and lists what should change in Phase 2's architecture proposal.

## What we ran

| Experiment | Outcome | Key signal |
|------------|---------|------------|
| 1.1 — `/goal` autonomy (single bot, mine 8 cobble + craft stone pickaxe) | Did not reach goal; agent grinded ~6min in one ReAct turn before manual termination | `/goal` works mechanically; agent reasons about Minecraft; action layer is the bottleneck |
| 1.2 — Kanban orchestration (Hermes-only, 4-card pipeline w/ deps) | Pipeline completed end-to-end in ~6 minutes; high-quality deliverables | Kanban is a real distributed task queue with atomic claims, dependencies, dispatcher |
| 1.3 — Two-agent goal-preset reactivity | "Failed" at original task but produced architecture-revising findings | Custom-metric goals get urgency=0; `/goal` sessions are short-lived; mission-scoped pattern needed |

Each experiment has its own findings doc with full detail; this is the cross-cutting synthesis.

## Cross-experiment findings

### 1. `/goal` is the right autonomy primitive *for one bounded mission*

`/goal` (in `hermes_cli/goals.py`) runs a Ralph-loop with an auxiliary judge: agent acts → judge evaluates → if not done, continuation prompt → repeat. Default 20 agent turns, configurable.

- Confirmed working as the **execution primitive** for a single autonomous task.
- **Not viable** as a "always-on bot brain" — sessions exit within minutes (max-turns / judge / natural completion). Long-lived tmux pattern from the preliminary architecture is wrong.
- Best fit: **one `/goal` session per mission**, scoped to a single goal text and a known success predicate. Spawn → run → exit → next mission.

### 2. Kanban is the right multi-agent substrate

Hermes' built-in kanban (1.2) is a full SQLite-backed task queue with:
- Atomic per-task claims (`hostname:pid` lock + TTL)
- Dependency graph (`hermes kanban link parent child`)
- Per-task workspace dir (`~/.hermes/kanban/workspaces/<id>/`)
- Per-task log file (`~/.hermes/kanban/logs/<id>.log`)
- Dispatcher embedded in `hermes gateway` (60s default tick)
- Auto-reclaim of stale claims; auto-block after `failure_limit` failures
- Audit log + per-spawn run records

This **replaces** the bespoke "scripted orchestrator + per-character tmux" sketch from the preliminary architecture. We get all the queue/dispatch machinery for free.

### 3. Custom-metric goal entries don't work; retargeting existing ones does

Critical finding from 1.3: the goal engine in `bot/lib/goals/engine.js` has a fixed metric registry. Injecting a goal with an unknown metric (`dirt_total`) yields `urgency=0.1, gap=null` — the bot's `mc goals` ranks by urgency, so the agent never sees it as top.

But: `POST /goals/update` to **change `target_min` / `priority` of a known goal** (e.g., `supply_cobblestone`) DOES propagate immediately and changes the urgency ranking.

For the steward → bot brain control surface, this means:
- Within the existing metric vocabulary (food, pickaxe, iron, coal, stone, diamond, threat, survive, chest_mark, plus builder-side fence/walls/arrows), the steward has full control via target manipulation.
- For free-form objectives ("explore biome X", "talk to villager Y"), goal-preset writes are NOT enough. Use kanban tasks with mission-specific `/goal` text instead.

### 4. The `mc` action layer has structural gaps

Confirmed across 1.1 and 1.3:
- `mc collect <name> <count>` returns `ok:true` even when `mined_count=0` (silent failure).
- `mc dig <x> <y> <z>` works correctly. The 1.3 agent self-corrected.
- Tool responses dominate token spend (~90% of message bytes in 1.1's session DB).
- `mc observe`/`mc nearby`/`mc scene` are heavy; we should add a leaner variant.
- Pathfinding to canopy logs from ground was unreliable (1.1).
- Bot got stuck in terrain holes repeatedly (1.1).

These are hermescraft, not Hermes, problems — and they're the throughput bottleneck.

### 5. Multiple Hermes profiles run concurrently with no contention

In 1.2, three hermes-spawned worker processes ran in parallel (worker-a × 2 tasks + worker-b × 1). No mutex on profile. **A profile is a config persona, not a worker slot.** This means a single character profile can hold multiple in-flight kanban tasks (though we probably want one bot body = one active task to avoid action conflicts).

### 6. `delegate_task` is for short-lived intra-task fan-out

In 1.2, the variant-A worker (researching 3 LLM frameworks) used `delegate_task` to spawn 3 parallel research subagents in ~50s. This is the right pattern for **transient fan-out within one task**, not for long-lived bot brains (which is what 1.1's plan-mode notes correctly warned about).

### 7. The specifier flow is a clean triage → ready primitive

`hermes kanban specify <id>` runs a one-shot LLM call (against the active profile) that takes a coarse triage card title and produces a structured spec (Goal / Approach / Acceptance / Out-of-scope), retitles it, and promotes to ready. Sub-second on cheap models. **Reusable as the human → steward ingress point** in Phase 2 — human posts coarse intent, specifier enriches, dispatcher routes.

### 8. Workers can read sibling/parent task workspaces

In 1.2's pipeline, the analysis worker `find`-ed for `papers.md` in sibling workspace dirs and read it directly. Workers are NOT auto-wired to parent outputs but they figure it out. **A small ergonomic improvement** would be a `kanban_workspace(<id>)` tool that returns the parent task's workspace path on demand.

### 9. Agents diverge from skill instructions

In 1.3, the explicit `minecraft-preset-reactive` skill (read goals → execute top entry) was overridden by the agent's broader judgment + memory. **For mission-critical control, embed the directive in the goal text itself, not in a skill.** Skills are advisory; `/goal` text is the contract.

### 10. Memory contaminates new sessions

In 1.3, Flint's behavior was strongly influenced by 1.1's narrative (returned to the same canopy log coordinates). For mission-scoped runs we likely want `--ignore-rules` (skip auto-injected memory/SOUL) per mission. The kanban dispatcher could pass this by default for tasks with `workspace_kind: scratch`.

## Architecture revisions for Phase 2

The preliminary architecture (long-lived `/goal` in tmux + scripted orchestrator + steward writing goal-presets) needs **major revision**.

### Old model (preliminary, in plan file)
```
   Steward profile (cron-tick 5min)
        ↓ writes
   data/goal-presets/<bot>.json     ← read by bot brain each cycle
        ↓
   Long-lived /goal session in tmux per character (Flint, Mason, etc.)
        ↓
   Mineflayer body
```

### New model (revised by 1.3)
```
   Human → posts coarse mission card to triage
        ↓ kanban specify
   Specifier (any cheap profile) → enriches into structured spec
        ↓ promotes to ready
   Steward profile (kanban-orchestrator role) → routes mission to character
        ↓ kanban assign
   Dispatcher (in gateway) → spawns hermes worker per mission
        ↓
   Worker: hermes -p <character> --skills kanban-worker,minecraft-<role>
              chat -q "/goal <mission text>"
        ↓
   Mineflayer body (one per character, long-lived)
        ↓ on completion
   Worker calls kanban_complete → next mission spawned
```

Plus, **goal-preset retargeting (within recognized metrics) remains** as a fast micro-control:
- Steward edits `target_min` of food/pickaxe/iron/etc. via `POST /goals/update` to nudge bot priorities mid-mission.
- This is the *micro* control loop; kanban is the *macro* loop.

### Steward as in-game ATC — still works

The "diegetic steward at a fixed tower" concept survives. The steward profile:
- Has its own Mineflayer body parked at the tower (long-lived body).
- Runs kanban-driven missions like any other character — but its missions are management-flavored ("decompose X into kanban tasks for the team", "dispense diamonds from treasury chest").
- Uses kanban_create + retargeting to coordinate, not direct mid-task commands.
- Treasury / patrol / status announcements remain as part of the steward's mission portfolio.

## What's ready to graduate from `experiment/hermes-agents` to main

- `~/.hermes/skills/gaming/minecraft-flint-mission/SKILL.md` (1.1) — pattern for per-character mission skills. Generalize per character.
- `~/.hermes/skills/gaming/minecraft-preset-reactive/SKILL.md` (1.3) — keep as a reference; not the recommended pattern after 1.3 findings.
- `scripts/orchestrator-v0.sh` (1.3) — shows the API surface but should be **superseded** by kanban-driven orchestration in Phase 2.
- All three findings docs and this summary.

## Branch-scope refactors needed (carry into Phase 2)

Identified in 1.1 and 1.3, urgency confirmed:

1. **Fix or replace `mc collect`** — must surface zero-mined as failure. Either return `ok:false` when `mined_count==0 && requested>0`, or surface `mined_count` as a top-level field.
2. **Add `mc dig`-based collection wrapper** — `mc collect_v2 <name> <count>` that uses `mc dig` under the hood and verifies inventory delta.
3. **`mc observe_lean`** — return only fields the agent acts on; cull verbose nearby-block lists.
4. **Custom metric registration** in `bot/lib/goals/engine.js` — accept arbitrary metric names with sensible defaults (or expose `evaluate_fn` per goal).
5. **`/api-spec` route on bot HTTP server** — OpenAPI listing of available actions/queries.
6. **Anti-revisit memory in pathfinder** — bot kept falling into the same hole at Y=62 in 1.1.
7. **Per-character `--ignore-rules` invocation** — kanban-spawned workers should not inherit cross-session memory by default.

## Open questions for Phase 2 plan

- **Steward profile's model:** kimi-k2.6 felt right for orchestrator role (capable, follows JSON contracts) — confirm vs cost in production.
- **Mission lifecycle policy:** does a mission `done` mean the bot's goal-engine should reset to defaults? Or hold pos? Define explicitly.
- **Treasury chest interaction:** untested. Need experiment in Phase 2 with `mc chest` + a marked location.
- **Cross-character chat as a coordination signal:** untested. Bots could `mc read_chat` to overhear each other.
- **PaperMCP for steward god-mode:** preliminary architecture suggested using PaperMCP `effect` to make steward invulnerable. Untested.
- **Production budget:** with deepseek-v4-flash workers + kimi-k2.6 steward, estimate token spend at 4 active characters × 10 missions/day. Need a budget rail.

## Files committed on `experiment/hermes-agents`

```
docs/experiments/
├── 1.1-goal-autonomy.md
├── 1.2-kanban-orchestration.md
├── 1.2-deliverables/
│   ├── analysis-comparison.md
│   ├── research-papers.md
│   └── synthesis-paragraph.md
├── 1.3-two-agent-collaboration.md
└── phase-1-summary.md          ← this file
scripts/
└── orchestrator-v0.sh           ← reference, superseded by kanban in Phase 2
```

Hermes-side artifacts (not in branch but referenced):
- `~/.hermes/skills/gaming/minecraft-flint-mission/SKILL.md`
- `~/.hermes/skills/gaming/minecraft-preset-reactive/SKILL.md`
- `~/.hermes/config.yaml` — added `auxiliary.goal_judge: moonshotai/kimi-k2.6`

## Phase 2 deliverable

A new plan file at `~/.claude/plans/<phase-2-name>.md` proposing:
1. The revised target architecture in detail (kanban-driven, steward-as-orchestrator, characters-as-profiles, /goal-per-mission).
2. Refactoring approach for hermescraft (action-layer fixes, custom metrics, lean observe, per-mission invocation pattern).
3. Migration sequence with concrete tasks ordered by dependency.
4. Token budget and operational expectations.
5. Initial mission portfolio: what missions exist, how the steward decomposes coarse intent, what success predicates look like.

To be written in a separate plan-mode session, drawing on this summary and the three findings docs.
