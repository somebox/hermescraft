"""Unit tests for construct session guard on scripts/kanban complete."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from scripts.lib.construct_kanban_guard import (  # noqa: E402
    api_base_for_profile,
    construct_complete_blocked_on_bot,
    construct_phase_closure_on_bot,
    schematic_construct_card_requires_phase_end,
)


class ConstructKanbanGuardTest(unittest.TestCase):
    def test_api_base_for_profile_barley(self):
        models = json.loads((REPO / "data" / "agent-models.json").read_text())
        barley_port = next(
            (spec["api_port"] for name, spec in models.get("agents", {}).items() if name.lower() == "barley"),
            None,
        )
        self.assertIsNotNone(barley_port)
        base = api_base_for_profile("barley")
        self.assertIsNotNone(base)
        self.assertIn(f":{barley_port}", base or "")

    def test_construct_blocked_when_bot_reports(self):
        payload = json.dumps(
            {
                "ok": True,
                "data": {
                    "construct_complete_blocked": {
                        "code": "CONSTRUCT_SESSION_ACTIVE",
                        "message": "Construct session still active",
                        "next_action_hint": "mc construct end",
                    }
                },
            }
        ).encode()

        class FakeResp:
            def read(self):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with patch(
            "scripts.lib.construct_kanban_guard.api_base_for_profile",
            return_value="http://127.0.0.1:3999",
        ), patch("urllib.request.urlopen", return_value=FakeResp()):
            block = construct_complete_blocked_on_bot("tester")
        self.assertEqual(block.get("code"), "CONSTRUCT_SESSION_ACTIVE")

    def test_construct_not_blocked_when_field_absent(self):
        payload = json.dumps({"ok": True, "data": {"task_context": None}}).encode()

        class FakeResp:
            def read(self):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with patch(
            "scripts.lib.construct_kanban_guard.api_base_for_profile",
            return_value="http://127.0.0.1:3999",
        ), patch("urllib.request.urlopen", return_value=FakeResp()):
            block = construct_complete_blocked_on_bot("tester")
        self.assertIsNone(block)

    def test_schematic_construct_card_detection(self):
        body = "mc task_context set :base: --plan starter_shelter --level 1 --card-kind CONSTRUCT"
        self.assertTrue(
            schematic_construct_card_requires_phase_end("[CONSTRUCT] L1 slab", body)
        )
        self.assertFalse(schematic_construct_card_requires_phase_end("[MINE] ore", "dig at site"))

    def test_construct_blocked_without_phase_closure_on_schematic_card(self):
        payload = json.dumps(
            {"ok": True, "data": {"task_context": None}}
        ).encode()

        class FakeResp:
            def read(self):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with patch(
            "scripts.lib.construct_kanban_guard.api_base_for_profile",
            return_value="http://127.0.0.1:3999",
        ), patch("urllib.request.urlopen", return_value=FakeResp()):
            block = construct_complete_blocked_on_bot(
                "tester",
                card_id="t_1",
                require_schematic_construct_end=True,
            )
        self.assertEqual(block.get("code"), "CONSTRUCT_PHASE_NOT_CLOSED")

    def test_construct_allowed_when_phase_closure_matches_card(self):
        payload = json.dumps(
            {
                "ok": True,
                "data": {
                    "construct_phase_closed": {
                        "card_id": "t_1",
                        "plan_id": "starter_shelter",
                        "phase_key": "L1_slab",
                    }
                },
            }
        ).encode()

        class FakeResp:
            def read(self):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with patch(
            "scripts.lib.construct_kanban_guard.api_base_for_profile",
            return_value="http://127.0.0.1:3999",
        ), patch("urllib.request.urlopen", return_value=FakeResp()):
            block = construct_complete_blocked_on_bot(
                "tester",
                card_id="t_1",
                require_schematic_construct_end=True,
            )
            closure = construct_phase_closure_on_bot("tester", card_id="t_1")
        self.assertIsNone(block)
        self.assertEqual(closure.get("phase_key"), "L1_slab")


if __name__ == "__main__":
    unittest.main()
