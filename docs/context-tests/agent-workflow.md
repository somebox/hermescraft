# Agent workflow — change validation loop

Human suspects a prompt hotspot. Agent measures signal, human promotes.

## Steps

1. `./context-tuner doctor`
2. `./context-tuner scenario new <id> --template=policy-rule --profile=prompts/landfolk/flint.md`
3. Edit `data/context-tests/_drafts/<id>.yaml` (remove all `TODO`)
4. `./context-tuner scenario validate <id>` then `scenario validate --all`
5. Baseline: `./context-tuner run <id> --runs 3 --no-judge --yes -q` → save `run_id` from stdout
6. `./context-tuner variant new <id> <label> --override prompts/landfolk/flint.md` (or `--override skills/minecraft-survival.md`)
7. Edit `prompts/experiments/...` and/or `skills/experiments/...`; ensure `configs/experiments/<label>.yaml` lists overrides + suite scenarios
8. Variant run: `./context-tuner run scripts/context-tests/configs/experiments/<label>.yaml --runs 3 --no-judge --yes -q` (or same with `--config` on step 5’s scenario id)
9. `./context-tuner compare <baseline-run-id> <variant-run-id>` — prefer explicit ids when re-running the same scenario; `compare last last~1` works when the latest two runs are the pair you intend
10. Side effects: `./context-tuner run <suite> --config scripts/context-tests/configs/experiments/<label>.yaml --yes`
11. `./context-tuner trend --scenario <id> -n 5` or `./context-tuner trend <suite> -n 5`
12. **Rubric-coupling check (before recommending promotion):** if the experiment text could be read as a cheat sheet for any matcher in the scenario (names allowed verbs, names the forbidden verb, recites the whitelist), the win may be recital, not internalization. Either rephrase the prompt to avoid the matcher's vocabulary, or run a **counter-scenario** whose right action is outside the matcher's whitelist. Only call the result "promotable" if the counter passes too.
13. Report to human: deltas, warnings, diff path; **do not** commit production prompt without human OK
14. Human promotes → `./context-tuner run <suite> --yes` → optional `./context-tuner compare ... --append-learnings`

## What an AI agent should do here

Follow steps in order. Exit code `3` after `run` means grading failures (signal), not necessarily a broken harness.
