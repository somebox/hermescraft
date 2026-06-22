#!/usr/bin/env python3
"""Mid-run validation predicates for active genesis-v2 runs."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))

import genesis2_lib as g2  # noqa: E402

VALIDATE_YAML = REPO / "config" / "gv2-validate.yaml"


def _load_thresholds() -> dict:
    if not VALIDATE_YAML.is_file():
        return {}
    try:
        import yaml  # type: ignore

        return yaml.safe_load(VALIDATE_YAML.read_text()) or {}
    except Exception:
        return {}


def _live_tasks() -> list[dict]:
    p = subprocess.run(
        ["hermes", "kanban", "--board", g2.BOARD, "list", "--json"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if p.returncode != 0:
        return []
    data = json.loads(p.stdout or "[]")
    return data if isinstance(data, list) else data.get("tasks") or []


def validate_run(run_root: Path | None, *, live: bool = False, run_id: str | None = None) -> tuple[int, dict]:
    """exit 0=ok 10=warn 20=abort_recommended 30=corrupt"""
    thresholds = _load_thresholds()
    preds = thresholds.get("predicates") or {}

    tasks: list[dict] = []
    if live:
        tasks = _live_tasks()
        if not tasks:
            return 30, {"reason": "artifacts_corrupt", "detail": "live board empty or hermes failed"}
    elif run_root:
        board_path = run_root / "artifacts" / "board.json"
        if not board_path.is_file():
            return 30, {"reason": "artifacts_corrupt", "missing": "board.json"}
        board = json.loads(board_path.read_text())
        tasks = board if isinstance(board, list) else board.get("tasks") or []
    else:
        return 30, {"reason": "artifacts_corrupt", "detail": "no run_root and not live"}

    retro = g2.retro_card_snapshot(tasks=tasks)
    ended = False
    if run_root and (run_root / "config.json").is_file():
        try:
            ended = bool(json.loads((run_root / "config.json").read_text()).get("ended_at"))
        except (json.JSONDecodeError, OSError):
            pass
    if retro.get("pending", 0) > 0 and ended:
        return 20, {"reason": "retro_stuck", "pending": retro["pending"]}

    mission_broken = False
    if run_id and not live:
        cs = g2.run_dir(run_id) / "card-stories"
        try:
            cfg = g2.load_config(run_id)
            mid = cfg.get("mission_id")
            if mid and (cs / f"{mid}.md").is_file():
                text = (cs / f"{mid}.md").read_text()
                if "protocol_violation" in text or "gave_up" in text:
                    mission_broken = True
        except Exception:
            pass
    if mission_broken:
        return 20, {"reason": "mission_broken"}

    manage_open = sum(
        1
        for t in tasks
        if "MANAGE re-engage" in (t.get("title") or "")
        and (t.get("status") or "").lower() in ("todo", "ready", "running", "blocked")
    )
    if manage_open >= int(preds.get("manage_unresolved_abort", 8)):
        return 20, {"reason": "manage_unresolved", "count": manage_open}

    return 0, {"ok": True, "retro_pending": retro.get("pending", 0)}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-id")
    p.add_argument("--run-dir", type=Path)
    p.add_argument("--live", action="store_true", help="Validate live board (mid-run)")
    p.add_argument("--once", action="store_true")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    run_id = args.run_id or g2.active_run_id()
    root = args.run_dir
    if not root and run_id and not args.live:
        root = g2.run_dir(run_id)
    code, body = validate_run(root, live=args.live, run_id=run_id)
    if args.json:
        print(json.dumps({"exit_code": code, **body}, indent=2))
    else:
        print(f"validate: exit={code} {body}")
    return min(code, 255)


if __name__ == "__main__":
    raise SystemExit(main())
