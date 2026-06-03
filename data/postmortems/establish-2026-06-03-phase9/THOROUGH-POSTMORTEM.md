# Phase 9 establish-base run-6 — Thorough Postmortem

**Window:** 2026-06-03 08:59–09:58 local (~60 min, stopped at stall not completion). Bots: Steward, Gatherer, Flint, Mason. Map: establish.explore seed=1001, world reused from run-5 (`AUTO_REUSE=1`) for apples-to-apples comparison. Phase 9 commit `61692ad`.

**Phase 9 changes under test:**
- **PR-A** Steward verb-first decomposition SOUL (prompts/landfolk/steward.md)
- **PR-B** Worker prose-card escalate (mason/flint/gatherer-test.md)
- **PR-C** `goto_near` 8s → 15s wallclock cap (bot/lib/actions/_helpers.js)
- **PR-D** `MARK_COORD_VS_CARD_DRIFT` + `wb stash-coord` (bot/lib/actions/marks.js, scripts/wb)
- **PR-E** `terrain_kind` + `feet_vs_local_ground` classifier + nav-brief surfacing
- **PR-F** Steward terrain_kind interpretation SOUL
- **PR-G** `mc escape` 1-block depression precedence
- **PR-H** Spawn-area cleanup in rcon prep
- **PR-I** Analyzer `--compare-with` delta mode

## Headline

Run-6 produced **no pad completion** (vs run-5's first-ever pad close) but surfaced the dispositive Phase 10 evidence: **the PR-E renderer's "skip flat" decision is wrong**, and **PR-D's prose-SOUL-only adoption strategy fails completely**. Both of these will be Phase 10's first PRs. Net Phase 9 PR scorecard: **2 strong wins (PR-H, PR-C), 1 working-as-designed prevention (PR-A), 1 partial win (PR-F), 4 dormant/failed surfaces (PR-B, D, E-renderer, G).** The 60-min stall — Flint immobile 70 min, Gatherer crash loop on verify-resources, no CONSTRUCT emerged — produced richer Phase 10 evidence than another successful pad would have.

## Predicate scorecard

| Predicate | Status | Evidence |
|---|---|---|
| **7.0** orchestrator-tracker (0 Steward worker sessions) | ✓ **HELD** | `ls ~/.hermes/profiles/steward/sessions/*.json` empty. 6+ hours cumulative stable now. |
| **PR-A** Steward emits no premature prose CONSTRUCT | ✓ **HELD (preventive)** | 0 CONSTRUCT cards in 60 min. She properly issued 4 SCOUT + 1 SURVEY + 1 verify-resources. Run-5's prose-CONSTRUCT regression did NOT recur. UNTESTED on the hot path because no CONSTRUCT was reached. |
| **PR-B** Workers escalate prose CONSTRUCT/SUPPLY | **DORMANT (carve-out gap)** | 0 invocations fleet-wide. Mason's SURVEY card was prose-only with no `mc <verb>` line but PR-B's exemption list (EXPLORE/SCOUT) didn't cover SURVEY → ambiguous → she didn't escalate. Gatherer's verify-resources card was prose-only with 3 coord targets → also not escalated. |
| **PR-C** `goto_near` 15s cap reduces exhaustions | ✓ **FIRED-WORKING** | Gatherer: **1× 15s exhaustion in run-6 vs 6× 8s exhaustions in run-5**. Direct causal mitigation of the wallclock cap that preceded run-5's iteration_budget_exhausted. Single most effective Phase 9 change for Gatherer per her postmortem. |
| **PR-D** structure-mark drift detection | **DORMANT (adoption failure)** | 0 `wb stash-coord` invocations fleet-wide. 0 stash files exist. Prose-SOUL guidance for a tooling invocation didn't penetrate worker behavior. |
| **PR-E** `terrain_kind` classifier correct | ✓ **WORKS (classifier)** | 18 hermetic tests pass including 3 run-5 regression cases. |
| **PR-E** `terrain_kind` reaches the agent | ✗ **FAILED (renderer)** | Steward's agent log shows `grep -c "terrain=" = 1` against 115 perception calls (0.87% conversion). Renderer skip-flat/skip-unknown branch is the gap. **Dispositive evidence**: Flint narrated *"Actually, I'm at Y=96 which is underground in this world. The surface is Y=100-105. Let me pillar up."* at `agent-flint.log:432` — standing on the freshly-cleaned PR-H spawn floor. classifier would have returned `kind=flat`, renderer hid it, Flint defaulted to raw-Y inference. Mason hit Pattern E 30 times for the same reason. |
| **PR-F** Steward terrain-aware whispers | **PARTIAL** | 9 absolute "pillar_up to 105/106" whispers in rounds 5-7 vs 1 relative-axis rescue (`dig_area 5 5 5 → mc move 100 102 100`) in round 13. The switch was **failure-reactive** (Flint's 30-min stall forced it), not driven by reading terrain.kind. |
| **PR-G** escape 1-block precedence | **NOT EXERCISED** | No 1-block depressions encountered. Hermetic tests pass. |
| **PR-H** spawn-area cleanup | ✓ **FIRED-WORKING (but undersized)** | **Zero underground re-tps in run-6 vs 2 in run-5**. PR-H rect (X[-8..16] × Z[12..36]) cleared the immediate spawn but missed residual run-5 structures at Z=54 (oak_door tar-pit, 16 run-6 hits) and Z=62 (Gatherer's verify-resources crash trap at the cobblestone shelter (13,101,62)). |
| **PR-I** analyzer `--compare-with` delta | ✓ **WORKS** | Run-6 vs run-4 delta produced rich verb-level shifts (see deltas below). |

## Per-bot summaries

- **[Steward](steward.md)** (933 words) — 15 orchestrator rounds (vs run-5's 24, shorter runtime). 0 worker sessions. **PR-A SOUL prevented premature CONSTRUCT** (refusal hook on missing `base_anchor` — never reached, so verb-first body shape went untested on the hot path). PR-F partial: 9 absolute-Y whispers → 1 relative rescue, the switch driven by Flint's stall not by reading labels. **New Pattern G — phantom-retry-on-stuck-worker**: she retried `t_1d175784` with identical "fresh spawn" reason after 2 prior `pid not alive` crashes; 4th crash followed immediately.

- **[Mason](mason.md)** (1164 words) — 3 cards: EXPLORE NW done (14 min), SCOUT NW done (19 min, 3 candidate marks), SURVEY claimed and abandoned at 2 of 5 sites. **Peak 99.3% / 31.1 done/min at round 27** during SCOUT terrain-probing burst. The SURVEY card body was prose-only (sqlite-verified, no `mc <verb>` line); Mason did NOT escalate because the PR-B carve-out language ambiguously exempted EXPLORE/SCOUT but left SURVEY unclear. **30 Pattern E hits** on flat NW grassland (PR-E renderer gap). Steward whispered the canonical fix; Mason re-fell into caves at log line 1260 anyway. 0 `wb stash-coord` invocations.

- **[Flint](flint.md)** (1572 words) — **the dispositive failure case.** Pattern E smoking-gun quote at `agent-flint.log:432`. Two cards: NE EXPLORE archived after protocol_violation at 09:10 (0 `kanban_complete` calls — same auto-archive shape as run-5 `t_a8650983`), NE SCOUT reclaimed 4× with the worker process exiting without proper close each time. Position frozen at ~(14.5, 102.0, 7.6) for ~70 min of total runtime. `recent[]` field stuck at identical 4-tuple `["inspect:done","move:done","pillar_step:done","move:error"]` for 42 consecutive rounds (10–51) — proof of total immobility. 286 mc invocations on her SCOUT card, of which 60 `mc move` + 14 `mc status` + 5 `mc pillar_up` cycled in a closed loop she couldn't break.

- **[Gatherer](gatherer.md)** (1181 words) — most productive worker after Mason early. 4 cards completed (2 EXPLORE + 2 SCOUT), 5th `t_1d175784 [SCOUT] Verify resource availability` produced **3 crashes** (`pid not alive`) plus a 4th reclaim at fleet stop. Crash trap: residual run-5 cobblestone shelter at (13, 101, 62) — Z=62 is **outside PR-H's Z=12-36 rect**. Burned the entire 5-min hermes window per attempt on `pillar_up`/`dig:air` loops before `exit_code=142`. **PR-C confirmed**: 1× 15s exhaustion vs run-5's 6× 8s exhaustions. Zero iteration_budget_exhausted (vs run-5's 1) — net win.

## Run-4 → run-6 verb-level delta (PR-I analyzer)

```
cards: 9 vs 9 (Δ +0)
invocations: 946 vs 982 (Δ -36)
errors: 200 vs 231 (Δ -31, −13%)

Top shifts:
  terrain_top   +283 (348 vs 65)   — PR-E classifier adoption: workers using terrain inspection 5× more often
  inspect       -123 (7 vs 130)    — PR-A indirect: no CONSTRUCT card means no cell-sweep anti-pattern
  dig           -89 (4 vs 93)      — consistent with no CONSTRUCT phase
  goto_near     -37 inv, -17 err   — PR-C cap change reducing some pathfind exhaustions
  through       +12 inv, +11 err   — Pattern D oak_door persisted at (16,102,54) outside PR-H rect
  pillar_up     -5 (24 vs 29)      — Pattern C softened slightly (PR-F partial); still active
```

The `terrain_top` 5× rise + `inspect` 18× drop are the load-bearing signals: workers ARE reading terrain via the new classifier (PR-E), and the inspect-storm anti-pattern is gone (PR-A's indirect effect). The `pillar_up` modest drop tells us PR-F's prose change is starting to shift Steward but the renderer gap (PR-E) is bottlenecking it.

## Phase 10 PR plan — commit-ready, ranked by evidence weight

### PR-J — nav-brief renderer always emit terrain.kind (P1, blocking)

**Surface:** `bot/lib/runtime/nav-brief.js:629-632` (the `renderNavBrief` lines I added in PR-E).

**Current bug:**
```javascript
const terrainText = terrain && terrain.kind && terrain.kind !== 'flat' && terrain.kind !== 'unknown'
  ? `terrain=${terrain.kind} (feet_vs_local_ground=${terrain.feet_vs_local_ground})`
  : null;
```

**Fix:** emit whenever `terrain.kind` is set:
```javascript
const terrainText = terrain && terrain.kind
  ? `terrain=${terrain.kind} (feet_vs_local_ground=${terrain.feet_vs_local_ground})`
  : null;
```

**Evidence:** Flint's narrated quote at `agent-flint.log:432` + 30 Mason Pattern E hits + Steward's 0.87% `terrain=` conversion rate. Workers fall back to raw-Y inference when labelled state is hidden — exactly what the SOUL is trying to prevent. **One-line fix; biggest single-change leverage in Phase 10.**

**Test:** extend `bot/test/scene-terrain-kind.test.js` with a render assertion or add a tiny nav-brief render test.

### PR-K — auto-invoke `wb stash-coord` from kanban-worker skill on claim (P1)

**Surface:** the kanban-worker skill (search `skills/` or `~/.hermes/kanban/`) — the post-claim hook that already runs `wb context` for orient.

**Rule:** auto-run `wb stash-coord` immediately after `wb context` on every CONSTRUCT/MINE/TILL/SUPPLY/SURVEY card claim. No SOUL prose; mechanical.

**Evidence:** 0 invocations across 4 bots over 60 min despite explicit SOUL bullets in mason.md, flint.md, and gatherer-test.md. Prose guidance for tooling adoption fails. Make it automatic.

**Test:** integration test asserts the file appears at `$HERMES_HOME/task-body-coord.json` after a claim event with a verb-first card body.

### PR-L — PR-B carve-out clarification: SURVEY + multi-coord SCOUT count as "verb-required" (P2)

**Surface:** `prompts/landfolk/{mason,flint,gatherer-test}.md` — the prose-escalate sections.

**Rule:** explicit "SURVEY cards and SCOUT cards with ≥3 coord targets MUST have at least one mc verb line — escalate `prose_card_no_verb` if missing".

**Evidence:** Mason's SURVEY abandonment (2 of 5 sites surveyed in ~14 min before stop) and Gatherer's `t_1d175784` crash loop on prose verify-resources both would have caught.

### PR-M — Pattern D residual cleanup card pattern (P2)

**Surface:** either widen `scripts/establish-rcon-prep.py` rect to cover known Z=54 and Z=62 residuals, OR teach Steward to emit a `mc dig` cleanup card when she detects persistent door/structure tar-pits at known coords.

**Evidence:** 16 run-6 oak_door hits at (16,102,54), Gatherer's 3-crash loop at (13,101,62). The current PR-H 25×25 rect missed both.

### PR-N — Steward retry-reason validation (P3)

**Surface:** Steward SOUL — when calling `hermes kanban retry`, require a hypothesis stronger than "fresh spawn".

**Evidence:** new Pattern G (phantom-retry-on-stuck-worker) — Steward retried `t_1d175784` 3× with identical reason text after each crash had identical `pid not alive` cause.

### PR-O (deferred) — Flint protocol_violation upstream Hermes change

Still upstream-blocked. Same deferral as Phase 9.

## Files

- Per-bot postmortems: `steward.md`, `mason.md`, `flint.md`, `gatherer.md`
- Board snapshot: `kanban-final-dump.sql` (219 lines, 11 cards at stop)
- Task cognition logs: `task-logs/` (9 logs from the 9 dispatched cards)
- PR-I analyzer outputs: `analyzer-delta-vs-run4.txt`, `analyzer-delta-vs-run4.json`
- Run-5 baseline: `data/postmortems/establish-2026-06-03-phase8/THOROUGH-POSTMORTEM.md`
- Run-4 baseline: `data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md`
- Phase 9 plan: `~/.claude/plans/investigate-the-open-points-wondrous-karp.md`
