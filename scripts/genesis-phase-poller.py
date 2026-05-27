#!/usr/bin/env python3
"""Poll kanban for [GENESIS:Pn] epic completion → difficulty + phase snapshot."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
import genesis_lib as gl  # noqa: E402

# Match `[GENESIS:Pn]` as a SUBSTRING — the actual title is prefixed with
# `[EPIC] ` (so worker/steward skills' [EPIC]-decomposition handlers fire),
# but we only key on the GENESIS tag for phase routing. Substring match
# keeps the poller robust to future title prefix additions.
PHASE_MAP = {
    "[GENESIS:P1]": ("P1", "phase1", None),
    "[GENESIS:P2]": ("P2", "phase2", None),
    "[GENESIS:P3]": ("P3", "phase3", "P3"),
    "[GENESIS:P4]": ("P4", "phase4", "P4"),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--interval", type=int, default=60)
    args = ap.parse_args()
    cfg = gl.load_config(args.run_id)
    seen: set[str] = set()
    while True:
        tasks = gl._kanban_list()
        for t in tasks:
            title = t.get("title") or ""
            if not title.startswith("[GENESIS:P"):
                continue
            status = (t.get("status") or "").lower()
            if status not in ("done", "archived"):
                continue
            key = title
            if key in seen:
                continue
            seen.add(key)
            for substring, (_p, label, diff_phase) in PHASE_MAP.items():
                if substring in title:
                    if diff_phase:
                        gl.apply_difficulty(diff_phase, cfg)
                    # Lock the base region to `protect` once the tower +
                    # shelter are built (P3 done). Before P3 close, `base`
                    # is `marker` so Phase 1/2 workers can dig/place freely
                    # inside the construction zone.
                    if label == "phase3":
                        try:
                            gl.lock_base_region_protect()
                        except Exception as e:
                            sys.stderr.write(f"lock_base_region_protect failed: {e}\n")
                    try:
                        gl.capture_snapshot(label, args.run_id)
                    except Exception as e:
                        sys.stderr.write(f"snapshot {label} failed: {e}\n")
                    break
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
