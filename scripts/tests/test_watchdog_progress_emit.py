"""P0-1: watchdog progress emitter reads lean observe state.position."""

import json
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts.lib.watchdog_progress_emit import progress_snapshot_from_observe  # noqa: E402


class TestWatchdogProgressEmit(unittest.TestCase):
    def test_lean_observe_state_position(self):
        observe = {
            "ok": True,
            "state": {
                "position": {"x": 5.5, "y": 78.9, "z": 24.7},
                "health": 20,
            },
            "recent_actions": [
                {"action": "move", "status": "error"},
                {"action": "goto_near", "status": "error"},
            ],
        }
        snap = progress_snapshot_from_observe(observe, "mason")
        self.assertIsNotNone(snap)
        assert snap is not None
        self.assertEqual(snap["pos"], {"x": 5, "y": 78, "z": 24})
        self.assertEqual(snap["recent"], ["move:error", "goto_near:error"])

    def test_top_level_position_fallback(self):
        observe = {
            "position": {"x": 1, "y": 2, "z": 3},
            "recent_actions": [],
        }
        snap = progress_snapshot_from_observe(observe, "flint")
        self.assertEqual(snap["pos"], {"x": 1, "y": 2, "z": 3})

    def test_no_position_yields_null_pos(self):
        observe = {"state": {"health": 20}, "recent_actions": []}
        snap = progress_snapshot_from_observe(observe, "steward")
        self.assertIsNone(snap["pos"])

    def test_agent_loop_observe_shape_state_position_only(self):
        """Agent-loop GET /observe (non-lean) — no top-level position key."""
        observe = {
            "ok": True,
            "state": {"position": {"x": 15.2, "y": 77.8, "z": 56.1}, "health": 20},
            "recent_actions": [{"action": "move", "status": "error"}],
            "goals": [{"id": "g1"}],
        }
        snap = progress_snapshot_from_observe(observe, "steward")
        assert snap is not None
        self.assertEqual(snap["pos"], {"x": 15, "y": 77, "z": 56})


if __name__ == "__main__":
    unittest.main()
