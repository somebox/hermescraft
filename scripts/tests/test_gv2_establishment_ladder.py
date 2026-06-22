"""Tests for gv2 establishment ladder."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))

from lib.gv2_establishment_ladder import evaluate_run_dir, format_one_line  # noqa: E402

FIXTURE = REPO / "scripts" / "tests" / "fixtures" / "gv2-run-smoke"


class TestEstablishmentLadder(unittest.TestCase):
    def test_fixture_establishment_score(self):
        result = evaluate_run_dir(FIXTURE)
        self.assertEqual(result["max"], 6)
        self.assertGreaterEqual(result["score"], 3.0)
        line = format_one_line(result)
        self.assertTrue(line.startswith("establishment: score="))

    def test_milestones_present(self):
        result = evaluate_run_dir(FIXTURE)
        ms = result["milestones"]
        self.assertEqual(ms["site"], "yes")
        self.assertIn(ms["chest"], ("yes", "partial"))


if __name__ == "__main__":
    unittest.main()
