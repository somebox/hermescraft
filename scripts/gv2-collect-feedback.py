#!/usr/bin/env python3
"""Package RETRO cards into feedback-bundle.json after capture."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
import genesis2_lib as g2  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-id", required=True)
    p.add_argument("--run-dir", type=Path)
    args = p.parse_args()
    root = args.run_dir or g2.run_dir(args.run_id)
    board_path = root / "artifacts" / "board.json"
    tasks = []
    if board_path.is_file():
        data = json.loads(board_path.read_text())
        tasks = data if isinstance(data, list) else data.get("tasks") or []
    retros = [
        {
            "assignee": t.get("assignee"),
            "task_id": t.get("id"),
            "body": t.get("body"),
            "status": t.get("status"),
        }
        for t in tasks
        if "[RETRO]" in (t.get("title") or "")
    ]
    bundle = {
        "run_id": args.run_id,
        "retro_cards": retros,
        "scorecard_ref": "scorecard.json",
    }
    (root / "feedback-bundle.json").write_text(json.dumps(bundle, indent=2) + "\n")
    print(root / "feedback-bundle.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
