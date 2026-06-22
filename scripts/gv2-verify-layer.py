#!/usr/bin/env python3
"""CLI for verify_layer — read-only rcon pad-acceptance gate.

Examples:
  gv2-verify-layer.py --origin 53,63,49 --footprint 7,7 --offset -1 --gate ground --apron 1
  gv2-verify-layer.py --origin 53,63,49 --gate fixtures --fixtures 56,49,chest 59,49,chest
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))

import genesis2_lib as g2  # noqa: E402
from scripts.lib.gv2_layer_verify import verify_layer  # noqa: E402


def _triple(s):
    return tuple(int(v) for v in s.split(","))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--origin", required=True, help="x,y,z of base origin")
    p.add_argument("--footprint", default="7,7", help="w,d")
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--gate", required=True, choices=["ground", "slab", "fixtures"])
    p.add_argument("--apron", type=int, default=0)
    p.add_argument("--world", default="genesis2")
    p.add_argument("--fixtures", nargs="*", default=[], help="x,z,block …")
    p.add_argument("--json", action="store_true")
    a = p.parse_args()

    fixtures = None
    if a.gate == "fixtures":
        fixtures = []
        for f in a.fixtures:
            x, z, block = f.split(",")
            fixtures.append((int(x), int(z), block))

    w, d = (int(v) for v in a.footprint.split(","))
    r = verify_layer(
        origin=_triple(a.origin), footprint=(w, d), offset=a.offset, gate=a.gate,
        rcon_fn=g2.rcon_in, world=a.world, apron=a.apron, fixtures=fixtures,
    )
    if a.json:
        print(json.dumps(r))
    else:
        verdict = "PASS" if r["ok"] else "FAIL"
        print(f"[verify_layer {a.gate} y={r['layer_y']}] {verdict} — {r['total_cells']} cells")
        print(f"  coverage: {r['coverage']}")
        if not r["ok"]:
            print(f"  gate_failed: {r['gate_failed']}")
            for o in r["offenders"][:12]:
                print(f"    offender ({o['x']},{o['y']},{o['z']}): found={o['found']} expected={o['expected']}")
    return 0 if r["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
