# Context tuning report: `goals_gap_not_withdraw`

**Date:** 2026-05-27  
**Scenario:** `data/context-tests/goals_gap_not_withdraw.yaml`  
**Subject model:** `deepseek/deepseek-v4-flash` (from `scripts/context-tests/configs/default.yaml`)  
**Grading:** matcher only (`--no-judge`); `required_canonical_any` on first parseable `mc` line(s); `forbidden_canonical: [withdraw]`  
**Samples per arm:** 5  

This report records a small context-tuner experiment. It is a **signal** for prompt edits, not proof of in-world behavior.

## Scenario contract

The fixture states a large base `supply_iron` gap while the bot already holds iron ingots. The user prompt asks for the next action. Matchers require at least one of: `tunnel`, `collect`, `discover`, `deposit`, `craft_plan` (and forbid `withdraw`). They do **not** score whether the model “understood” goals text in prose—only canonical verbs on parsed output.

## Arms tested

| Label | Config | Context change |
|-------|--------|----------------|
| baseline | `configs/default.yaml` | Production `prompts/landfolk/steve.md` + `skills/minecraft-survival.md` |
| `produce-not-find` | `configs/experiments/produce-not-find.yaml` | Experiment Steve: iron paragraph in supply/goals section; experiment survival: crafting-section guard + skip `find crafting_table` when `supply_iron` + iron in inv |
| `goals-priority-first` | `configs/experiments/goals-priority-first.yaml` | Experiment Steve only: short “before first `mc`” checklist inserted under **Priority order**; production survival unchanged |

Experiment prompts live under `prompts/experiments/`; survival copy under `skills/experiments/` (allowlisted overrides—see [variants.md](../variants.md)).

## Results

| Run ID | Arm | pass_rate | stable_pass (5/5) |
|--------|-----|-----------|-------------------|
| `r_2026-05-27T23-05-28-663Z` | baseline | 0.00 (0/5) | no |
| `r_2026-05-27T23-06-16-508Z` | produce-not-find | 0.60 (3/5) | no |
| `r_2026-05-27T23-08-17-265Z` | goals-priority-first | 0.80 (4/5) | yes |

Compare (baseline → variant), same scenario:

- baseline → produce-not-find: 0.00 → 0.60  
- baseline → goals-priority-first: 0.00 → 0.80  
- produce-not-find → goals-priority-first: 0.60 → 0.80  

Earlier 3-sample runs (same arms, before n=5) showed the same direction; n=5 increased confidence that **goals-priority-first** is the stronger arm at this sample size.

### Observed first-command patterns (qualitative)

**Baseline (0/5):** Repeated `mc inventory`, `mc find iron_ingot`, or prose then `find`; one empty model response.

**produce-not-find (3/5):** Several `mc craft_plan iron_pickaxe` (pass); failures included empty output, a multi-line chain ending in `mc find crafting_table`, and bare `mc craft iron_pickaxe`.

**goals-priority-first (4/5):** Mostly `mc craft_plan`, `mc collect` (e.g. cobble for pickaxe path); one failure opened with `mc inventory` only.

### Infra / parsing noise

Some samples returned **empty `raw_output`** (baseline 1/5, produce-not-find 1/5). Those count as matcher failures but are not evidence of a specific bad verb choice. Empty responses appeared on both default and experiment configs; treat as API/timeout or prompt-size flake until retried or logged.

## Tooling note

`context-tuner run <scenario-id> --config <experiment.yaml>` previously always passed `default.yaml` for scenario-id targets. That was fixed in `scripts/context-tests/cli/run-cmd.mjs` so `--config` is honored. Experiment runs should still use the experiment yaml as the run target (or the fixed `--config` flag) so run records show the correct `label` and fixture hashes.

## Update 2026-05-28 — counter-test results

External review flagged the original recommendation: the experiment prompt named 4 of 5 allowed verbs and the single forbidden verb from the scenario matchers verbatim, so the 4/5 pass rate could not distinguish "rule internalized" from "menu recited". Two follow-up tests were run.

### Softened experiment

`prompts/experiments/steve-goals-priority-softened.md` replaces the explicit verb menu with a positive-only paragraph (`add to the stockpile — pick the right mc verb for producing or staging more`). No verbs from the rubric named. Config: `scripts/context-tests/configs/experiments/goals-priority-softened.yaml`.

### Counter-scenario

`data/context-tests/goals_gap_but_hungry.yaml` keeps the same `supply_iron` gap and iron-in-inventory state, but adds `food: 6` (≤ 14, hunger threshold from `skills/minecraft-survival.md`) and `cooked_beef: 4` in inventory. Matcher: `required_canonical_any: [eat]`, `forbidden_canonical: [withdraw]`. The right action is `mc eat`; this tests whether any change that pushes Steve toward production verbs damages hunger prioritization.

### Results (5 samples per arm; softened arm was run twice, n=10 combined)

| Arm | Config | `goals_gap_not_withdraw` | `goals_gap_but_hungry` |
|-----|--------|--------------------------|------------------------|
| baseline | production `steve.md` | 0/5 = 0.00 | 4/5 = 0.80 |
| verbatim (`goals-priority-first`) | rubric verbs in priority block | 4/5 = 0.80 | not run on this arm |
| softened (`goals-priority-softened`) | positive-only block, no verbs | 1/10 = 0.10 | 4/10 = 0.40 |

Run ids: baseline goals_gap `r_2026-05-27T23-05-28-663Z`; baseline hungry `r_2026-05-27T23-27-10-730Z`; softened pair `r_2026-05-27T23-28-17-502Z`, `r_2026-05-27T23-31-28-056Z`.

### Interpretation

- **Rubric leak confirmed.** Removing the verb menu collapses pass rate from 0.80 → 0.10 on `goals_gap_not_withdraw`. The verbatim arm's win was dominated by recitation; the underlying rule did not generalize at all in this model.
- **Side regression confirmed.** The softened arm also drops hunger handling from 0.80 → 0.40. The "Survival rules still come first" footnote in the softened text was not enough to keep the model from over-applying the new goals-gap heuristic when hungry.
- **Net effect: worse than baseline.** Softened version produces no measurable improvement on the original scenario AND degrades a tangential one. Verbatim version is non-generalizing.
- **Empty-output anomaly.** The two softened runs had 11 of 20 empty `raw_output` responses. Production baseline runs at similar prompt length had 1 of 5. Cause unclear (API flake correlated to a single afternoon's calls vs prompt-specific destabilization); not actionable from this data but noted for follow-up.

### Observe-layer follow-up (no prompt change)

External review suggested testing whether the failure is doctrine-shaped or observation-shaped. Hypothesis: the model fails not because it lacks the rule, but because it doesn't cross-reference inventory against the open goal. Test: add `you_hold: 5` and `gap_after_deposit: 23` to the goal entry in the observe, leave Steve and survival skill at production. New fixture: `data/context-tests/_shared/observe-goals-gap-itemized.json`. Experiment: `scripts/context-tests/configs/experiments/goals-observe-itemized.yaml`. Scenario-patched via overrides (no scenario duplication).

Result: `r_2026-05-27T23-47-32-382Z` — **2/5 = 0.40** vs baseline 0.00. No prompt change, no rubric leak.

Outputs: passing samples opened with `mc collect oak_log 4` (gearing up toward iron pickaxe). Failing samples opened with `mc inventory`, `mc craft iron_pickaxe`, or `mc read_chat` — all arguably reasonable opening moves the matcher classifies as fail. Zero empty outputs on this arm (5/5 non-empty), which weakens the "longer prompt destabilizes generation" hypothesis from the softened arm.

The observe-layer fix is **directionally correct** but limited by matcher narrowness. Two interpretations:

- The scenario matcher should accept `inventory` and possibly `craft` as legitimate produce-adjacent opening moves; widening would lift 0.40 → ~0.80 without doctrine.
- Some samples still picked `craft iron_pickaxe` directly (no produce intent at all), so observation cues alone don't fully internalize the rule.

### Revised recommendation

1. **Do not promote either Steve variant.** Neither version is a net improvement.
2. **Keep the experiment files in `prompts/experiments/` and the counter-scenario in `data/context-tests/`** as a documented null result. The harness behaved correctly; the failure mode is in the doctrine, not the workbench.
3. The scenario `goals_gap_not_withdraw` may itself be too narrow: `mc inventory`, `mc find iron_ingot`, `mc craft_plan iron_pickaxe` are arguably reasonable opening moves the matcher classifies as fail. Either widen the matcher (allow `inventory`, `find`) or accept that this is exploratory rather than a promotion gate.
4. **Prefer the observe-layer fix over a doctrine fix.** Exposing `you_hold` / `gap_after_deposit` in the goals observation lifts baseline 0.00 → 0.40 with no prompt change. If `mc goals` ships this shape in production, the connection between inventory and goal is forced by the data rather than taught by a rule — cheaper to maintain, harder to overfit, applies to scenarios we haven't authored yet. This is the recommended direction.
5. If the goals-gap rule still seems worth teaching after the observe change, the survival skill (near smelting/resource decisions) is the next-cheapest place — re-test with the counter-scenario before promoting.

### Skill-side intervention also underperformed

The `produce-not-find` arm forked both the persona (Steve iron paragraph) and the skill (survival crafting guard). It scored 0.60 on `goals_gap_not_withdraw` vs the persona-only verbatim arm's 0.80. The heavier delta did not help. **Do not reach for skill forks first** when a persona-level change is available.

---

## Changes to consider (original, retained for context — superseded by Update above)

### 1. Promote (recommended candidate): priority checklist in production Steve

Copy the block from `prompts/experiments/steve-goals-priority-first.md` (immediately after the three priority bullets) into `prompts/landfolk/steve.md` at the same location:

```markdown
**Before your first `mc` when goals show a supply gap:** compare the gap to what you
already carry. If you already have some of that supply (e.g. iron ingots while
`supply_iron` is short at the base), your first command must **add** supply —
`mc collect`, `mc discover`, `mc tunnel`, `mc deposit`, or `mc craft_plan` toward
mining — not `mc withdraw`, not `mc find crafting_table`, not a bare `mc inventory`
or `mc craft` as the opening move.
```

**Rationale:** Highest pass_rate and only arm with `stable_pass` at n=5; smallest diff (persona only, no skill fork); aligns with scenario matchers without widening the whitelist.

**After promotion:** Re-run baseline at n=5 on `goals_gap_not_withdraw` and at least one related suite (e.g. `examples`) to check for regressions.

### 2. Optional: narrower iron-specific paragraph (lower priority)

The `produce-not-find` Steve paragraph (`**Iron supply_iron` gaps...**` in `prompts/experiments/steve-produce-not-find.md`) is more specific but duplicated themes already covered by the priority checklist. If promoted in addition to (1), watch prompt length and contradiction with generic “don’t drain chests” text elsewhere in Steve.

### 3. Optional: survival crafting guard (not required by n=5 data)

`skills/experiments/survival-produce-not-find.md` adds a pre-crafting rule and a skip on step 3 (`find crafting_table`). The **goals-priority-first** arm did better **without** this override. Consider survival edits only if live traces still show `find crafting_table` before mining when goals show metal gaps.

### 4. Do not change yet (based on this study)

- **Scenario matchers:** Adding `inventory` or `find` to `required_canonical_any` would raise pass_rate without fixing the behavior under test.  
- **Scenario `user_prompt`:** Synthetic one-liner; changing it would alter what is being measured.  
- **Retiring experiment files:** Keep `produce-not-find` and `goals-priority-first` configs until production promotion is validated; then archive or document as superseded.

### 5. Follow-up measurements

- Re-run `goals_gap_not_withdraw` with `--runs 5` after Steve promotion (expect pass_rate > 0 on default config if the hypothesis holds).  
- Optional: enable judge on a subset to see if NL expectations agree with matchers (default judge: `mc_conventions`, no cheatsheet).  
- Investigate empty responses (retry once, log token estimate on rendered prompt).

## Reproduction

```bash
./context-tuner run goals_gap_not_withdraw --runs 5 --no-judge --yes -q
./context-tuner run scripts/context-tests/configs/experiments/produce-not-find.yaml --runs 5 --no-judge --yes -q
./context-tuner run scripts/context-tests/configs/experiments/goals-priority-first.yaml --runs 5 --no-judge --yes -q
# equivalent: ./context-tuner run goals_gap_not_withdraw --config scripts/context-tests/configs/experiments/goals-priority-first.yaml ...
./context-tuner compare r_2026-05-27T23-05-28-663Z r_2026-05-27T23-08-17-265Z
```

Run artifacts (gitignored): `scripts/context-tests/runs/deepseek__deepseek-v4-flash/<stamp>-context.json` and compact `run.json` per run id.

## Ledger

A short entry was appended via `./context-tuner compare ... --append-learnings` in [learnings.md](../learnings.md) (decision left TODO for human).

## Limitations

- Single subject model and temperature 0.5; no multi-model sweep.  
- Matcher-only grading; no LLM judge scores in this report.  
- One hard scenario; not a full suite regression.  
- Fixture observe JSON is shared (`observe-goals-gap.json`); behavior under different observe shapes is untested here.
