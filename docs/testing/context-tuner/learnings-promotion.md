# Context test learnings

Signal ledger; not ground truth. Entries appended via `./context-tuner compare ... --append-learnings`.

## 2026-05-27 — goals_gap_not_withdraw (Steve)
- A: `r_2026-05-27T23-05-28-663Z` (baseline n=5) B: `r_2026-05-27T23-08-17-265Z` (`goals-priority-first` n=5)
- Report: [reports/2026-05-27-goals-gap-context-tuning.md](./reports/2026-05-27-goals-gap-context-tuning.md)
- Initial signal: priority-checklist experiment 0.80 pass vs baseline 0.00; `produce-not-find` 0.60 at n=5
- decision: **do not promote** — see 2026-05-28 update below

## 2026-05-28 — counter-test for goals-gap edits
- Softened arm: `r_2026-05-27T23-28-17-502Z`, `r_2026-05-27T23-31-28-056Z` (n=10 combined)
- Baseline on counter-scenario (`goals_gap_but_hungry`): `r_2026-05-27T23-27-10-730Z` (0.80, n=5)
- Findings:
  - Verbatim `goals-priority-first` win was rubric leak (named 4/5 allowed + the forbidden verb). Softened text drops `goals_gap_not_withdraw` from 0.80 → 0.10.
  - Softened text regresses hunger handling (0.80 → 0.40 on `goals_gap_but_hungry`). "Survival first" footnote insufficient.
  - Skill-fork arm (`produce-not-find`) underperformed persona-only arm at every comparison; **persona-side edits beat skill-side edits** for this kind of policy nudge.
  - Softened arm had elevated empty-response rate (11/20 vs production baseline 1/5). Cause undetermined; track if reproduced.
- decision: keep experiments archived as documented null result; do not edit production `prompts/landfolk/steve.md`. Consider widening `goals_gap_not_withdraw` matchers or relocating the rule to survival skill if revisited.

## 2026-06-17 — terrain-shaping context suite (baseline)

- Suite: `data/context-tests/suites/terrain-shaping.yaml` (11 scenarios + `terrain-shaping-baseline` / `terrain-shaping-hint-promote` experiment configs).
- Bot hint write-back: `navBlockedNextActionHint` prefers `mc move` when `target_standable` and |Δy|≤2 before `dig_area` fallback.
- Skills: navigation 1-block step-up doctrine; roadbuilding obstacle→verb table; kanban-worker shape-before-block paragraph.
- Embodied: six **F_*** specs on Tester — **6/6** (2026-06-19); see [status report](./reports/2026-06-19-terrain-shaping-status.md).
- **Improvement pass closed:** report [reports/2026-06-17-terrain-shaping-closure.md](./reports/2026-06-17-terrain-shaping-closure.md).
- Best baseline run: `r_2026-06-17T15-02-08-890Z` — **9/11 stable** at n=3 after **`next_action_hints`** in observe JSON + prompt-builder surfacing (vs 5/11 stable at n=5 pre-hints).
- decision: **promote observation fixture pattern + batch/fix-backlog + supporting skills** for terrain context regression. **Do not** require 11/11 n=5 as merge gate. **Follow-up:** gate + embodied + A/B completed 2026-06-19 — see entry below and [status report](./reports/2026-06-19-terrain-shaping-status.md).

## 2026-06-19 — terrain-shaping-hint-promote A/B

- Command: `./scripts/terrain-shaping-batch.sh ab --runs 3 --yes`
- A (baseline): `r_2026-06-19T06-54-46-725Z` — **10/11 stable** (apron ∅ flake 67%)
- B (`terrain-shaping-hint-promote`): `r_2026-06-19T06-56-15-241Z` — **11/11 stable**
- Variant lever: `prior_patch` on **`nav_blocked_one_block_step_up`** only — clearer `next_action_hint` on failed move (`mc move … # do not dig_area`).
- Compare: `./context-tuner compare r_2026-06-19T06-54-46-725Z r_2026-06-19T06-56-15-241Z` — **only delta** `base_apron_excludes_shelter` 0.67 → 1.00; **step-up unchanged** 1.00 → 1.00.
- Findings:
  - **Intended target (step-up prior) already saturated** at n=3 with observe `next_action_hints`; prior_patch adds no measurable lift.
  - Batch “promotion candidate” on apron is **run variance**, not the experiment override (apron is not in `terrain-shaping-hint-promote.yaml`).
  - Same session baseline runs swing apron/protect/walkable (e.g. `r_2026-06-19T06-47-36-031Z` 9/11 vs A arm 10/11); keep **≥8/11 @ n=3** regression bar, not single-run 11/11 as proof.
- decision: **do not promote** `prior_patch` step-up hint into production scenario YAML. Keep observe-first hints + apron user-prompt nudge (`2026-06-19` apron/lip fixture edits). Embodied **6/6** on Tester (`2026-06-19`).

## 2026-06-19 — runtime promotion (bot/)

- **Nav hints:** `navBlockedNextActionHint` runs standable `mc move` (|Δy|≤2) before sculpt/reach fallbacks; protect regions use `observed_state` (`nav_in_protect_region`, `region_nav_exit_hint`) to block destructive `dig_area` / tunnel defaults.
- **Observe:** live `next_action_hints[]` (cap 5, deduped, move/check before dig) on `buildObservePayload`; CLI observe prints **Suggested next commands**; cleared on `STALE_BRIEF` / `brief_refresh_required`.
- **Verification:** targeted bot tests green; context baseline **11/11 stable** `r_2026-06-19T10-41-41-874Z` @ n=3; embodied **6/6** same day.
- decision: **promote runtime hint path** for fleet nav/observe; keep context + embodied batch as regression guard. Docs: [planning/terrain-shaping-runtime-promotion.md](../../planning/terrain-shaping-runtime-promotion.md), [status report](./reports/2026-06-19-terrain-shaping-status.md).

## Methodology rules learned from the 2026-05-27/28 cycle

The workbench's most useful output here was a **null result**: a hypothesis that looked solid at n=5 (`goals-priority-first` 0.80 vs baseline 0.00) collapsed under a counter-scenario and softened-text re-test. A merge of the verbatim block would have shipped silent overfit. Three durable rules:

1. **Rubric-coupling check before promotion.** If the experiment prompt could function as a verbatim cheat sheet for any matcher in the scenario (mentions allowed verbs, names forbidden ones, etc.), the prompt and the matcher must not share that vocabulary. Either rephrase the prompt with synonyms/abstractions, or test on a counter-scenario whose right action is **outside** the matcher's whitelist before promoting.
2. **Smallest override surface first.** Persona → skill → suite. Skill-fork arms underperformed persona-only arms at every comparison in this cycle. Reach for a layered intervention only after the smaller one is shown insufficient.
3. **Counter-scenarios are cheap and worth one before promotion.** A single observe-patched scenario that flips the correct action (here: `goals_gap_but_hungry`) caught the overfit immediately. Pair every assumption-suite addition with one orthogonal test.
4. **Prefer observation-layer fixes over doctrine fixes when both are plausible.** Adding `you_hold: N` and `gap_after_deposit: N` to the goal observation lifted `goals_gap_not_withdraw` from 0.00 → 0.40 with no prompt change (`r_2026-05-27T23-47-32-382Z`, observe-only override). Data is harder to overfit than prose, applies across scenarios the model hasn't been trained on, and doesn't compete with other persona/skill rules at decode time. **Terrain-shaping (2026-06-17):** `next_action_hints` on shared observe fixtures lifted stable pass ~5/11 → **9/11** at n=3 (`r_2026-06-17T15-02-08-890Z`); keep hints as bare `mc …` lines only.
