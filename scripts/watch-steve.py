#!/usr/bin/env python3
"""Pretty-tail Steve's Hermes session.

The hermes TUI stdout redirect (/tmp/hermescraft/hermes-steve.log) is full
of ANSI noise and inconsistent line wrapping. The structured truth lives
in ~/.hermes-landfolk-steve/sessions/session_*.json. This watcher polls
the newest session file, prints new messages as they arrive, and auto-
switches if a new session starts (i.e. after `run-steve.sh`).

Usage:
  scripts/watch-steve.py                 # follow live, no reasoning
  scripts/watch-steve.py --reasoning     # include hidden thoughts
  scripts/watch-steve.py --no-color
  scripts/watch-steve.py --tail 30       # print last 30 msgs then follow
  scripts/watch-steve.py --tail 30 --no-follow
  scripts/watch-steve.py --home ~/.hermes-landfolk-flint --tail 20
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

DEF_HOME = Path(os.environ.get("STEVE_HOME", str(Path.home() / ".hermes-landfolk-steve")))


def newest_session(home: Path) -> Path | None:
    sess = home / "sessions"
    if not sess.is_dir():
        return None
    files = sorted(sess.glob("session_*.json"), key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


def load(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _truncate(s: str, n: int) -> str:
    s = (s or "").strip()
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def _parse_tool_args(raw: str) -> str:
    """Render tool call arguments compactly."""
    try:
        d = json.loads(raw)
    except Exception:
        return _truncate(raw, 120)
    # terminal tool: just show the command
    if "command" in d:
        cmd = d["command"]
        return _truncate(cmd, 160)
    if "path" in d:
        return d["path"]
    if "pattern" in d:
        return d["pattern"]
    return _truncate(json.dumps(d), 160)


def _parse_tool_output(content) -> str:
    """Tool result content is JSON-string-of-{output:str}; pull the output."""
    if not isinstance(content, str):
        return str(content)
    try:
        d = json.loads(content)
        out = d.get("output") if isinstance(d, dict) else None
        if isinstance(out, str):
            return out
    except Exception:
        pass
    return content


class Colors:
    def __init__(self, enabled: bool):
        if enabled and sys.stdout.isatty():
            self.dim = "\033[2m"
            self.bold = "\033[1m"
            self.rst = "\033[0m"
            self.assistant = "\033[36m"   # cyan
            self.user = "\033[33m"        # yellow
            self.tool_call = "\033[35m"   # magenta
            self.tool_out = "\033[37m"    # light grey — readable on dark themes
            self.reasoning = "\033[2;37m" # dim grey
            self.system = "\033[31m"      # red
        else:
            self.dim = self.bold = self.rst = ""
            self.assistant = self.user = self.tool_call = ""
            self.tool_out = self.reasoning = self.system = ""


def render_message(m: dict, idx: int, c: Colors, show_reasoning: bool) -> None:
    role = m.get("role")
    if role == "user":
        text = _truncate(str(m.get("content", "")), 600)
        if text:
            print(f"{c.user}{c.bold}USER ▸{c.rst} {text}")
        return
    if role == "assistant":
        if show_reasoning:
            r = (m.get("reasoning_content") or m.get("reasoning") or "").strip()
            if r:
                for line in r.splitlines():
                    print(f"  {c.reasoning}· {line.strip()}{c.rst}")
        text = (m.get("content") or "").strip()
        if text:
            for line in text.splitlines():
                print(f"{c.assistant}STEVE ▸{c.rst} {line}")
        for tc in m.get("tool_calls") or []:
            fn = (tc.get("function") or {})
            name = fn.get("name", "?")
            args = _parse_tool_args(fn.get("arguments", ""))
            print(f"  {c.tool_call}⚙  {name}{c.rst}  {c.dim}{args}{c.rst}")
        return
    if role == "tool":
        out = _parse_tool_output(m.get("content", ""))
        out_one = " ⏎ ".join(line for line in out.splitlines() if line.strip())
        out_short = _truncate(out_one, 200)
        marker = "←"
        if "[error]" in out.lower() or '"ok": false' in out.lower() or '"ok":false' in out.lower():
            marker = "✗"
        print(f"  {c.tool_out}{marker} {out_short}{c.rst}")
        return
    if role == "system":
        return  # system prompt — too long, irrelevant for live watching


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=str(DEF_HOME), help="HERMES_HOME (default: ~/.hermes-landfolk-steve)")
    ap.add_argument("--reasoning", action="store_true", help="Show hidden reasoning_content")
    ap.add_argument("--tail", type=int, default=0, help="Print last N messages then follow")
    ap.add_argument("--no-follow", action="store_true", help="Print and exit")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--poll", type=float, default=1.0, help="Poll interval seconds")
    args = ap.parse_args()

    home = Path(args.home).expanduser()
    c = Colors(not args.no_color)

    cur_path: Path | None = None
    last_count = 0

    try:
        while True:
            latest = newest_session(home)
            if latest is None:
                print(f"{c.system}no session yet in {home}/sessions/{c.rst}", file=sys.stderr)
                if args.no_follow:
                    return 1
                time.sleep(args.poll)
                continue
            if latest != cur_path:
                if cur_path is not None:
                    print(f"\n{c.system}── new session: {latest.name} ──{c.rst}\n")
                cur_path = latest
                last_count = 0
                # initial tail
                data = load(latest) or {}
                msgs = data.get("messages") or []
                if args.tail and last_count == 0:
                    start = max(0, len(msgs) - args.tail)
                    print(f"{c.dim}── tailing {latest.name} ({len(msgs)} msgs, showing last {len(msgs)-start}) ──{c.rst}")
                    for i, m in enumerate(msgs[start:], start=start):
                        render_message(m, i, c, args.reasoning)
                    last_count = len(msgs)
                else:
                    print(f"{c.dim}── following {latest.name} ({len(msgs)} msgs) ──{c.rst}")
                    last_count = len(msgs)
                if args.no_follow:
                    return 0
            else:
                data = load(latest) or {}
                msgs = data.get("messages") or []
                if len(msgs) > last_count:
                    for i, m in enumerate(msgs[last_count:], start=last_count):
                        render_message(m, i, c, args.reasoning)
                    last_count = len(msgs)
                    sys.stdout.flush()
            time.sleep(args.poll)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
