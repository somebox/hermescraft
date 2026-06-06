"""Ops: worker skill documents wb context on claim (PR-K stash path)."""

import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SKILL = REPO / "skills" / "kanban-worker.md"


class TestKanbanWorkerWbContext(unittest.TestCase):
    def test_first_turn_orient_mentions_wb_context(self):
        text = SKILL.read_text()
        idx = text.find("## First-turn spec review")
        self.assertGreater(idx, 0)
        section = text[idx : idx + 1200]
        self.assertIn("wb context", section.lower())
        self.assertIn("task-body-coord", section)


if __name__ == "__main__":
    unittest.main()
