#!/usr/bin/env python3
"""Look for naming-mistake error signatures in tool_result records."""
from __future__ import annotations
import json, re
from collections import Counter
from pathlib import Path

DIR = Path("/tmp/hermescraft/cognition")

# Errors that suggest agent typed a non-canonical block/item name.
NAMING_FAIL_PATTERNS = [
    ("unknown_block_or_item",  re.compile(r"UNKNOWN_BLOCK|UNKNOWN_ITEM|no such (block|item)|unknown (block|item)", re.I)),
    ("not_in_inventory_check",  re.compile(r"NOT_IN_INVENTORY", re.I)),
    ("invalid_args_name",       re.compile(r"INVALID_ARGS.*item|INVALID_ARGS.*block", re.I)),
]

counts: Counter[str] = Counter()
samples: dict[str, list[str]] = {k: [] for k, _ in NAMING_FAIL_PATTERNS}

for fp in sorted(DIR.glob("*.jsonl")):
    if fp.name == "bot-events.jsonl":
        continue
    for line in fp.read_text(errors="ignore").splitlines():
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("kind") != "tool_result":
            continue
        text = d.get("text") or ""
        for label, pat in NAMING_FAIL_PATTERNS:
            if pat.search(text):
                counts[label] += 1
                if len(samples[label]) < 5:
                    samples[label].append(text[:300].replace("\n", " | "))

print("# B3 — naming-related error signatures in tool_result records")
print(f"# scanned 5 days of cognition logs")
print()
for label, n in counts.most_common():
    print(f"  {n:5d}  {label}")
print()
for label, lst in samples.items():
    if not lst:
        continue
    print(f"## {label} — samples ({len(lst)} of {counts[label]}):")
    for s in lst:
        print(f"  {s[:240]}")
    print()
