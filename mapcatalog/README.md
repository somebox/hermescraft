# mapcatalog

Standalone **seed finder** for procedural test maps.

- **Black box:** [docs/features/procedural-map-catalog.md](../docs/features/procedural-map-catalog.md)
- **Scenario runs (apply/prep/teardown):** [docs/features/procedural-scenario-runs.md](../docs/features/procedural-scenario-runs.md)

## Quick start

```bash
pip install pyyaml   # or: pip install -r requirements-dev.txt
python -m mapcatalog lint -r requirements/mine_plains_iron.yaml
cp server.local.yaml.example server.local.yaml   # edit for your host
```

## CLI

| Command | Phase | Purpose |
|---------|-------|---------|
| `lint -r <job.yaml>` | P1 | Parse gates/placements, cell counts, warnings |
| `try -r ... -s server.local.yaml [--pass1-only] [--seed N]` | P2 | Pass 1 (cubiomes) + Pass 2 materialize/probe |
| `calibrate -s server.local.yaml [--enum-sweep]` | P1.5 | Cubiomes calibration |
| `find -r ... -s ... -o catalog/<id>/ [--solutions N] [--max-seeds M] [--json-lines]` | P3 | Build catalog pool (offline) |
| `find -o catalog/<id>/ --pick random` | P3 | Read one saved result (no server) |
| `scenario …` | P3.5 | **`list` / `lint` / `refresh` / `card`** — see `data/scenarios/registry.yaml` |

## Layout

| Path | Role |
|------|------|
| `requirements/*.yaml` | Job files |
| `profiles/*.yaml` | Presets (`extends:`) |
| `server.local.yaml` | Rcon + world slot (gitignored) |
| `catalog/<id>/` | Saved results (cards) |
| `catalog/rejects/<id>/` | Failed seeds from `find` (when written) |
| `data/scenarios/` | Scenario manifest + [`README`](../data/scenarios/README.md) |

## Tests

```bash
pytest tests/unit/test_mapcatalog_*.py -m unit -q
# or with heartbeats:
scripts/mapcatalog-unit-watch.sh
```
