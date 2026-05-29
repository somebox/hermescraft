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
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_BOARD = "landfolk-ops"
DEFAULT_TICK_SECONDS = 60  # matches kanban.dispatch_interval_seconds
# `os.environ.get(NAME, default)` returns "" when NAME is exported as empty —
# we want the default in that case. `or` falls through on falsy strings. Caught
# 2026-05-27: Steward's `scripts/board-recent.py --ticks 5` raised
# `sqlite3.OperationalError: unable to open database file` because
# HERMES_KANBAN_ROOT was "" in her subprocess env, the path became a relative
# string, `is_file()` happened to pass on a stray cwd entry, and sqlite then
# failed at first query.
_DEFAULT_KANBAN_ROOT = Path.home() / ".hermes" / "kanban"
KANBAN_ROOT = Path(os.environ.get("HERMES_KANBAN_ROOT") or str(_DEFAULT_KANBAN_ROOT))


def coerce_epoch(value) -> int:
    """Best-effort epoch-seconds normalization for kanban.db `created_at`.

    The schema doesn't declare a type for created_at and historically a
    small number of rows were written as ISO timestamp strings
    (e.g. "2026-05-26 01:01:56") while the rest are epoch ints. Sorting
    a mixed-type list raises TypeError, so we normalize here. Returns 0
    on unparseable input — those rows sort to the start without
    crashing the script.
    """
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value).strip()
    if not s:
        return 0
    # Try epoch-as-string first (cheapest happy-path).
    try:
        return int(float(s))
    except ValueError:
        pass
    # Fall back to ISO 8601 / common SQL datetime formats.
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
        try:
            return int(datetime.strptime(s, fmt).timestamp())
        except ValueError:
            continue
    return 0


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
    # Plain open instead of `mode=ro` URI — same fix as scripts/kanban
    # (7484b31). The URI form fails transiently with "unable to open
    # database file" when the WAL sidecars are mid-checkpoint right
    # after a writer commits; plain open cooperates with WAL normally.
    # Read-only is a soft contract here — all queries are SELECT.
    conn = sqlite3.connect(str(path), timeout=5.0)
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


def fetch_per_assignee_state(conn, assignee=None):
    """Current open-card counts + last-event time per assignee.

    Returns dict keyed by assignee (None bucket excluded), each value:
      {
        'running':  int,
        'ready':    int,
        'blocked':  int,
        'todo':     int,
        'last_event_at': int (epoch seconds, max over all task_events),
      }
    """
    sql = """
        SELECT t.assignee, t.status, COUNT(*) AS n
        FROM tasks t
        WHERE t.assignee IS NOT NULL AND t.assignee != ''
          AND t.status IN ('running','ready','blocked','todo')
    """
    args: list = []
    if assignee:
        sql += " AND t.assignee = ?"
        args.append(assignee)
    sql += " GROUP BY t.assignee, t.status"
    rows = conn.execute(sql, args).fetchall()

    out: dict = {}
    for r in rows:
        a = r["assignee"]
        if a not in out:
            out[a] = {"running": 0, "ready": 0, "blocked": 0, "todo": 0, "last_event_at": 0}
        out[a][r["status"]] = r["n"]

    # Last event timestamp per assignee (any kind, any time)
    sql2 = """
        SELECT t.assignee, MAX(e.created_at) AS last_at
        FROM task_events e
        LEFT JOIN tasks t ON t.id = e.task_id
        WHERE t.assignee IS NOT NULL AND t.assignee != ''
    """
    args2: list = []
    if assignee:
        sql2 += " AND t.assignee = ?"
        args2.append(assignee)
    sql2 += " GROUP BY t.assignee"
    for r in conn.execute(sql2, args2).fetchall():
        a = r["assignee"]
        if a not in out:
            out[a] = {"running": 0, "ready": 0, "blocked": 0, "todo": 0, "last_event_at": 0}
        raw = r["last_at"]
        if raw and isinstance(raw, str):
            from datetime import datetime
            out[a]["last_event_at"] = int(datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").timestamp())
        else:
            out[a]["last_event_at"] = int(raw or 0)

    return out


def detect_running_workers():
    """Map of profile_name → list of (pid, task_id) for hermes -p <profile> kanban task runs."""
    workers: dict = {}
    try:
        ps = subprocess.run(
            ["ps", "-ax", "-o", "pid=,command="],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:
        return workers
    pat = re.compile(r"hermes -p (\S+).*kanban task (\S+)")
    for line in ps.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        pid, cmd = parts
        m = pat.search(cmd)
        if not m:
            continue
        prof, tid = m.group(1).lower(), m.group(2)
        workers.setdefault(prof, []).append((pid, tid))
    return workers


def humanize_age(seconds: int) -> str:
    if seconds <= 0:
        return "?"
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h{(seconds % 3600) // 60}m"
    return f"{seconds // 86400}d{(seconds % 86400) // 3600}h"


def load_assignable_roster():
    """Best-effort: read roster.py --assignable, return set of profile names. Empty set on failure."""
    try:
        out = subprocess.run(
            ["python3", str(Path(__file__).resolve().parent / "roster.py"), "--assignable"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        return {line.strip().lower() for line in out.splitlines() if line.strip()}
    except Exception:
        return set()


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
    per_assignee = fetch_per_assignee_state(conn, assignee=args.assignee)
    running_workers = detect_running_workers()
    assignable = load_assignable_roster()

    # Suppress the `commented` event row when --no-comments is OFF — the
    # comment table already carries the real body. Otherwise each comment
    # shows up twice (once as a length-stat event, once as the body).
    if not args.no_comments:
        events = [e for e in events if e["kind"] != "commented"]

    # Merge by time. Normalize created_at to int epoch via coerce_epoch
    # to defend against mixed text/int storage in kanban.db (4 rows in
    # task_events were observed as ISO strings on 2026-05-27 — sort
    # crashed with "'<' not supported between str and int"). Unparseable
    # values sort to 0 = far past, surfacing them at the start of the
    # list rather than crashing.
    rows = []
    for e in events:
        rows.append({
            "time": coerce_epoch(e["created_at"]),
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
            "time": coerce_epoch(c["created_at"]),
            "tid": c["task_id"],
            "assignee": c["assignee"],
            "status": c["status"],
            "kind": "comment",
            "detail": f"{c['author']}: {body_one_line[:80]}",
            "title": c["title"],
        })
    rows.sort(key=lambda r: r["time"])
    rows = rows[-args.limit:]

    # Build worker-activity summary. Distinguishes:
    #   ACTIVE  — has a kanban worker process running right now
    #   READY   — has cards in ready/running on the board (dispatcher will spawn)
    #   IDLE    — assignable, no cards, no worker → AVAILABLE FOR REASSIGN
    #   STRANDED — has cards but not in --assignable (offline bot, dead profile)
    worker_summary = []
    # Assemble the union of assignees we have ANY signal for
    candidates = set(per_assignee.keys()) | set(running_workers.keys()) | assignable
    candidates.discard(None)
    candidates.discard("")
    candidates.discard("default")   # framework fallback, not a bot
    for a in sorted(candidates):
        st = per_assignee.get(a, {"running": 0, "ready": 0, "blocked": 0, "todo": 0, "last_event_at": 0})
        worker_pids = running_workers.get(a, [])
        is_assignable = a in assignable
        last_event = st["last_event_at"]
        age_s = (now - last_event) if last_event else None

        if worker_pids:
            label = "ACTIVE"
        elif st["running"] + st["ready"] > 0:
            label = "QUEUED"
        elif st["blocked"] + st["todo"] > 0 and is_assignable:
            label = "BLOCKED-ONLY"
        elif is_assignable:
            label = "IDLE"
        elif st["running"] + st["ready"] + st["blocked"] + st["todo"] > 0:
            label = "STRANDED"
        else:
            label = "OFFLINE"

        worker_summary.append({
            "profile": a,
            "label": label,
            "running": st["running"],
            "ready": st["ready"],
            "blocked": st["blocked"],
            "todo": st["todo"],
            "worker_pids": [pid for pid, _ in worker_pids],
            "worker_tids": [tid for _, tid in worker_pids],
            "last_event_age_s": age_s,
            "assignable": is_assignable,
        })

    if args.json:
        json.dump({"rows": rows, "workers": worker_summary}, sys.stdout, indent=2, default=str)
        print()
        return

    if not rows and not worker_summary:
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

    # Worker activity footer — what each profile is doing right now.
    # Helps Steward spot idle-but-assignable bots without running a separate
    # ps + roster + kanban-list dance.
    if worker_summary:
        print()
        print("# workers (snapshot — now state, not within window)")
        print("# profile    label         counts                       worker / last_event")
        for w in worker_summary:
            label_pad = w["label"].ljust(13)
            counts = f"run={w['running']} ready={w['ready']} block={w['blocked']} todo={w['todo']}"
            counts = counts.ljust(28)
            extras = []
            if w["worker_pids"]:
                tid = w["worker_tids"][0] if w["worker_tids"] else "?"
                extras.append(f"pid={w['worker_pids'][0]} task={tid}")
            if w["last_event_age_s"] is not None:
                extras.append(f"last_event {humanize_age(w['last_event_age_s'])} ago")
            elif w["last_event_age_s"] is None:
                extras.append("no events on record")
            if not w["assignable"] and w["label"] != "OFFLINE":
                extras.append("⚠ NOT in roster --assignable")
            extra_str = "  ".join(extras)
            print(f"  {w['profile']:<10}  {label_pad} {counts}  {extra_str}")

        # Quick guidance for Steward — what to do with the labels she sees
        idle_assignable = [w["profile"] for w in worker_summary
                           if w["label"] == "IDLE" and w["assignable"]]
        stranded = [w["profile"] for w in worker_summary if w["label"] == "STRANDED"]
        if idle_assignable:
            print(f"# hint: {', '.join(idle_assignable)} idle and assignable — consider rebalancing flint/mason cards or generating parallel work")
        if stranded:
            print(f"# hint: {', '.join(stranded)} have cards but aren't in roster --assignable — reassign or archive")


if __name__ == "__main__":
    main()
