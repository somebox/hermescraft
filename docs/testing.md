# Testing — what to run, when

HermesCraft has five tiers of tests with different prerequisites and
runtimes. Only Tier 1 runs in CI today; the rest are manual / local.

**Related documents:**
- [`docs/test-inventory.md`](test-inventory.md) — per-test catalog (overlaps, gaps, validation notes)
- [`docs/testing-migration.md`](testing-migration.md) — porting `scripts/test-*.py` to the pytest harness
- [`config/hermescraft.yaml`](../config/hermescraft.yaml) — central MC/rcon/bot/model/logging config
- [`tests/README.md`](../tests/README.md) — pytest tree overview
- [`bot/lib/config/README.md`](../bot/lib/config/README.md) — bot server's env-var schema

| Tier | What | Time | Prerequisites | CI? |
|---|---|---|---|---|
| 1 | Node unit tests (`bot/test/`) | ~0.5 s | none | ✅ on every push |
| 2 | Fixture preps | seconds | MC server (rcon) | manual |
| 3 | Python integration tests (`scripts/test-*.py`) | seconds–minutes | MC server + bot server | manual |
| 4 | Agent tests (behavior fixtures B1–B4) | minutes | MC + bot + LLM API key | manual / exploratory |
| 5 | Benchmark suite (`scripts/benchmark/`) | minutes | OpenRouter key | manual |

---

## Tier 1 — Node unit tests

Pure JS logic. No Minecraft server, no bot running, no external dependencies.

```bash
cd bot && npm test
```

23 test files, ~113 cases, runs under a second. Uses Node's built-in
`node:test` + `node:assert/strict`.

Includes a **contract test** (`bot/test/cli-action-sync.test.js`) that
asserts every CLI command in `bot/cli/registry.mjs` has a matching async
handler in `bot/lib/actions/*.js`. This is the gate that catches drift
between the CLI and the server during refactors.

CI: `.github/workflows/ci.yml` runs this on every push + PR, plus
`node --check bot/server.js` and `bash -n` on the main launch scripts.

## Tier 2 — Fixture preps

YAML files under `data/test-fixtures/{L0,L3,L8,L9,L10}/` describe world
state for integration scenarios (block layouts, mob spawns, bot starting
position). `scripts/run-fixture.sh` reads the `prep:` / `cleanup:`
sections and runs them via rcon against a Paper server.

```bash
scripts/run-fixture.sh prep    data/test-fixtures/L0/L0.1_health_connected.yaml
scripts/run-fixture.sh cleanup data/test-fixtures/L0/L0.1_health_connected.yaml
```

Requires SSH to the host running the Paper server (default `ubuntu-host`
docker exec → rcon-cli). No bot needed — this only manipulates the world.

## Tier 3 — Python functional tests (pytest)

`tests/functional/test_*.py` (~30 files) — regression tests for the
bot's behavior contracts (pathfinding, mining LOS, recovery protocols,
task semantics, …). Each test sets up world state via rcon, drives the
bot via its HTTP API, and asserts inventory/position state plus error
envelopes.

**Bot URL is config-driven** via `config/hermescraft.yaml`. All
functional tests use the dedicated **Tester bot at `localhost:3004`**
(`config.bot.roles.tester`) — the `bot` pytest fixture is hard-wired
to it. Flint (`localhost:3001`) keeps running for the landfolk scenario
but the test suite never touches it, which prevents test-driven world
edits from interfering with whatever Flint is doing.

```bash
# Run the entire functional suite:
pytest -m functional

# Filter:
pytest -m functional -k mine             # only "mine"-named tests
pytest -m "functional and not slow"      # skip @pytest.mark.slow tests

# Single file or test:
pytest tests/functional/test_nav_reachable.py -v
pytest tests/functional/test_dig_los.py::test_dig_refused_when_target_behind_wall
```

The harness in `tests/_lib/` provides:
- `rcon`/`bot` clients (session-scoped, config-driven URLs)
- `arena` (function-scoped helper for flat-arena / forceload / settle)
- `extract_error()` for normalizing error envelopes
- `bot.inventory_delta()` / `bot.position()` for state polling

In-game **test announcements** broadcast via rcon `say` right before
each functional test's body runs ("[test #N] file::test_name") — visible
in MC chat / server console / spectator overlay.

Pytest exit codes: 0 = all pass (xfail/xpass don't fail the suite),
non-zero = at least one real failure.

These are **not** in CI because they require live infrastructure. Run
them locally after any change to bot behavior, especially:
- `bot/lib/actions/*.js`
- `bot/lib/runtime/{manager,reactive,dig-tools,paper-mcp}.js`
- `bot/lib/server/http-app.js`

## Tier 4 — Agent (behavior) tests

`data/test-fixtures/behavior/B1_*.yaml` … `B4_*.yaml` describe
multi-step composition tasks (e.g. "fetch raw_iron, smelt to ingot") and
expected end states. `scripts/agent-test.py` drives a Hermes agent
through the scenario and grades the outcome.

```bash
scripts/agent-test.py --model deepseek/deepseek-v4-flash \
  data/test-fixtures/behavior/B1_fetch_smelt_basic.yaml
```

Requires: MC server, bot server, LLM key (OPENROUTER_API_KEY or
ANTHROPIC_API_KEY in `$HOME/.hermes/.env`). Each run on the cheap default
costs cents and takes several minutes; premium models (claude-sonnet-4,
gpt-5) cost ~30× more per run.

Results land in `data/agent-tests/runs/<test_id>-<timestamp>.json`.

## Tier 5 — Benchmark suite

`scripts/benchmark/run.mjs` drives an LLM through command-composition
tasks defined in `scripts/benchmark/tasks/*.json` and grades the
generated `mc` commands against gold answers. **No Minecraft server
required** — the harness simulates the world.

```bash
node scripts/benchmark/run.mjs --model deepseek/deepseek-v4-flash
```

Requires `secrets.yaml` with an `openrouter_api_key` (see
`secrets.example.yaml`). Results go to
`scripts/benchmark/runs/<model_slug>/<timestamp>-realistic.json`.

`scripts/benchmark/leaderboard.mjs` aggregates past runs into a
markdown leaderboard.

---

## Refactor safety guidance

| Touching… | Always run | Recommended | If time |
|---|---|---|---|
| `bot/lib/config/`, `bot/server.js` imports | Tier 1 | Tier 3 smoke | – |
| `bot/lib/actions/*.js` | Tier 1 | Tier 3 (relevant scenarios) | Tier 4 |
| `bot/lib/runtime/dig-tools.js`, `mining.js` | Tier 1 | `scripts/test-mine-*.py`, `scripts/test-dig-*.py` | – |
| `bot/cli/`, `bot/lib/server/http-app.js` | Tier 1 (incl. cli-action-sync) | `scripts/test-action-timeouts.py` | – |
| Prompts / SOULs (`prompts/*.md`, `SOUL-*.md`) | – | Tier 4 | Tier 5 |
| `data/test-fixtures/` | bash -n the fixture | run the affected Tier 3 test | – |

**Rule of thumb:** Tier 1 must stay green after every commit. Tier 3 is
the safety net for any behavior-touching change. Tiers 4 and 5 are
exploratory — useful before merging a meaningful agent-behavior change,
overkill for refactors that don't change semantics.
