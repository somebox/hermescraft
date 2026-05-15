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

from tests._lib import Arena, BotClient, Predicates, RconClient, load_config


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
def flint_bot(config):
    """Session-scoped Flint bot. Used by session- or module-scoped fixtures
    that need a stable BotClient reference (the function-scoped `bot`
    fixture below would cause ScopeMismatch when consumed from broader
    scopes). Most tests should consume `bot` instead.
    """
    return BotClient(config, base_url=_resolve_bot_url(config, "flint"))


@pytest.fixture(scope="session")
def tester_bot(config):
    """Session-scoped Tester bot. Symmetric to `flint_bot` for module-
    scoped fixtures that explicitly target the Tester role."""
    return BotClient(config, base_url=_resolve_bot_url(config, "tester"))


@pytest.fixture
def bot(config, request, flint_bot, tester_bot):
    """Role-aware function-scoped bot. Returns `tester_bot` when the test
    declares `@pytest.mark.tester`, else `flint_bot`. Function-scoped so
    role switching is per-test without rebuilding the client.

    Note: wait_until_ready is NOT called at construction — tests should
    call it themselves so unit tests sharing the same session don't spin
    on a missing bot.
    """
    if request.node.get_closest_marker("tester"):
        return tester_bot
    return flint_bot


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
# When watching the Minecraft server live, an autouse fixture broadcasts
# the test number + name via rcon `say` at the start of each functional
# test. This shows up in MC chat / server console / spectator overlay,
# making it easy to correlate in-world events with which pytest case
# is running. Skipped for unit/integration tiers because (a) unit has
# no live world, (b) integration broadcasts its own LLM-driven chat.

_test_counter = {"n": 0}


@pytest.fixture(autouse=True)
def _announce_functional_test(request, rcon, config):
    """Broadcast the test number + nodeid via rcon `say` at start of every
    functional-tier test. No-op for non-functional tests."""
    if not request.node.get_closest_marker("functional"):
        return
    _test_counter["n"] += 1
    n = _test_counter["n"]
    # `request.node.nodeid` is "tests/functional/test_foo.py::test_bar".
    # Keep the in-game broadcast short — drop the directory prefix.
    nodeid = request.node.nodeid
    short = nodeid.split("tests/functional/", 1)[-1]
    world = config["mc"]["world"]
    try:
        rcon.run(f'execute in {world} run say [test #{n}] {short}')
    except Exception:
        # rcon hiccup shouldn't fail the test — the announcement is
        # purely for human observation.
        pass
