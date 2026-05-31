#!/usr/bin/env python3
"""Diff two inspect/generate JSON reports."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _flat_metrics(report: dict) -> dict:
    m = report.get("metrics") or {}
    out = {}
    for section, vals in m.items():
        if isinstance(vals, dict):
            for k, v in vals.items():
                out[f"{section}.{k}"] = v
    out["timing.total"] = (report.get("timing_seconds") or {}).get("total")
    out["seed"] = report.get("seed")
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("a", type=Path)
    p.add_argument("b", type=Path)
    args = p.parse_args()
    a = json.loads(args.a.read_text())
    b = json.loads(args.b.read_text())
    fa, fb = _flat_metrics(a), _flat_metrics(b)
    keys = sorted(set(fa) | set(fb))
    for k in keys:
        va, vb = fa.get(k), fb.get(k)
        if va != vb:
            print(f"{k}: {va!r} -> {vb!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
