# Testing — what to run, when

HermesCraft has five tiers of tests with different prerequisites and
runtimes. Only Tier 1 runs in CI today; the rest are manual / local.

**Related documents:**
- [`docs/archive/test-inventory.md`](../archive/test-inventory.md) — per-test catalog (overlaps, gaps, validation notes)
- [`docs/archive/testing-migration.md`](../archive/testing-migration.md) — pytest migration cookbook (Round 3 complete)
- [`config/hermescraft.yaml`](../../config/hermescraft.yaml) — central MC/rcon/bot/model/logging config
- [`tests/README.md`](../../tests/README.md) — pytest tree overview
- [`bot/lib/config/README.md`](../../bot/lib/config/README.md) — bot server's env-var schema

| Tier | What | Time | Prerequisites | CI? |
|---|---|---|---|---|
| 1 | Node unit tests (`bot/test/`) | ~0.5 s | none | ✅ on every push |
| 2 | Fixture preps | seconds | MC server (rcon) | manual |
| 3 | Python functional tests (`tests/functional/`) | seconds–minutes | MC server + Tester bot (port 3004) | manual |
| 4 | Agent tests (behavior fixtures B1–B4) | minutes | MC + bot + LLM API key | manual / exploratory |
| 5 | Benchmark suite (`scripts/benchmark/`) | minutes | OpenRouter key | manual |

---

## Tier 1 — Node unit tests

Pure JS logic. No Minecraft server, no bot running, no external dependencies.

```bash
cd bot && npm test
```

45 test files under `bot/test/` (including `bot/test/cli/` and integration cases), **438** tests in the default `npm test` run (~15–20 s locally). Uses Node's built-in
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

**Tier 2 boundary:** legacy YAML (including remaining agent-driven L3 combat
fixtures and non-combat L0/L5/…) still uses the `(52, 65, 52)` safe-home
and slow-fall TPs from the combat-suite era. Those files are not subject to
the canonical pytest arena coord rules until migrated. Migrated reactive combat
lives in `tests/functional/combat/` on the `(0, 65, 0)` harness.

```bash
scripts/run-fixture.sh prep    data/test-fixtures/L0/L0.1_health_connected.yaml
scripts/run-fixture.sh cleanup data/test-fixtures/L0/L0.1_health_connected.yaml
```

Requires SSH to the host running the Paper server (default `ubuntu-host`
docker exec → rcon-cli). No bot needed — this only manipulates the world.

## Tier 3 — Python functional tests (pytest)

**Quick reference:** [arena-tests-quickstart.md](arena-tests-quickstart.md) — Tester on `:3004`, `ubuntu-host` / `minecraft` rcon, `landfolk-test` arena, model notes.

`tests/functional/` — pytest modules including `functional/combat/` (9 reactive
L3 scenarios, `@slow`), `functional/mining/`, and nested stairs/water cases.
Regression tests for the bot's behavior contracts (pathfinding, mining LOS,
reactive combat, recovery protocols, task semantics, …). Each test sets up
world state via rcon, drives the bot via its HTTP API, and asserts
inventory/position state plus error envelopes.

**Bot URL is config-driven** via `config/hermescraft.yaml`. All
functional tests use the dedicated **Tester bot at `localhost:3004`**
(`config.bot.roles.tester`) — the `bot` pytest fixture is hard-wired
to it. Flint (`localhost:3001`) keeps running for the landfolk scenario
but the test suite never touches it, which prevents test-driven world
edits from interfering with whatever Flint is doing.

```bash
# Arena runs: stop/start Tester only (Steve on :3001 stays up).
./scripts/stop-bots.sh Tester
./scripts/run-tester-bot.sh

# Profiles (stop Tester, start Tester, then pytest):
./scripts/run-functional-fast.sh   # functional, not slow, not integration
./scripts/run-functional-full.sh   # all functional (excludes integration)
./scripts/combat-suite.sh          # combat subset only (@slow)

# Run functional tests (excludes @integration):
pytest -m "functional and not integration"

# Filter:
pytest -m functional -k mine             # only "mine"-named tests
pytest -m "functional and not slow"      # skip @pytest.mark.slow tests
pytest -m "functional and slow" tests/functional/combat
```

`tests/integration/` uses the same `_functional_harness` reset/park/trace but
requires `@pytest.mark.integration` and an LLM key (not collected by the
functional runner scripts).

```bash
pytest -m integration
```

The harness in `tests/_lib/` provides:
- Session `lay_ground_substrate_session` + per-test `reset_ground_arena` (65×65 grass at y=64, origin observer point)
- `rcon`/`bot` clients (session-scoped, config-driven URLs)
- `arena` (`place_player`, settle profiles, `load_prefab` / `/clone` vault)
- `functional_fixtures` (canonical `ARENA_*` / zone constants, LOS helpers, `bake_prefabs_session`)
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

YAML specs under `data/agent-tests/` (F/G/P/M classes) describe multi-step
tasks and expected predicates. `scripts/agent-test.py` drives a Hermes agent
through the scenario and grades the outcome. See [agent-tests.md](agent-tests.md).

```bash
python3 scripts/agent-test.py data/agent-tests/F2_phantom_search.yaml
python3 scripts/agent-test.py --model deepseek/deepseek-v4-flash \
  data/agent-tests/G1_stone_pickaxe.yaml
```

Smaller **B1–B4** composition fixtures live under
`data/test-fixtures/behavior/` (same runner, narrower smelt/fetch scenarios).

Requires: MC server, bot server (default Flint on port 3001 for many specs;
Tester on 3004 for others — check each YAML), LLM key (`OPENROUTER_API_KEY` or
`ANTHROPIC_API_KEY` in `$HOME/.hermes/.env`).

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
| `bot/lib/runtime/dig-tools.js`, `mining.js` | Tier 1 | `pytest -m functional -k dig` or `-k mine` | – |
| `bot/cli/`, `bot/lib/server/http-app.js` | Tier 1 (incl. cli-action-sync) | `pytest -m functional` smoke on affected areas | – |
| Prompts / SOULs (`prompts/*.md`, `SOUL-*.md`) | – | Tier 4 | Tier 5 |
| `data/test-fixtures/` | bash -n the fixture | run the affected Tier 3 test | – |

**Rule of thumb:** Tier 1 must stay green after every commit. Tier 3 is
the safety net for any behavior-touching change. Tiers 4 and 5 are
exploratory — useful before merging a meaningful agent-behavior change,
overkill for refactors that don't change semantics.
