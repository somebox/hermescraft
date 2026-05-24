#!/usr/bin/env python3
"""Active steward supervisor — watches the landfolk-ops board for blocked
cards and dispatches **one** steward worker per block event. The steward
reads the card's events/comments and chooses exactly one action:

  1. Unblock + comment (corrective hint or new prerequisite)
  2. Decompose into smaller children with handoff data inline
  3. Reassign to a different worker profile
  4. Archive (stale / obsolete / superseded)
  5. Open a `[BUG]` / `[INCIDENT]` card for re44 when the block is caused
     by a tool defect, failing `mc` verb, or other dev-track issue, then
     confirm the original block and move on.

Implementation: polls `hermes kanban list --status blocked --json` every
POLL_INTERVAL_S. For each card NOT yet supervised since its last block
event, creates a single supervise card directly in `todo` (no `--triage`,
no auto-decompose). The dispatcher spawns one steward worker that performs
the chosen action and completes the card. No inspect / decide / execute
ceremony chain.

State (last-supervised timestamps per card) lives at
~/.steward-supervisor-state.json so a restart doesn't re-trigger old blocks.

Usage:
    BOARD=landfolk-ops python3 scripts/steward-supervisor.py

Env:
    BOARD             (default landfolk-ops)
    POLL_INTERVAL_S   (default 30 — supervision is not real-time)
    AUTO_DECOMPOSE    (default 0 — keep supervise cards as a single action;
                       set 1 only if you explicitly want fan-out)
    STATE_FILE        (default ~/.steward-supervisor-state.json)
    MIN_BLOCK_AGE_S   (default 60 — wait this long after the block event
                       before supervising, so transient blocks don't churn)
    MAX_SUPERVISIONS_PER_CARD (default 1 — one steward pass per block; if
                       that doesn't fix it, escalate via a BUG card)
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
AUTO_DECOMPOSE = os.environ.get("AUTO_DECOMPOSE", "0") == "1"
MIN_BLOCK_AGE_S = float(os.environ.get("MIN_BLOCK_AGE_S", "60"))
MAX_SUPERVISIONS = int(os.environ.get("MAX_SUPERVISIONS_PER_CARD", "1"))
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


BUG_HINT_PATTERNS = (
    "iteration budget exhausted",
    "internal error",
    "action_contract_violation",
    "ok=true && mined_count",
    "mc craft",
    "enoent",
    "econnrefused",
    "traceback",
    "unhandled exception",
)


def looks_like_bug(block_reason):
    if not block_reason:
        return False
    low = block_reason.lower()
    return any(p in low for p in BUG_HINT_PATTERNS)


def create_supervision_card(target_id, target_title, target_assignee, blocked_at_ms, n_prior, block_reason=None):
    title = f"[SUPERVISE] {target_id}"
    when = (
        time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(blocked_at_ms / 1000))
        if blocked_at_ms else 'unknown'
    )
    parsed = parse_block_reason(block_reason) if block_reason else None
    bug_hint = looks_like_bug(block_reason)

    body = (
        "Steward: one session, one action. Do NOT decompose this card into "
        "inspect/decide/execute children — perform the action inline and complete.\n\n"
        "## Blocked card\n"
        f"- ID: {target_id}\n"
        f"- Title: {target_title}\n"
        f"- Original assignee: {target_assignee}\n"
        f"- Last block at: {when}\n"
        f"- Supervisions to date: {n_prior} (max {MAX_SUPERVISIONS})\n\n"
    )
    if block_reason:
        body += f"## Block reason (verbatim)\n```\n{block_reason}\n```\n\n"
    if parsed:
        body += "## Parsed block reason\n"
        for key in ("block_kind", "region_id", "missing", "short_reason", "raw"):
            if parsed.get(key) is not None:
                body += f"- {key}: {parsed[key]}\n"
        body += "\n"
    if bug_hint:
        body += (
            "## Heuristic\n"
            "Block reason matches a known tool/code-defect pattern. **Strongly consider "
            "option (e) Open BUG card** in addition to whatever action you take on the "
            "original card.\n\n"
        )

    body += (
        "## Choose ONE action, execute it now, then `kanban_complete` this card\n"
        f"a. **Unblock + comment** — new hint is enough: `kanban_comment {target_id}` + "
        f"`kanban_unblock {target_id}`.\n"
        f"b. **Decompose** — card too big or missing prerequisites: `kanban_create` smaller "
        f"   children with handoff data inlined in their bodies, `kanban_link` them, leave "
        f"   the parent blocked or complete it PARTIAL.\n"
        f"c. **Reassign** — wrong profile: `kanban_reassign {target_id} --assignee <name>`.\n"
        f"d. **Archive** — stale/obsolete/superseded: `kanban_archive {target_id}`.\n"
        f"e. **Open BUG/INCIDENT card** — block is caused by a tool defect, failing `mc` "
        f"   verb, API error, or other dev-track issue that bots cannot fix:\n"
        f"   - `kanban_create \"[BUG] <short symptom>\" --assignee re44` with a body that "
        f"     includes: symptom, exact command + args, expected vs actual, reproduce steps, "
        f"     affected card ids, log/run pointers, suggested next step.\n"
        f"   - Then on the original blocked card, `kanban_comment` referencing the BUG id "
        f"     and either leave it blocked or archive it depending on recoverability.\n"
        f"   - See minecraft-steward-survey skill § BUG / INCIDENT cards for the body schema.\n\n"
        "## Constraints\n"
        f"- One steward session. Do NOT create [SUPERVISE] / [INSPECT] / [DECIDE] / [EXECUTE] "
        f"  child cards for this review — they cost more than they save.\n"
        f"- BUG cards are for **re44** (human dev lane); do NOT assign them to bots.\n"
        f"- If this is the {n_prior + 1}th supervision and prior passes didn't help, "
        f"  prefer option (e) BUG + archive/confirm — don't try the same fix again."
    )
    cmd = [
        "hermes", "kanban", "--board", BOARD, "create", title,
        "--assignee", "steward",
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
