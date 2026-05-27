# context-tuner

Signal workbench for **prompt/context iteration** (not live MC, not a production regression suite).

## Use case

You suspect a prompt hotspot causes bad `mc` choices. You edit the hotspot under `prompts/experiments/`, re-run a small suite, and read:

1. **This run** — `runs show last`
2. **A vs B** — `compare last last~1` (or default pairing by `label` / `suite`)
3. **Trend** — `trend <suite> -n 10` per-scenario scores over recent runs

Inputs live in **git** (scenarios, experiment configs). Runs store **scores + manifest** only.

## AI agent quickstart

```bash
./context-tuner doctor
./context-tuner scenario validate --all
./context-tuner run examples --runs 1 --no-judge --yes -q
./context-tuner runs query last
```

See [agent-workflow.md](./agent-workflow.md) for the full change-validation loop.

## Docs

| File | Contents |
|------|----------|
| [cli.md](./cli.md) | Commands and flags (matches `./context-tuner --help`) |
| [scenarios.md](./scenarios.md) | Scenario YAML schema and templates |
| [variants.md](./variants.md) | Experiment overrides and allowlist |
| [grading.md](./grading.md) | Matchers, patterns, expectations |
| [limitations.md](./limitations.md) | mc vs shell grading surface (Steward vs workers) |
| [agent-workflow.md](./agent-workflow.md) | Step-by-step session for coding agents |
| [learnings.md](./learnings.md) | Optional promotion ledger (`compare --append-learnings`) |
| [reports/](./reports/) | Dated experiment write-ups (objective results + promotion notes) |

## Grading stance

- **Matchers / patterns** — primary signal for assumptions (**mc worker output** by default).
- **Shell matchers** — opt-in for Steward/orchestrator (`grading_surface: shell`). See [limitations.md](./limitations.md).
- **Expectations (LLM judge)** — diagnostic; `mc_conventions` context, no cheatsheet by default.

**Footgun:** orchestrator output has no `mc ` lines unless you use the shell surface — judge-only scenarios are weak promotion signal.
