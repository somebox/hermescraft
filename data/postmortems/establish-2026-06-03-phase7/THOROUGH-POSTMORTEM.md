# Phase 7 replay run-4 — thorough postmortem

**Run:** 2026-06-03 02:29 → 03:30 (~60 min, stopped manually for analysis)
**Setup:** `AUTO_REUSE=1 MATERIALIZE=0` (residual world from prior runs)
**Bots:** Steward (orchestrator-loop), Flint, Mason, Gatherer
**Artifacts:** [`data/postmortems/establish-2026-06-03-phase7/`](.) — 4.7 MB capture
**Companion docs:** [`FRICTION-NOTES-LIVE.md`](FRICTION-NOTES-LIVE.md) (operator's live observations + Patterns A-E)

## Run shape

| Phase | Outcome |
|---|---|
| Bootstrap (epic + 4 explore) | clean ✅ |
| Explore phase | 4/4 closed by ~03:00 (faster than run2) |
| Mason rescue (Pattern D residual pit) | Steward filed [RESCUE], Mason self-recovered via 2× `pillar_up --force` |
| Pad construct (Mason) | **iteration_budget_exhausted at 150/150 after 21 min** — manual dig/place loop, NEVER called `mc fill` |
| Pad reassignment | mason → flint at 03:01 (auto on budget exhaustion, not Steward initiative) |
| Pad construct (Flint) | running at stop (took over but inherited degraded world from Mason) |
| SUPPLY (Gatherer) | running at stop (hit `mc collect oak_log 64` count limit — issue #55) |
| Run end | stopped at ~03:30 for analysis |

## Analyzer ground truth (run-4 totals across 9 cards)

```
cards=9 invocations=982 errors=231 (23.5% error rate)
  mc move: 108     mc dig: 45     mc goto_near: 25
  mc pillar_up: 10  mc escape: 7  mc through: 6
  mc go_mark: 6    mc collect: 6  mc advise: 3
```

For comparison, **run2's 5 high-friction cards** (the analyzer's correct baseline after the parser fix): 190 errors, 92 `mc move`. Run-4 absolute counts are higher because 9 cards vs 5, but the **error rate is similar (~23%)**. Phase 7's code changes did not measurably reduce per-card friction.

## Phase 7 predicate scorecard

| # | Predicate | Status | Evidence |
|---|---|---|---|
| **7.0** | Zero Steward kanban-worker sessions for explore cards | ✅ **HELD** | All Steward sessions started with `Continue (orchestrator cycle)`, none with `work kanban task t_<explore_id>` |
| **7.0** | Explore cards assignee=orchestrator-tracker, Steward reassigns to workers | ✅ **HELD** | All 4 explore cards reassigned within first OBSERVE cycle |
| **3.1** | Steward calls 0 mutating mc verbs (orch-deny hook) | ✅ **HELD** | mc-steward.log: only read-only verbs (observe/status/scene/look/nearby/inspect/inventory) + chat/whisper |
| **7.2** | `mc move` errors materially below 92 across equivalent cards | ⚠️ **partial** | Per-card error rates similar to run2; analyzer parser improvements explain count differences. **Mason did not hit NAV_RETRY_LOOP (she pivots, doesn't retry-3x)** — but the inspect-storm and panic-pillar patterns remain |
| **7.3b** | `mc fill` returns `FILL_PARTIAL` with `remaining_cells` | ❌ **NOT EXERCISED** | Mason never called `mc fill` on the pad. She used manual `mc dig` + `mc place` loops for 21 min. Contract change had no chance to act. |
| **7.3a** | `/action/place_fill` no spurious 25s `[error]` | ❌ **NOT EXERCISED** | Same reason — no `mc fill` calls |
| **7.4** | `lt_*` / `candidate_pad_*` marks saved at target coords | ❌ **FAILED** | Flint 0/3, Gatherer 0/3+ used `--at`. All marks saved at bot's standing position. Phase 7.4 predicate is unmeasurable because no marks have correct coords. |
| **7.5** | Workers use structured handoff template (corners/obstacles/flatness/...) | ❌ **NOT ADOPTED** | Gatherer (the gold-standard worker) reverted to run2's ad-hoc narrative — no `corners:` / `obstacles:` / `flatness:` headers |
| **Steward** | `hermes kanban diagnostics` once per OBSERVE cycle | ❌ **0 calls** | SOUL mandates it; agent-steward.log shows zero `diagnostics` invocations across 20 cycles |
| **Steward** | Decomposition uses `parents=[…]` + `idempotency_key=…` | ❌ **NOT ADOPTED** | Steward did create cards (pad, supply, rescue) but per subagent inspection, neither field was used |

**Summary:** 3 of 10 predicates held. The other 7 fall into two buckets: **didn't fire** (7.3a/b — no `mc fill` was called; the contract migration is correct, just unexercised) and **SOUL-level guidance failed to penetrate** (7.4 `--at`, 7.5 handoff template, Steward diagnostics).

## Per-agent summary

### Steward — ✅ structurally clean, ⚠️ giving bad advice

**Strengths:** Continuous loop ran 20 OBSERVE cycles cleanly with no wedging. Orchestrator-deny hook held — zero mutating mc verbs. Rescue flow worked: filed [RESCUE] when Mason was stuck, archived it when she self-recovered (3 min between create and archive).

**Critical issue — Pattern E at the orchestrator level:** Steward whispered Flint *"You're underground at (11,96,-6). pillar_up to surface"* and Gatherer *"You're underground at (5,93,24). Pillar_up 15 to reach surface Y=103+"*. **Steward herself misread terrain as raw altitude.** She generated orders that *caused* Pattern C panic-pillars in the workers. The "Pillar_up 15" instruction would overshoot local surface Y=103 by 5+ blocks if Gatherer obeyed.

**Compliance failures:** 0 `hermes kanban diagnostics` calls across 20 cycles despite SOUL mandate. 0 use of `parents=[…]` or `idempotency_key=…` on her own creates. Did not catch the 41-min Mason pad stall — only acted (reassigning to Flint) when the kanban system auto-fired on iteration budget.

**One concrete fix:** mandatory `hermes kanban diagnostics` trigger when any IN-FLIGHT card has runtime > 15 min. Would have caught the pad stall at ~T+20 min instead of T+41.

### Flint — ✅ adaptive, ❌ ignored mark `--at` SOUL bullet

**Strengths:** Closed NE explore cleanly. When pad inheritance was hopeless (inherited Mason's degraded world), pivoted intelligently to mining cobble. Doesn't repeat-same-target — switches strategy after 1-2 failures (which means Phase 7.2 retry-warning never fired because she doesn't loop). Uses `mc go_mark` and `--near R` lenient verbs.

**Pattern penetration:** 3 marks placed on NE explore. **0 used `--at` despite SOUL bullet.** All three saved at her standing position, not the resource/feature coords described in the mark notes. This breaks downstream `mc go_mark` and creates the Pattern A "mark-then-can't-return" scenario for other workers.

**Pattern C:** 4 `mc pillar_up` calls (one `dirt 5`, two `dirt 10`, one with no block specified). Cluster in the pad-construct task while trying to reach base_anchor from spawn.

**One concrete fix:** make `mc mark` SOFT-FAIL when no `--at` is provided and the note text contains coordinate-like substrings (regex `\d+\s*,\s*\d+`). Return: *"mark <name> created without `--at` but note references coords. Downstream cards can't pathfind to this. Retry with `--at X Y Z`."* Converts SOUL guidance to enforced contract.

### Mason — 🌟 best self-rescue, ❌ never invoked the verb Phase 7.3 was built for

**Strengths:** Mason's self-rescue from the (4,84,29) residual pit was *competent* — not panic-pillars at random, but two deliberate `pillar_up --force` placements (5-block + 10-block stacks) to reach surface Y=97. Her SE explore produced 6 well-named marks (`se_iron_vein`, `se_coal_pocket`, etc.) accessible to downstream workers. Persistence through 22% error rate without abandoning task.

**Critical issue:** The pad task body says *"run mc fill cobblestone 13 103 1 21 103 9"*. Mason **never called `mc fill` at all**. She implemented manual `mc dig` (67 calls) + `mc place` cobble (1 call) + many supply hunts. Spent her 150 LLM turns mining manually, ran out, got auto-reassigned. **The entire Phase 7.3b FILL_PARTIAL contract migration could not run because Mason never reached the verb.**

**Pattern penetration:** 4 `mc pillar_up` calls (`oak_log 20`, `dirt 5`, `dirt 10`). 50 `mc inspect` calls in 21 min — but these were *perception-driven* (probing stone locations before mining), not the post-fill inspect storm the SOUL bullet was written to prevent. **Mason's inspect pattern is a different shape than run2 Mason's was.** Both wasteful, but not addressed by the current SOUL change.

**Mark accuracy:** 5/6 marks saved without `--at`, at her standing coord. Same failure as Flint. One mark (`lt_stone_ne` at 17,103,5) is correct because she was AT that coord when marking (it's the base_anchor center).

**Two concrete fixes:**
1. **Worker SOUL bullet:** for [CONSTRUCT] cards with a `mc fill` line in the body, the worker MUST attempt `mc fill` before any manual `mc place` loop. Surface a precheck.
2. **Card body parsing:** the seeder could highlight required verbs in the card body so the worker reads them as instructions, not suggestions. Already structured; just needs a SOUL bullet.

### Gatherer — ✅ thorough explorer, ❌ template + `--at` not adopted

**Strengths:** Closed BOTH NW and SW explores (Mason had rescue + pad). NW patrol was full radius 30, marked 4 resources + candidate_pad with conservative estimates. SW patrol explored to (-29,81,42) before returning. Resource estimation accuracy good (NW coal estimate ~10 vs ~77 actual is *conservative*, useful for planning).

**Pattern penetration:** 5 `mc pillar_up` calls (NW had 4, SUPPLY had 1+). Some used `oak_log` as the build block — a new variant of Pattern C using whatever's in hand. **0 structured-handoff template adoption** — her NW close-out was the same ad-hoc narrative she produced in run2 (the SOUL update template did not change her output).

**Mark storage bug discovered:** Gatherer's NW marks are in `locations-base.json` (shared registry) at her patrol-end position `(-25,91,-4)`, with notes describing actual resource locations like `(-30,87,-5)`. Three marks all save at her standing coord, not target. **This is the root cause of "0 marks in `locations-gatherer.json`" — they DID land but in the shared file, not per-bot, and with the wrong coords.**

**SUPPLY card:** hit `mc collect oak_log 64` error twice. Tried `mc collect oak_log 42` — also errored. Likely #55 (mc collect max=64 boundary). At stop, supply was incomplete.

**One concrete fix:** as with Flint, enforce `--at` requirement on `mc mark` when note text references coords. Plus: distinguish per-bot vs shared mark registries explicitly in worker SOUL.

## Cross-cutting patterns — quantified from run-4 evidence

| Pattern | Verified count | Strongest evidence |
|---|---|---|
| **A** Mark-then-can't-return | All 12+ explore-phase marks saved at standing position with target coords in notes — every downstream `mc go_mark` resolves to a wrong cell | Steward's pad task body cited mark `lt_stone_ne` at (17,103,5); flint's pad worker spent 8.8s on `mc go_mark lt_stone_ne` then attempted nav with multiple errors. |
| **B** Self-trap-by-digging | Mason's mining sessions had implicit foot-block digs followed by pillar-out recovery; no explicit foot-cell dig trace, but the recovery pattern matches | `t_ab46a48d.log` lines 60-122 (rescue sequence). Mason hallucinated trapped state after she fell, used `--force` to escape. |
| **C** Panic-pillar | **13 total `mc pillar_up` calls** across all 3 workers in run-4 (analyzer says 10 total but per-bot reports show: Mason 4, Flint 4, Gatherer 5 — analyzer may have missed one). Multiple blocks left behind: dirt, oak_log, cobble. | Mason `pillar_up oak_log 20`, Gatherer `pillar_up oak_log` etc. World now has 30+ residual pillars from run-4 alone. |
| **D** World degradation | Verified by Mason's pit-fall at spawn (4,84,29) — that pit existed from run3 or earlier. Run-4 added more pillars and holes. | Mason rescue card, plus operator's live observation: *"base and surrounding area are littered with small holes and stairs that were started"*. |
| **E** Terrain blindness | **Steward's whispers contained terrain misreads** ("You're underground at (11,96,-6). pillar_up to surface") — the orchestrator itself can't classify slope vs pit. Workers inherit the misclassification. | agent-steward.log search for `pillar_up to surface` — multiple instances. |

## Newly discovered issues (not in friction notes)

1. **Spec-execution gap** — card body says `mc fill cobblestone 13 103 1 21 103 9` but workers don't parse / honour this. Mason manually mined cobblestone for 21 min instead of using the prescribed fill verb. The Phase 7.3 contract change addressed a verb that was never invoked.

2. **Mark storage is shared (`locations-base.json`), not per-bot** — but the live operator check was reading per-bot files. This is a UX trap: the place to look for marks is `locations-base.json`, and per-bot files are largely empty.

3. **Steward gives raw-Y advice that creates panic-pillars** — Pattern E at the orchestrator level, not just at workers. Her decomposition tells workers to "pillar_up to surface" with absolute Y numbers, multiplying Pattern C downstream.

4. **`mc collect COUNT max=64` not respected** — Gatherer asked for 64 logs but got an error. Tried 42 — also error. The count cap (#55) bites SUPPLY cards routinely.

5. **0 cards used `parents=[…]` or `idempotency_key=…`** — Steward decomposed (pad, supply, rescue) but didn't use the Phase 6 SOUL primitives. They were used in run2 (5/18). In run-4, decomposition reverted.

6. **Iteration budget (150) is fragile for construct cards** — Mason consumed 150 turns on manual mining without finishing. Run2 also hit 150/150. Workers need either (a) more budget, (b) more efficient verbs the SOUL points them to, or (c) progress-aware turn budgets that extend when productive.

## Recommended next steps — Phase 8 candidate

Order is roughly by leverage-per-effort, smallest first:

### Tier 1 — small, hermetic, fast

1. **Enforce `mc mark --at` when note text contains coords.** Soft-fail with hint. Code change in `bot/cli/registry.mjs` or runtime mark handler. Test: unit test that mark without `--at` and a note with `\d+,\s*\d+` returns the warning.
2. **Surface `terrain_kind` + `feet_vs_local_ground` in nav-brief.** Reuse `cardinalReliefDeltas` + `surfaceYAt` already in `scene-landscape.js`. Add a thresholded classifier. Unit tests with synthetic scenes.
3. **`hermes kanban diagnostics` mandatory trigger in Steward SOUL.** Add: *"if any IN-FLIGHT card has runtime > 900s, call `hermes kanban diagnostics` immediately."* Pure prose update.
4. **Move-near as default for long-range `mc move`.** Distances > 20 blocks → default `--near 2`. Strict mode opt-in via `--strict`. The `bg_goto` / `goto_mark` lenient verbs already work — make `mc move` join them.
5. **Update Steward SOUL to interpret `terrain_kind`.** After the field ships, add to SOUL: *"never tell a worker 'you are underground' based on raw Y; use `terrain_kind` and `feet_vs_local_ground`."*

### Tier 2 — bigger surface, still bounded

6. **Card-body verb extraction in worker SOUL.** When `mc fill ...` appears verbatim in a card body, the worker MUST attempt the literal `mc fill` before any manual loop. Pure SOUL update first; later a precheck in kanban-worker skill.
7. **`mc escape` recognizes 1-block depression.** If `feet_vs_local_ground == -1` and there's a standable cell at `+1 Y` in any cardinal, the escape primitive's first action is `mc jump` not pillar. Code change in escape action.
8. **`mc fence` + advisory if `--gate` missing.** Soft hint, doesn't block. Catches Pattern C-via-fence early.

### Tier 3 — operator-side / infrastructure

9. **Fix the `AUTO_REUSE=0 MATERIALIZE=1` bootstrap.** The `mapcatalog try` invocation needs the requirements file passed through. Phase 4 bootstrap polish bucket.
10. **Spawn-area cleanup in rcon prep.** Add a small rectangle fill (`/fill X-6 Y-3 Z-6 X+6 Y Z+6 grass replace air`) in `establish-rcon-prep.py` to clear residual run pits.

### Tier 4 — design follow-ups

11. **Server-side classification thesis** — generalize the `terrain_kind` pattern across the perception verbs. Goal: agent reads labelled state, not raw geometry. List of fields worth classifying: `terrain_kind`, `feet_vs_local_ground`, `exits_via_jump`, `nearest_standable`, `path_blocked_by`, `worker_can_reach_target_by`. Each one collapses 3-10 LLM turns of re-derivation.
12. **Investigate mark registry split** — `locations-base.json` (shared) vs `locations-{bot}.json` (per-bot). Document the rules. Worker SOUL should say which file is authoritative for which mark kinds.

## What to do RIGHT NOW

If you want a fast Tier 1 win that's likely to disproportionately help next run: ship **#1 (`mc mark --at` enforcement)** and **#4 (`mc move --near` default for long-range)** together as one bot-side PR. Both are bounded, hermetic, testable; both directly attack the dominant friction (Patterns A + the strict-cell issue). The terrain classification work (#2 + #5) is the highest-leverage but a bigger change; it's worth scoping as a separate PR.

## References

- [`FRICTION-NOTES-LIVE.md`](FRICTION-NOTES-LIVE.md) — operator's live observations + Patterns A-E definitions + design thesis
- [`analyzer-run4.json`](analyzer-run4.json), [`analyzer-run4.txt`](analyzer-run4.txt) — quantified verb/error totals
- [`task-logs/`](task-logs/) — per-card cognition logs
- [`kanban.db`](kanban.db) — full event history
- `prompts/landfolk/steward.md`, `flint.md`, `mason.md`, `gatherer-test.md` — current SOULs (Phase 7 changes in place)
- `skills/kanban-worker.md`, `skills/minecraft-building.md` — current shared skills with Phase 7 updates
