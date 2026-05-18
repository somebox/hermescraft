"""Shared pytest fixtures and one-time setup for the HermesCraft test tree.

All session-scoped clients (config, RconClient, BotClient) are constructed
once and reused across the run. The `arena` fixture is per-test and resets
world state on teardown.

Tests targeting different infrastructure should use markers:
    @pytest.mark.unit         no MC, no LLM
    @pytest.mark.functional   live MC + bot at config.bot.default_api_url
    @pytest.mark.integration  live MC + bot + LLM key

Markers are declared in pyproject.toml; --strict-markers forbids typos.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tests._lib import Arena, BotClient, BotTrace, Predicates, RconClient, load_config


@pytest.fixture(scope="session")
def config():
    """Loaded config/hermescraft.yaml. Session-scoped — read once."""
    return load_config()


@pytest.fixture(scope="session")
def run_id() -> str:
    """Per-pytest-invocation identifier, used as the test-log subdir name."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")


@pytest.fixture(scope="session")
def log_dir(config, run_id) -> Path:
    """Per-run log directory under config.logging.dir/tests/<run-id>/. Created on first use."""
    d = Path(config["logging"]["dir"]) / "tests" / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture(scope="session")
def silence_banner(config):
    """If config.test.silence_banner, set LOG_BANNER=0 so bots spawned by tests
    suppress their startup banner. Returns the original value for restoration."""
    original = os.environ.get("LOG_BANNER")
    if config["test"]["silence_banner"]:
        os.environ["LOG_BANNER"] = "0"
    yield original
    if original is None:
        os.environ.pop("LOG_BANNER", None)
    else:
        os.environ["LOG_BANNER"] = original


@pytest.fixture(scope="session")
def rcon(config):
    """RconClient for the entire session. No actual connection at construction —
    rcon-cli is invoked on demand. Tests skipped here will not exercise it."""
    return RconClient(config)


def _resolve_bot_url(config: dict, role: str) -> str:
    """Look up `role` in config.bot.roles, falling back to default_api_url."""
    roles = (config.get("bot") or {}).get("roles") or {}
    if role in roles:
        return roles[role]
    if role == "flint":
        # Flint role is the implicit default — fall back to default_api_url
        # when the roles map omits it. This keeps trivial configs working.
        return config["bot"]["default_api_url"]
    raise KeyError(f"unknown bot role {role!r}; config.bot.roles has {list(roles)}")


@pytest.fixture(scope="session")
def tester_bot(config):
    """Session-scoped Tester bot — the canonical test-only bot at
    config.bot.roles.tester (:3004 by default). Used by all functional
    tests. The dedicated Tester identity keeps test runs isolated from
    the landfolk-scenario bots (Flint, Mason, etc.).

    wait_until_ready is NOT called at construction so unit tests don't
    spin on a missing bot.
    """
    return BotClient(config, base_url=_resolve_bot_url(config, "tester"))


@pytest.fixture(scope="session")
def flint_bot(config):
    """Session-scoped Flint bot — the landfolk-scenario player. Functional
    tests should NOT use this (it interferes with whatever the landfolk
    world is doing with Flint). Kept available for any future test that
    explicitly needs to exercise Flint's identity.
    """
    return BotClient(config, base_url=_resolve_bot_url(config, "flint"))


@pytest.fixture
def bot(tester_bot):
    """Function-scoped bot — always Tester. Tests use this for all
    bot interactions. The `tester_bot` session-scoped fixture is the
    backing client; this wrapper exists so future tests can override
    per-case if needed."""
    return tester_bot


@pytest.fixture
def arena(config, rcon):
    """Per-test world prep/cleanup helper. Use `arena.clean()` to reset state."""
    return Arena(rcon, config)


@pytest.fixture
def predicates():
    """Factory: tests call `predicates(end_state, agent_chat=...)` to construct.
    Returning a factory (not an instance) so tests pick when to snapshot state."""
    def _make(end_state: dict, agent_chat: str = "", mc_verbs: list | None = None, pre_deaths: int = 0):
        return Predicates(
            end_state=end_state,
            agent_chat=agent_chat,
            mc_verbs=mc_verbs,
            pre_deaths=pre_deaths,
        )
    return _make


# ── In-game test announcement (functional tier only) ─────────────────
# When watching the Minecraft server live, broadcast each functional
# test's number + nodeid via rcon `say` AT TEST START — after all fixture
# setup has completed, so the setup rcon commands don't push the
# announcement off the chat log before the test actually runs.
#
# Implementation: pytest_runtest_call hook fires right before the test
# body executes (after all setup fixtures resolve). Skipped for
# unit/integration tiers because (a) unit has no live world, (b)
# integration broadcasts its own LLM-driven chat.

_test_counter = {"n": 0}


def pytest_runtest_call(item):
    """Broadcast the test number + short nodeid via rcon `say` at the
    exact moment the test body is about to execute.

    Resolves the `rcon` and `config` session fixtures via the item's
    `_request`. rcon hiccups are swallowed — the announcement is purely
    for human observation, not a contract.
    """
    if not item.get_closest_marker("functional"):
        return
    try:
        config = item._request.getfixturevalue("config")
        rcon = item._request.getfixturevalue("rcon")
    except Exception:
        return
    _test_counter["n"] += 1
    n = _test_counter["n"]
    short = item.nodeid.split("tests/functional/", 1)[-1]
    world = config["mc"]["world"]
    try:
        rcon.run(f'execute in {world} run say [test #{n}] {short}')
    except Exception:
        pass


# ── Auto bot-position trace (functional tier only) ──────────────────
# Every functional test gets a background poller that snapshots the
# bot's /status?lean=true every 0.4s into <log_dir>/traces/<nodeid>.log.
# When a primitive hangs, the trace shows exactly where the bot stalled.
# Autouse + marker-gate so unit tests don't pay the cost.

# Pre-test rescue — autouse on functional tier. Runs BEFORE the per-test
# arena fixture so every test starts with Tester (a) alive, (b) in creative
# mode invulnerable, (c) actually stationary on a known floor — no
# mid-air races. Previously each fixture had to remember to call
# arena.rescue_tester() and most didn't, so a death cascade in one test
# would leak failing physics state into the next test's setup. See
# arena.rescue_tester docstring for the sequence.
@pytest.fixture(autouse=True)
def _functional_rescue(request, config, rcon, tester_bot):
    """Pre/post test rescue. Functional-tier only.

    Implements steps 2 and 4 of the canonical test sequence:
      1. (per-test fixture) setup test area
      2. PRE: rescue_tester — bot in creative, safe coords, WAIT until
         stationary. Guarantees the test starts against a bot that has
         landed; no more mid-air races.
      3. (per-test fixture) run test
      4. POST: move_to_safe — park bot outside the test arena so its
         geometry doesn't decide the NEXT test's bot fate.
      5. (next test) per-test fixture rebuilds arena
    """
    if not request.node.get_closest_marker("functional"):
        yield
        return
    from tests._lib import Arena
    arena = Arena(rcon, config)
    arena.rescue_tester(bot=tester_bot, wait=True)
    try:
        yield
    finally:
        arena.move_to_safe(bot=tester_bot)


@pytest.fixture(autouse=True)
def bot_trace(request, tester_bot, log_dir):
    """Record bot position throughout each functional test. No-op for
    unit/integration markers."""
    if not request.node.get_closest_marker("functional"):
        yield None
        return
    safe = (
        request.node.nodeid
        .replace("tests/functional/", "")
        .replace("/", "_")
        .replace("::", "__")
        .replace("[", "_")
        .replace("]", "")
    )
    trace_path = log_dir / "traces" / f"{safe}.trace.log"
    trace = BotTrace(tester_bot.base, trace_path)
    trace.start()
    try:
        yield trace
    finally:
        trace.stop()
