#!/usr/bin/env python3
"""Compare two genesis run snapshots."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS = REPO_ROOT / "data" / "genesis-runs"


def _load_snap(run_id: str, label: str) -> dict | None:
    p = RUNS / run_id / f"snapshot-{label}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())


def _best_snap(run_id: str) -> dict | None:
    for label in ("end", "phase4", "phase3", "phase2", "phase1", "start"):
        s = _load_snap(run_id, label)
        if s:
            return s
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_id_a")
    ap.add_argument("run_id_b")
    args = ap.parse_args()

    sa = _best_snap(args.run_id_a)
    sb = _best_snap(args.run_id_b)
    if not sa or not sb:
        print("missing snapshot for one or both runs", file=sys.stderr)
        return 1

    lines = [
        f"# Genesis diff: {args.run_id_a} vs {args.run_id_b}",
        "",
        "| metric | A | B |",
        "|---|---|---|",
        f"| seed | {sa.get('seed')} | {sb.get('seed')} |",
        f"| elapsed_min | {sa.get('elapsed_min')} | {sb.get('elapsed_min')} |",
        f"| phase | {sa.get('phase')} | {sb.get('phase')} |",
        f"| rescues | {(sa.get('rescues') or {}).get('total')} | {(sb.get('rescues') or {}).get('total')} |",
    ]
    for res in ("food", "wood", "stone"):
        ca = (sa.get("resources") or {}).get(res, {}).get("current", "?")
        cb = (sb.get("resources") or {}).get(res, {}).get("current", "?")
        lines.append(f"| {res} current | {ca} | {cb} |")

    marks_a = (sa.get("marks") or {}).get("shared_count", 0)
    marks_b = (sb.get("marks") or {}).get("shared_count", 0)
    lines.append(f"| shared marks | {marks_a} | {marks_b} |")

    for run_id, letter in ((args.run_id_a, "A"), (args.run_id_b, "B")):
        digest = RUNS / run_id / "digest.md"
        if digest.exists():
            lines.append(f"\nDigest {letter}: `{digest}`")

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
