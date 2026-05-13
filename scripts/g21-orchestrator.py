#!/usr/bin/env python3
"""g21-orchestrator.py — first two-bot coordination test runner.

Drives a pair of Hermes-brained Minecraft bots (Flint + Mason) through
a multi-phase cooperative mission. The orchestrator is the "steward":
it speaks via RCON `/say` (visible in-game as `[Server] @flint: ...`),
listens to chat by polling each bot's `/chat` endpoint, and advances
phases on keyword acknowledgement (or fallback predicate) — see the
spec at data/agent-tests/G21_two_bot_house.yaml.

The orchestrator does NOT issue `mc` commands to the bots. All actions
come from the bots' own Hermes brains, who treat console messages
addressed to them as orders. This is the simplest possible "Hermes-
agnostic" steward — chat is the entire coordination surface.

Usage:
  scripts/g21-orchestrator.py data/agent-tests/G21_two_bot_house.yaml \
    --model z-ai/glm-5.1 \
    --findings docs/experiments/g21-findings-glm.md

Bot lifecycle (handled by this script):
  1. Stop any existing bots on the spec's ports.
  2. Run world_setup RCON commands.
  3. `landfolk-control.sh start --profiles flint,mason` with model env.
  4. Poll /health until both bots are connected.
  5. Write marks (SUPPLY_CHEST, KEEP_SITE, MINING_HINT) into each bot.
  6. Run phase state machine.
  7. landfolk-control.sh stop --profiles flint,mason (cleanup).
"""
from __future__ import annotations

import argparse
import json
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent.parent
SOUL_FILE = HERE / "SOUL-landfolk.md"
PROMPTS_DIR = HERE / "prompts" / "landfolk"
HOME_DIR = Path.home()
BOT_DIR = HERE / "bot"


# Default G21 brain prompt — appended to the role-specific prompt at launch.
# Designed to keep the brain in a chat-listening loop and OFF the goal engine.
G21_BRAIN_PROMPT_TEMPLATE = """
You are {name}, in a G21 two-bot coordination test alongside {partner}.

THE TEST IS CHAT-DRIVEN. A scripted steward broadcasts mission orders.
In `mc read_chat`, steward messages have `from=STEWARD` (literal) and
are addressed by your `@<name>` like:

    @{name_lower} please mine 100 cobblestone ...
    @{partner_lower} please build a chest ...
    @flint @mason please build a small house together

If the line addresses `@{name_lower}` (or both `@flint @mason`), it's
your job. Lines addressed only to `@{partner_lower}` belong to your
partner — don't act on them.

Each mission also carries a short ID (M1A, M1B, M2A, M2B, M3) and a
keyword phrase to emit on completion. YOUR missions in this run:
{missions_block}
{partner}'s missions: {partner_missions}.
TEAM missions (e.g. M3) are for both of you to collaborate on.

YOUR JOB IS TO LISTEN AND RESPOND. Do NOT pursue goal-engine goals
during this test — `mc goals` results do not apply. Do NOT run
`mc goal_load`. Do NOT mine, build, or place anything unless a steward
order has explicitly asked for it.

CORE LOOP:
1. `mc read_chat 30` — see what's new.
2. If there is a STEWARD message whose `@<name>` matches you (or both
   `@flint @mason`), and you have not already completed it, that is
   your current mission. Plan, execute, VERIFY, then ACKNOWLEDGE.
3. If {partner} sent a chat (a keyword, a question, a status report,
   a request for help), reply via `mc chat`. Conversation is encouraged.
4. If there's no NEW instruction and you've finished your last mission,
   run `mc wait 8` then loop back to step 1.

REPORTING — talk constantly. Silence is the failure mode of this test:
- Before starting a phase of work, announce it: `mc chat "{name}: heading
  to MINING_HINT to mine stone"`.
- During work, report every notable step: each block placed, each batch
  of items collected, each travel destination. Examples:
    `mc chat "{name}: 20/60 cobble"`
    `mc chat "{name}: chest at -3,65,10 placed, depositing planks now"`
    `mc chat "{name}: heading to BEACH for sand"`
    `mc chat "{name}: tree at 6,65,-6 chopped, 4 logs collected"`
- After finishing a sub-step, say so.
- ALWAYS reply to {partner}'s messages — questions, status reports,
  requests for help. Don't ignore your partner.
- If you find yourself running 3+ `mc` commands without a chat message
  in between, that's too quiet — emit a status `mc chat`.

NO-MINE ZONE — the build area is a CONSTRUCTION SITE, not a resource:
- DO NOT mine, dig, or destroy any block at the build site. That zone
  is roughly x: -4..3, y: 65..72, z: 6..14 — chest, platform, walls,
  door, window, and the air around them.
- If you need more cobble, mine NEW stone from MINING_HINT (-12,65,-12)
  or further out. NEVER take cobble back out of the chest, platform,
  or walls — you're destroying your own work.
- The same rule applies to oak_log/planks: don't break the chest or
  any placed plank/door blocks. Mine fresh logs from a tree.

PREFER DIRECT ACTIONS OVER BACKGROUND TASKS:
- `mc bg_collect` and `mc bg_move` are background-run actions — they
  can hang and the bot then panics with `mc flee`. Prefer simple, direct
  commands:
    mine 4 blocks of stone: `mc collect stone 4` (foreground, returns
      when done or fails clearly)
    travel: `mc goto X Y Z` or `mc goto_near X Y Z` (foreground)
  Use bg_* only when you specifically need to do something else while
  the action runs. For G21 work, foreground is almost always better.

ACKNOWLEDGE ONLY WHEN ACTUALLY DONE — VERIFY via real commands:
- inventory missions  → `mc inventory` and check the count yourself
- placement missions  → `mc find_blocks <type> radius=5` near where you
                        placed; or `mc nearby` to see what's around
- chest missions      → `mc chest_search <item>` to confirm contents
- ENCLOSURE missions  → `mc is_sheltered` while standing inside the
                        structure — returns the pathfinder enclosure
                        result. The ONLY way to verify a house is sealed.
- Emit the keyword phrase as the ENTIRE chat content, e.g.
    `mc chat "M1A DONE"` (not "almost M1A DONE!" — that triggers
    false advancement).

CLAIM SUB-TASKS via chat to avoid duplicate work:
- Before starting a sub-step on a TEAM mission, announce ownership:
    `mc chat "{name}: I'll build the north and east walls"`
    `mc chat "{name}: I'll handle the glass — going to BEACH for sand"`
- If your partner has already claimed a sub-task, DON'T also do it.
  Pick something else they didn't claim.
- If you finish your claimed work, ask for the next thing:
    `mc chat "{name}: north + east walls done, what's left?"`

IF YOU CANNOT COMPLETE — emit BLOCKED instead of DONE:
- If you genuinely can't finish (out of resources, repeated failures,
  pathfinding stuck, deadline missed), DO NOT emit the DONE keyword.
- Instead emit `mc chat "<missionID> BLOCKED: <reason>"` — for
  example `mc chat "M1A BLOCKED: only found 38 cobble, need more
  stone"`. The steward sees this and the failure is captured in the
  findings. {partner} may be able to help.

KEY RULES:
- Mission text includes `deadline tick NNNN` (Minecraft world tick).
  Run `mc status` to see the current tick. Pace yourself.
- SUPPLY_CHEST mark is at the start. It holds 2 wooden pickaxes, 2
  wooden axes, and 16 bread for BOTH of you. Take your share — leave
  enough for {partner}.
- A window mission needs glass. Sand is at the BEACH mark — you both
  know sand → furnace → smelt → glass. Decide with {partner} whether
  to make glass or skip windows.
- If stuck or short on materials, ASK {partner} via `mc chat` BEFORE
  giving up. Two heads beat one.

START SEQUENCE (run these in order):
1. `mc status`              — note the current tick and your position.
2. `mc marks`               — confirm SUPPLY_CHEST, KEEP_SITE, MINING_HINT.
3. `mc inventory`           — see what you start with.
4. `mc chat "READY: {name} standing by"` — handshake to the steward.
5. `mc read_chat 30`        — check for orders that arrived early.
6. If no order is active, `mc wait 8` and loop to step 5.

GO.
""".strip()

# ---------------------------------------------------------------------------
# YAML loader (PyYAML required — same as agent-test.py)


def load_spec(path: Path) -> dict:
    try:
        import yaml
    except ImportError:
        print("ERROR: PyYAML required. Install: pip install pyyaml", file=sys.stderr)
        sys.exit(2)
    with open(path) as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# RCON helpers (borrowed pattern from scripts/agent-test.py).


def run_rcon(cmd: str, timeout: int = 20) -> str:
    """Run a single rcon-cli command via ssh+stdin."""
    full = ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"]
    try:
        result = subprocess.run(full, input=cmd + "\n", capture_output=True, text=True, timeout=timeout)
        return (result.stdout or "").strip()
    except subprocess.TimeoutExpired:
        return ""


def run_rcon_batch(cmds: list[str], timeout: int = 60) -> str:
    """Run many rcon commands via a single ssh round-trip."""
    if not cmds:
        return ""
    batch = "\n".join(c for c in cmds if c.strip()) + "\n"
    full = ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"]
    try:
        result = subprocess.run(full, input=batch, capture_output=True, text=True, timeout=timeout)
        return result.stdout or ""
    except subprocess.TimeoutExpired:
        return ""


def steward_say(text: str) -> None:
    """Broadcast a steward message via RCON `tellraw`. We deliberately avoid
    `/say` because Paper expands `@<name>:` selectors in the text body — a
    mission like `@mason: mine cobble...` ends up parsed by Mineflayer as a
    chat FROM player `mason`, with the lowercased name. tellraw passes the
    text literally and the chat event arrives with from='' (or 'Rcon').
    Mineflayer also flattens the JSON components into a single message so
    the bots' `mc read_chat` sees the whole steward line as one unit."""
    safe = text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    if len(safe) > 240:
        safe = safe[:237] + "..."
    payload = (
        f'tellraw @a ['
        f'{{"text":"[STEWARD] ","color":"gold","bold":true}},'
        f'{{"text":"{safe}","color":"white"}}'
        f']'
    )
    run_rcon(payload)


# ---------------------------------------------------------------------------
# Bot HTTP helpers.


def http_get_json(url: str, timeout: float = 5.0) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError):
        return {}


def http_post_json(url: str, body: dict, timeout: float = 10.0) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError) as e:
        return {"ok": False, "error": {"code": "HTTP_FAIL", "message": str(e)}}


def bot_observe(port: int) -> dict:
    return http_get_json(f"http://localhost:{port}/observe").get("state", {}) or http_get_json(f"http://localhost:{port}/observe")


def bot_current_tick(port: int) -> int | None:
    """Return the current Minecraft world tick from /observe, or None."""
    payload = http_get_json(f"http://localhost:{port}/observe", timeout=3.0)
    # /observe returns { ok, time, ..., state: {time, ...} } — the top-level
    # `time` is the world tick.
    if isinstance(payload.get("time"), int):
        return payload["time"]
    state = payload.get("state", {}) or {}
    if isinstance(state.get("time"), int):
        return state["time"]
    return None


def bot_chat_history(port: int, count: int = 30) -> list[dict]:
    payload = http_get_json(f"http://localhost:{port}/chat?count={count}", timeout=3.0)
    data = payload.get("data") or {}
    msgs = data.get("messages") or []
    if isinstance(msgs, list):
        return msgs
    return []


def bot_inventory(port: int) -> dict[str, int]:
    """Return {item_name: total_count} across the bot's inventory.

    The /inventory endpoint returns items grouped under `data.categories.<cat>`
    rather than a flat list, so we walk every category and sum across them.
    Also accepts a flat `data.items` fallback in case the schema changes."""
    payload = http_get_json(f"http://localhost:{port}/inventory", timeout=3.0)
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return {}
    counts: dict[str, int] = {}

    def add(it):
        if not isinstance(it, dict):
            return
        name = it.get("name")
        n = it.get("count", 0)
        if isinstance(name, str) and isinstance(n, int):
            counts[name] = counts.get(name, 0) + n

    cats = data.get("categories")
    if isinstance(cats, dict):
        for items in cats.values():
            if isinstance(items, list):
                for it in items:
                    add(it)
    flat = data.get("items")
    if isinstance(flat, list):
        for it in flat:
            add(it)
    return counts


def bot_health(port: int) -> bool:
    payload = http_get_json(f"http://localhost:{port}/health", timeout=2.0)
    return bool(payload.get("connected"))


def write_mark(port: int, name: str, x: int, y: int, z: int, note: str = "") -> bool:
    body = {"name": name, "note": note, "at": {"x": x, "y": y, "z": z}}
    out = http_post_json(f"http://localhost:{port}/action/mark", body, timeout=8.0)
    return bool(out.get("ok") or out.get("result"))


# ---------------------------------------------------------------------------
# Bot lifecycle — direct launch (NOT via landfolk-control.sh).
#
# landfolk-control.sh's start runs the round-loop foreground and blocks. Its
# round prompts also force the brain into goal-engine pursuit ("Current focus
# hint: supply_iron (u=1.1)"), which overrides chat-driven coordination. For
# G21 we launch bot bodies + Hermes brains directly, with a single G21-focused
# prompt per brain.


def wait_bots_connected(bots: list[dict], timeout_s: int = 90) -> bool:
    """Poll /health until every bot reports connected=true. Returns True on success."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if all(bot_health(b["port"]) for b in bots):
            return True
        time.sleep(2)
    return False


def kill_port(port: int) -> None:
    """Best-effort: kill any process listening on the given TCP port."""
    try:
        out = subprocess.run(["lsof", "-ti", f"TCP:{port}"], capture_output=True, text=True, timeout=5)
        pids = [p.strip() for p in (out.stdout or "").split("\n") if p.strip()]
        for pid in pids:
            try:
                subprocess.run(["kill", pid], timeout=3)
            except Exception:
                pass
        if pids:
            time.sleep(1)
        # SIGKILL stragglers.
        for pid in pids:
            try:
                subprocess.run(["kill", "-9", pid], timeout=3)
            except Exception:
                pass
    except Exception:
        pass


def stop_existing_bots(bots: list[dict]) -> None:
    """Tear down anything currently bound to the spec's ports."""
    for b in bots:
        port = b["port"]
        if bot_health(port):
            print(f"  freeing port {port} (existing bot)")
            kill_port(port)


def launch_bot_body(name: str, port: int, env_extra: dict[str, str], log_path: Path) -> subprocess.Popen:
    """Spawn `node bot/server.js` for one bot. Returns the Popen handle."""
    import os
    env = os.environ.copy()
    env.update({
        "MC_HOST": env.get("MC_HOST", "192.168.1.202"),
        "MC_PORT": env.get("MC_PORT", "25565"),
        "MC_USERNAME": name,
        "API_PORT": str(port),
        "FAIR_PLAY": env.get("FAIR_PLAY", "true"),
        # BOT_HEAR_ALL bypasses the per-bot proximity filter on cross-bot
        # broadcasts. Without it, Mason mining at MINING_HINT (~25 blocks
        # from Flint near KEEP_SITE) silently drops the partner's chat
        # into overhearLog, where `mc read_chat` can't see it — bots
        # think their partner is mute.
        "BOT_HEAR_ALL": "true",
        # F45.5: allow bots to dig and relocate placed infrastructure
        # (crafting_table / furnace / chest / barrel) that ended up in the
        # wrong spot. Beds and bookshelves remain protected. This is
        # opt-in per-orchestrator; G20 and other tests keep full protection.
        "BOT_ALLOW_DIG_INFRASTRUCTURE": "true",
    })
    # PAPERMCP_TOKEN and friends from repo .env, if present.
    env_file = HERE / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip())
    env.update(env_extra)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    lf = open(log_path, "w")
    proc = subprocess.Popen(
        ["node", "server.js"],
        cwd=str(BOT_DIR),
        stdout=lf,
        stderr=subprocess.STDOUT,
        env=env,
    )
    return proc


def setup_hermes_home(name: str) -> Path:
    """Create per-bot HERMES_HOME directory, mirroring landfolk-control's layout.
    Wipes session memory between G21 runs so the bot doesn't carry "echoes"
    of past attempts into a fresh test. Copies SOUL.md + config; symlinks
    shared skills/credentials. Returns the HERMES_HOME path."""
    import shutil
    name_lower = name.lower()
    agent_home = HOME_DIR / f".hermes-landfolk-{name_lower}"
    agent_home.mkdir(parents=True, exist_ok=True)

    # Wipe session-state files that cause cross-run memory bleed. These are
    # the things that, between runs, make the bot reference past attempts
    # ("we tried this before") instead of treating each run as a clean slate.
    wipe_targets = ["MEMORY.md", "sessions", "checkpoints", "logs", "holographic.db"]
    for w in wipe_targets:
        p = agent_home / w
        if p.is_symlink():
            try:
                p.unlink()
            except OSError:
                pass
        elif p.is_file():
            try:
                p.unlink()
            except OSError:
                pass
        elif p.is_dir():
            try:
                shutil.rmtree(p)
            except OSError:
                pass

    # SOUL.md (always re-copy in case the source changed)
    if SOUL_FILE.exists():
        (agent_home / "SOUL.md").write_text(SOUL_FILE.read_text())
    # config.yaml
    src_config = HOME_DIR / ".hermes" / "config.yaml"
    if src_config.exists():
        (agent_home / "config.yaml").write_text(src_config.read_text())
    # Symlink shared skills/credentials — these are NOT memory, just static
    # tooling that all bots can share.
    for f in ("skills", "credentials.json"):
        target = agent_home / f
        src = HOME_DIR / ".hermes" / f
        if src.exists() and not target.exists():
            try:
                target.symlink_to(src)
            except OSError:
                pass
    return agent_home


def build_brain_prompt(name: str, role_prompt_path: Path, spec: dict) -> str:
    """Concatenate role prompt + G21 directive with mission IDs filled in
    from the spec, so each bot knows which mission IDs are its own."""
    role_text = role_prompt_path.read_text() if role_prompt_path.exists() else ""
    partner = "Mason" if name == "Flint" else "Flint"

    mine: list[str] = []
    theirs: list[str] = []
    team: list[str] = []
    for ph in spec.get("phases", []) or []:
        for mn in ph.get("missions", []) or []:
            mid = mn.get("id", "?")
            to = mn.get("to", "")
            kw = mn.get("done_keyword", "")
            line = f"  - {mid}  (acknowledge: \"{kw}\")"
            if to == "both":
                team.append(line + "  [TEAM]")
            elif to == name:
                mine.append(line)
            else:
                theirs.append(line)

    missions_block = "\n".join(mine + team) if (mine or team) else "  (none)"
    partner_missions = ", ".join(m.split()[1].rstrip(":") for m in theirs) or "(none)"
    missions_for_you = [m.split()[1].rstrip(":") for m in mine + team] or ["(none)"]

    directive = G21_BRAIN_PROMPT_TEMPLATE.format(
        name=name,
        partner=partner,
        name_lower=name.lower(),
        partner_lower=partner.lower(),
        missions_block=missions_block,
        missions_for_you=missions_for_you,
        partner_missions=partner_missions,
    )
    return f"{role_text}\n\n---\n\n{directive}"


def launch_brain(name: str, port: int, model: str | None, provider: str, prompt: str, max_turns: int, log_path: Path) -> subprocess.Popen:
    """Spawn `hermes chat --yolo` for one bot as a background subprocess."""
    import os
    agent_home = setup_hermes_home(name)
    env = os.environ.copy()
    # Clear inherited model/provider so hermes uses our flags only.
    for k in ("MODEL", "HERMES_MODEL", "PROVIDER", "HERMES_PROVIDER"):
        env.pop(k, None)
    env["HERMES_HOME"] = str(agent_home)
    env["MC_API_URL"] = f"http://localhost:{port}"
    env["_MC_API_URL_LOCKED"] = f"http://localhost:{port}"
    env["MC_USERNAME"] = name
    cmd = [
        "hermes", "chat", "--yolo",
        "--max-turns", str(max_turns),
        "-t", "terminal,memory",
        "-s", "minecraft-goals",
        "-q", prompt,
    ]
    if model:
        cmd.extend(["-m", model])
    if provider:
        cmd.extend(["--provider", provider])
    log_path.parent.mkdir(parents=True, exist_ok=True)
    lf = open(log_path, "w")
    proc = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT, env=env)
    return proc


def wait_for_chat_phrase(bots: list[dict], phrase: str, timeout_s: int, from_each: list[str] | None = None) -> bool:
    """Poll bots' /chat until `phrase` is seen FROM each named sender.

    If `from_each` is None, any single occurrence anywhere triggers True.
    If `from_each` is a list, returns True only when *every* sender in the
    list has emitted a message containing `phrase`. Used so we wait for
    both bots' READY handshakes, not just one."""
    targets = set(from_each or [])
    seen_from: set[str] = set()
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for b in bots:
            history = bot_chat_history(b["port"], count=20)
            for rec in history:
                if phrase not in (rec.get("message") or ""):
                    continue
                sender = (rec.get("from") or "")
                if not targets:
                    return True
                if sender in targets:
                    seen_from.add(sender)
        if targets and targets.issubset(seen_from):
            return True
        time.sleep(2)
    return False


def wipe_bot_marks(name: str) -> None:
    """Reset the bot's locations file so stale marks from previous runs
    (death_1, base, home, etc.) don't confuse the brain. The file is at
    `bot/data/locations-<name>.json`."""
    p = BOT_DIR / "data" / f"locations-{name.lower()}.json"
    if p.exists():
        try:
            p.write_text("{}")
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Combined log writer. Tails each brain's log file and merges lines into a
# single human-readable stream prefixed by bot name, so you can `tail -F`
# one file and see both agents' thinking + tool calls interleaved by time.
# Strips ANSI escapes AND Hermes TUI decoration (box-drawing chars + banner
# noise) so the result is concise.


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07")

# Pictograms that appear in Hermes output, mapped to ASCII so the combined
# log is plain ASCII (no UTF-8 "M-b" garbage when viewed with broken locale).
_ASCII_MAP = {
    "┊": "|", "│": "|",
    "💻": "$", "🧠": "#", "⚕": "*", "⚠": "!",
    "═": "=", "━": "-", "─": "-",
    "╭": "+", "╮": "+", "╯": "+", "╰": "+",
    "✓": "[ok]", "✗": "[x]",
    "—": "-", "–": "-",
}


def _strip_ansi(s: str) -> str:
    """Strip ANSI escapes and carriage returns."""
    return _ANSI_RE.sub("", s).replace("\r", "")


def _ascii_fy(s: str) -> str:
    """Replace known Hermes pictograms with ASCII, then drop any remaining
    non-ASCII chars. Result is guaranteed plain ASCII."""
    for k, v in _ASCII_MAP.items():
        s = s.replace(k, v)
    return s.encode("ascii", errors="ignore").decode("ascii")


def _keep_log_line(line: str) -> bool:
    """Filter out Hermes TUI decoration so the combined log is concise.
    Run AFTER _ascii_fy — assumes the line is pure ASCII.
    Keeps: `mc <cmd>` tool calls, agent response text. Drops: pure
    decoration lines, preparing-terminal noise, banner ASCII art."""
    s = line.rstrip()
    if not s.strip():
        return False
    stripped = s.strip()
    # Pure decoration lines (only +/-/=/| characters after asciify).
    if stripped and all(c in "+-=| \t" for c in stripped):
        return False
    # Banner ASCII-art / braille (was unicode, now stripped to empty/short).
    if len(stripped) < 3:
        return False
    if "preparing terminal" in stripped:
        return False
    if stripped in ("Initializing agent...", "Resume this session with:"):
        return False
    if stripped.startswith(("Session:", "Duration:", "Messages:", "Query:", "hermes --resume", "Resumed session")):
        return False
    if "commits behind" in stripped:
        return False
    return True


def tee_brain_logs(brain_logs: dict[str, Path], combined_path: Path, stop_event: threading.Event) -> threading.Thread:
    """Spawn a daemon thread that tails each brain log and writes a merged
    stream (prefixed by bot name) to `combined_path`. The thread exits when
    `stop_event` is set OR all source files vanish. Strips ANSI escapes."""
    combined_path.parent.mkdir(parents=True, exist_ok=True)
    # Truncate combined log at start so each run gets a fresh file.
    with open(combined_path, "w") as f:
        f.write(f"# G21 combined brain log — started {datetime.now(timezone.utc).isoformat()}\n")

    def _worker():
        # Open each brain log for reading, seek to end so we only tail new
        # lines (the brain log writes from start in launch_brain).
        files: dict[str, Any] = {}
        for name, path in brain_logs.items():
            # Wait briefly for the brain to start writing.
            for _ in range(20):
                if path.exists():
                    break
                if stop_event.is_set():
                    return
                time.sleep(0.2)
            try:
                fh = open(path, "r")
                fh.seek(0)  # read from start — capture init banner
                files[name] = fh
            except FileNotFoundError:
                pass

        out = open(combined_path, "a")
        try:
            while not stop_event.is_set():
                got_any = False
                for name, fh in files.items():
                    line = fh.readline()
                    if line:
                        got_any = True
                        clean = _ascii_fy(_strip_ansi(line.rstrip("\n")))
                        if not _keep_log_line(clean):
                            continue
                        out.write(f"[{name}] {clean}\n")
                        out.flush()
                if not got_any:
                    time.sleep(0.3)
        finally:
            out.close()
            for fh in files.values():
                try:
                    fh.close()
                except Exception:
                    pass

    t = threading.Thread(target=_worker, daemon=True, name="brain-tee")
    t.start()
    return t


# ---------------------------------------------------------------------------
# Phase state machine.


@dataclass
class MissionState:
    spec: dict
    done: bool = False
    done_reason: str = ""       # "keyword" | "predicate" | "timeout"
    done_at_tick: int | None = None
    done_at_wallclock: float | None = None
    warning_fired: bool = False


@dataclass
class PhaseState:
    spec: dict
    missions: list[MissionState]
    start_tick: int = 0
    start_wallclock: float = 0.0
    end_tick: int | None = None
    end_wallclock: float | None = None


@dataclass
class ChatRecord:
    """A deduplicated chat line as observed by either bot. Use (time_ms, from, message)
    as the dedup key — messages are duplicated across both bot's /chat endpoints."""
    time_ms: int
    sender: str   # username string, or "" for [Server] / RCON say
    message: str
    seen_first_by: str   # which bot first surfaced this record


def chat_key(rec: dict) -> tuple[int, str, str]:
    t = int(rec.get("time", 0) or 0)
    f = (rec.get("from") or "")
    m = (rec.get("message") or "")
    return (t, f, m)


def is_steward_chat(rec: dict) -> bool:
    """Heuristic: RCON `say` lines come through with from='Rcon' (PaperMC
    convention). Bot chats have from=<player username>."""
    f = (rec.get("from") or "").lower()
    return f in ("", "server", "rcon")


# ---------------------------------------------------------------------------
# Findings doc writer.


def write_findings(path: Path, spec: dict, args, run_meta: dict, phases: list[PhaseState], chat_log: list[ChatRecord]) -> None:
    """Emit a markdown findings doc summarising the run."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    lines.append(f"# G21 findings — {run_meta['started_iso']}")
    lines.append("")
    lines.append("## Run metadata")
    lines.append(f"- Spec: `{spec.get('agent_test_id')}`")
    lines.append(f"- Model: `{args.model or '(landfolk-control default)'}`")
    lines.append(f"- Started: {run_meta['started_iso']}")
    lines.append(f"- Ended: {run_meta['ended_iso']}")
    lines.append(f"- Wallclock: {run_meta['wallclock_s']:.0f}s")
    lines.append(f"- Verdict: **{run_meta['verdict']}**")
    lines.append("")

    lines.append("## Phase summary")
    lines.append("")
    lines.append("| Phase | Mission | Done? | Reason | Start tick | End tick | Δ ticks | Warning fired |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for ph in phases:
        for mn in ph.missions:
            delta = (mn.done_at_tick - ph.start_tick) if (mn.done_at_tick is not None) else None
            lines.append(
                f"| {ph.spec.get('id')} "
                f"| {mn.spec.get('id') or mn.spec.get('to')} "
                f"| {'✓' if mn.done else '✗'} "
                f"| {mn.done_reason or '—'} "
                f"| {ph.start_tick} "
                f"| {mn.done_at_tick if mn.done_at_tick is not None else '—'} "
                f"| {delta if delta is not None else '—'} "
                f"| {'yes' if mn.warning_fired else 'no'} |"
            )
    lines.append("")

    lines.append("## Chat transcript")
    lines.append("")
    lines.append("```")
    for rec in chat_log:
        ts = datetime.fromtimestamp(rec.time_ms / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        sender = rec.sender or "Server"
        lines.append(f"[{ts}] <{sender}> {rec.message}")
    lines.append("```")
    lines.append("")

    lines.append("## Observations (auto-derived)")
    flint_chats = sum(1 for c in chat_log if (c.sender or "").lower() == "flint")
    mason_chats = sum(1 for c in chat_log if (c.sender or "").lower() == "mason")
    steward_chats = sum(1 for c in chat_log if (c.sender or "").lower() in ("", "server", "rcon"))
    lines.append(f"- Steward broadcasts: {steward_chats}")
    lines.append(f"- Flint chat lines: {flint_chats}")
    lines.append(f"- Mason chat lines: {mason_chats}")
    lines.append(f"- Phases completed via keyword: {sum(1 for ph in phases for m in ph.missions if m.done_reason == 'keyword')}")
    lines.append(f"- Phases completed via predicate fallback: {sum(1 for ph in phases for m in ph.missions if m.done_reason == 'predicate')}")
    lines.append(f"- Phases that hit hard timeout: {sum(1 for ph in phases for m in ph.missions if m.done_reason == 'timeout')}")
    lines.append("")
    path.write_text("\n".join(lines))


# ---------------------------------------------------------------------------
# Main.


def main() -> int:
    p = argparse.ArgumentParser(description="G21 two-bot orchestrator")
    p.add_argument("spec", type=Path, help="path to G21 spec YAML")
    p.add_argument("--model", help="model to use for BOTH bots (sets MODEL_FLINT and MODEL_MASON)")
    p.add_argument("--provider", default="openrouter", help="provider (default: openrouter)")
    p.add_argument("--findings", type=Path, default=Path("docs/experiments/g21-findings.md"), help="findings doc output path")
    p.add_argument("--no-launch-brains", action="store_true", help="don't start Hermes brains (smoke-test mode — bodies only)")
    p.add_argument("--keep-running", action="store_true", help="don't stop bots after the test (debug)")
    p.add_argument("--dry-run", action="store_true", help="print steps but don't run brains or world_setup")
    args = p.parse_args()

    spec_path = args.spec if args.spec.is_absolute() else (HERE / args.spec)
    if not spec_path.exists():
        print(f"ERROR: spec not found: {spec_path}", file=sys.stderr)
        return 2
    spec = load_spec(spec_path)
    bots = spec.get("bots") or []
    if len(bots) < 2:
        print("ERROR: spec must define at least 2 bots", file=sys.stderr)
        return 2

    print(f"G21 orchestrator: spec={spec.get('agent_test_id')}")
    summary = ", ".join(f"{b['name']}:{b['port']}" for b in bots)
    print(f"  bots: {summary}")
    print(f"  model: {args.model or '(spec/config default)'}")
    print(f"  findings: {args.findings}")

    started_at = time.time()
    started_iso = datetime.now(timezone.utc).isoformat()

    # Track launched processes so cleanup can kill them.
    brain_procs: dict[str, subprocess.Popen] = {}
    body_procs: dict[str, subprocess.Popen] = {}
    tee_stop = threading.Event()
    tee_thread: threading.Thread | None = None

    def cleanup_bots():
        # Stop the brain-tee thread before killing brains (so it doesn't read
        # garbage from torn-down files).
        tee_stop.set()
        if tee_thread and tee_thread.is_alive():
            tee_thread.join(timeout=2)
        if args.keep_running:
            print("  --keep-running: leaving bots up")
            return
        if args.dry_run:
            return
        print("  stopping brains + bodies")
        for proc in brain_procs.values():
            try:
                proc.terminate()
            except Exception:
                pass
        for proc in body_procs.values():
            try:
                proc.terminate()
            except Exception:
                pass
        # Give a moment for graceful shutdown.
        time.sleep(2)
        for proc in list(brain_procs.values()) + list(body_procs.values()):
            try:
                if proc.poll() is None:
                    proc.kill()
            except Exception:
                pass
        # Final port-kill safety net.
        for b in bots:
            kill_port(b["port"])

    # SIGINT handling for clean shutdown.
    def sigint_handler(signum, frame):
        print("\nSIGINT — stopping bots and bailing")
        cleanup_bots()
        sys.exit(130)
    signal.signal(signal.SIGINT, sigint_handler)

    # Pre-flight.
    stop_existing_bots(bots)

    # World setup.
    if not args.dry_run:
        ws = spec.get("world_setup") or []
        cmds = [c.get("rcon") for c in ws if isinstance(c, dict) and "rcon" in c]
        if cmds:
            print(f"  world_setup: {len(cmds)} rcon commands")
            out = run_rcon_batch(cmds, timeout=120)
            if "Error" in out:
                print(f"  WARN: some RCON commands errored. Output tail:\n{out[-400:]}")

    log_dir = Path("/tmp/hermescraft-g21")

    # Launch bot bodies (Mineflayer servers).
    if not args.dry_run:
        for b in bots:
            log = log_dir / f"body-{b['name'].lower()}.log"
            print(f"  starting body {b['name']} on :{b['port']} → log={log}")
            body_procs[b["name"]] = launch_bot_body(b["name"], int(b["port"]), env_extra={}, log_path=log)
        print(f"  waiting for both bot bodies to connect...")
        if not wait_bots_connected(bots, timeout_s=90):
            print(f"  ERROR: bot bodies did not connect within 90s")
            cleanup_bots()
            return 1
        print(f"  bodies connected.")

    # Wipe per-bot mark files so old G20 marks (death_1, base, home, ...) don't
    # bleed into the run. This MUST happen after bodies are up — the body owns
    # the file. Best-effort: re-read won't happen until the brain restarts but
    # the bodies cache marks in memory, so we'll re-set via /action/mark below.
    if not args.dry_run:
        for b in bots:
            wipe_bot_marks(b["name"])

    # Post-connect setup — /clear and /effect on players only work when
    # players are connected. We also TP each bot to its safe spawn position
    # so they start exactly where world_setup intended.
    if not args.dry_run:
        post_setup = spec.get("post_connect_setup") or []
        post_cmds = [c.get("rcon") for c in post_setup if isinstance(c, dict) and "rcon" in c]
        if post_cmds:
            print(f"  post_connect_setup: {len(post_cmds)} rcon commands")
            run_rcon_batch(post_cmds, timeout=30)
            time.sleep(2)  # let TPs settle

    # Write marks via HTTP /action/mark. (After body restart, the marks file
    # was wiped — these calls rebuild the bot's in-memory mark table AND
    # persist them back to disk.)
    marks = spec.get("marks") or {}
    if marks and not args.dry_run:
        print(f"  writing {len(marks)} marks to each bot")
        for bot in bots:
            for mname, mdata in marks.items():
                ok = write_mark(bot["port"], mname, int(mdata["x"]), int(mdata["y"]), int(mdata["z"]), mdata.get("note", ""))
                if not ok:
                    print(f"  WARN: mark {mname} → {bot['name']}:{bot['port']} failed")

    # Launch Hermes brains AFTER marks are in place — so the bot's `mc marks`
    # at start-of-session returns the G21 marks rather than an empty list.
    if not args.no_launch_brains and not args.dry_run:
        max_turns = int(spec.get("hermes_session_max_turns", 800))
        for b in bots:
            role_prompt = PROMPTS_DIR / f"{b['profile']}.md"
            prompt = build_brain_prompt(b["name"], role_prompt, spec)
            log = log_dir / f"brain-{b['name'].lower()}.log"
            print(f"  starting brain {b['name']} model={args.model or '(env)'} → log={log}")
            brain_procs[b["name"]] = launch_brain(
                b["name"], int(b["port"]),
                model=args.model, provider=args.provider,
                prompt=prompt, max_turns=max_turns, log_path=log,
            )
        # Start combined-log tee — writes a merged view of both brain logs
        # prefixed by bot name. Tail this for live agent visibility:
        #   tail -F /tmp/hermescraft-g21/combined.log
        brain_log_map = {b["name"]: log_dir / f"brain-{b['name'].lower()}.log" for b in bots}
        combined_path = log_dir / "combined.log"
        tee_thread = tee_brain_logs(brain_log_map, combined_path, tee_stop)
        print(f"  combined brain log → {combined_path}")
        # Wait for both brains to emit "READY:" in chat (their startup handshake).
        ready_targets = [b["name"] for b in bots]
        print(f"  waiting up to 90s for READY handshakes from {ready_targets}...")
        if not wait_for_chat_phrase(bots, "READY:", timeout_s=90, from_each=ready_targets):
            print(f"  WARN: did not see READY from all brains within 90s — proceeding anyway.")
        settle = int(spec.get("launch_settle_seconds", 4))
        print(f"  settle: {settle}s before first mission")
        time.sleep(settle)
    elif args.no_launch_brains and not args.dry_run:
        print(f"  --no-launch-brains: skipping brain launch (smoke mode)")

    # Phase state machine.
    phase_specs = spec.get("phases") or []
    phases: list[PhaseState] = [
        PhaseState(spec=ps, missions=[MissionState(spec=m) for m in (ps.get("missions") or [])])
        for ps in phase_specs
    ]

    warning_lead = int(spec.get("warning_lead_ticks", 1200))
    hard_overtime = int(spec.get("hard_overtime_ticks", 2400))
    poll_interval = float(spec.get("poll_interval_seconds", 3.0))
    chat_count = int(spec.get("chat_history_count", 30))
    wall_max = int(spec.get("global_wallclock_max_seconds", 2700))

    seen_chat_keys: set[tuple[int, str, str]] = set()
    chat_log: list[ChatRecord] = []

    # Seed the seen-keys set with any pre-existing chat so we only react to
    # new lines from this point forward. Otherwise old chats from a prior
    # session bleed in and could falsely trigger keyword matches.
    for bot in bots:
        for rec in bot_chat_history(bot["port"], count=chat_count):
            seen_chat_keys.add(chat_key(rec))

    def poll_chat() -> list[ChatRecord]:
        """Pull /chat from every bot, dedup, append to chat_log, return new records."""
        new_recs: list[ChatRecord] = []
        for bot in bots:
            history = bot_chat_history(bot["port"], count=chat_count)
            for rec in history:
                k = chat_key(rec)
                if k in seen_chat_keys:
                    continue
                seen_chat_keys.add(k)
                cr = ChatRecord(
                    time_ms=k[0], sender=k[1], message=k[2], seen_first_by=bot["name"]
                )
                chat_log.append(cr)
                new_recs.append(cr)
        chat_log.sort(key=lambda c: c.time_ms)
        return new_recs

    def find_keyword(records: list[ChatRecord], keyword: str, sender_filter: str | None) -> ChatRecord | None:
        """Substring keyword match with EXACT-CASE sender filtering.

        Paper's `/say @<name>:` expands to a chat record with sender = the
        lowercased player name (e.g. `mason`), while real bot chats use the
        correct case (`Mason`). Exact-case filtering rejects the steward-side
        false positive while accepting real bot acks. Also rejects sender
        names like `Rcon` / empty / `Server`."""
        bot_names = {b["name"] for b in bots}
        for r in records:
            if keyword in r.message:
                # Always reject steward-side echoes — the mission text itself
                # quotes the keyword phrase (e.g. `emit "M1A DONE" when done`)
                # so a steward broadcast trivially contains the keyword.
                if (r.sender or "").lower() in ("", "server", "rcon", "steward"):
                    continue
                if sender_filter and sender_filter.lower() != "any":
                    if (r.sender or "") != sender_filter:
                        continue
                else:
                    # `keyword_from: any` still requires the sender to be one
                    # of the known bots; rejects rogue players or plugin echoes.
                    if (r.sender or "") not in bot_names:
                        continue
                return r
        return None

    def check_inventory_fallback(mn: MissionState) -> bool:
        fb = mn.spec.get("fallback_inventory")
        if not fb:
            return False
        target_bot = next((b for b in bots if b["name"].lower() == fb["bot"].lower()), None)
        if not target_bot:
            return False
        inv = bot_inventory(target_bot["port"])
        item = fb["item"]
        need = int(fb["min"])
        have = inv.get(item, 0)
        return have >= need

    def get_current_tick() -> int:
        # Sample from the first responding bot.
        for b in bots:
            t = bot_current_tick(b["port"])
            if t is not None:
                return t
        return 0

    # Dry-run: print what would happen and exit cleanly.
    if args.dry_run:
        print("\n── DRY RUN — phase plan ──")
        for ph in phases:
            print(f"  phase {ph.spec.get('id')} parallel={ph.spec.get('parallel', False)}")
            for mn in ph.missions:
                txt = mn.spec.get("text", "")
                print(f"    [{mn.spec.get('id')}] to={mn.spec.get('to')} deadline={mn.spec.get('deadline_tick')} kw={mn.spec.get('done_keyword')!r}")
                print(f"      say: {txt[:120]}{'...' if len(txt) > 120 else ''}")
        print("\nDRY RUN OK — spec parsed and orchestrator initialised cleanly.")
        return 0

    # Run phases.
    final_verdict = "FAIL"
    for ph in phases:
        # Per-phase setup hook — typically TPs bots back to safe coords and
        # cleans up dropped items so each phase starts from a known state.
        # Avoids bots stranded in weird places from the previous phase.
        ph_setup = ph.spec.get("phase_setup") or []
        ph_cmds = [c.get("rcon") for c in ph_setup if isinstance(c, dict) and "rcon" in c]
        if ph_cmds:
            print(f"\n  phase_setup for {ph.spec.get('id')}: {len(ph_cmds)} rcon commands")
            run_rcon_batch(ph_cmds, timeout=30)
            # Brief settle so TPs land before the missions broadcast.
            time.sleep(2)

        ph.start_tick = get_current_tick()
        ph.start_wallclock = time.time() - started_at
        print(f"\n── phase {ph.spec.get('id')} ── start_tick={ph.start_tick} wall={ph.start_wallclock:.0f}s")

        # Broadcast each mission's text. `text` may be a string OR a list
        # of strings — lists are broadcast as separate consecutive chat
        # lines so long missions don't get truncated at 240 chars.
        for mn in ph.missions:
            txt = mn.spec.get("text", "")
            if not txt:
                continue
            parts = txt if isinstance(txt, list) else [txt]
            for part in parts:
                if not part:
                    continue
                print(f"  steward → {mn.spec.get('to')}: {part[:90]}{'...' if len(part) > 90 else ''}")
                steward_say(part)
                time.sleep(0.6)  # gap so bots see each line as distinct

        # Poll loop until every mission in this phase is done OR all timed out.
        while any(not mn.done for mn in ph.missions):
            # Wallclock cap.
            elapsed = time.time() - started_at
            if elapsed > wall_max:
                print(f"  GLOBAL WALLCLOCK CAP HIT ({wall_max}s) — bailing")
                for mn in ph.missions:
                    if not mn.done:
                        mn.done = True
                        mn.done_reason = "wallclock"
                        mn.done_at_wallclock = elapsed
                break

            new_recs = poll_chat()
            cur_tick = get_current_tick()

            for mn in ph.missions:
                if mn.done:
                    continue
                kw = mn.spec.get("done_keyword")
                kw_from = mn.spec.get("keyword_from", "any")
                # Keyword match in new records.
                if kw:
                    hit = find_keyword(new_recs, kw, kw_from)
                    if hit:
                        mn.done = True
                        mn.done_reason = "keyword"
                        mn.done_at_tick = cur_tick
                        mn.done_at_wallclock = time.time() - started_at
                        print(f"  ✓ {mn.spec.get('id')} keyword '{kw}' from {hit.sender or 'Server'} at tick {cur_tick}")
                        continue
                # Predicate fallback.
                if check_inventory_fallback(mn):
                    mn.done = True
                    mn.done_reason = "predicate"
                    mn.done_at_tick = cur_tick
                    mn.done_at_wallclock = time.time() - started_at
                    print(f"  ✓ {mn.spec.get('id')} inventory fallback at tick {cur_tick}")
                    continue
                # Warning (one-shot) if we crossed soft deadline.
                deadline = int(mn.spec.get("deadline_tick", 0) or 0)
                if deadline and not mn.warning_fired:
                    if cur_tick >= (deadline - warning_lead):
                        mn.warning_fired = True
                        addressee = mn.spec.get("to", "all")
                        if addressee == "both":
                            tag = "@flint @mason"
                        elif isinstance(addressee, str):
                            tag = f"@{addressee.lower()}"
                        else:
                            tag = "@flint @mason"
                        remaining = max(0, deadline - cur_tick)
                        # NB: no colon-after-name — `@flint:` triggers the chat
                        # parser's direct-message routing AND Paper's selector
                        # expansion (breaks `from=STEWARD`). Em-dash is safe.
                        warn = f"{tag} — reminder: {mn.spec.get('id')} due in {remaining} ticks, please wrap up. status?"
                        print(f"  steward → warning: {warn}")
                        steward_say(warn)
                # Hard deadline.
                if deadline and cur_tick >= (deadline + hard_overtime):
                    mn.done = True
                    mn.done_reason = "timeout"
                    mn.done_at_tick = cur_tick
                    mn.done_at_wallclock = time.time() - started_at
                    print(f"  ✗ {mn.spec.get('id')} hard timeout at tick {cur_tick}")
            time.sleep(poll_interval)

        ph.end_tick = get_current_tick()
        ph.end_wallclock = time.time() - started_at
        print(f"── phase {ph.spec.get('id')} done at tick {ph.end_tick} ({ph.end_wallclock:.0f}s wall)")

    # Determine verdict. M3 keyword/predicate done = PASS.
    m3_done_well = False
    for ph in phases:
        if ph.spec.get("id") == "M3":
            for mn in ph.missions:
                if mn.done and mn.done_reason in ("keyword", "predicate"):
                    m3_done_well = True
    final_verdict = "PASS" if m3_done_well else "FAIL"

    # Run cleanup RCON.
    if not args.dry_run:
        cl = spec.get("cleanup") or []
        cmds = [c.get("rcon") for c in cl if isinstance(c, dict) and "rcon" in c]
        if cmds:
            run_rcon_batch(cmds, timeout=30)

    ended_at = time.time()
    run_meta = {
        "started_iso": started_iso,
        "ended_iso": datetime.now(timezone.utc).isoformat(),
        "wallclock_s": ended_at - started_at,
        "verdict": final_verdict,
    }

    # Final chat poll to catch any straggling lines.
    poll_chat()

    findings_path = args.findings if args.findings.is_absolute() else (HERE / args.findings)
    write_findings(findings_path, spec, args, run_meta, phases, chat_log)
    print(f"\nFindings → {findings_path}")
    print(f"VERDICT: {final_verdict}  wallclock={ended_at - started_at:.0f}s")

    cleanup_bots()
    return 0 if final_verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
