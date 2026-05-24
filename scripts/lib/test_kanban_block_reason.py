import unittest

from kanban_block_reason import parse


class TestKanbanBlockReason(unittest.TestCase):
    def test_region_blocked_with_id_and_reason(self):
        p = parse("region_blocked:hut3:cannot_dig_ceiling")
        self.assertIsNotNone(p)
        assert p is not None
        self.assertEqual(p["block_kind"], "region_blocked")
        self.assertEqual(p["region_id"], "hut3")
        self.assertEqual(p["short_reason"], "cannot_dig_ceiling")

    def test_prerequisite_missing(self):
        p = parse("prerequisite_missing:oak_planks:need 32")
        self.assertEqual(p["block_kind"], "prerequisite_missing")
        self.assertEqual(p["missing"], "oak_planks")
        self.assertEqual(p["short_reason"], "need 32")

    def test_stuck_pocket(self):
        p = parse("stuck_pocket_no_escape:water_below")
        self.assertEqual(p["block_kind"], "stuck_pocket_no_escape")
        self.assertEqual(p["short_reason"], "water_below")

    def test_decision_needed(self):
        p = parse("decision_needed:pick alternate site")
        self.assertEqual(p["block_kind"], "decision_needed")
        self.assertEqual(p["short_reason"], "pick alternate site")

    def test_unknown_returns_none(self):
        self.assertIsNone(parse("random_failure"))
        self.assertIsNone(parse(""))
        self.assertIsNone(parse(None))


if __name__ == "__main__":
    unittest.main()
