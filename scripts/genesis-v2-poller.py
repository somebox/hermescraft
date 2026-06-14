#!/usr/bin/env python3
"""Poll the genesis-v2 board for [GENESIS2:Pn] epic completion → phase snapshot.

Lighter than the legacy genesis poller: world stays peaceful (no difficulty
ramp), so on each phase-epic completion we just capture a labeled snapshot for
postmortem. The depends_on chain (seeded by genesis2_lib.seed_board) handles
promoting the next phase epic to ready.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
import genesis2_lib as g2  # noqa: E402

PHASE_LABEL = {f"[GENESIS2:P{i}]": f"phase{i}" for i in range(1, 6)}


def _board_tasks() -> list[dict]:
    p = subprocess.run(["hermes", "kanban", "--board", g2.BOARD, "list", "--json"],
                       cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        return []
    data = json.loads(p.stdout or "[]")
    return data if isinstance(data, list) else data.get("tasks", [])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--interval", type=int, default=60)
    args = ap.parse_args()
    seen: set[str] = set()
    while True:
        # Gate-gated advance: complete only the epics whose real-world gate
        # passes (the Steward never completes its own epics). Snapshot each
        # phase as it genuinely closes.
        try:
            for phase in g2.complete_passed_epics(args.run_id):
                label = f"phase{phase[1:]}"
                if label not in seen:
                    seen.add(label)
                    try:
                        g2.snapshot(label, args.run_id)
                        sys.stderr.write(f"[poller] {phase} gate passed → epic completed, {label} snapshot\n")
                    except Exception as e:
                        sys.stderr.write(f"[poller] snapshot {label} failed: {e}\n")
        except Exception as e:
            sys.stderr.write(f"[poller] gate check failed: {e}\n")
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
