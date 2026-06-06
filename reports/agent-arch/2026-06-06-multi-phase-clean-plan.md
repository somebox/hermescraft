# Multi-phase clean comparison — experiment plan

**Status:** plan / not yet executed.
**Prerequisite:** the [clean comparison report](./2026-06-06-clean-comparison.md) — × 3 each side on single-phase nav, with provable reset between every run. Headline: narrow wins on calls (−33%) and total tokens (−50%); wide wins on wall time (−12%) and output volume (−19%).

This document plans the *next* clean test. It's narrowly scoped — and that scoping matters.

## What this test is for (and what it is NOT for)

The architecture's *strategic* bet — the one the prototype was built to enable — is about properties that single-task or even multi-task benchmarks can't measure directly:

- **Parallelism** — many specialized workers running concurrently on different cards
- **Review** — separating "do the work" from "judge the work" via the `@overseer` pattern
- **Evolving tools and docs** — narrow agents whose skill bundles can be improved without retraining
- **Strategic planning** — `@planner` reasoning about the colony's goals at a different scope than execution
- **Better data and self-improvement loops** — focused MEMORY per agent role, compaction cards, recall streams

None of these are measured by a per-task token comparison. The test below cannot prove the architecture is the right call. Its only job is to **validate that the new model doesn't make per-task work worse, and to surface the levers we have on context size and scope.**

A reasonable success bar for this test: *narrow performs as well as, or modestly better than, wide on per-task work, on at least some metrics.* If that holds, the strategic case stands on its own merits; if narrow is significantly worse, we need to redesign before scaling.

## What we already know

| Question | Answer (so far) |
|---|---|
| Does the plumbing work? | Yes (mocks: Phase 1/2/3 of the prototype + 5/5 handoff contract tests) |
| Does it work end-to-end on the live bot? | Yes, demonstrated multiple times since |
| Does narrow beat wide on a single-phase nav, with clean state? | Yes — 33% fewer calls, 50% fewer tokens, both 3/3 success. Wide is 12% faster wall-clock. |
| Does narrow beat wide on multi-phase work? | **Unknown.** The contaminated attempt was invalidated by a satisfiable predicate. |

This test answers the last row.

## Design

### Task

Both sides do the same end-to-end task: **navigate to a tree, gather 4 oak_log, return**. Distance is short (~3 blocks each leg) — we are NOT measuring nav efficiency, we're measuring *whether splitting this work across cards costs more than doing it as one card*.

### Sides

**Narrow side** — three cards via `dispatch.py`, chained with `--parent`:

| # | Assignee | Body | Skills |
|---|---|---|---|
| 1 | pilot-navigator | `to :island_tree:` | agent-navigator, minecraft-navigation, minecraft-survival |
| 2 | pilot-miner | `extract 4 oak_log at :island_tree:` | agent-miner, minecraft-mining, minecraft-survival |
| 3 | pilot-navigator | `return to :island_start:` | agent-navigator, minecraft-navigation, minecraft-survival |

**Wide side** — one card on flint, body specifies all three steps:

> "Three-phase task: (1) navigate to mark `:island_tree:`, (2) extract 4 oak_log, (3) return to mark `:island_start:`. Complete when oak_log_count ≥ start_oak_log_count + 4 AND you are within 2 blocks of `:island_start:`."

The predicate uses **inventory delta**, not absolute count. Because reset clears the bot to 0 oak_log before each trial, this means the bot **must mine to complete**. (This is the fix for the contamination that invalidated the previous attempt.)

### Reset boundary

Reset profile + bot once **per trial**, not per phase within a chain. The narrow side's three cards within one trial share the bot's evolving world state (that's the architecture's actual story); MEMORY.md may grow between cards 1 → 2 → 3 within a single trial, and that's deliberate — it's the architecture's *intended* learning behavior.

Between trial n and trial n+1: full reset on all three profiles.

### Sample size

× 3 trials per side, alternating (n1, w1, n2, w2, n3, w3) to avoid temporal bias from server-side state drift.

If after 3 trials each side the results are within ~10% of each other on the cost metrics, we'll need to extend to × 5 to get a stable mean. If the gap is larger we stop.

### Metrics

Same extraction as `run_clean_test.sh` and `aggregate_results.py`. For the chain side, sum across the three cards' sessions (each card has its own worker_session_id):

| Per-side metric | How |
|---|---|
| Total API calls | Sum of API calls across all sessions in the trial |
| Total tokens in | Sum of `in` field across all API calls |
| Total tokens out | Sum of `out` field |
| Turn-1 in (per phase) | First-API-call `in` field per session; chain has 3 values, one-card has 1 |
| Wall time | First card start → last card end (chain) vs single card duration (wide) |
| Success | All cards `done` (chain) or single card `done` (wide) |
| Bot end position | Should be near `:island_start:` |
| Bot end inventory | Should contain ≥4 oak_log obtained this trial |

The completion predicate's inventory check protects against the earlier invalidation.

## Decision matrix

Three plausible outcomes; each has a clear implication:

| Outcome | What it means |
|---|---|
| **Narrow wins by ≥ same margin as single-nav** (≥33% calls, ≥50% tokens) | Architecture's scope-reset claim holds on multi-phase work. Scale the implementation. |
| **Narrow wins by less than single-nav** | Per-card scope reset is somewhat helpful but is not the dominant lever. Narrow's overall win comes from skill catalog and eager preload. Continue but recognize the architecture's strategic case (parallelism, review, evolution) is doing more of the work than the cost story. |
| **Narrow loses to wide on cost** | Splitting the task into 3 cards costs more than doing it in 1. Architecture's narrow-bundle bet doesn't pay off at the per-task level. Strategic case (parallelism, etc.) must justify the architecture on its own. May still want to ship for those reasons; understand we are not winning on token cost. |

Any of the three outcomes is **information**, not a setback. We're not betting the architecture's value on this test; we're checking what we get for free.

## Risks

| Risk | Mitigation |
|---|---|
| Wide one-card hits AUTO_STUCK_BLOCK as before | Body's completion predicate uses inventory delta — bot must take action. Watch for fingerprint stalls and document; if it happens, that's information too. |
| Chain miner scope-drifts (crafts wooden_axe instead of just collecting) | Accept this as honest narrow-agent behavior — the skill text doesn't enforce scope, and that's a finding. Measure the cost honestly. |
| MEMORY.md grows during a chain trial within a single trial | Intended. Reset only between trials. |
| Bot is stuck on the island and can't reach a varied target | Use `:island_tree:` (-31, 64, -26) and `:island_start:` (-29, 64, -28) — 3-block reachable distance, validated by prior runs. |
| Bot dies mid-trial | Reset retries up to 25 moves; if it fails repeatedly, abort that trial and re-run after a bot restart. |

## Files to write or update

| File | Purpose |
|---|---|
| `prototypes/agent-arch/scenarios/F-clean-chain.txt` | New scenario: 3 lines, navigator → miner → navigator |
| `prototypes/agent-arch/automation/run_clean_chain.sh` | New: drives the 3-card chain per trial, polling each phase. Reset once at start. |
| `prototypes/agent-arch/automation/run_clean_wide.sh` | New: one-card flint trial. Or reuse `run_clean_test.sh` with the chain-body argument. |
| `prototypes/agent-arch/automation/aggregate_results.py` | Extend to support multi-session totals per side |
| Predicate-checking helper | Compute oak_log delta from before/after bot inventory snapshots, attach to result JSON |

The reset framework (`reset_profile.sh`, `reset_bot.py`, `verify_clean.sh`) is reused as-is.

## Concrete sequence

```
for trial in 1 2 3:
  reset pilot-navigator, pilot-miner, flint profiles
  reset bot (target :island_start:, empty inventory, hp/food full)
  verify clean (all three profiles + bot)
  snapshot bot.inventory_start

  # narrow trial
  dispatch.py < F-clean-chain.txt   # creates 3 chained cards
  for each card in chain: dispatch + wait_done
  capture metrics across 3 sessions
  snapshot bot.inventory_end
  
  reset bot only (keep profile reset trash from narrow trial? — no, redo all)
  reset all profiles + bot
  verify clean

  # wide trial
  create one flint card with full body
  dispatch + wait_done
  capture metrics for one session
  snapshot bot.inventory_end

aggregate
```

## What I will NOT do as part of this test

- Run more than × 3 trials per side initially. If results need more, that's a separate run.
- Test SOUL-vs-skills decomposition (separate experiment).
- Test narrow-without-eager-preload (separate experiment).
- Build new agent profiles (`@crafter`, `@builder`, etc.) — out of scope.
- Test parallelism — the architecture's strategic claim, which this test deliberately does not exercise.
- Build a real `@planner` profile — out of scope.

## Time estimate

~10-15 min per trial × 6 trials = **60-90 min** of run time, plus ~30 min analysis and writeup. Same evening or one session.

## Open question for the user

Do you want this run all in one session (~2 hours total) or split across sessions? The reset framework makes it safe to stop mid-batch and resume — just re-run from any trial number.
