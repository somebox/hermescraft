"""Reserved Tester port vs landfolk agent-models.json."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from scripts.lib.port_registry import (  # noqa: E402
    TESTER_API_PORT,
    TESTER_MC_USERNAME,
    assert_no_tester_port_collision,
    filter_scenario_evac_names,
    is_test_mc_username,
    landfolk_api_ports,
)


class PortRegistryTest(unittest.TestCase):
    def test_no_landfolk_tester_port_collision(self) -> None:
        assert_no_tester_port_collision()
        ports = landfolk_api_ports()
        self.assertEqual(ports.get("Barley"), 3008)
        self.assertNotIn(TESTER_API_PORT, set(ports.values()))

    def test_tester_username_filter(self) -> None:
        self.assertTrue(is_test_mc_username("Tester"))
        self.assertTrue(is_test_mc_username("tester"))
        self.assertFalse(is_test_mc_username("Barley"))

    def test_scenario_evac_excludes_tester(self) -> None:
        out = filter_scenario_evac_names(["Flint", "Tester", "Mason"])
        self.assertEqual(out, ["Flint", "Mason"])


if __name__ == "__main__":
    unittest.main()
