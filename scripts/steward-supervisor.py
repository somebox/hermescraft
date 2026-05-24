#!/usr/bin/env python3
"""Active steward supervisor — watches the landfolk-ops board for blocked
cards and dispatches the steward profile to review each one. Without this,
blocked cards sit indefinitely until a human notices. With it, every block
is auto-routed to a steward worker that reads the card's events/comments
and decides whether to:

  1. Unblock with a corrective kanban_comment + new guidance
  2. Decompose into smaller, more achievable cards
  3. Reassign to a different worker profile
  4. Confirm the block and escalate (kanban_comment + @user mention)

Implementation: polls `hermes kanban list --status blocked --json` every
POLL_INTERVAL_S. For each card NOT yet supervised since its last block
event, creates a `[SUPERVISE]` triage card assigned to steward, then
optionally `hermes kanban decompose` to spawn the steward worker
immediately (the gateway would pick it up otherwise).

State (last-supervised timestamps per card) lives at
~/.steward-supervisor-state.json so a restart doesn't re-trigger old blocks.

Usage:
    BOARD=landfolk-ops python3 scripts/steward-supervisor.py

Env:
    BOARD             (default landfolk-ops)
    POLL_INTERVAL_S   (default 30 — supervision is not real-time)
    AUTO_DECOMPOSE    (default 1 — spawn steward immediately, else wait for gateway tick)
    STATE_FILE        (default ~/.steward-supervisor-state.json)
    MIN_BLOCK_AGE_S   (default 60 — wait this long after the block event
                       before supervising, so transient blocks don't churn)
    MAX_SUPERVISIONS_PER_CARD (default 2 — after this many supervises, leave alone)
    DRY_RUN           (default 0)

Stop with Ctrl-C.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR / "lib"))
from kanban_block_reason import parse as parse_block_reason

BOARD = os.environ.get("BOARD", "landfolk-ops")
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "30"))
AUTO_DECOMPOSE = os.environ.get("AUTO_DECOMPOSE", "1") == "1"
MIN_BLOCK_AGE_S = float(os.environ.get("MIN_BLOCK_AGE_S", "60"))
MAX_SUPERVISIONS = int(os.environ.get("MAX_SUPERVISIONS_PER_CARD", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
STATE_FILE = Path(os.environ.get(
    "STATE_FILE",
    str(Path.home() / ".steward-supervisor-state.json"),
))


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"cards": {}}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def list_blocked():
    """Returns list of {id, title, assignee} blocked cards on the board."""
    r = subprocess.run(
        ["hermes", "kanban", "--board", BOARD, "list", "--status", "blocked", "--json"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return []
    try:
        data = json.loads(r.stdout)
    except Exception:
        return []
    return data if isinstance(data, list) else data.get("tasks", [])


def show_card(task_id):
    """Returns the full card detail (status, events, comments, runs)."""
    r = subprocess.run(
        ["hermes", "kanban", "--board", BOARD, "show", task_id, "--json"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except Exception:
        return None


def last_block_ms(card_detail):
    """Find the most recent `[run X] blocked` event ms; 0 if none."""
    if not card_detail:
        return 0
    events = card_detail.get("events", [])
    blocked = [e for e in events if e.get("kind") == "blocked"]
    if not blocked:
        return 0
    # `created_at` is a Unix-epoch *seconds* int from hermes kanban (e.g.
    # 1779585352). Older paths emitted `time` in ms or an ISO string under
    # `created_at` — handle all three for forward/back-compat.
    times = []
    for e in blocked:
        ca = e.get("created_at")
        if "time" in e:
            try:
                times.append(int(e["time"]))
            except Exception:
                pass
        elif isinstance(ca, (int, float)):
            # Heuristic: < 10^12 ⇒ seconds, else already ms
            v = int(ca)
            times.append(v * 1000 if v < 10**12 else v)
        elif isinstance(ca, str):
            try:
                times.append(int(time.mktime(time.strptime(ca[:19], "%Y-%m-%dT%H:%M:%S")) * 1000))
            except Exception:
                pass
    return max(times) if times else 0


def last_block_reason(card_detail):
    """Most recent blocked-event reason string, if any."""
    if not card_detail:
        return None
    events = card_detail.get("events") or []
    blocked = [e for e in events if e.get("kind") == "blocked"]
    if not blocked:
        return None
    last = blocked[-1]
    for key in ("reason", "message", "detail", "text"):
        val = last.get(key)
        if val:
            return str(val).strip()
    return None


def create_supervision_card(target_id, target_title, target_assignee, blocked_at_ms, n_prior, block_reason=None):
    title = f"[SUPERVISE] review blocked {target_id}"
    body = (
        f"Steward: review the blocked card and decide next action.\n\n"
        f"## Blocked card\n"
        f"- ID: {target_id}\n"
        f"- Title: {target_title}\n"
        f"- Original assignee: {target_assignee}\n"
        f"- Last block at: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(blocked_at_ms / 1000)) if blocked_at_ms else 'unknown'}\n"
        f"- Supervisions to date: {n_prior}\n\n"
    )
    parsed = parse_block_reason(block_reason) if block_reason else None
    if parsed:
        body += "## Parsed block reason\n"
        for key in ("block_kind", "region_id", "missing", "short_reason", "raw"):
            if parsed.get(key) is not None:
                body += f"- {key}: {parsed[key]}\n"
        body += "\n"
    body += (
        f"## Your task\n"
        f"1. `hermes kanban show {target_id}` — read body, events, comments, runs.\n"
        f"2. Decide ONE action:\n"
        f"   a. **Unblock + comment**: if the block reason can be addressed by a new hint "
        f"      (corrected coords, alternate primitive, missing prerequisite spelled out), "
        f"      post a `kanban_comment` and `kanban_unblock`.\n"
        f"   b. **Decompose**: if the card is too big or has unmet prerequisites, "
        f"      `kanban_create` smaller children with explicit handoff data IN THEIR BODIES "
        f"      (per task #10 — do not point at sibling-comments), link them, then "
        f"      leave the original card blocked or complete it as PARTIAL.\n"
        f"   c. **Reassign**: if the wrong profile got it (e.g. gatherer cards routed today), "
        f"      `kanban_reassign` to flint or mason.\n"
        f"   d. **Confirm block**: if no recovery path is feasible, post a `kanban_comment` "
        f"      with the analysis and leave blocked. Mention @re44 if human action is needed.\n"
        f"3. Complete this supervise card with a one-line `--summary` of the action taken.\n\n"
        f"## Constraints\n"
        f"- Do NOT execute the work yourself — you are the orchestrator.\n"
        f"- Do NOT loop: if this is the {n_prior + 1}th supervision and prior ones didn't help, "
        f"  accept the block and escalate.\n"
        f"- Read prior supervise-card outcomes (if any) before deciding."
    )
    cmd = [
        "hermes", "kanban", "--board", BOARD, "create", title,
        "--assignee", "steward", "--triage",
        "--body", body,
        "--idempotency-key", f"supervise-{target_id}-{blocked_at_ms}",
        "--created-by", "steward-supervisor",
        "--json",
    ]
    if DRY_RUN:
        print(f"DRY: would create supervise card for {target_id} (block #{n_prior + 1})")
        return None
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  ERR create: {r.stderr.strip()[:200]}")
        return None
    m = re.search(r"t_[0-9a-f]+", r.stdout)
    return m.group(0) if m else None


def decompose(supervise_id):
    if not AUTO_DECOMPOSE or DRY_RUN:
        return
    r = subprocess.run(
        ["hermes", "kanban", "--board", BOARD, "decompose", supervise_id],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        print(f"  decomposed → {r.stdout.strip()[:120]}")


# In-game chat broadcasts use Steward's own bot. The supervisor announces
# its actions so re44 (and any watching humans) see what's happening in
# Minecraft without checking the dashboard. Failure is non-fatal — the
# supervise card still got created on the board.
CHAT_BOT_PORT = int(os.environ.get("CHAT_BOT_PORT", "3005"))  # Steward's bot
MC_CLI = str(SCRIPT_DIR.parent / "bin" / "mc")


def chat_announce(message):
    if DRY_RUN:
        print(f"  DRY chat: {message}")
        return
    try:
        env = {**os.environ, "MC_API_URL": f"http://localhost:{CHAT_BOT_PORT}"}
        subprocess.run(
            [MC_CLI, "chat", message],
            capture_output=True, text=True, env=env, timeout=5,
        )
    except Exception as e:
        # Chat is best-effort; don't break the supervisor loop on it
        print(f"  chat-announce failed: {e}")


def main():
    print(f"steward-supervisor: watching board {BOARD} for blocked cards")
    print(f"  poll every {POLL_INTERVAL_S}s, min-block-age {MIN_BLOCK_AGE_S}s, max {MAX_SUPERVISIONS}/card")
    print(f"  state at {STATE_FILE}")
    if DRY_RUN:
        print("  DRY_RUN=1 — no cards will be created")

    state = load_state()

    def stop(_sig, _frm):
        save_state(state)
        print("\nstopping; state saved")
        sys.exit(0)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    while True:
        try:
            blocked_cards = list_blocked()
            now_ms = int(time.time() * 1000)
            for card in blocked_cards:
                tid = card.get("id")
                title = card.get("title", "")
                assignee = card.get("assignee", "?")
                # Skip if title indicates this IS a supervise card (avoid recursion)
                if title.startswith("[SUPERVISE]"):
                    continue

                detail = show_card(tid)
                block_ms = last_block_ms(detail)
                if not block_ms:
                    continue
                age_s = (now_ms - block_ms) / 1000
                if age_s < MIN_BLOCK_AGE_S:
                    # Too fresh — wait for transient blocks to settle
                    continue

                card_state = state["cards"].get(tid, {"supervised": []})
                already = [s for s in card_state["supervised"] if s >= block_ms]
                if already:
                    # Already supervised THIS block event
                    continue
                if len(card_state["supervised"]) >= MAX_SUPERVISIONS:
                    print(f"[{time.strftime('%H:%M:%S')}] {tid} hit max-supervisions ({MAX_SUPERVISIONS}); skipping")
                    continue

                print(f"[{time.strftime('%H:%M:%S')}] supervising {tid} ({assignee}): {title[:60]}")
                block_reason = last_block_reason(detail)
                sup_id = create_supervision_card(
                    tid, title, assignee, block_ms, len(card_state["supervised"]), block_reason=block_reason,
                )
                if sup_id:
                    print(f"  created {sup_id}")
                    decompose(sup_id)
                    # Announce in-game so re44 sees activity in the FPV/chat
                    reason_hint = block_reason[:50] + "..." if block_reason and len(block_reason) > 50 else (block_reason or "no reason")
                    chat_announce(f"supervising {tid} ({assignee}): {reason_hint}")
                    card_state["supervised"].append(block_ms)
                    state["cards"][tid] = card_state
                    save_state(state)
        except Exception as e:
            print(f"  poll error: {e}")

        time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    main()
