#!/usr/bin/env python3
"""Pretty-tail a Landfolk Hermes agent session (session JSON).

Structured agent history lives in ~/.hermes-landfolk-<agent>/sessions/session_*.json.
This watcher polls the newest session, prints new messages, and switches when a
new session starts (e.g. after restart).

Usage:
  scripts/watch-agent.py --agent flint              # Landfolk continuous agent (~/.hermes-landfolk-flint)
  scripts/watch-agent.py --profile flint            # kanban worker (~/.hermes/profiles/flint)
  scripts/watch-agent.py --agent flint --auto       # newest session across landfolk + kanban profile
  scripts/watch-agent.py --agent steve --tail 30
  scripts/watch-agent.py --home ~/.hermes-landfolk-mason --label Mason
  scripts/watch-agent.py --tail 20 --no-follow      # default agent: steve
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

DEFAULT_AGENT = os.environ.get("WATCH_AGENT", "steve").lower()


def agent_home(name: str) -> Path:
    return Path.home() / f".hermes-landfolk-{name.lower()}"


def kanban_profile_home(name: str) -> Path:
    return Path.home() / ".hermes" / "profiles" / name.lower()


def resolve_home(
    agent: str | None,
    home: str | None,
    profile: str | None,
) -> Path:
    if home:
        return Path(home).expanduser()
    if profile:
        return kanban_profile_home(profile)
    name = (agent or DEFAULT_AGENT).lower()
    return Path(os.environ.get("HERMES_HOME", str(agent_home(name)))).expanduser()


def pick_newest_session_home(candidates: list[Path]) -> Path | None:
    best_home: Path | None = None
    best_mtime = -1.0
    for home in candidates:
        sess = newest_session(home)
        if sess is None:
            continue
        mt = sess.stat().st_mtime
        if mt > best_mtime:
            best_mtime = mt
            best_home = home
    return best_home


def resolve_label(
    agent: str | None,
    profile: str | None,
    label: str | None,
    home: Path,
) -> str:
    if label:
        return label
    if profile:
        p = profile.strip()
        base = p[0].upper() + p[1:] if p else "Agent"
        return f"{base} (kanban)"
    if agent:
        a = agent.strip()
        return a[0].upper() + a[1:] if a else "Agent"
    stem = home.name
    if stem.startswith(".hermes-landfolk-"):
        part = stem[len(".hermes-landfolk-") :]
        return part.title() if part else "Agent"
    if home.parent.name == "profiles":
        return f"{stem.title()} (kanban)"
    return "Agent"


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
    try:
        d = json.loads(raw)
    except Exception:
        return _truncate(raw, 120)
    if "command" in d:
        return _truncate(d["command"], 160)
    if "path" in d:
        return d["path"]
    if "pattern" in d:
        return d["pattern"]
    return _truncate(json.dumps(d), 160)


def _parse_tool_output(content) -> str:
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
            self.assistant = "\033[36m"
            self.user = "\033[33m"
            self.tool_call = "\033[35m"
            self.tool_out = "\033[37m"
            self.reasoning = "\033[2;37m"
            self.system = "\033[31m"
        else:
            self.dim = self.bold = self.rst = ""
            self.assistant = self.user = self.tool_call = ""
            self.tool_out = self.reasoning = self.system = ""


def render_message(m: dict, idx: int, c: Colors, show_reasoning: bool, label: str) -> None:
    role = m.get("role")
    tag = f"{label.upper()} ▸"
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
                print(f"{c.assistant}{tag}{c.rst} {line}")
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function") or {}
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
        return


def main() -> int:
    ap = argparse.ArgumentParser(description="Tail Hermes session JSON for a Landfolk agent.")
    ap.add_argument(
        "-a",
        "--agent",
        metavar="NAME",
        help="Landfolk agent id → ~/.hermes-landfolk-NAME (continuous goals loop)",
    )
    ap.add_argument(
        "-p",
        "--profile",
        metavar="NAME",
        help="Kanban Hermes profile → ~/.hermes/profiles/NAME (dispatcher one-shot workers)",
    )
    ap.add_argument(
        "--auto",
        action="store_true",
        help="With --agent NAME: follow whichever of landfolk vs kanban profile has the newest session",
    )
    ap.add_argument("--home", help="HERMES_HOME override (wins over --agent / --profile)")
    ap.add_argument("--label", help="Banner label (default: derived from --agent or home dir)")
    ap.add_argument("--reasoning", action="store_true", help="Show hidden reasoning_content")
    ap.add_argument("--tail", type=int, default=0, help="Print last N messages then follow")
    ap.add_argument("--no-follow", action="store_true", help="Print and exit")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--poll", type=float, default=1.0, help="Poll interval seconds")
    args = ap.parse_args()

    if args.profile and args.auto:
        print("error: --auto cannot be used with --profile", file=sys.stderr)
        return 2

    agent_name = (args.agent or DEFAULT_AGENT).lower() if not args.profile else None
    if args.auto and agent_name:
        picked = pick_newest_session_home(
            [agent_home(agent_name), kanban_profile_home(agent_name)]
        )
        if picked is None:
            print(
                f"error: no sessions under landfolk or kanban profile for {agent_name!r}",
                file=sys.stderr,
            )
            return 1
        home = picked
        label = resolve_label(None, None, args.label, home)
    else:
        home = resolve_home(args.agent, args.home, args.profile)
        label = resolve_label(args.agent, args.profile, args.label, home)
    c = Colors(not args.no_color)

    cur_path: Path | None = None
    last_count = 0
    last_home: Path | None = None

    try:
        while True:
            if args.auto and agent_name:
                picked = pick_newest_session_home(
                    [agent_home(agent_name), kanban_profile_home(agent_name)]
                )
                if picked is not None:
                    home = picked
                    if home != last_home:
                        label = resolve_label(None, None, args.label, home)
                        if last_home is not None:
                            print(
                                f"\n{c.system}── switched home → {home} ({label}) ──{c.rst}\n"
                            )
                        last_home = home
                        cur_path = None
                        last_count = 0

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
                data = load(latest) or {}
                msgs = data.get("messages") or []
                if args.tail and last_count == 0:
                    start = max(0, len(msgs) - args.tail)
                    print(
                        f"{c.dim}── {label} | {latest.name} "
                        f"({len(msgs)} msgs, showing last {len(msgs) - start}) ──{c.rst}"
                    )
                    for i, m in enumerate(msgs[start:], start=start):
                        render_message(m, i, c, args.reasoning, label)
                    last_count = len(msgs)
                else:
                    print(f"{c.dim}── following {label} | {latest.name} ({len(msgs)} msgs) ──{c.rst}")
                    last_count = len(msgs)
                if args.no_follow:
                    return 0
            else:
                data = load(latest) or {}
                msgs = data.get("messages") or []
                if len(msgs) > last_count:
                    for i, m in enumerate(msgs[last_count:], start=last_count):
                        render_message(m, i, c, args.reasoning, label)
                    last_count = len(msgs)
                    sys.stdout.flush()
            time.sleep(args.poll)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
