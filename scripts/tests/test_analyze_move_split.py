"""Phase 10 PR-V tests — analyze_move_errors split logic.

Pure-function tests on synthetic trace lines mimicking the Hermes
terminal-log format. Run-6 Pattern D evidence is encoded as a
regression: 16 hits on (16,102,54) should classify as both
stuck-on-target AND door-adjacent.
"""
from __future__ import annotations

import unittest

import importlib.util
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _load():
    loader = SourceFileLoader("awt", str(REPO / "scripts" / "analyze-worker-trace.py"))
    spec = importlib.util.spec_from_loader("awt", loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["awt"] = mod
    loader.exec_module(mod)
    return mod


awt = _load()


# Mimic the terminal line format the analyzer parses.
def _tline(cmd: str, dur: str = "1.0", error: bool = False) -> str:
    err_suffix = "  [error]" if error else ""
    return f"┊ 💻 $         {cmd}  {dur}s{err_suffix}"


# ── parse_move_target ──────────────────────────────────────────────────


class ParseMoveTargetTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(awt.parse_move_target("mc move 14 102 8"), (14, 102, 8))

    def test_negative_coords(self):
        self.assertEqual(awt.parse_move_target("mc move -5 64 -10"), (-5, 64, -10))

    def test_with_flags(self):
        self.assertEqual(awt.parse_move_target("mc move 14 102 8 --raw"), (14, 102, 8))
        self.assertEqual(awt.parse_move_target("mc move 14 102 8 --near 2"), (14, 102, 8))

    def test_not_a_move(self):
        self.assertIsNone(awt.parse_move_target("mc goto 14 102 8"))
        self.assertIsNone(awt.parse_move_target("mc inspect"))

    def test_no_coords(self):
        self.assertIsNone(awt.parse_move_target("mc move @lt_iron_se"))


# ── analyze_move_errors — repeated-target detection ────────────────────


class RepeatedTargetTest(unittest.TestCase):
    def test_single_error_no_stuck(self):
        text = _tline("mc move 14 102 8", error=True)
        result = awt.analyze_move_errors(text)
        self.assertEqual(result["total_move_errors"], 1)
        self.assertEqual(result["stuck_on_target"], [])

    def test_two_errors_no_stuck(self):
        text = "\n".join([
            _tline("mc move 14 102 8", error=True),
            _tline("mc move 14 102 8", error=True),
        ])
        result = awt.analyze_move_errors(text)
        # Threshold is 3 — 2 doesn't count.
        self.assertEqual(result["stuck_on_target"], [])

    def test_three_errors_classifies_stuck(self):
        text = "\n".join([
            _tline("mc move 14 102 8", error=True),
            _tline("mc move 14 102 8", error=True),
            _tline("mc move 14 102 8", error=True),
        ])
        result = awt.analyze_move_errors(text)
        self.assertEqual(len(result["stuck_on_target"]), 1)
        self.assertEqual(result["stuck_on_target"][0]["target"], [14, 102, 8])
        self.assertEqual(result["stuck_on_target"][0]["error_count"], 3)

    def test_multiple_stuck_targets_sorted(self):
        text = "\n".join([
            _tline("mc move 1 1 1", error=True),
            _tline("mc move 1 1 1", error=True),
            _tline("mc move 1 1 1", error=True),
            _tline("mc move 2 2 2", error=True),
            _tline("mc move 2 2 2", error=True),
            _tline("mc move 2 2 2", error=True),
            _tline("mc move 2 2 2", error=True),
            _tline("mc move 2 2 2", error=True),
        ])
        result = awt.analyze_move_errors(text)
        # Sorted by most_common: (2,2,2) with 5 errors first.
        self.assertEqual(result["stuck_on_target"][0]["target"], [2, 2, 2])
        self.assertEqual(result["stuck_on_target"][0]["error_count"], 5)
        self.assertEqual(result["stuck_on_target"][1]["error_count"], 3)


# ── door-adjacency detection ───────────────────────────────────────────


class DoorAdjacencyTest(unittest.TestCase):
    def test_exact_hit_on_known_hazard(self):
        # (16,102,54) is in KNOWN_HAZARD_COORDS — exact hit must count.
        text = _tline("mc move 16 102 54", error=True)
        result = awt.analyze_move_errors(text)
        self.assertEqual(result["door_adjacent_error_count"], 1)
        sample = result["door_adjacent_samples"][0]
        self.assertEqual(sample["target"], [16, 102, 54])
        self.assertEqual(sample["near_hazard"], [16, 102, 54])

    def test_within_radius_3_counts(self):
        # (17, 101, 53) is within manhattan 3 of (16,102,54).
        text = _tline("mc move 17 101 53", error=True)
        result = awt.analyze_move_errors(text)
        self.assertEqual(result["door_adjacent_error_count"], 1)

    def test_outside_radius_doesnt_count(self):
        # (16, 102, 100) is 46 blocks from the nearest hazard.
        text = _tline("mc move 16 102 100", error=True)
        result = awt.analyze_move_errors(text)
        self.assertEqual(result["door_adjacent_error_count"], 0)

    def test_non_error_move_doesnt_count(self):
        # Successful move to a hazard coord shouldn't be tallied as a
        # door-adjacency error.
        text = _tline("mc move 16 102 54", error=False)
        result = awt.analyze_move_errors(text)
        self.assertEqual(result["door_adjacent_error_count"], 0)

    def test_extended_hazards(self):
        # Caller-supplied hazard list extends the defaults.
        text = _tline("mc move 99 50 99", error=True)
        result = awt.analyze_move_errors(text, hazards=[(99, 50, 99)])
        self.assertEqual(result["door_adjacent_error_count"], 1)


# ── overall shape + run-6 Pattern D regression ─────────────────────────


class Run6PatternDRegressionTest(unittest.TestCase):
    """Pattern D: 16 hits on (16,102,54) oak_door in run-6. Verify the
    analyzer classifies it as both stuck-on-target AND door-adjacent so
    the postmortem can cite either lens."""

    def test_pattern_d_classified(self):
        text = "\n".join(
            _tline("mc move 16 102 54", error=True) for _ in range(16)
        )
        result = awt.analyze_move_errors(text)
        self.assertEqual(result["total_move_errors"], 16)
        # Stuck-on-target: (16,102,54) appears with 16 errors.
        self.assertEqual(len(result["stuck_on_target"]), 1)
        self.assertEqual(result["stuck_on_target"][0]["error_count"], 16)
        # Door-adjacent: all 16 errors are flagged.
        self.assertEqual(result["door_adjacent_error_count"], 16)

    def test_mixed_pattern_d_and_clean_targets(self):
        # Realistic: 16 stuck hits on Pattern D + scattered single-shot
        # failures on other coords.
        lines = [_tline("mc move 16 102 54", error=True) for _ in range(16)]
        lines.extend([
            _tline("mc move -50 64 50", error=True),
            _tline("mc move 100 64 100", error=True),
            _tline("mc move 200 64 -200", error=True),
        ])
        result = awt.analyze_move_errors("\n".join(lines))
        # 1 stuck target (Pattern D); 3 scattered errors that don't qualify.
        self.assertEqual(len(result["stuck_on_target"]), 1)
        self.assertEqual(result["stuck_on_target"][0]["target"], [16, 102, 54])
        # 16 door-adjacent + 0 from the scattered ones.
        self.assertEqual(result["door_adjacent_error_count"], 16)
        # Total errors = 16 + 3.
        self.assertEqual(result["total_move_errors"], 19)


# ── rendered text smoke ────────────────────────────────────────────────


class RenderTextTest(unittest.TestCase):
    def test_render_smoke(self):
        split = {
            "total_move_invocations": 50,
            "total_move_errors": 16,
            "unique_targets": 5,
            "stuck_on_target": [{"target": [16, 102, 54], "error_count": 16}],
            "door_adjacent_error_count": 16,
            "door_adjacent_samples": [
                {"target": [16, 102, 54], "near_hazard": [16, 102, 54]},
            ],
        }
        text = awt._render_move_split_text(split, label="9 cards")
        self.assertIn("mc move split", text)
        self.assertIn("9 cards", text)
        self.assertIn("(16,102,54): 16 errors", text)
        self.assertIn("door-adjacent errors: 16", text)


if __name__ == "__main__":
    unittest.main()
