# Phase 10 — focused mechanical fixes + fresh world

**Status:** draft, pending review (revision 2 incorporates second-opinion feedback on revision 1).
**Inputs:** [`data/postmortems/establish-2026-06-03-phase9/THOROUGH-POSTMORTEM.md`](../../../data/postmortems/establish-2026-06-03-phase9/THOROUGH-POSTMORTEM.md) + per-bot postmortems + two rounds of second-opinion review (2026-06-03).
**Prior phase:** [`planning-tracker.md`](../procedural/planning-tracker.md) Phase 9 (commit `61692ad`); run-6 postmortems + initial Phase 10 plan (commit `0f2ef75`).

## Why Phase 10

Run-6 stalled at ~60 min without reaching CONSTRUCT — Flint frozen 70+ min, Gatherer crash-looped on a prose verify-resources card. As an experiment it proved two things that revision 1 of this plan correctly identified:

1. **`nav-brief` renderer's "skip flat" is actively harmful.** Flint narrated *"I'm at Y=96 which is underground in this world"* on PR-H's freshly-cleaned spawn floor.
2. **Prose-SOUL alone cannot drive tooling adoption.** `wb stash-coord` got 0/4 invocations despite explicit bullets in three worker SOULs.

Revision 2 inherits revision 1's direction but rewrites the **how**: stop blocking simple mechanical fixes behind RCA; make "mechanical" actually mean upstream (linter, side effect, dispatcher policy) rather than another prose file; and accept that the heavily-modified test world is now a larger noise source than apples-to-apples comparison is worth.

## Three architectural shifts that drive everything below

1. **`wb context` becomes the orient-AND-stash surface.** Workers already call `wb context` on claim. Make it side-effect the card-body-coord stash file when extractable. Then every claim path gets PR-D's substrate without any worker remembering to invoke a second command. This collapses old PR-K (SOUL-bullet for stash-coord) into infrastructure.
2. **Card body linter at dispatch.** Instead of teaching each worker to detect prose CONSTRUCT/SURVEY and escalate, reject those cards before they leave `triage`. Steward or the dispatcher applies the rule once; workers never see a malformed card. This replaces PR-L (worker-side carve-out clarification) with a structural fix.
3. **Rescue is a board action, not a chat action.** Steward's durable control plane is the kanban board. Whispers via `mc chat` don't enter the worker's decision loop reliably. Make rescue = `kanban comment + reclaim` (or `+ reassign`), with chat as humans-only narration.

These three reshape revision 1's PR list. The renderer fix (10.J) is unchanged — it was already mechanical.

## Phase 10 PRs — revised by run-6 evidence weight + mechanical-first principle

### P0 — ship immediately, no gates

#### 10.J — `nav-brief` renderer always emits `terrain.kind`

- **Surface:** `bot/lib/runtime/nav-brief.js:629-632`. Drop the `terrain.kind !== 'flat' && terrain.kind !== 'unknown'` guard.
- **Test:** extend `bot/test/runtime/nav-brief-render.test.js` with a flat-pose fixture asserting `terrain=flat (feet_vs_local_ground=0)` appears in rendered output.
- **Effort:** ~5 LOC code + ~10 LOC test.
- **No RCA gate.** R1 (Flint pathfinder substrate) becomes post-fix validation, not pre-fix blocker. If route still fails with `terrain=flat` visible, `#41` promotes to P0.

#### 10.K — `wb context` writes the card-body-coord stash as a side effect

- **Surface:** `scripts/wb` — extend `cmd_context()` (or `_build_context()`) to call the existing `extract_card_body_coord()` and write `$HERMES_HOME/task-body-coord.json` when extraction succeeds. No new sub-command needed; the existing `wb stash-coord` stays as an explicit fallback.
- **Why this and not a skill bullet:** Phase 9 proved prose for tooling gets 0 adoption. `wb context` is already invoked on claim by every worker; piggyback on that path. Future SOULs don't need to remember anything.
- **Effort:** ~15 LOC in `scripts/wb` + 2 new tests (one for side-effect write on `wb context` with a CONSTRUCT body; one for no-write on EXPLORE body).
- **Coverage:** also clear the stash on `wb close`/`wb block`/`wb escalate` so stale coords don't leak across cards.

#### 10.R — dispatch-time card-body linter

- **Surface:** Steward SOUL where she calls `kanban_create` for CONSTRUCT/MINE/TILL/SUPPLY/SURVEY OR (preferred) a Python pre-check in `scripts/kanban` or a dispatcher hook.
- **Rule:** a card with `kind ∈ {CONSTRUCT, MINE, TILL, SUPPLY, SURVEY}` MUST have at least one line matching `^\s*mc\s+[a-z_]` (outside fenced code blocks; `Done_when: mc …` excluded). Multi-coordinate SCOUT (≥3 coord targets in body) follows the same rule. Cards that fail the lint either bounce back to `triage` with a linter comment OR get auto-rewritten with a TODO marker.
- **Why dispatch-time:** Phase 9 proved worker-side prose escalation (PR-B) gets 0/0 invocations on prose SURVEY + verify-resources cards because workers can't reliably distinguish "I should escalate" from "I should try". Move the check upstream.
- **Effort:** ~50 LOC linter helper + tests + a Steward SOUL "if linter rejects, fix the body before retrying create" bullet for the prose-edge cases.
- **Replaces:** revision-1 PR-L (worker-side carve-out clarification) and PR-A enforcement.

### P1 — close the run-6 stall failure modes

#### 10.N — `kanban retry` policy: same task + same failure signature → block

- **Surface:** `scripts/kanban retry` Python (preferred — code-level policy). Fallback if too large: Steward SOUL rule.
- **Rule:** track `(task_id, failure_code, failure_signature_hash)` per retry. If a retry would repeat the prior `(failure_code, signature)`, refuse with an error message naming the prior attempt unless `--force` or `--changed-hypothesis "<text>"`. Steward MUST cite what's different.
- **Why code-level:** revision-1 noted that prose retry discipline can fail under pressure just like `stash-coord` did. Pattern G (4 identical "fresh spawn" retries on `t_1d175784`) is exactly that failure mode.
- **Effort:** ~30 LOC Python + 2 tests (refuse on identical, allow on changed hypothesis).
- **SOUL companion:** one short Steward bullet pointing at the new error — minimal prose.

#### 10.S — runtime fires `AUTO_STUCK` event on identical `recent[]` for N rounds

- **Surface:** the per-round progress emitter — wherever `recent[]` is computed (likely `bot/lib/runtime/...` or the landfolk agent loop). When the bot's recent-action tuple AND position are identical for N=4 rounds, emit a `kanban_comment` on the active card with a structured payload `{auto_stuck: {rounds, position, recent_tuple}}`.
- **Why:** revision-1's R2 (whisper-into-prompt) is the right diagnosis but it's upstream-Hermes-shaped. Cheaper: skip the diagnosis and emit the symptom as a board comment. Steward already polls `kanban_comments` per cycle, so a comment is a durable signal her decision loop reads — chat isn't.
- **Effort:** ~30 LOC in the progress emitter + 1 unit test.
- **Pair with:** 10.T (below) so Steward acts on the comment by reclaim/reassign rather than another whisper.

#### 10.T — Steward rescue = `kanban_comment + reclaim/reassign`, not chat

- **Surface:** `prompts/landfolk/steward.md` PHYSICALLY_STUCK action row (line ~305) + the existing PR-F terrain-interpretation section.
- **Rule:** the canonical PHYSICALLY_STUCK action is `kanban_comment "<diagnosis + suggested next action>" + (kanban reclaim OR kanban_reassign)`. `mc chat` whisper is OPTIONAL narration for human-watchable runs only; the worker's durable input is the card body + comments.
- **Why:** revision-1 noted Steward's whispers don't enter the worker decision loop. Make rescue use the channel that does. Pairs cleanly with 10.S (auto_stuck) as the trigger signal.
- **Effort:** prose-only, ~10 lines.

### P1.5 — drop AUTO_REUSE; replace PR-M

#### 10.U — fresh-world bootstrap for run-7

- **Action:** before run-7, switch the bootstrap to a clean world.
- **Path 1 (preferred):** debug the `AUTO_REUSE=0 MATERIALIZE=1` rcon-ssh hang from Phase 8 (5-6 min wait on round-trip). Likely a timeout config, not a protocol issue.
- **Path 2 (fallback):** add a `scripts/reset-proc-lab.sh` that does `mvworld delete proc-lab && mvworld create proc-lab normal -s 1001` via rcon, then runs the normal bootstrap.
- **Why:** revision 2 promotes this from P1.5 to "default". Run-5+run-6 residuals (Z=54 oak_door, Z=62 cobble shelter) are larger noise than apples-to-apples is worth. Cross-run analyzer deltas across different worlds are noisier but the noise is in the world, not the agents — which is what we're trying to measure.
- **Replaces:** revision-1 PR-M (residual cleanup). Don't build hazard-mapping infrastructure for a baseline we're abandoning.

### P2 — cheap diagnostic to inform next phase

#### 10.V — analyzer move-error split by axis

- **Surface:** `scripts/analyze-worker-trace.py` — add `--split-move` flag that buckets `move:error` invocations by:
  - target distance from caller (≤8, 9-24, 25-64, >64 blocks)
  - repeated-target count (same target ≥3× = "stuck-on-target")
  - door-adjacency (target within 3 blocks of a known door coord)
  - flat-axis vs vertical (mostly horizontal vs Y-changing)
- **Why:** run-6 `move` errors +27 vs run-4 while total errors -31 is confusing without normalization. Revision 1 deferred `#41` ("long-range flat-ground give-up"); this split tells us whether it's one bug or several primitive-selection failures, cheaply, before we invest deeper.
- **Effort:** ~50 LOC analyzer + 1 test.
- **Output:** consumed by the run-7 postmortem; informs whether `#41` promotes to a Phase 11 P0.

### Deferred from revision 1 (now gated post-run-7)

| Item | Was | Now | Why |
|---|---|---|---|
| PR-M residual cleanup | P1 | Deferred behind 10.U | If fresh-world ships, PR-M is unnecessary infrastructure |
| Bench D (residual cleanup test) | run-7 entry | Mooted by 10.U | Same |
| Bench E (Flint stuck-simulate) | P2 | Only if 10.P route is taken | 10.S + 10.T close the stuck-and-reassign loop without needing a behavioral bench |
| PR-P.1 whisper-into-prompt | P2 | Deferred indefinitely | 10.S + 10.T solve it via comments without upstream Hermes change |
| PR-G escape 1-block | Watch | Watch | Tests pass; not exercised in run-6; revisit if run-7 hits a depression |
| PR-O protocol_violation auto-detect | P3 | P3 (unchanged) | Still upstream Hermes |
| R3 deep crash RCA | Pre-flight | Conditional | First: classify exit 142 from existing logs. Only instrument deeper if run-7 reproduces on a clean world with a verb-first card. |
| R5 residual hazard map | Pre-flight | Mooted by 10.U | Don't map a baseline we're dropping |

## RCAs — what to learn alongside (not gate) Phase 10

Revision 1 made RCAs into pre-flight gates. Revision 2 treats them as **questions to answer in parallel with the work**, with one explicit gate moved post-fix.

| RCA | When | Notes |
|---|---|---|
| **R1 Flint pathfinder substrate** | Post-10.J | After terrain renders, re-run Bench A (single Flint at (14,102,8), capture nav-brief, try goto NE). If routes still fail, `#41` promotes to Phase 11 P0. |
| **R2 worker decision loop** | Skipped if 10.S+10.T land | Comment-based rescue makes the whisper-in-prompt question moot. If 10.S+10.T don't solve stuck cycles in run-7, R2 comes back as a Phase 11 input. |
| **R3 Gatherer crash mechanism** | Conditional | First: classify exit 142 from existing `agent-gatherer.log` (one grep + a tabular write-up, ~10 min). Only deeper if it recurs on fresh-world. |
| **R4 PR-D wiring trace** | Covered by 10.K Bench B | The side-effect test IS the wiring trace. |
| **R5 world hazard map** | Mooted by 10.U | Drop. |
| **R6 PR-A hot-path test** | Replaced by 10.R linter test | The linter test asserts CONSTRUCT bodies have a verb line; that's the structural answer. |
| **R7 analyzer methodology** | Folds into 10.V | The move-error split forces a per-card normalization; methodology note rides with PR-V. |

## Focused testing — what stays, what gets cut

Revision 1 proposed 5 bench scenarios. Revision 2 cuts the agent-behavior ones (LLM-dependent, slow, noisy) and keeps the deterministic ones.

### Keep (deterministic, fast)

- **Bench A — terrain renderer** (10.J). Static synthetic-pose unit test. <60s wallclock. Lives in `bot/test/runtime/nav-brief-render.test.js`.
- **Bench B — `wb context` side-effect** (10.K). Integration test: set `$HERMES_HOME=/tmp/test-home`, run `wb context` against a stub kanban DB with a verb-first card body, assert the stash file appears and `mc mark "base_foundation"` reads it for drift detection. Pure subprocess + fs, no LLM. ~30s.
- **Bench L — card body linter** (10.R). Pure parser test: feed it 6-8 card bodies (verb-first CONSTRUCT pass, prose CONSTRUCT fail, prose EXPLORE pass via kind-exemption, multi-coord SURVEY fail, etc.). No LLM. <10s.
- **Bench R — retry policy** (10.N). `scripts/kanban retry` test: call twice with same `--reason`, assert second fails with linter message; call with different `--changed-hypothesis`, assert succeeds. Pure subprocess. <30s.

### Cut (LLM-dependent, slow, noisy)

- ~~Bench C — agent escalates prose card.~~ The agent's escalation behavior is variable and not directly Phase 10's concern; 10.R (linter at dispatch) makes it moot because workers never see the bad cards. The static-prompt-shape test replaces it.
- ~~Bench D — residual cleanup.~~ Mooted by 10.U fresh-world.
- ~~Bench E — Flint stuck-simulate.~~ Mooted by 10.S+10.T (comment-based stuck signal + reclaim).

### Pre-replay integration smoke (new)

- **Clean-world bootstrap smoke** (10.U). After 10.U lands: run `bash scripts/establish-scenario.sh` end-to-end against a freshly-reset proc-lab; verify all 4 bots come up on Surface; stop immediately. ~3-5 min wallclock. Doesn't replace run-7; it just confirms the bootstrap path isn't broken before we burn 60-90 min.

### Run-7 — full replay (integration test)

Stays as Phase 10's final validation. Entry criteria below. Expect ~60-90 min wallclock, ~half-day analysis.

## Run-7 entry criteria — tightened

Don't burn another 60-90 min replay until ALL of:

- [ ] **Bench A green** — `terrain=flat` appears in nav-brief render.
- [ ] **Bench B green** — `wb context` writes `task-body-coord.json`; `mc mark` drift warning fires.
- [ ] **Bench L green** — linter rejects prose CONSTRUCT/SURVEY, accepts verb-first.
- [ ] **Bench R green** — `kanban retry` refuses identical-reason retry.
- [ ] **Clean-world bootstrap smoke** green — fresh proc-lab → 4 bots on Surface → stop.
- [ ] Phase 10 PRs J, K, R, N, S, T, U committed.

Optional but recommended before run-7:
- [ ] 10.V move-error split tooling ready (for run-7 postmortem).
- [ ] R3 exit-142 classification (one-pager, ~10 min).

Note vs revision 1: no RCA pre-flight gates. Bench D + E cut entirely.

## Run-7 predicates (what we measure)

| Predicate | Target | Source |
|---|---|---|
| `terrain=` appears in worker nav_header at spawn | ≥1 hit per bot per 5 rounds | 10.J |
| `task-body-coord.json` exists for ≥1 verb-first CONSTRUCT/SURVEY card | ≥1 file | 10.K side effect |
| Linter rejected zero cards (i.e. Steward writes verb-first by default after PR-A) | 0 rejections per epic | 10.R |
| Steward identical-reason retries | 0 | 10.N |
| `AUTO_STUCK` events on identical-recent[] workers | observed when applicable | 10.S |
| Stuck workers reclaimed/reassigned within 2 cycles | observed | 10.T |
| Fresh-world re-tps to spawn | 0 underground re-tps | 10.U + PR-H carryover |
| Verb-first body on first CONSTRUCT/SUPPLY emitted | 100% (was preventively held in run-6) | PR-A + 10.R |
| Pad + walls reached | epic-level progression | composite |

## Phase 10 execution order

```
parallel:  10.J  (renderer always emit terrain) ─→ Bench A ──┐
           10.K  (wb context side-effect stash) ─→ Bench B   │
           10.R  (dispatch linter)              ─→ Bench L   ├─→ all green = unblock
           10.N  (retry policy)                 ─→ Bench R   │      run-7 entry
           10.S  (AUTO_STUCK event)             ─→ unit test │
           10.T  (rescue via comment)           ─→ prose     │
           10.U  (fresh-world bootstrap)        ─→ smoke   ──┘
           10.V  (analyzer move-error split)    ─→ unit test    (optional pre-run-7)
parallel diagnostics:  R1 post-10.J,  R3 exit-142 grep
run-7  (full replay against Phase 10 predicates)
```

All 7 P0/P1 PRs (J, K, R, N, S, T, U) are independent; ship in any order. 10.V is optional pre-run-7 but needed for the postmortem. RCAs run in background.

## Out of scope for Phase 10

- **PR-G escape 1-block** — Watch. Hermetic tests pass; not exercised in run-6; revisit if run-7 hits a depression.
- **PR-O protocol_violation auto-detect** — upstream Hermes, P3.
- **`#41` long-range pathfinder give-up** — promotes only if R1 (post-10.J validation) confirms Flint still can't path with `terrain=flat` visible.
- **`mc collect` 40s cap** — no Phase 9 evidence; revisit if run-7 surfaces.
- **Chest-behind-door / `through` stall** — deferred unless 10.V analyzer split shows it's a coord-set issue (cleanable) vs a behavioral issue (deeper).

## References

- Run-6 postmortem set: [`data/postmortems/establish-2026-06-03-phase9/`](../../../data/postmortems/establish-2026-06-03-phase9/)
- Run-5 baseline: [`data/postmortems/establish-2026-06-03-phase8/THOROUGH-POSTMORTEM.md`](../../../data/postmortems/establish-2026-06-03-phase8/THOROUGH-POSTMORTEM.md)
- Run-4 baseline: [`data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md`](../../../data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md)
- Phase 9 plan: `~/.claude/plans/investigate-the-open-points-wondrous-karp.md`
- Rolling phase doc: [`planning-tracker.md`](../procedural/planning-tracker.md) — append Phase 10 stub once this stabilizes
