#!/usr/bin/env python3
"""Preflight after establish TP: reject meaningless terrain at muster.

Fails when terrain kind is `unknown` and |feet_vs_local_ground| exceeds
threshold (run-8 spawn prep: canopy misclassified as unknown with large offset).
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def default_probe_ports() -> list[int]:
    """Worker + orchestrator API ports from data/agent-models.json."""
    path = REPO / "data" / "agent-models.json"
    if not path.is_file():
        return [3001, 3002, 3003, 3005]
    doc = json.loads(path.read_text())
    ports: list[int] = []
    for _name, spec in (doc.get("agents") or {}).items():
        p = spec.get("api_port")
        if isinstance(p, int):
            ports.append(p)
    return sorted(set(ports)) or [3001, 3002, 3003, 3005]


def fetch_nav_header(port: int, timeout: float = 3.0) -> dict:
    url = f"http://127.0.0.1:{port}/status"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode())
    return (body.get("data") or body).get("nav_header") or {}


def check_muster_terrain(
    nav_header: dict,
    *,
    max_abs_feet_offset: int = 8,
) -> list[str]:
    errors: list[str] = []
    terrain = nav_header.get("terrain") or {}
    kind = terrain.get("kind")
    feet_off = terrain.get("feet_vs_local_ground")
    if kind == "unknown" and feet_off is not None:
        try:
            off = int(feet_off)
        except (TypeError, ValueError):
            off = 0
        if abs(off) > max_abs_feet_offset:
            errors.append(
                f"terrain=unknown with feet_vs_local_ground={off} "
                f"(|offset|>{max_abs_feet_offset}); fix spawn/canopy or re-probe muster"
            )
    return errors


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--port",
        type=int,
        action="append",
        default=[],
        help="Bot HTTP port(s) to probe (repeatable). Default: agent-models.json api_port values",
    )
    p.add_argument("--max-feet-offset", type=int, default=8)
    args = p.parse_args()
    ports = args.port or default_probe_ports()
    failed = False
    for port in ports:
        try:
            hdr = fetch_nav_header(port)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print(f"port {port}: skip ({e})", file=sys.stderr)
            continue
        errs = check_muster_terrain(hdr, max_abs_feet_offset=args.max_feet_offset)
        if errs:
            failed = True
            for msg in errs:
                print(f"port {port}: FAIL {msg}")
        else:
            t = hdr.get("terrain") or {}
            print(
                f"port {port}: ok terrain={t.get('kind')} "
                f"feet_vs_local_ground={t.get('feet_vs_local_ground')}"
            )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
