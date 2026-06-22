"""Tests for evidence arm defaults and kanban export helpers."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import genesis2_lib as g2  # noqa: E402


class TestEvidenceArm(unittest.TestCase):
    def test_default_evidence_arm_emergent(self):
        arm = g2.default_evidence_arm(
            {
                "tier": "standard",
                "worker_model": "xiaomi/mimo-v2.5",
                "planner_model": "xiaomi/mimo-v2.5",
                "mode": "emergent",
            }
        )
        self.assertEqual(arm, "standard/mimo-v2.5/emergent")

    def test_default_evidence_arm_pinned_spawn(self):
        arm = g2.default_evidence_arm(
            {
                "tier": "standard",
                "worker_model": "mimo-v2.5",
                "mode": "emergent",
                "spawn_source": "pinned",
                "spawn": {"x": 0, "y": 69, "z": 0},
            }
        )
        self.assertIn("spawn-0,69,0", arm)


if __name__ == "__main__":
    unittest.main()
