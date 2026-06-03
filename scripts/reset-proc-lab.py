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
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


# Default bot names that may be in proc-lab pre-reset. Evac order matters
# (Steward last so her continuous orchestrator-loop doesn't grab a tile
# during the brief window between evac and delete).
DEFAULT_BOTS = ["Gatherer", "Flint", "Mason", "Steward"]


def build_evac_commands(*, hub: str, bots: list[str]) -> list[str]:
    """Phase 1 of the reset: evac all known bots to the hub. Offline bots
    are no-ops via Multiverse. Run before the player check so the resulting
    `list` reads accurately."""
    return [f"mvtp {bot} {hub}" for bot in bots]


def build_delete_commands(world: str) -> list[str]:
    """Phase 2: unload + request delete. The response will contain an
    OTP number we capture out-of-band and send via `build_confirm_command`.

    Multiverse's `mv delete` is two-stage by design:
      1. `mv delete <world>` returns "Are you sure? Run /mv confirm <N>"
      2. `mv confirm <N>` within 30s actually wipes the disc
    Without #2, NOTHING happens — and `mv list` shows the world still
    present, which is the failure mode that bit Phase 10 run-7 launch.
    See ~/.claude/projects/-Users-foz-hermescraft/memory/
    reference_mv_delete_requires_otp.md.
    """
    return [f"mv unload {world}", f"mv delete {world}"]


def build_confirm_command(otp: int) -> str:
    return f"mv confirm {otp}"


def build_create_commands(*, world: str, seed: str, generator: str = "NORMAL") -> list[str]:
    """Phase 3: create the fresh disc + read-back verify."""
    return [
        f"mv create {world} {generator} -s {seed}",
        "mv list",
    ]


def build_reset_commands(
    *,
    world: str,
    seed: str,
    hub: str,
    bots: list[str],
    generator: str = "NORMAL",
) -> list[str]:
    """Legacy single-batch sequence (no OTP handling). Used by --dry-run
    for documentation purposes. The live path uses the staged builders
    above so the OTP can be captured between batches."""
    cmds: list[str] = []
    cmds.extend(build_evac_commands(hub=hub, bots=bots))
    cmds.extend(build_delete_commands(world))
    cmds.extend(build_create_commands(world=world, seed=seed, generator=generator))
    return cmds


# OTP from `mv delete <world>` response.
_OTP_RE = re.compile(r"/mv confirm (\d+)", re.I)


def parse_delete_otp(stdout: str) -> int | None:
    """Extract the numeric OTP from a `mv delete` response. Returns None
    when not found (rare — either the command failed or MV version differs)."""
    m = _OTP_RE.search(stdout or "")
    return int(m.group(1)) if m else None


# Player line from rcon `list`:
#   "There are 1 of a max of 10 players online: re44"
_LIST_PLAYERS_RE = re.compile(
    r"There are \d+ of a max of \d+ players online:\s*(.*)",
    re.I,
)


def parse_online_players(stdout: str) -> list[str]:
    """Return the bare-name list of online players from rcon `list` stdout.
    Empty list if the line wasn't found (e.g. rcon transport injected
    other text)."""
    m = _LIST_PLAYERS_RE.search(stdout or "")
    if not m:
        return []
    raw = m.group(1).strip()
    if not raw:
        return []
    # Filter rcon prompt artifacts (`>`) and empty names. Minecraft player
    # names are alphanumeric + underscore (3-16 chars); anything not
    # starting with that pattern is transport noise.
    return [
        p.strip() for p in raw.split(",")
        if p.strip() and p.strip()[0].isalnum()
    ]


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
    ap.add_argument("--strict", action="store_true",
                    help="Refuse to proceed if any human player is online. "
                         "Default for test areas like proc-lab is to evac "
                         "humans to the hub via mvtp before delete; pass "
                         "--strict when targeting a non-test world.")
    args = ap.parse_args()

    bots = [b.strip() for b in args.bots.split(",") if b.strip()]

    if args.dry_run:
        cmds = build_reset_commands(
            world=args.world,
            seed=args.seed,
            hub=args.hub,
            bots=bots,
            generator=args.generator,
        )
        print("# Phase 10 PR-U reset (dry-run; live path stages these for OTP)")
        print(f"# world={args.world} seed={args.seed} hub={args.hub} generator={args.generator}")
        print(f"# bots={','.join(bots)}")
        for c in cmds:
            print(c)
        print("# (live path inserts `mv confirm <OTP>` between delete and create)")
        return 0

    print(f"== reset-proc-lab world={args.world} seed={args.seed} hub={args.hub} ==")
    rcon = _agent_test_module().run_rcon_batch

    # Stage 1: pre-flight player check. `mv delete` silently refuses when
    # players are in the world. proc-lab is a test area — operator policy
    # is to evac any online players to the hub automatically. --strict
    # opts into refusal for use against non-test worlds.
    print("  pre-flight player check…", end=" ", flush=True)
    try:
        list_out = rcon(["list"], timeout_s=15.0)
    except subprocess.TimeoutExpired:
        print("FAIL")
        print("  ! rcon `list` timed out — check ssh_docker connectivity", file=sys.stderr)
        return 2
    players = parse_online_players(list_out)
    if players and args.strict:
        print("REFUSED (strict)")
        print(f"  ! players online: {', '.join(players)}", file=sys.stderr)
        print(
            f"  Run `/mv tp {args.hub}` in-game to leave {args.world}, "
            "then re-run.\n  Or drop --strict to evac automatically.",
            file=sys.stderr,
        )
        return 4
    print("ok" if not players else f"online: {', '.join(players)}")

    # Stage 2: evac bots + any online humans (test-area default).
    targets = list(bots)
    if players and not args.strict:
        targets.extend(players)
    if targets:
        print(f"  evac → {args.hub}: {', '.join(targets)}")
        rcon(build_evac_commands(hub=args.hub, bots=targets), timeout_s=30.0)
        time.sleep(1.5)  # let the tp settle before delete

    # Stage 3: unload + delete (captures OTP).
    print(f"  mv unload + delete {args.world}…", end=" ", flush=True)
    try:
        del_out = rcon(build_delete_commands(args.world), timeout_s=30.0)
    except subprocess.TimeoutExpired:
        print("TIMEOUT")
        print("  ! rcon delete-batch timed out", file=sys.stderr)
        return 2
    otp = parse_delete_otp(del_out)
    if otp is None:
        print("FAIL")
        print("  ! couldn't parse OTP from `mv delete` response:", file=sys.stderr)
        print(f"  raw stdout:\n{del_out}", file=sys.stderr)
        return 5
    print(f"OTP={otp}")

    # Stage 4: confirm. Must be within 30s — single rcon shot, no
    # cross-session round-trip.
    print(f"  mv confirm {otp}…", end=" ", flush=True)
    try:
        rcon([build_confirm_command(otp)], timeout_s=15.0)
    except subprocess.TimeoutExpired:
        print("TIMEOUT")
        print("  ! OTP confirm timed out — world likely not deleted", file=sys.stderr)
        return 2
    time.sleep(1.0)
    print("ok")

    # Stage 5: verify the world was actually deleted by re-listing.
    # We expect proc-lab to be MISSING here — the delete just wiped it.
    verify_out = rcon(["mv list"], timeout_s=15.0)
    if args.world in verify_out:
        print(f"  ! {args.world} still in mv list after confirm — delete failed silently", file=sys.stderr)
        print(f"  raw output:\n{verify_out}", file=sys.stderr)
        return 6

    # Stage 6: create fresh disc.
    print(f"  mv create {args.world} {args.generator} -s {args.seed}…", end=" ", flush=True)
    try:
        create_out = rcon(build_create_commands(world=args.world, seed=args.seed, generator=args.generator), timeout_s=60.0)
    except subprocess.TimeoutExpired:
        print("TIMEOUT")
        print(f"  ! rcon create timed out — {args.world} may be in an inconsistent state", file=sys.stderr)
        return 2
    print("ok")
    if args.world not in create_out:
        print(f"  ! mv list post-create did not report {args.world}", file=sys.stderr)
        print(f"  raw output:\n{create_out}", file=sys.stderr)
        return 7
    print(f"  ✓ {args.world} freshly created (seed={args.seed})")

    print()
    print("Next: bash scripts/establish-scenario.sh   # bootstrap against fresh disc")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
