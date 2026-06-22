"""Motor/fleet metric smoke tests on fixture artifacts."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts.lib.gv2_metrics.fleet import extract_fleet  # noqa: E402
from scripts.lib.gv2_metrics.motor import extract_motor  # noqa: E402

FIXTURE_ART = REPO / "scripts" / "tests" / "fixtures" / "gv2-run-smoke" / "artifacts"


class TestMotorFleetMetrics(unittest.TestCase):
    def test_fleet_bots_from_action_log_stems(self):
        out = extract_fleet(FIXTURE_ART, wall_s=600)
        bots = out.get("bots_used") or []
        self.assertTrue(bots)
        self.assertTrue(all(isinstance(b, str) for b in bots))

    def test_motor_has_repeated_calls_key(self):
        out = extract_motor(FIXTURE_ART)
        self.assertIn("repeated_calls", out)
        self.assertIsInstance(out["repeated_calls"], list)


if __name__ == "__main__":
    unittest.main()
