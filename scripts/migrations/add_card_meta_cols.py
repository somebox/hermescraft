#!/usr/bin/env python3
"""Add `location_x/y/z` and `size` to the kanban `tasks` table.

Part of the worker-board-proxy / Steward redesign (P0). These columns let
Steward record where a card's work happens in the world and a t-shirt
size estimate. Both are nullable; existing reads and writes are
unaffected.

Idempotent. Re-running against a DB that already has the columns is a
no-op and exits 0. Safe to run while the dispatcher is up: each ALTER
is wrapped in a tolerant helper that swallows "duplicate column name".

Default DB path is the landfolk-ops board:
    ~/.hermes/kanban/boards/landfolk-ops/kanban.db
Override with --db <path>.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path.home() / ".hermes" / "kanban" / "boards" / "landfolk-ops" / "kanban.db"

NEW_COLUMNS = (
    ("location_x", "location_x INTEGER"),
    ("location_y", "location_y INTEGER"),
    ("location_z", "location_z INTEGER"),
    ("size",       "size TEXT"),
)


def add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> bool:
    """Return True when the column was added by this call."""
    try:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
        return True
    except sqlite3.OperationalError as exc:
        if "duplicate column name" in str(exc).lower():
            return False
        raise


def migrate(db_path: Path) -> dict:
    if not db_path.exists():
        raise FileNotFoundError(f"kanban DB not found: {db_path}")
    conn = sqlite3.connect(str(db_path), isolation_level=None, timeout=30)
    try:
        conn.row_factory = sqlite3.Row
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)")}
        added: list[str] = []
        skipped: list[str] = []
        for name, ddl in NEW_COLUMNS:
            if name in existing:
                skipped.append(name)
                continue
            if add_column_if_missing(conn, "tasks", name, ddl):
                added.append(name)
            else:
                skipped.append(name)
        return {"db": str(db_path), "added": added, "skipped": skipped}
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--db", type=Path, default=DEFAULT_DB,
                   help=f"kanban.db path (default: {DEFAULT_DB})")
    p.add_argument("--quiet", action="store_true",
                   help="Suppress per-column status output.")
    args = p.parse_args(argv)
    result = migrate(args.db)
    if not args.quiet:
        print(f"[migrate] db={result['db']}")
        for c in result["added"]:
            print(f"  + added   {c}")
        for c in result["skipped"]:
            print(f"  · skipped {c} (already present)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
