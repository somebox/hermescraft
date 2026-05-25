#!/usr/bin/env python3
"""Scan existing bot logs for the 2026-05-25 position-corruption pattern.

Hypothesis under test
---------------------
A death-storm (>= 3 deaths in 60 s) and/or a reconnect cascade
("session replacement already in flight" >= 3 in 5 min) precedes the
mineflayer client's position state going to NaN/null. We can't detect
the null state directly from historical logs (no instrumentation
existed), so we use `@NaN` in reactive flee lines as a proxy — the
reactive code prints `hostile=<name>@NaN` whenever the distance to the
hostile is NaN, which happens iff bot.entity.position has NaN
components.

Usage
-----
    scripts/scan-position-corruption.py
    scripts/scan-position-corruption.py --log /tmp/hermescraft/bot-mason.log
    scripts/scan-position-corruption.py --json
"""

from __future__ import annotations

import argparse
import glob
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

LOG_GLOB = "/tmp/hermescraft/bot-*.log"

# Pattern definitions — each accepts a raw log line, returns True if matches.
RE_DEATH = re.compile(r"\bDIED!")
RE_RECONNECT_CASCADE = re.compile(r"session replacement already in flight")
RE_NAN_PROXY = re.compile(r"hostile=[^@\s]+@NaN")  # `@NaN` in reactive log
RE_NULL_POS = re.compile(r"Pos:null,")  # tool-output Pos:null,y,null
RE_DIAG_CORRUPT = re.compile(r"\[POS_DIAG\] event=(\S+) CORRUPT")  # future
RE_DIAG_RECOVER = re.compile(r"\[POS_DIAG\] event=(\S+) RECOVERED")

# Log lines start with `[H:MM:SS AM/PM]` or `[HH:MM:SS]`. Convert to seconds-of-day.
RE_TIME = re.compile(r"^\[(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?\]")


def parse_time(line: str) -> int | None:
    m = RE_TIME.match(line)
    if not m:
        return None
    h, mi, s, ampm = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
    if ampm == "PM" and h != 12:
        h += 12
    elif ampm == "AM" and h == 12:
        h = 0
    return h * 3600 + mi * 60 + s


def scan_one(path: Path):
    out = {
        "path": str(path),
        "deaths": [],          # list of times-of-day (sec)
        "reconnects": [],      # session-replacement events
        "nan_proxies": [],     # `@NaN` in reactive lines
        "null_pos_lines": [],  # `Pos:null,` in tool output
        "diag_corrupt": [],    # POS_DIAG CORRUPT events (future)
        "diag_recover": [],    # POS_DIAG RECOVERED events
    }
    try:
        with open(path, errors="replace") as fh:
            for lineno, raw in enumerate(fh, 1):
                t = parse_time(raw)
                if t is None:
                    continue
                if RE_DEATH.search(raw):
                    out["deaths"].append((t, lineno))
                if RE_RECONNECT_CASCADE.search(raw):
                    out["reconnects"].append((t, lineno))
                if RE_NAN_PROXY.search(raw):
                    out["nan_proxies"].append((t, lineno))
                if RE_NULL_POS.search(raw):
                    out["null_pos_lines"].append((t, lineno))
                m = RE_DIAG_CORRUPT.search(raw)
                if m:
                    out["diag_corrupt"].append((t, lineno, m.group(1)))
                m = RE_DIAG_RECOVER.search(raw)
                if m:
                    out["diag_recover"].append((t, lineno, m.group(1)))
    except FileNotFoundError:
        return None
    return out


def find_death_storms(deaths, window=60, min_count=3):
    """Return list of (start_time, end_time, count) where >= min_count deaths
    happen within `window` seconds."""
    storms = []
    times = [t for t, _ in deaths]
    if len(times) < min_count:
        return storms
    for i in range(len(times) - min_count + 1):
        j = i + min_count - 1
        if times[j] - times[i] <= window:
            # Extend window
            k = j
            while k + 1 < len(times) and times[k + 1] - times[i] <= window:
                k += 1
            storms.append((times[i], times[k], k - i + 1))
    # De-overlap
    if not storms:
        return storms
    merged = [storms[0]]
    for s in storms[1:]:
        if s[0] <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], s[1]), max(merged[-1][2], s[2]))
        else:
            merged.append(s)
    return merged


def first_event_after(events, threshold_sec, within_sec):
    """First event with time > threshold_sec and time - threshold_sec <= within_sec."""
    for t, *_ in events:
        if t > threshold_sec and (t - threshold_sec) <= within_sec:
            return t
        if t > threshold_sec + within_sec:
            break
    return None


def fmt_t(s: int) -> str:
    if s is None:
        return "—"
    h, r = divmod(s, 3600)
    m, sec = divmod(r, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}"


def analyze(report):
    """For each log, correlate death-storms / reconnect cascades with later
    NaN evidence. Returns a summary dict."""
    bot_name = Path(report["path"]).stem.replace("bot-", "")
    storms = find_death_storms(report["deaths"], window=60, min_count=3)
    reconnect_bursts = find_death_storms(report["reconnects"], window=300, min_count=3)

    nan_times = sorted({t for t, *_ in report["nan_proxies"]} | {t for t, *_ in report["null_pos_lines"]})

    correlations = []
    for kind, events in [("death_storm", storms), ("reconnect_cascade", reconnect_bursts)]:
        for start, end, count in events:
            nan_after = first_event_after(
                [(t, 0) for t in nan_times],
                threshold_sec=end,
                within_sec=600,  # 10 min window
            )
            correlations.append({
                "kind": kind,
                "start": fmt_t(start),
                "end": fmt_t(end),
                "count": count,
                "nan_within_10min_at": fmt_t(nan_after) if nan_after else None,
                "lag_s": (nan_after - end) if nan_after else None,
            })

    return {
        "bot": bot_name,
        "deaths_total": len(report["deaths"]),
        "reconnect_events_total": len(report["reconnects"]),
        "nan_proxy_lines": len(report["nan_proxies"]),
        "null_pos_lines": len(report["null_pos_lines"]),
        "death_storms": len(storms),
        "reconnect_cascades": len(reconnect_bursts),
        "diag_corrupt_events": len(report["diag_corrupt"]),
        "diag_recover_events": len(report["diag_recover"]),
        "correlations": correlations,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--log", action="append", default=None,
                    help="specific log file(s); default scans /tmp/hermescraft/bot-*.log")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    paths = [Path(p) for p in (args.log or sorted(glob.glob(LOG_GLOB)))]
    paths = [p for p in paths if p.is_file()]
    if not paths:
        sys.exit(f"no logs found (tried: {LOG_GLOB})")

    summaries = []
    for p in paths:
        report = scan_one(p)
        if report is None:
            continue
        summaries.append(analyze(report))

    if args.json:
        print(json.dumps(summaries, indent=2))
        return

    # Human table
    print(f"# scanned {len(paths)} log(s)")
    print()
    for s in summaries:
        print(f"## {s['bot']}")
        print(f"  totals: deaths={s['deaths_total']} reconnect_events={s['reconnect_events_total']} "
              f"nan_proxy_lines={s['nan_proxy_lines']} null_pos_lines={s['null_pos_lines']} "
              f"death_storms={s['death_storms']} reconnect_cascades={s['reconnect_cascades']}")
        if s.get("diag_corrupt_events"):
            print(f"  [POS_DIAG] CORRUPT events: {s['diag_corrupt_events']}  RECOVERED: {s['diag_recover_events']}")
        if not s["correlations"]:
            print("  no death-storms or reconnect-cascades found")
        else:
            print("  trigger → NaN-symptom correlation (within 10 min):")
            for c in s["correlations"]:
                lag = f"+{c['lag_s']}s" if c["lag_s"] is not None else "none-in-window"
                print(f"    {c['kind']:<20} {c['start']}–{c['end']} (n={c['count']}) → NaN @ {c['nan_within_10min_at'] or '—'} ({lag})")
        print()

    # Aggregate verdict
    total_storms = sum(s["death_storms"] + s["reconnect_cascades"] for s in summaries)
    total_with_nan = sum(
        1 for s in summaries for c in s["correlations"] if c["nan_within_10min_at"]
    )
    print("# verdict")
    if total_storms == 0:
        print("  no trigger events found in scanned logs — hypothesis cannot be tested from this data.")
    else:
        rate = total_with_nan / total_storms
        print(f"  trigger events: {total_storms} (death-storms + reconnect-cascades)")
        print(f"  followed by NaN evidence within 10 min: {total_with_nan} ({rate:.0%})")
        if rate >= 0.5:
            print("  → STRONG correlation: hypothesis supported.")
        elif rate > 0:
            print("  → WEAK correlation: trigger may be necessary but not sufficient; investigate other contributors.")
        else:
            print("  → NO correlation: refute the spawn-kill / reconnect-cascade → NaN hypothesis.")


if __name__ == "__main__":
    main()
