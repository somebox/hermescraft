# Two-bot live trial #3 postmortem — PASS

**Date:** 2026-06-07 10:44–11:00 UTC+2
**Run id:** `trial-1780821845`
**Trial packet:** `data/postmortems/two-bot-base/trial-1780821845/`
**Scorecard band:** **pass** ✅
**Companion docs:** [Trial 1 postmortem](2026-06-07-two-bot-trial-1-postmortem.md) · [Trial 2 postmortem](2026-06-07-two-bot-trial-2-postmortem.md) · [Trial 3 runbook](two-bot-trial-3-runbook.md)

## Scorecard

| # | Number | Result |
|---|---|---|
| 1 | `parallelism_observed` + `overlap_s` | **true / 483 s** |
| 2 | `pip_done_count` / `zee_done_count` | **7/7** and **6/6** |
| 3 | `sign_at_seed` | **true** |
| 4 | Handoff contract test | **2/2 pass** |

**Wall time:** 951 s (~15.85 min) card-create to sign-verify.

## Why this trial mattered

Trial 3 wasn't about discovering new architectural behavior — trials 1 and 2 covered that. Trial 3 was the **migration test**: would the same 13-card cooperative DAG work against the live Hermes home (`~/.hermes/`) with cards on a dashboard-visible board (`two-bot-demo`), with no observable behavioral difference from the proto rig?

The hypothesis: trial 3 should look ~identical to trial 2. If it does, the proto rig is no longer load-bearing — future trials can use the live HERMES_HOME and the work is visible to anyone watching the dashboard.

The hypothesis held.

## Trial 1 → 2 → 3 comparison

| Metric | Trial 1 | Trial 2-B | Trial 3 |
|---|---|---|---|
| Band | partial (operator-blocked) | **pass** | **pass** |
| Cards done | 6/11 | 13/13 | 13/13 |
| `z_mine` | 1095 s stall, 1 cobble | 133 s, 32 cobble | 105 s, 32 cobble |
| `z_build` | n/a | 364 s | 441 s |
| Parallelism overlap | 529 s | 591 s | 483 s |
| Total wall time | aborted ~30 min | ~15.4 min | ~15.85 min |
| Operator interventions | 1 | 0 | 0 |
| **HERMES_HOME** | proto | proto | **live** |
| **Workspace layout** | flat | flat | **boards-per-tenant** |
| **Dashboard visibility** | no | no | **yes** |
| **Board** | (flat) | (flat) | `two-bot-demo` |

Wall times within ±3 %. Parallelism overlap noisier across runs but the architectural shape is consistent.

## Mid-trial fixes

Three small fixes landed during trial 3 — none architectural, all path-related.

### Fix 1 — Board pre-creation (first launch failed)

First launch attempt (`trial-1780821766`) failed because the runner's first `hermes kanban create` call hit:

```
kanban: board 'two-bot-demo' does not exist. Create it with `hermes kanban boards create two-bot-demo`.
```

The runner has no manifest-write fallback for "all creates failed" — wrote an empty `cards: []` manifest and exited.

**Fix:** added `_ensure_board_exists(board)` to `mode_create_only` — calls `hermes kanban boards create <slug>` defensively before the first card create. The CLI is idempotent (exit 0 on already-exists), so this is safe to run on every launch. No more manual board-create step.

### Fix 2 — `_kanban_db()` board-aware path

Original runner hardcoded `_kanban_db = HERMES_HOME / "kanban.db"`. The boards-per-tenant layout puts the kanban DB at `HERMES_HOME/kanban/boards/<name>/kanban.db`. After the runner created cards on `two-bot-demo`, the watch loop couldn't find them because it was querying the wrong file.

**Fix:** added module-level `_BOARD` set in `main()` from `--board`; `_kanban_db()` now checks `HERMES_HOME/kanban/boards/<_BOARD>/kanban.db` first, falling back to flat layout. Backwards-compatible — proto-rig calls (no `--board`) use the original flat path.

### Fix 3 — Handoff contract test same hardcoded path

`test_two_bot_base_handoff_contract.py` had `KANBAN_DB = HERMES_HOME / "kanban.db"` at module load. After trial 3 completed, the test SKIPPED with "no completed run for task t_2692171f (yet?)" because it was querying the wrong file.

**Fix:** added `_kanban_db_for_run(manifest)` helper that reads the new `manifest["board"]` field. Pytest fixture `kanban_db` provides the right path per-test. `_completed_run_metadata` and `_worker_session_id` now take the path as a parameter.

After all three fixes, the test passed first try: `2 passed in 0.02s`.

## What behavior changed (subtly)

### z_build slower (441 s vs 364 s)

Both trials hit the same NAV_BLOCKED-during-placement pattern that the trial 2 postmortem flagged. The new `agent-builder.md` placement-reachability discipline IS present (added before trial 3) but the trial-3 worker still recovered ad-hoc rather than following the discipline preemptively. Bundle text isn't a behavior contract — it's a hint.

**Read:** bundle text changes shift behavior at the margin but don't eliminate failure modes that depend on the model recognising them in context. The discipline section needs to be more directive — "BEFORE every `mc place`, call `mc reachable`" rather than the current "Use `mc reachable` first" suggestion. (Action item for trial 4.)

### Parallelism overlap slightly lower (483 s vs 591 s)

Cards completed in tighter sequence — when a card finishes, its child becomes ready faster than in trial 2 (where the gap was sometimes ~10 s on the proto rig). On the live board the dispatcher loop fires every 10 s same as before, but the kanban write latency to `~/.hermes/kanban/boards/two-bot-demo/kanban.db` is comparable to the proto's flat `kanban.db` — within ~1 s.

The smaller overlap doesn't mean LESS parallelism; it means cards spent slightly less time concurrently running because handoffs happened faster. Same total wall time, tighter scheduling.

## What didn't change

- **All 13 cards completed on the first task_run**. No crashes anywhere, no operator interventions, no manual retries. Same as trial 2.
- **`z_mine` succeeded in 105 s with 32/32 cobblestone**. The `mc collect` headline fix + floor stack + miner bundle update remain the load-bearing combination.
- **The handoff contract test passed** on the `p_nav_wood → p_withdraw_wood` edge once the path-lookup was fixed.
- **Cost ~cents.** OpenRouter cache hit rate stayed at 97-100% across all worker sessions.
- **`mc fill … overwrite=true`** worked in both pip and zee builds — the explicit documentation in `agent-builder.md` landed before trial 3 and the workers used the form correctly first try.
- **Cross-bot coordination** when builders converged at seed: same chat-once-pivot pattern emerged as in trial 2. The added bundle text §"Coordinating with a partner bot" didn't prescribe it but doesn't contradict it either; the model independently arrived at the same recovery.

## What worked about the migration

| Aspect | How it worked |
|---|---|
| `--board` flag passthrough | `run_two_bot_base.py` → `author.py` → `hermes kanban --board <slug> create …`. Existed at the CLI level (no Hermes changes needed). |
| Dispatcher isolation | Live `scripts/landfolk-dispatcher.sh` filters `--board landfolk-ops`. Our dispatcher loop filters `--board two-bot-demo`. Zero contention; production loop never saw our cards. |
| Profile installation | `setup-pilot-pip-zee-live.sh` created `~/.hermes/profiles/pilot-{pip,zee}/` cleanly, didn't touch `flint/mason/etc.`. |
| Workspace isolation | Each card got its own dir at `~/.hermes/kanban/boards/two-bot-demo/workspaces/t_<id>/`. Auto-torn-down after card completion. |
| Skill bundle path | Same path (`skills/agent-*.md`) read from same repo. No bundle duplication. |
| Fixture | `data/test-fixtures/open/two_bot_base.yaml` unchanged. Same arena, same chest staging, same marks. |
| Telemetry / scorecard | Manifest carries `"board": "two-bot-demo"` so postmortems can sort runs by layout. |

## What's stored

```
data/postmortems/two-bot-base/trial-1780821845/
  manifest.json    # "board": "two-bot-demo"
  telemetry.jsonl
  scorecard.json   # band: pass

~/.hermes/kanban/boards/two-bot-demo/
  board.json
  kanban.db        # the live board's task store, visible at :9119
  workspaces/
    (mostly torn down)
```

## Fixes worth landing before trial 4

### P1 — would tighten placement reasoning

- [ ] **`agent-builder.md` placement-reachability discipline more directive**: change from "before each placement, especially when working diagonally" to "**MUST** call `mc reachable <x> <y> <z>` immediately before every `mc place` whose target isn't your current standing cell. If unreachable, MUST call `mc goto_near` first." The current trial-3 z_build had 441 s with 8 placement-related errors despite the new section.
- [ ] **`mc place` should auto-pathfind to an adjacent standable cell on first call**, returning a friendlier error if no such cell exists. Currently it requires the bot to be in range AND returns NAV_BLOCKED if not, forcing the agent to pre-plan. This is a bot-side change in `bot/lib/actions/building/place-single.js`.

### P2 — operational hygiene

- [ ] **Capture `mc fill` exit message variants** as test cases — agent saw "Cannot place at X, Y, Z: block is already cobblestone" mid-overwrite-fill and (correctly) interpreted it as partial success. Worth a contract test in `bot/test/actions/`.
- [ ] **Dispatcher loop into runner `--watch`** — still hand-rolled bash. Trial 3 had no issues but it's operational debt.

### Not landing — trial 3 didn't surface new issues

- The `--board` migration story is complete. Three runner/test files patched in trial 3 are committed; no further migration work needed.
- The architecture's two falsifiable claims (mutex parallelism + handoff metadata across spawn) are demonstrated across three independent runs, two HERMES_HOME layouts, two workspace formats. Closing the v1 falsifiability story.

## What surprised me

Honestly, nothing. Trial 3 confirmed the migration hypothesis: the live boards layout works identically to the proto flat layout once the SQL paths are fixed. The architecture claim doesn't depend on which kanban-database-on-disk it talks to — only on the in-memory mutex + handoff semantics.

The biggest takeaway: **trial 3 is a regression** for the trial 2 claims, not a new measurement. Future cooperation-architecture work should use this layout from the start.
