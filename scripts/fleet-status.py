#!/usr/bin/env python3
"""fleet-status.py — what is every bot actually doing right now?

Single-pass sitrep across the landfolk fleet. Combines:
  - /health from each bot's HTTP port (position, HP, food, holding, uptime)
  - kanban worker process detection (ps grep for `hermes -p <bot> kanban task`)
  - mc-<bot>.log tail for last `mc` tool call + result
  - bot-<bot>.log tail for last narration line

Steward kept needing this picture (board state + worker process + last action)
and reaching for `ps aux | grep mineflayer` + `cat scripts/roster.py` + ad-hoc
sqlite queries. This is the consolidated read.

Usage:
    scripts/fleet-status.py
    scripts/fleet-status.py --json
    scripts/fleet-status.py --bot flint           # one-bot focus

Read-only. No board mutations. Fast (~1-2s).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
AGENT_MODELS = Path(os.environ.get("AGENT_MODELS", str(REPO_ROOT / "data" / "agent-models.json")))
LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp/hermescraft"))

# ANSI color helpers — TTY only.
_TTY = sys.stdout.isatty()
def c(s, color):
    if not _TTY:
        return s
    codes = {"green": 32, "yellow": 33, "red": 31, "dim": 2, "bold": 1, "cyan": 36}
    return f"\033[{codes[color]}m{s}\033[0m"


def http_get_json(url, timeout=2):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def load_agents():
    """Returns list of (name_lower, api_port, role)."""
    data = json.loads(AGENT_MODELS.read_text())
    agents = data.get("agents", {})
    return [
        (name.lower(), int(cfg.get("api_port") or 0), cfg.get("role", "?"))
        for name, cfg in agents.items()
        if cfg.get("api_port")
    ]


def detect_workers():
    """profile → list of (pid, task_id) from `hermes -p <prof> ... kanban task <tid>`."""
    workers: dict = {}
    try:
        ps = subprocess.run(
            ["ps", "-ax", "-o", "pid=,etime=,command="],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:
        return workers
    pat = re.compile(r"hermes -p (\S+).*kanban task (\S+)")
    for line in ps.splitlines():
        line = line.strip()
        # First token = pid, second = etime, rest = command
        parts = line.split(None, 2)
        if len(parts) != 3:
            continue
        pid, etime, cmd = parts
        m = pat.search(cmd)
        if not m:
            continue
        workers.setdefault(m.group(1).lower(), []).append({
            "pid": pid, "etime": etime, "task_id": m.group(2),
        })
    return workers


def detect_continuous_agent(bot_lower):
    """Is there a continuous orchestrator/agent loop for this profile?
    Look for the agent-loop process (landfolk:agent-loop:<Name>).
    """
    cap = bot_lower[:1].upper() + bot_lower[1:]
    try:
        out = subprocess.run(
            ["pgrep", "-f", f"landfolk:agent-loop:{cap}"],
            capture_output=True, text=True, timeout=3,
        ).stdout.strip()
        return out.split("\n")[0] if out else None
    except Exception:
        return None


_MC_LOG_RE = re.compile(
    r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\].*tokens=\[\"([a-z_]+)\"(?:,([^\]]*))?\]"
)


def tail_mc_log(bot_lower, max_lines=300):
    """Most recent (timestamp, verb, args, result) from mc-<bot>.log."""
    path = LOG_DIR / f"mc-{bot_lower}.log"
    if not path.is_file():
        return None
    try:
        # Tail by reading last N lines
        with path.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = min(size, 8192)
            f.seek(size - block)
            tail = f.read().decode("utf-8", errors="replace").splitlines()
    except Exception:
        return None

    last_verb = None
    last_ts = None
    last_result = None
    for line in reversed(tail[-max_lines:]):
        m = _MC_LOG_RE.match(line)
        if m and last_verb is None:
            last_ts = m.group(1)
            last_verb = m.group(2)
            args = (m.group(3) or "").strip()
            args_short = args[:30] + "…" if len(args) > 30 else args
            last_verb = f"{last_verb} {args_short}".strip()
        # Find first result line after the verb
        if "RES " in line and last_verb and last_result is None:
            last_result = "ok" if "http=200" not in line.lower() or "FAIL" not in line else "FAIL"
            if "http=200" in line and "FAIL" not in line:
                last_result = "ok"
            elif "FAIL" in line or "http=4" in line or "http=5" in line:
                last_result = "fail"
            else:
                last_result = "?"
            break
    if not last_verb:
        return None
    return {"ts": last_ts, "verb": last_verb, "result": last_result or "?"}


def tail_bot_log(bot_lower, max_chars=200):
    """Most recent narration / event line from bot-<bot>.log."""
    path = LOG_DIR / f"bot-{bot_lower}.log"
    if not path.is_file():
        return None
    try:
        with path.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = min(size, 4096)
            f.seek(size - block)
            tail = f.read().decode("utf-8", errors="replace").splitlines()
    except Exception:
        return None
    for line in reversed(tail):
        line = line.strip()
        if not line:
            continue
        # Filter out [HEARD] / [CHAT] noise unless that's all there is
        if "POS_DIAG" in line or "instrumentation armed" in line:
            continue
        # Show first meaningful line
        return line[:max_chars]
    return None


def ago_seconds(ts_str):
    if not ts_str:
        return None
    try:
        ts = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
        return int((datetime.now() - ts).total_seconds())
    except Exception:
        return None


def humanize(seconds):
    if seconds is None:
        return "?"
    if seconds < 0:
        return "?"
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h{(seconds % 3600) // 60:02d}m"
    return f"{seconds // 86400}d{(seconds % 86400) // 3600}h"


def classify(connected, continuous_pid, worker_pids, last_mc_age_s):
    if not connected:
        return "OFFLINE", "red"
    if continuous_pid and worker_pids:
        return "ACTIVE+ORCH", "cyan"
    if worker_pids:
        return "ACTIVE", "green"
    if continuous_pid:
        return "CONTINUOUS", "cyan"
    # Connected, no worker, no continuous → idle bot body
    # Distinguish recently-active (just finished a card) vs long-idle
    if last_mc_age_s is not None and last_mc_age_s < 120:
        return "RECENT", "yellow"
    return "IDLE", "yellow"


def gather_one(bot_lower, port, role):
    health = http_get_json(f"http://127.0.0.1:{port}/health")
    connected = bool(health and health.get("connected"))
    continuous_pid = detect_continuous_agent(bot_lower)
    workers = detect_workers().get(bot_lower, [])
    mc_tail = tail_mc_log(bot_lower)
    bot_tail = tail_bot_log(bot_lower)

    last_mc_age = ago_seconds(mc_tail["ts"]) if mc_tail else None
    label, color = classify(connected, continuous_pid, [w["pid"] for w in workers], last_mc_age)

    pos = health.get("position") if health else None
    return {
        "bot": bot_lower,
        "role": role,
        "port": port,
        "label": label,
        "label_color": color,
        "connected": connected,
        "position": pos,
        "holding": (health.get("holding") if health else None),
        "uptime_s": (health.get("uptime_sec") if health else None),
        "build": (health.get("build") if health else None),
        "continuous_pid": continuous_pid,
        "workers": workers,
        "last_mc": mc_tail,
        "last_log": bot_tail,
    }


def fmt_pos(p):
    if not p:
        return "(?)"
    return f"({p.get('x', '?'):.0f},{p.get('y', '?'):.0f},{p.get('z', '?'):.0f})"


def print_human(snapshots):
    now_s = datetime.now().strftime("%H:%M:%S")
    print(f"# fleet sitrep — {now_s}")
    counts = {"ACTIVE": 0, "ACTIVE+ORCH": 0, "CONTINUOUS": 0, "RECENT": 0, "IDLE": 0, "OFFLINE": 0}
    for s in snapshots:
        counts[s["label"]] = counts.get(s["label"], 0) + 1
    summary = "  ".join(f"{c(k, 'bold')}={v}" for k, v in counts.items() if v)
    print(f"# {summary}")
    print()
    for s in snapshots:
        label = c(s["label"].ljust(11), s["label_color"])
        if not s["connected"]:
            print(f"{c(s['bot'], 'bold'):<10}  {label}  role={s['role']}")
            continue
        head = f"{c(s['bot'], 'bold'):<10}  {label}"
        details = f"pos={fmt_pos(s['position'])}  holding={s['holding'] or 'empty'}  up={humanize(s['uptime_s'])}  role={s['role']}"
        print(f"{head}  {details}")

        # build commit (if /health.build present)
        if s["build"] and isinstance(s["build"], dict):
            spawn = (s["build"].get("spawn") or {}).get("commit", "")
            drift = s["build"].get("drift")
            if spawn:
                build_str = f"build {spawn[:7]}" + (c(" DRIFT", "red") if drift else "")
                print(f"            {c(build_str, 'dim')}")

        if s["workers"]:
            for w in s["workers"]:
                print(f"            {c('worker', 'green')}  pid={w['pid']} task={w['task_id']} runtime={w['etime']}")
        elif s["continuous_pid"]:
            print(f"            {c('orchestrator', 'cyan')}  pid={s['continuous_pid']} (continuous loop)")
        else:
            print(f"            {c('no worker process', 'dim')}")

        if s["last_mc"]:
            age = ago_seconds(s["last_mc"]["ts"])
            # mc-<bot>.log is only written for profiles with MC_DEBUG_LOG set
            # (currently just steward). For kanban-mode workers, the log
            # exists but is stale — suppress to avoid misleading output.
            if age is not None and age < 3600:
                verb = s["last_mc"]["verb"]
                result = s["last_mc"]["result"]
                color = "green" if result == "ok" else ("red" if result == "fail" else "dim")
                print(f"            last mc:  {c(verb[:50], color)}  ({humanize(age)} ago, {result})")
        if s["last_log"]:
            # Strip ANSI from log lines if any leaked through
            clean = re.sub(r"\033\[[0-9;]*m", "", s["last_log"])
            print(f"            last log: {c(clean[:90], 'dim')}")
        print()

    # Action hints
    hints = []
    idle = [s for s in snapshots if s["label"] == "IDLE" and s["connected"]]
    if idle:
        names = ", ".join(s["bot"] for s in idle)
        hints.append(f"{names} idle — consider reassigning or generating parallel work")
    drift = [s for s in snapshots
             if s["build"] and isinstance(s["build"], dict) and s["build"].get("drift")]
    if drift:
        hints.append(f"{', '.join(s['bot'] for s in drift)} on stale code — landfolk version, then restart")
    if hints:
        print(c("# hints:", "yellow"))
        for h in hints:
            print(f"  - {h}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bot", help="focus on one profile only", default=None)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    agents = load_agents()
    if args.bot:
        agents = [(n, p, r) for (n, p, r) in agents if n == args.bot.lower()]
        if not agents:
            print(f"unknown bot: {args.bot}", file=sys.stderr)
            return 2

    snapshots = [gather_one(name, port, role) for (name, port, role) in agents]

    if args.json:
        # Strip non-serializable color tags
        clean = []
        for s in snapshots:
            d = {k: v for k, v in s.items() if k != "label_color"}
            clean.append(d)
        json.dump(clean, sys.stdout, indent=2, default=str)
        print()
        return 0

    print_human(snapshots)
    return 0


if __name__ == "__main__":
    sys.exit(main())
