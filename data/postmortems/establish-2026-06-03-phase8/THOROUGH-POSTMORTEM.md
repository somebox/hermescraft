# Phase 8 establish-base run-5 — Thorough Postmortem

**Window:** 2026-06-03 04:48:22 → 06:14:35 UTC (1h26m). Bots: Steward, Gatherer, Flint, Mason. Map: establish.explore seed=1001, world reused from run-4 (AUTO_REUSE=1) for apples-to-apples comparison.

**Phase 8 changes under test** (commits 41c314a, 3d36b31, e34059f):
- **8.A** `bot/lib/actions/marks.js` — soft-warn `MARK_NO_AT_COORD_IN_NOTE` when note text contains a coord triple but no `--at`.
- **8.B** `bot/lib/actions/movement/move.js` — long-range (>20 blocks) `mc move` defaults to `--near 2` instead of strict cell-match.
- **8.3 SOUL** `prompts/landfolk/steward.md` — mandatory `hermes kanban diagnostics` row in conditional reads.
- **8.4 SOUL** `prompts/landfolk/mason.md` — "card-body `mc <verb>` lines are REQUIRED instructions" subsection.

## Headline

**First-ever pad completion** in establish-base (t_7d9b1fd4 closed at 05:44 after Mason engaged `mc fill cobblestone 15 101 49 23 101 56`). Achieved via Steward re-decomposing a failed *prose* CONSTRUCT card (t_174de3c0) into 3 SUPPLY cards + 1 *verb-first* CONSTRUCT — the only verb-first card emitted in the run. The follow-up walls card t_19305b13 regressed to prose, and Mason fell back into the inspect-storm anti-pattern from run-4. **Phase 9's central surface is making verb-first decomposition Steward's default, not her failure-reactive recovery move.**

## Predicate scorecard

| Predicate | Status | Evidence |
|---|---|---|
| **7.0** orchestrator-tracker (no Steward worker sessions) | ✓ **HELD** | `ls ~/.hermes/profiles/steward/sessions/*.json` → empty. 0 across 5 hours. Pattern stable. |
| **8.A** `MARK_NO_AT_COORD_IN_NOTE` warning fires | **DORMANT** | 0 warnings. Workers wrote range-style notes (`"abundant at Y94-100"`) that correctly bypass the regex. No new marks with coord triples this run; predicate untested rather than failed. |
| **8.B** long-range `mc move` lenient default | ✓ **FIRING** | 25 "within 2" entries vs. 82 "within 1" across fleet logs. Mason's NW explore err_pct recovery 65% → 3.2% over 24 min is the strongest single-bot win — 13 of 28 `mc move` calls used `--near 2`. |
| **8.3** Steward diagnostics adoption | ✓ **67%** | 16 rendered `Diagnostics:` digests across 24 orchestrator rounds. Detected Mason pad stall at T+13m (run-4 baseline: T+20m). |
| **8.4** Mason engages verb when card body has one | ✓ **WORKED** | t_7d9b1fd4 (verb-first body) → ~14 min completion + `mc fill` engaged. t_174de3c0 and t_19305b13 (prose bodies) → inspect-storm recurrence. Necessary but insufficient — depends on Steward emitting verbs. |
| **NEW — Pattern F** Steward default-prose decomposition | **CONFIRMED** | 5 of 6 cards Steward created had prose bodies. The 1 verb-first card was a failure-recovery re-decompose, not a default. |

## Per-bot summaries

- **[Steward](steward.md)** (928 words) — 24 orchestrator rounds, 0 worker sessions, healthy chat orchestration (12 whispers in rounds 9-15 to unstick Flint/Gatherer/Mason). Phase 8.3 diagnostics adoption at 67% caught the pad stall 7 min faster than baseline. Pattern F is hers: verb-first card body emitted exactly once (under failure), regressed to prose on the next card.

- **[Mason](mason.md)** (1016 words) — 4 cards (1 EXPLORE done with NW NAV recovery, 3 CONSTRUCT — 1 archived under PHYSICALLY_STUCK reclaim, 1 done in 14 min via `mc fill`, 1 walls running at run-stop). On the prose pad: 60 inspect + 22 dig + 13 collect + **0 fill** + 11 level + 2 place. On the verb-first pad: `mc fill` engaged, clean close. Walls (prose) regressed to 74 inspect + 3 fill manual loop. Pattern E (prose-card-inspect-storm) is the dominant friction.

- **[Flint](flint.md)** (833 words) — 2 EXPLORE done (NE + SW), 4 SUPPLY cards (1 archived as protocol_violation when Flint exited cleanly without `kanban_complete`; not real abandonment). NE recovery 33% → 0% err in 8 rounds. Phase 8.A unexercised (Flint placed zero new marks in run-5 — all 6 marks in his store are run-4 reconciled). Phase 8.B impact minimal (1 within-2 vs 3 within-1 in his trace). Dominant nav surface: 23× "goal changed before completion" + 13× goto_near 8s cap (existing tasks #41 + #42). Chest-behind-door pattern at (16,102,54) became a tar-pit second half of run.

- **[Gatherer](gatherer.md)** (952 words) — SE explore done in 7.75 min. Oak SUPPLY t_2160f84d **iteration_budget_exhausted (150/150) at 06:13** — Gatherer's headline failure. 52 hermes rounds, 8 SIGALRM exits at 5-min round cap. Top errors: goto_near 8s wallclock cap (top error in 6 cycles including the final iteration_budget cycle) + collect 40s cap (top in 6 consecutive cycles, 58% failure rate). Pattern E (Steward whispers prescribing absolute-Y pillar_up) still leaking — Gatherer pillared to Y=105 on a 1×1 column on Steward's literal order. Pattern C panic-pillar count unchanged from run-4 baseline (~5).

## Run-4 → Run-5 metric deltas

| Metric | Run-4 | Run-5 | Δ |
|---|---|---|---|
| 9×9 pad completion | never closed | ✓ done 05:44 | **WIN** (first completion) |
| Mason iteration_budget exhausted | 1 (150/150 on pad) | 0 | **WIN** |
| Total iteration_budget hits across fleet | 1 | 1 (Gatherer oak) | flat (different bot/card) |
| Steward worker sessions (Phase 7.0) | 0 | 0 | ✓ stable |
| New marks placed with coord-bearing notes | ~12 (0 with `--at`) | 0 new (workers used range notes) | unmeasurable — predicate dormant |
| Mason NW explore err_pct recovery | n/a (different terrain) | 65% → 3.2% | new pattern (8.B-attributable) |
| EPIC progressed past EXPLORE | partial | ✓ EXPLORE + PAD done, walls in flight | **WIN** |
| Mason "0 mc fill" on pad CONSTRUCT | yes | yes on prose; no on verb-first | **CONDITIONAL WIN** |

The headline delta is the first-ever pad completion. The conditional win is that Phase 8.4 SOUL bites when paired with a verb-first card body, but is impotent on prose. The repeat failure on Gatherer's prose oak SUPPLY confirms the pattern generalizes beyond CONSTRUCT.

## Phase 9 surface — ranked by evidence weight

1. **Steward verb-first decomposition SOUL** (highest leverage). Pattern F is the single biggest unaddressed friction surface. Evidence: verb-first card closed in 14 min; two prose siblings burned 1h+ wallclock and triggered a manual reclaim and a manual rescue. *Surface:* `prompts/landfolk/steward.md` decomposition section. *Change:* mandate first body line of every CONSTRUCT/MINE/TILL/SUPPLY card be a literal `mc <verb> <args>` line; prose annotations after. *Effort:* prose edit, ~15 lines. *Expected impact:* ~50% cut to CONSTRUCT median runtime per the t_174de3c0 vs t_7d9b1fd4 delta.

2. **Structure-mark coord-vs-card drift detection** (Pattern A new vector). The 06:00:25 Steward rescue ("mason at (7,98,25) but pad is (19,101,52)") was bot-drift during materials gathering — Mason's actual `base_foundation` mark was correct, but she had wandered off-site. Detection lag was 22 minutes. *Surface:* `bot/lib/actions/marks.js`. *Change:* extend 8.A — if mark name matches a STRUCTURE noun (`base_foundation`, `pad`, `wall`, `roof`, `chest`) and the worker has an active card whose body cites a coord triple, warn when `dist(mark_pos, card_body_coord) > 3`. *Effort:* ~20 lines + test. *Expected:* per-mark detection, drops Pattern A latency from 22m to <30s.

3. **Mason-side prose-card escalate fallback** (defence-in-depth). Cheap regex at task-claim: if card body has no `mc <verb>` line and verb is implied (CONSTRUCT/MINE/TILL/SUPPLY), `wb escalate "prose_card_no_verb"`. *Surface:* `prompts/landfolk/mason.md` (also `flint.md`, `gatherer.md`). *Change:* SOUL bullet directing escalate before grind. *Expected:* turns 22-min silent failure into 1-min noisy one; forces Steward re-spec.

4. **goto_near 8s wallclock cap → 15s** (existing task #42). Gatherer's trace makes this concrete: top error in 6 of 53 cycles including the final cycle before her iteration_budget exhaustion. *Surface:* `bot/lib/actions/movement/goto-near.js`. *Effort:* one constant + test update. *Expected:* unblocks long-range oak gathering, prevents one iteration_budget exhaustion per run.

5. **Pattern E remediation — Steward whisper filter** (carry-over). Steward still issued absolute-Y `pillar_up 105` whispers to Gatherer. *Surface:* Steward SOUL or `agent-context.py` outbound-whisper validator. *Change:* block absolute-Y or `pillar_up N>5` whispers. *Effort:* small validator. *Expected:* eliminates Pattern E mechanically rather than via prose guidance.

6. **Chest-behind-oak_door pattern** (Flint + Mason). 5+ recurrences at (16,102,54). *Surface:* either `bot/lib/actions/containers.js` door-open-then-approach logic, or Steward's chest-coord emission (the coord she cites is the door, not the chest). Cross-cuts with kanban #38 vertical NAV. *Defer for now — narrower scope than #1-3.*

## Commit-ready Phase 9 PR plan

Ship as one or two PRs:

**PR-1 (P1, mandatory): Verb-first decomposition + prose-card escalate.** Pairs the Steward emission fix with the worker fallback so neither is the single point of failure.
- File 1: `prompts/landfolk/steward.md` — new "Verb-first card bodies" subsection. Template-force `mc <verb>` at body line 1 for CONSTRUCT/MINE/TILL/SUPPLY. Include the t_7d9b1fd4 vs t_174de3c0 evidence.
- File 2: `prompts/landfolk/mason.md` (and flint.md, gatherer.md) — claim-time escalate guidance: "If your card is CONSTRUCT/MINE/TILL/SUPPLY and the body has no literal `mc <verb>` line, `wb escalate \"prose_card_no_verb\"` immediately."
- Tests: none (prose-only). Verification: live run.
- Expected: ~50% CONSTRUCT runtime cut; iteration_budget exhaustion rate halved.

**PR-2 (P2, recommended): Structure-mark drift detection.** Extends Phase 8.A.
- File 1: `bot/lib/actions/marks.js` — when mark name matches `/^(base_|pad_|wall_|roof_|chest_)/` and `process.env.HERMES_KANBAN_TASK_BODY_COORD` is set (new env var pushed by dispatcher), check distance; emit `MARK_COORD_VS_CARD_DRIFT` warning if >3 blocks.
- File 2: dispatcher / kanban-worker session bootstrap — extract first coord triple from card body, export as env var.
- Tests: `bot/test/actions/mark-structure-drift.test.js` — analogous to `mark-soft-warn.test.js`.
- Expected: Pattern A detection latency 22m → <30s per mark.

**PR-3 (P3, low-risk quick win): goto_near wallclock cap.** Existing task #42.
- File: `bot/lib/actions/movement/goto-near.js` — bump 8000ms → 15000ms.
- Tests: existing goto-near tests should still pass.
- Expected: -1 iteration_budget exhaustion per run for gathering verbs.

## Files

- Per-bot postmortems: `steward.md`, `mason.md`, `flint.md`, `gatherer.md` (this directory)
- Board snapshot: `kanban-final-dump.sql` (266 lines, 11 cards including 2 archived + 7 done + 1 blocked + 1 ready + 2 running at stop)
- Live logs preserved at `/tmp/hermescraft/{agent,hermes,progress}-{steward,gatherer,flint,mason}.log`
- Memory pointer: `/Users/foz/.claude/projects/-Users-foz-hermescraft/memory/feedback_steward_card_verbs.md`
- Run-4 baseline: `data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md`
