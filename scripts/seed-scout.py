#!/usr/bin/env python3
"""Seed scout — probe + classify the spawn neighborhood for several
candidate seeds and report which ones are viable for establishment.

Why
---
Phase-14 (seed 1001) put the resolved spawn on a tiny island; bots
drowned. Phase-15 (seed 20240601) found a 1-block stone column at
Y=201 in open ocean; bots fell 138 blocks to the seafloor. We need
to vet seeds *before* the operator commits a 60-90 min run to them.

What
----
For each --seed:
  1. Regenerate the proc-lab disc with that seed via reset-proc-lab.py.
  2. Read spawn (sx, sz) from data/runtime/last-establish-map.json (or
     the --sx/--sz overrides). Probe surface Y via mapcatalog's
     find_surface_heights.
  3. Run scan_neighborhood_safety (the same predicate establish-rcon-
     prep.py uses) across a (2*radius+1)² patch.
  4. Print one row per seed; mark PASS / REJECT based on land_pct.

Usage
-----
  scripts/seed-scout.py --seed 1001 --seed 20240601 --seed 3141592
  scripts/seed-scout.py --seed 12345 --radius 3 --min-land-pct 80
  scripts/seed-scout.py --seed 1001 --sx 4 --sz 24 --no-reset
                                         # skip the disc-regen step
                                         # (use the currently-loaded disc)

Output (example):
  seed=1001      probed_y= 64  land= 4/25 ( 16%)  cliff= 0  water=21  lava= 0  → REJECT
  seed=20240601  probed_y=201  land= 1/25 (  4%)  cliff=24  water= 0  lava= 0  → REJECT
  seed=3141592   probed_y= 82  land=24/25 ( 96%)  cliff= 0  water= 1  lava= 0  → PASS

The scout does NOT modify the catalog metadata. Once you pick a winner,
launch with `RUN_ID=phaseN scripts/establish-run.sh --fresh-disc <seed>`.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[1]
# mapcatalog is a sibling package (./mapcatalog), not installed.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_rcon_prep():
    """Import scripts/establish-rcon-prep.py as a module (it isn't a
    package member; the dashed filename blocks the normal import)."""
    spec = importlib.util.spec_from_file_location(
        "erp_mod", ROOT / "scripts" / "establish-rcon-prep.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


def _read_spawn_xz(map_json: Path) -> tuple[int, int]:
    if not map_json.is_file():
        return 4, 24  # catalog default for scenario_establish_explore
    try:
        card = json.loads(map_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return 4, 24
    placements = card.get("placements") or {}
    spawn = card.get("spawn") or placements.get("spawn") or [4, 96, 24]
    return int(spawn[0]), int(spawn[2])


def _reset_disc(seed: int, world: str, hub: str) -> None:
    """Run reset-proc-lab.py inline to regenerate the disc with `seed`."""
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "reset-proc-lab.py"),
        "--seed", str(seed),
        "--world", world,
        "--hub", hub,
    ]
    print(f"  ─ resetting disc to seed={seed}…", flush=True)
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.stderr.write(res.stdout)
        sys.stderr.write(res.stderr)
        raise SystemExit(f"reset-proc-lab.py failed for seed={seed} (rc={res.returncode})")


def scout_seed(erp, seed: int, *, world: str, hub: str,
               sx: int, sz: int, radius: int,
               min_land_pct: float, do_reset: bool) -> dict:
    """Materialize seed, probe + scan, return a result dict."""
    from mapcatalog.rcon_client import SshDockerRcon

    if do_reset:
        _reset_disc(seed, world, hub)
    ssh_host, container = erp._read_rcon_config(ROOT / "server.local.yaml")
    client = SshDockerRcon(ssh_host=ssh_host, container=container)

    probed_y = erp.probe_surface_y(
        world=world, sx=sx, sz=sz,
        ssh_host=ssh_host, container=container,
    )
    if probed_y is None:
        return {
            "seed": seed, "probed_y": None,
            "land": 0, "columns": 0, "land_pct": 0.0,
            "water": 0, "lava": 0, "cliff": 0, "air": 0,
            "verdict": "REJECT", "reason": "probe returned None",
        }
    scan = erp.scan_neighborhood_safety(
        client, world=world, sx=sx, sy=probed_y, sz=sz, radius=radius,
    )
    verdict = "PASS" if scan["land_pct"] >= min_land_pct else "REJECT"
    reason = (
        f"land_pct {scan['land_pct']:.0f}% < {min_land_pct:.0f}%"
        if verdict == "REJECT"
        else "ok"
    )
    return {
        "seed": seed, "probed_y": probed_y,
        **{k: scan[k] for k in ("land", "water", "lava", "cliff", "air",
                                 "columns", "land_pct")},
        "verdict": verdict, "reason": reason,
    }


def _fmt_row(r: dict) -> str:
    py = "?" if r["probed_y"] is None else str(r["probed_y"])
    return (
        f"seed={r['seed']:<10} probed_y={py:>4}  "
        f"land={r['land']:>2}/{r['columns']:<2} "
        f"({r['land_pct']:>4.0f}%)  "
        f"cliff={r['cliff']:>2}  water={r['water']:>2}  lava={r['lava']:>2}  "
        f"→ {r['verdict']}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", action="append", required=True, type=int,
                    help="Seed candidate (repeatable: --seed 1001 --seed 20240601)")
    ap.add_argument("--world", default="proc-lab")
    ap.add_argument("--hub", default="landfolk-test",
                    help="Hub world to evacuate to before disc reset")
    ap.add_argument("--sx", type=int, default=None, help="Override spawn X")
    ap.add_argument("--sz", type=int, default=None, help="Override spawn Z")
    ap.add_argument("--radius", type=int, default=2,
                    help="Scan a (2*radius+1)² patch (default: 5×5)")
    ap.add_argument("--min-land-pct", type=float, default=80.0,
                    help="PASS threshold land%% (default 80%%)")
    ap.add_argument("--no-reset", action="store_true",
                    help="Skip the reset-proc-lab.py step (use loaded disc only)")
    ap.add_argument("--json", action="store_true",
                    help="Emit machine-readable JSON instead of a table")
    args = ap.parse_args()

    if args.no_reset and len(args.seed) > 1:
        raise SystemExit("--no-reset is only meaningful with a single --seed "
                         "(without disc regen the world doesn't change)")

    erp = _load_rcon_prep()
    map_json = ROOT / "data" / "runtime" / "last-establish-map.json"
    sx = args.sx if args.sx is not None else _read_spawn_xz(map_json)[0]
    sz = args.sz if args.sz is not None else _read_spawn_xz(map_json)[1]

    results = []
    for seed in args.seed:
        try:
            r = scout_seed(
                erp, seed, world=args.world, hub=args.hub,
                sx=sx, sz=sz, radius=args.radius,
                min_land_pct=args.min_land_pct,
                do_reset=not args.no_reset,
            )
        except SystemExit as exc:
            r = {"seed": seed, "verdict": "ERROR", "reason": str(exc),
                 "probed_y": None, "land": 0, "columns": 0, "land_pct": 0.0,
                 "water": 0, "lava": 0, "cliff": 0, "air": 0}
        results.append(r)
        if not args.json:
            print(_fmt_row(r))

    if args.json:
        print(json.dumps({"sx": sx, "sz": sz, "radius": args.radius,
                          "min_land_pct": args.min_land_pct, "results": results},
                          indent=2))
        return 0

    winners = [r for r in results if r["verdict"] == "PASS"]
    if winners:
        best = max(winners, key=lambda r: r["land_pct"])
        print()
        print(f"  winner: seed={best['seed']}  ({best['land_pct']:.0f}% land at "
              f"({sx},{best['probed_y']},{sz}))")
        print(f"  launch: RUN_ID=phaseN scripts/establish-run.sh "
              f"--fresh-disc {best['seed']} --min-credits-usd 5 --archive-logs")
        return 0

    print()
    print("  no candidate passed — broaden the seed list or relax --min-land-pct")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
