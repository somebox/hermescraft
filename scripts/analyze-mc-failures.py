#!/usr/bin/env python3
"""analyze-mc-failures — surface top `mc <verb> <material>` failure patterns
from the cognition JSONL log.

Originally written to answer "which materials does the agent get wrong?"
The data showed material naming is mostly NOT the failure mode — agents
pick correct Minecraft names at ~98% rate. The dominant failures are
spatial / geometric / state errors that share a `mc place cobblestone`
signature regardless of material correctness.

Usage:
    scripts/analyze-mc-failures.py [--top N] [--samples K]

    Default: --top 20 --samples 2  (top 20 failing commands, 2 error
    snippets per command for diagnostic context).

Reads:  /tmp/hermescraft/cognition/*.jsonl  (per-profile agent logs)
Writes: stdout (analysis report)

The script is read-only and safe to run anytime. It re-aggregates from
scratch on each invocation — no incremental state.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

COGNITION_DIR = Path("/tmp/hermescraft/cognition")

# mc verbs that take a material/item as their first positional. Excludes
# mc move/goto (coords), mc chat (text), mc mark (name), mc help, etc.
MC_VERB_RE = re.compile(
    r"\bmc\s+(place|collect|craft|equip|withdraw|deposit|smelt|fill|dig|inspect)"
    r"\s+([a-z_][a-z0-9_]*)"
)

# Patterns that indicate the tool_result is a failure of some kind.
FAIL_HINT_RE = re.compile(
    r'"exit_code":\s*[1-9]'           # non-zero shell exit
    r'|\bERROR\b'                      # mc's own ERROR prefix
    r'|"ok":\s*false'                  # explicit ok:false envelope
    r"|refusing to dig"                # no-tool refusal
    r"|cannot place"                   # placement geometry
    r"|no solid neighbor"              # placement geometry
    r"|view blocked"                   # line-of-sight
    r"|pathfind failed"                # navigation
    r"|no such (item|block)"           # name-recognition
    r"|unknown (item|block)"           # name-recognition
)

# Classify the error category from the result text — first match wins.
CATEGORY_PATTERNS = [
    ("no_solid_neighbor",   re.compile(r"no solid neighbor",        re.I)),
    ("view_blocked",        re.compile(r"view (is )?blocked|sight",  re.I)),
    ("already_block",       re.compile(r"block is already|already\s+\w+\b", re.I)),
    ("entity_in_way",       re.compile(r"item .* is standing|TARGET_ENTI",  re.I)),
    ("pathfind_failed",     re.compile(r"pathfind failed|no path to|OUT_OF_RANGE", re.I)),
    ("prev_move_failed",    re.compile(r"previous mc move .* failed",  re.I)),
    ("refusing_to_dig",     re.compile(r"refusing to dig",            re.I)),
    ("digging_aborted",     re.compile(r"digging aborted|error mining", re.I)),
    ("server_rejected",     re.compile(r"rejected by server|INTERRUPTED", re.I)),
    ("region_protected",    re.compile(r"region_protected|REGION_PROT", re.I)),
    ("unknown_name",        re.compile(r"unknown (item|block)|no such (item|block)", re.I)),
    ("invalid_arg",         re.compile(r"invalid|INVALID_",           re.I)),
    ("nav_blocked",         re.compile(r"NAV_BLOCKED|stuck",          re.I)),
]


def classify_error(text: str) -> str:
    for cat, pat in CATEGORY_PATTERNS:
        if pat.search(text):
            return cat
    return "other"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--top", type=int, default=20, help="top N failing (verb, material) combos")
    ap.add_argument("--samples", type=int, default=2, help="error snippets per combo")
    ap.add_argument("--min-calls", type=int, default=5, help="min total invocations to surface")
    ap.add_argument("--min-fail-ratio", type=float, default=0.30, help="min failure ratio to surface")
    args = ap.parse_args()

    if not COGNITION_DIR.exists():
        print(f"# no cognition logs at {COGNITION_DIR}", file=sys.stderr)
        return 1

    per_combo_total: Counter[tuple[str, str]] = Counter()
    per_combo_fail: Counter[tuple[str, str]] = Counter()
    per_combo_categories: dict[tuple[str, str], Counter[str]] = {}
    per_combo_samples: dict[tuple[str, str], list[str]] = {}
    overall_categories: Counter[str] = Counter()

    for jsonl in sorted(COGNITION_DIR.glob("*.jsonl")):
        if jsonl.name == "bot-events.jsonl":
            continue
        lines = jsonl.read_text().splitlines()
        for i, line in enumerate(lines):
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("kind") != "tool_call":
                continue
            text = d.get("text") or ""
            m = MC_VERB_RE.search(text)
            if not m:
                continue
            verb, mat = m.group(1), m.group(2)
            combo = (verb, mat)
            per_combo_total[combo] += 1

            # Look at the next few records for a tool_result in the same session.
            session = d.get("session")
            for j in range(i + 1, min(i + 6, len(lines))):
                try:
                    r = json.loads(lines[j])
                except Exception:
                    continue
                if r.get("kind") != "tool_result":
                    continue
                if r.get("session") and session and r["session"] != session:
                    break
                rtext = r.get("text") or ""
                if FAIL_HINT_RE.search(rtext):
                    per_combo_fail[combo] += 1
                    cat = classify_error(rtext)
                    overall_categories[cat] += 1
                    per_combo_categories.setdefault(combo, Counter())[cat] += 1
                    if len(per_combo_samples.get(combo, [])) < args.samples:
                        snippet = rtext[:220].replace("\n", " | ")
                        per_combo_samples.setdefault(combo, []).append(snippet)
                break

    total_invocations = sum(per_combo_total.values())
    total_failures = sum(per_combo_fail.values())

    print(f"# mc <verb> <material> failure analysis")
    print(f"# scanned: {len(list(COGNITION_DIR.glob('*.jsonl')))} cognition jsonl files")
    print(f"# total recognised (verb, material) tool_calls: {total_invocations}")
    print(f"# total with failure-hint in result:            {total_failures}  "
          f"({100 * total_failures / max(1, total_invocations):.0f}%)")
    print()

    print("# ── failure categories (across all commands) ──")
    for cat, n in overall_categories.most_common():
        print(f"  {n:6d}  {cat}")
    print()

    print(f"# ── top {args.top} failing (verb, material) combos "
          f"(min {args.min_calls} calls, fail≥{int(args.min_fail_ratio*100)}%) ──")
    candidates = []
    for combo, fails in per_combo_fail.items():
        total = per_combo_total[combo]
        if total >= args.min_calls and fails / total >= args.min_fail_ratio:
            candidates.append((fails / total, fails, total, combo))
    candidates.sort(reverse=True)
    for ratio, fails, total, (verb, mat) in candidates[: args.top]:
        cats = per_combo_categories.get((verb, mat), Counter())
        top_cats = ", ".join(f"{c}={n}" for c, n in cats.most_common(3))
        print(f"  {int(ratio*100):3d}%  fail {fails:4d}/{total:<4d}   mc {verb} {mat}")
        print(f"        categories: {top_cats}")
        for snip in per_combo_samples.get((verb, mat), [])[: args.samples]:
            print(f"        ↳ {snip}")
        print()

    if not candidates:
        print("  (no combos exceed the thresholds)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
