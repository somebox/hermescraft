#!/usr/bin/env python3
"""Pretty-tail /tmp/hermescraft/mc-advise.jsonl.

Usage:
  scripts/watch-advise.py                    # follow new entries
  scripts/watch-advise.py --last 10          # last N entries, no follow
  scripts/watch-advise.py --kind scene       # filter by kind
  scripts/watch-advise.py --full             # include recommendations + caveats
  scripts/watch-advise.py --include-smoke    # don't filter smoke-test entries
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

LOG = Path(os.environ.get("LOG_DIR", "/tmp/hermescraft")) / "mc-advise.jsonl"

C_DIM = "\033[2m"
C_OK = "\033[32m"
C_ERR = "\033[31m"
C_BOLD = "\033[1m"
C_RST = "\033[0m"


def fmt_one(d: dict, full: bool = False) -> str:
    # ts format: 2026-05-18T22:38:09.170789+00:00 → show HH:MM:SS local
    raw_ts = d.get("ts") or ""
    ts = ""
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
        ts = dt.astimezone().strftime("%H:%M:%S")
    except Exception:
        ts = raw_ts[11:19] if len(raw_ts) >= 19 else raw_ts
    kind = d.get("kind") or "?"
    digest = d.get("digest_ms") or 0
    dry = d.get("dry_run", False)
    ok = d.get("ok", dry)
    reason = d.get("reason") or ""
    tag = f"{C_OK}✓{C_RST}" if ok else f"{C_ERR}✗{C_RST}"
    cost = ""
    usage = d.get("usage") or {}
    if usage.get("cost") is not None:
        cost = f" ${usage['cost']:.4f}"
    head = (
        f"{tag} {C_DIM}{ts}{C_RST} "
        f"{C_BOLD}{kind:6s}{C_RST} "
        f"{digest:6.0f}ms{cost}  "
        f"{C_BOLD}reason{C_RST}={reason!r}"
    )
    if not full:
        summary = (d.get("summary") or "").strip().replace("\n", " ")
        if summary:
            head += f"\n  {summary[:240]}"
        return head
    parts = [head]
    if d.get("summary"):
        parts.append(f"  {C_BOLD}summary{C_RST}: {d['summary']}")
    for r in d.get("recommendations") or []:
        if isinstance(r, dict):
            parts.append(
                f"  {C_BOLD}→{C_RST} {r.get('kind')} "
                f"{r.get('block_or_entity') or ''} "
                f"@{r.get('position') or ''} "
                f"({r.get('confidence')}) — {r.get('rationale','')}"
            )
        else:
            parts.append(f"  {C_BOLD}→{C_RST} {r!s}")
    for c in d.get("caveats") or []:
        parts.append(f"  {C_DIM}caveat:{C_RST} {c!s}")
    if d.get("nothing_actionable"):
        parts.append(f"  {C_DIM}(nothing_actionable){C_RST}")
    return "\n".join(parts)


def matches(d: dict, kind: str | None, include_smoke: bool) -> bool:
    if not include_smoke and d.get("reason") == "smoke test":
        return False
    if kind and d.get("kind") != kind:
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--last", type=int, default=0, help="Print last N entries and exit (no follow)")
    ap.add_argument("--kind", default=None, help="Filter by kind (scene/status/map/find/nearby/advise)")
    ap.add_argument("--full", action="store_true", help="Show recommendations + caveats")
    ap.add_argument("--include-smoke", action="store_true", help="Include smoke-test entries")
    args = ap.parse_args()

    if not LOG.exists():
        print(f"no log yet at {LOG}", file=sys.stderr)
        return 1

    if args.last:
        with LOG.open("r", encoding="utf-8") as f:
            all_lines = [l for l in f if l.strip()]
        matched: list[dict] = []
        for line in reversed(all_lines):
            try:
                d = json.loads(line)
            except Exception:
                continue
            if not matches(d, args.kind, args.include_smoke):
                continue
            matched.append(d)
            if len(matched) >= args.last:
                break
        for d in reversed(matched):
            print(fmt_one(d, args.full))
            print()
        return 0

    # follow mode
    with subprocess.Popen(["tail", "-n", "0", "-F", str(LOG)], stdout=subprocess.PIPE, text=True) as p:
        assert p.stdout is not None
        try:
            for line in p.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if not matches(d, args.kind, args.include_smoke):
                    continue
                print(fmt_one(d, args.full))
                print()
        except KeyboardInterrupt:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
