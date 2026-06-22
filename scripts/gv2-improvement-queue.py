#!/usr/bin/env python3
"""Committed improvement queue for genesis-v2 dev loop."""
from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
QUEUE = REPO / "data" / "genesis-v2" / "improvement-queue.json"


def _load() -> dict:
    return json.loads(QUEUE.read_text()) if QUEUE.is_file() else {"schema_version": 1, "items": []}


def _save(data: dict) -> None:
    QUEUE.parent.mkdir(parents=True, exist_ok=True)
    QUEUE.write_text(json.dumps(data, indent=2) + "\n")


def cmd_ingest(args: argparse.Namespace) -> int:
    run_root = Path(args.run_dir)
    run_id = run_root.name
    data = _load()
    existing_ids = {it.get("work_id") for it in data.get("items") or []}
    existing_titles = {(it.get("title") or "").strip() for it in data.get("items") or []}
    added = 0

    na_path = run_root / "next-actions.json"
    if na_path.is_file():
        na = json.loads(na_path.read_text())
        for item in na:
            title = (item.get("title") or "").strip()
            wid = item.get("id") or item.get("work_id") or f"na-{uuid.uuid4().hex[:8]}"
            work_id = wid if str(wid).startswith("gv2-") else f"gv2-{wid}"
            if work_id in existing_ids or title in existing_titles:
                continue
            data["items"].append(
                {
                    "work_id": work_id,
                    "status": "proposed",
                    "type": item.get("type"),
                    "title": title,
                    "source_run_id": run_id,
                    "evidence": item.get("evidence") or [],
                    "predicted_delta": item.get("predicted_delta") or {},
                    "suggested_test": item.get("suggested_test"),
                    "lifts_level": item.get("lifts_level"),
                }
            )
            existing_ids.add(work_id)
            existing_titles.add(title)
            added += 1

    pr_path = run_root / "planner-review.json"
    if pr_path.is_file():
        pr = json.loads(pr_path.read_text())
        for i, step in enumerate(pr.get("proposed_next_steps") or []):
            title = (step.get("title") or "").strip()
            if not title or title in existing_titles:
                continue
            work_id = f"gv2-pr-{run_id}-{i}"
            if work_id in existing_ids:
                continue
            data["items"].append(
                {
                    "work_id": work_id,
                    "status": "proposed",
                    "type": step.get("maps_to_next_action_type") or "planner_prompt_or_skill",
                    "title": title,
                    "source_run_id": run_id,
                    "evidence": [step.get("source") or "planner-review"],
                }
            )
            added += 1

    _save(data)
    print(f"ingested {added} items")
    return 0


def cmd_list(_: argparse.Namespace) -> int:
    data = _load()
    for it in data.get("items") or []:
        print(f"{it.get('work_id')}\t{it.get('status')}\t{it.get('title')}")
    return 0


def cmd_select(args: argparse.Namespace) -> int:
    data = _load()
    selected = 0
    for wid in args.work_id:
        for it in data.get("items") or []:
            if it.get("work_id") == wid:
                it["status"] = "selected"
                selected += 1
    _save(data)
    print(f"selected {selected}")
    return 0


def cmd_set_status(args: argparse.Namespace) -> int:
    data = _load()
    for it in data.get("items") or []:
        if it.get("work_id") == args.work_id:
            it["status"] = args.status
            if args.validation_run_id:
                it["validation_run_id"] = args.validation_run_id
    _save(data)
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    ing = sub.add_parser("ingest")
    ing.add_argument("--run-dir", type=Path, required=True)
    ing.set_defaults(func=cmd_ingest)
    sub.add_parser("list").set_defaults(func=cmd_list)
    sel = sub.add_parser("select")
    sel.add_argument("work_id", nargs="+")
    sel.set_defaults(func=cmd_select)
    st = sub.add_parser("set-status")
    st.add_argument("work_id")
    st.add_argument("status")
    st.add_argument("--validation-run-id")
    st.set_defaults(func=cmd_set_status)
    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
