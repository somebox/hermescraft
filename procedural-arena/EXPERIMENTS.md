# Procedural-arena experiments

Change **one knob** per run; diff reports with `compare_reports.py`.

| Sweep | Command knobs | Question |
|-------|----------------|----------|
| A | `--map-size small\|medium\|large` | pregen/inspect time vs area |
| B | same map, `--random-seed` ×5 | biome/flat/water variance |
| C | `--no-structures` vs default | structures in samples |
| D | `--generator FLAT` vs `NORMAL` | baseline vs procedural |
| E | `--grid-step 8\|16\|32` | inspect cost vs stability |
| F | `inspect.advance_time_ticks` in params + re-inspect | mob counts in report `metrics.work.mobs` |

Fixture matrix: `fixtures/matrix.yaml`. Stamp: `stamp_fixture.py --id …`.

Promote winner: `generate.py --promote-pinned --fixture flat_sparse_iron_plains`.
