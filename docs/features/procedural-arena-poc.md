# Procedural-arena POC

Status: **POC shipped in-repo** (2026-05-31). Standalone tooling under [`procedural-arena/`](../../procedural-arena/) for bounded `proc-*` Multiverse worlds, batched rcon inspect, fixture stamping, and optional multi-candidate scoring.

## Purpose

Learn which worldgen levers matter before wiring fleet agent tests off flat `landfolk-test` slabs. Successor to the playbook pass closure direction ([`playbook-improvement-pass-closure.md`](playbook-improvement-pass-closure.md)): **procedural maps + scenario library**.

## Experimental hypothesis

**The five-shape scenario taxonomy holds on realistic terrain** — prep, survey, transit, work, closeout — when inspect metrics prove affordances (flat patch, biome diversity, traversability, ore/tree proxies, cleanup bbox) instead of hand-placed coordinates.

## Components

| Piece | Path |
|-------|------|
| Generate / regenerate | `procedural-arena/generate.py` |
| Inspect only | `procedural-arena/inspect_world.py` |
| Batched rcon | `procedural-arena/lib/rcon.py` |
| Fixture stamp | `procedural-arena/stamp_fixture.py`, `fixtures/registry.yaml` |
| Scenarios (M2 weights) | `procedural-arena/scenarios/*.yaml` |
| Agent-test extension | `procedural_env` in YAML; [`scripts/agent-test.py`](../../scripts/agent-test.py) `_apply_procedural_env_if_present` |
| Example spec | `data/agent-tests/procedural/mine_proc_smoke_v1.yaml` |

## Report JSON

- `timing_seconds`: delete, create, datapack_install, border_forceload, pregen, inspect, total
- `rcon_batches`, `rcon_commands_sent`
- `map`: center, border_radius, diameter, arena_half; optional `map_size_preset` when `--map-size` was used
- `metrics` / `metrics_by_shape`: prep, survey, transit, work (includes `mobs`, `mob_total`), closeout, `runtime` snapshot
- `spawn_feet`, `muster`, `work_bbox`, `cleanup_bbox`, `fingerprint_inputs`, `fingerprint`

### Map presets

See [procedural-arena/README.md](../../procedural-arena/README.md#map-sizes). **small** (64 radius) is the practical default for smoke and agent-test; **medium** matches `params/defaults.yaml` when no `--map-size` is passed.

### CLI

`generate.py --help` embeds the preset table and copy-paste examples. Default terminal output is **compact** (`terrain` + `mobs` lines); `--verbose` restores per-phase progress.

## Modes

- **VARIETY**: random seed; optional `--candidates N` + `--scenario` weights
- **PINNED**: `fixtures/pinned/<id>.yaml` via `--promote-pinned`

## Limitations

- Datapack worldgen templates are stubs (`vanilla_baseline`); axis enums in `fixtures/registry.yaml` map to profiles for M1 expansion.
- Inspect uses batched `execute if block` / biome probes — costly on large maps; tune `--grid-step` and `--map-size`.
- Pregen uses **forceload** chunk coverage (no Chunky dependency).
- `mv create` / worldborder syntax may need host-specific tweaks (document in `procedural-arena/README.md` after first live run).

## Related

- [`docs/guides/test-world.md`](../guides/test-world.md) — flat pytest arena (unchanged)
- [`docs/guides/agent-tests.md`](../guides/agent-tests.md) — agent-test harness
