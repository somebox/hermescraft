# Multi-phase chain vs one-card flint — live comparison

> **Update (later same day):** the [integrity audit](./2026-06-06-experiment-integrity-audit.md) found this comparison is **invalid**. The flint card body specified a completion predicate (≥4 oak_log AND within 2 blocks of `:island_start:`) that was **already true at turn 0** because I tossed 4 oak_log to clear inventory and the bot auto-picked them up. Flint correctly recognized "task already done" and tried to early-exit; auto-stuck-check then fired on the no-state-change fingerprint. This was not a failure to mine, it was correctly identifying no work was needed. Do not cite this report as evidence the chain pattern beats one-card.

**Date:** 2026-06-06 evening
**World:** live Paper MC server, flint Mineflayer body on :3002
**Model:** deepseek/deepseek-v4-flash (both sides)
**Start:** `:island_start:` (-29, 64, -28) — small island, see [the trap-recovery story](#how-the-experiment-got-degraded) below
**Target:** `:island_tree:` (-31, 64, -26) — oak tree ~3 blocks away
**Task:** navigate to the tree, extract 4 oak_log, return to start

This is the load-bearing test from `docs/architecture/target.md`: does scope-reset across cards beat a wide worker doing the whole task in one card?

## Headline

| | Chain (pilot-navigator → pilot-miner → pilot-navigator) | One-card flint |
|---|---|---|
| **Outcome** | ✅ done | ❌ blocked (AUTO_STUCK_BLOCK before any real work) |
| Total API calls | **61** | 4 (then killed) |
| Total tokens in | **3,465,799** | 231,690 |
| Total tokens out | **15,074** | 1,483 |
| Wall time | 726 s (12 min) | 109 s (then killed) |
| Phase 1 (navigate to tree) | 96 s, 8 calls, 434k tokens | — |
| Phase 2 (mine 4 oak_log) | 6:30, 41 calls, 2,374k tokens | — |
| Phase 3 (return to start) | 4:48, 12 calls, 658k tokens | — |
| Real `mc` calls | many; included scope drift (see below) | only 3: `mc status`, `mc read_chat`, `mc marks` — never moved |
| Inventory at end | 4 oak_log + 3 planks + 2 sand + 2 sticks + wooden_axe + dirt | 4 oak_log (auto-pickup, NOT mined — see caveat) |

**The headline reverses again.** On the multi-phase task, the chain pattern *did* complete; the wide one-card flint *didn't*. But the picture is muddier than that suggests.

## The flint failure mode

The flint worker spawned, made one API call, and called these three `mc` verbs:

1. `mc status`
2. `mc read_chat 20`
3. `mc marks`

Then it kept reasoning without taking action. By round 4 the bot's `recent[]` action list still showed `["move:done", "move:done", "move:done", "move:done"]` (every read returned "no change") and the auto-stuck-check fingerprint fired. Hermes' `auto-stuck-check` reclaimed the worker; a fresh worker spawned, made ONE API call from the same position with the same context, and the `AUTO_STUCK_BLOCK` fired immediately because the fingerprint hadn't changed.

So flint **didn't fail the task — it failed to start the task within 4 rounds**. The auto-stuck mechanism is tuned for landfolk-fleet workers who should make rapid concrete progress per turn. A multi-phase body that requires the worker to reason about three sequential steps before acting hits the budget before getting moving.

### The 4-oak_log-in-inventory artifact

Before the one-card run I tossed 4 oak_log from the bot's inventory (chain-1 had left some). The bot then auto-picked them up from the ground because Minecraft items auto-collect when the player is within ~1 block. So the final inventory showing 4 oak_log is **not evidence flint mined anything**. Flint never moved.

## The chain success mode (and its asterisk)

The chain ran to completion across three fresh workers:

- **Card 1 — `pilot-navigator` to `:island_tree:`**: 8 API calls, 96 seconds. Bot moved ~3 blocks west to the tree. Clean.
- **Card 2 — `pilot-miner` extract 4 oak_log**: 41 API calls, 6.5 min. The miner did the work but **scope-drifted**: started with `mc collect oak_log 4` (correct, batch verb), then chained into placing a crafting table, crafting `oak_planks`, crafting `sticks`, crafting a `wooden_axe`, more mining with the new axe. The `agent-miner.md` skill text I wrote explicitly says **"No crafting, smelting, depositing"** — and the worker ignored that and did exactly that.
- **Card 3 — `pilot-navigator` return to `:island_start:`**: 12 API calls, 4:48. Long for a 3-block walk. The navigator did unnecessary status checks and observation reads before confirming arrival.

So the chain succeeded, but it was **inefficient**: 61 calls and ~3.5M tokens for what should have been 8-12 calls if scope had been honored.

## What this comparison really shows

Two distinct architectural levers are entangled in the result:

1. **Per-phase scope discipline.** Chain Card 1 has body `to :island_tree:` — the worker has one obvious action and runs it. One-card flint has body `(1) navigate to X, (2) extract 4 oak_log, (3) return to Y`. The wide worker has to plan and verify three things before starting. The chain wins this by **simplifying turn-1 reasoning**, not by fewer skills.

2. **Auto-stuck-check tuning.** Both kinds of worker can hit the fingerprint cap. The narrow agent-miner skill's verb table puts `mc collect <name> [--count N]` on row 3, so the miner reached for it on turn 3 (and got immediate world-state change → fingerprint reset). The wide flint never picked an action verb in its budget. **The auto-stuck-check is the immediate killer; the skill text influences whether the worker reaches for an action verb early enough.**

3. **Scope drift in the chain miner** says the narrow skill bundle alone doesn't *enforce* scope — it only *recommends* it. The agent-miner.md text says "no crafting" and the worker crafted anyway. A real production system would need either (a) hard tool gating via `disabled_toolsets`, (b) a `pre_tool_call` hook in the landfolk plugin, or (c) a tighter SOUL — none of which the prototype implements.

## Where the architecture's bet actually holds

The original `target.md` claim — "smaller scope per agent invocation produces better outcomes than a wide worker doing the same task in one session" — is supported here in a weaker form:

- **Per-phase cards survive the auto-stuck-check** because the first verb the worker reaches for produces immediate world-state change. A multi-phase card spends turn-1 budget on planning.
- **Per-phase cards complete the task**, even if inefficiently. The wide one-card worker did not complete on this task type.

The original claim — "smaller turn-1 context, fewer total tokens" — is NOT supported. The chain used 15× more tokens than flint did before being killed, and per-phase contexts in the chain were comparable to flint's.

## Where the architecture's bet does NOT hold

- **Token efficiency on completed tasks.** The chain used 3.5M tokens to mine 4 wood. The replication report showed wide flint on single-phase nav was *more* token-efficient than narrow. We have no evidence the chain's per-token cost is competitive with a wide worker on a fair task.
- **Scope enforcement.** A "narrow" skill bundle doesn't constrain behavior in practice — the chain miner crafted a wooden_axe and oak_planks despite the skill text saying not to.
- **Wall time.** Chain took 12 min; flint took 109 s before failing. If the task were one wide flint could actually complete, the wall time comparison might favor flint.

## What I would do next if continuing

- **Tune auto-stuck-check or disable it for the wide one-card test.** The current `4 rounds of identical recent[]` threshold is too tight for multi-step planning. Run the wide flint with `--max-runtime 15m` AND auto-stuck disabled to see if it can actually do the task.
- **Multi-trial chain comparison.** This is one run per side. The chain itself wasn't replicated; we don't know its variance.
- **Tighter scope enforcement.** Add a `pre_tool_call` hook that blocks `mc craft`, `mc place crafting_table` etc. on `pilot-miner` cards. Test whether the chain still completes (or whether the over-engineering was actually *necessary* because mc collect failed silently without an axe).
- **Test a flint pre-warmup.** Run a flint card with a single-phase body first ("just mine 4 oak_log from :island_tree:"). If flint can do that, the failure mode is specifically multi-phase planning, not the skill bundle.

## How the experiment got degraded

A prior chain run had a bug in the runner script's card-ordering logic (cards with identical `created_at` timestamps sorted unpredictably in SQLite). The bug caused the runner to dispatch and poll cards in the wrong order. The miner worker ran into nothing-to-do state, wandered the bot ~60 blocks west onto a small island ((-31, 64, -30)), and the bot got stuck on the island's pathfinder limits. The original `:pinch_target:` test location became unreachable.

Rather than restart the experiment (which would have required either rcon teleport — disabled — or a full server-side intervention), I marked new island-scale marks and ran the chain comparison on a tiny ~3-block task. This is why the chain's nav-to-tree card took only 96 s for a 3-block walk — the task is small.

The findings are still valid for what they show (relative behavior, failure modes, scope drift), but the token/wall-time numbers should not be compared across reports — different distances, different starts, different terrain.

## Files

- Chain card IDs: `t_8c271b66` (nav→tree), `t_bc164665` (mine), `t_3041ddf9` (nav→start)
- Flint one-card ID: `t_0480cf78`
- Chain metrics: `/tmp/chain-sums.json`
- New scenario file: `prototypes/agent-arch/scenarios/E-island-chain.txt`
- Fixed runner: `/tmp/run-chain-v2.sh` (uses `dispatch.py CARDS_IN_ORDER=` line)
- `dispatch.py` was patched to emit `CARDS_IN_ORDER=` for the fixed runner.
