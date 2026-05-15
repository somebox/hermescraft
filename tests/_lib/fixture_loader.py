"""FixtureLoader — read the existing data/test-fixtures/**/*.yaml schema.

The fixture YAML format predates this harness and is documented at
scripts/agent-test.py:8–29. Notable keys:

    agent_test_id: P1_mixed_blocks         # used as the run identifier
    world: landfolk-test                   # MC dimension (rcon `execute in`)
    prompt: "natural-language goal"        # for integration (LLM-driven) tests
    skills: [minecraft-survival, ...]      # Hermes skill preloads
    model: openrouter/google/gemini-flash  # optional model pin
    max_turns: 6                           # optional cap
    timeout_seconds: 120                   # optional timeout
    prep: [<rcon cmd>, ...]                # world setup
    cleanup: [<rcon cmd>, ...]             # world teardown
    expect:                                # predicate dict (see Predicates)
        bot_at: {x: 0, y: 65, z: 6, range: 2}
        bot_inventory: {stone_pickaxe: 1, cobblestone: ">=3"}
        ...

This loader returns the dict mostly as-is. Round 3 will move agent-test.py
onto it and use pytest_collect_file() to surface YAMLs as pytest test cases.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


class Fixture:
    """Parsed YAML fixture. All keys are optional; missing ones return defaults."""

    def __init__(self, path: Path, data: dict[str, Any]):
        self.path = path
        self.data = data or {}

    @property
    def test_id(self) -> str:
        return self.data.get("agent_test_id") or self.path.stem

    @property
    def world(self) -> str | None:
        return self.data.get("world")

    @property
    def prompt(self) -> str:
        return self.data.get("prompt") or ""

    @property
    def prep(self) -> list[str]:
        return list(self.data.get("prep") or [])

    @property
    def cleanup(self) -> list[str]:
        return list(self.data.get("cleanup") or [])

    @property
    def expect(self) -> dict[str, Any]:
        return self.data.get("expect") or {}

    @property
    def model(self) -> str | None:
        return self.data.get("model")

    @property
    def max_turns(self) -> int | None:
        v = self.data.get("max_turns")
        return int(v) if v is not None else None

    @property
    def timeout_seconds(self) -> int | None:
        v = self.data.get("timeout_seconds")
        return int(v) if v is not None else None


def load_fixture(path: Path | str) -> Fixture:
    p = Path(path)
    with open(p) as f:
        data = yaml.safe_load(f) or {}
    return Fixture(p, data)
