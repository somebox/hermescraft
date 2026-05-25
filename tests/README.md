# tests/ — pytest-driven test tree

The Python pytest harness for HermesCraft. Sibling to `bot/test/` (Node unit
tests, stay-in-place).

## Layout

```
tests/
  _lib/                  shared primitives — RconClient, BotClient, Arena, Predicates, FixtureLoader, load_config
  conftest.py            shared fixtures (config, rcon, bot, arena, predicates)
  unit/                  pure logic — no MC, no LLM, no network
  functional/            live MC + bot — no LLM
  integration/           live MC + bot + LLM (OpenRouter / Anthropic)
  fixtures/              placeholder package (world-prep YAML lives in data/test-fixtures/)
```

World-prep and capability scenarios: **`data/test-fixtures/`** (L0–L10, behavior B1–B4). Agent+LLM specs: **`data/agent-tests/`** (see [docs/guides/agent-tests.md](../docs/guides/agent-tests.md)).

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
```

## Running

One-page cheat sheet (server, Tester, models): [docs/guides/arena-tests-quickstart.md](../docs/guides/arena-tests-quickstart.md).

```bash
.venv/bin/pytest -m unit                  # fast, no infra
.venv/bin/pytest -m functional            # needs MC server + Tester bot (:3004)
.venv/bin/pytest -m integration           # needs MC + bot + LLM key
.venv/bin/pytest -m "not slow"            # skip the heavy ones
.venv/bin/pytest --collect-only           # see what's there without running
.venv/bin/pytest tests/unit/test_smoke.py # one file
```

## Running profiles

- **Fast** (~10–15 min): `./scripts/run-functional-fast.sh` — stops **Tester only**, starts Tester, `-m "functional and not slow and not integration"`.
- **Full** (~15–25 min + slow combat): `./scripts/run-functional-full.sh` — `-m "functional and not integration"`.
- **Combat only** (~10+ min): `./scripts/combat-suite.sh` — `pytest -m "functional and slow" tests/functional/combat`.

Do **not** run `stop-bots.sh --all` or legacy no-arg stop during a functional suite — concurrent expedition/game runs use Steve on :3001; targeted `Tester` stop avoids killing the wrong bot.

Slow-marker policy: mark `@pytest.mark.slow` on any test consistently observed >30s. New tests >30s without `@slow` should fail CR.

## Harness post-condition

After the autouse `_functional_harness` runs, Tester is in survival at `(0, 65, 0)` on the canonical **65×65 grass plane** (dirt y=60–63, stone y=50–59 below). Lapis pillars at `(0, 65, ±32)` mark the lab (west) / mining (east) zone divider. Inventory cleared, entities killed, stuck-state cleared. Per-test fixtures should **not** call `arena.rescue_tester()`, `arena.clean()`, or `tester_bot.wait_until_ready()`. Declare **`functional_world`** (or `_functional_harness`) as a fixture dependency on any function-scoped world geometry fixture so setup runs **after** the harness reset (otherwise `reset_ground_arena` wipes your blocks). Add props on top of grass; use `arena.place_player(bot, ...)` (feet Y = `floor_top_y + 1`). After rcon-only TPs, a short `arena.settle_fast()` helps the bot client load new chunks before block queries.

## Canonical arena

Observer: fly to `(0, 80, 0)` looking down, or `(0, 70, -30)` facing north. Constants and reset helpers: `tests/_lib/functional_fixtures.py` (`ARENA_FEET_Y`, `LAB_CENTER`, `MINING_CENTER`, `reset_ground_arena` is harness-only).

## Prefabs

Session start bakes `mining_grid_3x3`, `los_wall`, `sealed_cage` into a vault; fixtures call `arena.load_prefab(name, dest_origin)` (see `bake_prefabs_session` in `functional_fixtures.py`).

## Combat tests

Reactive L3 scenarios (formerly `combat-suite.sh` + YAML) are parametrized under `tests/functional/combat/`. Shared rcon/bot helpers: `tests/_lib/combat_fixtures.py` (`lay_cobble_arena`, `summon_target`, `count_targets`, `arm_reactive`, `hold_reactive`). Scenario definitions: `tests/functional/combat/scenarios.py`. Markers: `@pytest.mark.functional` + `@pytest.mark.slow`.

Integration tests use the same autouse `_functional_harness` (reset, trace, park) but keep only `@pytest.mark.integration` — they are not collected by the functional runner scripts above.

## Coord validator

`python3 scripts/check-arena-coords.py` — flags coords outside `[-32,32]×[50,80]×[-32,32]`. `--strict` exits 1; `--feet-strict` checks `tp`/`place_player` Y=65. Opt out per line: `# arena-coords: skip`. Collection emits a warning summary when offenders exist.

## RCON transport (SSH ControlMaster)

`config.rcon.ssh_multiplex` defaults to `true`: one SSH session is reused for the pytest run (`ControlPersist=30m`). Disable with `ssh_multiplex: false` if `/tmp` is unwritable. Check socket: `ls -la /tmp/hermes-rcon-cm-*`.

## Writing functional tests — batching

Prefer `rcon.batch([...])` over multiple `rcon.run(...)` calls. Each `run` is its own round-trip even with multiplex; one `batch` with N commands is one round-trip.

Use named settle helpers: `arena.settle_fast()`, `settle_default()`, `settle_water()`, `settle_heavy()` instead of bare `time.sleep` in test bodies.

## Configuration

All cross-cutting test settings live in [`config/hermescraft.yaml`](../config/hermescraft.yaml)
at the repo root: MC host, rcon ssh host, bot URL, model defaults, log dir.
Functional tests use **`config.bot.roles.tester`** (`http://localhost:3004`) via the `bot` fixture.

Per-machine divergence via the `$overrides:` block keyed by hostname or by
`$HERMESCRAFT_PROFILE`. See [`bot/lib/config/README.md`](../bot/lib/config/README.md)
for the bot server's separate env-var schema (env vars still override).

## Writing a new test

```python
# tests/functional/test_my_thing.py
import pytest

@pytest.mark.functional
def test_bot_responds_to_health(bot):
    bot.ensure_connected()                # fast path when already connected
    h = bot.get("/health")
    assert h["connected"] is True
```

Need world setup? Inject `arena` (per-test):

```python
@pytest.mark.functional
def test_pickup_after_dig(arena, bot):
    from tests._lib.functional_fixtures import ARENA_FEET_Y
    arena.prep([
        f"execute in {arena.world} run setblock 2 65 4 minecraft:cobblestone",
        "give Tester diamond_pickaxe",
    ])
    arena.place_player(bot, 0, ARENA_FEET_Y, 4, expected_floor_y=64, expected_floor_block="grass_block")
    arena.settle_default()
```

## Adding functional tests (cookbook)

Legacy `scripts/test-*.py` were migrated in Round 3 (2026-05-16). For new tests, follow patterns in [docs/archive/testing-migration.md](../docs/archive/testing-migration.md) and existing files under `tests/functional/`.

## Functional test quality checklist

When adding or tightening a functional test:

1. **Prove the side effect** — not only `ok=true` (use `rcon.block_is`, inventory delta, or position change).
2. **Match error codes to intent** — do not accept unrelated codes (e.g. `NO_LINE_OF_SIGHT` on a timeout scenario).
3. **Avoid masking** — prefer scoped `pytest.xfail()` on a failing assertion segment over whole-test xfail; use `@pytest.mark.skip` for unimplemented specs.
4. **Isolate setup/teardown** — clear terrain you build; verify critical cells after prep when using `/fill` in shared worlds.
5. **Reuse geometry** — import helpers from `tests/_lib/functional_fixtures.py` when the scenario matches an existing pattern (LOS wall, mining grid).
