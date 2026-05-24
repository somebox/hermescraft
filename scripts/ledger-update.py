#!/usr/bin/env python3
"""Fold landfolk-ops kanban_complete metadata into data/ops/logistics-ledger.yaml."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
LEDGER_PATH = ROOT / "data" / "ops" / "logistics-ledger.yaml"
BOARD = "landfolk-ops"
OPS_PREFIXES = ("[SUPPLY]", "[STORE]", "[SURVEY]", "[PATROL]", "[REGION]", "[EPIC]")


def task_is_ops(task: dict) -> bool:
    title = task.get("title") or ""
    if any(title.startswith(p) for p in OPS_PREFIXES):
        return True
    assignee = (task.get("assignee") or "").lower()
    if assignee in ("flint", "gatherer", "mason", "steward"):
        return True
    return False


def run_hermes(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["hermes", "kanban", "--board", BOARD, *args],
        capture_output=True,
        text=True,
        check=False,
    )


def load_ledger() -> dict:
    if not LEDGER_PATH.is_file():
        return {
            "last_updated": None,
            "chests": {},
            "floors": {},
            "processed_run_ids": [],
        }
    with LEDGER_PATH.open(encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    data.setdefault("chests", {})
    data.setdefault("floors", {})
    data.setdefault("processed_run_ids", [])
    return data


def save_ledger(data: dict, dry_run: bool) -> None:
    data["last_updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if dry_run:
        print(yaml.dump(data, default_flow_style=False, sort_keys=False))
        return
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER_PATH.open("w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)


def list_done_tasks() -> list[dict]:
    proc = run_hermes("list", "--status", "done", "--json")
    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip()
        if "does not exist" in err:
            print(f"Board {BOARD} not found; run scripts/setup-landfolk-profiles.sh", file=sys.stderr)
            return []
        print(err, file=sys.stderr)
        sys.exit(1)
    return json.loads(proc.stdout or "[]")


def show_task(task_id: str) -> dict | None:
    proc = run_hermes("show", task_id, "--json")
    if proc.returncode != 0:
        return None
    return json.loads(proc.stdout)


def apply_metadata(ledger: dict, task: dict, meta: dict, run_id: int) -> bool:
    changed = False
    chest = meta.get("chest_state")
    if isinstance(chest, dict):
        mark = chest.get("chest_mark") or f"coords_{chest.get('chest_coords')}"
        entry = ledger["chests"].setdefault(mark, {"items": {}})
        if chest.get("chest_coords"):
            entry["coords"] = chest["chest_coords"]
        item = chest.get("item")
        if item and chest.get("count_after") is not None:
            entry.setdefault("items", {})[item] = chest["count_after"]
        entry["last_audit"] = ledger.get("last_updated") or datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        entry["last_task_id"] = task.get("id")
        changed = True

    inv = meta.get("inventory_delta")
    if isinstance(inv, dict) and inv:
        ledger.setdefault("last_inventory_deltas", []).append(
            {"task_id": task.get("id"), "run_id": run_id, "delta": inv}
        )
        changed = True

    floors = meta.get("floors_checked")
    if isinstance(floors, list):
        for row in floors:
            if isinstance(row, dict) and row.get("name"):
                ledger["floors"][row["name"]] = row
        changed = True

    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    ledger = load_ledger()
    processed = set(ledger.get("processed_run_ids") or [])
    updates = 0

    for summary in list_done_tasks():
        title = summary.get("title") or ""
        if not task_is_ops(summary):
            continue
        detail = show_task(summary["id"])
        if not detail:
            continue
        task = detail.get("task") or summary
        for run in detail.get("runs") or []:
            if run.get("outcome") != "completed":
                continue
            run_id = run.get("id")
            if run_id is None or run_id in processed:
                continue
            meta = run.get("metadata") or {}
            if not isinstance(meta, dict):
                meta = {}
            if apply_metadata(ledger, task, meta, run_id):
                updates += 1
            processed.add(run_id)

    ledger["processed_run_ids"] = sorted(processed)
    if updates or not args.dry_run:
        save_ledger(ledger, args.dry_run)
    print(f"ledger-update: {updates} run(s) folded into {LEDGER_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
