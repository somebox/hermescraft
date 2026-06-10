# mc grammar A/B eval — flat vs categorical

Run: 2026-05-10. 12 direct tasks + 2 prediction tasks × 2 grammars × 2 models = 52 LLM calls.

## Hypothesis

The proposed categorical grammar (`mc <category> <verb> [args]`) makes
LLMs more accurate at composing mc commands than the current flat
grammar, because:
1. Cheatsheet is shorter to scan (grouped by category)
2. Parallel verbs let the model **predict** mirror commands without seeing them
3. `mc <category> --help` provides a discoverability path

## Result

**Hypothesis not validated.** Across both DeepSeek-V4-Flash and
Nemotron-120B, accuracy is statistically equivalent on both grammars,
and prediction tests scored 0% on both models.

### Direct lookup accuracy (12 tasks)

After excluding 3 rate-limit errors that hit DeepSeek's v1 run:

| Model | v1 (flat) | v2 (categorical) | Δ |
|---|---|---|---|
| DeepSeek-V4-Flash | 89% (8/9) | 100% (12/12) | +11pp |
| Nemotron-120B | 92% (11/12) | 83% (10/12) | -9pp |
| **Combined** | **90% (19/21)** | **92% (22/24)** | **+2pp** |

The 11pp DeepSeek win for v2 looks promising in isolation, but the
opposing 9pp Nemotron win for v1 cancels it out. Combined, the grammars
are within noise of each other.

### Prediction accuracy (2 tasks, partial cheatsheet)

We showed the model only `mine` verbs and asked it to compose `build` commands — testing whether parallelism enables prediction of unseen verbs.

| Model | predict_build_from_mine | predict_mark_from_goal |
|---|---|---|
| DeepSeek-V4-Flash | invented `mc place block` (not real) | empty output |
| Nemotron-120B | empty output | got close — emitted `mc mark add lookout`, missed `plan` prefix |

**Both models scored 0%.** Models do not reliably extrapolate parallel verb structure from partial cheatsheets.

## What the failure modes were

Real grammar-driven failures (not infra/model-behavior bugs):

| Task | Grammar | Model | What model did | Expected |
|---|---|---|---|---|
| feed_cow | v1 | DeepSeek | `mc feed_mob cow` (missing wheat arg) | `mc feed_mob cow wheat` |
| feed_cow | v2 | Nemotron | echoed cheatsheet template `mc farm breed PAIR` | `mc farm feed cow wheat` |
| fight_zombie | v1+v2 | Nemotron | empty output (token cap hit during reasoning paragraph) | `mc fight zombie 6` / `mc fight loop zombie 6` |

## Why the prediction tests failed

The hypothesis was that, given only `mine block / area / tunnel`, the model would predict `build block / area / tunnel`. This didn't happen:

- **DeepSeek invented external commands** — `mc place block 0 64 0 oak_planks`. The model fell back to its training prior ("I know `place` is a Minecraft action") rather than predicting the parallel verb.
- **Nemotron got close on mark-from-goal** — it correctly extracted `mark add NAME` from `goal add ID ...`, just missed the `plan` parent prefix. Suggests parallelism IS perceivable, but the test framing was too compressed.

## Conclusion

**The data does not justify the categorical refactor on accuracy grounds.**

Implications:

1. **Don't refactor for LLM accuracy.** Combined accuracy is +2pp, well within noise. The flat grammar with the existing `mc <cmd> --help` discoverability already works for both DeepSeek and Nemotron.

2. **Prediction is not a real win.** LLMs don't reliably extrapolate parallel verbs even when the parallelism is explicit. The "guess from analogy" argument is empirically wrong for these models.

3. **The refactor case is now purely about maintainability.**
   - Easier for humans reading the code/cheatsheet
   - Cleaner extension as we add 30+ verbs in sprints 5–10
   - Compactness per-skill (subset by category)
   These are real but smaller benefits than a multi-pp accuracy gain would be.

4. **Sprint 5+ verbs can be added in either grammar without affecting agent performance.** This removes the urgency to refactor before sprint 5.

## Recommendation

**Don't do the refactor now.** Keep the flat grammar. Focus the
refactor budget on building primitives (sprint 5) and the missing-tool
backfill that actually moves capability forward.

Revisit the categorical proposal if/when:
- The flat command surface exceeds ~200 verbs and humans struggle to navigate it
- We start running into per-skill cheatsheet bloat
- A model upgrade changes the prediction story

## Caveats

- Sample size is small (12 tasks, 2 models).
- Auto-grading is exact-match against accepted forms; partial credit isn't captured (e.g., DeepSeek's `mc feed_mob cow` is "almost right").
- Token-cap truncation cost Nemotron 2 results that probably would have passed with `max_tokens` ≥ 2000.
- Variance run-to-run is ~5pp from random temperature drift; a single run is suggestive, not conclusive.

The eval harness is at `scripts/eval-grammar/run.mjs`. Re-run with
`node scripts/eval-grammar/run.mjs` to refresh.

## v3 tier-grouped cheatsheet (2026-06-10)

After agent-surface tiering, **v1** in the harness reads the frozen flat baseline
(`scripts/eval-grammar/fixtures/cheatsheet-flat-baseline.md`); **v3** reads the live
tier-grouped [`docs/reference/mc-cheatsheet.md`](../../docs/reference/mc-cheatsheet.md)
(Agent core / Extended / Microscope). **v2** remains the archived categorical doc at
`docs/archive/mc-cheatsheet-v2.md`. Direct tasks grade v1/v3 against flat `v1_correct`
forms (verb names unchanged). Re-run A/B/C when changing tier layout or core membership.
Optional merge gate — `cd bot && HERMES_VALIDATE=1 npm test` is authoritative.
