#!/usr/bin/env python3
"""Phase 10 PR-U — fresh-world bootstrap for run-7.

Resets the proc-lab Minecraft world to a known-clean state by evacuating
players to the hub, deleting the world via Multiverse, and creating a
fresh disc with the configured seed. Removes the run-5/run-6 residual
contamination (Z=54 oak_door tar-pit, Z=62 cobble shelter trap) that
made apples-to-apples baselines noisier than they were worth.

Why not `AUTO_REUSE=0 MATERIALIZE=1`?  Phase 8 evidence: the
`mapcatalog try` path through ssh_docker rcon hung at 5-6 min during
fresh-disc materialization. Cause unidentified. This script is the
coarser-but-reliable Path 2 from the Phase 10 plan: drop the world,
recreate it via mv, let the next `establish-scenario.sh` invocation
bootstrap normally against a clean disc.

Usage
-----
  scripts/reset-proc-lab.py --seed 1001
  scripts/reset-proc-lab.py --seed 1001 --dry-run   # print commands
  scripts/reset-proc-lab.py --seed 1001 --world proc-lab --hub landfolk-test

Pre-run-7 sequence (operator):
  1. bash scripts/landfolk stop                     # stop any active fleet
  2. python3 scripts/reset-proc-lab.py --seed 1001  # fresh disc
  3. AUTO_REUSE=1 MATERIALIZE=0 bash scripts/establish-scenario.sh
                                                    # normal bootstrap;
                                                    # AUTO_REUSE=1 is safe
                                                    # because the disc is
                                                    # now clean.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


# Default bot names that may be in proc-lab pre-reset. Evac order matters
# (Steward last so her continuous orchestrator-loop doesn't grab a tile
# during the brief window between evac and delete).
DEFAULT_BOTS = ["Gatherer", "Flint", "Mason", "Steward"]


def build_reset_commands(
    *,
    world: str,
    seed: str,
    hub: str,
    bots: list[str],
    generator: str = "NORMAL",
) -> list[str]:
    """Phase 10 PR-U command sequence builder. Pure function — testable
    without the rcon transport.

    Returns the rcon command list in execution order:
      1. evac each bot to the hub (`mvtp` is the safe-tp form)
      2. mv unload world (gentle release before delete)
      3. mv delete world (wipes disc)
      4. mv create world with seed
      5. mv tp probe — sanity-check world exists by reading its list entry
    """
    cmds: list[str] = []
    # 1. Evac. Multiverse `mvtp <player> <world>` requires the player be
    # online; offline players are no-ops with a warning we swallow.
    for bot in bots:
        cmds.append(f"mvtp {bot} {hub}")
    # 2. Unload — flush chunks, releases file handles cleanly.
    cmds.append(f"mv unload {world}")
    # 3. Delete — wipes the world disc files.
    cmds.append(f"mv delete {world}")
    # 4. Create fresh disc.
    cmds.append(f"mv create {world} {generator} -s {seed}")
    # 5. Read-back: `mv list` includes the new world entry if creation
    # succeeded. The caller greps for the world name in the stdout.
    cmds.append("mv list")
    return cmds


def _agent_test_module():
    """Load `scripts/agent-test.py` for `run_rcon_batch` (mirror the
    convention from establish-rcon-prep.py)."""
    spec = importlib.util.spec_from_file_location(
        "agent_test_mod", ROOT / "scripts" / "agent-test.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


def _load_server_config(path: Path) -> dict:
    """Read server.local.yaml for hub/world defaults. Returns {} if file
    missing — operator can pass --world/--hub explicitly."""
    if not path.is_file():
        return {}
    try:
        import yaml  # type: ignore
    except ImportError:
        # No yaml available — coarse INI-ish extraction.
        text = path.read_text(encoding="utf-8")
        out: dict = {"world": {}, "evac": {}}
        for line in text.splitlines():
            if ": " in line and not line.lstrip().startswith("#"):
                key, val = line.split(":", 1)
                out.setdefault("_flat", {})[key.strip()] = val.strip().strip("\"'")
        return out
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    cfg = _load_server_config(ROOT / "server.local.yaml")
    default_world = (cfg.get("world") or {}).get("name", "proc-lab")
    default_hub = (cfg.get("evac") or {}).get("hub_world", "landfolk-test")
    default_generator = (cfg.get("world") or {}).get("generator", "NORMAL")

    ap.add_argument("--world", default=default_world,
                    help=f"World to reset (default from server.local.yaml: {default_world})")
    ap.add_argument("--seed", default="1001",
                    help="Seed for the fresh world (default: 1001 — same as run-5/6 for cross-run comparison)")
    ap.add_argument("--hub", default=default_hub,
                    help=f"Hub world to evac bots into (default: {default_hub})")
    ap.add_argument("--generator", default=default_generator,
                    help="World generator (default: NORMAL)")
    ap.add_argument("--bots", default=",".join(DEFAULT_BOTS),
                    help="Comma-list of bot names to evac (default: Gatherer,Flint,Mason,Steward)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the rcon command sequence without executing")
    ap.add_argument("--no-verify", action="store_true",
                    help="Skip the post-create `mv list` read-back")
    args = ap.parse_args()

    bots = [b.strip() for b in args.bots.split(",") if b.strip()]
    cmds = build_reset_commands(
        world=args.world,
        seed=args.seed,
        hub=args.hub,
        bots=bots,
        generator=args.generator,
    )
    if args.no_verify:
        # Drop the `mv list` read-back.
        cmds = [c for c in cmds if c != "mv list"]

    if args.dry_run:
        print("# Phase 10 PR-U reset (dry-run)")
        print(f"# world={args.world} seed={args.seed} hub={args.hub} generator={args.generator}")
        print(f"# bots={','.join(bots)}")
        for c in cmds:
            print(c)
        return 0

    print(f"== reset-proc-lab world={args.world} seed={args.seed} hub={args.hub} ==")
    print(f"  evac bots: {', '.join(bots)}")
    print(f"  rcon commands: {len(cmds)}")

    t0 = time.time()
    try:
        out = _agent_test_module().run_rcon_batch(cmds, timeout_s=120.0)
    except subprocess.TimeoutExpired:
        print("  ! rcon batch timed out after 120s — check ssh_docker connectivity", file=sys.stderr)
        return 2
    elapsed = time.time() - t0
    print(f"  rcon batch ok ({elapsed:.1f}s)")

    if not args.no_verify:
        # Parse the final `mv list` output for our world name.
        out_lines = (out or "").splitlines()
        # Multiverse output format: `&aproc-lab &b- NORMAL ...` (with color codes
        # stripped or kept depending on the rcon-cli wrapper). Be lenient: just
        # check for the world name in any line.
        if not any(args.world in line for line in out_lines):
            print(f"  ! mv list did not report {args.world}; create may have failed", file=sys.stderr)
            print(f"  raw output:\n{out}", file=sys.stderr)
            return 3
        print(f"  ✓ {args.world} present in mv list — fresh world ready")

    print(f"Next: bash scripts/establish-scenario.sh   # bootstrap against fresh disc")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
