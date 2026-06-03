# Phase 10 — focused fixes, focused tests, fresh world

**Status:** draft, pending review.
**Inputs:** [`data/postmortems/establish-2026-06-03-phase9/THOROUGH-POSTMORTEM.md`](../../data/postmortems/establish-2026-06-03-phase9/THOROUGH-POSTMORTEM.md) + per-bot postmortems + second-opinion review (2026-06-03).
**Prior phase:** [`procedural-planning.md`](procedural-planning.md) Phase 9 (commit `61692ad`).

## Why Phase 10

Run-6 (phase9) ran ~60 min and stalled — no pad built, Flint immobile ~70 min, Gatherer crash-looped on `t_1d175784`. As a **product test** it failed (vs run-5's first-ever pad close). As an **experiment** it proved two things:

1. **The `nav-brief` renderer's "skip flat" decision is actively harmful** — Flint narrated *"I'm at Y=96 which is underground in this world"* on the freshly-cleaned PR-H spawn floor. PR-E classifier returned `flat` correctly; renderer hid it; Flint defaulted to raw-Y inference and looped pillar-up attempts for 70 minutes.
2. **Prose-SOUL alone can't drive tooling adoption.** `wb stash-coord` got 0/4 invocations despite explicit bullets in three worker SOULs. PR-D is dormant by design, not by accident.

Phase 10 ships those two fixes mechanically, closes the remaining open RCAs, and **shifts the validation surface from 60-90 min full establish replays to short bench scenarios that test one PR at a time**. Replays remain the eventual integration test, but only after the unit-level claims are nailed down.

## Open RCAs to close before Phase 10 ships

These are the gaps the second opinion called out that the postmortem named but didn't fully resolve. Each one needs a one-paragraph trace before its corresponding PR can land safely.

| RCA | What's still unknown | Closure approach |
|---|---|---|
| **R1 Flint pathfinder substrate** | Why does pathfinder fail flat-grass routes from (14,102,8) to NE waypoints? `#41 long-range flat-ground give-up` is separate from terrain labels and may be the real nav substrate. | Replay the same coords in a 5-min bench scenario with one Flint bot, captured nav-brief dumps, after PR-J ships. If routes still fail with `terrain=flat` visible, R1 is independent of Pattern E and #41 moves up to P0. |
| **R2 Worker decision loop** | 286 `mc` calls on `t_7265d6b1` vs 42 rounds of identical `recent[]` tuples — does the worker re-read the card after a Steward whisper, or does whisper land outside the decision loop entirely? | Merge agent-flint / progress-flint / `t_7265d6b1.log` timelines into a single ASCII timeline before Phase 10 ships. If whispers don't enter the worker's prompt, PR-P (whisper-into-prompt) becomes mandatory; otherwise it's P2. |
| **R3 Gatherer crash mechanism** | Exit code 142 + `pid not alive` — was it OOM, hermes wallclock timeout, unhandled exception, or bot disconnect? Logs cite symptoms only. | Repro by claim-pinning `t_1d175784`-shape prose card to a single Gatherer bot in the bench, attach `strace`/`py-spy`/hermes verbose logging. ~30 min RCA. |
| **R4 PR-D wiring trace** | Path from worker home → `wb stash-coord` → `$HERMES_HOME/task-body-coord.json` → `marks.js readCardBodyCoord` — verified in unit tests but never validated end-to-end. | Single bench: launch one bot, claim a CONSTRUCT-shaped card, observe stash file appears, place a structure mark 5 blocks off, assert warning in response. ~10 min. |
| **R5 World hazard map** | PR-H rect missed Z=54 oak_door (16 hits) and Z=62 cobble shelter (3 crashes). What other coords are residual hazards? | Run the analyzer's `pillar_up` + `through` + `move:error` coords against `data/postmortems/establish-2026-06-03-phase{7,8,9}/` aggregate. Produce `data/runtime/residual-hazards.json` keyed by coord → hit count. PR-M consumes it. |
| **R6 PR-A hot-path test** | 0 CONSTRUCT cards in run-6 means the verb-first SOUL was preventive, not exercised. We don't know if Steward would write `mc fill ...` on line 1 when the time comes. | Bench: force Steward to a state where she should emit a CONSTRUCT (mock world has 4 candidates marked, base_anchor selected, cobble stockpiled). Capture her card body shape. ~20 min. |
| **R7 Metrics methodology** | "errors −13% vs run-4" while `move` errors +27 is confusing without normalization. | One-paragraph methodology note in `analyze-worker-trace.py` docstring: report **error rate per invocation**, not total counts, when card mix differs. ~5 min. |

R4, R5, R7 can land alongside their PRs. R1, R2, R3 are diagnostic — they should close BEFORE the related PR (J, P, M) ships so we don't paper over a deeper issue.

## Phase 10 PRs — ranked by run-6 evidence weight

### P0 — must ship before any further full replay

#### 10.J — `nav-brief` renderer always emits `terrain.kind`

- **Surface:** `bot/lib/runtime/nav-brief.js:629-632` (the `renderNavBrief` block introduced in Phase 9 PR-E).
- **Change:** drop the `terrain.kind !== 'flat' && terrain.kind !== 'unknown'` guard. Emit whenever `terrain.kind` is set; let SOUL decide what's noise.
- **Evidence:** `agent-flint.log:432` smoking-gun quote; Mason ×30 Pattern E recurrences; Steward 1/115 `terrain=` conversion (0.87%).
- **Effort:** ~5 LOC code + 1 nav-brief render test asserting `terrain=flat` appears on a flat-pose fixture.
- **Verification:** see **Bench A** below — 1-min smoke test before any replay.

#### 10.K — auto-invoke `wb stash-coord` on claim (skill hook, not SOUL)

- **Surface:** `skills/kanban-worker.md` (or the existing post-claim hook that runs `wb context` for orient). Add a mechanical call: after `wb context`, run `wb stash-coord` if card kind is in `{CONSTRUCT, MINE, TILL, SUPPLY, SURVEY}`.
- **Why mechanical:** PR-D prose-SOUL got 0/4 adoption. Tooling invocation isn't a judgment call; make it deterministic.
- **Effort:** ~10 lines of skill prose + a kanban-worker integration test asserting `$HERMES_HOME/task-body-coord.json` exists after a synthetic claim event with a verb-first body.
- **Verification:** **Bench B** below.
- **Depends on:** R4 RCA closed (file wiring trace).

### P1 — close the run-6 stall failure modes

#### 10.L — PR-B carve-out: SURVEY + multi-coord SCOUT count as verb-required

- **Surface:** `prompts/landfolk/mason.md:25-32`, `flint.md` equivalent, `gatherer-test.md` equivalent (the Phase 9 prose-escalate sections).
- **Rule:** explicit "SURVEY cards and SCOUT cards with ≥3 coord targets MUST contain at least one literal `mc <verb>` line — escalate `prose_card_no_verb` if missing".
- **Evidence:** Mason's SURVEY abandonment (2 of 5 sites in 14 min); Gatherer's `t_1d175784` crash loop on prose verify-resources.
- **Effort:** prose, ~3 files × ~5 lines.
- **Verification:** **Bench C** below + run-7 predicate.

#### 10.M — widen spawn cleanup OR Steward residual-hazard cleanup card

Two viable shapes, pick after R5 RCA produces the hazard map:

- **10.M.1 (preferred if hazard map is small)** — widen `scripts/establish-rcon-prep.py` rect to cover Z=54 and Z=62 residuals. Currently X[-8..16] × Z[12..36]; bump to X[-16..24] × Z[-4..68] to cover both observed traps. Keep the 1-block grass layer minimal; add scripted per-coord `setblock air` for known structure blocks from R5.
- **10.M.2 (if hazard map is large)** — Steward SOUL gains a "world prep" pre-EXPLORE step: read `data/runtime/residual-hazards.json`, emit one `[CLEANUP]` card per cluster before opening the EXPLORE phase. Workers run `mc dig_area` over the hazard rect.
- **Evidence:** 16× oak_door at (16,102,54); 3 Gatherer crashes at (13,101,62).
- **Effort:** 10.M.1 = ~10 LOC Python; 10.M.2 = ~half-day prose+SOUL test cycle.
- **Verification:** see "fresh-world transition" below — 10.M is mooted if we drop AUTO_REUSE entirely. If we don't, **Bench D** validates.

### P2 — orchestration hygiene

#### 10.N — Steward `kanban retry` must change hypothesis

- **Surface:** `prompts/landfolk/steward.md` retry section (find via grep for `kanban retry`).
- **Rule:** block retry unless one of {card body changed, target coord changed, diagnosis hypothesis changed} since the prior attempt. Identical-reason retries return an error from the SOUL's perspective ("you already tried this — diagnose differently").
- **Evidence:** New Pattern G in phase9 — Steward retried `t_1d175784` 4× with identical "fresh spawn" reason after identical `pid not alive` cause.
- **Effort:** prose, ~10 lines.
- **Verification:** SOUL-only; observe in run-7 by counting distinct reason hashes per task_id in `task_events.payload`.

#### 10.P — Flint whisper-into-prompt OR after-N-identical-rounds reassign

- **Surface:** depends on R2 RCA. Two shapes:
  - **10.P.1** — inject Steward chat as a system prompt fragment on next worker round when the worker has been stuck (identical `recent[]` for ≥3 rounds). Hermes runtime change.
  - **10.P.2** — Steward SOUL: after observing N=5 rounds with identical `recent[]` tuples and zero position delta, block-and-reassign the card rather than whisper again.
- **Evidence:** Flint frozen at (14.5, 102, 7.6) for 70 min despite 3+ rescue whispers. `recent[]` field identical for 42 consecutive rounds.
- **Effort:** 10.P.1 = upstream Hermes (deferrable); 10.P.2 = prose-only.
- **Verification:** run-7 with Flint stuck-simulating test (Bench E) confirms reassign fires.

### P3 — deferred / upstream-blocked

#### 10.O — Flint protocol_violation auto-archive (carries from Phase 8.8)

Still upstream Hermes. EXPLORE one-shots vanish without `kanban_complete` on worker clean exit. Tracked, not in Phase 10 scope.

#### 10.Q — `mc collect` 40s wallclock cap

Run-6 Gatherer had 0 collect invocations (didn't reach wood gathering). Not phase10 evidence; revisit if run-7 surfaces it.

## Focused testing strategy — bench scenarios over full replays

**The shift.** Phase 5 → 9 used full establishment.explore replays (~60-90 min wallclock + ~half day analysis) as the primary validation surface. That's expensive and noisy. Phase 10 fixes hypothesis-level claims with **5-30 min bench scenarios**, each pinned to one PR. Full replays return as the **integration test**, run once at Phase 10 close.

### Bench A — terrain renderer (10.J)

```
Setup: 1 bot, spawn at (0,64,0) on a flat 5x5 grass pad. No other state.
Test: HTTP /status, capture nav_header text.
Assert: text contains "terrain=flat (feet_vs_local_ground=0)".
Wallclock: <60s. Repeats: cheap.
```

Surface: extend `bot/test/runtime/nav-brief-render.test.js` with a synthetic flat-pose fixture. Doesn't even need a live world.

### Bench B — stash-coord wiring (10.K)

```
Setup: 1 bot, $HERMES_HOME=/tmp/test-home, no task-body-coord.json yet.
Action: simulate worker post-claim hook with a verb-first body
        ("mc fill cobblestone 0 64 0 8 64 8").
Assert: /tmp/test-home/task-body-coord.json exists,
        contains {"coord": {"x": 4, "y": 64, "z": 4}} (box center).
Then: bot places mark "base_foundation" at (10,64,10).
Assert: response observed_state.warnings contains MARK_COORD_VS_CARD_DRIFT
        with distance ≈ 8.5.
Wallclock: ~5 min.
```

This is the end-to-end PR-D + PR-K test that closes R4.

### Bench C — prose-card escalate (10.L)

```
Setup: 1 bot, claim a synthetic [SURVEY] card with prose body only
       (no mc verb lines, 3 candidate coords).
Assert: bot calls wb escalate "prose_card_no_verb" within first 5 mc invocations.
       Board shows blocked event with [!ESCALATED] prefix.
Wallclock: ~5 min.
```

### Bench D — residual-hazard cleanup (10.M)

```
Setup: world with two scripted residual structures (oak_door at known coord, sealed shelter at known coord).
Run: rcon prep + spawn → observe hazard coords cleared.
OR
Run: Steward boots, observes hazard.json, emits CLEANUP card; Mason runs it.
Wallclock: ~15-30 min.
```

Skip if we go fresh-world per below.

### Bench E — Flint stuck-simulating (10.P)

```
Setup: 1 Flint bot pinned at (14, 102, 8) with NE SCOUT card; mock pathfinder always returns "no path".
Action: progress 6 rounds with identical recent[].
Assert: Steward SOUL fires reassign/block, not whisper.
       (10.P.2 only — 10.P.1 requires hermes change.)
Wallclock: ~10 min.
```

### Phase 10 integration test — run-7 (full replay)

Run only after all benches green. Predicates carry from run-6 + add Phase 10 PR-specific:

| Predicate | Target | Source |
|---|---|---|
| `terrain=` appears in agent logs at spawn | ≥1 hit per bot per 5 rounds | 10.J |
| `task-body-coord.json` exists for ≥1 CONSTRUCT/SURVEY card | ≥1 file | 10.K |
| `wb escalate "prose_card_no_verb"` fires on first prose CONSTRUCT/SURVEY | ≥1 fire | 10.L |
| Steward identical-reason retries | 0 | 10.N |
| Verb-first body on first CONSTRUCT/SUPPLY card | ≥80% | PR-A carryover (now hot-path) |
| Flint stall-and-reassign | reassign within 6 rounds of frozen `recent[]` | 10.P.2 |
| Pad + walls reached | epic-level progression | composite |

## Fresh-world transition — drop AUTO_REUSE=1 for run-7

Run-5 and run-6 both ran `AUTO_REUSE=1` to keep apples-to-apples baseline. That's worn out:

- Run-5 left residuals at Z=54 (oak_door) and Z=62 (cobble shelter) that contaminated run-6 — Gatherer crash-looped on the Z=62 trap; Flint+Mason burned cycles on the Z=54 door.
- Each replay adds residuals (dirt pillars, partial pads, scattered fences). Three replays in, the world is a debugging hazard, not a clean test bed.
- PR-H spawn cleanup is patching a problem that wouldn't exist on a fresh disc.

**Action:** before run-7, switch the bootstrap to a clean world. Two paths:

1. **`AUTO_REUSE=0 MATERIALIZE=1`** (the original plan) — generates a fresh proc-lab disc via `mapcatalog try`. **Blocker:** the rcon ssh hang at 5-6 min during Phase 8 prep. Re-investigate; the fix may be timeout-related, not protocol-related.
2. **Manual proc-lab reset** — `mvworld delete proc-lab && mvworld create proc-lab normal -s 1001` via rcon, then run normal bootstrap. Coarser but reliable.

Either way, **the baseline for run-7 is a clean world with no run-5/6 residuals**. PR-M (residual cleanup) becomes optional if we adopt this — it's only needed when we choose to reuse.

The trade-off: cross-run analyzer deltas become noisier because the worlds differ in micro-terrain. We accept that — Phase 9's evidence shows world contamination is the larger source of noise.

## Phase 10 execution order

```
parallel:  RCA R1 (Flint substrate)     ┐
           RCA R2 (worker decision loop) │  ← diagnostic, before code lands
           RCA R4 (PR-D wiring)          │
           RCA R5 (residual hazard map)  ┘
PR-10.J   (renderer always emits terrain) ─→ Bench A → can land before replays
PR-10.K   (auto wb stash-coord on claim)  ─→ Bench B → can land before replays
PR-10.L   (PR-B carve-out clarification)  ─→ Bench C
PR-10.N   (Steward retry-reason validation) — prose, no bench
PR-10.P.2 (Steward stuck-and-reassign SOUL) ─→ Bench E (needs R2 closed first)
Fresh-world transition (drop AUTO_REUSE=1) — operator step
run-7      (full replay against Phase 10 predicates)
PR-10.M    (residual cleanup) — only if fresh-world transition slips
```

P0 (J, K) blocks all other work — if those don't validate, the rest is noise. P1 (L, M) are independent of each other and of J/K once the surfaces are clean. P2/3 (N, P, O, Q) are observability/SOUL improvements that ride along.

## Run-7 entry criteria

Don't burn another 60-90 min replay until ALL of:

- [ ] Bench A green: `terrain=flat` appears in nav_header on a spawn fixture.
- [ ] Bench B green: `task-body-coord.json` written + drift warning fires.
- [ ] Bench C green: prose SURVEY → `wb escalate` fires.
- [ ] R1, R2, R4, R5 RCAs each closed with a one-paragraph note (or explicit defer with reason).
- [ ] Fresh-world bootstrap path validated end-to-end (`AUTO_REUSE=0 MATERIALIZE=1` or manual reset).
- [ ] Phase 10 PRs J, K, L, N committed.

Optional but recommended before run-7:
- [ ] Bench D or E green (depending on M / P route).
- [ ] Analyzer methodology note (R7) merged.

## Out of scope for Phase 10

- **`mc collect` 40s cap** (R-Q) — no phase9 evidence; revisit if run-7 surfaces.
- **Chest-behind-door / `through` stall** — Pattern D recurrence; deferred unless R5 hazard map shows it's a cleanup-able coord-set rather than a behavioral issue.
- **`#41` long-range pathfinder give-up** — moves up to P0 only if Bench A shows terrain=flat visible but Flint still can't path. Otherwise stays deferred.
- **PR-G escape 1-block** — Phase 9 not exercised; tests pass; defer revisit until a 1-block depression appears in run-7.

## References

- Run-6 postmortem set: [`data/postmortems/establish-2026-06-03-phase9/`](../../data/postmortems/establish-2026-06-03-phase9/) — THOROUGH-POSTMORTEM + 4 per-bot files + analyzer delta + kanban dump
- Run-5 baseline: [`data/postmortems/establish-2026-06-03-phase8/THOROUGH-POSTMORTEM.md`](../../data/postmortems/establish-2026-06-03-phase8/THOROUGH-POSTMORTEM.md)
- Run-4 baseline: [`data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md`](../../data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md)
- Phase 9 plan: `~/.claude/plans/investigate-the-open-points-wondrous-karp.md`
- Rolling phase doc: [`procedural-planning.md`](procedural-planning.md) — append Phase 10 stub once this plan stabilizes
