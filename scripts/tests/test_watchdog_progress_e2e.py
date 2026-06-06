"""P1-7b: lean observe → progress lines with pos → AUTO_STUCK can fire."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

import importlib.util

from scripts.lib.watchdog_progress_emit import emit_progress_line  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "auto_stuck_check",
    REPO / "scripts" / "auto-stuck-check.py",
)
_mod = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
sys.modules[_spec.name] = _mod
_spec.loader.exec_module(_mod)
detect_auto_stuck = _mod.detect_auto_stuck


class TestWatchdogProgressE2e(unittest.TestCase):
    def test_four_ticks_identical_recent_and_pos_triggers_auto_stuck(self):
        observe = {
            "ok": True,
            "state": {
                "position": {"x": -3.2, "y": 68.9, "z": 53.1},
            },
            "recent_actions": [
                {"action": "goto_near", "status": "error"},
                {"action": "collect", "status": "error"},
                {"action": "tunnel", "status": "error"},
                {"action": "move", "status": "error"},
            ],
        }
        lines = []
        for rnd in range(1, 5):
            line = emit_progress_line(observe, "steward")
            self.assertTrue(line)
            entry = json.loads(line)
            entry["round"] = rnd
            lines.append(entry)
            self.assertIsNotNone(entry.get("pos"), "pos must be non-null for PR-S")

        sig = detect_auto_stuck(lines, threshold=4)
        self.assertIsNotNone(sig)
        assert sig is not None
        self.assertEqual(sig.position, {"x": -3, "y": 68, "z": 53})
        self.assertEqual(
            sig.recent_tuple,
            ["goto_near:error", "collect:error", "tunnel:error", "move:error"],
        )

    def test_progress_log_roundtrip(self):
        observe = {
            "state": {"position": {"x": 1, "y": 2, "z": 3}},
            "recent_actions": [{"action": "move", "status": "error"}] * 4,
        }
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "progress-steward.log"
            with path.open("a") as fh:
                for rnd in range(4):
                    fh.write(emit_progress_line(observe, "steward") + "\n")
            entries = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
            for i, e in enumerate(entries, 1):
                e["round"] = i
            self.assertIsNotNone(detect_auto_stuck(entries, threshold=4))


if __name__ == "__main__":
    unittest.main()
