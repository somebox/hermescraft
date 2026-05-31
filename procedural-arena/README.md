# Procedural-arena POC

Bounded **`proc-*`** Multiverse worlds, batched rcon inspect, and JSON reports for
agent-test fixtures. Does not touch `world` or `landfolk-test`.

## Map sizes

Presets come from `params/defaults.yaml` (`map_size_presets`). They set **worldborder
radius** from the map center (default `0,0`). Inspect and pregen sample a **square**
with half-width `arena_half` (defaults to the same value as `border_radius`).

| Preset | Border radius | Diameter | Inspect square (grid_step 16) |
|--------|---------------|----------|--------------------------------|
| **small** | 64 blocks | 128 | 129×129 columns (~17k) — good for manual smoke and agent-test iteration |
| **medium** | 128 blocks | 256 | 257×257 columns — default in `defaults.yaml` when `--map-size` is omitted |
| **large** | 256 blocks | 512 | 513×513 columns — slow; use for variety sweeps only |

Worldborder clips play; samples outside the circle are skipped during inspect. Tune cost
with `--grid-step` (default 16) or `--skip-inspect` when you only need a fresh seed.

Runtime defaults: **peaceful** difficulty, **doMobSpawning true** — hostile counts in
reports are usually zero until you change `runtime.difficulty` in params or add
`inspect.advance_time_ticks` (see EXPERIMENTS.md sweep F).

## Quick start

```bash
# Recommended: fast regen + compact summary (terrain + mob lines)
python3 procedural-arena/generate.py --map-size small --random-seed --regenerate

# Same run with per-phase progress
python3 procedural-arena/generate.py --map-size small --random-seed --regenerate --verbose

# Inspect existing world only (updates spawn/metrics, writes *-inspect-*.json)
python3 procedural-arena/inspect_world.py --world proc-lab

python3 procedural-arena/generate.py --help   # map preset table + examples
```

Reports: `procedural-arena/reports/*.json` (gitignored).

## Workflows (realistic testing)

**Manual in-game check** after generate — summary prints `go` line with `/mvtp` and feet coords:

```bash
python3 procedural-arena/generate.py --map-size small --random-seed --regenerate
# in game: /mvtp Flint proc-lab
```

**Reproducible agent-test seed** (point YAML at latest report path):

```bash
python3 procedural-arena/generate.py --map-size small --seed 424242 --regenerate
python3 scripts/agent-test.py data/agent-tests/procedural/mine_proc_smoke_v1.yaml
```

**Pick a mining-friendly roll** without reading every JSON:

```bash
python3 procedural-arena/generate.py --map-size small --scenario mining \
  --candidates 5 --random-seed --regenerate
```

**Compare two reports** after a params sweep:

```bash
python3 procedural-arena/compare_reports.py \
  procedural-arena/reports/proc-lab-AAA.json \
  procedural-arena/reports/proc-lab-BBB.json
```

**Dry-run** (planned rcon only):

```bash
python3 procedural-arena/generate.py --dry-run --map-size small --regenerate --random-seed
```

## CLI output

Default **compact** summary (one header, `terrain`, `mobs`, `go`, `report`). Mob line
includes passive/hostile totals plus non-zero per-type counts (chicken, cow, pig, sheep,
zombie, skeleton, creeper, spider) inside the work bbox. Use `--verbose` for phase
timings and the older multi-block layout.

## Server

Rcon via [`config/hermescraft.yaml`](../config/hermescraft.yaml): `rcon.ssh_host`
(default **ubuntu-host**), docker `minecraft`, game port **25565**. Summary uses
`ubuntu-host:25565` when `mc.host` is `localhost` (set `MC_HOST` for bots).

- World names must start with `proc-` (unless `--i-know-what-im-doing`).
- Forbidden: `world`, `landfolk-test`, nether/end defaults.
- Multiverse delete requires **`mv confirm`**; regenerate handles that automatically.

## Agent-test bridge

[`data/agent-tests/procedural/mine_proc_smoke_v1.yaml`](../data/agent-tests/procedural/mine_proc_smoke_v1.yaml)
+ [`scripts/agent-test.py`](../scripts/agent-test.py) (`procedural_env` / fingerprint).

```bash
python3 procedural-arena/run_agent_test.py data/agent-tests/procedural/mine_proc_smoke_v1.yaml
```

## More

- [EXPERIMENTS.md](EXPERIMENTS.md) — one-knob sweeps
- [docs/features/procedural-arena-poc.md](../docs/features/procedural-arena-poc.md) — design notes
