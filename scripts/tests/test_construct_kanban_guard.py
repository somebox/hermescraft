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
)


class ConstructKanbanGuardTest(unittest.TestCase):
    def test_api_base_for_profile_barley(self):
        base = api_base_for_profile("barley")
        self.assertIsNotNone(base)
        self.assertIn(":3004", base or "")

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


if __name__ == "__main__":
    unittest.main()
