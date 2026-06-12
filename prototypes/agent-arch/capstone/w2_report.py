#!/usr/bin/env python3
"""Tiered W2 pass/fail report from scorecards + artifacts."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
POSTMORTEMS = REPO / "data/postmortems/wheat-capstone"
ARTIFACTS = POSTMORTEMS / "_w2_artifacts.json"
REGISTRY = POSTMORTEMS / "_known_issues.json"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text()) if path.is_file() else {}


def tier_minimum(artifacts: dict, registry: dict) -> bool:
    scripts = artifacts.get("scripts") or {}
    promoted = len(scripts) >= 1
    resolved = any(
        i.get("status") == "resolved" and i.get("resolved_by_run")
        for i in registry.get("issues", [])
        if str(i.get("id", "")).startswith("W2-AUTO")
    )
    return promoted and resolved


def farmer_wall_time(scorecard: dict) -> int | None:
    # Placeholder — manifest lacks per-card timing; use wall_time_s proxy.
    return scorecard.get("wall_time_s")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--baseline", default="")
    args = ap.parse_args()
    sc = load_json(POSTMORTEMS / args.run_id / "scorecard.json")
    base = load_json(POSTMORTEMS / args.baseline / "scorecard.json") if args.baseline else {}
    art = load_json(ARTIFACTS)
    reg = load_json(REGISTRY)

    report = {
        "run_id": args.run_id,
        "tier_minimum": tier_minimum(art, reg),
        "tier_stretch_efficiency": False,
        "band": sc.get("band"),
        "graph": sc.get("graph"),
        "fixture_seed": sc.get("fixture_seed"),
        "survey_cache": art.get("survey_cache"),
        "manual_interventions": sc.get("manual_interventions", []),
    }
    wt = farmer_wall_time(sc)
    bwt = farmer_wall_time(base)
    if wt and bwt and bwt > 0 and wt <= int(bwt * 0.9):
        report["tier_stretch_efficiency"] = True

    out = POSTMORTEMS / args.run_id / "w2-report.json"
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
