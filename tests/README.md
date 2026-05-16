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
  fixtures/              YAML world-prep files (Round 3 will migrate data/test-fixtures/)
```

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
```

## Running

```bash
.venv/bin/pytest -m unit                  # fast, no infra
.venv/bin/pytest -m functional            # needs MC server + running bot
.venv/bin/pytest -m integration           # needs MC + bot + LLM key
.venv/bin/pytest -m "not slow"            # skip the heavy ones
.venv/bin/pytest --collect-only           # see what's there without running
.venv/bin/pytest tests/unit/test_smoke.py # one file
```

## Configuration

All cross-cutting test settings live in [`config/hermescraft.yaml`](../config/hermescraft.yaml)
at the repo root: MC host, rcon ssh host, bot URL, model defaults, log dir.
Per-machine divergence via the `$overrides:` block keyed by hostname or by
`$HERMESCRAFT_PROFILE`. See [`bot/lib/config/README.md`](../bot/lib/config/README.md)
for the bot server's separate env-var schema (env vars still override).

## Writing a new test

```python
# tests/functional/test_my_thing.py
import pytest

@pytest.mark.functional
def test_bot_responds_to_health(bot):
    bot.wait_until_ready()                # blocks until /health says connected
    h = bot.get("/health")
    assert h["connected"] is True
```

Need world setup? Inject `arena` (per-test):

```python
@pytest.mark.functional
def test_pickup_after_dig(arena, bot):
    arena.clean()                              # canonical blank slate
    arena.prep([                               # custom rcon prep
        f"execute in {arena.world} run setblock 0 65 5 cobblestone",
        "give Tester diamond_pickaxe",
    ])
    arena.teleport_bot(0, 65, 4)
    arena.settle()                             # let perception catch up
    # ... drive the bot via `bot.post(...)`, observe via `bot.observe()`
```

## Migrating an existing `scripts/test-*.py`

See [`docs/testing-migration.md`](../docs/testing-migration.md) (Round 2 deliverable).

The existing `scripts/test-*.py` continue to work unchanged. Migration happens
in batches in Round 3.
