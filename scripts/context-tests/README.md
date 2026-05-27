# Context tests workbench

Offline harness for **prompt/context interpretation**: given persona, skills, synthetic `observe`, and optional prior tool results, does the model emit the expected `mc` calls? No live Mineflayer or Hermes.

## Layers

1. **Runner** — `node scripts/context-tests/run.mjs` (config-driven)
2. **Capture** — `python3 scripts/context-tests/capture.py` (Hermes cognition JSONL → draft YAML)
3. **Experiments** — `configs/experiments/*.yaml` + `compare.mjs`

## Quick start

```bash
./context-tuner doctor
node scripts/context-tests/run.mjs --canary
./context-tuner scenario validate --all

# Smoke (one scenario, one run, no judge)
./context-tuner run pillar_down_hint_honored --runs 1 --no-judge --yes -q
```

Full docs: `docs/context-tests/README.md`.

Requires `OPENROUTER_API_KEY` or `secrets.yaml` with `openrouter_api_key`.

## CLI (small surface)

| Flag | Purpose |
|------|---------|
| `--config` | YAML config (default `configs/default.yaml`) |
| `--runs-override` | Override per-scenario run count |
| `--no-judge` | Skip diagnostic LLM judge |
| `--yes` | Bypass cost preflight |
| `--estimate-only` | Print cost estimate and exit |
| `--verify-only` | Run fixture verifier only |
| `--canary` | Matcher self-tests (no API) |

## Matchers

Structured grading on `cli-simulate` output (`canonical_name`, `simulated_request.body`). See `grading.mjs`. Pass/fail outcomes: `pass`, `matcher_fail`, `model_error`, `infra_error`, `invalid_fixture`. Judge is **diagnostic only** in v1.

## Capture locations

- Recommended: `HERMESCRAFT_CAPTURE_ROOT` (default `~/.hermescraft/captures`) and `COGNITION_DIR` (set by `scripts/landfolk` on start).
- Workbench archives slices under `data/context-tests/captures/_raw/<id>/` (gitignored).

## Judge context (mc conventions)

By default the NL judge sees only scenario `description`, expectation text, parsed `simulated_requests`, and agent output — **not** the cheatsheet the subject saw.

To ground the judge on HermesCraft verb naming:

```yaml
judge:
  context_mode: mc_conventions      # built-in conventions blurb
  include_cheatsheet: true          # append docs/mc-cheatsheet.md (truncated)
  cheatsheet_max_chars: 8000
```

Per-scenario override: `judge_context: |` in the scenario YAML.

Compare on a saved run without re-calling the subject:

```bash
node scripts/context-tests/compare-judge-context.mjs \
  scripts/context-tests/runs/<slug>/<stamp>-context.json --samples 3
```

Experiment config with context enabled: `configs/experiments/safety-experiment-a-mc-context.yaml`.

## Overfitting

If a prompt change fixes real play but fails a scenario, fix or retire the scenario — do not treat the scenario as ground truth for production behaviour.
