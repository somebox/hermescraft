"""Export genesis-v2 kanban task_runs snapshot at capture (read-only)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import genesis2_lib as g2


def _q(db: Path, sql: str, args=()) -> list[dict]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    except sqlite3.Error:
        return []
    finally:
        con.close()


def export_board_runs(board: str | None = None) -> dict:
    """Tasks + latest task_run per task from live kanban.db."""
    board = board or g2.BOARD
    bdb = Path.home() / ".hermes" / "kanban" / "boards" / board / "kanban.db"
    if not bdb.is_file():
        return {"board": board, "ok": False, "error": "kanban.db missing", "cards": []}
    tasks = _q(
        bdb,
        "SELECT id, title, assignee, status, session_id, size, current_run_id "
        "FROM tasks ORDER BY rowid",
    )
    cards = []
    for t in tasks:
        runs = _q(
            bdb,
            "SELECT id, task_id, started_at, ended_at, outcome, status, profile, metadata "
            "FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 3",
            (t["id"],),
        )
        cards.append({**t, "task_runs": runs})
    return {"board": board, "ok": True, "cards": cards}


def write_kanban_runs_artifact(artifact_dir: Path, board: str | None = None) -> Path | None:
    payload = export_board_runs(board)
    out = artifact_dir / "kanban-runs.json"
    out.write_text(json.dumps(payload, indent=2) + "\n")
    return out
