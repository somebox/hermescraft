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
        # Gateway watchdog FIRST: the hermes dispatcher is an asyncio task that can
        # die silently on a worker-crash path (gv2-2026-06-15-4), freezing dispatch
        # while the process stays up. If gateway.log is silent while genesis cards
        # await dispatch, bounce the gateway (cooldown-guarded) so a single mimo
        # crash can't quietly stall a whole run.
        try:
            if g2.maybe_restart_dead_gateway(args.run_id):
                sys.stderr.write("[poller] gateway dispatch looked dead (log silent + cards waiting) → restarted gateway\n")
        except Exception as e:
            sys.stderr.write(f"[poller] gateway watchdog failed: {e}\n")
        # Reap orphan leases FIRST: a worker that timed out / gave up / was killed
        # never ran `mc bot release`, so its body stays leased until the 1h TTL —
        # leak all three and the pool deadlocks (gv2-2026-06-15-3). Release any
        # lease whose owner task is terminal/absent before the pool-gate math runs,
        # so freed bodies are visible to requeue this same tick.
        try:
            reaped = g2.reap_orphan_leases(args.run_id)
            if reaped:
                sys.stderr.write(f"[poller] reaped {len(reaped)} orphan lease(s): "
                                 f"{[(r['bot'], r['status']) for r in reaped]}\n")
        except Exception as e:
            sys.stderr.write(f"[poller] orphan-lease reap failed: {e}\n")
        # Requeue deferred work: a worker that lost the lease race blocked itself
        # `no_free_body` (sticky — never retries alone). Once the pool frees up,
        # unblock those so dependents (e.g. BASE-SELECT waiting on all scouts)
        # don't stall behind them. Epics are never touched here.
        try:
            gate = g2.sync_body_pool_gates(args.run_id)
            if gate.get("blocked"):
                sys.stderr.write(f"[poller] pool gate blocked {gate['blocked']}\n")
            if gate.get("released"):
                sys.stderr.write(f"[poller] pool gate released {gate['released']}\n")
            if gate.get("released") or not gate.get("blocked"):
                requeued = g2.requeue_deferred(args.run_id)
                if requeued:
                    sys.stderr.write(f"[poller] requeued {len(requeued)} deferred card(s): {requeued}\n")
        except Exception as e:
            sys.stderr.write(f"[poller] body pool sync/requeue failed: {e}\n")
        try:
            if g2.maybe_render_shelter_for_run(args.run_id):
                sys.stderr.write("[poller] shelter structure rcon-rendered at base_anchor\n")
        except Exception as e:
            sys.stderr.write(f"[poller] shelter render failed: {e}\n")
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
        # Overseer review on phase transition: when the frontier phase's worker
        # cards are done but the gate hasn't closed (e.g. BUILD placed 1 of 2
        # chests, gv2-2026-06-15-4), file an [OVERSEE] card carrying the gate state
        # so the read-only OVERSEER agent verifies + files the missing worker
        # card(s) with judgment. This is the primary corrector; file_gate_gap_card
        # remains a latent mechanical backstop. The stuck-worker path only fires on
        # running/blocked workers, so this is what catches "done but gate unmet".
        try:
            gap = g2.detect_gate_gap(args.run_id)
            if gap:
                phase, failures = gap
                cid = g2.file_overseer_card(args.run_id, phase, {"pass": False, "failures": failures})
                if cid:
                    sys.stderr.write(f"[poller] {phase} gate unmet + no active cards ({failures}) → overseer review card {cid}\n")
        except Exception as e:
            sys.stderr.write(f"[poller] overseer review failed: {e}\n")
        # Continuous supply: keep base stocks above target_min. Reads the
        # genesis-aware base inventory each tick; when a resource is below target
        # (and the base is measurable), files a [GENESIS2:SUPPLY] card to the
        # restocking expertise (dedup+cap). Makes gathering a continuous need.
        try:
            for d in g2.detect_supply_deficits():
                cid = g2.file_supply_card(args.run_id, d)
                if cid:
                    sys.stderr.write(f"[poller] {d['resource']} low ({d['current']}<{d['target_min']}) → supply card {cid} ({d['assignee']})\n")
        except Exception as e:
            sys.stderr.write(f"[poller] supply check failed: {e}\n")
        # Planner re-engagement: a worker that's stuck — either RUNNING far longer
        # than a healthy one (~minutes) OR BLOCKED for a substantive reason (no
        # water, out of materials, unreachable; not no_free_body) — stalls the
        # colony. File a [SUPERVISE] card so the PLANNER investigates + re-scopes /
        # supplies a prerequisite. Run-age gating means a progressing worker is
        # never disrupted; the blocked path is what unsticks "all blocked, none
        # running" dead-ends.
        try:
            stalled = [{"id": w["id"], "title": w["title"],
                        "summary": f"running ~{w['age_s'] // 60}m with no completion"}
                       for w in g2.detect_stalled_workers()]
            stalled += g2.detect_blocked_workers()
            for w in stalled:
                cid = g2.file_supervise_card(args.run_id, w["id"], w["title"], w["summary"])
                if cid:
                    sys.stderr.write(f"[poller] worker {w['id']} stuck ({w['summary'][:40]}) → planner supervise card {cid}\n")
        except Exception as e:
            sys.stderr.write(f"[poller] stall-supervise failed: {e}\n")
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
