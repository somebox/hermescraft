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

## Methodology rules learned from the 2026-05-27/28 cycle

The workbench's most useful output here was a **null result**: a hypothesis that looked solid at n=5 (`goals-priority-first` 0.80 vs baseline 0.00) collapsed under a counter-scenario and softened-text re-test. A merge of the verbatim block would have shipped silent overfit. Three durable rules:

1. **Rubric-coupling check before promotion.** If the experiment prompt could function as a verbatim cheat sheet for any matcher in the scenario (mentions allowed verbs, names forbidden ones, etc.), the prompt and the matcher must not share that vocabulary. Either rephrase the prompt with synonyms/abstractions, or test on a counter-scenario whose right action is **outside** the matcher's whitelist before promoting.
2. **Smallest override surface first.** Persona → skill → suite. Skill-fork arms underperformed persona-only arms at every comparison in this cycle. Reach for a layered intervention only after the smaller one is shown insufficient.
3. **Counter-scenarios are cheap and worth one before promotion.** A single observe-patched scenario that flips the correct action (here: `goals_gap_but_hungry`) caught the overfit immediately. Pair every assumption-suite addition with one orthogonal test.
4. **Prefer observation-layer fixes over doctrine fixes when both are plausible.** Adding `you_hold: N` and `gap_after_deposit: N` to the goal observation lifted `goals_gap_not_withdraw` from 0.00 → 0.40 with no prompt change (`r_2026-05-27T23-47-32-382Z`, observe-only override). Data is harder to overfit than prose, applies across scenarios the model hasn't been trained on, and doesn't compete with other persona/skill rules at decode time.
