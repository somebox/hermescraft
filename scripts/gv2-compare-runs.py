#!/usr/bin/env python3
"""Compare two scored genesis-v2 runs (same metrics keys)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
import genesis2_lib as g2  # noqa: E402


def load_score(run_id: str) -> dict:
    p = g2.run_dir(run_id) / "scorecard.json"
    return json.loads(p.read_text())


def diff(a: dict, b: dict) -> dict:
    sa = a.get("summary") or {}
    sb = b.get("summary") or {}
    return {
        "a": a.get("run_id"),
        "b": b.get("run_id"),
        "overall_delta": (sb.get("overall") or 0) - (sa.get("overall") or 0),
        "establishment_delta": (
            (sb.get("achievement") or {}).get("establishment_score", 0)
            - (sa.get("achievement") or {}).get("establishment_score", 0)
        ),
        "level_a": (sa.get("achievement_level") or {}).get("current"),
        "level_b": (sb.get("achievement_level") or {}).get("current"),
        "compare_safe_a": (sa.get("compare") or {}).get("compare_safe"),
        "compare_safe_b": (sb.get("compare") or {}).get("compare_safe"),
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--prev-run-id", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    out = diff(load_score(args.prev_run_id), load_score(args.run_id))
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
