# Agent workflow — change validation loop

Human suspects a prompt hotspot. Agent measures signal, human promotes.

## Steps

1. `./context-tuner doctor`
2. `./context-tuner scenario new <id> --template=policy-rule --profile=prompts/landfolk/flint.md`
3. Edit `data/context-tests/_drafts/<id>.yaml` (remove all `TODO`)
4. `./context-tuner scenario validate <id>` then `scenario validate --all`
5. Baseline: `./context-tuner run <id> --runs 3 --yes -q` → save `run_id` from stdout
6. `./context-tuner variant new <id> <label> --override prompts/landfolk/flint.md`
7. Edit `prompts/experiments/...` hotspot
8. Variant run: `./context-tuner run scripts/context-tests/configs/experiments/<label>.yaml --runs 3 --yes -q`
9. `./context-tuner compare last last~1` — targeted delta + stderr `WARN` if git/model drift
10. Side effects: `./context-tuner run <suite> --config scripts/context-tests/configs/experiments/<label>.yaml --yes`
11. `./context-tuner trend --scenario <id> -n 5` or `./context-tuner trend <suite> -n 5`
12. Report to human: deltas, warnings, diff path; **do not** commit production prompt without human OK
13. Human promotes → `./context-tuner run <suite> --yes` → optional `./context-tuner compare ... --append-learnings`

## What an AI agent should do here

Follow steps in order. Exit code `3` after `run` means grading failures (signal), not necessarily a broken harness.
