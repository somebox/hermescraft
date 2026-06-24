"""G1 — per-agent bot_env from data/agent-models.json (Mason construct pilot)."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
RESOLVE = REPO / "scripts" / "resolve-agent-model.py"
MODELS = REPO / "data" / "agent-models.json"


def _load():
    spec = importlib.util.spec_from_file_location("resolve_agent_model", RESOLVE)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class ResolveBotEnvTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = _load()

    def test_mason_construct_flag(self) -> None:
        env = self.mod.resolve_bot_env("Mason", MODELS)
        self.assertEqual(env.get("HERMES_CONSTRUCT_CONTEXT"), "1")

    def test_flint_no_bot_env(self) -> None:
        env = self.mod.resolve_bot_env("Flint", MODELS)
        self.assertEqual(env, {})

    def test_cli_bot_env_json(self) -> None:
        out = subprocess.check_output(
            [sys.executable, str(RESOLVE), "bot-env", "Mason", str(MODELS)],
            text=True,
        )
        parsed = json.loads(out)
        self.assertEqual(parsed, {"HERMES_CONSTRUCT_CONTEXT": "1"})


if __name__ == "__main__":
    unittest.main()
