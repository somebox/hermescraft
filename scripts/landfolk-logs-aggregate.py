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

Each line is prefixed with ``HH:MM:SS`` (local time), interpolated from the
session JSON the same way as ``$LOG_DIR/cognition/*.jsonl`` (``--no-timestamps``
to disable). Bot ``[BOT]`` / ``chat`` lines use the timestamp embedded in the
bot log line when present.

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

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from hermes_session_lib import (
    load_session_document,
    message_event_time,
    parse_bot_log_timestamp,
    parse_iso_dt,
    session_times_from_path,
    short_ts_local_prefix,
)

PROFILES_DIR = Path.home() / ".hermes" / "profiles"
BOT_LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp/hermescraft"))
DISPATCHER_LOG = BOT_LOG_DIR / "dispatcher.log"


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
USER_C = "\033[38;5;245m"   # neutral grey — tool-call summaries
META_C = "\033[2;38;5;244m"
CHAT_C = "\033[1;38;5;51m"  # bright cyan — global in-game chat (dedup'd across bots)
DISP_C = "\033[1;38;5;208m"  # bright orange — landfolk dispatcher.log + plugin gate-check ticks

# In-game chat lines (`[Chat]`, `[Whisper]`, `[Overheard]`) are GLOBAL events
# — every bot that hears them writes the same line to its own log, so
# tailing N bot logs prints the same chat N times. Dedupe them and emit
# once under the `chat` pseudo-profile with CHAT_C.
#
# `[Queued via mention]` stays per-profile: it's the bot's local
# "I got @-mentioned" record, which IS profile-specific signal.
_GLOBAL_CHAT_RE = re.compile(r"\[(Chat|Whisper|Overheard)\]")

# Long absolute paths in shell snippets (replaced with basename or tail).
_PATHLIKE_RE = re.compile(
    r"(?:~(?:/[\w.-]+)+)|"
    r"(?:/(?:Users|home|tmp|var)(?:/[\w.-]+)+)|"
    r"(?:\b[\w.-]+/(?:[\w.-]+/)+[\w.-]+\.(?:py|json|yaml|yml|md|sh|js|ts|tsx)\b)"
)
_MC_CMD_RE = re.compile(
    r"\bmc\s+(\S+(?:\s+(?:--?\w+|[-\d.,]+|\w+))*)",
    re.IGNORECASE,
)


def palette_for(profile: str):
    return PALETTE.get(profile.lower(), FALLBACK)


class SessionClock:
    """Interpolated message times (same logic as cognition JSONL)."""

    def __init__(self) -> None:
        self._cache: dict[Path, tuple[float, object, object]] = {}

    def _bounds(self, sess: Path):
        mtime = sess.stat().st_mtime
        hit = self._cache.get(sess)
        if hit and hit[0] == mtime:
            return hit[1], hit[2]
        doc = load_session_document(sess)
        meta = session_times_from_path(sess, doc)
        start = parse_iso_dt(meta.get("session_start"))
        end = parse_iso_dt(meta.get("session_last_updated"))
        self._cache[sess] = (mtime, start, end)
        return start, end

    def prefix_for_message(self, sess: Path, msg_index: int, msg: dict, message_count: int) -> str:
        start, end = self._bounds(sess)
        iso, _ = message_event_time(
            session_start=start,
            session_end=end,
            msg_index=msg_index,
            message_count=message_count,
            msg=msg,
        )
        return short_ts_local_prefix(iso)


def time_col(show: bool, time_p: str, use_color: bool) -> str:
    if not show:
        return ""
    if use_color:
        return f"{META_C}{time_p}{RST} "
    return f"{time_p} "


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


def _strip_paths(text: str) -> str:
    def _repl(m: re.Match) -> str:
        frag = m.group(0)
        if frag.startswith("~/"):
            tail = frag[2:]
            return tail if len(tail) <= 40 else "…/" + tail.split("/")[-1]
        if frag.count("/") >= 2:
            return "…/" + frag.rstrip("/").split("/")[-1]
        return frag

    return _PATHLIKE_RE.sub(_repl, text)


def _short_path(path: str) -> str:
    path = (path or "").strip().strip("\"'")
    try:
        repo = Path(__file__).resolve().parent.parent
        rp = str(repo)
        if path.startswith(rp):
            return path[len(rp) :].lstrip("/")
    except Exception:
        pass
    home = str(Path.home())
    if path.startswith(home):
        path = path[len(home) :].lstrip("/")
    if len(path) > 48 and "/" in path:
        parts = path.split("/")
        path = "/".join(parts[-2:])
    return path


def _summarize_shell_part(part: str) -> str:
    part = part.strip()
    if not part:
        return ""
    part = re.sub(r"\s*\|\s*head(?:\s+-[^\s|;&]+)?\s*$", "", part)
    part = re.sub(r"\s*2>/dev/null\s*", " ", part)
    part = re.sub(r"\s*2>&1\s*", " ", part).strip()
    part = re.sub(r"^(?:export\s+)?(?:[A-Z_][A-Z0-9_]*=\S+\s+&&?\s+)+", "", part).strip()
    mc = _MC_CMD_RE.search(part)
    if mc:
        return truncate(f"mc {mc.group(1).strip()}", 56)
    if part.startswith(("echo ", "sleep ", "export ", "cd ")):
        return truncate(_strip_paths(part), 48)
    return truncate(_strip_paths(part), 56)


def summarize_terminal_command(command: str) -> str:
    cmd = (command or "").strip()
    if not cmd:
        return ""
    parts = re.split(r"\s*(?:&&|;|\|\|)\s*", cmd)
    bits = [_summarize_shell_part(p) for p in parts if p.strip()]
    bits = [b for b in bits if b]
    if not bits:
        return truncate(_strip_paths(cmd), 72)
    # Drop consecutive duplicates (e.g. repeated mc status in one chain).
    compact: list[str] = []
    for b in bits:
        if not compact or compact[-1] != b:
            compact.append(b)
    if len(compact) == 1:
        return compact[0]
    if len(compact) <= 3:
        return truncate("; ".join(compact), 88)
    return truncate("; ".join(compact[:2]) + f"; +{len(compact) - 2} more", 88)


def summarize_tool(name: str, arguments: str) -> str:
    """One-line hint for a tool call (paths stripped, mc verbs emphasized)."""
    name_l = (name or "").lower()
    try:
        d = json.loads(arguments) if arguments else None
    except Exception:
        d = None

    if name_l == "terminal":
        if isinstance(d, dict) and d.get("command") is not None:
            return summarize_terminal_command(str(d["command"]))
        return truncate(_strip_paths(str(arguments)), 72)

    if name_l in ("read_file", "readfile", "read"):
        if isinstance(d, dict):
            path = d.get("path") or d.get("file") or d.get("target")
            if path:
                return _short_path(str(path))
        return truncate(_strip_paths(str(arguments)), 60)

    if isinstance(d, dict):
        if "pattern" in d:
            return truncate(str(d["pattern"]), 72)
        if "query" in d:
            return truncate(str(d["query"]), 72)
        if "command" in d:
            return summarize_terminal_command(str(d["command"]))
    return truncate(_strip_paths(fmt_tool_args(arguments)), 72)


def collapse_tool_summaries(summaries: list[str], *, max_items: int = 4, max_len: int = 96) -> str:
    """Merge summaries from a run of similar tool calls into one grey line."""
    uniq: list[str] = []
    for s in summaries:
        s = (s or "").strip()
        if not s:
            continue
        if s not in uniq:
            uniq.append(s)
    if not uniq:
        return ""
    if len(uniq) <= max_items:
        return truncate(", ".join(uniq), max_len)
    head = ", ".join(uniq[:max_items])
    return truncate(f"{head}, +{len(uniq) - max_items} more", max_len)


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
    line with a light-grey one-line summary of ``mc …`` / command hints,
    printed when the worker says anything else (or after a few seconds of
    silence so it doesn't sit forever in the buffer).
    """

    STALE_FLUSH_S = 3.0

    def __init__(self, pad: int, use_color: bool, *, show_times: bool = True):
        self.pad = pad
        self.use_color = use_color
        self.show_times = show_times
        # profile → {"name": str, "n": int, "last": float, "summaries": list[str]}
        self.pending: dict[str, dict] = {}

    def _fmt_tool_summary(
        self, profile: str, name: str, n: int, summaries: list[str], time_p: str = "        "
    ) -> str:
        primary, bold, dim = palette_for(profile) if self.use_color else ("", "", "")
        hint = USER_C if self.use_color else ""
        rst = RST if self.use_color else ""
        tag = f"{profile.lower():<{self.pad}}"
        count = f"×{n}" if n > 1 else ""
        hint_text = collapse_tool_summaries(summaries)
        hint_suffix = f"  {hint}{hint_text}{rst}" if hint_text else ""
        tcol = time_col(self.show_times, time_p, self.use_color)
        return f"{tcol}{primary}{tag}{rst} {bold}⚙ {count} {name}{rst}{hint_suffix}"

    def flush(self, profile: str) -> None:
        p = self.pending.pop(profile, None)
        if p:
            print(
                self._fmt_tool_summary(
                    profile,
                    p["name"],
                    p["n"],
                    p.get("summaries") or [],
                    p.get("time_p") or "        ",
                )
            )

    def flush_all(self) -> None:
        for profile in list(self.pending):
            self.flush(profile)

    def flush_stale(self) -> None:
        now = time.time()
        for profile, p in list(self.pending.items()):
            if now - p["last"] > self.STALE_FLUSH_S:
                self.flush(profile)

    def add_tool(self, profile: str, name: str, summary: str = "", time_p: str = "        ") -> None:
        p = self.pending.get(profile)
        if p and p["name"] == name:
            p["n"] += 1
            p["last"] = time.time()
            if summary:
                p.setdefault("summaries", []).append(summary)
        else:
            # Different tool (or no pending) — flush prior, start new run
            if p:
                self.flush(profile)
            self.pending[profile] = {
                "name": name,
                "n": 1,
                "last": time.time(),
                "summaries": [summary] if summary else [],
                "time_p": time_p,
            }

    def add_line(self, profile: str, line: str) -> None:
        """Print a non-tool line — flush any pending run for that profile first."""
        self.flush(profile)
        print(line)


def render_quiet_items(
    profile: str,
    msg: dict,
    use_color: bool,
    pad: int,
    show_reasoning: bool = False,
    *,
    show_times: bool = True,
    time_p: str = "        ",
) -> list[tuple[str, str]]:
    """Quiet-mode renderer: emit structured items instead of lines so the
    caller can run-length-compress tool calls across messages.

    Returns list of (kind, payload):
      - ("line", str)  → print verbatim (already formatted)
      - ("tool", (name, summary)) → feed to QuietPrinter.add_tool for run-length collapse
    """
    primary, bold, dim = palette_for(profile) if use_color else ("", "", "")
    user_c = USER_C if use_color else ""
    rst = RST if use_color else ""
    tag = f"{profile.lower():<{pad}}"
    tcol = time_col(show_times, time_p, use_color)
    role = msg.get("role")
    out: list[tuple[str, str]] = []

    if role == "user":
        text = truncate(str(msg.get("content", "")), 200)
        if text:
            for ln in text.splitlines():
                out.append(("line", f"{tcol}{user_c}{tag}{rst} {user_c}USER {ln}{rst}"))
        return out

    if role == "assistant":
        reasoning = (msg.get("reasoning_content") or msg.get("reasoning") or "").strip()
        text = (msg.get("content") or "").strip()
        hint_c = META_C if use_color else ""
        if show_reasoning and reasoning and reasoning != text:
            for ln in reasoning.splitlines():
                out.append(("line", f"{tcol}{primary}{tag}{rst} {hint_c}· {ln.strip()}{rst}"))
        if text:
            for ln in text.splitlines():
                out.append(("line", f"{tcol}{primary}{tag}{rst} {primary}{ln}{rst}"))
        for tcall in msg.get("tool_calls") or []:
            fn = tcall.get("function") or {}
            name = fn.get("name", "?")
            summary = summarize_tool(name, fn.get("arguments", ""))
            out.append(("tool", (name, summary, time_p if show_times else "")))
        return out

    if role == "tool":
        raw = fmt_tool_output(msg.get("content", ""))
        if not is_tool_error(raw):
            return out  # hide non-error results entirely
        one = " ⏎ ".join(line for line in raw.splitlines() if line.strip())
        short = truncate(one, 160)
        out.append(("line", f"{tcol}{primary}{tag}{rst} {bold}✗ {short}{rst}"))
        return out

    return out


def render(
    profile: str,
    msg: dict,
    use_color: bool,
    pad: int,
    quiet: bool = False,
    show_reasoning: bool = False,
    *,
    show_times: bool = True,
    time_p: str = "        ",
) -> list[str]:
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
    tcol = time_col(show_times, time_p, use_color)
    role = msg.get("role")
    lines: list[str] = []

    if role == "user":
        text = truncate(str(msg.get("content", "")), 200 if quiet else 400)
        if text:
            for ln in text.splitlines():
                lines.append(f"{tcol}{user_c}{tag}{rst} {user_c}USER {ln}{rst}")
        return lines

    if role == "assistant":
        reasoning = (msg.get("reasoning_content") or msg.get("reasoning") or "").strip()
        text = (msg.get("content") or "").strip()
        if show_reasoning and reasoning and reasoning != text:
            hint_c = META_C if use_color else ""
            for ln in reasoning.splitlines():
                lines.append(f"{tcol}{primary}{tag}{rst} {hint_c}· {ln.strip()}{rst}")
        if text:
            for ln in text.splitlines():
                lines.append(f"{tcol}{primary}{tag}{rst} {primary}{ln}{rst}")
        tool_calls = msg.get("tool_calls") or []
        if quiet:
            if tool_calls:
                summaries = [
                    summarize_tool(
                        (tcall.get("function") or {}).get("name", "?"),
                        (tcall.get("function") or {}).get("arguments", ""),
                    )
                    for tcall in tool_calls
                ]
                hint = collapse_tool_summaries(summaries)
                hint_c = USER_C if use_color else ""
                lines.append(
                    f"{tcol}{primary}{tag}{rst} {bold}⚙ ×{len(tool_calls)}{rst}"
                    + (f"  {hint_c}{hint}{rst}" if hint else "")
                )
        else:
            for tcall in tool_calls:
                fn = tcall.get("function") or {}
                name = fn.get("name", "?")
                summary = summarize_tool(name, fn.get("arguments", ""))
                hint_c = USER_C if use_color else ""
                hint_suffix = f"  {hint_c}{summary}{rst}" if summary else ""
                lines.append(f"{tcol}{primary}{tag}{rst} {bold}⚙  {name}{rst}{hint_suffix}")
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
        lines.append(f"{tcol}{primary}{tag}{rst} {body_c}{marker} {out_short}{rst}")
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


def print_freshness_banner(profiles: list[str], pad: int, use_color: bool, *, show_dispatcher: bool = True) -> None:
    meta = META_C if use_color else ""
    disp_c = DISP_C if use_color else ""
    rst = RST if use_color else ""
    now = time.time()
    # Apply same realpath dedup as the main loop so the banner reflects what
    # the loop will actually print. Profile order wins: if flint and mason
    # both resolve to the same session dir (symlink case), flint claims it
    # and mason is marked as "shares with flint".
    claimed: dict[Path, str] = {}
    for p in profiles:
        primary, _, dim = palette_for(p) if use_color else ("", "", "")
        sess = newest_session(p)
        share_owner: str | None = None
        if sess is not None:
            rp = sess.resolve()
            if rp in claimed:
                share_owner = claimed[rp]
                sess = None  # don't display this session's age under p
            else:
                claimed[rp] = p
        bot_log = BOT_LOG_DIR / f"bot-{p}.log"
        if sess:
            age = fmt_age(int(now - sess.stat().st_mtime))
            sess_note = f"session {sess.name} (last activity {age} ago)"
        elif share_owner:
            sess_note = f"shares session dir with {share_owner} — see that stream"
        else:
            sess_note = "no kanban sessions yet"
        if bot_log.exists():
            bage = fmt_age(int(now - bot_log.stat().st_mtime))
            bot_note = f"bot log {bage} ago"
        else:
            bot_note = "no bot log"
        print(f"  {primary}{p:<{pad}}{rst} {dim}{sess_note}  |  {bot_note}{rst}")
    if show_dispatcher:
        if DISPATCHER_LOG.exists():
            dage = fmt_age(int(now - DISPATCHER_LOG.stat().st_mtime))
            dnote = f"last entry {dage} ago"
        else:
            dnote = "no dispatcher.log yet"
        print(f"  {disp_c}{'dispatcher':<{pad}}{rst} {META_C if use_color else ''}{dnote}{rst}")


def render_bot_line(
    profile: str, line: str, use_color: bool, pad: int, *, show_times: bool = True
) -> str:
    """Color a bot-log line in the player's dim shade, prefixed with [BOT]."""
    primary, _, dim = palette_for(profile) if use_color else ("", "", "")
    rst = RST if use_color else ""
    tag = f"{profile.lower():<{pad}}"
    s = line.rstrip()
    time_p = short_ts_local_prefix(parse_bot_log_timestamp(s)) if show_times else ""
    tc = time_col(show_times, time_p, use_color)
    return f"{tc}{primary}{tag}{rst} {dim}[BOT] {s}{rst}"


def render_chat_line(line: str, use_color: bool, pad: int, *, show_times: bool = True) -> str:
    """Color a deduped chat line under the `chat` pseudo-profile."""
    chat_c = CHAT_C if use_color else ""
    rst = RST if use_color else ""
    tag = f"{'chat':<{pad}}"
    s = line.rstrip()
    time_p = short_ts_local_prefix(parse_bot_log_timestamp(s)) if show_times else ""
    tc = time_col(show_times, time_p, use_color)
    return f"{tc}{chat_c}{tag} {s}{rst}"


# 24-hour [HH:MM:SS] prefix used by scripts/landfolk-dispatcher.sh and
# plugins/landfolk/landfolk/orchestrator/log.py. Different from the
# 12-hour AM/PM format that mineflayer bot-log lines use, so the
# shared parse_bot_log_timestamp() doesn't match it.
_DISPATCHER_TS_RE = re.compile(r"^\[(\d{1,2}):(\d{2}):(\d{2})\]")


def _parse_dispatcher_timestamp(line: str) -> str | None:
    m = _DISPATCHER_TS_RE.match((line or "").strip())
    if not m:
        return None
    hh, mm, ss = m.group(1), m.group(2), m.group(3)
    return f"{int(hh):02d}:{mm}:{ss}"


def render_dispatcher_line(line: str, use_color: bool, pad: int, *, show_times: bool = True) -> str:
    """Render a dispatcher.log line under the `dispatcher` pseudo-profile.

    Strips the redundant ``[HH:MM:SS]`` prefix from the body since we
    already extract it into the time column. Used for landfolk
    dispatcher ticks AND for `orch: promoted=N mutex_parked=M ...`
    lines emitted by the landfolk plugin's gate-check.
    """
    disp_c = DISP_C if use_color else ""
    rst = RST if use_color else ""
    tag = f"{'dispatcher':<{pad}}"
    s = line.rstrip()
    time_p = _parse_dispatcher_timestamp(s) if show_times else ""
    # Strip the leading [HH:MM:SS] prefix from the body once we've
    # surfaced it into the time column — no need to print it twice.
    body = s
    if show_times and time_p and body.startswith("["):
        bracket_end = body.find("]")
        if bracket_end != -1:
            body = body[bracket_end + 1:].lstrip()
    tc = time_col(show_times, time_p, use_color)
    return f"{tc}{disp_c}{tag} {body}{rst}"


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
    ap.add_argument("--no-dispatcher", action="store_true",
                    help="don't fold in /tmp/hermescraft/dispatcher.log (kanban tick + landfolk gate-check)")
    ap.add_argument("-q", "--quiet", action="store_true",
                    help="collapse consecutive tool calls to one summary line, "
                         "hide non-error tool output, keep thoughts + errors")
    ap.add_argument(
        "--reasoning",
        action="store_true",
        help="include reasoning_content / reasoning (hidden chain-of-thought) before assistant text",
    )
    ap.add_argument(
        "--no-timestamps",
        action="store_true",
        help="omit HH:MM:SS column (legacy layout)",
    )
    ap.add_argument("--poll", type=float, default=1.0)
    args = ap.parse_args()

    use_color = (not args.no_color) and sys.stdout.isatty()
    show_times = not args.no_timestamps
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
    # Dispatcher log byte offset — single file, no per-profile state.
    dispatcher_log_offset = 0
    if not args.no_dispatcher:
        try:
            dispatcher_log_offset = DISPATCHER_LOG.stat().st_size
        except FileNotFoundError:
            dispatcher_log_offset = 0
    # Dedup ring for global chat lines: every bot logs the same `[Chat]`
    # message; emit only the first occurrence. Bounded LRU on (timestamp +
    # message body) — the bot-log timestamp is server-driven and identical
    # across listeners, so identical lines hash identically across files.
    from collections import OrderedDict
    chat_dedup: OrderedDict[str, None] = OrderedDict()
    CHAT_DEDUP_MAX = 200
    # Recompute pad to include the "chat" and "dispatcher" pseudo-profiles
    # so their banners align with real-profile rows.
    pad = max(pad, len("chat"))
    if not args.no_dispatcher:
        pad = max(pad, len("dispatcher"))

    meta = META_C if use_color else ""
    rst = RST if use_color else ""
    src_parts = ["session"]
    if not args.no_bot_logs:
        src_parts.append("bot-log")
    if not args.no_dispatcher:
        src_parts.append("dispatcher.log")
    sources = "+".join(src_parts)
    print(f"{meta}── aggregating {sources}: {', '.join(profiles)}{' (tail '+str(args.tail)+')' if args.tail else ''} ──{rst}")
    print_freshness_banner(profiles, pad, use_color, show_dispatcher=not args.no_dispatcher)

    qp = QuietPrinter(pad=pad, use_color=use_color, show_times=show_times) if args.quiet else None
    clock = SessionClock()

    def emit_msg(p: str, m: dict, msg_index: int, sess: Path | None, n: int) -> None:
        time_p = (
            clock.prefix_for_message(sess, msg_index, m, n)
            if show_times and sess is not None
            else "        "
        )
        if qp is None:
            for ln in render(
                p,
                m,
                use_color,
                pad,
                quiet=args.quiet,
                show_reasoning=args.reasoning,
                show_times=show_times,
                time_p=time_p,
            ):
                print(ln)
            return
        for kind, payload in render_quiet_items(
            p,
            m,
            use_color,
            pad,
            show_reasoning=args.reasoning,
            show_times=show_times,
            time_p=time_p,
        ):
            if kind == "tool":
                name, summary, tp = payload
                qp.add_tool(p, name, summary, time_p=tp or time_p)
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
                for i, m in enumerate(msgs[start:], start):
                    emit_msg(p, m, i, sess, len(msgs))
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
                for i, m in enumerate(msgs):
                    emit_msg(p, m, i, sess, len(msgs))
            if qp:
                qp.flush_all()
            return 0
        if args.no_follow:
            return 0

        while True:
            any_new = False
            # Per-tick dedup: if two profiles' newest sessions resolve to
            # the same realpath (e.g. ~/.hermes-landfolk-flint/sessions and
            # ~/.hermes-landfolk-mason/sessions both symlink to the same
            # default home), attribute the session to the first profile in
            # the list. Without this, identical lines get printed under
            # both labels, falsely implying two agents doing the same work.
            claimed_realpaths: dict[Path, str] = {}
            for p in profiles:
                # 1) Kanban session JSON (agent thoughts / commands / info)
                sess = newest_session(p)
                if sess is not None:
                    rp = sess.resolve()
                    if rp in claimed_realpaths:
                        sess = None  # already shown under another profile
                    else:
                        claimed_realpaths[rp] = p
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
                        for i, m in enumerate(msgs[last_n:], last_n):
                            emit_msg(p, m, i, sess, len(msgs))
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
                            if not BOT_LOG_FILTER.search(line):
                                continue
                            # Global chat events: dedupe across bots and
                            # emit once under the `chat` pseudo-profile.
                            # Per-profile noise (Queued via mention,
                            # Connected, Kicked, Disconnected) goes through
                            # the normal per-profile path below.
                            if _GLOBAL_CHAT_RE.search(line):
                                key = line.rstrip()
                                if key in chat_dedup:
                                    continue
                                chat_dedup[key] = None
                                if len(chat_dedup) > CHAT_DEDUP_MAX:
                                    chat_dedup.popitem(last=False)
                                chat_line = render_chat_line(line, use_color, pad, show_times=show_times)
                                if qp:
                                    qp.add_line('chat', chat_line)
                                else:
                                    print(chat_line)
                                any_new = True
                                continue
                            bot_line = render_bot_line(p, line, use_color, pad, show_times=show_times)
                            if qp:
                                qp.add_line(p, bot_line)
                            else:
                                print(bot_line)
                            any_new = True

            # 3) Dispatcher log — single file, not per-profile. Includes
            # `tick: spawned=N reclaimed=M ...` from hermes kanban dispatch
            # AND `orch: promoted=N mutex_parked=M ...` from the landfolk
            # plugin's gate-check. Emitted under the `dispatcher` pseudo-
            # profile so it interleaves chronologically with agent activity.
            if not args.no_dispatcher:
                try:
                    size = DISPATCHER_LOG.stat().st_size
                except FileNotFoundError:
                    size = -1
                if size >= 0:
                    if size < dispatcher_log_offset:
                        dispatcher_log_offset = 0  # rotation / truncation
                    if size > dispatcher_log_offset:
                        try:
                            with DISPATCHER_LOG.open("r", encoding="utf-8", errors="replace") as fh:
                                fh.seek(dispatcher_log_offset)
                                chunk = fh.read()
                                dispatcher_log_offset = fh.tell()
                        except OSError:
                            chunk = ""
                        for line in chunk.splitlines():
                            if not line.strip():
                                continue
                            disp_line = render_dispatcher_line(line, use_color, pad, show_times=show_times)
                            if qp:
                                qp.add_line("dispatcher", disp_line)
                            else:
                                print(disp_line)
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
