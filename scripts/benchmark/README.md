# mc benchmark

LLM benchmark for translating natural-language tasks into valid `mc` CLI
commands. Runs against [OpenRouter](https://openrouter.ai/) models listed in
`models.json`. Used to:

1. **Choose models** — rank candidates by strict pass rate, semantic score,
   CLI parse rate, latency, and reported cost.
2. **Detect regressions** — after registry/cheatsheet/skill changes, re-run and
   compare. See `compare.mjs` thresholds below.
3. **Track over time** — each run JSON stores timestamp + git SHA + per-call
   grading metadata.

This generalizes the one-off `scripts/eval-grammar/` grammar A/B study; that
folder stays a historical record — **new work happens here**.

## Quick start

```bash
# 1) Offline gate — every gold answer in tasks/*.json parses like the real CLI
node scripts/benchmark/verify-harness.mjs

# 2) Optional: list cheap/free models from OpenRouter public API (merge into models.json by hand)
node scripts/benchmark/list-openrouter-models.mjs --max-usd-per-1m 0.2 --limit 40
node scripts/benchmark/list-openrouter-models.mjs --free-only --limit 40

# 3) Small live smoke test after verify-harness passes (costs a few API calls)
node scripts/benchmark/run.mjs --syntax-only --tasks direct --models deepseek-v4-flash --serial

# Full suite: all models in models.json × all task groups under tasks/
node scripts/benchmark/run.mjs

# Markdown leaderboard: merges latest JSON per model directory (see Runs layout)
node scripts/benchmark/leaderboard.mjs

# Compare last two runs for one model
node scripts/benchmark/compare.mjs --model deepseek/deepseek-v4-flash

# Regression gate: legacy — latest two flat *.json in runs/ only if present
node scripts/benchmark/compare.mjs
```

Secrets: `run.mjs` reads `openrouter_api_key` from
`/Users/foz/homelab/secrets.yaml` (same pattern as the legacy grammar eval).

## Targeted runs

```bash
node scripts/benchmark/run.mjs --models deepseek-v4-flash

# Comma-separated task group names = stems of tasks/*.json (direct, composition, challenges, …)
node scripts/benchmark/run.mjs --tasks direct,challenges

# Cheatsheet-only prompts (no persona / skill / observe fixture)
node scripts/benchmark/run.mjs --syntax-only

# One API call at a time (vs default: parallel per-model queues)
node scripts/benchmark/run.mjs --serial

node scripts/benchmark/leaderboard.mjs --run deepseek__deepseek-v4-flash/<stamp>-realistic.json

node scripts/benchmark/leaderboard.mjs --model deepseek/deepseek-v4-flash
```

## What gets measured

Each OpenRouter response is graded with:

| Field | Meaning |
|---|---|
| `pass` | Task-specific rubric (exact/prefix match for `direct`; multi-line rules for `composition` / `challenges`). |
| `semantic_score` | 0–1: `1` when `pass`; otherwise partial credit from parse rate / matched canonical verbs / partial sequence hits (`challenges` tasks define richer rules). |
| `parse_ok_rate` | Fraction of emitted `mc …` lines that parse successfully against `bot/cli/registry.mjs` + `bot/cli/dispatch.mjs` (see `cli-simulate.mjs`). |
| `simulated_lines` | Per-line parse outcome + normalized HTTP `{method,path,body?,params?}` (no server call). |
| `cost_usd` / `cost_basis` | Prefer OpenRouter `usage.cost` when present; else `usage.cost_details.upstream_inference_cost`; else estimate from `models.json` token prices. |
| `finish_reason` / `native_finish_reason` | From the chat completion choice (useful to spot `length` truncation). |

## Runs layout

Main harness writes **one JSON per model** so you can run a subset now and others later:

- `runs/<model_slug>/<ISO-stamp>-realistic.json` or `-syntax.json`
- Slug = OpenRouter model id with `/` → `__` and `:` → `_colon_` (see `runs-layout.mjs`).
- One invocation shares the same `timestamp` across written files; each file lists `suite_models` for context.

Two-tier eval: `runs/two-tier/<decomposer_slug>__<executor_slug>/<stamp>-two-tier.json`, or `runs/two-tier/_multi_pair/` when multiple pairs run at once.

`leaderboard.mjs` (no flags) loads the **latest JSON in each model directory** and merges rows for cross-model ranking. Old flat `runs/*.json` files still work as a single-source fallback.

## Files

| Path | Role |
|---|---|
| `models.json` | OpenRouter model ids + USD per 1M tokens (fallback pricing). |
| `tasks/direct.json` | Single-command lookup tasks. |
| `tasks/composition.json` | Multi-command composition tasks. |
| `tasks/challenges.json` | Scenario rubrics (forbidden/required verbs, parse gates, reference answers). |
| `cli-simulate.mjs` | Parse-only simulator shared with the bot CLI. |
| `verify-harness.mjs` | Offline check: every gold `mc` line in `tasks/` parses via `cli-simulate.mjs`. |
| `billing-extract.mjs` | Token/cost normalization + `usage_totals` aggregation. |
| `runs-layout.mjs` | Slug helpers + discover latest run per model directory. |
| `list-openrouter-models.mjs` | Fetch public model list; filter by USD/1M (aligns with [cheap models on OpenRouter](https://openrouter.ai/models?order=top-weekly&max_price=0.2)). |
| `run.mjs` | Main harness → `runs/<slug>/<stamp>-realistic.json` (one model per file). |
| `run-two-tier.mjs` | Decomposer+executor pipeline → `runs/two-tier/...`. |
| `leaderboard.mjs` | Merged latest-per-model → `LEADERBOARD.md` (or `--run` / `--model`). |
| `compare.mjs` | Diff two JSON paths, or `--model` for last two in a model dir. |
| `runs/` | Per-model history + optional legacy flat snapshots. |

## When to run

| Trigger | Cadence |
|---|---|
| Change to `bot/cli/registry.mjs` | Recommended |
| Change to `docs/mc-cheatsheet.md` (generated from registry) | Recommended |
| Change to benchmark fixtures under `fixtures/` or skills referenced by agents | Recommended |
| End of sprint | Required where docs say so |
| Model/pricing refresh | Optional |

## Cost

Rough call count = `(sum of tasks in selected groups) × (selected models)`.
OpenRouter often returns `usage.cost` (USD) per completion — that is stored and
summed; fallback estimates use `models.json` when the API omits cost.

## Adding tasks

### Direct (`tasks/direct.json`)

```json
{
  "id": "unique_string",
  "category": "movement|combat|world|...",
  "task": "natural-language description for the LLM",
  "correct": ["mc verb arg1 arg2", "alt acceptable form"]
}
```

### Composition (`tasks/composition.json`)

```json
{
  "id": "...",
  "category": "...",
  "task": "...",
  "correct_lines_required": ["canonical mc …", "per slot …"],
  "correct_line_groups": [
    ["mc option_a", "mc option_b"],
    ["mc only_choice"]
  ],
  "rubric_note": "Human-readable; optional.",
  "scoring": "all_lines_present | all_lines_present_partial_args_ok | all_lines_present_any_order_partial_args_ok"
}
```

Each inner array in `correct_line_groups` is one scored slot (OR across alternatives). When omitted, each entry in `correct_lines_required` is its own single-choice slot. `verify-harness.mjs` parses every string in those groups.

### Challenges (`tasks/challenges.json`)

Natural-language scenarios scored with a `challenge` object:

```json
{
  "id": "example_challenge",
  "category": "world",
  "task": "Describe what the bot should do …",
  "challenge": {
    "correct": ["mc safe_dig 8 64 8"],
    "correct_lines_required": ["mc cmd_a …", "mc cmd_b …"],
    "scoring": "all_lines_present_partial_args_ok",
    "required_canonical_all": ["move"],
    "required_canonical_any": ["safe_dig"],
    "forbidden_canonical": ["dig"],
    "require_parse_ok": true,
    "max_mc_lines": 4
  }
}
```

- `correct` / `correct_lines_required` / optional `challenge.correct_line_groups`
  reuse the same matchers as `direct` / `composition`.
- Canonical name checks use the **primary** verb after alias resolution
  (`goto` not `go`).
- Set `"require_parse_ok": false` to allow rubric pass even when some lines
  fail CLI parse (discouraged — prefer fixing the task gold answer).

The OpenRouter UI filter [top weekly, max price $0.2](https://openrouter.ai/models?order=top-weekly&max_price=0.2) uses marketplace ordering; `list-openrouter-models.mjs` uses the same public pricing fields but sorts by **prompt+completion** USD/1M (cheapest first). Always paste ids into `models.json` manually and trim duplicates/broken endpoints before a large run.

**Recommended workflow before benchmarking many cheap models:**

1. `node scripts/benchmark/verify-harness.mjs` — must exit 0.
2. Optional: one-model `--syntax-only` run on `direct` to confirm OpenRouter + secrets.
3. Add a handful of ids from `list-openrouter-models.mjs` into `models.json`, then widen the set once results look sane.

## `models.json` entries

Each model needs the OpenRouter `id`, a stable `label`, and `cost_per_1m_in` /
`cost_per_1m_out` for fallback costing when a completion omits `usage.cost`.
Copy numbers from the lister output or from the model page, then trim the list
to models you actually want to pay for.
