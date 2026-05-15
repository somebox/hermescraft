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


@pytest.fixture(scope="session")
def bot(config):
    """BotClient for the entire session. NOT waited-on at construction;
    functional tests should call `bot.wait_until_ready()` themselves so unit
    tests in the same run don't spin on a missing bot."""
    return BotClient(config)


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
