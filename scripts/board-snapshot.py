#!/usr/bin/env python3
"""Show all cards and worker state from a kanban board."""
from __future__ import annotations

import os
import sqlite3
import sys
from collections import Counter

DEFAULT_SLUG = "steward"


def db_path_for_slug(slug: str) -> str:
    env = os.environ.get("HERMES_KANBAN_DB")
    if env:
        return os.path.expanduser(env)
    return os.path.expanduser(f"~/.hermes-landfolk-{slug}/kanban.db")


def main() -> None:
    slug = (sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SLUG).strip().lower()
    db_path = db_path_for_slug(slug)
    if not os.path.exists(db_path):
        print(f"DB not found at {db_path} (slug={slug}, set HERMES_KANBAN_DB to override)")
        sys.exit(1)

    db = sqlite3.connect(db_path)
    c = db.execute(
        "SELECT id, title, status, assignee, kind, priority, tags, body "
        "FROM cards ORDER BY "
        "  CASE status "
        "    WHEN 'blocked' THEN 0 "
        "    WHEN 'ready' THEN 1 "
        "    WHEN 'todo' THEN 2 "
        "    WHEN 'running' THEN 3 "
        "    ELSE 4 "
        "  END, priority"
    )
    rows = c.fetchall()
    if not rows:
        print("Board is empty.")
        return

    print(f"{'ASSIGNEE':8s} {'STATUS':10s} {'ID':24s} {'TITLE':50s} {'KIND':6s}")
    print("-" * 100)
    for r in rows:
        assignee = r[3] or "—"
        body_preview = (r[7] or "")[:50].replace("\n", " ")
        print(f"{assignee:8s} {r[2]:10s} {r[0]:24s} {(r[1] or '')[:50]:50s} {r[4]:6s}")
        if body_preview:
            print(f"{'':8s} {'':10s} body: {body_preview}...")

    print()
    counts = Counter(r[2] for r in rows)
    print("Status summary:")
    for status, n in sorted(counts.items(), key=lambda x: (-x[1], x[0])):
        print(f"  {status}: {n}")


if __name__ == "__main__":
    main()
