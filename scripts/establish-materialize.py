#!/usr/bin/env python3
"""Materialize proc-lab for an establishment.explore map (mapcatalog try)."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _resolve_req(req: str) -> Path:
    p = Path(req)
    if p.is_absolute():
        return p
    return ROOT / req


def run_try(*, req_path: Path, server: Path, seed: str, reuse_world: bool) -> dict:
    # Phase 8 (2026-06-03): upstream `mapcatalog try` requires the
    # requirements via `-r` / `--requirements`, not positional. Without
    # the flag the bootstrap dies with "mapcatalog try: error: the
    # following arguments are required: -r/--requirements", breaking
    # the AUTO_REUSE=0 MATERIALIZE=1 fresh-disc path. (Identical fix
    # may apply to scripts/agent-test-from-map.py:87 if that path is
    # ever exercised — leaving for now since this is the establish path.)
    cmd = [
        sys.executable,
        "-m",
        "mapcatalog",
        "try",
        "-r",
        str(req_path),
        "-s",
        str(server),
        "--seed",
        str(seed),
        "--json-full",
    ]
    if reuse_world:
        cmd.append("--reuse-world")
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        print(proc.stdout or proc.stderr, file=sys.stderr)
        raise SystemExit(proc.returncode or 1)
    card = json.loads(proc.stdout)
    if not card.get("ok"):
        reasons = card.get("reasons") or ["try failed"]
        raise SystemExit(f"mapcatalog try seed={seed}: {'; '.join(reasons)}")
    return card


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--map", type=Path, required=True)
    ap.add_argument("-s", "--server", type=Path, default=ROOT / "server.local.yaml")
    ap.add_argument(
        "--reuse-world",
        action=argparse.BooleanOptionalAction,
        default=os.environ.get("PROC_LAB_REUSE", "1") != "0",
    )
    args = ap.parse_args()

    card = json.loads(args.map.read_text(encoding="utf-8"))
    meta = card.get("_scenario") or {}
    req = meta.get("requirements")
    seed = card.get("seed")
    if not req or not seed:
        raise SystemExit("map JSON missing _scenario.requirements or seed")
    out = run_try(
        req_path=_resolve_req(str(req)),
        server=args.server,
        seed=str(seed),
        reuse_world=args.reuse_world,
    )
    print(json.dumps({"ok": True, "seed": out.get("seed"), "world": out.get("world_name")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
