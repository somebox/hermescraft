#!/usr/bin/env python3
"""Planner-model secondary review (deterministic stub without --llm)."""
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
    p.add_argument("--no-llm", action="store_true", default=True)
    args = p.parse_args()
    root = args.run_dir or g2.run_dir(args.run_id)
    sc = json.loads((root / "scorecard.json").read_text()) if (root / "scorecard.json").is_file() else {}
    fb = json.loads((root / "feedback-bundle.json").read_text()) if (root / "feedback-bundle.json").is_file() else {}
    hotspots = (sc.get("metrics") or {}).get("motor", {}).get("hotspots") or []
    review = {
        "run_id": args.run_id,
        "model": None,
        "aligned_with_metrics": [],
        "contradictions": [],
        "proposed_next_steps": [],
        "confidence": "low",
    }
    if hotspots:
        review["proposed_next_steps"].append(
            {
                "title": f"Investigate motor hotspot {hotspots[0].get('verb')}",
                "source": "metrics",
                "priority": 1,
                "maps_to_next_action_type": "mc_motor_fix",
            }
        )
    if fb.get("retro_cards"):
        review["aligned_with_metrics"].append("retro packaged in feedback-bundle")
    (root / "planner-review.json").write_text(json.dumps(review, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
