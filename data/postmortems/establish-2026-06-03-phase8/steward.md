# Steward — run-5 (establish-base, phase 8) postmortem

Window: 2026-06-03 04:48:22 → 06:14:35 UTC (1h26m, 24 orchestrator rounds; `hermes-steward.log` L1, L48).
Worker sessions claimed: **0** (`ls ~/.hermes/profiles/steward/sessions/*.json` → no matches). Orchestrator-tracker pattern HELD.

## Run timeline

Boot at 04:48, idle observation through round 5 (`hermes-steward.log` L1). Round 6 at 05:08 SIGALRM exit=142 (L12). Round 9 at 05:16 identifies the cobble bottleneck: "Board: 1 in-flight (mason t_174de3c0 [CONSTRUCT] Pad 9x9, 13m runtime)" (`agent-steward.log` L4214). Rounds 10-11 (05:18, 05:21) re-route Flint + Gatherer via whisper rescues; mason stuck at 18:44 with only 6 cobble (L4662). Round 12 (~05:25) force-kills mason worker on `t_174de3c0`, archives it, and creates verb-first replacement `t_7d9b1fd4` with `mc fill cobblestone 15 101 49 23 101 56` body + `--after` deps on 3 supply cards (L6771, L6891-6895) — the lone verb-first emission of the run. Round 13 (05:34) pad done; archive. Round 14 (~05:38) creates walls card `t_19305b13` body **regressed to prose** ("Build 4 cobble walls 3 blocks high on the 9x9 foundation pad…", L7944, L8150) plus supply `t_7defd5bc`. Round 16 (05:45) second SIGALRM exit=142 (L32). At 06:00:25 comments on `t_19305b13`: "mason rescue needed — at (7,98,25) but pad is (19,101,52). base_foundation mark is wrong" (kanban.db `task_comments` id 16). Mason's `base_foundation` mark sat at (12,102,14), 38 blocks from pad center (L10000-L10002). At 06:13:35 (round 24, last log line) `t_2160f84d` oak supply flagged `iteration_budget_exhausted 150/150`, gatherer parked 66.9 blocks from target (L13016, L13066); Steward unblocks. Walls card `t_19305b13` still running at run-stop.

## Friction patterns observed

**Pattern A (mark-then-can't-return)** — STRUCK despite Phase 8.A. Mason saved `base_foundation` at his standing position (12,102,14), not the pad center (19,101,52). The 8.A regex `MARK_NO_AT_COORD_IN_NOTE` did not fire because the mark note carried no `\d+,\d+,\d+` triple. Detection cost: 22 minutes (mark placed pre-05:38; Steward caught it at 06:00:25 via position-vs-pad delta inspection).

**Pattern C (panic-pillar)** — Steward issued 0 raw-Y "pillar_up to surface" whispers this run (grep of `agent-steward.log` for `pillar_up to surface` → no hits in her outbound whispers, vs. multiple in run-4). Phase 7-era SOUL fix held.

**Pattern F (NEW: default-prose-decomposition)** — Steward's default card body is prose; she re-decomposes to literal verbs only after a failure. Quantitative evidence:

| Card | Type | Body style | Outcome |
|---|---|---|---|
| `t_174de3c0` | CONSTRUCT pad | prose ("Level the area first, then fill 9x9 with cobble") | archived after ~22m, mason iteration_budget exhausted with 0 `mc fill` calls (per `feedback_steward_card_verbs.md`: 150 inspect + 78 dig + 19 collect + 0 fill) |
| `t_7d9b1fd4` | CONSTRUCT pad (replacement) | **VERB-FIRST** (`mc fill cobblestone 15 101 49 23 101 56`) | done in ~19m |
| `t_a8650983` / `t_47f74d1d` / `t_b0486f5e` | SUPPLY cobble 1/3, 2/3, 3/3 | prose `mc collect ... mc deposit ...` (action sentences but worker-level verbs are listed inline) | 1 archived, 2 done |
| `t_2160f84d` | SUPPLY 64 oak | prose `mc collect oak_log 64` (listed but mixed in prose) | iteration_budget_exhausted 150/150 at 06:13 |
| `t_19305b13` | CONSTRUCT walls | **REGRESSED TO PROSE** ("Build 4 cobble walls 3 blocks high…") | still running at run-stop after ~36m |
| `t_7defd5bc` | SUPPLY 48 cobble for walls | prose with inline verbs | running |

Steward learned during the pad rebuild (verb-first body for `t_7d9b1fd4`) but did not carry the lesson to the next CONSTRUCT card (`t_19305b13`). Confirms the feedback hypothesis exactly.

## Phase 8 changes impact on Steward

**8.A (marks.js MARK_NO_AT_COORD_IN_NOTE)** — Net impact on Steward: **null**. She does not place structure marks (calls `reconcile-marks.py` 17× across the run). The mason mark that bit her at 06:00:25 evaded the regex because the note had no coord triple at all. Phase 9 needs a structural fallback for STRUCTURE-flagged marks.

**8.B (move.js long-range default `--near 2`)** — Indirect only. Steward is read-only; worker rescues she whispered (~12 across rounds 9-15) benefit downstream.

**8.3 SOUL (mandatory `hermes kanban diagnostics`)** — **Partial adoption, working.** 36 SOUL mentions per re-render; 16 actual rendered "Diagnostics:" digests (L3057, L3577, L4087, L4217, L4488, L6410, L6879, L6971, L7345, L8815, L9078, L9225, L9618, L9962, L10432, L10798) = 67% of 24 rounds. Phase 7 baseline "missed the Mason pad stall at T+20"; this run she caught it at T+13 (round 9, mason runtime 13m). She still missed the wall-mark error for 22m because diagnostics doesn't surface mark-vs-card-coord drift.

**8.4 SOUL (mason verb-line subsection)** — Not Steward-side, but exposes the asymmetry: Mason's worker SOUL says "literal verbs FIRST" while Steward's emission surface still defaults to prose. The pair only works if both sides agree.

## Recommendations for Phase 9

1. **Verb-first decomposition SOUL bullet for Steward** (`prompts/landfolk/steward.md`). Mirror the Phase 8.4 Mason bullet: any CONSTRUCT/MINE/TILL card body MUST contain at least one literal `mc <verb> <args>` line before prose. Exemplar: `t_7d9b1fd4`. Anti-exemplars: `t_174de3c0`, `t_19305b13`. Highest-leverage surface this run revealed — verb-first card finished in 19m, prose siblings stalled or iteration-budgeted. *Effort: 1 prose edit. Expected: ~50% cut to CONSTRUCT median runtime per the t_174de3c0 vs t_7d9b1fd4 delta.*

2. **MARK_NO_AT_COORD_IN_NOTE → MARK_COORD_VS_CARD_DRIFT** (`bot/lib/actions/marks.js`). Extend the 8.A warning: if the mark name matches a STRUCTURE noun (`base_foundation`, `pad`, `wall`, `roof`, `chest`) and the bot is running a card whose body cites a coord triple, warn when `dist(mark_pos, card_body_coord) > 3`. Catches the 06:00:25 failure exactly. *Effort: ~20 lines + test. Detection latency drops from 22m to per-mark.*

3. **`hermes kanban diagnostics`: surface mark-vs-card drift** as a first-class warning row per stuck construct card. Steward's 67% diagnostics adoption is good but the signal she needs (structure-mark misplacement) isn't in the output. Pairs with rec #2. *Effort: small renderer change. Closes the loop: SOUL → diagnostics → root-cause visible.*
