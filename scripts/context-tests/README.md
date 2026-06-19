# Context tests workbench

Offline harness for **prompt/context interpretation**: given persona, skills, synthetic `observe`, and optional prior tool results, does the model emit the expected `mc` (or shell) lines? No live Mineflayer or Hermes.

**Entry point:** `./context-tuner` at repo root (dispatches here). Human-oriented docs: `docs/testing/context-tuner/README.md`.

## Layout

| Path | Role |
|------|------|
| `bench.mjs` + `cli/` | `./context-tuner` subcommands |
| `run.mjs` | OpenRouter subject + grading + run records |
| `configs/` | `default.yaml`, `configs/experiments/*.yaml` overrides |
| `runs/` | Local scores + manifest (gitignored) |
| `_archive/` | Retired one-shots (`capture.py`, old compare scripts) |

## Quick start

```bash
./context-tuner doctor
node scripts/context-tests/run.mjs --canary
./context-tuner scenario validate --all

./context-tuner run examples --runs 1 --no-judge --yes -q
./context-tuner runs query last
./context-tuner compare last last~1
```

Requires `OPENROUTER_API_KEY` or `secrets.yaml` with `openrouter_api_key`.

## `run.mjs` flags (direct runner)

| Flag | Purpose |
|------|---------|
| `--config` | YAML config (default `configs/default.yaml`) |
| `--scenario-id` | Run one scenario from config suite filter |
| `--suite-file` | Suite YAML under `data/context-tests/suites/` |
| `--runs-override` | Override per-scenario sample count |
| `--no-judge` | Skip diagnostic LLM judge |
| `--yes` | Bypass cost preflight |
| `--estimate-only` | Print cost estimate and exit |
| `--verify-only` | Fixture verifier only |

Prefer `./context-tuner run …` so `--config` on a scenario id is applied correctly (see `cli/run-cmd.mjs`).

**Fix backlog:** every run writes `fix-backlog.json` / `.md` next to the run record. See [data/context-tests/fix-backlog/README.md](../../data/context-tests/fix-backlog/README.md).

**Terrain-shaping batch (no one-off commands):** context pass **closed** — [closure](../../docs/testing/context-tuner/reports/2026-06-17-terrain-shaping-closure.md), [standing 2026-06-19](../../docs/testing/context-tuner/reports/2026-06-19-terrain-shaping-status.md). Regression guard: stable ≥ 8/11 at n=3 on baseline; embodied **6/6** via `./scripts/terrain-agent-tests.sh all`.

```bash
./scripts/terrain-shaping-batch.sh doctor
./scripts/terrain-shaping-batch.sh baseline --runs 3 --yes
./scripts/terrain-shaping-batch.sh ab --runs 3 --yes      # baseline + hint variant + promotion summary
./scripts/terrain-shaping-batch.sh summary --run last
./scripts/terrain-shaping-batch.sh gate --runs 1 --yes      # region-protect smoke before mint
```

## Experiments

```bash
./context-tuner variant new goals_gap_not_withdraw my-label --override prompts/landfolk/steve.md
# edit prompts/experiments/steve-my-label.md + configs/experiments/my-label.yaml
./context-tuner run scripts/context-tests/configs/experiments/my-label.yaml --runs 3 --no-judge --yes -q
./context-tuner compare <baseline-run-id> <variant-run-id>
```

## Grading

- **mc** (default): `expect.tool_calls`, `patterns` — see `grading.mjs`, `lib/shell-lines.mjs` for shell.
- **shell**: `expect.shell_commands` for Steward-style output.
- NL judge: diagnostic; defaults in `configs/default.yaml` (`mc_conventions`, no cheatsheet).

**Cheatsheet in prompts:** `run.mjs` embeds `docs/reference/mc-cheatsheet.md` by default (tier layout: Agent core / Extended / Microscope). Run manifests record its SHA256 — expect a new hash after `scripts/regenerate-artifacts.sh` or registry edits; not a CI gate.

## Capture (optional)

Draft scenarios from cognition JSONL: `python3 scripts/context-tests/_archive/capture.py` (archived; not required for the workbench loop). Runtime captures: `HERMESCRAFT_CAPTURE_ROOT`, `COGNITION_DIR` from `scripts/landfolk`; workbench may store slices under `data/context-tests/captures/` (gitignored).

## Overfitting

If a prompt change fixes live play but fails a scenario, fix or retire the scenario — do not treat the scenario as ground truth for production behaviour.
