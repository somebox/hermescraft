"""Dashboard render smoke test."""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "scripts" / "tests" / "fixtures" / "gv2-run-smoke"


class TestRenderDashboard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = {**os.environ, "GV2_SCORE_SKIP_SMOKE": "1"}
        subprocess.run(
            [sys.executable, str(REPO / "scripts" / "gv2-score-run.py"), "--run-dir", str(FIXTURE)],
            cwd=REPO,
            check=True,
            env=env,
        )

    def test_html_contains_run_id(self):
        html = (FIXTURE / "dashboard" / "index.html").read_text()
        self.assertIn("fixture", html)
        self.assertIn("Operational", html)
        self.assertIn("fleet index", html)


if __name__ == "__main__":
    unittest.main()
