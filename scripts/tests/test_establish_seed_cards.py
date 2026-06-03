"""Hermetic tests for establish-seed-cards explore assignee default."""
from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]


def _load_seed_module():
    path = REPO / "scripts" / "establish-seed-cards.py"
    loader = SourceFileLoader("establish_seed_cards", str(path))
    spec = importlib.util.spec_from_loader("establish_seed_cards", loader)
    assert spec
    mod = importlib.util.module_from_spec(spec)
    sys.modules["establish_seed_cards"] = mod
    loader.exec_module(mod)
    return mod


class TestEstablishSeedCards(unittest.TestCase):
    def test_explore_cards_default_assignee_orchestrator_tracker(self):
        seed_mod = _load_seed_module()
        map_data = {
            "seed": 1001,
            "spawn": [0, 97, 24],
            "muster": [0, 97, 24],
            "starter_chest": [1, 97, 24],
        }
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            map_path = Path(td) / "map.json"
            map_path.write_text(json.dumps(map_data), encoding="utf-8")
            calls: list[list[str]] = []

            def fake_run_kanban(args: list[str]) -> dict:
                calls.append(list(args))
                if args[0] == "add-epic":
                    return {"id": "t_epic1"}
                if args[0] == "add":
                    return {"id": f"t_card{len(calls)}"}
                if args[0] == "reassign":
                    return {}
                return {}

            with patch.object(seed_mod, "_run_kanban", fake_run_kanban):
                with patch.object(
                    sys,
                    "argv",
                    ["establish-seed-cards.py", "--map", str(map_path), "--explore-cards"],
                ):
                    buf = StringIO()
                    with redirect_stdout(buf):
                        self.assertEqual(seed_mod.main(), 0)

            explore_adds = [c for c in calls if c and c[0] == "add"]
            self.assertEqual(len(explore_adds), 4)
            for cmd in explore_adds:
                idx = cmd.index("--assignee")
                self.assertEqual(cmd[idx + 1], "orchestrator-tracker")


if __name__ == "__main__":
    unittest.main()
