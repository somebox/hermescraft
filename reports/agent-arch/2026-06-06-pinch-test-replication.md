# Pinch test replication — × 3 each side on a fair task

> **Update (later same day):** a [clean re-run](./2026-06-06-clean-comparison.md) with provable reset between every run **reversed the headline**: with no MEMORY contamination, narrow wins on tokens (-50%) and API calls (-27%), wide wins only on wall time (-12%) and output tokens (-19%). The contamination here was hiding the architecture's signal. Treat this report as superseded; the [audit](./2026-06-06-experiment-integrity-audit.md) explains what was wrong and the clean comparison is the current best estimate.

**Date:** 2026-06-06 (~2 hours after the [first pinch test](./2026-06-06-live-pinch-test.md))
**World:** live Paper MC server, same flint Mineflayer body on :3002
**Model:** deepseek/deepseek-v4-flash (both sides)
**Start:** `:muster_south:` (31, 64, -29) — known mark, flat ground next to base
**Target:** `:pinch_target:` (45, 64, -43) — new mark created via direct HTTP, NE ~20 blocks, open surface, no trap geometry

## Headline — the original finding doesn't replicate

The first run claimed the narrow `pilot-navigator` profile beat the wide `flint` profile on a real task. Three more runs each side, on a fair task without the terrain trap that caused the first wide run to block, show **wide actually beats narrow on every metric except success rate**:

| Metric | Narrow mean | Wide mean | Δ |
|---|---|---|---|
| Success rate | 3/3 | 3/3 | — |
| API calls | 11 (10–12) | 9 (8–10) | wide **−18%** |
| Tokens in (sum) | 565 k (526 k – 641 k) | 525 k (367 k – 679 k) | wide **−7%** |
| Tokens out (sum) | 3,337 (2.9 k – 3.6 k) | 1,905 (1.8 k – 2.0 k) | wide **−43%** |
| Turn-1 in-context | 49,727 (very tight) | 38,833 (very tight) | wide **−22%** |
| Wall time | 100 s (72 s – 136 s) | 65 s (47 s – 87 s) | wide **−35%** |

Both sides reached within 2 blocks of the target on all six runs.

## Per-run table

| tag | profile | status | dur (s) | API calls | tokens in | tokens out | turn-1 in | latency sum |
|---|---|---|---:|---:|---:|---:|---:|---:|
| narrow1 | pilot-navigator | done | 93 | 12 | 640,516 | 2,924 | 49,631 | 84.3 s |
| narrow2 | pilot-navigator | done | 72 | 10 | 530,129 | 3,635 | 49,730 | 69.2 s |
| narrow3 | pilot-navigator | done | 136 | 10 | 525,619 | 3,451 | 49,819 | 128.1 s |
| wide1 | flint | done | 87 | 10 | 679,023 | 1,960 | 38,797 | 73.8 s |
| wide2 | flint | done | 47 | 8 | 366,625 | 1,808 | 38,811 | 47.6 s |
| wide3 | flint | done | 60 | 9 | 528,139 | 1,948 | 38,891 | 60.2 s |

## What changed since the first report

The first pinch test report claimed three things; two were wrong and one needs nuance:

**Wrong: "The narrow bundle worked on a real task the wide bundle blocked on."**
The wide bundle blocked because the bot pathfinder, given coord-form `mc move 31 64 -29` from start position (33.5, 69, -49.5), descended into a four-walls-around-it pocket at (33, 66, -50). On a fair start position the wide worker has no problem completing the same nav task. The wide-vs-narrow distinction wasn't the variable — the start position was.

**Wrong: "The wide flint worker didn't reach for `mc escape`."**
Inspection of the wide worker's actual `tool_calls` (not text mentions) showed it tried `mc escape` after getting trapped, plus `mc goto_near`, `mc reachable`, and 17 rounds of `mc terrain_top` scanning for a viable surface. Auto-stuck-check killed it not because it didn't try the escape verb, but because the verb itself returned `ESCAPE_PILLAR error` and subsequent attempts produced identical "move:done" fingerprint.

**Nuanced: "Mark form vs coord form is the architecturally important lever."**
The narrow worker's agent-navigator skill table puts `mc move @MARK` first with "Primary." Narrow consistently used the mark form (verb-choice winning is a *positive* lesson — narrow's skill bundle pushes the right verb to the top). But wide's metric efficiency at the fair task suggests the verb-choice habit may matter less than its narrow-by-construction starting context, which on inspection is *bigger*, not smaller.

## What the data says about the architecture's core bet

The architecture in `docs/architecture/target.md` § "What success looks like" predicted narrow would win on:

- worker context tokens at completion — **narrow loses** (55,895 vs 62,337 mean — within noise; wide range is huge)
- turn count — **narrow loses** (11 vs 9)
- time to complete — **narrow loses** (100 s vs 65 s)
- success rate — **tie** (3/3 both)

For this task type (single-phase nav with a mark target), the narrow bundle did not pay off. Reasons we observed:

- Narrow preloads `agent-navigator.md` via `skill_view` on turn 1 (the kanban-worker SOUL pattern eagerly loads the first listed skill). That's roughly +11 k tokens to turn-1 context vs wide's lazy load.
- Narrow's three-skill array (agent-navigator + minecraft-navigation + minecraft-survival) still all need to be loaded for the worker to see the verb tables; the laziness doesn't save you much when the bundle is small.
- Wide's flint SOUL is mature (weeks of fleet ops). It already knows how to do nav. The "wide catalog confuses the model" hypothesis from `target.md` § "The problem" doesn't show up at this task scale.

## What the data does NOT say

- **Mining and handoff aren't tested.** This was a single-phase nav. The architecture's strongest case is for chains (navigator → miner → navigator) where scope reset between phases prevents context bloat across multi-card sessions. The handoff contract test (Phase 3 of the prototype) showed cross-agent handoff works, but didn't compare cost vs a wide worker chasing the same chain in one session.
- **Failure-mode robustness isn't tested.** On the original trap geometry the wide worker burned 15 LLM calls and still failed. The narrow worker may simply not have hit the trap on its 4-call resolution. We don't know how narrow would fare on a *deliberately* nasty starting position.
- **Adversarial / multi-priority tasks aren't tested.** "Go to mark X but also collect any iron on the way and stay above food=10" is closer to what flint actually does day-to-day. Wide may dominate here.
- **Failure-tolerance to wide-SOUL drift.** Flint's SOUL has accreted weeks of incident learnings. If we built a new bot from scratch with a heavy wide skill catalog but a fresh SOUL, it might do worse.

## Implications for the architecture direction

This isn't a stop-the-rewrite finding. It's a "don't sell the bet on token count alone" finding:

1. **The card-boundary scope reset claim is unrelated to this measurement.** That's the handoff story (Phase 3), which works and doesn't compete with wide on this metric.
2. **The narrow-skills-cost-fewer-tokens claim is not supported on single-phase tasks.** Eager `skill_view` of the first listed skill defeats lazy-load savings; the bundle simply has to fit.
3. **Where narrow MIGHT win is in robustness on adversarial tasks.** Wide blocked on the trap; narrow finished. With only 1+3 runs we don't know if narrow is *systematically* better in stuck states or just got lucky on the trap path.
4. **Test on multi-phase work next.** The architecture's strongest claim is chain-level — navigator → miner → navigator producing cleaner state than one wide worker doing it all in one session. That's what Phase 3 of the prototype tests on mocks; it's what needs to be tested on the live bot to actually validate the bet.

## Reproducibility

All six runs are reproducible with the same start/target marks already saved on the server:

```bash
# Each round:
/tmp/run-pinch.sh pilot-navigator /Users/foz/.hermes-proto-agent-arch narrow1
/tmp/run-pinch.sh flint /Users/foz/.hermes wide1
```

Raw per-run metrics in `/tmp/pinch-rep-final.json` and `/tmp/pinch-narrow{1,2,3}.json` / `pinch-wide{1,2,3}.json`. Worker session ids on each completed card's `task_runs.metadata.worker_session_id` (per HOME's kanban DB).

## Suggested follow-up

- **Multi-phase live run.** Drive an actual chain (navigator → miner → navigator) on the live bot, both as a chain on pilot-* profiles and as one card on flint. Compare end-to-end tokens, completion, and observable behavior. This is the architecture's *load-bearing* claim.
- **Adversarial position run × 3.** Re-do narrow on the original (33.5, 69, -49.5) trap start position three times. If narrow consistently solves it, the verb-choice / skill-table-priority lever is real. If narrow also blocks 2/3 of the time, the original finding was lucky.
- **Decompose SOUL vs skills.** Run narrow with flint's SOUL but only narrow skills; run wide with the small generated SOUL but flint's skill catalog. Separate the two effects.
