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
