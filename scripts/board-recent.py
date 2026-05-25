#!/usr/bin/env python3
"""Recent kanban board activity — read-only delta view across all cards.

Why this exists
---------------
Stock Hermes ships ``kanban watch`` (streaming, no batch query) and per-card
``kanban show`` / ``tail``. There is no ``kanban events --since 5m`` board-wide
snapshot. Steward's continuous loop needs that delta to know "what changed
since my last cycle" without paging through every suspect card.

This is a pure read-only sqlite3 query against the existing kanban.db. It
writes nothing, creates no schema, and never patches Hermes. If a future
Hermes ships a native ``--since`` flag, swap the internals here while keeping
the CLI surface stable.

Usage
-----
    scripts/board-recent.py                      # default: last 5 dispatcher ticks
    scripts/board-recent.py --ticks 3            # last 3 dispatcher ticks (3 min)
    scripts/board-recent.py --since 30m          # last 30 minutes
    scripts/board-recent.py --since 2h           # last 2 hours
    scripts/board-recent.py --assignee flint     # only Flint's cards
    scripts/board-recent.py --kinds blocked,unblocked,completed
    scripts/board-recent.py --json               # machine-readable
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_BOARD = "landfolk-ops"
DEFAULT_TICK_SECONDS = 60  # matches kanban.dispatch_interval_seconds
KANBAN_ROOT = Path(os.environ.get(
    "HERMES_KANBAN_ROOT",
    Path.home() / ".hermes" / "kanban",
))


def parse_duration(s: str) -> int:
    """'5m' → 300, '2h' → 7200, '30s' → 30, '1d' → 86400. Bare int → seconds."""
    s = s.strip().lower()
    m = re.fullmatch(r"(\d+)\s*([smhd]?)", s)
    if not m:
        raise argparse.ArgumentTypeError(f"bad duration: {s!r}")
    n = int(m.group(1))
    unit = m.group(2) or "s"
    return n * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]


def open_db_readonly(board: str) -> sqlite3.Connection:
    path = KANBAN_ROOT / "boards" / board / "kanban.db"
    if not path.is_file():
        sys.exit(f"kanban.db not found at {path}")
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_events(conn, since_epoch: int, assignee=None, kinds=None):
    sql = """
        SELECT e.created_at, e.task_id, e.kind, e.payload,
               t.title, t.assignee, t.status
        FROM task_events e
        LEFT JOIN tasks t ON t.id = e.task_id
        WHERE e.created_at >= ?
    """
    args = [since_epoch]
    if assignee:
        sql += " AND t.assignee = ?"
        args.append(assignee)
    if kinds:
        placeholders = ",".join("?" * len(kinds))
        sql += f" AND e.kind IN ({placeholders})"
        args.extend(kinds)
    sql += " ORDER BY e.created_at ASC"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def fetch_comments(conn, since_epoch: int, assignee=None):
    sql = """
        SELECT c.created_at, c.task_id, c.author, c.body,
               t.title, t.assignee, t.status
        FROM task_comments c
        LEFT JOIN tasks t ON t.id = c.task_id
        WHERE c.created_at >= ?
    """
    args = [since_epoch]
    if assignee:
        sql += " AND t.assignee = ?"
        args.append(assignee)
    sql += " ORDER BY c.created_at ASC"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def payload_summary(payload_str: str, max_len: int = 60) -> str:
    if not payload_str:
        return ""
    try:
        p = json.loads(payload_str)
    except (json.JSONDecodeError, TypeError):
        return str(payload_str)[:max_len]
    # Common payloads: {assignee: x}, {reason: x}, {author: x, len: n}, {pid: n, exit_code: n}
    interesting = []
    for k in ("reason", "assignee", "from", "to", "exit_code", "error",
              "limit_source", "trigger_outcome"):
        if k in p and p[k] not in (None, "", []):
            v = str(p[k])
            interesting.append(f"{k}={v}")
    if not interesting:
        # fall back to compact dump
        return json.dumps(p, separators=(",", ":"))[:max_len]
    return " ".join(interesting)[:max_len]


def fmt_line(time_s: int, tid: str, who: str, status: str, kind: str, detail: str) -> str:
    ts = datetime.fromtimestamp(time_s).strftime("%H:%M:%S")
    who = (who or "—")[:9].ljust(9)
    status = (status or "?")[:7].ljust(7)
    kind = kind[:11].ljust(11)
    return f"[{ts}] {tid}  {who} {status} {kind} {detail}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    win = ap.add_mutually_exclusive_group()
    win.add_argument("--since", type=parse_duration, default=None,
                     help="window duration: 30s, 5m, 2h, 1d (default: --ticks 5)")
    win.add_argument("--ticks", type=int, default=None,
                     help=f"window in dispatcher ticks (1 tick = {DEFAULT_TICK_SECONDS}s)")
    ap.add_argument("--tick-seconds", type=int, default=DEFAULT_TICK_SECONDS,
                    help=f"seconds per tick (default {DEFAULT_TICK_SECONDS})")
    ap.add_argument("--board", default=os.environ.get("HERMES_KANBAN_BOARD", DEFAULT_BOARD))
    ap.add_argument("--assignee", default=None,
                    help="filter to one profile's cards")
    ap.add_argument("--kinds", default=None,
                    help="comma-separated event kinds (created,blocked,unblocked,reassigned,completed,...)")
    ap.add_argument("--no-comments", action="store_true",
                    help="omit comments (events only)")
    ap.add_argument("--limit", type=int, default=200,
                    help="max rows (default 200)")
    ap.add_argument("--json", action="store_true",
                    help="machine-readable output")
    args = ap.parse_args()

    # Resolve window
    if args.since is not None:
        window_s = args.since
    elif args.ticks is not None:
        window_s = args.ticks * args.tick_seconds
    else:
        window_s = 5 * args.tick_seconds  # default: 5 ticks

    now = int(datetime.now().timestamp())
    since_epoch = now - window_s

    kinds = None
    if args.kinds:
        kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]

    conn = open_db_readonly(args.board)
    events = fetch_events(conn, since_epoch, assignee=args.assignee, kinds=kinds)
    comments = [] if args.no_comments else fetch_comments(conn, since_epoch, assignee=args.assignee)

    # Suppress the `commented` event row when --no-comments is OFF — the
    # comment table already carries the real body. Otherwise each comment
    # shows up twice (once as a length-stat event, once as the body).
    if not args.no_comments:
        events = [e for e in events if e["kind"] != "commented"]

    # Merge by time
    rows = []
    for e in events:
        rows.append({
            "time": e["created_at"],
            "tid": e["task_id"],
            "assignee": e["assignee"],
            "status": e["status"],
            "kind": e["kind"],
            "detail": payload_summary(e["payload"] or ""),
            "title": e["title"],
        })
    for c in comments:
        body_one_line = re.sub(r"\s+", " ", c["body"] or "").strip()
        rows.append({
            "time": c["created_at"],
            "tid": c["task_id"],
            "assignee": c["assignee"],
            "status": c["status"],
            "kind": "comment",
            "detail": f"{c['author']}: {body_one_line[:80]}",
            "title": c["title"],
        })
    rows.sort(key=lambda r: r["time"])
    rows = rows[-args.limit:]

    if args.json:
        json.dump(rows, sys.stdout, indent=2, default=str)
        print()
        return

    if not rows:
        win_desc = f"{window_s}s"
        if args.ticks:
            win_desc = f"{args.ticks} tick(s) = {window_s}s"
        elif args.since:
            win_desc = f"{window_s}s"
        print(f"no board activity in the last {win_desc} on '{args.board}'")
        return

    # Header
    win_min = round(window_s / 60, 1)
    print(f"# board={args.board}  window={win_min}min  rows={len(rows)}  (now={datetime.now().strftime('%H:%M:%S')})")
    print("# time      task_id     assignee  status  kind        detail")
    for r in rows:
        print(fmt_line(r["time"], r["tid"], r["assignee"], r["status"],
                       r["kind"], r["detail"]))


if __name__ == "__main__":
    main()
