#!/usr/bin/env python3
"""Print genesis-v2 establishment ladder score for a run directory."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

import genesis2_lib as g2  # noqa: E402
from lib.gv2_establishment_ladder import evaluate_run_dir, format_one_line  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Genesis-v2 establishment ladder")
    p.add_argument("--run-id", help="Run id under data/genesis-v2-runs/")
    p.add_argument("--run-dir", type=Path, help="Override run root (fixtures)")
    p.add_argument("--live-marks", action="store_true", help="Fall back to data/locations-base.json")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    if args.run_dir:
        root = args.run_dir
    elif args.run_id:
        root = g2.run_dir(args.run_id)
    else:
        rid = g2.active_run_id()
        if not rid:
            print("establishment: unavailable (no run)", file=sys.stderr)
            return 2
        root = g2.run_dir(rid)
    if not (root / "config.json").is_file() and not (root / "artifacts").is_dir():
        print("establishment: unavailable (missing run dir)", file=sys.stderr)
        return 2
    result = evaluate_run_dir(root, live_marks=args.live_marks)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(format_one_line(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
