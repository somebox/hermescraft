"""Tests for scripts/migrations/add_card_meta_cols.py.

Verifies the four new nullable columns appear on the tasks table, that
existing rows remain readable, that round-tripping location + size
preserves values, and that re-running the migration is a no-op.
"""
from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MIGRATION_PATH = REPO / "scripts" / "migrations" / "add_card_meta_cols.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("add_card_meta_cols", MIGRATION_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _make_legacy_tasks_db(path: Path) -> None:
    """Build a minimal pre-migration tasks table and seed one row."""
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE tasks (
            id           TEXT PRIMARY KEY,
            title        TEXT NOT NULL,
            body         TEXT,
            assignee     TEXT,
            status       TEXT NOT NULL,
            priority     INTEGER DEFAULT 0,
            created_by   TEXT,
            created_at   INTEGER NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("t_legacy01", "old card", "body", "flint", "ready", 0, 1_700_000_000),
    )
    conn.commit()
    conn.close()


def test_adds_missing_columns_and_preserves_existing_row(tmp_path):
    db = tmp_path / "kanban.db"
    _make_legacy_tasks_db(db)

    mod = _load_migration()
    result = mod.migrate(db)

    assert set(result["added"]) == {"location_x", "location_y", "location_z", "size"}
    assert result["skipped"] == []

    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)")}
    assert {"location_x", "location_y", "location_z", "size"} <= cols

    row = conn.execute("SELECT * FROM tasks WHERE id = ?", ("t_legacy01",)).fetchone()
    assert row["title"] == "old card"
    assert row["location_x"] is None
    assert row["location_y"] is None
    assert row["location_z"] is None
    assert row["size"] is None
    conn.close()


def test_round_trip_location_and_size(tmp_path):
    db = tmp_path / "kanban.db"
    _make_legacy_tasks_db(db)
    mod = _load_migration()
    mod.migrate(db)

    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.execute(
        "INSERT INTO tasks (id, title, status, created_at, "
        "location_x, location_y, location_z, size) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("t_new0001", "supply wood", "ready", 1_700_000_100, 372, 64, -595, "M"),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", ("t_new0001",)).fetchone()
    assert row["location_x"] == 372
    assert row["location_y"] == 64
    assert row["location_z"] == -595
    assert row["size"] == "M"
    conn.close()


def test_idempotent_rerun(tmp_path):
    db = tmp_path / "kanban.db"
    _make_legacy_tasks_db(db)
    mod = _load_migration()

    first = mod.migrate(db)
    second = mod.migrate(db)

    assert set(first["added"]) == {"location_x", "location_y", "location_z", "size"}
    assert second["added"] == []
    assert set(second["skipped"]) == {"location_x", "location_y", "location_z", "size"}


def test_missing_db_raises(tmp_path):
    mod = _load_migration()
    with pytest.raises(FileNotFoundError):
        mod.migrate(tmp_path / "no-such.db")
