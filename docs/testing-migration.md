# Migrating tests to the pytest harness

This is the Round 3 cookbook for converting a `scripts/test-*.py`
functional test into a `tests/functional/test_*.py` pytest test using
the new harness (Round 2 deliverable).

The 44 `scripts/test-*.py` files keep working unchanged until they're
explicitly migrated — there's no flag day. Pick a test, port it,
verify, commit; repeat.

---

## Before / after

### Before — `scripts/test-nav-reachable.py` (227 LOC)

The legacy form. Every test reimplements rcon, http_get, http_post,
hardcodes `ssh ubuntu-host`, hardcodes `http://localhost:3001`, and
uses `print(... PASS/FAIL ...)` instead of assertions:

```python
DEFAULT_BOT_URL = "http://localhost:3001"
WORLD = "landfolk-test"

def rcon(cmd):
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input=cmd + "\n", capture_output=True, text=True, timeout=20,
    )
    return r.stdout.strip()

def setup_mason_trap():
    cmds = [
        f"execute in {WORLD} run difficulty peaceful",
        # ... 8 more rcon commands ...
        "effect give Flint minecraft:saturation 600 1",
    ]
    rcon_batch(cmds)
    time.sleep(1.5)

def scenario_reachable_unreachable(bot_url):
    print("=== A: ... ===")
    setup_mason_trap()
    r = http_post(f"{bot_url}/action/reachable", {"x": 0, "y": 65, "z": 12}, timeout=10)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    passed = (ok and data.get("target_standable") is False and ...)
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed
```

### After — `tests/functional/test_nav_reachable.py` (~100 LOC)

pytest-style: assertions, fixtures, markers, config-driven everything:

```python
@pytest.fixture(scope="module")
def mason_trap(rcon, config, bot):
    bot.wait_until_ready(timeout=10)
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        # ... same 8 rcon commands ...
        "effect give Flint minecraft:saturation 600 1",
    ])
    time.sleep(config["test"]["settle_seconds"])
    yield
    # Cleanup runs on module teardown.
    rcon.batch([
        f"execute in {world} run fill -5 65 5 5 70 18 minecraft:air",
        f"execute in {world} run tp Flint 52 65 52",
    ])

@pytest.mark.functional
def test_reachable_reports_head_blocked_for_unreachable_target(bot, mason_trap):
    r = bot.post("/action/reachable", {"x": 0, "y": 65, "z": 12}, timeout=10)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("target_standable") is False, data
    assert data.get("target_reason") == "head_blocked", data
```

See [`tests/functional/test_nav_reachable.py`](../tests/functional/test_nav_reachable.py)
for the full migrated version.

---

## Conversion cookbook

### 1. The boilerplate goes away

| Legacy pattern | New pattern |
|---|---|
| `subprocess.run(["ssh", "ubuntu-host", "sudo", "docker", ...])` | `rcon.run(cmd)` (from fixture) |
| `subprocess.run(...with rcon batched...)` | `rcon.batch(cmds)` |
| `urllib.request.urlopen(f"{bot_url}/...")` | `bot.get(path)` |
| `urllib.request.Request(url, data=...)` | `bot.post(path, body)` |
| `http_post(.../health...)` poll loop | `bot.wait_until_ready(timeout)` |
| `time.sleep(1.5)  # for perception` | `arena.settle()` (uses config.test.settle_seconds) |
| `DEFAULT_BOT_URL = "http://localhost:3001"` | gone — comes from `config["bot"]["default_api_url"]` |
| `WORLD = "landfolk-test"` | gone — comes from `config["mc"]["world"]` (or `arena.world`) |

### 2. `scenario_*` functions become test functions

Each `def scenario_X(bot_url) -> bool` becomes a `def test_X(bot, ...)`
that uses `assert`. Pytest names matter: prefix with `test_`.

| Legacy | New |
|---|---|
| `def scenario_a(bot_url)` returning `bool` | `def test_a(bot, ...)` raising `AssertionError` |
| `print("PASS" / "FAIL")` | `assert ...`, with a message argument so failures show context |
| `return passed` | (none — pytest sees the assertion) |
| `--only A` CLI arg | `pytest -k test_a` |
| `--bot-url` CLI arg | `HERMESCRAFT_PROFILE` env or `config/hermescraft.yaml.$overrides` |

### 3. Setup helpers become fixtures

A `setup_xxx()` function called inside each scenario becomes either:

- **A module-scoped fixture** (`@pytest.fixture(scope="module")`) when
  multiple tests in one file share the same arena. Yield-style with
  teardown after `yield`. Use when scenarios B/C/D depend on the state
  built by scenario A.
- **A per-test fixture** (default scope) when each test must start
  from a clean slate. Use `arena.clean()` for the canonical blank
  state + your own `arena.prep([rcon cmds...])` for the test-specific
  geometry.

### 4. Error envelopes — extract a tiny helper

The pattern `code, msg, obs = err_fields(r)` is small enough to inline
or to put in a `tests/_lib/util.py` if needed across files. Don't
prematurely abstract — wait until 3+ tests want it.

### 5. The shared setup preamble

Most legacy tests open with this batch:

```python
rcon_batch([
    f"execute in {WORLD} run kill @e[type=!player]",
    f"execute in {WORLD} run difficulty peaceful",
    f"execute in {WORLD} run gamerule doDaylightCycle false",
    f"execute in {WORLD} run time set noon",
    "clear Flint",
    "effect clear Flint",
    "effect give Flint minecraft:saturation 600 1",
])
```

Replace with `arena.clean()` — that's exactly the same preamble plus
optional bbox fill. If your test needs only some of the steps, write the
batch by hand using `rcon.batch([...])`.

### 6. Markers

Every test gets exactly one tier marker:

```python
@pytest.mark.unit         # no MC, no LLM, no network
@pytest.mark.functional   # live MC + bot, no LLM
@pytest.mark.integration  # live MC + bot + LLM key
```

Optional add-ons:

```python
@pytest.mark.slow         # takes >30s — skip in fast feedback loops
```

`pyproject.toml`'s `--strict-markers` will fail typos at collection time.

### 7. Skip vs xfail

Legacy tests sometimes `return True` early when a scenario is
borderline (e.g. distance exactly 1.0). In pytest:

- `pytest.skip("reason")` — the test was inapplicable today (env
  drift, borderline numeric case). Re-runs may pass.
- `pytest.xfail("reason")` — the test is expected to fail (known bug).
  Re-runs are also expected to fail.

Don't `assert True` to fake a pass.

---

## Running the migrated test

```bash
# Once-per-machine setup:
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

# Run all unit tests (fast, no infra):
.venv/bin/pytest -m unit

# Run one functional test (requires live MC + bot at config.bot.default_api_url):
.venv/bin/pytest tests/functional/test_nav_reachable.py -v

# Run all functional, skip slow:
.venv/bin/pytest -m "functional and not slow"

# See what would run without running:
.venv/bin/pytest --collect-only -m functional
```

---

## What NOT to migrate yet

- **`scripts/benchmark/`** (`run.mjs`, `run-two-tier.mjs`) — LLM-only,
  produces leaderboard JSON. Different value model from pytest;
  graph/comparison-oriented. Leave alone.
- **`scripts/g21-orchestrator.py`** (1634 LOC) — multi-bot coordination
  state machine. Drives 2 bot processes + 2 Hermes brains in parallel,
  with phase-keyword chat dispatch. Doesn't map to pytest cleanly.
  Stays under `scripts/`.
- **`scripts/g20-bench.py`** — wraps `agent-test.py` for N-pass
  sampling. May migrate as a pytest plugin in Round 4+ if needed.
- **`scripts/agent-test.py`** itself — Round 3 will turn this into a
  pytest collector (`tests/integration/conftest.py:pytest_collect_file`)
  that surfaces `data/agent-tests/*.yaml` as pytest test cases. Until
  then, run it the old way.

---

## Batch suggestion for Round 3

Per [`docs/test-inventory.md`](test-inventory.md), the 44 functional
tests cluster into rough groups. Migrate by group so a batch can share
fixtures:

| Batch | Tests | Shared fixture |
|---|---|---|
| 1: navigation | `test-nav-reachable`, `test-movement-errors-enriched`, `test-stuck-recenter`, `test-stuck-loop-prevention`, `test-corner-cut-prevention` | trap arena |
| 2: line-of-sight | `test-dig-los`, `test-place-los`, `test-interact-los`, `test-chest-los`, `test-through-los`, `test-goto-near-los`, `test-mine-behind-wall`, `test-attack-through-wall` | wall arena |
| 3: doors | `test-door-pathfind`, `test-door-simple`, `test-through-fresh-door`, `test-through-elevated-door`, `test-through-recovery`, `test-dig-door-support` | door arena |
| 4: mining/pickup | `test-dig-walk-pickup-chain`, `test-mine-collect-grid`, `test-collect-recent-pickup`, `test-collect-underwater`, `test-pickup-blocked` | grid arena |
| 5: action contracts | `test-action-timeouts`, `test-action-reach-pathing`, `test-task-semantics`, `test-recovery-protocols`, `test-inventory-advisories` | reused arena per test |
| 6: predicates | `test-region-predicates`, `test-is-sheltered-wall-check`, `test-movement-precondition`, `test-drown-protection`, `test-flee-no-threat`, `test-inspect` | small per-test arenas |
| 7: miscellany | the remaining ~10 | per-test arenas |

Each batch: pick 1 test to migrate as exemplar, factor out the shared
arena fixture, then port the others using that fixture.
