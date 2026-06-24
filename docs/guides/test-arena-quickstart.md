# Arena tests quickstart (Tester + landfolk-test)

Short reference for **Tier 3 pytest functional** runs. Full tier map: [test-overview.md](test-overview.md). World layout: [test-world-landfolk.md](test-world-landfolk.md). Harness details: [tests/README.md](../../tests/README.md).

## Server stack

| Piece | Where / how |
|-------|-------------|
| **Paper MC** | Host **`ubuntu-host`**, Docker container **`minecraft`**, TCP **`25565`** |
| **Console (rcon)** | Pytest shells **`ssh ubuntu-host`** → **`docker exec minecraft rcon-cli …`** (`config/hermescraft.yaml` → `rcon.*`) |
| **Test dimension** | Multiverse world **`landfolk-test`** (peaceful, flat; production **`world`** untouched) |
| **Arena** | Harness rebuilds **65×65 grass** at origin each test; **Tester** parked at **`(0, 65, 0)`** |

Per-machine MC/bot URLs: **`config/hermescraft.yaml`** and optional **`$overrides`** keyed by hostname or **`HERMESCRAFT_PROFILE`**.

## Tester bot (local)

| Setting | Value |
|---------|--------|
| Identity | **`Tester`** |
| HTTP API | **`http://localhost:3004`** (`config.bot.roles.tester`; pytest `bot` fixture) |
| MC login target | **`MC_HOST:MC_PORT`** — launcher default **`192.168.1.202:25565`** (`scripts/run-tester-bot.sh`; override with env) |
| Logs | **`/tmp/hermescraft/bot-tester.log`** (default) |

Functional tests drive **HTTP only** (no Hermes agent). Leave **Steve/Flint on `:3001`** running; stop **Tester** only.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt

./scripts/stop-bots.sh Tester
./scripts/run-tester-bot.sh

# recommended before a suite (reaps :3004 orphans + mine_list sentinel)
./scripts/restart-tester.sh
./scripts/run-functional-fast.sh
./scripts/run-functional-core.sh   # @functional_core smoke only

# execution-kernel bulk verbs (dig_area _useKernel, level, wall):
.venv/bin/pytest tests/functional/terrain/test_execution_kernel_bulk.py -v -m functional

# Optional: kernel ordering for clear_strip / level column sweep on the bot process:
# HERMES_EXEC_KERNEL=1 ./scripts/run-tester-bot.sh

# stair egress (stair_down + mc retrace): @slow
.venv/bin/pytest tests/functional/mining/stairs/ -v -m slow

# one test
.venv/bin/pytest tests/functional/mining/test_foo.py::test_name -v
./scripts/combat-suite.sh           # combat @slow only
```

Harness **`mvtp Tester landfolk-test`** + rescue runs automatically; do not use **`stop-bots.sh --all`** mid-suite.

## Model / LLM (when it applies)

| Run type | Model |
|----------|--------|
| **`@pytest.mark.functional`** | **None** — bot action layer via Tester HTTP API |
| **`@pytest.mark.integration`** (e.g. perception digest) | OpenRouter: **`OPENROUTER_API_KEY`** or **`secrets.yaml`** → `openrouter_api_key`. Model: **`DIGEST_MODEL`** env, else code default **`deepseek/deepseek-v4-flash`** (`tests/_lib/openrouter.py`). Config also documents **`models.integration_default`** (`google/gemini-2.5-flash`) for future integration tests — not all integration paths read it yet. |
| **Agent YAML** (`scripts/agent-test.py`, Tier 4) | Default **`google/gemini-2.5-flash`** (`DEFAULT_MODEL` in script). Override: **`--model`**, or **`model:`** in the YAML spec. Hermes launched with **`-m <model>`**. Uses **Flint `:3001`** by default, not Tester. See [test-agent-llm-runbook.md](test-agent-llm-runbook.md). |

Functional arena work does **not** need an API key. Integration/agent tiers do.

## See also

- Tier 2 rcon-only fixtures (no bot): `scripts/run-fixture.sh prep|cleanup data/test-fixtures/…`
- Blueprint plan paste/capture (RCON, no bot): [`place-schematic-rcon.py`](../../scripts/place-schematic-rcon.py), [`capture-schematic-rcon.py`](../../scripts/capture-schematic-rcon.py) — [`blueprints-grabcraft.md`](../specs/world/blueprints-grabcraft.md) (Terminology + RCON section)
- Coord check: `python3 scripts/check-arena-coords.py --strict`
