# Phase 2 — Architecture index

> **Status:** active. Branch `experiment/hermes-agents`. No backwards-compat constraint.
> **Predecessor docs:** [archive/experiments/](../../archive/experiments/) (1.1–1.4, phase-1-summary).

Split from a former monolith; each subdoc can be read independently.

## Subdocs

| File | What's in it | Original §§ |
|---|---|---|
| [overview.md](overview.md) | Context, non-goals, roles, co-evolution loop | 1–4 |
| [board.md](board.md) | Card protocol, statuses, retries, idempotency | 5 |
| [capability-tests.md](capability-tests.md) | L0–L4 matrix, test contract schema, fixtures, test world | 6, 7, 12 |
| [action-contracts.md](action-contracts.md) | Required response shape for every `mc <verb>` (heavily referenced) | 8 |
| [protocols.md](protocols.md) | Marks, chest accounting, steward protocol, event/feed schema | 9, 10, 11, 13 |
| [reactive-layer.md](reactive-layer.md) | Layer 2 autopilot — modes, micro-actions, combat skill, stuck escalation | 16 (first instance) |
| [sprints.md](sprints.md) | Sprint plan + success criteria. **Sprint 5+ added here.** | 14, 15, 16 (second instance) |
| [appendix.md](appendix.md) | Deferred design notes (A1–A8) | A1–A8 |

## Other related docs

- [mc-cheatsheet.md](../../mc-cheatsheet.md) — generated `mc` command reference.
- [patterns.md](../../patterns.md) — maintainability patterns.
- [guides/test-world.md](../../guides/test-world.md) — landfolk-test world reference.
- [agent-boundaries.md](../../agent-boundaries.md) — Hermes vs `mc` server boundary.
- [goal-profiles.md](../goal-profiles.md) — goal schema design references.
- [archive/experiments/](../../archive/experiments/) — Phase 1 deliverables + phase-2-sprint-log.
- [archive/](../../archive/) — pre-fork conceptual docs and superseded designs.

## Cross-references

When citing a section in commit messages or other docs, use the new path:

- `phase-2-architecture.md §16` → `reactive-layer.md`
- `phase-2-architecture.md §8` → `action-contracts.md`
- `phase-2-architecture.md §15` → `sprints.md`
