# Phase 2 — Architecture index

> **Status:** active. Branch `experiment/hermes-agents`. No backwards-compat constraint.
> **Predecessor docs:** `docs/experiments/1.1–1.4-*.md`, `docs/experiments/phase-1-summary.md`.

This file used to be a 1000-line monolith. It's been split into focused subdocs under `docs/phase-2/`. Each piece can be read and edited independently.

## Subdocs

| File | What's in it | Original §§ |
|---|---|---|
| [`phase-2/overview.md`](phase-2/overview.md) | Context, non-goals, roles, co-evolution loop | 1–4 |
| [`phase-2/board.md`](phase-2/board.md) | Card protocol, statuses, retries, idempotency | 5 |
| [`phase-2/capability-tests.md`](phase-2/capability-tests.md) | L0–L4 matrix, test contract schema, fixtures, test world | 6, 7, 12 |
| [`phase-2/action-contracts.md`](phase-2/action-contracts.md) | Required response shape for every `mc <verb>` (heavily referenced) | 8 |
| [`phase-2/protocols.md`](phase-2/protocols.md) | Marks, chest accounting, steward protocol, event/feed schema | 9, 10, 11, 13 |
| [`phase-2/reactive-layer.md`](phase-2/reactive-layer.md) | Layer 2 autopilot — modes, micro-actions, combat skill, stuck escalation | 16 (first instance) |
| [`phase-2/sprints.md`](phase-2/sprints.md) | Sprint plan + success criteria. **Sprint 5+ added here.** | 14, 15, 16 (second instance) |
| [`phase-2/appendix.md`](phase-2/appendix.md) | Deferred design notes (A1–A8) | A1–A8 |

## Other related docs

- [`mc-cheatsheet.md`](mc-cheatsheet.md) — generated reference of all `mc` commands.
- [`patterns.md`](patterns.md) — maintainability patterns extracted from sprint work.
- [`test-world.md`](test-world.md) — landfolk-test world reference.
- [`MC_AGENT_BOUNDARIES.md`](MC_AGENT_BOUNDARIES.md) — Hermes vs `mc` server boundary.
- [`GOAL_PROFILES.md`](GOAL_PROFILES.md) — goal schema design references.
- [`experiments/`](experiments/) — Phase 1 deliverables + the phase-2-sprint-log.md F-numbered findings.
- [`archive/`](archive/) — pre-fork conceptual docs and superseded designs.

## Cross-references

When citing a section in commit messages or other docs, use the new path:
- `phase-2-architecture.md §16` → `phase-2/reactive-layer.md`
- `phase-2-architecture.md §8`  → `phase-2/action-contracts.md`
- `phase-2-architecture.md §15` → `phase-2/sprints.md`
