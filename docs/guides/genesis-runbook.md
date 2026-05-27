# Genesis operator runbook (Core v1)

Spec: [docs/features/genesis-boot.md](../features/genesis-boot.md).

## Preconditions

- Homelab Minecraft host reachable via `MC_HOST_SSH` (default `ubuntu-host`).
- `MC_DOCKER_NAME` (default `minecraft`) for rcon via docker exec.
- `GENESIS_COMPOSE_FILE` — production compose (default `/opt/stacks/minecraft/docker-compose.yml`).
- `GENESIS_WORLD_DATA` — overworld path inside the volume (default `/data/world`).
- `hermes` and `scripts/landfolk` on PATH; board `landfolk-ops`.
- Seven templates under `data/genesis/templates/` (see spec table).

### Example seeds (operator notes)

- `6833329508037519212` — above-ground dungeon
- `-1312751495452676979` — generally good flat build (use `--seed=-1312751495452676979`)

## Conventions (quick reference)

| Topic | Rule |
|---|---|
| Run id | `g-YYYY-MM-DD-N` under `data/genesis-runs/` (gitignored) |
| Active run | `data/genesis-runs/.active` (one line: run id) |
| Lock | `data/genesis-runs/.lock` during `new-run` (`<pid> <run_id> <iso>`) |
| Anchor flag | `--anchor X,Y,Z` (not `--base`) |
| Placeholders | Flat scalars only: `{anchor_x}`, `{system_chest_x}`, `{tower_x}`, `{seed}`, `{run_id}` |
| Kanban assignee | lowercase (`steward`, `flint`, `mason`) |
| Snapshot labels | `[a-zA-Z0-9_-]+`; phase files `phase1`…`phase4`; ticks `tick-001` (3-digit) |
| Pn ↔ file | `[GENESIS:P1]` done → `snapshot-phase1.json` |

## Commands

```bash
scripts/genesis.sh new-run --seed 12345
scripts/genesis.sh new-run --seed=-8675309 --anchor 0,64,0 --no-confirm
scripts/genesis.sh current
scripts/genesis.sh list
scripts/genesis.sh check-phases
scripts/genesis.sh check-phases --json
scripts/genesis.sh snapshot --label tick-001
scripts/genesis.sh snapshot --label manual-note
scripts/genesis.sh render-templates --seed=42 --anchor 10,64,-5 --run-id g-preview-1
scripts/genesis.sh seed-cards
scripts/genesis.sh diff g-2026-05-27-1 g-2026-05-28-1
# or: scripts/genesis-diff.py <run_a> <run_b>
scripts/genesis.sh note "paused for dinner"
scripts/genesis.sh archive-rescue /path/to/RESCUE_flint.md
scripts/genesis.sh help
```

### `new-run` flags

| Flag | Meaning |
|---|---|
| `--seed <int>` | Required world seed |
| `--seed=-N` | **Preferred for negative seeds** (avoids flag parsing) |
| `--anchor X,Y,Z` | Skip biome probe; use fixed `base_anchor` |
| `--difficulty {peaceful\|easy\|normal\|hard}` | Pin difficulty; disables P3/P4 ramp |
| `--no-confirm` | Skip interactive run-id confirmation |

Negative seeds: `scripts/genesis.sh new-run --seed=-1312751495452676979`. Bash also accepts `--seed -1312751495452676979` after the parser fix.

### Flow (`new-run`)

1. Finalize previous `.active` run (`snapshot-end.json`, `digest.md`) if any.
2. Confirm run id + seed (unless `--no-confirm`).
3. `landfolk stop` → archive kanban + `locations-*.json` + prior goals/regions/plan into `archived/`.
4. `reset_world` (production `world` only) → probe or `--anchor`.
5. `render_templates` → `data/base-goals.yaml`, `regions-world.json`, hut1 plan, `config.json`, `.active`.
6. `system-chest.mjs place && fill` with `SYSTEM_CHEST_*` env from offsets file.
7. Seed 4 epics (parent chain) + 5 P1 cards (no epic parent).
8. `snapshot-start.json` → `landfolk start` → `genesis-phase-poller.py` in background.

Structured steps: `data/genesis-runs/<run_id>/run.log` (JSON-lines).

## During a run

- Steward follows genesis doctrine in `prompts/landfolk/steward.md`.
- Phase snapshots: poller writes `snapshot-phase1.json` … `phase4` when the matching epic hits `done`.
- Manual capture: `scripts/genesis.sh snapshot --label <name>`.

## End / next run

Another `new-run` closes the previous run (`snapshot-end`, `digest.md`) and clears `.active` before the new run proceeds.

## Compare runs

```bash
scripts/genesis.sh list
scripts/genesis.sh diff g-2026-05-27-1 g-2026-05-28-1
```

## Rescue artifacts

```bash
scripts/genesis.sh archive-rescue RESCUE_flint.md
```

v1.1: `watch-rescues` daemon — not shipped; use `archive-rescue` per file.

## Recovery

- **Lock stuck:** remove `data/genesis-runs/.lock` only if no `new-run` process is running.
- **Partial new-run:** read `run.log`; fix error; `landfolk stop` then retry (same or new run id).
- **Probe timeout:** `new-run --seed=<int> --anchor X,Y,Z`.

## Local dev (no SSH)

```bash
GENESIS_DRY_RUN=1 scripts/genesis.sh render-templates --seed=1 --anchor 0,64,0 --run-id g-test-1
```

Skips rcon/ssh/world reset; still writes under `data/genesis-runs/` unless `GENESIS_RUNS_ROOT` is set.

## Landfolk integration

`scripts/landfolk stop` stops bots and default daemons (gateway unless `--keep-gateway`). `scripts/landfolk start` brings up `PLAYERS_DEFAULT` (typically flint, mason, steward) plus steward continuous/gateway per landfolk defaults.

## Smoke checklist (homelab)

1. `new-run --seed 12345` → `snapshot-start.json`, kanban 4 epics + 5 P1 cards (P1 workers without parent).
2. P1 epic `done` → `snapshot-phase1.json`, P2 epic eligible via parent link.
3. Second run + `genesis.sh diff` (or `genesis-diff.py`) between run ids.
4. `new-run --seed=99999 --anchor 0,64,0` skips probe.

## Tests (repo)

```bash
python3 -m venv .venv-genesis && .venv-genesis/bin/pip install pytest pyyaml
GENESIS_DRY_RUN=1 .venv-genesis/bin/python -m pytest \
  scripts/tests/test_templates.py \
  scripts/tests/test_genesis_lib.py \
  scripts/tests/test_genesis_snapshot.py -q
```
