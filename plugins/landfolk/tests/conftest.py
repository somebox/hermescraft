"""Shared fixtures for landfolk plugin unit tests.

The fixture builds a fresh temp SQLite DB with the columns we need
from the Hermes kanban schema. We don't import Hermes' ``init_db``
because (a) it pulls in the whole hermes_cli machinery and (b) we
want to keep these tests Hermes-free so they run in CI without the
agent platform installed.

The schema below is a STRICT subset matching what the orchestrator
module reads/writes. If Hermes ever drops or renames any of these
columns the assertion in ``test_schema_matches_hermes_subset`` will
fail loudly.
"""

from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

import pytest

# Make `landfolk` importable as a package without installing it.
_PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))


# Schema kept narrow on purpose — only the columns the orchestrator
# touches. Keep this in sync with ~/.hermes/hermes-agent/hermes_cli/kanban_db.py.
_TASKS_DDL = """
CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    body            TEXT,
    assignee        TEXT,
    status          TEXT NOT NULL,
    priority        INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL,
    started_at      INTEGER,
    completed_at    INTEGER,
    claim_lock      TEXT,
    claim_expires   INTEGER
)
"""

_TASK_LINKS_DDL = """
CREATE TABLE task_links (
    parent_id TEXT NOT NULL,
    child_id  TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
)
"""

_TASK_EVENTS_DDL = """
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at INTEGER NOT NULL
)
"""

_TASK_COMMENTS_DDL = """
CREATE TABLE task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
)
"""


@pytest.fixture
def conn(tmp_path: Path) -> sqlite3.Connection:
    """Fresh per-test temp SQLite DB with the kanban tables we need."""
    db_path = tmp_path / "kanban.db"
    c = sqlite3.connect(str(db_path), isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute(_TASKS_DDL)
    c.execute(_TASK_LINKS_DDL)
    c.execute(_TASK_EVENTS_DDL)
    c.execute(_TASK_COMMENTS_DDL)
    yield c
    c.close()


@pytest.fixture
def now() -> int:
    return int(time.time())


def insert_task(
    conn: sqlite3.Connection,
    task_id: str,
    *,
    title: str = "test card",
    assignee: str | None = "flint",
    status: str = "ready",
    priority: int = 0,
    created_at: int | None = None,
    claim_lock: str | None = None,
    claim_expires: int | None = None,
) -> None:
    """Helper used by all the tests to insert a row."""
    if created_at is None:
        created_at = int(time.time())
    conn.execute(
        """
        INSERT INTO tasks
            (id, title, body, assignee, status, priority, created_at,
             claim_lock, claim_expires)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
        """,
        (task_id, title, assignee, status, priority, created_at, claim_lock, claim_expires),
    )


def insert_link(conn: sqlite3.Connection, parent_id: str, child_id: str) -> None:
    conn.execute(
        "INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)",
        (parent_id, child_id),
    )


def get_status(conn: sqlite3.Connection, task_id: str) -> str | None:
    row = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return row["status"] if row else None


def get_claim_lock(conn: sqlite3.Connection, task_id: str) -> str | None:
    row = conn.execute("SELECT claim_lock FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return row["claim_lock"] if row else None


def event_kinds(conn: sqlite3.Connection, task_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT kind FROM task_events WHERE task_id = ? ORDER BY id", (task_id,)
    ).fetchall()
    return [r["kind"] for r in rows]
