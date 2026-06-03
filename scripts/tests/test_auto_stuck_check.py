"""Phase 10 PR-S unit tests — `detect_auto_stuck` pure-function behavior.

Run-6 evidence: Flint sat at (14.5,102,7.6) for ~70 min with recent[]
identical (`["inspect:done","move:done","pillar_step:done","move:error"]`)
across 42 consecutive rounds. PR-S surfaces that signal as a
kanban_comment so Steward's diagnostics loop can see it (whispers via
mc chat didn't enter Flint's decision loop).

These tests cover the detector logic only. The CLI wrapper, sqlite
idempotency check, and `hermes kanban comment` shell-out are exercised
in run-7.
"""
from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _load_auto_stuck():
    loader = SourceFileLoader(
        "auto_stuck_check",
        str(REPO / "scripts" / "auto-stuck-check.py"),
    )
    spec = importlib.util.spec_from_loader("auto_stuck_check", loader)
    mod = importlib.util.module_from_spec(spec)
    # Python 3.14: dataclass(frozen=True) introspects sys.modules during
    # decoration; register before exec_module so dataclasses can find us.
    sys.modules["auto_stuck_check"] = mod
    loader.exec_module(mod)
    return mod


asc = _load_auto_stuck()


def _entry(round_no: int, recent: list[str], pos: dict | None) -> dict:
    return {"round": round_no, "recent": list(recent), "pos": pos and dict(pos)}


FLINT_TUPLE = ["inspect:done", "move:done", "pillar_step:done", "move:error"]
FLINT_POS = {"x": 14, "y": 102, "z": 7}


# ── detector pure logic ────────────────────────────────────────────────


class DetectorTest(unittest.TestCase):
    def test_no_entries_no_signal(self):
        self.assertIsNone(asc.detect_auto_stuck([], threshold=4))

    def test_fewer_than_threshold_no_signal(self):
        entries = [_entry(i, FLINT_TUPLE, FLINT_POS) for i in range(3)]
        self.assertIsNone(asc.detect_auto_stuck(entries, threshold=4))

    def test_identical_window_fires(self):
        entries = [_entry(i, FLINT_TUPLE, FLINT_POS) for i in range(4)]
        sig = asc.detect_auto_stuck(entries, threshold=4)
        self.assertIsNotNone(sig)
        self.assertEqual(sig.rounds, 4)
        self.assertEqual(sig.position, FLINT_POS)
        self.assertEqual(sig.recent_tuple, FLINT_TUPLE)
        self.assertEqual(sig.first_round, 0)
        self.assertEqual(sig.last_round, 3)

    def test_different_recent_breaks_signal(self):
        entries = [_entry(i, FLINT_TUPLE, FLINT_POS) for i in range(3)]
        entries.append(_entry(3, ["chat:done"] + FLINT_TUPLE[1:], FLINT_POS))
        self.assertIsNone(asc.detect_auto_stuck(entries, threshold=4))

    def test_different_position_breaks_signal(self):
        entries = [_entry(i, FLINT_TUPLE, FLINT_POS) for i in range(3)]
        moved = dict(FLINT_POS)
        moved["x"] = 20  # bot took a step
        entries.append(_entry(3, FLINT_TUPLE, moved))
        self.assertIsNone(asc.detect_auto_stuck(entries, threshold=4))

    def test_pos_tolerance_allows_drift(self):
        entries = [_entry(i, FLINT_TUPLE, FLINT_POS) for i in range(3)]
        drift = dict(FLINT_POS)
        drift["x"] = FLINT_POS["x"] + 1  # 1-block jitter
        entries.append(_entry(3, FLINT_TUPLE, drift))
        # With tolerance 0: signal breaks.
        self.assertIsNone(asc.detect_auto_stuck(entries, threshold=4, pos_tolerance=0))
        # With tolerance 1: signal still fires.
        self.assertIsNotNone(asc.detect_auto_stuck(entries, threshold=4, pos_tolerance=1))

    def test_only_last_window_examined(self):
        # Earlier history is allowed to differ — only the most-recent N matter.
        entries = [
            _entry(0, ["chat:done"], {"x": 99, "y": 0, "z": 99}),
            _entry(1, ["pillar_up:done"], {"x": 50, "y": 0, "z": 50}),
        ] + [_entry(i, FLINT_TUPLE, FLINT_POS) for i in range(2, 6)]
        sig = asc.detect_auto_stuck(entries, threshold=4)
        self.assertIsNotNone(sig)
        self.assertEqual(sig.first_round, 2)
        self.assertEqual(sig.last_round, 5)

    def test_empty_recent_no_signal(self):
        # If a bot is idle with no recent[] (legitimately healthy), don't fire.
        entries = [_entry(i, [], FLINT_POS) for i in range(4)]
        self.assertIsNone(asc.detect_auto_stuck(entries, threshold=4))

    def test_missing_pos_no_signal(self):
        # Bot disconnected — pos missing. Don't fire (no way to verify).
        entries = [_entry(i, FLINT_TUPLE, None) for i in range(4)]
        self.assertIsNone(asc.detect_auto_stuck(entries, threshold=4))


# ── run-6 Flint regression ─────────────────────────────────────────────


class FlintRegressionTest(unittest.TestCase):
    """Exact reproduction of Flint's run-6 stuck pattern. If the detector
    doesn't fire on Flint's pattern, the whole PR-S is moot."""

    def test_flint_42_round_stuck_streak_fires_at_round_4(self):
        # Simulate 42 identical rounds (Flint's actual count).
        entries = [_entry(i, FLINT_TUPLE, FLINT_POS) for i in range(42)]
        sig = asc.detect_auto_stuck(entries, threshold=4)
        self.assertIsNotNone(sig)
        # Only the last 4 rounds count.
        self.assertEqual(sig.first_round, 38)
        self.assertEqual(sig.last_round, 41)


# ── progress log reader ────────────────────────────────────────────────


class ProgressLogReadTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.log = Path(self._tmp.name) / "progress.log"

    def tearDown(self):
        self._tmp.cleanup()

    def test_empty_file_returns_empty(self):
        self.log.write_text("")
        self.assertEqual(asc.read_progress_tail(self.log, 4), [])

    def test_missing_file_returns_empty(self):
        self.assertEqual(asc.read_progress_tail(self.log, 4), [])

    def test_reads_last_n_entries(self):
        entries = [_entry(i, ["a:done"], {"x": 0, "y": 0, "z": 0}) for i in range(10)]
        self.log.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
        read = asc.read_progress_tail(self.log, 4)
        self.assertEqual(len(read), 4)
        self.assertEqual([e["round"] for e in read], [6, 7, 8, 9])

    def test_skips_blank_and_malformed(self):
        # Mix of good lines, blank lines, and malformed JSON.
        lines = [
            json.dumps(_entry(0, ["a"], FLINT_POS)),
            "",
            "{not valid",
            json.dumps(_entry(1, ["b"], FLINT_POS)),
            json.dumps(_entry(2, ["c"], FLINT_POS)),
        ]
        self.log.write_text("\n".join(lines))
        read = asc.read_progress_tail(self.log, 5)
        self.assertEqual([e["round"] for e in read], [0, 1, 2])


# ── idempotency check ──────────────────────────────────────────────────


class IdempotencyTest(unittest.TestCase):
    """Don't re-spam Steward when the stuck condition persists across
    rounds — once we've commented, stay quiet until the worker breaks
    the loop or Steward acts."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "k.db"
        conn = sqlite3.connect(str(self.db))
        conn.executescript(
            """
            CREATE TABLE task_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                author TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            """
        )
        conn.commit()
        conn.close()

    def tearDown(self):
        self._tmp.cleanup()

    def _insert_comment(self, task_id: str, body: str, ts: int = 1000) -> None:
        with sqlite3.connect(str(self.db)) as conn:
            conn.execute(
                "INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, 'auto-stuck', ?, ?)",
                (task_id, body, ts),
            )
            conn.commit()

    def test_no_prior_comment_returns_false(self):
        self.assertFalse(asc.auto_stuck_already_signaled(self.db, "t_abc"))

    def test_prior_auto_stuck_comment_returns_true(self):
        self._insert_comment("t_abc", "AUTO_STUCK: identical recent[] for 4 rounds at ...")
        self.assertTrue(asc.auto_stuck_already_signaled(self.db, "t_abc"))

    def test_prior_unrelated_comment_returns_false(self):
        self._insert_comment("t_abc", "Steward: please update the card body.")
        self.assertFalse(asc.auto_stuck_already_signaled(self.db, "t_abc"))

    def test_missing_db_returns_false_silently(self):
        # Detector must not crash if the DB doesn't exist (early run, race).
        self.assertFalse(asc.auto_stuck_already_signaled(Path("/nonexistent.db"), "t_abc"))


# ── format_comment_body ────────────────────────────────────────────────


class FormatCommentTest(unittest.TestCase):
    def test_format_includes_position_and_tuple(self):
        sig = asc.StuckSignal(
            rounds=4,
            position=FLINT_POS,
            recent_tuple=FLINT_TUPLE,
            first_round=10,
            last_round=13,
        )
        body = asc.format_comment_body(sig)
        self.assertIn("AUTO_STUCK", body)
        self.assertIn("4 rounds", body)
        self.assertIn("(14,102,7)", body)
        self.assertIn("first_round=10", body)
        self.assertIn("last_round=13", body)
        self.assertIn("Phase 10 PR-S", body)


if __name__ == "__main__":
    unittest.main()
