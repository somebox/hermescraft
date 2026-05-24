import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from locations_prune import prune_locations


class TestLocationsPrune(unittest.TestCase):
    def test_removes_all_deaths_by_default(self):
        locs = {
            "home": {"x": 1, "y": 2, "z": 3},
            "death_1": {"x": 0, "y": 0, "z": 0},
            "death_99": {"x": 1, "y": 1, "z": 1},
        }
        out, stats = prune_locations(locs)
        self.assertNotIn("death_1", out)
        self.assertNotIn("death_99", out)
        self.assertIn("home", out)
        self.assertEqual(stats["removed_deaths"], 2)

    def test_cap_deaths_when_not_remove_all(self):
        locs = {f"death_{i}": {"x": i} for i in range(1, 6)}
        locs["spawn"] = {"x": 0}
        out, stats = prune_locations(locs, remove_all_deaths=False, max_deaths=3)
        self.assertEqual(set(out.keys()), {"death_3", "death_4", "death_5", "spawn"})
        self.assertEqual(stats["removed_deaths"], 2)


if __name__ == "__main__":
    unittest.main()
