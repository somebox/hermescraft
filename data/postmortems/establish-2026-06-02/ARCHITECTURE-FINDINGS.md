# Architecture findings — establish 2026-06-02

**TL;DR.** The dual-claim and dup-card symptoms we've been chasing for weeks are both fixable with **default Hermes capabilities** (`--parent` dependencies + `--idempotency-key`). Our local plumbing — `scripts/landfolk-dispatcher.sh`, `plugins/landfolk/`, the `dispatch_in_gateway: false` override — shadows upstream features rather than complementing them, was based on an older bug that is no longer current, and was not actually enforcing the invariants we thought it was.

This document records (a) what we verified by direct test against the live Hermes install on 2026-06-02, (b) which of our docs got it wrong, and (c) the migration shape proposed in [procedural-planning.md Phase 6](../../docs/features/procedural-planning.md#phase-6--upstream-alignment).

## What we verified

Five small tests, all on the `scratch-mutex` board (no live bots, no production impact). Source DB: `~/.hermes/kanban/boards/scratch-mutex/kanban.db`.

| # | Test | Result | What it proves |
|---|---|---|---|
| α.1 | `hermes kanban dispatch` one-shot tick against a board with mixed `ready` cards | ✅ PASS. Tick spawned the spawnable card, logged `Skipped (non-spawnable assignee — terminal lane, OK)` for unknowns, recorded `claim_lock=macstudio.local:<pid>`. | Upstream dispatch works exactly as the docs say. Same code path the gateway-embedded loop calls. |
| α.2 | Create card A, create card B with `--parent A`, observe B.status until A completes | ✅ PASS. B.status='todo' until A done; auto-promoted to 'ready' the moment A flipped to 'done'. | Upstream `parents=[…]` mechanism is the canonical serialiser. |
| α.3 | `hermes kanban create` twice with the same `--idempotency-key` | ✅ PASS. Both calls returned the same task id. Only one row in DB. | Upstream has native idempotent create. |
| α.4 | `kanban.failure_limit: 2` auto-blocks repeatedly-failing tasks | ✅ DOCUMENTED (`docs/user-guide/features/kanban-worker-lanes.md`). Not separately tested because α.1 already confirmed the dispatch path runs. | Upstream auto-blocks after N consecutive spawn failures. |
| α.5 | `hermes kanban diagnostics` against the scratch board | ✅ PASS. Flagged my own stale test cards as `stranded_in_ready` after 1.3h with the threshold + assignee + age. Three severity tiers (warn/error/critical at 1×/2×/6× threshold). | Upstream has the "situation room" view we've been planning to build. |
| **Integration** | Simulate run3's exact dup pattern using only upstream tools | ✅ PASS. Steward issues 5 `kanban_create` calls (3 originals + 2 "forgotten" re-issues), board has 3 cards, only the parent is `ready`, two children gated in `todo`. | The whole Phase 5 symptom set collapses. |

## Misinformation in our docs that I'm correcting

### 1. `docs/guides/landfolk-lifecycle.md:28`

> "Ensures the standalone dispatcher is running — `scripts/landfolk-dispatcher.sh` (out-of-process kanban worker dispatcher; the gateway-embedded one is disabled via `kanban.dispatch_in_gateway: false` **because it wedges**)."

The "wedges" claim is **stale**. The current Hermes docs (`~/.hermes/hermes-agent/website/docs/user-guide/features/kanban.md:191`) describe `dispatch_in_gateway: true` as the **default and recommended** path, and explicitly call running both *unsupported*: *"running both a gateway-embedded dispatcher AND a standalone daemon against the same kanban.db causes claim races."*

### 2. `docs/guides/landfolk-lifecycle.md:110-114` ("Gateway wedge" section)

> "Used to happen with `kanban.dispatch_in_gateway: true`. We disabled that — dispatcher is now out-of-process (`landfolk-dispatcher.sh`)."

Same story. The historical wedge bug appears to be resolved upstream; we've been carrying the workaround past its expiry date.

### 3. `scripts/landfolk-dispatcher.sh:6-13` (header)

> "The gateway-embedded dispatcher (`kanban.dispatch_in_gateway: true`) has wedged silently 3+ times in this project's short life... Mirrors upstream issues #29034, #28805."

The reference to #29034 (auto-launch swarms) and #28805 (no config knob for cap) point at a *different* upstream concern (paid-LLM cost safety), not the gateway-wedge bug. Conflating the two has kept the workaround feeling load-bearing. The real safety knob upstream now ships — `kanban.max_spawn` is config-exposed in `~/.hermes/config.yaml`.

### 4. `docs/features/landfolk-plugin.md:11` (the plugin's purpose statement)

> "The first subsystem (`orchestrator/`) enforces a per-assignee concurrency cap on the `landfolk-ops` kanban board, replacing three independent userland mutex layers with one cohesive plugin."

**The plugin's `post_tool_call` hooks were never actually registered** with Hermes (`ctx.register_hook(...)` is missing — compare disk-cleanup or langfuse plugins). The only path the plugin's mutex code ever ran on was `hermes landfolk gate-check`, which only fires when `landfolk-dispatcher.sh` calls it once per tick. During the 2026-06-02 Phase 5 run, dispatcher.sh was not running — establish-scenario.sh calls `scripts/landfolk-control.sh start`, not `scripts/landfolk start`, and only the latter starts the dispatcher script.

Net effect: **the plugin's mutex code has not been enforcing the invariant during the runs we care about.** Workers still got spawned (by the gateway-embedded dispatcher, despite the config flag), but with no per-assignee guard. The dual-claim symptom in run3 is exactly what you'd expect.

### 5. `prompts/landfolk/steward.md` (orchestrator SOUL) — bypass guidance

Steward's SOUL today tells her to use `scripts/kanban` CLI and forbids direct sqlite3. Both were workarounds for our local CLI's shape. Neither references `kanban_create(..., parents=[…])` or `kanban_create(..., idempotency_key=…)`, the upstream-native tools that would have made the workarounds unnecessary.

## The new picture

```
                Operator (re44)  |  Steward (orchestrator)
                        │             │
                        │             ▼  kanban_create(parents=[…], idempotency_key=…)
                        ▼             ▼
                 hermes gateway (single long-lived process)
                  └─ embedded kanban dispatcher (default: every 60s)
                  └─ spawns workers via _default_spawn
                      ↳ enforces parent→child serialisation in claim_task
                      ↳ enforces failure_limit auto-block
                      ↳ surfaces stranded_in_ready via diagnostics

                NO landfolk-dispatcher.sh
                NO plugins/landfolk/orchestrator/gate-check
                NO custom fleet-status.py situation-room
```

Steward's contract reduces to one sentence: *"For each card you create, set `parents` to the cards it must wait for, and set `idempotency_key` to something unique-per-intent so retrying your decomposition is idempotent."*

What we lose: per-bot parallel-claim safety for siblings with no dependency edge. Steward must encode serial work as a chain. The plugin was insurance against Steward not chaining; the upstream model is "discipline the agent, not the dispatcher."

What we gain: ~600 LOC deleted (`landfolk-dispatcher.sh` ~140 lines + `plugins/landfolk/` ~500 lines + the various landfolk-control.sh integration points). Three layers of mutex-encoding-as-task_links collapse to one upstream-native edge type. `task_links` cleanly means "real domain dependency" again. Reassignment cleanup stops being heuristic. Diagnostics is built-in.

## Migration path

See [procedural-planning.md Phase 6](../../docs/features/procedural-planning.md#phase-6--upstream-alignment).

## What this doesn't fix

- **`auto_decompose: true` race with Steward.** The pre-filed P1 children in run3 came from the gateway-embedded decomposer doing its job; Steward then decomposed again. Decision needed: set `auto_decompose: false` on the `landfolk-ops` board (manual orchestration mode — Steward owns all decomposition), or leave it on and have Steward defer to whatever auto-decompose produced. The docs describe both as supported.
- **Worker nav issues** (#38a, #42 NAV_BLOCKED + goto_near cap). Independent of dispatch.
- **Steward's confabulated memory IDs** (#32). Independent of dispatch.
- **`mc mark` records bot position, not target** (RC-8). Independent of dispatch.

These remain on the plan as their own items.
