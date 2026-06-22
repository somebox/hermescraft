from __future__ import annotations

import importlib.util
from pathlib import Path

from scripts.lib.action_log_metrics import load_jsonl_entries, summarize_scoped_run
from scripts.lib.mc_registry_verbs import core_verbs

REPO = Path(__file__).resolve().parents[3]


def _detect_loop(entries: list[dict]) -> dict:
    spec = importlib.util.spec_from_file_location("agent_test", REPO / "scripts" / "agent-test.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod.detect_loop_signature(entries)


def extract_motor(artifact_dir: Path) -> dict:
    base = summarize_scoped_run(artifact_dir)
    per = base.get("per_verb") or {}
    verbs = []
    for name, slot in sorted(per.items(), key=lambda x: -x[1].get("calls", 0)):
        calls = slot.get("calls") or 0
        errs = slot.get("errors") or 0
        to = slot.get("timeouts") or 0
        slow = slot.get("slow") or 0
        verbs.append(
            {
                "verb": name,
                "calls": calls,
                "errors": errs,
                "timeouts": to,
                "slow": slow,
                "error_rate": round(errs / calls, 3) if calls else 0,
            }
        )
    hotspots = sorted(
        verbs,
        key=lambda v: v["errors"] + 2 * v["timeouts"] + 0.5 * v["slow"],
        reverse=True,
    )[:10]
    used = {v["verb"] for v in verbs if v["calls"] > 0}
    never = [v for v in core_verbs() if v not in used]
    server_down = 0
    goalchanged = 0
    entries = load_jsonl_entries(artifact_dir)
    for e in entries:
        det = str(e.get("detail") or "")
        if "503" in det:
            server_down += 1
        if "GoalChanged" in det or "goal changed" in det.lower():
            goalchanged += 1
    loop = _detect_loop(entries)
    repeated = []
    if loop.get("detected") and loop.get("worst"):
        act, frag = loop["worst"]
        repeated.append({"action": act, "detail_prefix": frag, "streak": loop.get("max_streak")})
    return {
        "errors": base.get("errors"),
        "timeouts": base.get("timeouts"),
        "slow": base.get("slow"),
        "verbs": verbs,
        "hotspots": hotspots[:5],
        "never_used_core": never[:20],
        "server_down": server_down,
        "goalchanged": goalchanged,
        "repeated_calls": repeated,
    }
