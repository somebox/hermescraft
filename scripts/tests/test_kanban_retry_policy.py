"""Phase 10 PR-N Bench R — `kanban retry` repeat-retry guard.

Run-6 evidence (Pattern G): Steward retried `t_1d175784` 4× with the
same "fresh spawn" reason after 4 identical `pid not alive` crashes.
The retry verb didn't enforce hypothesis discipline — Bench R locks
that in.

Self-contained unittest (no pytest). Sets up a tmp sqlite kanban DB,
loads `scripts/kanban` as a module, and drives `cmd_retry` directly
via argparse.Namespace.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from importlib.machinery import SourceFileLoader
from io import StringIO
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]


def _load_kanban_module(db_path: Path):
    """`scripts/kanban` has no .py extension; load it as a module pointed
    at the test sqlite DB via env var."""
    os.environ["HERMES_KANBAN_DB"] = str(db_path)
    os.environ["HERMES_KANBAN_BOARD"] = "test-board"
    sys.modules.pop("kanban_facade", None)
    loader = SourceFileLoader("kanban_facade", str(REPO / "scripts" / "kanban"))
    spec = importlib.util.spec_from_loader("kanban_facade", loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["kanban_facade"] = mod
    loader.exec_module(mod)
    mod.DB_PATH = db_path  # override
    return mod


_SCHEMA = """
CREATE TABLE tasks (
    id                    TEXT PRIMARY KEY,
    title                 TEXT NOT NULL,
    body                  TEXT,
    assignee              TEXT,
    status                TEXT NOT NULL,
    priority              INTEGER DEFAULT 0,
    created_at            INTEGER NOT NULL,
    started_at            INTEGER,
    completed_at          INTEGER,
    claim_lock            TEXT,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    last_failure_error    TEXT
);
CREATE TABLE task_links (
    parent_id TEXT NOT NULL,
    child_id  TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
);
CREATE TABLE task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL
);
"""


def _seed_db(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.executescript(_SCHEMA)
    conn.commit()
    conn.close()


def _insert_failed_task(db_path: Path, task_id: str, error: str, failures: int = 2) -> None:
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(
            "INSERT INTO tasks (id, title, status, created_at, consecutive_failures, last_failure_error) "
            "VALUES (?, '[CONSTRUCT] test', 'blocked', ?, ?, ?)",
            (task_id, int(time.time()), failures, error),
        )


def _retry_events(db_path: Path, task_id: str) -> list[dict]:
    with sqlite3.connect(str(db_path)) as conn:
        rows = conn.execute(
            "SELECT payload, created_at FROM task_events "
            "WHERE task_id = ? AND kind = 'retried' "
            "ORDER BY created_at ASC",
            (task_id,),
        ).fetchall()
    out = []
    for row in rows:
        try:
            payload = json.loads(row[0] or "{}")
        except json.JSONDecodeError:
            payload = {}
        payload["_created_at"] = row[1]
        out.append(payload)
    return out


def _run_retry(kf, **kwargs) -> int:
    """Drive cmd_retry directly with an argparse Namespace, capturing stdout."""
    args = argparse.Namespace(
        task_id=kwargs.get("task_id"),
        reason=kwargs.get("reason"),
        force=kwargs.get("force", False),
        changed_hypothesis=kwargs.get("changed_hypothesis", ""),
    )
    with redirect_stdout(StringIO()):
        return kf.cmd_retry(args)


# ── _failure_signature unit tests ──────────────────────────────────────


class FailureSignatureTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "k.db"
        _seed_db(self.db)
        self.kf = _load_kanban_module(self.db)

    def tearDown(self):
        self._tmp.cleanup()

    def test_pid_normalized(self):
        a = self.kf._failure_signature("worker exited cleanly (pid 12345) without kanban_complete")
        b = self.kf._failure_signature("worker exited cleanly (pid 67890) without kanban_complete")
        self.assertEqual(a, b)

    def test_epoch_timestamp_normalized(self):
        a = self.kf._failure_signature("crash at 1717440000 — pid not alive")
        b = self.kf._failure_signature("crash at 1717450000 — pid not alive")
        self.assertEqual(a, b)

    def test_whitespace_collapsed(self):
        a = self.kf._failure_signature("pid not alive\n\n  extra whitespace")
        b = self.kf._failure_signature("pid not alive extra whitespace")
        self.assertEqual(a, b)

    def test_empty_text_empty_signature(self):
        self.assertEqual(self.kf._failure_signature(""), "")
        self.assertEqual(self.kf._failure_signature(None), "")

    def test_truncates_to_120_chars(self):
        big = "x" * 500
        sig = self.kf._failure_signature(big)
        self.assertLessEqual(len(sig), 120)


# ── cmd_retry repeat-retry guard ───────────────────────────────────────


class RetryPolicyTest(unittest.TestCase):
    """The headline Phase 10 PR-N invariant: identical retry refused
    unless --force or --changed-hypothesis."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "k.db"
        _seed_db(self.db)
        self.kf = _load_kanban_module(self.db)

    def tearDown(self):
        self._tmp.cleanup()

    def test_first_retry_succeeds(self):
        _insert_failed_task(self.db, "t_first", "worker exited (pid 12345)")
        rc = _run_retry(self.kf, task_id="t_first", reason="fresh spawn")
        self.assertEqual(rc, 0)
        events = _retry_events(self.db, "t_first")
        self.assertEqual(len(events), 1)
        # failure_signature recorded in the event payload.
        self.assertIn("failure_signature", events[0])

    def test_identical_retry_refused(self):
        _insert_failed_task(self.db, "t_repeat", "worker exited (pid 12345)")
        # First retry succeeds.
        _run_retry(self.kf, task_id="t_repeat", reason="fresh spawn")
        # Simulate a second crash with the same shape.
        with sqlite3.connect(str(self.db)) as conn:
            conn.execute(
                "UPDATE tasks SET status='blocked', consecutive_failures=2, "
                "last_failure_error='worker exited (pid 99999)' WHERE id=?",
                ("t_repeat",),
            )
            conn.commit()
        # Second retry with same reason MUST be refused.
        with self.assertRaises(SystemExit):
            _run_retry(self.kf, task_id="t_repeat", reason="fresh spawn")
        # Still only one retry event recorded.
        self.assertEqual(len(_retry_events(self.db, "t_repeat")), 1)

    def test_changed_hypothesis_bypasses(self):
        _insert_failed_task(self.db, "t_changed", "pid not alive")
        _run_retry(self.kf, task_id="t_changed", reason="fresh spawn")
        with sqlite3.connect(str(self.db)) as conn:
            conn.execute(
                "UPDATE tasks SET status='blocked', consecutive_failures=2, "
                "last_failure_error='pid not alive' WHERE id=?",
                ("t_changed",),
            )
            conn.commit()
        rc = _run_retry(
            self.kf,
            task_id="t_changed",
            reason="fresh spawn",
            changed_hypothesis="adding strace this time to capture exit signal",
        )
        self.assertEqual(rc, 0)
        events = _retry_events(self.db, "t_changed")
        self.assertEqual(len(events), 2)
        # The changed_hypothesis is captured for audit.
        self.assertIn("changed_hypothesis", events[1])
        self.assertIn("strace", events[1]["changed_hypothesis"])

    def test_force_bypasses(self):
        _insert_failed_task(self.db, "t_force", "pid not alive")
        _run_retry(self.kf, task_id="t_force", reason="fresh spawn")
        with sqlite3.connect(str(self.db)) as conn:
            conn.execute(
                "UPDATE tasks SET status='blocked', consecutive_failures=2, "
                "last_failure_error='pid not alive' WHERE id=?",
                ("t_force",),
            )
            conn.commit()
        rc = _run_retry(self.kf, task_id="t_force", reason="fresh spawn", force=True)
        self.assertEqual(rc, 0)
        events = _retry_events(self.db, "t_force")
        self.assertEqual(len(events), 2)
        self.assertTrue(events[1].get("forced"))

    def test_different_reason_passes(self):
        _insert_failed_task(self.db, "t_diff_reason", "pid not alive")
        _run_retry(self.kf, task_id="t_diff_reason", reason="fresh spawn")
        with sqlite3.connect(str(self.db)) as conn:
            conn.execute(
                "UPDATE tasks SET status='blocked', consecutive_failures=2, "
                "last_failure_error='pid not alive' WHERE id=?",
                ("t_diff_reason",),
            )
            conn.commit()
        # Different reason = different diagnosis = allowed.
        rc = _run_retry(self.kf, task_id="t_diff_reason", reason="hypothesis: card body has bad coords")
        self.assertEqual(rc, 0)

    def test_different_failure_passes(self):
        _insert_failed_task(self.db, "t_diff_fail", "pid not alive")
        _run_retry(self.kf, task_id="t_diff_fail", reason="fresh spawn")
        with sqlite3.connect(str(self.db)) as conn:
            # Different crash mode — signature differs.
            conn.execute(
                "UPDATE tasks SET status='blocked', consecutive_failures=2, "
                "last_failure_error='OperationTimeoutError: goto exceeded 300000ms' WHERE id=?",
                ("t_diff_fail",),
            )
            conn.commit()
        # Same reason but different failure — allowed.
        rc = _run_retry(self.kf, task_id="t_diff_fail", reason="fresh spawn")
        self.assertEqual(rc, 0)

    def test_pid_normalized_so_pid_only_diff_is_refused(self):
        # Crashes with identical shape but different PIDs would have been
        # treated as different failures pre-PR-N. The normalizer makes
        # them equal so the guard fires.
        _insert_failed_task(self.db, "t_pid_norm", "worker exited (pid 12345)")
        _run_retry(self.kf, task_id="t_pid_norm", reason="fresh spawn")
        with sqlite3.connect(str(self.db)) as conn:
            conn.execute(
                "UPDATE tasks SET status='blocked', consecutive_failures=2, "
                "last_failure_error='worker exited (pid 99999)' WHERE id=?",
                ("t_pid_norm",),
            )
            conn.commit()
        with self.assertRaises(SystemExit):
            _run_retry(self.kf, task_id="t_pid_norm", reason="fresh spawn")


# ── run-6 Pattern G regression case ────────────────────────────────────


class Run6PatternGRegressionTest(unittest.TestCase):
    """Direct reproduction of Pattern G: Steward retrying t_1d175784
    4× with same "fresh spawn" reason after same `pid not alive` crash.
    Bench R asserts the 2nd-4th attempts all refuse."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "k.db"
        _seed_db(self.db)
        self.kf = _load_kanban_module(self.db)

    def tearDown(self):
        self._tmp.cleanup()

    def test_pattern_g_repeat_retries_blocked_after_first(self):
        _insert_failed_task(self.db, "t_1d175784", "pid 12345 not alive")
        # 1st retry succeeds.
        rc = _run_retry(self.kf, task_id="t_1d175784", reason="fresh spawn")
        self.assertEqual(rc, 0)
        # Simulate 3 more identical crashes — each followed by an
        # attempted Steward retry with the same text.
        for pid in (23456, 34567, 45678):
            with sqlite3.connect(str(self.db)) as conn:
                conn.execute(
                    "UPDATE tasks SET status='blocked', consecutive_failures=2, "
                    "last_failure_error=? WHERE id=?",
                    (f"pid {pid} not alive", "t_1d175784"),
                )
                conn.commit()
            with self.assertRaises(SystemExit):
                _run_retry(self.kf, task_id="t_1d175784", reason="fresh spawn")
        # Only the 1st retry was recorded; the 3 repeats were blocked.
        events = _retry_events(self.db, "t_1d175784")
        self.assertEqual(len(events), 1, msg=f"Expected 1 retry event, got {len(events)}: {events}")


if __name__ == "__main__":
    unittest.main()
