#!/usr/bin/env python3
"""Extract example stuck-bot scenarios with surrounding context from a run.

A "stuck cluster" is 4+ tool errors within 5 minutes whose error coords
or messages cluster within ~12 blocks. For each cluster, capture:

  - the agent reasoning (assistant message content + reasoning_content)
  - tool calls (commands) issued during the cluster
  - tool results (error envelopes)
  - whether nav-brief context (Surface at / nav_brief_text / ← suggested)
    appeared in any of the preceding tool results
  - how the cluster resolved (success → moved away, or session timed out)

Each scenario is written as a markdown file under
  data/genesis-runs/<run>/findings/stuck-scenarios/<profile>-<seq>.md
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "data" / "genesis-runs"

PROFILE_DIRS = {
    "flint":   Path.home() / ".hermes/profiles/flint/sessions",
    "mason":   Path.home() / ".hermes/profiles/mason/sessions",
    "steward": Path.home() / ".hermes-landfolk-steward/sessions",
}

NAV_BRIEF_PATTERNS = (
    "Surface at", "Underground at", "Pit at", "Tunnel at",
    "nav_brief_text", "← suggested", "journey:",
    "⚠ blocked (confined)", "⚠ PARTIAL_BRIEF", "⚠ STALE_BRIEF",
    "⚠ brief_refresh_required",
)

# Stuck-cluster tuning
CLUSTER_MIN_ERRORS = 4
CLUSTER_WINDOW_SEC = 300
CLUSTER_RADIUS_BLOCKS = 12
CTX_BEFORE = 5
CTX_AFTER = 5

ERR_POS_RE = re.compile(r"Pos:(?P<x>-?[\d.]+),(?P<y>-?[\d.]+),(?P<z>-?[\d.]+)")
ERR_TARGET_RE = re.compile(r"to (?P<x>-?\d+),\s*(?P<y>-?\d+),\s*(?P<z>-?\d+)")
ERR_VERB_RE = re.compile(r"ERROR \[(?P<verb>[a-z_]+)\]")
ERR_CODE_RE = re.compile(r"code=(?P<code>[A-Z_]+)")


def parse_session_timeline(path: Path) -> list[dict]:
    """Return a chronological list of {role, ts, content, tool_calls, tool_call_id}."""
    try:
        sess = json.load(open(path))
    except Exception:
        return []
    msgs = sess.get("messages", [])
    # Sessions don't carry per-message timestamps reliably; we approximate
    # by the session's last_updated proportionally — good enough for
    # detecting clusters within a session.
    return msgs


def extract_cmd(tc: dict) -> str:
    try:
        cmd = json.loads(tc["function"]["arguments"]).get("command", "")
        return re.sub(r"^cd\s+\S+\s+&&\s+", "", cmd).strip()
    except Exception:
        return ""


def is_error_result(content: str) -> bool:
    if not isinstance(content, str):
        return False
    head = content[:120]
    return "ERROR" in head or '"ok":false' in head or "[Command timed out" in head


def extract_pos(content: str) -> tuple[int, int, int] | None:
    m = ERR_POS_RE.search(content)
    if not m:
        return None
    return (int(float(m.group("x"))), int(float(m.group("y"))), int(float(m.group("z"))))


def has_nav_brief(content: str) -> list[str]:
    found = []
    for p in NAV_BRIEF_PATTERNS:
        if p in content:
            found.append(p)
    return found


def build_index(msgs: list[dict]) -> list[dict]:
    """Pair tool_calls with their results.  Output: list of step dicts in
    chronological order, each with {idx, role, content, reasoning,
    tool_call_id, cmd, error_pos, nav_brief_hits, is_error}.
    """
    steps = []
    pending_tc_by_id: dict[str, dict] = {}
    for i, m in enumerate(msgs):
        if m.get("role") == "assistant":
            content = (m.get("content") or "").strip()
            reasoning = (m.get("reasoning_content") or m.get("reasoning") or "").strip()
            for tc in m.get("tool_calls") or []:
                cmd = extract_cmd(tc)
                step = {
                    "idx": i,
                    "role": "tool_call",
                    "reasoning": reasoning,
                    "preface": content,
                    "tool_call_id": tc.get("id"),
                    "cmd": cmd,
                    "verb": (re.match(r"mc\s+(\w+)", cmd) or [None]).group(1) if re.match(r"mc\s+(\w+)", cmd) else None,
                }
                pending_tc_by_id[tc.get("id")] = step
                steps.append(step)
        elif m.get("role") == "tool":
            tcid = m.get("tool_call_id")
            content = m.get("content") or ""
            is_err = is_error_result(content)
            pos = extract_pos(content)
            brief = has_nav_brief(content)
            step = {
                "idx": i,
                "role": "tool_result",
                "tool_call_id": tcid,
                "content_excerpt": content[:280].replace("\n", " "),
                "is_error": is_err,
                "error_pos": pos,
                "nav_brief_hits": brief,
            }
            # Link back to the tool_call for verb/cmd
            if tcid in pending_tc_by_id:
                step["verb"] = pending_tc_by_id[tcid].get("verb")
                step["cmd"] = pending_tc_by_id[tcid].get("cmd")
            steps.append(step)
    return steps


def find_clusters(steps: list[dict]) -> list[tuple[int, int]]:
    """Find contiguous runs of error tool_results whose positions cluster
    within CLUSTER_RADIUS_BLOCKS. Returns list of (start_step_idx, end_step_idx)."""
    # Walk through tool_results, identifying error chains.
    clusters = []
    i = 0
    while i < len(steps):
        if steps[i]["role"] != "tool_result" or not steps[i].get("is_error"):
            i += 1
            continue
        # Start a candidate cluster from i
        start = i
        positions = []
        if steps[i].get("error_pos"):
            positions.append(steps[i]["error_pos"])
        j = i + 1
        last_err = i
        while j < len(steps):
            s = steps[j]
            if s["role"] == "tool_result":
                if s.get("is_error"):
                    pos = s.get("error_pos")
                    if pos and positions:
                        ax, ay, az = positions[0]
                        if max(abs(pos[0] - ax), abs(pos[1] - ay), abs(pos[2] - az)) > CLUSTER_RADIUS_BLOCKS:
                            # Different area — break the cluster
                            break
                    if pos:
                        positions.append(pos)
                    last_err = j
                else:
                    # Successful tool result — cluster ends
                    break
            j += 1
        # Count actual errors in [start..last_err]
        err_count = sum(1 for k in range(start, last_err + 1)
                        if steps[k]["role"] == "tool_result" and steps[k].get("is_error"))
        if err_count >= CLUSTER_MIN_ERRORS:
            clusters.append((start, last_err))
            i = last_err + 1
        else:
            i = start + 1
    return clusters


def render_scenario(profile: str, session_id: str, steps: list[dict], cluster: tuple[int, int], seq: int) -> str:
    s_start, s_end = cluster
    err_count = sum(1 for k in range(s_start, s_end + 1)
                    if steps[k]["role"] == "tool_result" and steps[k].get("is_error"))
    # Position range
    posns = [steps[k]["error_pos"] for k in range(s_start, s_end + 1)
             if steps[k].get("error_pos")]
    pos_summary = "?"
    if posns:
        xs, ys, zs = zip(*posns)
        pos_summary = f"({min(xs)}..{max(xs)}, {min(ys)}..{max(ys)}, {min(zs)}..{max(zs)})"

    # Did nav-brief context appear in any tool result in the lead-in?
    lead_start = max(0, s_start - CTX_BEFORE * 2)
    brief_hits_before = []
    for k in range(lead_start, s_start):
        if steps[k]["role"] == "tool_result" and steps[k].get("nav_brief_hits"):
            brief_hits_before.append((k, steps[k]["verb"], steps[k]["nav_brief_hits"]))

    # Verb mix during the cluster
    from collections import Counter
    verb_counter = Counter()
    code_counter = Counter()
    for k in range(s_start, s_end + 1):
        if steps[k]["role"] == "tool_result":
            v = steps[k].get("verb")
            if v:
                verb_counter[v] += 1
            cm = ERR_CODE_RE.search(steps[k].get("content_excerpt", "") or "")
            if cm:
                code_counter[cm.group(1)] += 1

    out = []
    out.append(f"# Stuck scenario {seq}: {profile}\n")
    out.append(f"_Session: `{session_id}`_  ·  steps {s_start}–{s_end}  ·  **{err_count} errors** in cluster\n")
    out.append(f"_Position range: {pos_summary}_\n")
    if verb_counter:
        out.append(f"_Failing verbs: {dict(verb_counter.most_common())}_\n")
    if code_counter:
        out.append(f"_Error codes: {dict(code_counter.most_common())}_\n")
    out.append("")

    out.append("## Did nav-brief context appear in the lead-in?")
    if not brief_hits_before:
        out.append("\n**No** — none of the tool results in the 10 steps before this cluster carried nav-brief context (Surface at / nav_brief_text / ← suggested / journey).\n")
    else:
        out.append(f"\n**Yes** — {len(brief_hits_before)} tool results in the lead-in carried nav-brief markers:\n")
        for step_idx, verb, hits in brief_hits_before:
            out.append(f"- step {step_idx} (`mc {verb}`): {', '.join(hits)}")
        out.append("")

    out.append("## Lead-in (last 5 steps before stuck)")
    out.append("")
    lead_range = range(max(0, s_start - CTX_BEFORE * 2), s_start)
    rendered = 0
    for k in reversed(list(lead_range)):
        s = steps[k]
        if s["role"] == "tool_call":
            out.append(f"- **call** `{s.get('cmd', '?')[:90]}`")
            rendered += 1
        elif s["role"] == "tool_result":
            tag = "❌" if s.get("is_error") else "✅"
            brief = " 🧭" if s.get("nav_brief_hits") else ""
            out.append(f"- {tag} result{brief}: `{s.get('content_excerpt', '')[:140].strip()}`")
        if rendered >= CTX_BEFORE:
            break
    out.append("")

    out.append("## The stuck cluster")
    out.append("")
    for k in range(s_start, s_end + 1):
        s = steps[k]
        if s["role"] == "tool_call":
            if s.get("preface"):
                out.append(f"> {s['preface'][:300]}")
            if s.get("reasoning"):
                out.append(f"_reasoning:_ {s['reasoning'][:300]}")
            out.append(f"- **call** `{s.get('cmd', '?')[:120]}`")
        else:
            tag = "❌" if s.get("is_error") else "✅"
            brief = " 🧭" if s.get("nav_brief_hits") else ""
            out.append(f"- {tag} result{brief}: `{s.get('content_excerpt', '')[:200].strip()}`")
    out.append("")

    out.append("## Resolution (next 5 steps)")
    out.append("")
    after_range = range(s_end + 1, min(len(steps), s_end + 1 + CTX_AFTER * 2))
    shown = 0
    for k in after_range:
        s = steps[k]
        if s["role"] == "tool_call":
            out.append(f"- **call** `{s.get('cmd', '?')[:90]}`")
        elif s["role"] == "tool_result":
            tag = "❌" if s.get("is_error") else "✅"
            brief = " 🧭" if s.get("nav_brief_hits") else ""
            out.append(f"- {tag} result{brief}: `{s.get('content_excerpt', '')[:140].strip()}`")
        shown += 1
        if shown >= CTX_AFTER * 2:
            break
    if not after_range:
        out.append("_(end of session — never resolved within this conversation turn)_")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("run_id", nargs="?", help="Run id under data/genesis-runs/")
    ap.add_argument("--limit", type=int, default=3, help="Max scenarios per profile")
    args = ap.parse_args()

    run_id = args.run_id
    if not run_id:
        runs = [p.name for p in RUNS_ROOT.iterdir() if p.is_dir() and not p.name.startswith(".")]
        run_id = max(runs, key=lambda r: (RUNS_ROOT / r).stat().st_mtime)

    out_dir = RUNS_ROOT / run_id / "findings" / "stuck-scenarios"
    out_dir.mkdir(parents=True, exist_ok=True)

    summary_lines = [f"# Stuck-bot scenarios — {run_id}\n"]
    total = 0
    for profile, sess_dir in PROFILE_DIRS.items():
        paths = sorted([p for p in sess_dir.glob("session_2026*.json")
                        if p.name >= "session_20260530_165"])
        scenarios = []
        for path in paths:
            msgs = parse_session_timeline(path)
            if not msgs:
                continue
            steps = build_index(msgs)
            clusters = find_clusters(steps)
            for c in clusters:
                err_count = sum(1 for k in range(c[0], c[1] + 1)
                                if steps[k]["role"] == "tool_result" and steps[k].get("is_error"))
                scenarios.append((path.stem, steps, c, err_count))
        # Pick the largest N by error count
        scenarios.sort(key=lambda x: -x[3])
        scenarios = scenarios[:args.limit]
        summary_lines.append(f"## {profile} — {len(scenarios)} scenario(s)\n")
        for i, (session_id, steps, cluster, err_count) in enumerate(scenarios, 1):
            seq = f"{profile}-{i:02d}"
            text = render_scenario(profile, session_id, steps, cluster, i)
            md_path = out_dir / f"{seq}.md"
            md_path.write_text(text)
            summary_lines.append(f"- [{seq}.md](stuck-scenarios/{seq}.md) — {err_count} errors")
            total += 1
        summary_lines.append("")
    (RUNS_ROOT / run_id / "findings" / "stuck-scenarios.md").write_text("\n".join(summary_lines))
    print(f"wrote {total} scenarios → {out_dir}/", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
