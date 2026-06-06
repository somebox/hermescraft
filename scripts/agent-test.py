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
      world_block_at: [{ x: 0, y: 65, z: 2, block: cobblestone }]
      structure_manifest: { block: cobblestone, footprint: { x: [0], z: [0], y_min: 65, y_max: 70 } }
      world_bbox_block_count: [{ block: dirt, bbox: { x1: 0, y1: 65, z1: 0, x2: 2, y2: 70, z2: 2 }, max_count: 0 }]
      chest_item_count_at: [{ x: 96, y: 65, z: 53, item: oak_log, min_count: 8 }]
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
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Line-buffer stdout so `tee` / `tail -f` see output immediately. Without
# this, Python switches to block-buffering when stdout is a pipe, and the
# user can't watch a run in real time.
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

ROOT = Path(__file__).parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests._lib.chest_nbt import sum_chest_item_from_nbt as _sum_chest_item_from_nbt

DEFAULT_BOT_URL = "http://localhost:3001"
DEFAULT_MODEL = os.environ.get("AGENT_TEST_MODEL", "deepseek/deepseek-v4-flash:exacto")
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


def resolve_agent_test_spec(spec_path: Path, spec: dict, arm: str | None) -> dict:
    """Expand multi-arm specs + optional includes/<dir>/goal.txt into a runnable spec."""
    spec = dict(spec)
    includes_dir = spec.get("includes_dir") or "chop-oak-8"
    goal_path = spec_path.parent / "includes" / includes_dir / "goal.txt"
    goal_text = goal_path.read_text(encoding="utf-8") if goal_path.exists() else ""

    if spec.get("arms"):
        arm_key = arm or spec.get("default_arm")
        if not arm_key or arm_key not in spec["arms"]:
            keys = ", ".join(sorted(spec["arms"]))
            print(f"ERROR: --arm required (one of: {keys})", file=sys.stderr)
            sys.exit(2)
        overlay = spec["arms"][arm_key]
        if overlay.get("skills"):
            spec["skills"] = overlay["skills"]
        if overlay.get("max_turns") is not None:
            spec["max_turns"] = overlay["max_turns"]
        if overlay.get("card_body_file"):
            body_path = spec_path.parent / overlay["card_body_file"]
            body = body_path.read_text(encoding="utf-8").replace("{{GOAL}}", goal_text.strip())
            spec["_card_body"] = body
        if overlay.get("prep_extra"):
            spec["prep"] = list(spec.get("prep") or []) + list(overlay["prep_extra"])
        extra = overlay.get("expect_extra") or {}
        if extra:
            merged = dict(spec.get("expect") or {})
            merged.update(extra)
            spec["expect"] = merged
        base_id = spec.get("agent_test_id") or spec_path.stem
        spec["agent_test_id"] = f"{base_id}_{arm_key.replace('-', '_')}"

    task_default = spec.get("kanban_task_default") or "t_agent_test_chop"
    task_id = os.environ.get("HERMES_KANBAN_TASK", task_default)
    spec["_kanban_task_id"] = task_id
    prefix = (spec.get("prompt_prefix") or "").strip()
    if prefix:
        card_body = spec.get("_card_body") or ""
        spec["prompt"] = (
            prefix.replace("{{TASK_ID}}", task_id).replace("{{CARD_BODY}}", card_body)
        ).strip()
    elif spec.get("prompt"):
        spec["prompt"] = str(spec["prompt"]).replace("{{TASK_ID}}", task_id)
    elif spec.get("_card_body"):
        spec["prompt"] = spec["_card_body"]

    return spec


def run_rcon(cmd: str) -> str:
    """Run a single rcon command via ssh+stdin. Stdin avoids docker's CLI
    parser interpreting leading dashes (e.g. -2 coordinates) as flags."""
    full = ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"]
    result = subprocess.run(full, input=cmd + "\n", capture_output=True, text=True, timeout=20)
    return result.stdout.strip()


def mirror_to_chat(text: str, prefix: str = "Flint") -> None:
    """Broadcast a single line to every player on every world via
    `tellraw @a` (Paper). Used to mirror the agent's natural-language
    thinking into in-game chat so a spectator can follow along — without
    this, chat from a `landfolk-test` test world is invisible to anyone
    standing in `landfolk`. Best-effort: failures are swallowed so a
    flaky rcon never breaks the test."""
    if not text:
        return
    # Escape for JSON inside a Minecraft tellraw payload. The text becomes
    # the value of a JSON string, so escape backslash and double-quote and
    # collapse newlines.
    safe = text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    if len(safe) > 240:
        safe = safe[:237] + "..."
    payload = (
        f'tellraw @a ['
        f'{{"text":"<{prefix} thinks> ","color":"gray","italic":true}},'
        f'{{"text":"{safe}","color":"white"}}'
        f']'
    )
    try:
        run_rcon(payload)
    except Exception:
        pass


def run_rcon_batch(cmds: list[str], timeout_s: float | None = None) -> str:
    """Run many rcon commands via a single ssh+rcon-cli invocation.
    Drastically faster than per-command (one TCP/ssh round-trip vs N).
    Returns combined stdout."""
    if not cmds:
        return ""
    if timeout_s is None:
        timeout_s = max(60.0, min(600.0, len(cmds) * 0.25))
    batch = "\n".join(cmds) + "\n"
    full = ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"]
    result = subprocess.run(full, input=batch, capture_output=True, text=True, timeout=timeout_s)
    if os.environ.get("AGENT_TEST_RCON_DEBUG"):
        out_lines = (result.stdout or "").splitlines()
        for i, (cmd, out) in enumerate(zip(cmds, out_lines + [""] * max(0, len(cmds) - len(out_lines)))):
            print(f"  [rcon {i:02d}] {cmd}  → {out}", file=sys.stderr)
    return result.stdout


def _test_world(spec: dict) -> str:
    return str(spec.get("world") or "landfolk-test")


def _player_reset_rcon_cmds(spec: dict) -> list[str]:
    """Reset Flint between runs (fire, effects, optional inventory clears)."""
    # After proc-lab cleanup Flint is usually still in hub; prep mvtp moves him next.
    world = (
        "landfolk-test"
        if _test_world(spec) == "proc-lab"
        else _test_world(spec)
    )
    cmds = [
        f"execute in {world} run data merge entity @e[type=player,name=Flint,limit=1] {{Fire:0s,HurtTime:0s,DeathTime:0s}}",
        f"execute in {world} run effect clear Flint",
        f"execute in {world} run effect give Flint minecraft:instant_health 1 4",
    ]
    for item in spec.get("inventory_reset") or []:
        name = str(item).replace("minecraft:", "")
        cmds.append(f"execute in {world} run clear Flint minecraft:{name}")
    return cmds


def _wait_for_bot_ready(bot_url: str, timeout_s: float = 45) -> bool:
    """Landfolk-style: HTTP listener up + /observe position (after dimension tp)."""
    import urllib.error
    import urllib.request

    deadline = time.time() + timeout_s
    posted_connect = False
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{bot_url}/health", timeout=5) as resp:
                health = json.loads(resp.read().decode())
            if not health.get("connected"):
                if not posted_connect:
                    try:
                        urllib.request.urlopen(
                            urllib.request.Request(
                                f"{bot_url}/connect", method="POST", data=b""
                            ),
                            timeout=10,
                        )
                    except Exception:
                        pass
                    posted_connect = True
                time.sleep(1.0)
                continue
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            time.sleep(1.0)
            continue
        obs = observe(bot_url)
        pos = (obs.get("state") or {}).get("position") or {}
        if pos.get("x") is not None:
            return True
        time.sleep(1.0)
    return False


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


def _summarize_msg(m: dict, max_len: int = 220) -> str:
    """Render a hermes session message as a single short line for live tail.
    Hermes schema: content is a string (possibly empty), tool calls live on
    assistant messages as `tool_calls=[{function:{name,arguments(JSON-str)}}]`,
    and tool responses are `role=tool` with content as JSON-stringified
    `{output: "..."}`. Returns '' to skip the system prompt and empty noise."""
    role = m.get("role", "?")
    content = m.get("content") or ""
    parts = []

    # Assistant tool calls — surface command name + first arg (the bash
    # command, or the first kwarg) so the user sees what the model
    # is actually doing each turn.
    if role == "assistant":
        if isinstance(content, str) and content.strip():
            parts.append(content.strip())
        for tc in m.get("tool_calls") or []:
            fn = (tc.get("function") or {})
            name = fn.get("name", "?")
            args_raw = fn.get("arguments") or ""
            try:
                args = json.loads(args_raw) if isinstance(args_raw, str) else (args_raw or {})
            except Exception:
                args = {"_raw": args_raw[:80]}
            cmd = (args.get("command") or args.get("cmd") or args.get("script")
                   if isinstance(args, dict) else None)
            if cmd:
                parts.append(f"→ {name}: {cmd}")
            else:
                key = next(iter(args), None) if isinstance(args, dict) else None
                val = args.get(key) if (key and isinstance(args, dict)) else args
                parts.append(f"→ {name}({key}={val!r})" if key else f"→ {name}()")
    elif role == "tool":
        # Tool output is verbose JSON — flatten to first non-empty line.
        text = content if isinstance(content, str) else json.dumps(content)
        try:
            obj = json.loads(text)
            if isinstance(obj, dict) and "output" in obj:
                text = obj["output"]
        except Exception:
            pass
        text = (text or "").strip().splitlines()
        # Take the first informative line, skip "state: ..." prefix if
        # there's a more interesting JSON-result line right after.
        head = text[0] if text else ""
        if head.startswith("state:") and len(text) > 1:
            head = text[1]
        parts.append(f"⟵ {head}")
    elif role == "user":
        # The big initial prompt is uninteresting in the live tail.
        if isinstance(content, str) and len(content) > 400:
            return ""
        if isinstance(content, str) and content.strip():
            parts.append(content.strip())
    elif isinstance(content, str) and content.strip():
        parts.append(content.strip())

    text = " | ".join(p for p in parts if p)
    text = text.replace("\n", " ").strip()
    if not text:
        return ""
    if len(text) > max_len:
        text = text[:max_len - 1] + "…"
    return text


def _line_indicates_block_match(line: str) -> bool:
    line = line or ""
    return ("Test passed" in line) or ("matches" in line) or ("passed" in line.lower())


def _rcon_blocks_match_batch(cells: list[tuple[int, int, int]], block: str) -> list[bool]:
    """Batch `execute if block` probes; one ssh round-trip per chunk."""
    if not cells:
        return []
    block_id = str(block).replace("minecraft:", "")
    cmds = [
        f"execute in landfolk-test if block {x} {y} {z} minecraft:{block_id}"
        for x, y, z in cells
    ]
    hits: list[bool] = []
    chunk_size = 80
    for i in range(0, len(cmds), chunk_size):
        chunk = cmds[i : i + chunk_size]
        out = run_rcon_batch(chunk)
        lines = (out or "").splitlines()
        # Paper prints one result line per command; pad if short.
        for j in range(len(chunk)):
            line = lines[j] if j < len(lines) else ""
            hits.append(_line_indicates_block_match(line))
    return hits


def _rcon_block_is(x: int, y: int, z: int, block: str) -> bool:
    hits = _rcon_blocks_match_batch([(x, y, z)], block)
    return hits[0] if hits else False


def _structure_manifest_cells(spec: dict) -> list[tuple[int, int, int]]:
    """Expand structure_manifest: cells, solid footprint, or platform_layers + corner_columns."""
    if spec.get("cells"):
        out = []
        for c in spec["cells"]:
            if isinstance(c, dict):
                out.append((int(c["x"]), int(c["y"]), int(c["z"])))
            else:
                out.append((int(c[0]), int(c[1]), int(c[2])))
        return out

    cells: list[tuple[int, int, int]] = []

    for layer in spec.get("platform_layers") or []:
        y = int(layer["y"])
        for x in layer.get("x") or []:
            for z in layer.get("z") or []:
                cells.append((int(x), y, int(z)))

    cc = spec.get("corner_columns") or {}
    cx = cc.get("x") or []
    cz = cc.get("z") or []
    for y_lo, y_hi in cc.get("y_ranges") or []:
        y_lo, y_hi = int(y_lo), int(y_hi)
        for x in cx:
            for z in cz:
                for y in range(y_lo, y_hi + 1):
                    cells.append((int(x), y, int(z)))

    if cells:
        # dedupe while preserving order
        seen = set()
        uniq = []
        for c in cells:
            if c not in seen:
                seen.add(c)
                uniq.append(c)
        return uniq

    fp = spec.get("footprint") or {}
    xs = fp.get("x") or []
    zs = fp.get("z") or []
    y_min, y_max = int(fp["y_min"]), int(fp["y_max"])
    for x in xs:
        for z in zs:
            for y in range(y_min, y_max + 1):
                cells.append((int(x), int(y), int(z)))
    return cells


def _count_block_in_bbox(block: str, bb: dict) -> int:
    x1, y1, z1 = int(bb["x1"]), int(bb["y1"]), int(bb["z1"])
    x2, y2, z2 = int(bb["x2"]), int(bb["y2"]), int(bb["z2"])
    cells = [
        (x, y, z)
        for x in range(x1, x2 + 1)
        for y in range(y1, y2 + 1)
        for z in range(z1, z2 + 1)
    ]
    hits = _rcon_blocks_match_batch(cells, block)
    return sum(1 for h in hits if h)


def _parse_scoreboard_count(rcon_out: str, holder: str = "#probe") -> int | None:
    """Parse `scoreboard players get` stdout: ``#probe has 3 [obj]``."""
    for line in (rcon_out or "").splitlines():
        if holder not in line or " has " not in line:
            continue
        try:
            mid = line.split(" has ", 1)[1]
            return int(mid.split()[0])
        except (IndexError, ValueError):
            continue
    return None


def _count_entities_in_bbox(ent_type: str, x1: int, y1: int, z1: int, x2: int, y2: int, z2: int) -> int:
    """Count entities of ``ent_type`` in an inclusive axis-aligned box (rcon/scoreboard)."""
    dx = max(0, int(x2) - int(x1))
    dy = max(0, int(y2) - int(y1))
    dz = max(0, int(z2) - int(z1))
    cmds = [
        "scoreboard objectives add agenttest_ent dummy",
        "execute in landfolk-test run scoreboard players set #probe agenttest_ent 0",
        (
            f"execute in landfolk-test run execute as "
            f"@e[type={ent_type},x={x1},y={y1},z={z1},dx={dx},dy={dy},dz={dz}] "
            f"run scoreboard players add #probe agenttest_ent 1"
        ),
        "scoreboard players get #probe agenttest_ent",
    ]
    out = run_rcon_batch(cmds)
    n = _parse_scoreboard_count(out or "")
    return n if n is not None else 0


def predicate_results(spec: dict, agent_chat: str, end_state: dict,
                       mc_verbs: list = None, pre_deaths: int = 0) -> list:
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

    if "final_bot_time_at_least" in expect:
        # Bot-time at end of run. For G20-style "survive the night" tests,
        # ending at bot_time ~12100 (right at sunset) means the test
        # ran out of turns before mobs could spawn. Force the run to
        # actually reach deep night (e.g., 15000+ for past-midnight).
        target = int(expect["final_bot_time_at_least"])
        st = end_state.get("state") or {}
        bt = st.get("time")
        ok = bt is not None and bt >= target
        results.append({"kind": f"final_bot_time>={target}",
                         "pass": bool(ok),
                         "detail": f"final_bot_time={bt if bt is not None else 'none'}"})

    if expect.get("bot_did_not_die"):
        # Bot's death counter (state.death_death_number) increments per death.
        # Compare pre vs post to detect deaths during the test, regardless of
        # whether the bot then respawned. Robust to "died and got back to
        # almost-full HP" cases where bot_hp_at_least would still pass.
        st = end_state.get("state") or {}
        post_deaths = int(st.get("death_death_number") or 0)
        died = post_deaths > pre_deaths
        results.append({"kind": "bot_did_not_die",
                         "pass": not died,
                         "detail": f"deaths: pre={pre_deaths} post={post_deaths}" + (" (died!)" if died else "")})

    if "auto_action_fired" in expect:
        # Validates that the reactive layer auto-fired at least one of the
        # listed actions during the run. Reads from observe response's
        # auto_action_log (populated by reactive.js:pushAutoEvent).
        wanted = expect["auto_action_fired"] or []
        log = end_state.get("auto_action_log") or end_state.get("autoActionLog") or []
        fired = set(e.get("action") for e in log if isinstance(e, dict))
        hits = [w for w in wanted if w in fired]
        ok = len(hits) > 0
        detail = ("fired: " + ",".join(hits)) if hits else f"none of {wanted}; log had: {sorted(fired) if fired else '(empty)'}"
        results.append({"kind": f"auto_action:{','.join(wanted)}", "pass": ok, "detail": detail})

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
            # Use rcon's own stdout from `execute if block` — Paper prints
            # "Test passed" on match and "Test failed" otherwise.
            hit = _rcon_block_is(x, y, z, block)
            results.append({"kind": f"block@{x},{y},{z}=={block}", "pass": hit,
                             "detail": "match" if hit else "no match"})

    if "structure_manifest" in expect:
        sm = expect["structure_manifest"] or {}
        block = str(sm.get("block", "cobblestone")).replace("minecraft:", "")
        cells = _structure_manifest_cells(sm)
        hits = _rcon_blocks_match_batch(cells, block)
        missing = [f"{cells[i][0]},{cells[i][1]},{cells[i][2]}" for i, ok in enumerate(hits) if not ok]
        ok = len(missing) == 0
        results.append({
            "kind": f"structure_manifest:{block}x{len(cells)}",
            "pass": ok,
            "detail": f"missing={len(missing)}" + (f" e.g. {missing[0]}" if missing else ""),
        })

    if "world_bbox_block_count" in expect:
        for rule in expect["world_bbox_block_count"] or []:
            block = str(rule["block"]).replace("minecraft:", "")
            bb = rule["bbox"]
            have = _count_block_in_bbox(block, bb)
            want = rule.get("count")
            max_c = rule.get("max_count")
            min_c = rule.get("min_count")
            if want is not None:
                ok = have == int(want)
                bound = f"=={want}"
            elif max_c is not None and min_c is not None:
                ok = int(min_c) <= have <= int(max_c)
                bound = f"[{min_c},{max_c}]"
            elif max_c is not None:
                ok = have <= int(max_c)
                bound = f"<={max_c}"
            elif min_c is not None:
                ok = have >= int(min_c)
                bound = f">={min_c}"
            else:
                ok = have == 0
                bound = "==0"
            results.append({
                "kind": f"bbox_{block}{bound}",
                "pass": ok,
                "detail": f"have={have} bbox=({bb['x1']},{bb['y1']},{bb['z1']})..({bb['x2']},{bb['y2']},{bb['z2']})",
            })

    if "chest_item_count_at" in expect:
        for probe in expect["chest_item_count_at"] or []:
            x, y, z = probe["x"], probe["y"], probe["z"]
            item = str(probe["item"]).replace("minecraft:", "")
            want_min = int(probe.get("min_count", 1))
            want_max = probe.get("max_count")
            out = run_rcon(f"execute in landfolk-test run data get block {x} {y} {z} Items")
            have = _sum_chest_item_from_nbt(out or "", item)
            ok_min = have >= want_min
            ok_max = want_max is None or have <= int(want_max)
            ok = ok_min and ok_max
            bound = f">={want_min}" + (f",<={want_max}" if want_max is not None else "")
            results.append({
                "kind": f"chest@{x},{y},{z}:{item}{bound}",
                "pass": ok,
                "detail": f"have={have}",
            })

    if "entity_in_bbox" in expect:
        # List of {type, bbox: {x1,y1,z1,x2,y2,z2}, min_count?, max_count?}.
        # Counts entities of that type inside the inclusive AABB; passes when
        # count >= min_count (default 0) AND count <= max_count (default inf).
        # Set max_count: 0 to assert absence; min_count: 1 to assert presence.
        for probe in expect["entity_in_bbox"] or []:
            t = probe["type"]
            bb = probe["bbox"]
            x1, y1, z1 = bb["x1"], bb["y1"], bb["z1"]
            x2, y2, z2 = bb["x2"], bb["y2"], bb["z2"]
            min_count = int(probe.get("min_count", 0))
            max_count = probe.get("max_count", None)
            dx = x2 - x1
            dy = y2 - y1
            dz = z2 - z1
            sel = f"@e[type={t},x={x1},y={y1},z={z1},dx={dx},dy={dy},dz={dz}]"
            count = _count_entities_in_bbox(t, x1, y1, z1, x2, y2, z2)
            ok = count >= min_count and (max_count is None or count <= max_count)
            bounds = f">={min_count}" + (f",<={max_count}" if max_count is not None else "")
            results.append({
                "kind": f"entity_in_bbox:{t}{bounds}",
                "pass": ok,
                "detail": f"count={count} bbox=({x1},{y1},{z1})..({x2},{y2},{z2})",
            })

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
    p.add_argument(
        "--arm",
        help="A1 card-body arm for specs with arms: (prose-minimal, prose-skilled, playbook)",
    )
    args = p.parse_args()

    spec_path = Path(args.spec)
    if not spec_path.exists():
        print(f"ERROR: spec not found: {spec_path}", file=sys.stderr)
        sys.exit(2)

    spec = resolve_agent_test_spec(spec_path, parse_yaml(spec_path), args.arm)
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

    # Pre-prep: player reset + spec cleanup (clears prior arena), then prep + settle.
    stage_times = {}
    overall_t0 = time.time()

    # Cycle: player reset → (landfolk only: spec cleanup) → prep → settle.
    # proc-lab: do NOT run hub cleanup before prep — previous run's cleanup tp'd
    # Flint to landfolk-test; prep mvtp+tp must run without an extra hub hop first.
    print(f"  pre-prep reset + clean...", end="", flush=True)
    _t = time.time()
    pre_cmds = _player_reset_rcon_cmds(spec)
    if _test_world(spec) != "proc-lab":
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
    settle_s = int(spec.get("settle_seconds", 8 if _test_world(spec) == "proc-lab" else 6))
    print(f"  settle ({settle_s}s)...", end="", flush=True)
    _t = time.time()
    time.sleep(settle_s)
    stage_times["settle"] = time.time() - _t
    print(f" ok ({stage_times['settle']:.1f}s)")

    if _test_world(spec) == "proc-lab":
        print(f"  wait for bot in proc-lab...", end="", flush=True)
        _t = time.time()
        if not _wait_for_bot_ready(args.bot_url, timeout_s=45):
            print(f" FAIL ({time.time() - _t:.1f}s)", file=sys.stderr)
            print(
                "ERROR: Flint has no position after proc-lab prep — "
                "check bot connected (landfolk start) and rcon mvtp/tp in prep.",
                file=sys.stderr,
            )
            sys.exit(2)
        stage_times["bot_ready"] = time.time() - _t
        print(f" ok ({stage_times['bot_ready']:.1f}s)")

    # Verify prep: query bot's perception and check counts match spec.
    # Spec uses `verify_after_prep` as a list of { block, min_count } items.
    # Failures abort the test (no point launching hermes against a broken arena).
    verify_items = spec.get("verify_after_prep") or []
    if verify_items:
        nearby = observe(args.bot_url)
        # /observe doesn't include block counts; use /nearby separately.
        # Radius is the max of any item's `radius` field (default 16) so
        # arenas with prep beyond Flint's tp can opt in to a wider scan.
        import urllib.request
        scan_radius = max(int(item.get("radius", 16)) for item in verify_items)
        try:
            with urllib.request.urlopen(f"{args.bot_url}/nearby?radius={scan_radius}", timeout=10) as resp:
                near = json.loads(resp.read().decode())
        except Exception as e:
            print(f"  VERIFY: nearby query failed: {e}")
            near = {"data": {"blocks": []}}
        block_counts = {b["name"]: b["count"] for b in (near.get("data") or {}).get("blocks", [])}
        print(f"  verify_after_prep:")
        fail = False
        for item in verify_items:
            name = item["block"]
            want_min = int(item.get("min_count", 1))
            want_max = item.get("max_count")
            have = block_counts.get(name, 0)
            ok_min = have >= want_min
            ok_max = want_max is None or have <= int(want_max)
            ok = ok_min and ok_max
            flag = "✓" if ok else "✗"
            bound = f"≥ {want_min}" + (f", ≤ {want_max}" if want_max is not None else "")
            print(f"    {flag} {name} {bound}  (have {have})")
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
    pre_deaths = int((pre.get("state") or {}).get("death_death_number") or 0)

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
    # Per-spec toolsets override; default `terminal` — the G-test agent
    # only needs the `mc` CLI surface, which lives in the terminal
    # toolset. Skipping the rest (browser, code_execution, delegation,
    # cronjob, etc.) saves ~10k tokens of tool-schema overhead per
    # request. Override via `toolsets: [...]` in the test YAML.
    toolsets = spec.get("toolsets") or ["terminal"]
    cmd.extend(["-t", ",".join(toolsets)])
    # G-tests have self-contained step-by-step prompts; the global
    # ~/.hermes/SOUL.md (3.6k tokens of "Hermes — Playing Minecraft"
    # guidance) plus preloaded skills are dead weight. --ignore-rules
    # skips AGENTS.md / SOUL.md / .cursorrules / memory / preloaded
    # skills. Saves another ~3.5k tokens per request. Tests that NEED
    # SOUL/skill context can set `ignore_rules: false` in the spec.
    if spec.get("ignore_rules", True):
        cmd.append("--ignore-rules")

    env = os.environ.copy()
    env["MC_API_URL"] = args.bot_url
    env["MC_USERNAME"] = "Flint"
    # Propagate the synthetic task ID used in the prompt so agents that read
    # `scripts/kanban card $HERMES_KANBAN_TASK` get the same id we templated
    # into {{TASK_ID}}. Otherwise the var expands to empty in the hermes
    # subprocess and the agent burns turns on a CLI usage error before
    # falling back to the prompt body.
    env["HERMES_KANBAN_TASK"] = spec.get("_kanban_task_id") or spec.get("kanban_task_default") or "t_agent_test_chop"

    _t = time.time()
    stage_times["verify"] = _t - (overall_t0 + sum(stage_times.values()))
    # Stall watchdog kills hermes if its session file stops growing for this
    # long — catches "agent loops on a 60s-timeout mc call" without waiting
    # out the full spec timeout. Each tool call appends to the session file,
    # so mtime growth is a reliable progress signal. Threshold must exceed
    # hermes' own per-tool timeout (60s) so a single slow tool doesn't trip.
    stall_seconds = int(spec.get("stall_seconds", 75))

    # Early-exit watchdog: terminate hermes when the bot has demonstrably
    # survived past the danger window. For G20-style night-survival tests
    # this saves 5-10 minutes per run that would otherwise be spent
    # polling `mc wait 30` until dawn. Spec sets:
    #   early_exit:
    #     bot_time_at_least: 14000   # game-time threshold (night well in)
    #     bot_hp_at_least: 15         # HP floor
    #     stable_seconds: 60          # how long the above must hold
    #     bot_url: http://localhost:3001
    early_exit_cfg = spec.get("early_exit") or {}
    early_exit_bot_url = early_exit_cfg.get("bot_url", "http://localhost:3001")
    early_exit_time = int(early_exit_cfg.get("bot_time_at_least", 0))
    early_exit_hp = float(early_exit_cfg.get("bot_hp_at_least", 0))
    early_exit_stable = float(early_exit_cfg.get("stable_seconds", 60))
    early_exit_enabled = bool(early_exit_cfg) and early_exit_time > 0
    early_exit_first_ok_at = None
    early_exit_last_deaths = None
    early_exit_last_poll = 0.0

    print(f"  launching hermes... (timeout={timeout_s}s, stall_kill={stall_seconds}s)" +
          (f" early_exit=t>={early_exit_time},hp>={early_exit_hp},stable={early_exit_stable}s" if early_exit_enabled else ""))
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
                    # Also stream a short snippet of each new assistant/tool
                    # message so the user can watch what the agent is doing.
                    try:
                        sess_data = json.loads(my_session.read_text())
                        msgs = sess_data.get("messages", [])
                        if len(msgs) > last_msg_count:
                            for m in msgs[last_msg_count:]:
                                role = m.get("role", "?")
                                message_timeline.append((round(elapsed, 1), len(message_timeline) + 1, role))
                                snippet = _summarize_msg(m)
                                if snippet:
                                    ts = f"{elapsed:6.1f}s"
                                    print(f"    [{ts}] {role}: {snippet}")
                                # Mirror assistant *text* (not tool calls)
                                # to in-game chat so a spectator on any
                                # world can follow the agent's reasoning.
                                if role == "assistant":
                                    c = m.get("content") or ""
                                    if isinstance(c, str) and c.strip():
                                        mirror_to_chat(c.strip())
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

                # Early-exit watchdog. Poll bot state every 4s; if the bot
                # has cleared the danger threshold and stayed there for
                # `stable_seconds`, terminate hermes early and treat as PASS.
                if early_exit_enabled and time.time() - early_exit_last_poll > 4.0:
                    early_exit_last_poll = time.time()
                    try:
                        import urllib.request
                        with urllib.request.urlopen(f"{early_exit_bot_url}/status?lean=true&preserve=true", timeout=3) as resp:
                            sdata = (json.loads(resp.read().decode()).get("data") or {})
                        s_time = int(sdata.get("time") or 0)
                        s_hp = float(sdata.get("health") or 0)
                        s_deaths = int(sdata.get("deaths") or 0)
                        threshold_met = s_time >= early_exit_time and s_hp >= early_exit_hp
                        deaths_stable = early_exit_last_deaths is None or s_deaths == early_exit_last_deaths
                        if threshold_met and deaths_stable:
                            if early_exit_first_ok_at is None:
                                early_exit_first_ok_at = time.time()
                                early_exit_last_deaths = s_deaths
                                print(f"  early-exit: bot stable (t={s_time}, hp={s_hp}, deaths={s_deaths}) — armed, will exit after {early_exit_stable:.0f}s")
                            elif time.time() - early_exit_first_ok_at >= early_exit_stable:
                                proc.terminate()
                                try: proc.wait(timeout=5)
                                except subprocess.TimeoutExpired: proc.kill()
                                hermes_status = "early_exit"
                                print(f"  early-exit: bot stable for {early_exit_stable:.0f}s (t={s_time}, hp={s_hp}, deaths={s_deaths}) — killed hermes (PASS)")
                                break
                        else:
                            # Reset arming if the bot took a death or HP dropped.
                            if early_exit_first_ok_at is not None:
                                early_exit_first_ok_at = None
                                print(f"  early-exit: re-armed (t={s_time}, hp={s_hp}, deaths={s_deaths})")
                            early_exit_last_deaths = s_deaths
                    except Exception:
                        pass
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

    # Optional post-hermes settle: give the bot time to finish auto-actions
    # (reactive escape, regenerate from saturation, etc.) before measuring
    # final state. Useful for survival tests where hermes exits while the bot
    # is mid-escape and the un-settled HP under-counts true survival.
    post_wait = int(spec.get("post_wait_seconds", 0))
    if post_wait > 0:
        print(f"  post_wait ({post_wait}s, let reactive finish)...", end="", flush=True)
        time.sleep(post_wait)
        print(" ok")

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
    # When the verb is `batch`, also peek into the JSON payload so inner
    # action names (e.g. "craft" inside a batch step) count toward predicates.
    mc_verbs_used = []
    for tc in tool_calls:
        if tc.get("name") == "terminal":
            cmd = (tc.get("args") or {}).get("command") or ""
            for m in re.finditer(r"\bmc\s+([a-z_]+)\b", cmd):
                mc_verbs_used.append(m.group(1))
            try:
                tokens = shlex.split(cmd, posix=True)
            except ValueError:
                tokens = []
            for i, tok in enumerate(tokens):
                if tok != "mc" or i + 1 >= len(tokens) or tokens[i + 1] != "batch":
                    continue
                for j in range(i + 2, len(tokens)):
                    t = tokens[j]
                    if not (t.startswith("[") or t.startswith("{")):
                        continue
                    try:
                        steps = json.loads(t)
                    except (json.JSONDecodeError, TypeError):
                        break
                    if isinstance(steps, list):
                        for step in steps:
                            if isinstance(step, dict) and isinstance(step.get("action"), str):
                                mc_verbs_used.append(step["action"])
                    break
    mc_cli_calls = len(mc_verbs_used)
    verb_counts = {}
    for v in mc_verbs_used:
        verb_counts[v] = verb_counts.get(v, 0) + 1

    # Predicates MUST run before cleanup: rcon chest probes and post.observe
    # inventory reflect end-of-hermes state. Cleanup (fill air, tp, etc.) runs
    # only after verdict is computed.
    print(f"  predicates...", end="", flush=True)
    _t = time.time()
    preds = predicate_results(spec, agent_stdout, post, mc_verbs_used, pre_deaths)
    stage_times["predicates"] = time.time() - _t
    print(f" ok ({stage_times['predicates']:.1f}s)")
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
