#!/usr/bin/env python3
"""POST catalog anchors as marks to Mox (:3007) and Tester (:3004)."""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MAP = ROOT / "data/runtime/last-scenario-map.json"
DEFAULT_PORTS = (3007, 3004)
MARK_NAMES = ("spawn", "muster", "overlook", "return_post", "farm_patch")


def anchor_xyz(card: dict, name: str) -> tuple[int, int, int] | None:
    placements = card.get("placements") or {}
    raw = placements.get(name) or card.get(name)
    if not isinstance(raw, (list, tuple)) or len(raw) < 3:
        return None
    return int(raw[0]), int(raw[1]), int(raw[2])


def post_mark(port: int, name: str, x: int, y: int, z: int) -> bool:
    url = f"http://127.0.0.1:{port}/action/mark"
    body = json.dumps({
        "name": name,
        "at": {"x": x, "y": y, "z": z},
        "note": f"proc-scout prep {name}",
    }).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return 200 <= resp.status < 300
    except urllib.error.URLError as exc:
        print(f"[prep-marks] port={port} mark={name}: {exc}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--map-json", type=Path, default=DEFAULT_MAP)
    ap.add_argument("--ports", default=",".join(str(p) for p in DEFAULT_PORTS))
    args = ap.parse_args()
    if not args.map_json.is_file():
        print(f"[prep-marks] missing {args.map_json}")
        return 1
    card = json.loads(args.map_json.read_text(encoding="utf-8"))
    ports = [int(p.strip()) for p in args.ports.split(",") if p.strip()]
    ok = 0
    for name in MARK_NAMES:
        xyz = anchor_xyz(card, name)
        if not xyz:
            continue
        x, y, z = xyz
        for port in ports:
            if post_mark(port, name, x, y, z):
                ok += 1
                print(f"[prep-marks] OK {name} @ {x},{y},{z} port={port}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
