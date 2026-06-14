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
        # Promote per-bot marks to the shared map BEFORE checking gates: workers
        # `mc mark` to their private locations-<bot>.json (the reconciler is the
        # sole writer to the shared file), so without this the gates never see
        # scout marks. Consensus-only (--auto); single-proposer marks promote.
        try:
            bots = ",".join(g2.BODY_POOL.keys())  # genesis bodies only — don't pull prod marks
            subprocess.run([sys.executable, str(REPO_ROOT / "scripts" / "reconcile-marks.py"),
                            "--auto", "--bots", bots],
                           cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
        except Exception as e:
            sys.stderr.write(f"[poller] reconcile-marks failed: {e}\n")
        # Requeue deferred work: a worker that lost the lease race blocked itself
        # `no_free_body` (sticky — never retries alone). Once the pool frees up,
        # unblock those so dependents (e.g. BASE-SELECT waiting on all scouts)
        # don't stall behind them. Epics are never touched here.
        try:
            requeued = g2.requeue_deferred(args.run_id)
            if requeued:
                sys.stderr.write(f"[poller] requeued {len(requeued)} deferred card(s): {requeued}\n")
        except Exception as e:
            sys.stderr.write(f"[poller] requeue_deferred failed: {e}\n")
        # Poller-authoritative advance: complete the epic whose real-world gate
        # passes AND unblock the next (parked) phase epic. Sole promoter — the
        # next phase stays blocked until its predecessor's gate truly passes, so a
        # Steward worker finishing early can't cascade. Snapshot each phase close.
        try:
            for phase in g2.advance_phases(args.run_id):
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
