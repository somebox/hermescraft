"""Shared pytest harness primitives for HermesCraft.

Tests under tests/ import these to avoid the duplication that grew across
the 44 scripts/test-*.py files (each reimplementing rcon, http_get,
http_post, and the same setup preamble).

Modules:
    config       — load config/hermescraft.yaml with per-host overrides
    rcon         — RconClient: rcon-cli over ssh+docker
    bot          — BotClient: HTTP wrapper for the bot's API
    arena        — Arena: world prep / cleanup using a blank-slate convention
    predicates   — Predicates: predicate evaluator extracted from agent-test.py
    fixture_loader — read the existing data/test-fixtures/**/*.yaml schema
"""

from .arena import Arena
from .bot import BotClient
from .config import load_config
from .fixture_loader import Fixture, load_fixture
from .predicates import PredicateResult, Predicates
from .rcon import RconClient
from .trace import BotTrace
from .util import extract_error

__all__ = [
    "Arena",
    "BotClient",
    "BotTrace",
    "Fixture",
    "PredicateResult",
    "Predicates",
    "RconClient",
    "extract_error",
    "load_config",
    "load_fixture",
]
