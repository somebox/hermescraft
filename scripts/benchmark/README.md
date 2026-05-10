# mc benchmark

LLM accuracy benchmark for the `mc` command surface. Used to:

1. **Choose models** — score every candidate, rank by accuracy/cost/latency.
2. **Detect regressions** — when registry, cheatsheet, or skill text changes,
   re-run and compare. Drops > 5pp signal that a change has hurt agent
   performance.
3. **Track over time** — runs are stored with timestamp + git SHA so trends
   are reconstructable.

This generalizes the one-off `scripts/eval-grammar/` study (v1 vs v2 grammar)
that lived under that folder. Going forward, `eval-grammar/` is frozen as a
historical record; new evals run from here.

## Quick start

```bash
# Run the full suite against all models in models.json
node scripts/benchmark/run.mjs

# Render markdown leaderboard from the latest run
node scripts/benchmark/leaderboard.mjs

# Compare to the previous run (regression check)
node scripts/benchmark/compare.mjs
```

`run.mjs` writes a JSON file per run into `runs/`. The latest run is whichever
filename sorts last (timestamp prefix). Both `leaderboard.mjs` and
`compare.mjs` default to "latest run" but can take an explicit path.

## Targeted runs

```bash
# Just one model
node scripts/benchmark/run.mjs --models deepseek-v4-flash

# Just one task group
node scripts/benchmark/run.mjs --tasks direct

# A specific historical run
node scripts/benchmark/leaderboard.mjs --run 2026-05-10T15-30-00.000Z.json
```

## Files

| Path | Role |
|---|---|
| `models.json` | Models to benchmark, with cost/1M tokens. Update when prices change. |
| `tasks/direct.json` | Single-step lookup tasks (one task → one mc command) |
| `tasks/composition.json` | Multi-step tasks (one task → sequence of commands) |
| `run.mjs` | Runs the benchmark, writes `runs/<timestamp>.json` |
| `leaderboard.mjs` | Renders the latest run as `LEADERBOARD.md` |
| `compare.mjs` | Diffs two runs; exits non-zero on >5pp regression |
| `runs/` | Persisted run history (committed; small JSON files) |

## When to run

| Trigger | Cadence |
|---|---|
| After any change to `bot/cli/registry.mjs` | Recommended |
| After any change to `docs/mc-cheatsheet.md` | Recommended |
| After any change to skill text under `skills/` | Recommended |
| End of each sprint | Required (exit gate) |
| Quarterly model/cost refresh | Optional |
| Investigating an agent-side accuracy issue | As needed |

## Cost

A full run is ~50 calls × cheap models. With DeepSeek-V4-Flash + Nemotron-free,
expect under $0.05 per full run. With Anthropic/Google/OpenAI cheap-tier
models added, expect $0.10–$0.30. All runs are cheap enough to run on demand.

## Adding tasks

Add JSON entries to `tasks/direct.json` or `tasks/composition.json` (or
create new task group files in `tasks/`). When a sprint adds new verbs, that
sprint should also add 3–5 tasks here covering them.

Task schema (direct):
```json
{
  "id": "unique_string",
  "category": "movement|combat|world|...",
  "task": "natural-language description for the LLM",
  "correct": ["mc verb arg1 arg2", "alt acceptable form"]
}
```

Task schema (composition):
```json
{
  "id": "...",
  "category": "...",
  "task": "...",
  "correct_lines_required": ["mc cmd1 ...", "mc cmd2 ..."],
  "scoring": "all_lines_present | all_lines_present_partial_args_ok"
}
```

## Adding models

Add an entry to `models.json` with the OpenRouter `id` and the current
prices. The label can be anything as long as it's stable (used in run JSON
keys and the leaderboard).

The script picks up new models automatically on next run.
