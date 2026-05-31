#!/usr/bin/env python3
"""Extract structured navigation telemetry from a completed genesis run.

Mines existing data sources (agent.log, bot-*.log, session JSONs,
locations-*.json) and emits:

  - <run>/findings/nav-telemetry.jsonl   — per-event JSON lines
  - <run>/findings/nav-telemetry.md      — human summary

Event shapes:

  {"kind": "blockage", "profile": "flint", "ts": "...", "verb": "move",
   "code": "NAV_BLOCKED", "from": {"x":..,"y":..,"z":..}, "target": {...},
   "holding": "stone_pickaxe", "raw": "<truncated error tail>"}

  {"kind": "mark_save", "profile": "mason", "name": "lt_stone_west",
   "coord": {"x":..,"y":..,"z":..}, "note": "...", "saved_at": "..."}

  {"kind": "nav_brief_shadow", "profile": "flint", "compute_ms": 4,
   "nav_mode": "open", "mark_count": 5, "reachable": 0, ...}

  {"kind": "sign_read", "profile": ..., "coord": {...}, "lines": [...]}
    (TODO: bot doesn't currently log sign reads as JSON — placeholder)

Usage:
  scripts/nav-telemetry.py <run_id>          # most-recent run by default
  scripts/nav-telemetry.py --jsonl           # write only the jsonl file
  scripts/nav-telemetry.py --stdout          # stream to stdout instead
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "data" / "genesis-runs"
HERMES_PROFILES = Path.home() / ".hermes" / "profiles"
BOT_LOG_DIR = Path("/tmp/hermescraft")

# ─── parsers ───────────────────────────────────────────────────────────

# Agent log line: "2026-05-30 19:50:38,039 WARNING [SID] agent.tool_executor: Tool terminal returned error (0.86s): {"output": "ERROR [move] : No path to -456,74,593 from -475.3,66.0,592.5 ..."
#
# IMPORTANT: many log lines are truncated mid-JSON (the harness clips long
# outputs). A greedy regex requiring the closing `", "exit_code":` would
# miss most of them. Match on the prefix and grab as much output as is on
# the same line.
AGENT_ERR_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ .* Tool terminal returned error "
    r"\([\d.]+s\): \{\"output\": \"(?P<output>.*)$",
)
ERR_VERB_RE = re.compile(r"ERROR \[(?P<verb>[a-z_]+)\]\s*:\s*(?P<msg>.+?)(?=\[http=|$)", re.DOTALL)
ERR_CODE_RE = re.compile(r"code=(?P<code>[A-Z_]+)")

# Known error codes (from grep across bot/lib/actions/**/*.js). Truncated
# log lines lose the suffix mid-token — we get e.g. NAV_BLOC instead of
# NAV_BLOCKED. Match truncated codes against this list as a prefix.
KNOWN_CODES = (
    "NAV_BLOCKED", "NAV_FAILED", "NAV_RETRY_LOOP", "NAV_TARGET_UNSTANDABLE",
    "NAV_TARGET_OCCUPIED", "NO_BLOCK_AT_COORD", "NO_VISIBLE_BLOCKS",
    "OPERATION_TIMEOUT", "MISSING_INGREDIENTS", "INTERRUPTED",
    "ALL_PATHFIND_FAILED", "ESCAPE_NO_OPEN_DIR", "ESCAPE_CEILING_BLOCKED",
    "ESCAPE_NO_DROP", "TARGET_SELF_OCCUPIED", "STAIRCASE_EGRESS",
    "REGION_PROTECTED", "MIXED_FAILURE", "TARGET_OCCUPIED", "BOT_TRAPPED",
    "NO_LINE_OF_SIGHT", "TOOL_INVALID_CATEGORY", "INVALID_VALUE",
    "ITEM_NOT_FOUND", "NO_FUEL", "UNKNOWN_CATEGORY", "OUT_OF_RANGE",
    "SUPPORT_BLOCK", "BOT_ON_PILLAR", "PLACEMENT_BLOCKED",
)


def normalize_code(code: str | None) -> str | None:
    """Resolve a possibly-truncated error code against the known set.
    NAV_BLOC → NAV_BLOCKED, NAV_ → NAV_BLOCKED (ambiguous, picks first match).
    Returns the truncated form unchanged if no prefix match (so we can spot
    new codes that need adding to KNOWN_CODES)."""
    if not code:
        return code
    if code in KNOWN_CODES:
        return code
    for full in KNOWN_CODES:
        if full.startswith(code):
            return full
    return code
ERR_HOLD_RE = re.compile(r"Hold:(?P<hold>[a-z_]+)")
ERR_POS_RE = re.compile(r"Pos:(?P<x>-?[\d.]+),(?P<y>-?[\d.]+),(?P<z>-?[\d.]+)")
ERR_TARGET_RE = re.compile(r"(?:to|at|of|target=)\s*\(?(?P<x>-?\d+),\s*(?P<y>-?\d+),\s*(?P<z>-?\d+)")

NAV_SHADOW_RE = re.compile(r'\{"event":"nav_brief_shadow"[^\n]*\}')


def parse_agent_log_errors(path: Path, profile: str, window: tuple[dt.datetime, dt.datetime] | None):
    """Yield blockage events from an agent.log."""
    if not path.is_file():
        return
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return
    for line in lines:
        m = AGENT_ERR_RE.match(line)
        if not m:
            continue
        ts = dt.datetime.strptime(m.group("ts"), "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=dt.timezone.utc
        )
        if window and not (window[0] <= ts <= window[1]):
            continue
        output = m.group("output")
        verb_match = ERR_VERB_RE.search(output)
        if not verb_match:
            # Some errors don't have the verb prefix (CLI parse errors etc.);
            # skip them — they're not nav events.
            continue
        verb = verb_match.group("verb")
        msg = verb_match.group("msg")[:200].strip()
        cm = ERR_CODE_RE.search(output)
        code = normalize_code(cm.group("code")) if cm else None
        # If no code found at all, try inferring from the message itself.
        if not code:
            if "No path to" in output or "no door/gate" in output:
                code = "NAV_BLOCKED"
            elif "Took to long to decide path" in output:
                code = "NAV_FAILED"
            elif "No standable cell" in output or "NAV_TARGET_UNSTANDABLE" in output:
                code = "NAV_TARGET_UNSTANDABLE"
            elif "[Command timed out" in output:
                code = "AGENT_CMD_TIMEOUT"
            elif "consecutive mc" in output and "failed" in output:
                code = "NAV_RETRY_LOOP"
        hold = ERR_HOLD_RE.search(output)
        pos = ERR_POS_RE.search(output)
        tgt = ERR_TARGET_RE.search(output)
        evt = {
            "kind": "blockage",
            "profile": profile,
            "ts": ts.isoformat().replace("+00:00", "Z"),
            "verb": verb,
            "code": code,
            "msg": msg.rstrip(". "),
        }
        if pos:
            evt["from"] = {
                "x": round(float(pos.group("x")), 1),
                "y": round(float(pos.group("y")), 1),
                "z": round(float(pos.group("z")), 1),
            }
        if tgt:
            evt["target"] = {
                "x": int(tgt.group("x")),
                "y": int(tgt.group("y")),
                "z": int(tgt.group("z")),
            }
        if hold:
            evt["holding"] = hold.group("hold")
        yield evt


def parse_locations(path: Path, profile: str):
    """Yield mark_save events from a locations-*.json snapshot."""
    if not path.is_file():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    for name, v in data.items():
        if not isinstance(v, dict) or not all(k in v for k in ("x", "y", "z")):
            continue
        yield {
            "kind": "mark_save",
            "profile": profile,
            "name": name,
            "coord": {"x": v["x"], "y": v["y"], "z": v["z"]},
            "note": v.get("note"),
            "saved_at": v.get("saved") or v.get("updated"),
            "visit_count": v.get("visit_count", 0),
        }


def parse_nav_brief_shadow(path: Path, profile: str):
    """Yield nav_brief_shadow events from a bot stdout log."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        m = NAV_SHADOW_RE.search(line)
        if not m:
            continue
        try:
            evt = json.loads(m.group(0))
            evt["kind"] = "nav_brief_shadow"
            evt["profile"] = profile
            yield evt
        except json.JSONDecodeError:
            continue


def parse_session_commands(profile: str, window: tuple[dt.datetime, dt.datetime] | None):
    """Yield successful nav verbs from session JSONs (gives the *intent* trace
    that complements the failure trace from agent.log)."""
    sess_dir = HERMES_PROFILES / profile / "sessions"
    if not sess_dir.is_dir():
        return
    nav_verbs = {"move", "goto", "goto_near", "go_mark", "stair_down", "pillar_up", "pillar_down"}
    for sess_path in sorted(sess_dir.glob("session_*.json")):
        try:
            mtime = dt.datetime.fromtimestamp(sess_path.stat().st_mtime, tz=dt.timezone.utc)
            if window and mtime < window[0] - dt.timedelta(hours=2):
                continue
            if window and mtime > window[1] + dt.timedelta(hours=2):
                continue
            sess = json.loads(sess_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for msg in sess.get("messages", []):
            if msg.get("role") != "assistant":
                continue
            for tc in msg.get("tool_calls") or []:
                try:
                    args = json.loads(tc.get("function", {}).get("arguments") or "{}")
                except json.JSONDecodeError:
                    continue
                cmd = args.get("command") or ""
                cmd = re.sub(r"^cd\s+\S+\s+&&\s+", "", cmd)
                vm = re.match(r"mc\s+(\w+)\s*(.*)", cmd)
                if not vm or vm.group(1) not in nav_verbs:
                    continue
                yield {
                    "kind": "nav_attempt",
                    "profile": profile,
                    "session": sess_path.stem,
                    "verb": vm.group(1),
                    "raw_args": vm.group(2)[:140].strip(),
                }


def resolve_run_window(run_id: str) -> tuple[dt.datetime, dt.datetime] | None:
    run_log = RUNS_ROOT / run_id / "run.log"
    if not run_log.is_file():
        return None
    starts = []
    ends = []
    for line in run_log.read_text().splitlines():
        try:
            row = json.loads(line)
            ts = dt.datetime.strptime(row["ts"], "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=dt.timezone.utc
            )
            starts.append(ts)
            ends.append(ts)
        except (json.JSONDecodeError, KeyError):
            continue
    if not starts:
        return None
    # End-of-run signals: latest run.log ts OR snapshot-end if it exists.
    # Pad +12h to catch agent activity after the recorded steps complete.
    return (min(starts), max(ends) + dt.timedelta(hours=12))


# ─── summary writer ────────────────────────────────────────────────────


def write_summary(events: list[dict], out_path: Path, run_id: str) -> None:
    blockages = [e for e in events if e["kind"] == "blockage"]
    marks = [e for e in events if e["kind"] == "mark_save"]
    nav_briefs = [e for e in events if e["kind"] == "nav_brief_shadow"]
    nav_attempts = [e for e in events if e["kind"] == "nav_attempt"]

    by_profile_code = defaultdict(Counter)
    for e in blockages:
        by_profile_code[e["profile"]][e["code"] or "?"] += 1

    # Top-N blockage cells (clustered to integer grid)
    cells = Counter()
    for e in blockages:
        if e.get("from"):
            cells[(e["profile"], int(e["from"]["x"]), int(e["from"]["y"]), int(e["from"]["z"]))] += 1

    with out_path.open("w") as f:
        f.write(f"# Navigation telemetry — {run_id}\n\n")
        f.write(f"_Events: {len(events)} total"
                f" — blockages={len(blockages)}, marks={len(marks)},"
                f" nav_brief_shadow={len(nav_briefs)}, nav_attempts={len(nav_attempts)}_\n\n")

        f.write("## Blockages by profile × code\n\n")
        f.write("| Profile | Code | Count |\n|---|---|---|\n")
        for prof in sorted(by_profile_code):
            for code, n in by_profile_code[prof].most_common(15):
                f.write(f"| {prof} | {code} | {n} |\n")
        f.write("\n")

        f.write("## Hotspot cells (top 12 stall locations)\n\n")
        f.write("| Profile | Cell | Stalls |\n|---|---|---|\n")
        for (prof, x, y, z), n in cells.most_common(12):
            f.write(f"| {prof} | ({x},{y},{z}) | {n} |\n")
        f.write("\n")

        f.write(f"## Marks ({len(marks)} final)\n\n")
        f.write("| Profile | Name | Coord | Visits | Note |\n|---|---|---|---|---|\n")
        for m in sorted(marks, key=lambda e: (e["profile"], e["name"])):
            c = m["coord"]
            note = (m.get("note") or "").replace("|", "\\|")[:50]
            f.write(f"| {m['profile']} | {m['name']} | ({c['x']},{c['y']},{c['z']}) "
                    f"| {m.get('visit_count', 0)} | {note} |\n")
        f.write("\n")

        if nav_briefs:
            f.write("## nav_brief_shadow (SLO calibration)\n\n")
            cms = [b.get("compute_ms", 0) for b in nav_briefs]
            f.write(f"- samples: {len(cms)}\n")
            f.write(f"- compute_ms: min={min(cms)}, mean={sum(cms)/len(cms):.1f}, "
                    f"max={max(cms)} (slo={nav_briefs[0].get('slo_ms')})\n")
            exceeded = [b for b in nav_briefs if b.get("slo_exceeded")]
            f.write(f"- slo_exceeded: {len(exceeded)} ({100*len(exceeded)/len(cms):.1f}%)\n\n")


# ─── live JSONL + compliance ───────────────────────────────────────────


def _live_jsonl_dir() -> Path:
    return Path(os.environ.get("HERMESCRAFT_TMP", "/tmp/hermescraft"))


def read_live_nav_rows() -> list[dict]:
    rows: list[dict] = []
    d = _live_jsonl_dir()
    if not d.is_dir():
        return rows
    for path in sorted(d.glob("nav-*.jsonl")):
        profile = path.stem.replace("nav-", "", 1)
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                row.setdefault("profile", profile)
                rows.append(row)
        except (OSError, json.JSONDecodeError):
            continue
    return rows


def load_registry_phases() -> dict[str, list[dict]]:
    reg_path = REPO_ROOT / "data" / "playbooks" / "registry.yaml"
    if not reg_path.is_file():
        return {}
    try:
        import yaml
    except ImportError:
        return {}
    raw = yaml.safe_load(reg_path.read_text(encoding="utf-8")) or {}
    out: dict[str, list[dict]] = {}
    for entry in raw.get("playbooks") or []:
        if isinstance(entry, dict) and entry.get("id"):
            out[str(entry["id"])] = list(entry.get("phases") or [])
    return out


def compliance_checks(rows: list[dict]) -> dict[str, float]:
    """Three post-checks; returns fractions in 0..1."""
    sync = [r for r in rows if r.get("actionName")]
    if not sync:
        return {"preflight_before_act": 0.0, "whitelist": 0.0, "null_playbook_context": 1.0}
    null_ctx = sum(1 for r in sync if not r.get("playbook_id")) / len(sync)
    phases_by_pb = load_registry_phases()
    whitelist_ok = 0
    whitelist_n = 0
    preflight_ok = 0
    preflight_n = 0
    spans: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in sync:
        pid = r.get("playbook_id")
        ph = r.get("phase")
        if pid and ph:
            spans[(pid, ph)].append(r)
    for (pid, ph), evts in spans.items():
        phase_defs = {p["id"]: p for p in phases_by_pb.get(pid, []) if isinstance(p, dict)}
        pdef = phase_defs.get(ph)
        if not pdef:
            continue
        allowed = set(pdef.get("allowed_verbs") or [])
        preflight = set(pdef.get("preflight_verbs") or [])
        phase_set = {"playbook_phase_set", "playbook_phase_clear"}
        ordered = sorted(evts, key=lambda e: e.get("ts") or "")
        read_hits = [e for e in ordered if e.get("actionName") in preflight]
        act_hits = [
            e
            for e in ordered
            if e.get("actionName")
            and e.get("actionName") not in phase_set
            and e.get("actionName") not in preflight
        ]
        if act_hits:
            preflight_n += 1
            first_act = act_hits[0]
            first_act_ts = first_act.get("ts") or ""
            if not preflight:
                preflight_ok += 1
            elif read_hits and (read_hits[0].get("ts") or "") <= first_act_ts:
                preflight_ok += 1
            elif first_act.get("actionName") in preflight:
                preflight_ok += 1
        for e in evts:
            act = e.get("actionName")
            if not act or act.startswith("playbook_phase"):
                continue
            if allowed:
                whitelist_n += 1
                if act in allowed:
                    whitelist_ok += 1
    return {
        "preflight_before_act": (preflight_ok / preflight_n) if preflight_n else 1.0,
        "whitelist": (whitelist_ok / whitelist_n) if whitelist_n else 1.0,
        "null_playbook_context": null_ctx,
    }


def live_main(args: argparse.Namespace) -> int:
    rows = read_live_nav_rows()
    if args.stdout:
        for r in rows:
            sys.stdout.write(json.dumps(r, sort_keys=True) + "\n")
        return 0
    if args.compliance or args.playbooks:
        by_pb: Counter[str] = Counter()
        for r in rows:
            pid = r.get("playbook_id") or "(null)"
            by_pb[pid] += 1
        print(f"live rows: {len(rows)}", file=sys.stderr)
        if len(rows) == 0:
            print(
                "  (no nav-*.jsonl rows yet — expected before playbook phase set; not an error)",
                file=sys.stderr,
            )
        for pid, n in by_pb.most_common():
            print(f"  {pid}: {n}", file=sys.stderr)
    if args.compliance:
        c = compliance_checks(rows)
        print("compliance:", json.dumps(c, indent=2))
    return 0


def baseline_turns_main(run_id: str) -> int:
    run_dir = RUNS_ROOT / run_id
    findings = run_dir / "findings"
    findings.mkdir(parents=True, exist_ok=True)
    out = findings / "baseline-turns.md"
    text = f"""# Baseline turns — {run_id}

## Genesis aggregate (from postmortem g-2026-05-30-3)

Populate via `scripts/nav-telemetry.py {run_id}` session mining.

## Fixture A1 medians (after 2a-V)

| Arm | median tool calls | median turns |
|---|---|---|
| prose-skilled | TBD | TBD |
| playbook-flat | TBD | TBD |
| playbook+skill ref | TBD | TBD |

Stage 4 A1 % target: **TBD** until fixture section filled.
"""
    out.write_text(text, encoding="utf-8")
    print(f"wrote {out}", file=sys.stderr)
    return 0


# ─── main ──────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("run_id", nargs="?", help="Run id under data/genesis-runs/; default: most recent.")
    ap.add_argument("--stdout", action="store_true", help="Stream JSONL to stdout instead of writing files")
    ap.add_argument("--jsonl-only", action="store_true", help="Skip the markdown summary")
    ap.add_argument("--live", action="store_true", help="Read live nav-*.jsonl from HERMESCRAFT_TMP")
    ap.add_argument("--playbooks", action="store_true", help="With --live: aggregate playbook_id/phase counts")
    ap.add_argument("--compliance", action="store_true", help="With --live: preflight/whitelist/NULL context checks")
    ap.add_argument("--baseline-turns", metavar="RUN_ID", help="Write findings/baseline-turns.md for a genesis run")
    args = ap.parse_args()

    if args.live:
        return live_main(args)
    if args.baseline_turns:
        return baseline_turns_main(args.baseline_turns)

    run_id = args.run_id
    if not run_id:
        runs = [p.name for p in RUNS_ROOT.iterdir() if p.is_dir() and not p.name.startswith(".")]
        if not runs:
            print("no runs found", file=sys.stderr)
            return 1
        run_id = max(runs, key=lambda r: (RUNS_ROOT / r).stat().st_mtime)
    run_dir = RUNS_ROOT / run_id
    if not run_dir.is_dir():
        print(f"unknown run: {run_id}", file=sys.stderr)
        return 1

    window = resolve_run_window(run_id)
    profiles = ("flint", "mason", "steward")

    events: list[dict] = []

    for profile in profiles:
        events.extend(parse_agent_log_errors(
            HERMES_PROFILES / profile / "logs" / "agent.log", profile, window))
        events.extend(parse_locations(
            REPO_ROOT / "data" / f"locations-{profile}.json", profile))
        events.extend(parse_nav_brief_shadow(
            BOT_LOG_DIR / f"bot-{profile}.log", profile))
        events.extend(parse_session_commands(profile, window))

    events.sort(key=lambda e: (e.get("ts") or "0", e.get("profile") or ""))

    if args.stdout:
        for e in events:
            sys.stdout.write(json.dumps(e, sort_keys=True) + "\n")
        return 0

    findings = run_dir / "findings"
    findings.mkdir(parents=True, exist_ok=True)
    jsonl_path = findings / "nav-telemetry.jsonl"
    md_path = findings / "nav-telemetry.md"

    with jsonl_path.open("w") as f:
        for e in events:
            f.write(json.dumps(e, sort_keys=True) + "\n")

    if not args.jsonl_only:
        write_summary(events, md_path, run_id)

    print(f"wrote {len(events)} events → {jsonl_path}", file=sys.stderr)
    if not args.jsonl_only:
        print(f"summary → {md_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
