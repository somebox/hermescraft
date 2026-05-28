#!/usr/bin/env python3
"""Fire-and-forget: insert a chat-derived comment onto a kanban card.

Called by `bot/server.js` `handleChat()` when a chat line mentions a card
id. Caller has already filtered for a useful message and prefixed the
body with ``[via:chat] ``. We only do the DB insert.

Exit codes:
  0  success (or success + nothing to do)
  1  real DB error (file missing, permission denied, etc.)
  2  card id not present in `tasks` — silent (chat is noisy)
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path


def _db_path() -> Path:
    override = os.environ.get("HERMES_KANBAN_DB")
    if override:
        return Path(override)
    board = os.environ.get("HERMES_KANBAN_BOARD", "landfolk-ops")
    return Path.home() / ".hermes" / "kanban" / "boards" / board / "kanban.db"


def insert_comment(db_path: Path, task_id: str, author: str, body: str) -> int:
    if not db_path.exists():
        print(f"kanban_chat_comment: db missing at {db_path}", file=sys.stderr)
        return 1
    try:
        conn = sqlite3.connect(str(db_path), timeout=5.0)
    except sqlite3.Error as exc:
        print(f"kanban_chat_comment: open failed: {exc}", file=sys.stderr)
        return 1
    try:
        row = conn.execute("SELECT 1 FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            return 2
        conn.execute(
            "INSERT INTO task_comments (task_id, author, body, created_at) "
            "VALUES (?, ?, ?, ?)",
            (task_id, author, body, int(time.time())),
        )
        conn.commit()
        return 0
    except sqlite3.Error as exc:
        print(f"kanban_chat_comment: insert failed: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--task-id", required=True)
    ap.add_argument("--author", required=True)
    ap.add_argument("--body", required=True)
    args = ap.parse_args(argv)
    return insert_comment(_db_path(), args.task_id, args.author, args.body)


if __name__ == "__main__":
    sys.exit(main())
