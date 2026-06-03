#!/usr/bin/env python3
"""Process grader for exploration-first base establishment (not site quality)."""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _agent_test():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "agent_test_mod", ROOT / "scripts" / "agent-test.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod

DATA = ROOT / "data"
EPIC_TAG = "[ESTABLISH:BASE]"
EXPLORE_PREFIX = "[EXPLORE]"
COBBLE_MIN = 80
PAD_HALF = 4
DEFAULT_BOARD = "landfolk-ops"
DEFAULT_WORLD = "proc-lab"

EPIC_TRAILER_RE = re.compile(r"^---\s*\nepic:\s*(\S+)\s*$", re.MULTILINE)


def kanban_db() -> Path:
    import os

    board = os.environ.get("HERMES_KANBAN_BOARD", DEFAULT_BOARD)
    explicit = os.environ.get("HERMES_KANBAN_DB")
    if explicit:
        return Path(explicit).expanduser()
    return Path.home() / ".hermes" / "kanban" / "boards" / board / "kanban.db"


def load_marks() -> dict:
    names: dict[str, dict] = {}
    for path in sorted(DATA.glob("locations-*.json")):
        if path.name == "locations-base.json":
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if isinstance(raw, dict):
            for name, val in raw.items():
                if isinstance(val, dict) and "x" in val:
                    names[name] = val
    base = DATA / "locations-base.json"
    if base.exists():
        try:
            raw = json.loads(base.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for name, val in raw.items():
                    if isinstance(val, dict) and "x" in val:
                        names[name] = val
        except (json.JSONDecodeError, OSError):
            pass
    return names


def epic_trailer(body: str | None) -> str | None:
    if not body:
        return None
    m = EPIC_TRAILER_RE.search(body)
    return m.group(1) if m else None


def fetch_tasks(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return list(conn.execute("SELECT id, title, status, body FROM tasks"))


def count_cobble_pad(world: str, ax: int, ay: int, az: int) -> int:
    """9×9 pad at foot y: surface layer is ay-1 (genesis convention)."""
    pad_y = ay - 1
    x1, z1 = ax - PAD_HALF, az - PAD_HALF
    x2, z2 = ax + PAD_HALF, az + PAD_HALF
    cells = [
        (x, pad_y, z)
        for x in range(x1, x2 + 1)
        for z in range(z1, z2 + 1)
    ]
    cmds = [
        f"execute in {world} if block {x} {y} {z} minecraft:cobblestone"
        for x, y, z in cells
    ]
    hits = 0
    chunk = 80
    at = _agent_test()
    for i in range(0, len(cmds), chunk):
        out = at.run_rcon_batch(cmds[i : i + chunk])
        lines = (out or "").splitlines()
        for j in range(len(cmds[i : i + chunk])):
            line = lines[j] if j < len(lines) else ""
            if at._line_indicates_block_match(line):
                hits += 1
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--world", default=DEFAULT_WORLD)
    ap.add_argument("--explore-min", type=int, default=4)
    ap.add_argument("--skip-rcon", action="store_true", help="Skip cobble pad probe (offline)")
    args = ap.parse_args()

    db_path = kanban_db()
    if not db_path.exists():
        print(f"FAIL: no kanban db at {db_path}", file=sys.stderr)
        return 1

    marks = load_marks()
    anchor = marks.get("base_anchor")
    failures: list[str] = []

    if not anchor:
        failures.append("missing base_anchor mark (run reconcile-marks --auto)")

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    tasks = fetch_tasks(conn)
    epic = next((t for t in tasks if EPIC_TAG in (t["title"] or "")), None)
    if not epic:
        failures.append(f"no epic with {EPIC_TAG!r} on board")
        epic_id = None
    else:
        epic_id = str(epic["id"])
        if epic["status"] != "done":
            failures.append(f"epic {epic_id} status={epic['status']!r}, want done")

    explore_done = 0
    if epic_id:
        for t in tasks:
            title = t["title"] or ""
            if not title.startswith(EXPLORE_PREFIX):
                continue
            if epic_trailer(t["body"]) != epic_id:
                continue
            if t["status"] == "done":
                explore_done += 1
        if explore_done < args.explore_min:
            failures.append(
                f"[EXPLORE] done {explore_done} < {args.explore_min} (epic {epic_id})"
            )

    cobble = None
    if anchor and not args.skip_rcon:
        ax, ay, az = int(anchor["x"]), int(anchor["y"]), int(anchor["z"])
        cobble = count_cobble_pad(args.world, ax, ay, az)
        if cobble < COBBLE_MIN:
            failures.append(f"cobble pad {cobble}/{81} cells (< {COBBLE_MIN} threshold)")

    report = {
        "ok": not failures,
        "base_anchor": anchor,
        "cobble_cells": cobble,
        "explore_done": explore_done,
        "failures": failures,
    }
    print(json.dumps(report, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
