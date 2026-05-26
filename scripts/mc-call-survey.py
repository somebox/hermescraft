#!/usr/bin/env python3
"""Survey mc tool calls across landfolk bot sessions.

Reads each profile's session_*.json files modified within a configurable
recency window, parses the assistant `tool_calls`, and extracts mc verbs
(`mc <verb> ...`) plus framework tool names (kanban_show, skill_view,
memory, etc.). Prints:

  1. Top verbs across the fleet
  2. Per-bot top verbs
  3. Non-mc shell commands attempted (catches "hallucinated" tools)
  4. Key escalation primitives — flagged when usage is zero or near-zero

Use this to spot fleet-wide adoption / non-adoption of doctrine. Ran
ad-hoc 2026-05-26 and found mc advise = 1 call / 243 total over 30 min,
mc help = 0, mc marks = 0 — driving SKILL updates to push adoption.

Usage:
    scripts/mc-call-survey.py                  # default: last 30 min
    scripts/mc-call-survey.py --minutes 120    # last 2 hours
    scripts/mc-call-survey.py --profiles flint # one bot only
    scripts/mc-call-survey.py --json           # machine-readable output
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

PROFILES_DIR = Path.home() / ".hermes" / "profiles"
DEFAULT_PROFILES = ["flint", "mason", "gatherer", "steward", "barley"]

# Framework tools that aren't mc verbs but matter for usage tracking.
FRAMEWORK_TOOLS = {
    "kanban_show", "kanban_complete", "kanban_block", "kanban_comment",
    "kanban_create", "kanban_list", "skill_view", "memory",
    "delegate_task", "execute_code",
}

# Primitives we explicitly check for under-use. Keep in sync with SKILL
# guidance — adding new doctrine? Add the verb here so the survey flags
# adoption (or lack thereof).
KEY_PRIMITIVES = [
    "advise", "scene", "observe", "find", "find_blocks",
    "help",
    "task", "task_context",
    "set_mark", "go_mark", "marks",
    "rescue_request", "escape", "pillar_down",
    "inspect", "terrain_top",
    "collect",  # preferred over manual dig+pickup loops
]

MC_VERB_RE = re.compile(r"mc\s+(\w+)")


def parse_sessions(profiles: list[str], cutoff_s: float):
    """Walk profile session dirs and return (counts, per-bot counts, non-mc)."""
    verb_counter: Counter[str] = Counter()
    per_bot: dict[str, Counter[str]] = defaultdict(Counter)
    non_mc: Counter[str] = Counter()
    scanned = 0
    skipped = 0

    for profile in profiles:
        sess_dir = PROFILES_DIR / profile / "sessions"
        if not sess_dir.is_dir():
            continue
        for sess_file in sess_dir.glob("session_*.json"):
            if sess_file.stat().st_mtime < cutoff_s:
                skipped += 1
                continue
            scanned += 1
            try:
                data = json.loads(sess_file.read_text())
            except Exception:
                continue
            for msg in data.get("messages", []):
                if msg.get("role") != "assistant":
                    continue
                for tc in (msg.get("tool_calls") or []):
                    fn_name = (tc.get("function") or {}).get("name", "?")
                    args_str = (tc.get("function") or {}).get("arguments", "")
                    try:
                        args = json.loads(args_str) if args_str else {}
                    except Exception:
                        args = {}
                    cmd_text = args.get("command") or args.get("code") or ""
                    if not cmd_text:
                        # Direct framework tool (kanban_*, memory, skill_view, etc.)
                        if fn_name in FRAMEWORK_TOOLS:
                            label = f"<{fn_name}>"
                            verb_counter[label] += 1
                            per_bot[profile][label] += 1
                        continue
                    m = MC_VERB_RE.search(cmd_text)
                    if m:
                        verb = m.group(1)
                        verb_counter[verb] += 1
                        per_bot[profile][verb] += 1
                    else:
                        first = cmd_text.split()[0] if cmd_text.split() else "(empty)"
                        non_mc[first[:40]] += 1
    return verb_counter, per_bot, non_mc, scanned, skipped


def render_table(rows: list[tuple[str, int]], total: int) -> list[str]:
    out = []
    for label, count in rows:
        pct = (100.0 * count / total) if total else 0
        out.append(f"  {count:5d}  {pct:5.1f}%  {label}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--minutes", type=int, default=30,
                    help="Window in minutes (default: 30)")
    ap.add_argument("--profiles", default=",".join(DEFAULT_PROFILES),
                    help="Comma-separated profile names to include")
    ap.add_argument("--top", type=int, default=25,
                    help="How many top verbs to show fleet-wide (default: 25)")
    ap.add_argument("--per-bot-top", type=int, default=10,
                    help="How many top verbs per bot (default: 10)")
    ap.add_argument("--json", action="store_true",
                    help="Emit machine-readable JSON")
    args = ap.parse_args()

    profiles = [p.strip().lower() for p in args.profiles.split(",") if p.strip()]
    cutoff_s = time.time() - args.minutes * 60

    verb_counter, per_bot, non_mc, scanned, skipped = parse_sessions(profiles, cutoff_s)
    total_calls = sum(verb_counter.values())

    if args.json:
        out = {
            "window_minutes": args.minutes,
            "sessions_scanned": scanned,
            "sessions_skipped_older": skipped,
            "total_calls": total_calls,
            "by_verb": dict(verb_counter),
            "by_bot": {b: dict(c) for b, c in per_bot.items()},
            "non_mc_attempts": dict(non_mc),
            "key_primitives": {p: verb_counter.get(p, 0) for p in KEY_PRIMITIVES},
        }
        print(json.dumps(out, indent=2))
        return 0

    print(f"=== mc tool-call survey — last {args.minutes} min ===")
    print(f"sessions scanned: {scanned}  (skipped {skipped} older than window)")
    print(f"total recognized calls: {total_calls}")
    print()
    if not total_calls:
        print("(no calls in window)")
        return 0

    print(f"=== Fleet-wide top {args.top} ===")
    for line in render_table(verb_counter.most_common(args.top), total_calls):
        print(line)
    print()

    print(f"=== Per-bot top {args.per_bot_top} ===")
    for bot in profiles:
        if not per_bot[bot]:
            print(f"--- {bot}: (no calls in window) ---")
            continue
        bot_total = sum(per_bot[bot].values())
        print(f"--- {bot} ({bot_total} calls) ---")
        for line in render_table(per_bot[bot].most_common(args.per_bot_top), bot_total):
            print(line)
        print()

    if non_mc:
        print("=== Non-mc shell commands attempted (possible hallucinations) ===")
        for cmd, count in non_mc.most_common(15):
            print(f"  {count:5d}  {cmd}")
        print()

    print("=== Key escalation / observation primitives (❗ = zero use) ===")
    for p in KEY_PRIMITIVES:
        count = verb_counter.get(p, 0)
        marker = "❗" if count == 0 else " "
        print(f"  {marker} {count:5d}  mc {p}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
