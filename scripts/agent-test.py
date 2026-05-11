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
DEFAULT_MODEL = "google/gemini-2.5-flash"  # baseline for terminal-tool agent tests.
# 2026-05 model findings (agent-test context, not direct-API/benchmark):
#   - google/gemini-2.5-flash       — reliable, fast, ~6 mc calls/composite test
#   - openai/gpt-4o-mini            — confuses mc CLI for memory/search_files
#                                     even with explicit prompt; better for
#                                     benchmark-style direct-response tests
#   - google/gemini-2.5-flash-lite  — refuses ~50% of tasks claiming no MC tools
#   - meta-llama/llama-3.1-8b-instruct — comparable to gemini-2.5-flash-lite,
#                                     useful for cheap regression runs
#   - deepseek/deepseek-v4-flash    — works but 2-3x slower than gemini-2.5-flash
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
    """Run a single rcon command via ssh+stdin. Stdin avoids docker's CLI
    parser interpreting leading dashes (e.g. -2 coordinates) as flags."""
    full = ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"]
    result = subprocess.run(full, input=cmd + "\n", capture_output=True, text=True, timeout=20)
    return result.stdout.strip()


def run_rcon_batch(cmds: list[str]) -> str:
    """Run many rcon commands via a single ssh+rcon-cli invocation.
    Drastically faster than per-command (one TCP/ssh round-trip vs N).
    Returns combined stdout."""
    if not cmds:
        return ""
    # rcon-cli accepts multiple commands via stdin, one per line.
    batch = "\n".join(cmds) + "\n"
    full = ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"]
    result = subprocess.run(full, input=batch, capture_output=True, text=True, timeout=60)
    return result.stdout


def fixture_run(spec: dict, mode: str) -> str:
    """Run prep or cleanup commands as a batched rcon call. Returns combined output."""
    cmds = spec.get(mode, [])
    if not cmds:
        return ""
    try:
        return run_rcon_batch(cmds)
    except subprocess.TimeoutExpired:
        print(f"  WARN: rcon batch timeout in {mode}", file=sys.stderr)
        return ""


def observe(bot_url: str) -> dict:
    """Fetch /observe from bot. Returns parsed JSON or {}."""
    import urllib.request, urllib.error
    try:
        with urllib.request.urlopen(f"{bot_url}/observe", timeout=10) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return {}


def predicate_results(spec: dict, agent_chat: str, end_state: dict,
                       mc_verbs: list = None) -> list:
    """Evaluate each predicate, return list of {kind, pass, detail}."""
    expect = spec.get("expect", {}) or {}
    results = []
    mc_verbs = mc_verbs or []
    chat_lower = (agent_chat or "").lower()

    if "agent_chat_contains" in expect:
        for needle in expect["agent_chat_contains"]:
            hit = needle.lower() in chat_lower
            results.append({"kind": f"chat_contains:{needle}", "pass": hit,
                             "detail": "" if hit else f"not in chat"})

    if "agent_chat_contains_any" in expect:
        needles = expect["agent_chat_contains_any"]
        hits = [n for n in needles if n.lower() in chat_lower]
        ok = len(hits) > 0
        detail = (",".join(hits) + " found") if hits else f"none of {len(needles)} phrases in chat"
        results.append({"kind": f"chat_contains_any:{len(needles)}_phrases",
                         "pass": ok, "detail": detail})

    if "agent_chat_does_not_contain" in expect:
        for needle in expect["agent_chat_does_not_contain"]:
            hit = needle.lower() in chat_lower
            results.append({"kind": f"chat_does_not_contain:{needle}", "pass": not hit,
                             "detail": "" if not hit else f"unwanted phrase appeared"})

    if "bot_y_at_least" in expect:
        ymin = float(expect["bot_y_at_least"])
        pos = (end_state.get("state") or {}).get("position") or {}
        ok = pos and pos.get("y", -1) >= ymin
        results.append({"kind": f"bot_y>={ymin}", "pass": bool(ok),
                         "detail": f"y={pos.get('y') if pos else 'none'}"})

    if "bot_hp_at_least" in expect:
        hpmin = float(expect["bot_hp_at_least"])
        st = end_state.get("state") or {}
        hp = st.get("health")
        ok = hp is not None and hp >= hpmin
        results.append({"kind": f"bot_hp>={hpmin}", "pass": bool(ok),
                         "detail": f"hp={hp if hp is not None else 'none'}"})

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

    def _inv_check(item, want, inv):
        have = inv.get(item, 0)
        if isinstance(want, str) and want.startswith(">="):
            threshold = int(want[2:])
            return have >= threshold, have, threshold, f"{item}>={threshold}"
        if isinstance(want, str) and want.startswith(">"):
            threshold = int(want[1:])
            return have > threshold, have, threshold, f"{item}>{threshold}"
        threshold = int(want)
        return have >= threshold, have, threshold, f"{item}>={threshold}"

    if "bot_inventory" in expect:
        inv = end_state.get("inventory_summary") or {}
        for item, want in expect["bot_inventory"].items():
            ok, have, _, label = _inv_check(item, want, inv)
            results.append({"kind": f"inv:{label}", "pass": ok, "detail": f"have={have}"})

    if "bot_inventory_excludes" in expect:
        # Items the bot should NOT have at end. Each item/threshold defines
        # the failure boundary: predicate fails if bot has >= that count.
        inv = end_state.get("inventory_summary") or {}
        offenders = []
        for item, want in expect["bot_inventory_excludes"].items():
            ok, have, threshold, _ = _inv_check(item, want, inv)
            if ok:
                offenders.append(f"{item}={have}>={threshold}")
        any_offender = len(offenders) > 0
        results.append({"kind": "inv_excludes",
                         "pass": not any_offender,
                         "detail": ("had: " + "; ".join(offenders)) if offenders else "clean"})

    if "bot_inventory_any" in expect:
        # Passes if ANY listed item meets its threshold. Useful for tests
        # like "has SOME working axe" without prescribing the tier.
        inv = end_state.get("inventory_summary") or {}
        items = expect["bot_inventory_any"]
        passes = []
        for item, want in items.items():
            ok, have, _, label = _inv_check(item, want, inv)
            if ok:
                passes.append(f"{item}={have}")
        any_pass = len(passes) > 0
        def _lbl(k, v):
            if isinstance(v, str) and (v.startswith(">=") or v.startswith(">")):
                return f"{k}{v}"
            return f"{k}>={v}"
        label = " | ".join(_lbl(k, v) for k, v in items.items())
        detail = ("; ".join(passes)) if passes else "none of: " + ", ".join(items.keys())
        results.append({"kind": f"inv_any:{label}", "pass": any_pass, "detail": detail})

    if "mc_cli_invocations_max" in expect:
        cap = int(expect["mc_cli_invocations_max"])
        have = len(mc_verbs)
        ok = have <= cap
        results.append({"kind": f"mc_cli_invocations<={cap}", "pass": ok,
                         "detail": f"used {have}"})

    if "mc_verbs_include_any" in expect:
        wanted = expect["mc_verbs_include_any"]
        hits = [v for v in wanted if v in mc_verbs]
        ok = len(hits) > 0
        label = "|".join(wanted)
        detail = (",".join(hits) + " used") if hits else f"none of: {','.join(wanted)} in {mc_verbs}"
        results.append({"kind": f"mc_verbs_include_any:{label}", "pass": ok, "detail": detail})

    if "world_no_entity_of_type" in expect:
        # Pass when no entity of the given type exists in the test world.
        # Uses rcon stdout: a `data get entity` selector prints entity NBT on
        # match, or "No entity was found" when nothing matches. Read-only.
        for ent_type in (expect["world_no_entity_of_type"] or []):
            out = run_rcon(f'execute in landfolk-test run data get entity @e[type={ent_type},limit=1]')
            absent = "No entity was found" in (out or "")
            results.append({"kind": f"no_entity:{ent_type}", "pass": absent,
                             "detail": "" if absent else out.strip()[:60]})

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

    # Pre-prep: tp Flint to safe-home AND run the spec's cleanup commands
    # so leftover state from a prior interrupted test can't leak in. Then
    # run prep. All three steps go through the batched rcon path so the
    # arena flickers for a fraction of a second instead of ~10s.
    stage_times = {}
    overall_t0 = time.time()

    print(f"  pre-prep tp + clean...", end="", flush=True)
    _t = time.time()
    pre_cmds = ["execute in landfolk-test run tp Flint 52 65 52"]
    pre_cmds.extend(spec.get("cleanup") or [])
    run_rcon_batch(pre_cmds)
    time.sleep(0.5)
    stage_times["pre_prep"] = time.time() - _t
    print(f" ok ({stage_times['pre_prep']:.1f}s)")

    print(f"  prep...", end="", flush=True)
    _t = time.time()
    fixture_run(spec, "prep")
    stage_times["prep"] = time.time() - _t
    print(f" ok ({stage_times['prep']:.1f}s)")

    # Settle: let mineflayer's block cache ingest the rcon changes. 6s is
    # needed when the agent will read/write blocks that an external rcon
    # `fill` just modified — chunk update packets can lag 3-4s under load.
    settle_s = int(spec.get("settle_seconds", 6))
    print(f"  settle ({settle_s}s)...", end="", flush=True)
    _t = time.time()
    time.sleep(settle_s)
    stage_times["settle"] = time.time() - _t
    print(f" ok ({stage_times['settle']:.1f}s)")

    # Verify prep: query bot's perception and check counts match spec.
    # Spec uses `verify_after_prep` as a list of { block, min_count } items.
    # Failures abort the test (no point launching hermes against a broken arena).
    verify_items = spec.get("verify_after_prep") or []
    if verify_items:
        nearby = observe(args.bot_url)
        # /observe doesn't include block counts; use /nearby separately
        import urllib.request
        try:
            with urllib.request.urlopen(f"{args.bot_url}/nearby?radius=16", timeout=10) as resp:
                near = json.loads(resp.read().decode())
        except Exception as e:
            print(f"  VERIFY: nearby query failed: {e}")
            near = {"data": {"blocks": []}}
        block_counts = {b["name"]: b["count"] for b in (near.get("data") or {}).get("blocks", [])}
        print(f"  verify_after_prep:")
        fail = False
        for item in verify_items:
            name = item["block"]
            want = int(item.get("min_count", 1))
            have = block_counts.get(name, 0)
            ok = have >= want
            flag = "✓" if ok else "✗"
            print(f"    {flag} {name} ≥ {want}  (have {have})")
            if not ok:
                fail = True
        if fail:
            print(f"  ABORT: prep verification failed — world not in expected state")
            fixture_run(spec, "cleanup")
            sys.exit(3)

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

    _t = time.time()
    stage_times["verify"] = _t - (overall_t0 + sum(stage_times.values()))
    # Stall watchdog kills hermes if its session file stops growing for this
    # long — catches "agent loops on a 60s-timeout mc call" without waiting
    # out the full spec timeout. Each tool call appends to the session file,
    # so mtime growth is a reliable progress signal. Threshold must exceed
    # hermes' own per-tool timeout (60s) so a single slow tool doesn't trip.
    stall_seconds = int(spec.get("stall_seconds", 75))
    print(f"  launching hermes... (timeout={timeout_s}s, stall_kill={stall_seconds}s)")
    t0 = time.time()
    agent_stdout = ""
    agent_stderr = ""
    hermes_status = "unknown"
    timed_out = False
    stalled = False
    sessions_dir = Path.home() / ".hermes" / "sessions"
    pre_session_files = set(sessions_dir.glob("session_*.json")) if sessions_dir.exists() else set()
    proc = None
    my_session = None
    # message_timeline records (t_since_launch, msg_count, role) each time
    # the session file grows. Used to break down hermes wall time into
    # per-step latencies after the run.
    message_timeline = []
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, env=env)
        last_mtime = None
        last_growth = time.time()
        last_msg_count = 0
        while True:
            try:
                proc.wait(timeout=1.0)
                break
            except subprocess.TimeoutExpired:
                pass
            elapsed = time.time() - t0
            if elapsed > timeout_s:
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: proc.kill()
                hermes_status = "timeout"
                timed_out = True
                break
            # Identify our session file: newest *.json that wasn't there at start.
            if my_session is None and sessions_dir.exists():
                now_files = set(sessions_dir.glob("session_*.json"))
                new_files = now_files - pre_session_files
                if new_files:
                    my_session = max(new_files, key=lambda p: p.stat().st_mtime)
            if my_session and my_session.exists():
                mt = my_session.stat().st_mtime
                if last_mtime is None or mt > last_mtime:
                    last_mtime = mt
                    last_growth = time.time()
                    # Sample message count for timeline (cheap; only on growth).
                    try:
                        sess_data = json.loads(my_session.read_text())
                        msgs = sess_data.get("messages", [])
                        if len(msgs) > last_msg_count:
                            for m in msgs[last_msg_count:]:
                                message_timeline.append((round(elapsed, 1), len(message_timeline) + 1, m.get("role", "?")))
                            last_msg_count = len(msgs)
                    except Exception:
                        pass
                elif time.time() - last_growth > stall_seconds:
                    proc.terminate()
                    try: proc.wait(timeout=5)
                    except subprocess.TimeoutExpired: proc.kill()
                    hermes_status = "stalled"
                    stalled = True
                    print(f"  stall-watchdog: no session-file growth in {stall_seconds}s — killed hermes")
                    break
        agent_stdout, agent_stderr = proc.communicate()
        if not timed_out and not stalled:
            hermes_status = "ok" if proc.returncode == 0 else f"exit_{proc.returncode}"
    except KeyboardInterrupt:
        if proc:
            proc.terminate()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: proc.kill()
        hermes_status = "interrupted"
        print("\n  interrupted — running cleanup before exit")
        fixture_run(spec, "cleanup")
        sys.exit(130)

    wall_s = time.time() - t0
    stage_times["hermes"] = wall_s
    print(f"  hermes finished in {wall_s:.0f}s ({hermes_status})")

    # Break the hermes wall time into model-think vs tool-exec phases by
    # looking at inter-message latencies. Convention in hermes session log:
    # role=assistant ← model output (preceded by think-time); role=tool ←
    # tool result (preceded by tool-exec time). Edge: first assistant msg
    # latency includes hermes startup (Python import + plugin load).
    role_secs = {"think": 0.0, "tool_exec": 0.0, "other": 0.0}
    role_counts = {"think": 0, "tool_exec": 0, "other": 0}
    if message_timeline:
        prev_t = 0.0
        for t, _idx, role in message_timeline:
            dt = max(0.0, t - prev_t)
            if role == "assistant":
                role_secs["think"] += dt
                role_counts["think"] += 1
            elif role == "tool":
                role_secs["tool_exec"] += dt
                role_counts["tool_exec"] += 1
            else:
                role_secs["other"] += dt
                role_counts["other"] += 1
            prev_t = t
        # Account for hermes startup / final wrap (any time after last msg).
        tail = wall_s - prev_t
        if tail > 0:
            role_secs["other"] += tail
        parts = []
        if role_counts["think"]:
            parts.append(f"model_think={role_secs['think']:.0f}s({role_counts['think']} calls, avg {role_secs['think']/max(1,role_counts['think']):.1f}s)")
        if role_counts["tool_exec"]:
            parts.append(f"tool_exec={role_secs['tool_exec']:.0f}s({role_counts['tool_exec']} calls, avg {role_secs['tool_exec']/max(1,role_counts['tool_exec']):.1f}s)")
        parts.append(f"other={role_secs['other']:.0f}s")
        print(f"  hermes breakdown: " + " | ".join(parts))
    stage_times["hermes_model_think"] = round(role_secs["think"], 1)
    stage_times["hermes_tool_exec"] = round(role_secs["tool_exec"], 1)
    stage_times["hermes_other"] = round(role_secs["other"], 1)
    if os.environ.get("AGENT_TEST_TIMELINE"):
        print(f"  hermes message timeline (t_s, role):")
        for t, _i, role in message_timeline:
            print(f"    {t:6.1f}s  {role}")

    _t = time.time()
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
    # On timeout/stall, the session_id line may not have flushed to stderr —
    # fall back to my_session (the file path the watchdog identified).
    tool_calls = []
    sess_path = None
    if session_id:
        sess_path = Path.home() / ".hermes" / "sessions" / f"session_{session_id}.json"
    elif my_session and my_session.exists():
        sess_path = my_session
        session_id = sess_path.stem.replace("session_", "")
    if sess_path and sess_path.exists():
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

    preds = predicate_results(spec, agent_stdout, post, mc_verbs_used)
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

    stage_times["post"] = time.time() - _t

    _t = time.time()
    try:
        fixture_run(spec, "cleanup")
    except Exception as e:
        print(f"  WARN: cleanup error: {e}", file=sys.stderr)
    stage_times["cleanup"] = time.time() - _t

    report["stage_times"] = {k: round(v, 1) for k, v in stage_times.items()}
    report["total_seconds"] = round(time.time() - overall_t0, 1)

    stamp = report["timestamp"].replace(":", "-").replace(".", "-")
    out_path = ROOT / "data" / "agent-tests" / "runs" / f"{test_id}-{stamp}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    verb_summary = ", ".join(f"{k}×{v}" for k, v in sorted(verb_counts.items(), key=lambda kv: -kv[1])[:5]) or "(none)"
    timing_summary = " ".join(f"{k}={v:.1f}s" for k, v in stage_times.items())
    print(f"  timing: total={report['total_seconds']:.1f}s | {timing_summary}")
    print(f"  {verdict}  {mc_cli_calls} mc/cli ({verb_summary}), {ok_false_count} ok:false, loop={loop_sig.get('max_streak', 0)}")
    for r in preds:
        flag = "✓" if r["pass"] else "✗"
        print(f"    {flag} {r['kind']}" + (f" — {r['detail']}" if r['detail'] else ""))
    print(f"  report: {out_path}")
    sys.exit(0 if verdict == "PASS" else 1)


if __name__ == "__main__":
    main()
