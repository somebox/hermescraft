#!/usr/bin/env python3
"""Live-tail expedition state: hermes thinking/tool-calls + positions + events.

Invoked by `scripts/exp.sh watch`. Combines:
  - the newest hermes session JSON (thinking, assistant content, tool calls + results)
  - positions.jsonl (every 30s pos sample, with delta-distance)
  - events.jsonl (death, low_hp, nav_error, midcheck)

All three streams merged by file polling. ANSI colors:
  cyan   — assistant content      gray   — reasoning (thinking)
  green  — tool call              red    — tool error
  dim    — positions (low signal) yellow — events
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

RUNS_CURRENT = Path("/tmp/hermescraft/runs/current")
HERMES_HOME = Path(os.environ.get("STEVE_HOME", str(Path.home() / ".hermes-landfolk-steve")))

# ANSI
C_RESET = "\033[0m"
C_DIM = "\033[2m"
C_BOLD = "\033[1m"
C_CYAN = "\033[36m"
C_GREEN = "\033[32m"
C_YELLOW = "\033[33m"
C_RED = "\033[31m"
C_GRAY = "\033[90m"
C_WHITE = "\033[97m"


def newest_session() -> Optional[Path]:
    sess = HERMES_HOME / "sessions"
    if not sess.is_dir():
        return None
    files = sorted(sess.glob("session_*.json"), key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


def load_session(path: Path) -> list[dict[str, Any]]:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, list) else d.get("messages", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def truncate(s: str, n: int = 200) -> str:
    s = (s or "").strip()
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def render_tool_call(args_raw: str) -> str:
    try:
        d = json.loads(args_raw)
    except Exception:
        return truncate(args_raw)
    if isinstance(d, dict) and "command" in d:
        return truncate(d["command"], 220)
    return truncate(json.dumps(d, separators=(",", ":")))


def render_tool_result(content: Any) -> tuple[str, bool]:
    """Return (rendered text, is_error)."""
    if not isinstance(content, str):
        return truncate(str(content)), False
    is_err = False
    try:
        d = json.loads(content)
        out = d.get("output") if isinstance(d, dict) else None
        if isinstance(out, str):
            if out.lstrip().startswith("ERROR"):
                is_err = True
            return truncate(out, 220), is_err
        if "error" in (d or {}):
            return truncate(json.dumps(d.get("error")), 220), True
    except Exception:
        pass
    return truncate(content, 220), False


def short_ts(ts: str) -> str:
    """Return HH:MM:SS from an ISO timestamp."""
    if not ts:
        return "?"
    if "T" in ts and len(ts) >= 19:
        return ts[11:19]
    return ts[-8:]


def follow():
    current = RUNS_CURRENT
    if not current.exists():
        print(f"{C_RED}no active run (symlink {current} missing). start one with `scripts/exp.sh start <slug>`.{C_RESET}",
              file=sys.stderr)
        sys.exit(1)
    run_dir = current.resolve()

    pos_path = run_dir / "positions.jsonl"
    evt_path = run_dir / "events.jsonl"

    # Discover session.
    sess_path = newest_session()
    sess_mtime = 0
    sess_consumed = 0   # number of messages already printed
    sess_msgs: list[dict[str, Any]] = []

    # File-pointer state for positions / events.
    pos_pos = pos_path.stat().st_size if pos_path.exists() else 0
    evt_pos = evt_path.stat().st_size if evt_path.exists() else 0

    print(f"{C_BOLD}── live tail: {run_dir.name} ──{C_RESET}")
    print(f"  session: {sess_path.name if sess_path else '(none yet)'}")
    print(f"  positions: {pos_path}")
    print(f"  events:    {evt_path}")
    print(f"  Ctrl-C to exit\n")

    prev_pos = None

    try:
        while True:
            # Discover newer session if one rotated.
            ns = newest_session()
            if ns and (sess_path is None or ns != sess_path):
                sess_path = ns
                sess_consumed = 0
                sess_mtime = 0

            # Refresh session if mtime grew (cheap check, parse only on change).
            if sess_path and sess_path.exists():
                m = sess_path.stat().st_mtime
                if m != sess_mtime:
                    sess_mtime = m
                    sess_msgs = load_session(sess_path)
                    # Print new messages since last consumed.
                    # Helper: prefix every line with the message ts so the
                    # think/asst/tool stream lines up with positions/events.
                    # Before this every reasoning line was prefixed with
                    # plain spaces — postmortems couldn't tell WHEN the
                    # agent thought "go to W1" vs WHEN it actually moved.
                    def msg_ts(m):
                        raw = m.get("created_at") or m.get("ts") or ""
                        return short_ts(raw) if raw else "        "
                    for i in range(sess_consumed, len(sess_msgs)):
                        msg = sess_msgs[i]
                        role = msg.get("role")
                        mts = msg_ts(msg)
                        if role == "assistant":
                            reasoning = (msg.get("reasoning_content") or msg.get("reasoning") or "").strip()
                            content = (msg.get("content") or "").strip()
                            if reasoning and reasoning != content:
                                print(f"{C_GRAY}{mts} think: {truncate(reasoning, 300)}{C_RESET}")
                            if content:
                                print(f"{C_CYAN}{C_BOLD}{mts} asst:{C_RESET} {C_CYAN}{truncate(content, 300)}{C_RESET}")
                            for tc in msg.get("tool_calls", []) or []:
                                fn = tc.get("function", {}) if isinstance(tc, dict) else {}
                                name = fn.get("name", "?")
                                args = fn.get("arguments", "") or ""
                                rendered = render_tool_call(args)
                                print(f"{C_GREEN}{mts} {name}:{C_RESET} {rendered}")
                        elif role == "tool":
                            content = msg.get("content", "")
                            rendered, is_err = render_tool_result(content)
                            color = C_RED if is_err else C_DIM
                            tag = "ERR " if is_err else "out "
                            print(f"{color}{mts} {tag} → {rendered}{C_RESET}")
                    sess_consumed = len(sess_msgs)

            # Tail positions.jsonl
            if pos_path.exists():
                size = pos_path.stat().st_size
                if size > pos_pos:
                    with pos_path.open() as f:
                        f.seek(pos_pos)
                        for line in f:
                            line = line.strip()
                            if not line: continue
                            try: d = json.loads(line)
                            except: continue
                            if d.get("ok") is False:
                                ts = short_ts(d.get("ts", ""))
                                print(f"{C_DIM}{ts} POS  status_failed{C_RESET}")
                                continue
                            ts = short_ts(d.get("ts", ""))
                            dx = (d["x"] - prev_pos["x"]) if prev_pos else 0
                            dz = (d["z"] - prev_pos["z"]) if prev_pos else 0
                            delta = (dx * dx + dz * dz) ** 0.5 if prev_pos else 0
                            task = d.get("task_action") or "-"
                            tstat = d.get("task_status") or "-"
                            print(f"{C_DIM}{ts} POS  ({d['x']:.0f},{d['y']},{d['z']:.0f}) hp={d['hp']} food={d['food']} task={task}/{tstat} Δ={delta:.0f}b{C_RESET}")
                            prev_pos = d
                    pos_pos = size

            # Tail events.jsonl
            if evt_path.exists():
                size = evt_path.stat().st_size
                if size > evt_pos:
                    with evt_path.open() as f:
                        f.seek(evt_pos)
                        for line in f:
                            line = line.strip()
                            if not line: continue
                            try: d = json.loads(line)
                            except: continue
                            ts = short_ts(d.get("ts", ""))
                            kind = d.get("kind", "?")
                            extras = {k: v for k, v in d.items() if k not in ("ts", "kind")}
                            color = C_YELLOW
                            if kind in ("death", "low_hp", "nav_error"):
                                color = C_RED
                            print(f"{color}{ts} EVT  [{kind}] {json.dumps(extras, separators=(',', ':'))}{C_RESET}")
                    evt_pos = size

            time.sleep(0.5)
    except KeyboardInterrupt:
        print(f"\n{C_BOLD}stopped{C_RESET}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="live-tail expedition state (thinking + tool calls + positions + events)")
    ap.parse_args()
    follow()


if __name__ == "__main__":
    main()
