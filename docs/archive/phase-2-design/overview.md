# Phase 2 — Overview & roles

Sections 1–4 of the Phase 2 architecture: context, non-goals, roles, and the co-evolution loop.

## 1. Context & narrowed objective

Phase 1 validated the core architecture (kanban-driven mission spawn, per-character profiles, comments-as-IPC, `worker_context` injection) but also surfaced that **the action layer is the bottleneck**. Phase 2 takes that seriously.

The **single objective** is: *prove the co-evolution loop with two bots and human-as-steward, on a regression-grade test suite.* Steward automation, marks sync, logistics planning, multi-bot expansion, dashboard — all become **products of** that loop, not part of the executable plan. They live in the appendix.

The plan changed substantially from earlier drafts based on review feedback:
- Scope narrowed to two bots (gatherer + flint) and L0–L4 capabilities only
- Steward profile + body deferred entirely; human plays the steward role
- Marks system simplified to a single file + coords inline in card bodies (no distributed sync)
- Logistics planner deferred; chest tracking moves from prose-parsing to structured `kanban_complete.metadata`
- Action layer promoted from "side quest" to **gate** — every primitive must meet a response-shape contract before higher tests can pass
- Capability tests get a strict YAML schema; tests are runnable specifications, not prose
- Multiverse + flat test world + reusable fixture files make every test deterministic and repeatable

## 2. Non-goals (Phase 2)

These are explicitly out of scope and live in the Phase 3+ appendix:

- ❌ Steward profile + body (human plays the role)
- ❌ Marks sync between bot caches (single canonical file; coords inline in cards)
- ❌ Chest inventory in canonical (use card metadata)
- ❌ Logistics planner / supply-chain analysis / distance computation
- ❌ Cast expansion beyond gatherer + flint
- ❌ Custom dashboard implementation (only the event/feed schema is specified, for later)
- ❌ Capability levels L5–L8 (build, farm, combat, full logistics)
- ❌ `/api-spec` self-describing endpoint, anti-revisit pathfinder memory, custom metric registration in goal engine — all Phase 3

## 3. Roles

| Assignee | Body | Function | Model |
|----------|------|----------|-------|
| `gatherer` | port 3001 — mobile | Wood, food, plants, scouting; L1–L4 worker | DeepSeek V4 Flash |
| `flint` | port 3002 — mobile | Mining, deep ops; L4 specialist | DeepSeek V4 Flash |
| `human` | (none — pulls cards manually) | Steward role + bug fixes via Claude Code | (me) |

The `human` assignee is a first-class kanban concept: cards assigned to `human` are **never auto-dispatched**. They sit in `ready` until I pull them.

I play **two distinct sub-roles** as `human`:
1. **Steward role** — write capability_test cards, triage failures into bug_reports, run verify_fix cycles, maintain the capability matrix
2. **Coding role** — pull `[BUG]` / `[FEAT]` / `[SKILL]` cards from the board, fix with Claude Code on the experiment branch, mark done with commit SHA

The protocol below in §11 specifies exactly what each sub-role does, with formats precise enough that the steward agent can later be programmed to execute them.

## 4. The co-evolution loop

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Pick the next L<N>.<n> in capability matrix (status=pending)│
│ 2. Look up its fixture file → run `prep` rcon commands         │
│ 3. Create capability_test card per the schema (§7)             │
│ 4. Dispatch via hermes kanban; worker runs                     │
│ 5. Worker outputs: kanban_complete with PASS/FAIL + metadata   │
│ 6. Outcome:                                                    │
│    PASS → matrix.consecutive_pass++; if ≥2 mark green          │
│    FAIL → triage:                                              │
│      - action contract violation? → bug_report (assignee=human)│
│      - skill behavior issue?      → skill_revision (human)     │
│      - missing primitive?          → feature_request (human)   │
│      - test/fixture defect?        → fix the test, re-run      │
│ 7. Pull bug card → fix with Claude Code → commit              │
│ 8. Mark bug card done with `summary: "fixed in <SHA>"`        │
│ 9. verify_fix card auto-spawns (or human creates) → re-runs   │
│    the original test                                           │
│ 10. PASS on re-run → matrix updated, both cards archived       │
│     FAIL on re-run → re-open bug or new bug with diagnosis     │
└──────────────────────────────────────────────────────────────┘
```

The kanban board does double duty: gameplay coord (worker cards) and dev backlog (human cards). Dispatcher patch (§14) ensures these don't cross.

