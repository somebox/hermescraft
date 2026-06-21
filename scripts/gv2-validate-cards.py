#!/usr/bin/env python3
"""CLI for genesis-v2 worker-card validation (read-only)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.lib.gv2_card_validator import validate_board_tasks, validate_card  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--title", default="")
    p.add_argument("--body", default="")
    p.add_argument("--body-file", type=Path)
    p.add_argument("--assignee", default="")
    p.add_argument("--kind", default=None)
    p.add_argument("--board-json", type=Path, help="Validate tasks from captured board.json")
    p.add_argument(
        "--status",
        default="ready,todo,running,done",
        help="Comma statuses when using --board-json",
    )
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    body = args.body
    if args.body_file:
        body = args.body_file.read_text(encoding="utf-8")

    if args.board_json:
        tasks = json.loads(args.board_json.read_text(encoding="utf-8"))
        if isinstance(tasks, dict):
            tasks = tasks.get("tasks", [])
        statuses = {s.strip().lower() for s in args.status.split(",") if s.strip()}
        out = validate_board_tasks(tasks, statuses=statuses)
        if args.json:
            print(json.dumps(out, indent=2))
        else:
            print(
                f"validate-board: {'ok' if out['ok'] else 'FAIL'} "
                f"checked={out['checked']} invalid={out['invalid_count']}"
            )
            for r in out["results"]:
                if r["ok"]:
                    continue
                print(f"  {r.get('id')} [{r.get('status')}] {r.get('title', '')[:70]}")
                for e in r["errors"]:
                    print(f"    ERROR: {e}")
                for w in r["warnings"]:
                    print(f"    warn: {w}")
        return 0 if out["ok"] else 1

    result = validate_card(
        title=args.title,
        body=body,
        assignee=args.assignee or None,
        kind=args.kind,
    )
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"validate: {'ok' if result['ok'] else 'FAIL'} kind={result.get('kind')!r}")
        for e in result["errors"]:
            print(f"  ERROR: {e}")
        for w in result["warnings"]:
            print(f"  warn: {w}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
