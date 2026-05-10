#!/usr/bin/env python3
"""
Agent-integration test runner. Drives a Hermes agent through a goal scenario
against the running Flint bot at http://localhost:3001, then evaluates
success predicates against bot state + agent chat output.

Usage:
    scripts/agent-test.py data/agent-tests/P1_mixed_blocks.yaml
    scripts/agent-test.py --model openrouter/google/gemini-flash-latest \
                          --max-turns 6 \
                          data/agent-tests/P1_mixed_blocks.yaml

Spec format (YAML, extends fixture format):
    agent_test_id: P1_mixed_blocks
    world: landfolk-test
    prompt: |
      <natural-language goal given to the agent>
    skills: [minecraft-survival, minecraft-navigation]   # optional preload
    model: openrouter/google/gemini-flash-latest         # optional override
    max_turns: 6                                          # optional, default 8
    timeout_seconds: 120                                  # optional, default 180
    expect:
      agent_chat_contains: ["oak_log", "birch_log"]
      agent_chat_does_not_contain: ["error", "I don't see"]
      bot_at: { x: 0, y: 65, z: 6, range: 2 }
      bot_inventory: { stone_pickaxe: 1, cobblestone: ">=3" }
      world_block_at: [{ x: 0, y: 65, z: 2, block: "oak_door[open=false]" }]
    prep:    [...]   # standard fixture prep
    cleanup: [...]   # standard fixture cleanup

Writes a JSON report to data/agent-tests/runs/<test_id>-<timestamp>.json with:
  - pass/fail/timeout + which predicates passed
  - hermes session id, model, wall time, agent chat output
  - mc command count, ok:false count, loop-signature detection
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
DEFAULT_BOT_URL = "http://localhost:3001"
DEFAULT_MODEL = None  # None = use hermes default
DEFAULT_MAX_TURNS = 8
DEFAULT_TIMEOUT_S = 180


def parse_yaml(path: Path) -> dict:
    """Very small YAML parser using PyYAML if available, else error."""
    try:
        import yaml
    except ImportError:
        print(f"ERROR: PyYAML required. Install: pip install pyyaml", file=sys.stderr)
        sys.exit(2)
    with open(path) as f:
        return yaml.safe_load(f)


def run_rcon(cmd: str) -> str:
    """Run a single rcon command via ssh, return output."""
    full = ["ssh", "ubuntu-host", "sudo", "docker", "exec", "minecraft", "rcon-cli", cmd]
    result = subprocess.run(full, capture_output=True, text=True, timeout=20)
    return result.stdout.strip()


def fixture_run(spec: dict, mode: str) -> None:
    """Run prep or cleanup commands sequentially."""
    cmds = spec.get(mode, [])
    if not cmds:
        return
    for cmd in cmds:
        try:
            run_rcon(cmd)
        except subprocess.TimeoutExpired:
            print(f"  WARN: rcon timeout on: {cmd[:60]}", file=sys.stderr)


def observe(bot_url: str) -> dict:
    """Fetch /observe from bot. Returns parsed JSON or {}."""
    import urllib.request, urllib.error
    try:
        with urllib.request.urlopen(f"{bot_url}/observe", timeout=10) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return {}


def predicate_results(spec: dict, agent_chat: str, end_state: dict) -> list:
    """Evaluate each predicate, return list of {kind, pass, detail}."""
    expect = spec.get("expect", {}) or {}
    results = []
    chat_lower = (agent_chat or "").lower()

    if "agent_chat_contains" in expect:
        for needle in expect["agent_chat_contains"]:
            hit = needle.lower() in chat_lower
            results.append({"kind": f"chat_contains:{needle}", "pass": hit,
                             "detail": "" if hit else f"not in chat"})

    if "agent_chat_does_not_contain" in expect:
        for needle in expect["agent_chat_does_not_contain"]:
            hit = needle.lower() in chat_lower
            results.append({"kind": f"chat_does_not_contain:{needle}", "pass": not hit,
                             "detail": "" if not hit else f"unwanted phrase appeared"})

    if "bot_at" in expect:
        target = expect["bot_at"]
        pos = (end_state.get("state") or {}).get("position") or {}
        if not pos:
            results.append({"kind": "bot_at", "pass": False, "detail": "no bot position"})
        else:
            r = float(target.get("range", 2))
            dx = abs(pos.get("x", 0) - target["x"])
            dy = abs(pos.get("y", 0) - target["y"])
            dz = abs(pos.get("z", 0) - target["z"])
            dist = (dx * dx + dy * dy + dz * dz) ** 0.5
            ok = dist <= r
            results.append({"kind": "bot_at", "pass": ok,
                             "detail": f"pos={pos}, target={target}, dist={dist:.1f}"})

    if "bot_inventory" in expect:
        inv = end_state.get("inventory_summary") or {}
        for item, want in expect["bot_inventory"].items():
            have = inv.get(item, 0)
            if isinstance(want, str) and want.startswith(">="):
                threshold = int(want[2:])
                ok = have >= threshold
                results.append({"kind": f"inv:{item}{want}", "pass": ok,
                                 "detail": f"have={have}"})
            elif isinstance(want, str) and want.startswith(">"):
                threshold = int(want[1:])
                ok = have > threshold
                results.append({"kind": f"inv:{item}{want}", "pass": ok,
                                 "detail": f"have={have}"})
            else:
                threshold = int(want)
                ok = have >= threshold
                results.append({"kind": f"inv:{item}>={threshold}", "pass": ok,
                                 "detail": f"have={have}"})

    if "world_block_at" in expect:
        for probe in expect["world_block_at"]:
            x, y, z = probe["x"], probe["y"], probe["z"]
            block = probe["block"]
            tag = f"chk_{x}_{y}_{z}".replace("-", "n")
            run_rcon(f'execute in landfolk-test if block {x} {y} {z} minecraft:{block} run say MATCH_{tag}')
            time.sleep(1.5)
            obs = observe(DEFAULT_BOT_URL)
            chat = (obs.get("state") or {}).get("new_chat") or []
            hit = any(f"MATCH_{tag}" in (m.get("message") or "") for m in chat)
            results.append({"kind": f"block@{x},{y},{z}=={block}", "pass": hit,
                             "detail": ""})

    return results


def detect_loop_signature(actions: list) -> dict:
    """Look for the same (action, params) repeated 3+ times in a row."""
    if not actions:
        return {"detected": False}
    last_key = None
    streak = 0
    max_streak = 0
    worst_key = None
    for a in actions:
        # action key: action name + first ~40 chars of detail (rough)
        key = (a.get("action", "?"), (a.get("detail") or "")[:40])
        if key == last_key:
            streak += 1
            if streak > max_streak:
                max_streak = streak
                worst_key = key
        else:
            streak = 1
            last_key = key
    return {"detected": max_streak >= 3, "max_streak": max_streak, "worst": worst_key}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("spec", help="path to agent-test YAML")
    p.add_argument("--model", help="override model (e.g. openrouter/google/gemini-flash-latest)")
    p.add_argument("--max-turns", type=int, help="override max_turns")
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    args = p.parse_args()

    spec_path = Path(args.spec)
    if not spec_path.exists():
        print(f"ERROR: spec not found: {spec_path}", file=sys.stderr)
        sys.exit(2)

    spec = parse_yaml(spec_path)
    test_id = spec.get("agent_test_id") or spec_path.stem
    timeout_s = int(spec.get("timeout_seconds", DEFAULT_TIMEOUT_S))
    max_turns = args.max_turns or int(spec.get("max_turns", DEFAULT_MAX_TURNS))
    model = args.model or spec.get("model") or DEFAULT_MODEL
    skills = spec.get("skills") or []

    print(f"=== {test_id} ===")
    print(f"  model: {model or '(hermes default)'}")
    print(f"  max-turns: {max_turns}  timeout: {timeout_s}s")
    if skills:
        print(f"  skills: {','.join(skills)}")

    print(f"  prep...", end="", flush=True)
    fixture_run(spec, "prep")
    print(" ok")

    pre = observe(args.bot_url)
    pre_actions = ((pre.get("state") or {}).get("recent_actions") or [])
    pre_count = len(pre_actions)
    pre_pos = (pre.get("state") or {}).get("position") or {}
    pre_inv = pre.get("inventory_summary") or {}

    prompt = spec.get("prompt", "").strip()
    if not prompt:
        print("ERROR: spec.prompt is empty", file=sys.stderr)
        sys.exit(2)

    cmd = ["hermes", "chat", "--yolo", "-Q", "-q", prompt,
            "--max-turns", str(max_turns)]
    if model:
        cmd.extend(["-m", model])
    if skills:
        cmd.extend(["-s", ",".join(skills)])

    env = os.environ.copy()
    env["MC_API_URL"] = args.bot_url
    env["MC_USERNAME"] = "Flint"

    print(f"  launching hermes...")
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout_s, env=env)
        agent_stdout = proc.stdout
        agent_stderr = proc.stderr
        hermes_status = "ok" if proc.returncode == 0 else f"exit_{proc.returncode}"
        timed_out = False
    except subprocess.TimeoutExpired as e:
        agent_stdout = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        agent_stderr = (e.stderr or b"").decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
        hermes_status = "timeout"
        timed_out = True

    wall_s = time.time() - t0
    print(f"  hermes finished in {wall_s:.0f}s ({hermes_status})")

    post = observe(args.bot_url)
    post_actions = ((post.get("state") or {}).get("recent_actions") or [])
    new_actions = post_actions[: max(0, len(post_actions) - pre_count)] if len(post_actions) >= pre_count else post_actions
    ok_false_count = sum(1 for a in new_actions if a.get("status") == "error")
    loop_sig = detect_loop_signature(new_actions)
    # mc_cli_calls is now computed below from session JSON (more reliable).

    # extract session id from hermes output — typically in stderr with -Q
    session_id = None
    for source in (agent_stderr, agent_stdout):
        for line in (source or "").splitlines():
            m = re.search(r"session_id:\s*(\S+)", line)
            if m:
                session_id = m.group(1)
                break
        if session_id:
            break

    # Read the session JSON to get the real tool-call sequence and counts.
    # -Q suppresses tool traces in stdout, so this is the only reliable source.
    tool_calls = []
    if session_id:
        sess_path = Path.home() / ".hermes" / "sessions" / f"session_{session_id}.json"
        if sess_path.exists():
            try:
                sess = json.loads(sess_path.read_text())
                for msg in sess.get("messages", []):
                    for tc in (msg.get("tool_calls") or []):
                        fn = tc.get("function", {}) or {}
                        try:
                            args = json.loads(fn.get("arguments") or "{}")
                        except Exception:
                            args = {"_raw": fn.get("arguments")}
                        tool_calls.append({"name": fn.get("name"), "args": args})
            except Exception as e:
                print(f"  WARN: could not read session {sess_path}: {e}", file=sys.stderr)

    # Extract individual `mc <verb>` invocations from terminal tool commands.
    mc_verbs_used = []
    for tc in tool_calls:
        if tc.get("name") == "terminal":
            cmd = (tc.get("args") or {}).get("command") or ""
            for m in re.finditer(r"\bmc\s+([a-z_]+)\b", cmd):
                mc_verbs_used.append(m.group(1))
    mc_cli_calls = len(mc_verbs_used)
    verb_counts = {}
    for v in mc_verbs_used:
        verb_counts[v] = verb_counts.get(v, 0) + 1

    preds = predicate_results(spec, agent_stdout, post)
    all_pass = all(r["pass"] for r in preds) if preds else False
    verdict = "PASS" if all_pass and not timed_out else ("TIMEOUT" if timed_out else "FAIL")

    report = {
        "test_id": test_id,
        "verdict": verdict,
        "timed_out": timed_out,
        "wall_seconds": round(wall_s, 1),
        "model": model,
        "max_turns": max_turns,
        "hermes_session_id": session_id,
        "hermes_status": hermes_status,
        "predicates": preds,
        "metrics": {
            "action_mutating_calls": len(new_actions),
            "mc_cli_invocations": mc_cli_calls,
            "mc_verb_counts": verb_counts,
            "tool_call_count": len(tool_calls),
            "ok_false_count": ok_false_count,
            "loop_signature": loop_sig,
        },
        "tool_calls": tool_calls,
        "pre": {"position": pre_pos, "inventory": pre_inv},
        "post": {
            "position": (post.get("state") or {}).get("position"),
            "inventory": post.get("inventory_summary"),
        },
        "agent_chat": agent_stdout,
        "agent_stderr": agent_stderr[-2000:] if agent_stderr else "",
        "new_actions": new_actions,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    fixture_run(spec, "cleanup")

    stamp = report["timestamp"].replace(":", "-").replace(".", "-")
    out_path = ROOT / "data" / "agent-tests" / "runs" / f"{test_id}-{stamp}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    verb_summary = ", ".join(f"{k}×{v}" for k, v in sorted(verb_counts.items(), key=lambda kv: -kv[1])[:5]) or "(none)"
    print(f"  {verdict}  {mc_cli_calls} mc/cli ({verb_summary}), {ok_false_count} ok:false, loop={loop_sig.get('max_streak', 0)}")
    for r in preds:
        flag = "✓" if r["pass"] else "✗"
        print(f"    {flag} {r['kind']}" + (f" — {r['detail']}" if r['detail'] else ""))
    print(f"  report: {out_path}")
    sys.exit(0 if verdict == "PASS" else 1)


if __name__ == "__main__":
    main()
