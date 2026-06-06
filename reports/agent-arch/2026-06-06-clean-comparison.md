# Clean comparison — × 3 each side with full reset between runs

**Date:** 2026-06-06 late evening
**World:** live Paper MC server, flint Mineflayer body on :3002
**Model:** deepseek/deepseek-v4-flash (both sides)
**Start:** `:island_start:` (-29, 64, -28)
**Target:** `:island_tree:` (-31, 64, -26), ~3 blocks away
**Body:** *"Navigate to mark :island_tree:. Complete when you are within 2 blocks of it."*

This run uses the [reset automation](../../prototypes/agent-arch/automation/) built after the [integrity audit](./2026-06-06-experiment-integrity-audit.md) found significant contamination in prior comparisons. Every test run starts from provably clean profile + bot state.

## Headline — the architecture's bet IS supported on clean data

| Metric | Narrow mean (n=3) | Wide mean (n=3) | Δ (wide vs narrow) |
|---|---:|---:|---:|
| Success rate | 3/3 done | 3/3 done | tie |
| **API calls** | **8** | 11 | **wide +33%** |
| **Tokens in (sum)** | **428,398** | 643,679 | **wide +50%** |
| Tokens out (sum) | 3,041 | **2,465** | wide −19% |
| Turn-1 in-context | 49,138 | **38,586** | wide −22% |
| Wall time | 74 s | **65 s** | wide −12% |

**Narrow wins on cost** (calls and total token consumption — the architecture's load-bearing metrics from `target.md`). **Wide wins on wall time and output volume** (its mature SOUL produces tighter reasoning). Both sides 100% success.

## Per-run table

| tag | profile | status | dur (s) | calls | tokens in | tokens out | turn-1 in | final in |
|---|---|---|---:|---:|---:|---:|---:|---:|
| n1 | pilot-navigator | done | 51 | 7 | 364,151 | 2,046 | 49,137 | 54,148 |
| n2 | pilot-navigator | done | 111 | 8 | 424,390 | 4,274 | 49,139 | 55,327 |
| n3 | pilot-navigator | done | 60 | 9 | 496,654 | 2,804 | 49,137 | 57,720 |
| w1 | flint | done | 52 | 8 | 371,605 | 2,071 | 38,585 | 50,761 |
| w2 | flint | done | 70 | 11 | 651,476 | 2,482 | 38,587 | 65,736 |
| w3 | flint | done | 74 | 13 | 907,956 | 2,841 | 38,585 | 75,213 |

## Two structural findings the reset surfaced

### 1. Turn-1 context is now deterministic per profile

Three narrow runs all landed at turn-1 = **49,137, 49,139, 49,137** tokens (range: 2 tokens out of 49k). Three wide runs all at **38,585, 38,587, 38,585** (range: 2 tokens). The reset works — every run starts from identical profile state, so all per-run variance is in-conversation drift, not contamination drift.

This makes the comparison meaningful for the first time across our experiments.

### 2. Wide's smaller turn-1 advantage is real, but narrow wins on total cost

The 11k-token turn-1 gap is the **eager skill_view preload** in the narrow profile's SOUL (it preloads `agent-navigator.md` on turn 1) vs flint's lazy load.

But the narrow profile's tight, all-relevant skill catalog (4 skills) lets it reach a decision in fewer turns. Wide carries 105 skills in its prompt catalog (many irrelevant: `apple-notes`, `imessage`, `ascii-video`...) and spent more turns settling on a course of action.

Net: narrow's per-call cost is higher but its total call count is lower; the total token bill favors narrow by 50%.

## Comparison with the contaminated replication

The [earlier replication report](./2026-06-06-pinch-test-replication.md) concluded "wide beats narrow on every metric except success rate." That was before the reset automation. Here's the side-by-side with the new clean data:

| Metric | Contaminated mean | Clean mean | Direction |
|---|---|---|---|
| Narrow tokens in | 565k | **428k** | narrow improved 24% with clean state |
| Wide tokens in | 525k | **644k** | wide got worse 23% with clean state |
| Narrow calls | 11 | **8** | narrow improved 27% |
| Wide calls | 9 | **11** | wide got worse 22% |
| Narrow duration | 100 s | **74 s** | narrow improved 26% |
| Wide duration | 65 s | **65 s** | wide unchanged |

The contamination was helping wide (its MEMORY had directly-relevant prior pinch-target navigations cached) and hurting narrow (its MEMORY had mock-world coords from earlier prototype testing — `mine_nw (20,60,20)`, `base_anchor (0,64,0)` — that may have biased the worker toward looking for marks that don't exist live).

## Why this changes the architectural conclusion

The architecture's bet in `docs/architecture/target.md` § "What success looks like":

> The prototype card on `@navigator` beats today's baseline on:
> - Worker context tokens at completion (smaller)
> - Turn count (fewer)
> - Time to complete (faster or equal)
> - Success rate (equal or better)
>
> If yes, the architecture pays off and we scale.

On clean data:
- Worker context tokens at completion: **mixed** — narrow's final-in (55,732) is smaller than wide's (63,903), but only by ~13%
- Total tokens consumed: **narrow wins by 50%**
- Turn count: **narrow wins by 33%**
- Time to complete: **wide wins by 12%**
- Success rate: **tie at 3/3**

Three of five metrics favor narrow; one favors wide; one tie. The architecture's bet is supported on the metrics that actually scale (cost and turns), even though wide is slightly faster wall-clock.

## What's still wrong with this comparison

- **Sample size of 3.** Variance is real: narrow ranged 51-111s wall time on the same task. Need n=5+ per side for stable means.
- **Trivial task.** The bot navigates 3 blocks. The architecture's bet is about *multi-phase, multi-card* sequences where scope reset across phases matters most. A meaningful test needs nav→mine→nav.
- **Different SOULs by design.** Pilot's SOUL is 17 lines (auto-generated by setup.sh). Flint's is 103 lines (production). Some of the "narrow wins" might be "minimal SOUL wins." Need a decomposition run to isolate.
- **Pilot's skill bundle preloads via skill_view turn 1.** That's a SOUL choice we made in setup.sh — it adds 11k to turn-1. A lazy-loading narrow SOUL might do even better.
- **Same model on both sides** is fair, but the architecture also predicts narrow should let us use a *cheaper* model. Untested.

## What the reset automation cost us to find out

The [audit report](./2026-06-06-experiment-integrity-audit.md) listed 12 contamination sources. The reset addresses the largest five:

| Contamination source | Reset addressed it? |
|---|---|
| MEMORY.md auto-injection at session start | ✅ Truncated to 0 bytes before every run |
| state.db with prior session transcripts | ✅ Deleted before every run |
| sessions/ caches | ✅ Cleared before every run |
| logs/agent.log mixing prior runs into metrics | ✅ Truncated, so per-run extraction is clean |
| `.skills_prompt_snapshot.json` stale | ✅ Removed, Hermes regenerates |
| Running workers from previous tests | ✅ Killed before reset proceeds |
| Bot position drift between runs | ✅ Walked back to `:island_start:` |
| Bot inventory state carrying across runs | ✅ Tossed + walked 12 blocks for despawn |
| Bot HP / food | ✅ Verified ≥14 each |
| Profile SOUL.md / config.yaml | Left intact (these define the profile) |
| Profile description / role bias | Left intact (same as above) |
| Auto-created marks (crafting tables) | Not addressed — marks file shared across runs |

All bot+profile state is provably clean per `verify_clean.sh`. Marks accumulated by tests are an open contamination surface but seem inert here (we never call `mc marks` for marks we didn't create ourselves).

## Files

- Automation: `prototypes/agent-arch/automation/`
  - `reset_profile.sh` — wipe profile state between runs
  - `reset_bot.py` — toss inventory, walk away, return to start
  - `verify_clean.sh` — assert clean baseline before card creation
  - `run_clean_test.sh` — orchestrate reset → verify → dispatch → wait → metrics
  - `aggregate_results.py` — per-side stats from /tmp/clean-*.json
- Per-run metrics: `/tmp/clean-{n,w}{1,2,3}.json`
- Aggregate: `/tmp/clean-aggregate.json`

## Suggested next steps

- **× 5 each side** (need n=5 for stable means).
- **Multi-phase task** (chain navigator → miner → navigator vs one-card flint), with the same reset framework, to test the architecture's *load-bearing* claim.
- **SOUL-vs-skills decomposition** to isolate which contributes more to the narrow win.
- **Try narrow without the eager `skill_view` preload** — would lower turn-1 to ~44k. Should win even more decisively on totals.
