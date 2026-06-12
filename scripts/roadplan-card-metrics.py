#!/usr/bin/env python3
"""Per-card worker metrics for the road-planner colony A/B trial.

Joins a kanban board's `tasks` (card → worker session id + assignee) to the
assignee profile's Hermes `state.db` `sessions` row, so we get the four
target.md POC numbers per card: **context tokens, turns, wall time, success**.

Scorecards don't carry token usage; this is the missing join. Read-only.

Usage:
  scripts/roadplan-card-metrics.py --board proc-nav-lab [--title-like road] [--json]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

HERMES = Path.home() / ".hermes"


def _board_db(board):
    return HERMES / "kanban" / "boards" / board / "kanban.db"


def _profile_state_db(assignee):
    return HERMES / "profiles" / assignee / "state.db"


def _q(db, sql, args=()):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


def _session_by_id(assignee, session_id):
    sdb = _profile_state_db(assignee)
    if not session_id or not sdb.exists():
        return None
    rows = _q(sdb, "SELECT * FROM sessions WHERE id=?", (session_id,))
    return rows[0] if rows else None


def _session_by_window(assignee, started_at, ended_at):
    """Fallback: the assignee's session that started within the run's
    window (epoch seconds). Picks the latest such session."""
    sdb = _profile_state_db(assignee)
    if not sdb.exists() or not started_at:
        return None
    hi = ended_at or (started_at + 86400)
    rows = _q(sdb, "SELECT * FROM sessions WHERE started_at >= ? AND "
                   "started_at <= ? ORDER BY started_at DESC LIMIT 1",
              (started_at - 5, hi + 5))
    return rows[0] if rows else None


def _worker_session_id(run_metadata, task_session_id):
    """Bridge order: task_runs.metadata.worker_session_id (what the worker
    handoff records, per run_proc_nav.py) → tasks.session_id."""
    if run_metadata:
        try:
            sid = json.loads(run_metadata).get("worker_session_id")
            if sid:
                return sid
        except (ValueError, TypeError):
            pass
    return task_session_id


def collect(board, title_like):
    bdb = _board_db(board)
    if not bdb.exists():
        sys.exit(f"board db not found: {bdb}")
    where = "WHERE title LIKE ?" if title_like else ""
    args = (f"%{title_like}%",) if title_like else ()
    tasks = _q(bdb, f"SELECT id,title,assignee,status,session_id,current_run_id "
                    f"FROM tasks {where} ORDER BY rowid", args)
    out = []
    for t in tasks:
        runs = _q(bdb, "SELECT started_at,ended_at,outcome,status,profile,"
                       "metadata FROM task_runs WHERE task_id=? "
                       "ORDER BY started_at DESC LIMIT 1", (t["id"],))
        run = runs[0] if runs else {}
        assignee = t["assignee"] or run.get("profile")
        sid = _worker_session_id(run.get("metadata"), t["session_id"])
        sess = (_session_by_id(assignee, sid)
                or _session_by_window(assignee, run.get("started_at"),
                                      run.get("ended_at")))
        wall = None
        if run.get("started_at") and run.get("ended_at"):
            wall = int(run["ended_at"]) - int(run["started_at"])
        rec = {
            "card": t["title"], "assignee": assignee,
            "card_status": t["status"], "outcome": run.get("outcome"),
            "wall_s": wall,
            "turns": (sess or {}).get("message_count"),
            "tool_calls": (sess or {}).get("tool_call_count"),
            "input_tokens": (sess or {}).get("input_tokens"),
            "output_tokens": (sess or {}).get("output_tokens"),
            "cache_read_tokens": (sess or {}).get("cache_read_tokens"),
            "context_tokens": None,
            "session_id": t["session_id"],
        }
        # "context tokens at completion" ≈ the prompt the model carried each
        # turn: cache-read (the cached prefix) + fresh input on the last call.
        # input_tokens is cumulative across turns, so the per-turn carried
        # context is better estimated by cache_read+input over turns; we
        # report the cumulative input + cache_read as the spend proxy and
        # leave a derived per-turn average.
        it, cr, turns = (rec["input_tokens"], rec["cache_read_tokens"],
                         rec["turns"])
        if it is not None and turns:
            rec["context_tokens"] = round((it + (cr or 0)) / max(turns, 1))
        out.append(rec)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--board", default="proc-nav-lab")
    ap.add_argument("--title-like", default=None,
                    help="filter cards by title substring")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    rows = collect(args.board, args.title_like)
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    if not rows:
        print("no matching cards.")
        return 0
    cols = ["card", "assignee", "card_status", "outcome", "wall_s", "turns",
            "tool_calls", "input_tokens", "output_tokens", "context_tokens"]
    print("\t".join(cols))
    for r in rows:
        print("\t".join(str(r.get(c, "")) for c in cols))
    return 0


if __name__ == "__main__":
    sys.exit(main())
