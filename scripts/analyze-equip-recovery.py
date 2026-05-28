#!/usr/bin/env python3
"""analyze-equip-recovery — summarize the pre-throw equip recovery counter.

Reads /tmp/hermescraft/mc-equip-recovery.jsonl (written by
bot/lib/runtime/metrics.js:logEquipRecovery), aggregates by result class
and bot/category, and prints a brief summary.

The recovery fires inside bot/lib/runtime/dig-tools.js when the bot is
about to throw "Refusing to dig X with empty hand" — before refusing,
it re-checks inventory for the right tool and tries to equip it. This
analyzer tells you how often that fallback fires, how often it actually
saves the dig (vs hits a real no-tool case), and per-bot patterns.

Three result classes:
  saved          — re-equip brought dig ticks under cap; dig proceeded silently
  still_slow     — re-equip happened but tool tier insufficient; refused anyway
  no_candidate   — no tool of the needed category in inventory at all

A high `saved` count = the fallback is load-bearing (real desync recovery).
A high `no_candidate` count = workers leaving base without tools (doctrine gap).
A high `still_slow` count = workers using wrong-tier tools (e.g. wooden_pickaxe
on iron_ore) — wants a smarter craft/upgrade prompt.

Usage:
    scripts/analyze-equip-recovery.py             # summary
    scripts/analyze-equip-recovery.py --tail 20   # show last 20 raw events
    scripts/analyze-equip-recovery.py --by-block  # break down by block name
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

LOG_PATH = Path("/tmp/hermescraft/mc-equip-recovery.jsonl")


def load_records():
    if not LOG_PATH.exists():
        return []
    out = []
    for line in LOG_PATH.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--tail", type=int, default=0, help="print the last N raw records")
    ap.add_argument("--by-block", action="store_true", help="break down by block name as well")
    args = ap.parse_args()

    records = load_records()
    if not records:
        print(f"# no equip-recovery events in {LOG_PATH}")
        print("# (the recovery code logs only when an 'empty hand' refusal is about to fire;")
        print("#  if bots aren't running or aren't hitting the refusal path, the log stays empty)")
        return 0

    if args.tail:
        for r in records[-args.tail:]:
            print(json.dumps(r))
        return 0

    total = len(records)
    by_result = Counter(r.get("result", "?") for r in records)
    by_bot_result = Counter((r.get("bot", "?"), r.get("result", "?")) for r in records)
    by_category = Counter((r.get("category", "?"), r.get("result", "?")) for r in records)

    print(f"# equip recovery events: {total}")
    print(f"# log file: {LOG_PATH}")
    print()
    print("# ── by result ──")
    for res in ("saved", "still_slow", "no_candidate"):
        n = by_result.get(res, 0)
        pct = (100 * n / total) if total else 0
        marker = (
            "  ← fallback is doing its job (desync recovery)"   if res == "saved" else
            "  ← workers using wrong-tier tools"                 if res == "still_slow" else
            "  ← workers leaving base without tools"             if res == "no_candidate" else
            ""
        )
        print(f"  {n:5d}  {pct:4.0f}%  {res}{marker}")
    print()

    print("# ── by bot × result ──")
    bots = sorted({k[0] for k in by_bot_result.keys()})
    results = ("saved", "still_slow", "no_candidate")
    header = "  " + " " * 12 + "  ".join(f"{r:>12s}" for r in results) + "  total"
    print(header)
    for bot in bots:
        row_total = sum(by_bot_result.get((bot, r), 0) for r in results)
        cells = "  ".join(f"{by_bot_result.get((bot, r), 0):>12d}" for r in results)
        print(f"  {bot:<12s}  {cells}  {row_total:>5d}")
    print()

    print("# ── by tool category × result ──")
    cats = sorted({k[0] for k in by_category.keys()})
    print(header.replace(" " * 12, " " * 12, 1))
    for cat in cats:
        cells = "  ".join(f"{by_category.get((cat, r), 0):>12d}" for r in results)
        row_total = sum(by_category.get((cat, r), 0) for r in results)
        print(f"  {cat:<12s}  {cells}  {row_total:>5d}")

    if args.by_block:
        print()
        print("# ── by block × result (top 12) ──")
        by_block = Counter((r.get("block", "?"), r.get("result", "?")) for r in records)
        block_totals = Counter()
        for (block, _res), n in by_block.items():
            block_totals[block] += n
        for block, total_n in block_totals.most_common(12):
            row = {r: by_block.get((block, r), 0) for r in results}
            print(f"  {block:<24s}  saved={row['saved']:>4d}  still_slow={row['still_slow']:>4d}  no_candidate={row['no_candidate']:>4d}  total={total_n}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
