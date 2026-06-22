"""Tests for card_story offline mode."""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIXTURE_BOARD = REPO / "scripts" / "tests" / "fixtures" / "gv2-run-smoke" / "artifacts" / "board.json"


class TestCardStory(unittest.TestCase):
    def test_card_story_board_json(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            proc = subprocess.run(
                [
                    sys.executable,
                    str(REPO / "scripts" / "card_story.py"),
                    "--board-json",
                    str(FIXTURE_BOARD),
                    "--out",
                    str(out),
                ],
                cwd=REPO,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0)
            self.assertTrue((out / "t_mission.md").is_file())


if __name__ == "__main__":
    unittest.main()
