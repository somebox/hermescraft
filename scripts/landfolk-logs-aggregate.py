#!/usr/bin/env python3
"""Aggregate live kanban-worker sessions across landfolk profiles, with
grc-style per-player coloring and shaded message types.

Each profile in ~/.hermes/profiles/<name>/sessions/ rotates session_*.json
files as new kanban-worker dispatches start. This watcher polls every
profile, picks the newest session per profile, tracks a per-file message
cursor, and prints anything new prefixed with a colored player banner.

Within a player's stream, shades distinguish:
  - thoughts  (assistant text)        → bright primary color
  - commands  (assistant tool_calls)  → bold primary color
  - info      (tool results)          → dim primary color
  - user      (cards / handoff)       → light grey, no player color

Usage:
  scripts/landfolk-logs-aggregate.py                       # flint+mason+steward
  scripts/landfolk-logs-aggregate.py --profiles flint,steward
  scripts/landfolk-logs-aggregate.py --tail 20             # backfill last 20 each
  scripts/landfolk-logs-aggregate.py --no-color --no-follow
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

PROFILES_DIR = Path.home() / ".hermes" / "profiles"
BOT_LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp/hermescraft"))


def candidate_homes(profile: str) -> list[Path]:
    """Both possible session homes for a profile, matching dashboard logic.

    The dashboard picks whichever is freshest because some agents are run as
    a continuous landfolk loop (~/.hermes-landfolk-<name>) while others are
    pure kanban workers (~/.hermes/profiles/<name>). A given profile can
    have either or both at different times — only the freshest is the
    "real" cognitive stream right now.
    """
    return [
        Path.home() / f".hermes-landfolk-{profile.lower()}",
        PROFILES_DIR / profile.lower(),
    ]

# Bot-log lines we want to surface (chat, connection state, kicks).
# Everything else (prismarine viewer noise, raw movement chatter) is dropped.
BOT_LOG_FILTER = re.compile(
    r"\[Chat\]|\[Whisper\]|\[Queued|Kicked:|Disconnected:|Reconnect|Connected!|Spawned at"
)

# Per-player palette: (primary_fg, bold_fg, dim_fg)
#   primary_fg → thoughts (assistant text)
#   bold_fg    → commands (tool_calls)
#   dim_fg     → info (tool output)
PALETTE = {
    "flint":    ("\033[38;5;75m",  "\033[1;38;5;75m",  "\033[2;38;5;75m"),   # steel blue
    "mason":    ("\033[38;5;114m", "\033[1;38;5;114m", "\033[2;38;5;114m"),  # green
    "steward":  ("\033[38;5;221m", "\033[1;38;5;221m", "\033[2;38;5;221m"),  # gold
    "gatherer": ("\033[38;5;177m", "\033[1;38;5;177m", "\033[2;38;5;177m"),  # violet
    "barley":   ("\033[38;5;215m", "\033[1;38;5;215m", "\033[2;38;5;215m"),  # peach
    "reed":     ("\033[38;5;152m", "\033[1;38;5;152m", "\033[2;38;5;152m"),  # teal
}
FALLBACK = ("\033[38;5;250m", "\033[1;38;5;250m", "\033[2;38;5;250m")
RST = "\033[0m"
USER_C = "\033[38;5;245m"   # neutral grey
META_C = "\033[2;38;5;244m"


def palette_for(profile: str):
    return PALETTE.get(profile.lower(), FALLBACK)


def newest_session(profile: str) -> Path | None:
    """Newest session_*.json across BOTH candidate homes for this profile."""
    best: Path | None = None
    best_mtime = -1.0
    for home in candidate_homes(profile):
        sess_dir = home / "sessions"
        if not sess_dir.is_dir():
            continue
        for f in sess_dir.glob("session_*.json"):
            try:
                mt = f.stat().st_mtime
            except OSError:
                continue
            if mt > best_mtime:
                best_mtime = mt
                best = f
    return best


def load_messages(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return data.get("messages") or []


def truncate(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def fmt_tool_args(raw: str) -> str:
    try:
        d = json.loads(raw)
    except Exception:
        return truncate(raw, 160)
    if isinstance(d, dict):
        if "command" in d:
            return truncate(str(d["command"]), 200)
        if "path" in d:
            return str(d["path"])
        if "pattern" in d:
            return str(d["pattern"])
        return truncate(json.dumps(d), 200)
    return truncate(str(d), 200)


def fmt_tool_output(content) -> str:
    if not isinstance(content, str):
        return str(content)
    try:
        d = json.loads(content)
        if isinstance(d, dict):
            out = d.get("output")
            if isinstance(out, str):
                return out
    except Exception:
        pass
    return content


def is_tool_error(out: str) -> bool:
    low = (out or "").lower()
    return "[error]" in low or '"ok": false' in low or '"ok":false' in low


class QuietPrinter:
    """Cross-message run-length compression of tool-call lines per profile.

    A worker often fires 20+ consecutive ``terminal`` (or ``mc *``) calls
    while doing nothing else interesting. Printing each as its own line
    is the dominant source of noise. This class buffers a running count
    per profile and flushes it the moment something else happens for
    that profile — a thought, an error, a user/handoff line, a different
    tool, or a periodic stale-flush from the main loop.

    Output for a 13-call run thus collapses to a single ``⚙ ×13 terminal``
    line printed when the worker says anything else (or after a few
    seconds of silence so it doesn't sit forever in the buffer).
    """

    STALE_FLUSH_S = 3.0

    def __init__(self, pad: int, use_color: bool):
        self.pad = pad
        self.use_color = use_color
        # profile → {"name": str, "n": int, "last": float}
        self.pending: dict[str, dict] = {}

    def _fmt_tool_summary(self, profile: str, name: str, n: int) -> str:
        primary, bold, dim = palette_for(profile) if self.use_color else ("", "", "")
        rst = RST if self.use_color else ""
        tag = f"{profile.lower():<{self.pad}}"
        count = f"×{n}" if n > 1 else ""
        return f"{primary}{tag}{rst} {bold}⚙ {count} {name}{rst}"

    def flush(self, profile: str) -> None:
        p = self.pending.pop(profile, None)
        if p:
            print(self._fmt_tool_summary(profile, p["name"], p["n"]))

    def flush_all(self) -> None:
        for profile in list(self.pending):
            self.flush(profile)

    def flush_stale(self) -> None:
        now = time.time()
        for profile, p in list(self.pending.items()):
            if now - p["last"] > self.STALE_FLUSH_S:
                self.flush(profile)

    def add_tool(self, profile: str, name: str) -> None:
        p = self.pending.get(profile)
        if p and p["name"] == name:
            p["n"] += 1
            p["last"] = time.time()
        else:
            # Different tool (or no pending) — flush prior, start new run
            if p:
                self.flush(profile)
            self.pending[profile] = {"name": name, "n": 1, "last": time.time()}

    def add_line(self, profile: str, line: str) -> None:
        """Print a non-tool line — flush any pending run for that profile first."""
        self.flush(profile)
        print(line)


def render_quiet_items(profile: str, msg: dict, use_color: bool, pad: int) -> list[tuple[str, str]]:
    """Quiet-mode renderer: emit structured items instead of lines so the
    caller can run-length-compress tool calls across messages.

    Returns list of (kind, payload):
      - ("line", str)  → print verbatim (already formatted)
      - ("tool", name) → feed to QuietPrinter.add_tool for run-length collapse
    """
    primary, bold, dim = palette_for(profile) if use_color else ("", "", "")
    user_c = USER_C if use_color else ""
    rst = RST if use_color else ""
    tag = f"{profile.lower():<{pad}}"
    role = msg.get("role")
    out: list[tuple[str, str]] = []

    if role == "user":
        text = truncate(str(msg.get("content", "")), 200)
        if text:
            for ln in text.splitlines():
                out.append(("line", f"{user_c}{tag}{rst} {user_c}USER {ln}{rst}"))
        return out

    if role == "assistant":
        text = (msg.get("content") or "").strip()
        if text:
            for ln in text.splitlines():
                out.append(("line", f"{primary}{tag}{rst} {primary}{ln}{rst}"))
        for tc in msg.get("tool_calls") or []:
            name = (tc.get("function") or {}).get("name", "?")
            out.append(("tool", name))
        return out

    if role == "tool":
        raw = fmt_tool_output(msg.get("content", ""))
        if not is_tool_error(raw):
            return out  # hide non-error results entirely
        one = " ⏎ ".join(line for line in raw.splitlines() if line.strip())
        short = truncate(one, 160)
        out.append(("line", f"{primary}{tag}{rst} {bold}✗ {short}{rst}"))
        return out

    return out


def render(profile: str, msg: dict, use_color: bool, pad: int, quiet: bool = False) -> list[str]:
    """Return list of printable lines for this message.

    When ``quiet`` is true:
      - assistant text (thoughts) kept in full
      - consecutive tool calls in one assistant message collapse to a single
        ``⚙ name1, name2, name3`` line (no args, no per-call line)
      - normal tool results are hidden — only errors are surfaced
      - user/handoff lines kept (short context)
    """
    primary, bold, dim = palette_for(profile) if use_color else ("", "", "")
    user_c = USER_C if use_color else ""
    rst = RST if use_color else ""
    tag = f"{profile.lower():<{pad}}"
    role = msg.get("role")
    lines: list[str] = []

    if role == "user":
        text = truncate(str(msg.get("content", "")), 200 if quiet else 400)
        if text:
            for ln in text.splitlines():
                lines.append(f"{user_c}{tag}{rst} {user_c}USER {ln}{rst}")
        return lines

    if role == "assistant":
        text = (msg.get("content") or "").strip()
        if text:
            for ln in text.splitlines():
                lines.append(f"{primary}{tag}{rst} {primary}{ln}{rst}")
        tool_calls = msg.get("tool_calls") or []
        if quiet:
            if tool_calls:
                names = [tc.get("function", {}).get("name", "?") for tc in tool_calls]
                summary = ", ".join(names) if len(names) <= 6 else (
                    ", ".join(names[:6]) + f", +{len(names) - 6} more"
                )
                lines.append(f"{primary}{tag}{rst} {bold}⚙ ×{len(names)}{rst}  {dim}{summary}{rst}")
        else:
            for tc in tool_calls:
                fn = tc.get("function") or {}
                name = fn.get("name", "?")
                args = fmt_tool_args(fn.get("arguments", ""))
                lines.append(f"{primary}{tag}{rst} {bold}⚙  {name}{rst}  {dim}{args}{rst}")
        return lines

    if role == "tool":
        out = fmt_tool_output(msg.get("content", ""))
        err = is_tool_error(out)
        if quiet and not err:
            return lines  # hide non-error results entirely in quiet mode
        out_one = " ⏎ ".join(line for line in out.splitlines() if line.strip())
        out_short = truncate(out_one, 160 if quiet else 220)
        marker = "✗" if err else "←"
        # In quiet mode, errors get the player's bold color (not dim) so they pop.
        body_c = bold if (quiet and err) else dim
        lines.append(f"{primary}{tag}{rst} {body_c}{marker} {out_short}{rst}")
        return lines

    return lines


def fmt_age(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h{(seconds % 3600) // 60:02d}m"
    return f"{seconds // 86400}d{(seconds % 86400) // 3600:02d}h"


def print_freshness_banner(profiles: list[str], pad: int, use_color: bool) -> None:
    meta = META_C if use_color else ""
    rst = RST if use_color else ""
    now = time.time()
    for p in profiles:
        primary, _, dim = palette_for(p) if use_color else ("", "", "")
        sess = newest_session(p)
        bot_log = BOT_LOG_DIR / f"bot-{p}.log"
        if sess:
            age = fmt_age(int(now - sess.stat().st_mtime))
            sess_note = f"session {sess.name} (last activity {age} ago)"
        else:
            sess_note = "no kanban sessions yet"
        if bot_log.exists():
            bage = fmt_age(int(now - bot_log.stat().st_mtime))
            bot_note = f"bot log {bage} ago"
        else:
            bot_note = "no bot log"
        print(f"  {primary}{p:<{pad}}{rst} {dim}{sess_note}  |  {bot_note}{rst}")


def render_bot_line(profile: str, line: str, use_color: bool, pad: int) -> str:
    """Color a bot-log line in the player's dim shade, prefixed with [BOT]."""
    primary, _, dim = palette_for(profile) if use_color else ("", "", "")
    rst = RST if use_color else ""
    tag = f"{profile.lower():<{pad}}"
    # Strip trailing newline + tighten whitespace
    s = line.rstrip()
    return f"{primary}{tag}{rst} {dim}[BOT] {s}{rst}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profiles", default="flint,mason,steward",
                    help="comma-separated list of kanban profiles to follow")
    ap.add_argument("--tail", type=int, default=0,
                    help="print last N messages from each profile's newest session before following")
    ap.add_argument("--no-follow", action="store_true")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--no-bot-logs", action="store_true",
                    help="don't fold in bot-<profile>.log chat/connection events")
    ap.add_argument("-q", "--quiet", action="store_true",
                    help="collapse consecutive tool calls to one summary line, "
                         "hide non-error tool output, keep thoughts + errors")
    ap.add_argument("--poll", type=float, default=1.0)
    args = ap.parse_args()

    use_color = (not args.no_color) and sys.stdout.isatty()
    profiles = [p.strip().lower() for p in args.profiles.split(",") if p.strip()]
    pad = max(len(p) for p in profiles) if profiles else 8

    # Per-profile state: (current_session_path, last_message_count_for_that_path).
    # Cursors are also kept PER SESSION FILE so that when "newest" ping-pongs
    # between two homes (continuous landfolk vs kanban worker), we don't
    # re-dump the entire session every time it briefly regains newest status.
    state: dict[str, tuple[Path | None, int]] = {p: (None, 0) for p in profiles}
    file_cursors: dict[Path, int] = {}
    # Per-profile bot-log byte offset (we start at end so we don't replay old chat)
    bot_log_offsets: dict[str, int] = {}
    if not args.no_bot_logs:
        for p in profiles:
            lp = BOT_LOG_DIR / f"bot-{p}.log"
            try:
                bot_log_offsets[p] = lp.stat().st_size
            except FileNotFoundError:
                bot_log_offsets[p] = 0

    meta = META_C if use_color else ""
    rst = RST if use_color else ""
    sources = "session+bot-log" if not args.no_bot_logs else "session-only"
    print(f"{meta}── aggregating {sources}: {', '.join(profiles)}{' (tail '+str(args.tail)+')' if args.tail else ''} ──{rst}")
    print_freshness_banner(profiles, pad, use_color)

    qp = QuietPrinter(pad=pad, use_color=use_color) if args.quiet else None

    def emit_msg(p: str, m: dict) -> None:
        if qp is None:
            for ln in render(p, m, use_color, pad):
                print(ln)
            return
        for kind, payload in render_quiet_items(p, m, use_color, pad):
            if kind == "tool":
                qp.add_tool(p, payload)
            else:  # "line"
                qp.add_line(p, payload)

    try:
        # Initial backfill if --tail
        if args.tail:
            for p in profiles:
                sess = newest_session(p)
                if sess is None:
                    continue
                msgs = load_messages(sess)
                start = max(0, len(msgs) - args.tail)
                for m in msgs[start:]:
                    emit_msg(p, m)
                state[p] = (sess, len(msgs))
                file_cursors[sess] = len(msgs)
            if qp:
                qp.flush_all()
            sys.stdout.flush()

        if args.no_follow and not args.tail:
            # One-shot: still print everything (no backfill mode just dumps current state)
            for p in profiles:
                sess = newest_session(p)
                if sess is None:
                    continue
                msgs = load_messages(sess)
                for m in msgs:
                    emit_msg(p, m)
            if qp:
                qp.flush_all()
            return 0
        if args.no_follow:
            return 0

        while True:
            any_new = False
            for p in profiles:
                # 1) Kanban session JSON (agent thoughts / commands / info)
                sess = newest_session(p)
                cur_path, _ = state[p]
                if sess is not None:
                    # Resume cursor for THIS file. A new file starts at 0;
                    # a file we've already been reading resumes from where
                    # we left off — defeats the ping-pong duplicate dump.
                    last_n = file_cursors.get(sess, 0)
                    if sess != cur_path:
                        if qp:
                            qp.flush(p)
                        # Only announce *brand-new* sessions (never seen before).
                        # Switching back to an already-known session is silent —
                        # the user doesn't need to see "new session" 6× when two
                        # active sessions are competing for newest.
                        if cur_path is not None and sess not in file_cursors:
                            print(f"{meta}── {p}: new session {sess.name} ──{rst}")
                    msgs = load_messages(sess)
                    if len(msgs) > last_n:
                        for m in msgs[last_n:]:
                            emit_msg(p, m)
                        last_n = len(msgs)
                        any_new = True
                    file_cursors[sess] = last_n
                    state[p] = (sess, last_n)

                # 2) Bot log (in-game chat / connect / kick events)
                if not args.no_bot_logs:
                    lp = BOT_LOG_DIR / f"bot-{p}.log"
                    try:
                        size = lp.stat().st_size
                    except FileNotFoundError:
                        continue
                    off = bot_log_offsets.get(p, 0)
                    if size < off:
                        # Log was rotated/truncated — reset
                        off = 0
                    if size > off:
                        try:
                            with lp.open("r", encoding="utf-8", errors="replace") as fh:
                                fh.seek(off)
                                chunk = fh.read()
                                bot_log_offsets[p] = fh.tell()
                        except OSError:
                            continue
                        for line in chunk.splitlines():
                            if BOT_LOG_FILTER.search(line):
                                bot_line = render_bot_line(p, line, use_color, pad)
                                if qp:
                                    qp.add_line(p, bot_line)
                                else:
                                    print(bot_line)
                                any_new = True
            # Periodic flush — keeps long quiet runs from sitting hidden forever
            if qp:
                qp.flush_stale()
            if any_new:
                sys.stdout.flush()
            time.sleep(args.poll)
    except KeyboardInterrupt:
        if qp:
            qp.flush_all()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
