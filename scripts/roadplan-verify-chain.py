#!/usr/bin/env python3
"""Phase 3 acceptance gate for a planner-agent road run.

Asserts, from durable state + the live world, that the agent actually
produced a confirmed, lit, walkable plan — not just that it ran. Exits
non-zero with a reason on any failure so `roadplan-exercise.sh` (or CI)
can gate on it rather than eyeballing.

Checks:
  1. state.json has a solved route.
  2. The route is `natural` (a construction route isn't walkable yet —
     `confirm` refuses it; only natural routes reach a lit chain). Pass
     --allow-construction to skip this when testing the build path.
  3. Every route waypoint is status=confirmed with a torch_at.
  4. Each torch is physically present in-world on natural ground (torch
     block present AND the cell below is solid, i.e. not air/fluid) —
     the §11.1 no-fabricated-base doctrine, checked impartially via RCON.

Usage:
  scripts/roadplan-verify-chain.py --ledger /tmp/live --world proc-nav
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))

from roadplan.ledger import read_state  # noqa: E402


def _fail(msg):
    print(f"GATE FAIL: {msg}", file=sys.stderr)
    return 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ledger", required=True, type=Path)
    ap.add_argument("--world", default="proc-nav")
    ap.add_argument("--server-config", default=str(REPO / "server.local.yaml"))
    ap.add_argument("--allow-construction", action="store_true",
                    help="Don't require route_class==natural (build-path test)")
    args = ap.parse_args(argv)

    state = read_state(args.ledger)
    if not state or not state.get("routes"):
        return _fail("no solved route in state.json")
    route = state["routes"][-1]
    rclass = route.get("route_class", "?")
    if rclass != "natural" and not args.allow_construction:
        return _fail(f"route is '{rclass}', not natural — not a walkable lit "
                     f"chain (needs the build role first)")

    route_wps = {(w[0], w[2]) for w in route.get("waypoints", [])}
    wps = [w for w in state.get("waypoints", [])
           if (w["pos"][0], w["pos"][2]) in route_wps]
    if not wps:
        return _fail("no waypoints allocated for the route")

    unconfirmed = [w["name"] for w in wps if w.get("status") != "confirmed"]
    if unconfirmed:
        return _fail(f"{len(unconfirmed)} waypoint(s) not confirmed: "
                     f"{unconfirmed[:5]}")
    missing_torch = [w["name"] for w in wps if not w.get("torch_at")]
    if missing_torch:
        return _fail(f"waypoint(s) with no torch_at: {missing_torch[:5]}")

    # In-world verification via RCON: torch present + solid natural support.
    try:
        from mapcatalog.rcon_client import make_rcon
        from mapcatalog.server_config import load_server_config
    except ImportError as e:
        return _fail(f"mapcatalog not importable for in-world check: {e}")
    client = make_rcon(load_server_config(Path(args.server_config)))
    probes = []
    for w in wps:
        x, y, z = w["torch_at"]
        probes.append(f"execute in {args.world} if block {x} {y} {z} minecraft:torch")
        probes.append(f"execute in {args.world} if block {x} {y - 1} {z} #minecraft:air")
    out = client.run_batch(probes)
    lines = [ln for ln in (out or "").splitlines() if "Test" in ln]
    if len(lines) < 2 * len(wps):
        return _fail(f"RCON probe misalignment ({len(lines)} of {2*len(wps)})")
    bad = []
    for i, w in enumerate(wps):
        torch_present = "passed" in lines[2 * i]
        support_air = "passed" in lines[2 * i + 1]
        if not torch_present or support_air:
            bad.append((w["name"], w["torch_at"],
                        "no_torch" if not torch_present else "no_support"))
    if bad:
        return _fail(f"{len(bad)} torch(es) not on natural ground: {bad[:5]}")

    print(f"GATE PASS: route '{rclass}', {len(wps)}/{len(wps)} waypoints "
          f"confirmed, all torches on natural ground "
          f"(cost {route.get('cost')}, {route.get('est_edits')} edits)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
