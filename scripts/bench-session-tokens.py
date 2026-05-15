#!/usr/bin/env python3
"""bench-session-tokens.py — break down a Hermes session by where the
tokens go.

Usage:
    scripts/bench-session-tokens.py [SESSION_FILE]
    scripts/bench-session-tokens.py           # uses the newest session

Reads a Hermes session JSON (from ~/.hermes/sessions/) and prints byte
+ approximate-token sizes for the system prompt, tools schema, and
each message role. Approximate tokens = bytes // 4 (English/JSON heuristic).

Useful for verifying that context-trim changes (lean endpoints,
toolset restrictions, --ignore-rules) actually reduce request size.
"""
import json
import os
import sys
from pathlib import Path
from collections import Counter

HERMES_SESSIONS = Path.home() / ".hermes" / "sessions"


def newest_session() -> Path:
    files = sorted(HERMES_SESSIONS.glob("session_*.json"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        raise SystemExit(f"No sessions found in {HERMES_SESSIONS}")
    return files[0]


def main():
    if len(sys.argv) > 1:
        path = Path(sys.argv[1]).expanduser()
    else:
        path = newest_session()
    if not path.exists():
        raise SystemExit(f"Not found: {path}")

    print(f"Session: {path.name}")
    with open(path) as f:
        d = json.load(f)

    sp = d.get("system_prompt", "") or ""
    tools = d.get("tools", []) or []
    msgs = d.get("messages", []) or []
    model = d.get("model", "?")

    print(f"Model:   {model}")
    print()

    sp_bytes = len(sp)
    tools_bytes = len(json.dumps(tools))

    role_bytes = Counter()
    role_counts = Counter()
    for m in msgs:
        r = m.get("role", "unknown")
        c = m.get("content", "")
        if isinstance(c, list):
            c = json.dumps(c)
        role_bytes[r] += len(str(c))
        role_counts[r] += 1

    msg_bytes = sum(role_bytes.values())
    total = sp_bytes + tools_bytes + msg_bytes

    def row(label, b):
        pct = (b / total * 100) if total else 0
        print(f"  {label:<25}  {b:>7} B  (~{b // 4:>5} tok)  {pct:5.1f}%")

    print(f"Sizes (n_messages={len(msgs)}, n_tools={len(tools)}):")
    row("system_prompt", sp_bytes)
    row("tools (schema)", tools_bytes)
    row("messages (all)", msg_bytes)
    print(f"  {'-' * 70}")
    row("TOTAL", total)
    print()

    if role_bytes:
        print("Messages by role:")
        for r, b in sorted(role_bytes.items(), key=lambda x: -x[1]):
            print(f"  {r:<25}  count={role_counts[r]:>3}  {b:>7} B  (~{b // 4:>5} tok)")
        print()

    if tools:
        print("Tools by schema size:")
        rows = []
        for t in tools:
            n = t.get("name") or t.get("function", {}).get("name", "?")
            rows.append((n, len(json.dumps(t))))
        rows.sort(key=lambda x: -x[1])
        for n, b in rows[:15]:
            print(f"  {n:<25}  {b:>5} B  (~{b // 4:>5} tok)")
        if len(rows) > 15:
            rest = sum(b for _, b in rows[15:])
            print(f"  {'...':<25}  {rest:>5} B  (~{rest // 4:>5} tok)  ({len(rows) - 15} more)")
        print()

    # Top heavy tool responses — most actionable diagnostic for bloat,
    # since per-turn token cost is dominated by repeated large tool outputs.
    tool_msgs = []
    for i, m in enumerate(msgs):
        if m.get("role") != "tool":
            continue
        c = m.get("content", "")
        if isinstance(c, list):
            c = json.dumps(c)
        tool_msgs.append((i, len(str(c)), str(c)))
    if tool_msgs:
        tool_msgs.sort(key=lambda x: -x[1])
        print(f"Top {min(10, len(tool_msgs))} largest tool responses:")
        for i, b, c in tool_msgs[:10]:
            head = c[:140].replace("\n", " ")
            print(f"  msg #{i:>3}  {b:>5} B  (~{b // 4:>4} tok)  {head}…")
        print()

    # Per-turn growth: shows whether the conversation accumulates linearly.
    # Each "turn" here = one assistant call. Sum of bytes-up-to-and-
    # including each assistant message ≈ what gets re-sent on the NEXT call.
    print("Per-turn cumulative bytes (what each request roughly sends):")
    fixed = sp_bytes + tools_bytes
    cum = 0
    turn = 0
    for m in msgs:
        r = m.get("role", "?")
        c = m.get("content", "")
        if isinstance(c, list):
            c = json.dumps(c)
        cum += len(str(c))
        if r == "assistant":
            turn += 1
            total_this = fixed + cum
            if turn <= 3 or turn % 5 == 0 or turn == len(msgs):
                print(f"  turn {turn:>3}: ~{total_this // 4:>5} tok  (msgs={cum} B, fixed={fixed} B)")
    print()


if __name__ == "__main__":
    main()
