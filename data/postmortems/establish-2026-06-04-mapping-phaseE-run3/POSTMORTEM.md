# Phase E mapping mission — run-3 postmortem

**Date:** 2026-06-04
**Seed:** `300886438233796193` (same as run-2; beach + forest + river, Y-delta 18)
**Models:** Workers = `xiaomi/mimo-v2.5`. Steward = `deepseek/deepseek-v4-flash:exacto` (unchanged).
**Duration:** ~50 min wall-clock (11:16–12:06 PDT), operator-halted.
**Outcome:** 3 of 4 grader thresholds met; 1 short (need 6 named, have 4).

## Headline

The run revealed **one new structural bug** that swamped everything else: `landfolk-control.sh` snapshots wake prompts at session boot. Both mid-run patches to `steward.wake-minimal.md` (the [MAP:ARENA] handling and the "1/1 done is a red herring" clarification) **never reached Steward**. The entire run executed against the pre-patch checklist. Almost every Steward-side problem in this run traces back to that.

Separately, **xiaomi/mimo-v2.5 is strictly worse than deepseek for these workers** on this scenario — 3× the reasoning tokens, 0 new landmarks from scratch, plus a critical failure mode where the model narrates "Waypoint placed" without invoking `mc poi_add`.

## Final state

| Metric | Threshold | Final | Status |
|---|---:|---:|---|
| `named_count` | ≥ 6 | 4 | **short** (need 2 more landmarks) |
| `longest_path_len` | ≥ 80 | 122.0 | ✓ |
| `quadrants_covered` | {NE, NW, SE, SW} | {NE, NW, SE, SW} | ✓ |
| `named_frontier_count` | ≤ 3 | 3 | ✓ |

**Landmarks (4):** muster, birch_landing (NE, from run-2), lake_isle (SW, from run-2), birch_hollow (NW, **new this run by Mason**).
**Waypoints (7):** edge_east, wp_e_1, wp_e_2, wp_n_1, wp_nw_0, wp_nw_1, wp_nw_2 (the wp_nw_* trio is Mason's torch chain to NW).

## Timeline

- 11:16 — fleet up, workers on `xiaomi/mimo-v2.5`
- 11:24 — Flint posts `birch_landing` SIGN_PROPOSAL; Steward approves autonomously by ~11:35
- 11:43 — operator patches `steward.wake-minimal.md` to add [MAP:ARENA] handling + mandatory card-creation directive *(patch never reaches Steward — see Bug 10)*
- 11:47 — operator patches again with "1/1 done red herring" + graph thresholds *(also never reaches Steward)*
- 11:49 — operator manually dispatches NW [MAP-PATH] for Mason (Steward isn't creating cards)
- 11:51–11:58 — Mason executes NW protocol cleanly: torch chain (wp_nw_0/1/2), reaches target, foot-cell error, sidesteps, posts SIGN_PROPOSAL `birch hollow` at (-20,67,-80)
- 11:58 — Mason posts SIGN_PROPOSAL; Steward **does not see it**, posts a NUDGE instead
- 12:00 — operator manually APPROVES on Steward's behalf
- 12:00 — Mason places sign + `poi_add birch_hollow --kind landmark` + closes card
- 12:00 — Mason **reverts to SOUL "Defense Builder" loop**, placing perimeter torches at base
- 12:05 — reconcile lifts birch_hollow into shared file; thresholds jump (named 3→4, path 89→122, quadrants 3/4→4/4)
- 12:06 — operator force-completes Gatherer's stuck south card (32m of AUTO_STUCK in a boat at -1,12) + Flint's stale RESCUE card, dispatches Mason→SE and Gatherer→S (no-boat directive)
- 12:08 — operator halts run for postmortem

## Bug catalog (continuing from run-2)

### Bug 10 — **Wake-prompt snapshot at session boot** (NEW, central bug)

`scripts/landfolk-control.sh:1138` reads `steward.wake-minimal.md` once via `cat` inside `start_agent()`. The captured string is passed into the per-round agent loop (lines 1736–1767), which never re-reads the file. The misleading comment at line 1134 — *"Re-read each round via cat — edits land on the NEXT round without a restart"* — is aspirational, not what the code does.

**Impact:** Every prompt edit during a live run requires a Steward restart. Both run-3 patches landed on disk but never on the model.

**Fix (recommended):** Move the `cat` from `start_agent()` into the round loop near line 1736, so each round reads the file fresh. Same applies to `worker.wake-minimal.md` / `worker.wake-full.md` (lines 1149–1159). Cost: ~1 file stat per round per agent — negligible.

### Bug 11 — **SOUL bleed-through on card close** (NEW)

When a worker's kanban card closes, the `kanban_held: skipped` sleeper releases with `top_goal=none` and `HERMES_KANBAN_TASK` unset. There is no orchestrator handoff, no completion summary, no "next-card pending" hint — so the SOUL preset agent-loop wins by default. Mason demonstrated this twice: rounds 1–3 (before NW dispatch) and rounds 20+ (after NW close), running the same "Defense Builder torches around base" reflex and hitting `block is already torch` errors on already-lit cells.

**Impact:** Idle workers thrash on stale role-preset behaviour instead of waiting for kanban or signalling availability.

**Fix candidates:**
- Worker default behaviour when no card is in flight: `mc goto muster` + `mc chat "idle, awaiting dispatch"` + sleep, instead of SOUL preset.
- OR have Steward post a holding-task on epic close ("IDLE: report to muster").
- OR make `kanban_held` extend through a brief "look-for-next-card" window before releasing to SOUL.

### Bug 12 — **`kanban_held` silences workers during 90s SIGN_PROPOSAL wait** (NEW)

The card protocol says "post SIGN_PROPOSAL → wait 90s for approval." But the worker enters `kanban_held: sleeping 60s` while on a claimed task, which silences it across the wait window. Workers only poll kanban on round boundaries — they don't re-fetch comments during sleep. So if Steward APPROVES at second 30, the worker won't see it until ~second 60. If she APPROVES at second 60+, the worker has already moved on.

**Comms agent measurement:** ~60% of card runtime is synchronization wait, not execution.

**Fix candidates:**
- Wake worker on kanban-comment notification (push, not poll).
- OR shorten kanban_held to 15s when in active SIGN_PROPOSAL window.
- OR replace the wait with optimistic execution: place sign immediately, accept REJECTED later as a rollback.

### Bug 13 — **SIGN_PROPOSAL discovery requires a loud stuck signal** (NEW)

Steward classified Mason `HEALTHY_WORKING runtime 2m at target` — no stuck signal — and posted a NUDGE ("propose a sign name") instead of scanning her card for the proposal she'd already filed. By contrast, Flint's earlier `birch_landing` SIGN_PROPOSAL surfaced because his PHYSICALLY_STUCK + AUTO_STUCK fingerprints made the pending state visible in `scripts/kanban board` and `fleet-status`. **Steward's classification rubric reads board diagnostics, not card comments** — so silent waiting is invisible to her.

**Fix:** Add a checklist step "for each IN-FLIGHT [MAP-PATH], `kanban show $id` and grep `SIGN_PROPOSAL` in the last 5 comments." Land via the same restart that picks up Bug 10's fix.

### Bug 14 — **Steward hallucinates SIGN_PROPOSAL success from stale fleet-status** (NEW)

After missing Mason's actual proposal, Steward later wrote "Mason placed sign 'birch hollow' at NW target" — but this was parsed from a chat line that the operator had posted on Mason's behalf via the manual APPROVE, NOT a real placement event. She then closed the loop in her head and stopped checking the card. This is a credibility-of-source problem: `fleet-status` "last log" lines mix in-world chat with kanban comments and operator interventions, and Steward treats all of it as ground truth.

**Fix:** Steward should verify by reading the personal-pois file directly (or by `mc reconcile` if she gains the ACL), not by reading lagging fleet-status snippets.

### Bug 15 — **`deepseek/exacto` emits malformed `<｜DSML｜tool_calls`** (NEW, low severity)

Three rounds (7, 9, 10) had visible malformed tool-call emits in Steward's log. Distinct from xiaomi/mimo failures; this is a deepseek-exacto stability issue worth tracking but not blocking.

### Bug 16 — **xiaomi/mimo narrates protocol completion without invoking the tool** (NEW)

Critical failure mode for mimo workers. Mason at line 3001 of `agent-mason.log` recited all 8 MAP-PATH protocol steps in order, then executed only step 3 (torches), skipped 4–7 entirely, and self-reported "Waypoint 1 placed" / "Waypoint 2 placed" without ever invoking `mc poi_add`. The model treats the recited protocol as performative narration. (Caveat: Mason DID register `birch_hollow` as a real landmark POI — that part worked. The narration failures are on the intermediate waypoints.)

**Fix candidates:**
- Coercive scaffold: enforce that `mc poi_add` follows every `mc place_torch` before the next round can begin.
- OR replace mimo with deepseek for workers (recommended — see model comparison below).

### Bug 17 — **Workers don't read the kanban card body, only chat** (NEW — Gatherer's failure)

Gatherer's 32-min stuck loop traces to one root cause: she **never read her [MAP-PATH] card body**. Zero `kanban` or `kanban_comment` tokens in her mc-log. The destination "south landmark" appears nowhere in her reasoning. She inferred her mission from a stale chat fragment ("connect lake isle → muster with torch-lit path"), invented sailing as a side-quest to rescue someone else, deposited herself in the wrong quadrant, and thrashed there. Engine `hint=mc reachable X Y Z` suggestions appeared in 4+ FAIL_DETAILs — ignored every one.

**Fix candidates:**
- First action on every round MUST be `kanban_show $HERMES_KANBAN_TASK`.
- Workers should be force-fed the card body on round=1 of every claim.
- The `kanban-worker` skill should explicitly start with "READ YOUR CARD BODY."

### Bug 18 — **`HERMES_KANBAN_TASK` env var unset between rounds** (NEW)

Gatherer's reasoning never references her card because the env var was unset every round. If the var were set, the worker could at least look up which card it's on and re-read the body. (Mason got around this by remembering the card content from her round=1 reasoning — but that depends on the model's recall, which mimo is unreliable about.)

**Fix:** Persist `HERMES_KANBAN_TASK` across rounds in the worker's session state, set by the dispatcher when the claim is made.

## Model comparison: xiaomi/mimo-v2.5 vs deepseek-v4-flash:exacto (workers)

| Metric | mimo (run-3) | deepseek (run-2) |
|---|---:|---:|
| Run duration | ~50 min | ~40 min |
| Reasoning blocks total | 909 | 260 |
| Reasoning words total | 49,362 | 16,885 |
| **Successful `mc place_named_sign`** | 1 (Mason) | several |
| **`mc poi_add --kind landmark`** | 1 (Mason birch_hollow) | several |
| Hallucinated verbs | mc sail_to, mc rescue, mc fight, mc fill, mc respawn, mc map, mc connect, mc discover | minimal |
| Protocol adherence | Mason: literal when card present; otherwise narrative | Worse on deliberation latency, better on protocol completion |

**Behavioural signatures:**
- **xiaomi/mimo-v2.5 (Mason):** committed, protocol-literal *when she has a card*; defaults hard to SOUL preset when none.
- **xiaomi/mimo-v2.5 (Gatherer):** confused, never read card body, ignored engine hints, invented verbs.
- **xiaomi/mimo-v2.5 (Flint):** middle of the road — completed birch_landing handshake (carry from earlier in run).
- **deepseek/exacto Steward:** thorough planner, slow to act, occasional malformed tool emits, repeatedly bumps the role-ACL ceiling.

**Recommendation:** Stay on deepseek for workers. mimo's one advantage is commit-bias on micro-actions — when it decides to place a torch, it places it fast. For mapping that's irrelevant; what matters is durable artifacts (signs, POI records), and mimo doesn't reliably produce those — it narrates them. Cost-per-landmark proxy is dramatically worse.

**Caveat to the model comparison subagent's finding:** the agent claimed all run-3 graph state was inherited from runs 1+2 based on timestamps. That's wrong on at least one specific point — birch_hollow at (-20,67,-80) couldn't pre-exist run-3 because the NW MAP-PATH card was created during run-3. Mason did register that landmark. But the broader narrate-vs-execute pattern is consistent across the rest of her behaviour.

## Run-2 bugs that reappeared

- **Bug 5 (Steward mc ACL-denied):** Strongly reappeared. 41 denial events in run-3. Wake prompt still ends with "mc chat" which Steward keeps trying. Untouched because Bug 10 prevented the patched prompt from landing.
- **Bug 6 (no plan persistence):** Reappeared. Steward re-discovered her mc denials in rounds 2, 3, 5, 8, 10, 11. Memory writes happen, memory reads don't carry forward.
- **Bug 7 (one-way comms loop):** Reappeared and aggravated by Bug 12 (kanban_held silences workers during SIGN_PROPOSAL wait).
- **Bug 8 (skill-flag forgetfulness):** N/A but inverted — Steward never created cards at all, so couldn't forget `--skill` flags. The patched mandate never reached her.
- **Bug 9 (idle-worker → spawn-capacity confusion):** Strongly reappeared. With 3 idle assignable workers and an open [MAP:ARENA] epic, Steward tried `landfolk enable barley` twice to bring up a 4th worker instead of dispatching the existing three.

## Highest-leverage fixes for run-4

Ranked by expected impact:

1. **Bug 10 — fix prompt re-read in `landfolk-control.sh`.** Single biggest unblocker; almost all Steward-side issues in this run trace through it. Move the `cat` into the round loop. **One-line move.**
2. **Bug 17/18 — force workers to read the card body on round 1 of every claim.** Either persist `HERMES_KANBAN_TASK` across rounds or hard-code "first action: kanban_show" in the worker wake prompt. Saves Gatherer-class 30-min stuck loops.
3. **Bug 5 — lift Steward's `mc` ACL** for at least `mc chat`, `mc whisper`, `mc observe`, `mc pois` (read-only). Run-2 postmortem already flagged this as highest-leverage; still true.
4. **Bug 11 — define worker idle behaviour.** "Return to muster, chat 'idle, awaiting dispatch', wait" instead of SOUL bleed-through.
5. **Bug 13 — Steward checklist scans card comments.** Easy add to the wake prompt once Bug 10 is fixed.
6. **Switch workers back to deepseek.** xiaomi/mimo-v2.5 is strictly worse here.

## Out of scope for run-4 (revisit later)

- Bug 6 plan persistence (architectural — `mc next_step` / `mc step_done`)
- Bug 12 push-based kanban notifications (architectural — adds gateway dependency)
- Bug 15 deepseek malformed tool emits (model-side; track over time)
- Bug 16 mimo narrative-vs-execute (only relevant if we revisit mimo with a coercive scaffold)

## Artifacts

- `logs/` — agent + mc logs for all 4 bots
- `personal-pois-*.json` — per-bot POI files
- `personal-pois-shared.json` — reconciled shared file
- `poi-graph-final.json` — final graph summary
- `kanban-final.txt` — last board snapshot
- `kanban-full.json` — full kanban DB dump
- `agent-models.json` — model config used (with xiaomi/mimo on workers)

## Wins worth keeping

- **Mason's NW path-construction** is a clean reference for the protocol: muster → 3 torch waypoints → target → SIGN_PROPOSAL → approval → place_named_sign → poi_add landmark. When the model has a card and the comms loop closes, the design works end-to-end.
- **Reconcile lifted state correctly.** birch_hollow appeared in shared file with no conflicts; quadrants graph updated.
- **`establish-fleet-cleanup.sh` pkill addition from earlier in this session held up** — fewer orphan kanban-task hermes processes than run-2.
- **Wake-prompt classification patches** (PHYSICALLY_STUCK vs IDLE_AVAILABLE) were the *right* edit — they just never shipped. They are ready to land as-is once Bug 10 is fixed.
