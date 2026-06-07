# Two-bot live trial #1 postmortem

**Date:** 2026-06-07 04:00–04:30 UTC+2
**Run id:** `trial-1780797829`
**Trial packet:** [`data/postmortems/two-bot-base/trial-1780797829/`](../../data/postmortems/two-bot-base/trial-1780797829/)
**Plan:** [`~/.claude/plans/create-a-plan-that-magical-lovelace.md`](../../../../.claude/plans/create-a-plan-that-magical-lovelace.md)
**Scorecard band:** **partial**

## Scorecard

| # | Number | Result | Notes |
|---|---|---|---|
| 1 | `parallelism_observed` + `overlap_s` | **true / 529s** | Pip and Zee both `running` from 04:04:01 to ~04:12 — Session 4 mutex contract holds under real Mineflayer wall time |
| 2 | `pip_done_count` / `zee_done_count` | **5/7** and **1/4** | Pip's whole gather chain completed; Zee's miner card blocked at extraction |
| 3 | `sign_at_seed` | **false (not evaluable)** | Sign card never ran — its grand-parent (z_mine) was blocked |

**Handoff contract test (one edge, `p_nav_wood → p_withdraw_wood`):** ✅ both assertions pass — parent's `exit_pos` literally appears in child's worker session corpus.

## What the trial proved

- Per-bot mutex parallelism — first real-Mineflayer validation. 9 minutes of overlap before convergence.
- Handoff metadata crosses the spawn boundary cleanly (`p_nav_wood → p_withdraw_wood` verified by reading child's `state.db.messages`).
- The fixture/reset workflow is repeatable. After fixing two MC-server misconfigurations during pre-flight, a single `reset-open-test.sh` run gets the world to a known state.
- The 11-card DAG dispatch + watch + evaluate runner works end-to-end and emits scoreable telemetry.

## What broke

### Issue 1 — `mc collect` silent failure (PRIMARY blocker)

**Severity:** load-bearing for any extraction card.

Sequence (zee miner session, msg #138–142):

```
mc collect cobblestone 32
→ "Mined 32/32 cobblestone. Have 1 cobblestone in inventory. [mined stone as source]"
mc pickup
→ "No items picked up."
mc inventory
→ "iron_pickaxe x1, cobblestone x1"
```

`mc collect` reports `mined_count: 32` and `result: "Mined 32/32 cobblestone"` because the bot successfully broke 32 stone blocks. But only **1** ended up in inventory. The remaining 31 cobblestone drops landed where the bot wasn't standing and despawned before pickup.

The agent **trusted the success message**, marked the card progress, and on the next call discovered only 1 in inventory. From there it spent 70+ LLM turns retrying — calling `mc collect`, `mc pickup`, `mc dig`, `mc dig_area`, `mc move`, `mc goto_near` — trying to figure out why "Mined 32/32" didn't equal "have 32".

**Evidence:** verbs called during zee miner (116 tool responses, 1095s runtime):

| Verb | Calls |
|---|---|
| `move` | 21 |
| `goto_near` | 13 |
| `inspect` | 12 |
| `reachable` | 10 |
| `inventory` | 8 |
| `dig_area` | 6 |
| `pickup` | 6 |
| `dig` | 5 |
| `collect` | 4 |
| `place`, `equip`, others | ≤3 each |

The agent didn't loop on one bad pattern — it tried multiple strategies. The bot side rewarded none of them with usable inventory.

**Root cause:** `mc collect`'s "Mined N/N" message conflates "blocks broken" with "items picked up." A 5×3×5 cobblestone outcrop with a bot on the south face has drops landing on top of the outcrop, in the gap between bot and outcrop, or off the south edge — most are not reachable from the dig position. The verb doesn't walk to the drops.

### Issue 2 — Movement targeting solid blocks (NAV_BLOCKED storm)

13 `NAV_BLOCKED` errors during z_mine alone. Pattern: agent called `mc move <x> <y> <z>` with coords inside the cobblestone outcrop or on top of a chest, then pathfind failed because the destination is solid.

Examples:
- `mc move 300 65 305` (chest is at this exact cell) → NAV_BLOCKED
- `mc move 310 65 309` (cobble outcrop) → NAV_BLOCKED
- `mc move 311 65 305` (overshoot into outcrop interior) → NAV_BLOCKED

The skill bundle correctly says "use `mc move @MARK`" but the agent kept reverting to raw coords mid-card after a complication. The pattern: `mc move @:stone_source:` (success), then later `mc move 310 65 309` (failure).

The first `mc move 300 65 305` was in pip's run too (msg #9 of `p_nav_stash`'s session) but recovered by re-trying with `mc goto_near 299 65 305 range=2`. So `goto_near` is the right verb when the target is a placed block.

### Issue 3 — Chest verb syntax mismatch (caused crash 26 and detours)

The `agent-crafter.md` bundle's verb table says:
```
mc chest open :mark:
mc chest open <pos>
```

The actual CLI doesn't have an `open` subverb. Pip's first `p_withdraw_axe` attempt (run 26 — crashed, no session persisted) and zee's mine session both hit this:

```
mc chest open chest_stash       → MISSING_COORDS
mc chest open @chest_stash      → MISSING_COORDS
mc chest open 300 65 305        → MISSING_COORDS
mc help chest                   → "usage: mc chest X Y Z OR mc chest @MARK"
mc chest 300 65 305             → "Container: wooden_axex1, iron_pickaxex1, oak_signx4"  ✓
```

Three failures → `same_tool_failure_warning` → presumed crash on pip run 26.

Also: `mc deposit/withdraw` requires explicit coords or `mark=NAME`. The agent tried `mc withdraw wooden_axe 1 chest_stash` (no `mark=` keyword) — that worked (the CLI accepts mark as last positional), but it's not documented in the bundle.

### Issue 4 — Miner's tool acquisition is implicit in the graph

Zee's `z_mine` card body says "Use the iron_pickaxe from your inventory." But the fixture stages the iron_pickaxe in `:chest_stash:`, not in Zee's inventory. The `z_nav_stone` card before it just navigates to `:stone_source:` — there's no withdraw step in zee's lane.

The agent caught this in turn 1 (msg #100–128): noticed inventory empty, ran `mc chest_search pickaxe`, found nothing in known snapshots, eventually `goto_near` chest_stash, opened it, withdrew the iron_pickaxe. Total detour: 28 messages before any mining happened.

The bundle says: "No pickaxe / tool in inventory → block with `tool_required:<tool_name>`." The agent chose initiative over blocking, which is *good* behavior but obscures the graph bug: zee's lane should have a `z_withdraw_pickaxe` card between `z_nav_stone` and `z_mine`, or `z_nav_stone` should detour through stash. As written, the graph assumes zee starts with a pickaxe.

### Issue 5 — `mc pickup` doesn't search a reasonable radius

Six `mc pickup` calls during z_mine, mostly returning "No items picked up." The drops from mined stone are 1–3 blocks away (above/below the cobble outcrop top surface, or in cracks). `mc pickup` apparently searches only the bot's exact cell. The bot's movement between mining and pickup tends to put it out of pickup range.

### Issue 6 — `dig_area` per-call limit + hazard checks interrupt natural mining patterns

```
mc dig_area 310 64 309 312 66 312
→ ERROR: 36 blocks is too many — per-call limit is 32

mc dig_area 310 64 311 312 65 312
→ dig_area aborted at 311,64,309: fall hazard. 5 blocks dug so far.
```

For a 5×3×5 outcrop (75 blocks), the natural verb is `dig_area` covering the whole thing — but the per-call limit is 32 and the hazard check fires when the bot has to dig downward through a solid stack. Both protections make sense in general, but they force the agent into smaller, more bookkeeping-heavy moves.

### Issue 7 — Cross-bot chat in tool output

Many tool responses include `chat <Pip> done t_xyz: …` prefixes — the other bot's chat is observable to the agent. This adds 50–200 tokens per response without informing the current task. With deepseek's 97% cache hit ratio it's cheap, but it's signal noise the bundle should explicitly de-emphasise ("ignore chat from other bots unless the body asks you to").

### Issue 8 — Worker spawn crash on run 26 (no diagnostic)

`p_withdraw_axe` run 26 is recorded as `outcome=crashed` with metadata `{"pid": 10294, "claimer": "macstudio.local:10293"}`. No session in state.db. No traceback in `errors.log`. The dispatcher's `--failure-limit 2` would have auto-blocked after one more crash, but the next attempt (run 27) succeeded.

Could have been: too-many-failures from chest_open trying, or a transient API issue, or a worker boot error. We don't know without more instrumentation.

## Operator interventions

| # | Card | Action | Reason |
|---|---|---|---|
| 1 | `z_mine` | `hermes kanban block` after 18 min | Agent making LLM calls but no bot-side mining progress for ~10 min |
| 2 | `z_return`, `p_build`, `z_build`, `p_sign` | `hermes kanban archive` | Cascade: parents unreachable, watch loop wouldn't terminate otherwise |

Cost (telemetry summary, manual_interventions = 1): ~71 API calls on zee's miner (~85k tokens / 97% cache hit). Pip's 5 cards: ~6–30 turns each. Total trial cost: small (cents-of-dollars). The wasted LLM spend during the stall was tiny in absolute terms because cache hit rate was high.

## What's still good after this trial

- Mutex parallelism proof is intact. Both bots ran concurrent navigators for 9 minutes.
- Handoff contract test passed on a real edge.
- Pip's lane (5 cards, ~9 min wall time) executed cleanly with one auto-recovered crash. Demonstrates the architecture's recovery pattern works.
- The 11-card DAG topology held — convergence cards stayed `todo` until parents finished, would have run had zee finished.
- Telemetry JSONL has every transition + the scorecard. Postmortems are tractable.

## Fixes — by priority, with concrete actions

### P0 — Bot-side: fix `mc collect`'s misleading success message

`bot/lib/actions/collect.js` (or wherever the verb lives) should distinguish three counts in its response:
- `blocks_broken` — what the verb does today
- `items_dropped` — count of `dropped_items` events  
- `items_collected_in_inventory` — recount inventory delta against pre-call snapshot

`result:` text should reflect the inventory delta, not blocks_broken. Suggested message:
```
"Mined 32 blocks, picked up 1/32 cobblestone — drops out of pickup range. Try smaller batches + mc pickup between, or position to catch drops."
```

The `data` object should include all three so the agent can reason about it. Add a Tier-1 contract test in `bot/test/actions/` that verifies the count fields are present and consistent.

### P0 — Skill: fix `agent-crafter.md` verb table

Current `agent-crafter.md` §3 says `mc chest open :mark:` — change to:

| Verb | Correct usage |
|---|---|
| `mc chest <x> <y> <z>` | Open + list chest by coords |
| `mc chest @MARK` | Open + list chest by mark name (no colons, no `open` subverb) |
| `mc withdraw <item> <count> @MARK` | Withdraw from named chest |
| `mc withdraw <item> <count> <x> <y> <z>` | Withdraw by coords |
| `mc deposit <item> <count> @MARK` | Symmetric to withdraw |

Drop the `open` subverb everywhere. Add an explicit hint: "If you forget the syntax, run `mc help <verb>` — the bundle's verb table is a quick reference, not the authoritative grammar."

### P1 — Skill: `agent-miner.md` extraction-from-face strategy

Add a "Phase-specific knowledge" subsection on outcrop face mining:

> **Mining an outcrop face.** If `mc collect` returns "Mined N/M" but `mc inventory` shows fewer than M items, the drops likely landed where you can't reach. Switch to manual loop: `mc dig <x> <y> <z>` one cell at a time, then `mc pickup` *immediately* before stepping to the next cell. For a multi-block face, batch with `mc dig_area` in **≤32-block chunks** at a single Y plane (avoids both the per-call limit and the fall-hazard check).

Also: tighten the "what you do NOT do" escape rule — when target count not in inventory after 3 collect/dig attempts, **block with `extraction_yield_low:<observed>/<target>` and report observed drops to the next agent**, instead of looping.

### P1 — Skill: `agent-navigator.md` and others — pre-check movement targets

Add to every bundle that uses `mc move`:

> **Targets that are solid blocks (chests, walls) need `goto_near`, not `move`.** Before `mc move <x> <y> <z>`, mentally check: is the destination cell air? If you're navigating to a chest or block at coords, use `mc goto_near <x> <y> <z> range=2` instead. The mark form `mc move @MARK` handles this for you — prefer it.

This is documented for navigator but the agent reverted to raw coords under stress. Reinforcement helps.

### P1 — Graph: zee's lane needs a stash withdraw step

Either:
- **Option A**: split `z_nav_stone` → add `z_nav_stash` + `z_withdraw_pickaxe` cards before it. Zee's lane grows from 3 → 5 cards. Symmetric with pip's pre-axe withdraw.
- **Option B**: change the fixture to give zee the iron_pickaxe directly via `/give Zee minecraft:iron_pickaxe 1` in prep. Zee's lane stays 3 cards but the trial assumes "tools magically appear" — less architecturally clean.

Option A is the architecturally honest fix; Option B is what we'd do if the goal is to test extraction in isolation.

### P2 — Bot-side: `mc pickup` should search a small radius

`mc pickup` currently picks up items at the bot's cell only. Extend to search 2 blocks radius (the `mineflayer` pickup distance), and surface what was picked up vs what's nearby-but-unreachable.

Test fixture for the contract: stage 5 drops at varying distances, assert pickup returns the reachable subset.

### P2 — Bundles: deprioritise cross-bot chat noise

Add a one-line guidance to every bundle:

> Chat lines from *other* bots are not your concern unless your card body specifically references the other bot's progress. If you see `<other_bot> done t_xyz: ...` in tool output, treat it as background noise — don't react.

This won't reduce the noise mechanically but tells the model not to spend turn budget on it.

### P2 — Runner: handle workers that exit without crashing

Pip's run 26 was marked `crashed` with no traceback. Investigate whether the dispatcher's spawn-failure detection has a default error code path or just times out. Worth checking `hermes kanban dispatch --failure-limit 2` behavior on actual exception vs. silent exit.

### P3 — Dispatcher needs to be a real script, not a shell loop

This trial's dispatcher was a bash `while true; do hermes kanban dispatch; sleep 10; done` loop I started by hand. Production should have either:
- A long-running `scripts/proto-dispatcher.sh` that mirrors `scripts/landfolk-dispatcher.sh`
- Or built into `run_two_bot_base.py --watch` so a single command starts both

The current shell loop is operator-hand-rolled and easy to forget to start.

### P3 — `pytest --run-id` not registering

`test_two_bot_base_handoff_contract.py` declared `pytest_addoption` inside the test module. Pytest only recognises it from `conftest.py`. Move it to `prototypes/agent-arch/tests/conftest.py` so `--run-id` works (currently falls back to `TWO_BOT_RUN_ID` env or auto-discovery).

### P3 — Colony stop-bots names

`scripts/stop-bots.sh` whitelist needs Pip/Zee/Mox. Today `scripts/colony stop --all` fails silently to kill them, leaving stale processes that hold ports. Documented at pre-flight; should be a one-line patch.

## Decisions for the next trial

1. **Land P0 fixes before any re-run.** A second trial that fails the same way doesn't add information.
2. **Make the fix list explicit upstream**: add a `reports/agent-arch/two-bot-trial-2-prereqs.md` checklist; tick boxes as items land.
3. **Decide pickaxe path** (graph Option A vs fixture Option B). The plan's freeze-rule discipline says: pick one before the trial, don't switch mid-run.
4. **Score next trial against the same 3-number band**. Pass = parallelism (already shown) + sign at seed. Partial = anything else.

## Cross-references to existing memory + plan items

- The plan's "Out of scope (deferred)" already calls out `scripts/scout-seed.py` and `scripts/audit-skill-verbs.py`. This postmortem suggests **the verb-audit script should land before trial 2**: it would have caught Issue 3 (the bundle's verb table claiming `mc chest open` which doesn't exist in the CLI registry).
- The plan's "Pivot options" listed "Pre-stage zee's cobble" as a Tier-B move — same as Option B for the pickaxe fix here. The pickaxe vs cobble are both "fixture giveth what the agent should fetch" decisions; consistent framing.
- Existing memory `feedback_hermescraft_framework_scope.md` (framework primitives only, no coordination semantics) supports: don't try to coordinate the stash-fetch in the bundle — the GRAPH should handle it via dependencies.

## Status of the v1 falsification claims

| Claim | Status after trial 1 |
|---|---|
| Mutex parallelism in vivo | **Supported.** 529s of overlap, no cross-claim, no orchestration bugs. |
| Handoff metadata crosses spawn | **Supported.** Contract test passed on the chosen edge. |
| Cooperative outcome at seed | **Inconclusive.** Cooperation didn't reach the sign because of unrelated extraction-layer issues (mc collect false success, miner skill gaps). |

The architecture's mechanism layer is **not** what failed. The bundle text + the bot-side verb implementations are where the gaps live.
