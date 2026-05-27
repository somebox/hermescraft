# context-tuner CLI

Source of truth for `./context-tuner --help`.

```
context-tuner — prompt/context signal workbench

Usage:
  context-tuner doctor [--json]
  context-tuner scenario new <id> --template=<error-recovery|policy-rule|stuck-escalation|bare> [--profile=PATH]
  context-tuner scenario list|show|validate [<id>|--all]|archive <id>
  context-tuner variant new <scenario> <label> [--override PATH | --profile -]
  context-tuner variant list <scenario>
  context-tuner suite list|show <name>
  context-tuner run <scenario|suite|config> [--config experiment.yaml] [--runs=N] [--no-judge] [--yes] [-q]
  context-tuner runs list|show|query <id|last|last~N> [--json] [--failing]
  context-tuner compare [<A>] [<B>] [--json] [--append-learnings]
  context-tuner trend <suite-preset> [-n N] [--json]
  context-tuner trend --scenario <id> [-n N] [--json]

Exit codes: 0 ok, 1 usage, 2 validate fail, 3 grading failures, 4 infra abort
```

## Running scenarios and experiments

| Target | Example |
|--------|---------|
| Scenario id (default config) | `./context-tuner run goals_gap_not_withdraw --runs 3 --no-judge --yes -q` |
| Scenario + experiment overrides | `./context-tuner run goals_gap_not_withdraw --config scripts/context-tests/configs/experiments/goals-priority-first.yaml --runs 3 --yes -q` |
| Experiment config (suite in YAML) | `./context-tuner run scripts/context-tests/configs/experiments/goals-priority-first.yaml --runs 3 --yes -q` |
| Suite preset name | `./context-tuner run examples --yes` |
| Suite file path | `./context-tuner run data/context-tests/suites/region-protect.yaml --yes` |

After `run -q`, stdout is a single `run_id` (e.g. `r_2026-05-27T23-08-17-265Z`). Exit code `3` means matcher (or pattern) failures in at least one sample — expected when tuning.

## Conventions

- Progress and errors → **stderr**; machine ids and tables → **stdout**.
- Piped `list` → one id per line.
- `--json` on read commands; `--field` reserved for future dotted paths.

## Composability

```bash
./context-tuner scenario list | head -3
./context-tuner runs list | tail -1
./context-tuner runs query last --failing --json | jq '.[].id'
./context-tuner compare last last~1 --json | jq '.rows'
./context-tuner trend examples -n 5
```

## What an AI agent should do here

Run `doctor` first. After `run -q`, capture stdout `run_id` only. Use `compare` and `trend` before editing production prompts.
