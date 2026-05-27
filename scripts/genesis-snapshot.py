#!/usr/bin/env python3
"""Capture genesis run snapshot JSON."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
import genesis_lib as gl  # noqa: E402

SCHEMA_KEYS = frozenset(
    {
        "ts",
        "run_id",
        "elapsed_min",
        "seed",
        "difficulty",
        "base_anchor",
        "system_chest_at",
        "phase",
        "phase_completion",
        "resources",
        "marks",
        "kanban_events",
        "block_reasons",
        "phase_checks",
        "rescues",
        "findings",
        "poi_distance_min",
        "system_chest_usage",
    }
)


def _elapsed_min(started_at: str) -> int:
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - start
        return max(0, int(delta.total_seconds() / 60))
    except Exception:
        return 0


def _current_phase(tasks: list) -> str:
    for n in ("P1", "P2", "P3", "P4"):
        for t in tasks:
            if f"[GENESIS:{n}]" in (t.get("title") or ""):
                if (t.get("status") or "").lower() not in ("done", "archived"):
                    return n
    return "post-P4"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out-dir", default="")
    args = ap.parse_args()
    gl.validate_label(args.label)
    cfg = gl.load_config(args.run_id)
    out_dir = Path(args.out_dir) if args.out_dir else gl.run_dir(args.run_id)

    resources = {}
    proc = gl._run([sys.executable, str(REPO_ROOT / "scripts" / "base-inventory.py"), "--json"], timeout=30)
    if proc.returncode == 0:
        resources = json.loads(proc.stdout)

    marks_info = {"shared_count": 0, "private_total": 0, "by_prefix": {}, "stale_flagged": 0}
    loc = gl._load_json(gl.DATA_DIR / "locations-base.json", {})
    if isinstance(loc, dict):
        marks_info["shared_count"] = len(loc)
        for name in loc:
            for pref in ("chest_", "base_", "lt_", "mine_", "farm_"):
                if str(name).startswith(pref):
                    marks_info["by_prefix"][pref] = marks_info["by_prefix"].get(pref, 0) + 1

    kanban_events = {"created": 0, "completed": 0, "blocked": 0, "archived": 0, "reassigned": 0}
    block_reasons = {
        "region_blocked": 0,
        "prerequisite_missing": 0,
        "stuck_pocket_no_escape": 0,
        "decision_needed": 0,
        "other": 0,
    }
    try:
        br = gl._run(
            [sys.executable, str(REPO_ROOT / "scripts" / "board-recent.py"), "--since", "24h", "--json"],
            timeout=30,
        )
        if br.returncode == 0:
            events = json.loads(br.stdout)
            if isinstance(events, list):
                for ev in events:
                    et = (ev.get("type") or ev.get("event") or "").lower()
                    if "complete" in et:
                        kanban_events["completed"] += 1
                    elif "block" in et:
                        kanban_events["blocked"] += 1
                        reason = (ev.get("reason") or ev.get("detail") or "").lower()
                        if "region" in reason:
                            block_reasons["region_blocked"] += 1
                        elif "prereq" in reason:
                            block_reasons["prerequisite_missing"] += 1
                        else:
                            block_reasons["other"] += 1
    except Exception:
        pass

    phase_checks = gl.check_phases(cfg)
    tasks = gl._kanban_list()
    rescues_dir = out_dir / "rescues"
    rescue_total = len(list(rescues_dir.glob("*"))) if rescues_dir.exists() else 0

    snap = {
        "ts": gl._iso_utc(),
        "run_id": cfg["run_id"],
        "elapsed_min": _elapsed_min(cfg.get("started_at", "")),
        "seed": cfg.get("seed"),
        "difficulty": cfg.get("difficulty") or "peaceful",
        "base_anchor": cfg.get("base_anchor"),
        "system_chest_at": cfg.get("system_chest_at"),
        "phase": _current_phase(tasks),
        "phase_completion": {f"P{i}": {} for i in range(1, 5)},
        "resources": resources,
        "marks": marks_info,
        "kanban_events": kanban_events,
        "block_reasons": block_reasons,
        "phase_checks": phase_checks,
        "rescues": {"total": rescue_total, "by_bot": {}},
        "findings": {"steward_cycles": len(list((out_dir / "observations").glob("*.md"))) if (out_dir / "observations").exists() else 0},
        "poi_distance_min": None,
        "system_chest_usage": {"relief_events": 0},
    }

    out_path = out_dir / f"snapshot-{args.label}.json"
    out_path.write_text(json.dumps(snap, indent=2) + "\n")
    missing = SCHEMA_KEYS - set(snap.keys())
    if missing:
        print(f"warning: snapshot missing keys: {missing}", file=sys.stderr)
    print(out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
