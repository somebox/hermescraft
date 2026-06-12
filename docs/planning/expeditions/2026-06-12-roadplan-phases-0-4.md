# Postmortem — adaptive road planning, Phases 0→4 (2026-06-12)

Single long session that took the adaptive road planner from "kernels built"
to "a real agent plans + lights a road, and the construction path is proven
on live water." This is the decision document: what works, what's open, and
the best next step. Design contract: `docs/planning/adaptive-road-planning.md`.
Blow-by-blow: `docs/planning/session-devlog.md`.

## Scope delivered

15 commits, `a80e03a`→`5ddcb1d`. `scripts/roadplan/` is ~2700 lines; CLI now
ships `ingest / solve / sample / confirm / workorders / render / promote /
preflight`. 106 Python roadplan tests + the JS contract tests green.

## Capability state

| Capability | State | Evidence |
|---|---|---|
| Sample → solve → render (natural terrain) | **Solid** | many corridors, fixtures + live |
| Two-phase RCON probe, walk-grade Y, overhang repair | **Solid** | `a80e03a`, regression-tested |
| Natural torch placement (no fabricated bases) | **Solid** | 22/22, 26/26, 3/3 verified |
| Planner-agent loop (`sample`/`confirm`, `\| bash` batch) | **Solid, agent-validated** | real agent lit a 3-wp chain; 20/21 on a 21-wp over-distance run |
| Sample-over-distance (walk the box) | **Solid** | 3081 cells / 7 segs, agent-driven |
| Water detection in `corridor_sample` | **Solid** | water route now solves `bridge`, not phantom `natural` |
| `confirm --near` (no backtrack), waypoint suggest-nearby | **Solid** | 21/21 confirmed after fix |
| Construction: `workorders` emits build cmds | **Works (operator)** | correct `mc deck`/`level`/`fell_tree`; live water bridged |
| Construction: full leg → to-spec → light → walk | **Partial (~80%)** | water bridged; trees/guards/grade unfinished |
| `roadplan cards` (§6.6 kanban) | **Not built** | — |
| Agent driving the construction loop | **Not done** | only operator-driven |

The headline: **the natural-route path is complete and proven by a real
Hermes agent end to end.** The construction path is proven in mechanism (the
bot can bridge water with `mc deck`) but not yet to a finished, lit, walkable
road.

## What the live runs taught us (cheap lessons we'd have missed offline)

Every phase's live run surfaced bugs fixture tests could not. The pattern is
the lesson: **drive it for real early.**

- Phase 3 agent run: `--ledger` placement, bot-identity confusion, the
  **64 KB piped-stdout truncation** (a CLI-wide bug), `max_turns:90` budget
  (fixed with `| bash` batching), the confirm backtrack, `TARGET_SELF_OCCUPIED`.
- Phase 4 build run: **all three `workorders` build commands had the wrong
  verb signatures**, the 16-cell tiling cap, `mc level` can't bridge open
  water (→ `mc deck`), and decks must abut a bank to anchor (→ padding).

None of these were visible until a real agent / real bot executed the emitted
commands.

## Open findings (prioritized)

**P1 — blocks a finished construction road**
1. **Bank grading.** A bridge between banks of different heights (here 67 vs
   64) leaves a step where the flat deck meets the lower bank. `workorders`
   decks flat; it doesn't grade the approaches. The road never reaches
   "walkable" without this.
2. **Guard rails.** A deck over water flags `drop_hazard` on both open sides;
   survey calls the leg not-walkable until they're guarded. No guard verb /
   doctrine yet. (Or: decide a road bridge is "walkable" with hazards.)
3. **`fell_tree` vs survey disagreement.** Survey flags `tree` deficits at
   columns where `mc fell_tree` finds no log. `workorders`' fell commands
   then no-op. Needs root-causing (Y/coord mismatch, or canopy-vs-trunk).

**P2 — correctness / doctrine**
4. **`workorders` doesn't consume `level_ground` dry-run** (the §6.5
   authoritative-classifier doctrine). v1 assembles from survey deficits +
   route Ys. Fine for trees/decks; risk is divergence on leveling dispositions.
5. **Deck Y vs water surface.** Per-span interpolated feet can sit at/below
   the water; the deck must clear it and match the rim. Partly handled by
   bank-to-bank padding; not principled.

**P3 — completeness**
6. `roadplan cards` (§6.6) — turn legs into kanban for the build role.
7. Agent has never driven `workorders`→build→re-survey→confirm.
8. No metrics trial yet (the original Phase 5: timed night-walk vs the
   pre-road `reachable` baseline, % route needing zero construction).

## Recommended next steps

The natural-route capability is done and agent-proven; the construction
capability has a real but bounded backlog. Two coherent paths:

**Recommendation A (highest leverage): bank the win — run the Phase 5 trial
on the natural-route path.** A real agent plans + lights a route over a fresh
corridor, a bot walks the torch chain at night, timed vs the pre-road
`reachable` baseline; capture the headline metric (% route needing zero
construction). This converts the validated capability into a demonstrable
result with numbers, on a solid foundation, with low risk. It also exercises
the agent loop once more for regressions. ~1 focused session.

**Recommendation B (finish construction): close the P1 trio, then one agent
build.** Bank grading + a guard-rail decision + the `fell_tree` root-cause are
each small and well-scoped now that we know they exist. With those, drive one
agent through solve→workorders→build→re-survey→confirm on the water corridor
for a complete construct→light→walk. Higher effort, but completes Phase 4.
Construction is the *rarer* case (most routes solve natural), so this is
lower-priority than A for demonstrating the system — but necessary for
generality.

**Not recommended yet:** `roadplan cards` / kanban (§6.6) before an agent has
driven the build loop even once; and consuming `level_ground` dry-run before
the simpler P1 build gaps are closed.

Suggested order: **A, then the P1 fixes, then B.** A delivers a result now;
the P1 fixes are quick and unblock B; B generalizes the system to terrain
that actually needs building.
