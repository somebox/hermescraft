#!/usr/bin/env python3
"""Inactive-profile card pauser.

Watches the landfolk-ops board for cards assigned to profiles that are
NOT currently in the active roster (the set of bots `landfolk-session.sh up`
brought online). For each such card it:

  1. Posts a `kanban_comment` explaining the bot is offline
  2. Reassigns the card to `re44` (operator queue) — re44 decides
     whether to wait, archive, or route it to another bot

Without this, any card targeting (e.g.) `gatherer` will cause the gateway
dispatcher to spawn a Hermes worker that, having no bot body, will
typically launch its own bot via `terminal` — surprising the operator
with an unintended player in-game.

Active roster source (in priority order):
  1. $ACTIVE_PROFILES_FILE      (default /tmp/hermescraft/active-profiles)
  2. $ACTIVE_PROFILES env       (csv)
  3. Default: flint,mason,steward

The roster file is plain text, one profile name per line, blanks/comments
allowed. `landfolk-session.sh up` writes it; `landfolk-session.sh down`
removes it.

Profiles NEVER auto-reassigned (treated as virtual / non-bot):
  - re44       (operator lane)
  - default, librarian, worker-a, worker-b  (admin)

Env:
  BOARD                  default landfolk-ops
  POLL_INTERVAL_S        default 20
  FALLBACK_ASSIGNEE      default re44
  DRY_RUN                default 0
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

BOARD = os.environ.get("BOARD", "landfolk-ops")
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "20"))
# Last-resort fallback (used only when no active worker is available).
# When an active worker IS available, the pauser prefers that worker so
# operator (re44) doesn't get spammed with routine work — re44 should
# only receive cards needing human judgement, not "gatherer was offline".
FALLBACK = os.environ.get("FALLBACK_ASSIGNEE", "re44")
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
ROSTER_FILE = Path(os.environ.get("ACTIVE_PROFILES_FILE", "/tmp/hermescraft/active-profiles"))
ROSTER_ENV = os.environ.get("ACTIVE_PROFILES", "")

# Profiles that are valid assignees but never get auto-paused. Add new
# operator/virtual lanes here as the board grows.
NEVER_PAUSE = {"re44", "default", "librarian", "worker-a", "worker-b"}

# Orchestrator-class profiles in the active roster — these route work to
# OTHER profiles; we shouldn't re-route worker-tier cards to them. Cards
# explicitly intended for an orchestrator (decomposed by it, or
# requesting a decision) will already arrive with that assignee.
ORCHESTRATORS = {"steward"}

# Statuses we care about — anything that the dispatcher could promote/claim.
WATCHED_STATUSES = ("todo", "ready", "running")


def load_active_roster() -> set[str]:
    """Set of currently-active profile names (lowercase).

    Roster file format (one line per player):
        <name> [mode]            # mode ∈ kanban|continuous, optional
    Anything after the first whitespace-separated token is treated as
    metadata. Legacy single-name lines remain valid.
    """
    names: set[str] = set()
    if ROSTER_FILE.exists():
        for line in ROSTER_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            first = line.split()[0]
            names.add(first.lower())
        return names
    if ROSTER_ENV:
        for tok in ROSTER_ENV.split(","):
            t = tok.strip().lower()
            if t:
                names.add(t)
        return names
    # Fall back to a sensible default
    return {"flint", "mason", "steward"}


def list_cards(status: str) -> list[dict]:
    r = subprocess.run(
        ["hermes", "kanban", "--board", BOARD, "list", "--status", status, "--json"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return []
    try:
        d = json.loads(r.stdout)
    except Exception:
        return []
    return d if isinstance(d, list) else d.get("tasks", [])


def post_comment(task_id: str, body: str) -> bool:
    r = subprocess.run(
        ["hermes", "kanban", "--board", BOARD, "comment", task_id, "--body", body],
        capture_output=True, text=True,
    )
    return r.returncode == 0


def reassign(task_id: str, to_profile: str, reason: str) -> bool:
    """Reassign using the CLI. Pass --reclaim so the call also handles
    a currently-running claim (no-op if the task isn't running).

    NOTE: the CLI flag is `--reclaim` (not `--reclaim-first` — the latter
    silently lands in argparse as an unknown arg and the whole command
    fails with returncode != 0, so the running-card case never re-routes).
    """
    r = subprocess.run(
        ["hermes", "kanban", "--board", BOARD, "reassign", task_id, to_profile,
         "--reclaim", "--reason", reason],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        # Fall back to plain assign (works only when not running)
        r = subprocess.run(
            ["hermes", "kanban", "--board", BOARD, "assign", task_id, to_profile],
            capture_output=True, text=True,
        )
    return r.returncode == 0


def pick_target(active: set[str]) -> str:
    """Choose the best in-roster destination for a re-route.

    Preference order:
      1. Active worker profiles (roster minus ORCHESTRATORS) — the
         pauser tries to keep work on bots that can actually do it.
         When multiple are present we pick alphabetically; if a future
         load-balancing pass is needed, query the board for current
         todo+running counts and prefer the lightest.
      2. Orchestrator profiles (e.g. steward) — fine for decomposition
         work but won't actually execute mining/building.
      3. ``FALLBACK`` (re44) — operator queue, last resort. Only used
         when the active roster is empty of bots entirely. Keeps re44
         from being spammed when there IS an active worker to take it.
    """
    workers = sorted(p for p in active if p not in ORCHESTRATORS)
    if workers:
        return workers[0]
    orchs = sorted(p for p in active if p in ORCHESTRATORS)
    if orchs:
        return orchs[0]
    return FALLBACK


def handle(card: dict, active: set[str], handled_ids: set[str]) -> None:
    tid = card.get("id")
    assignee = (card.get("assignee") or "").lower()
    title = card.get("title", "")[:80]
    if not tid or not assignee:
        return
    if assignee in active or assignee in NEVER_PAUSE:
        return
    if tid in handled_ids:
        return
    ts = time.strftime("%H:%M:%S")
    target = pick_target(active)
    print(f"[{ts}] {tid} ({assignee}→{target}): {title}")
    body = (
        f"Auto-routed: assignee `{assignee}` is not in the active roster "
        f"({sorted(active)}). Reassigned to **@{target}** so the work can "
        f"proceed without operator intervention.\n\n"
        f"If `{target}` shouldn't own this, options:\n"
        f"- Bring `{assignee}` online via `./scripts/landfolk-session.sh up "
        f"--profiles {assignee}` and reassign back\n"
        f"- Reassign elsewhere via `kanban_reassign`\n"
        f"- Archive if obsolete via `kanban_archive`"
    )
    if DRY_RUN:
        print(f"  DRY: would comment + reassign {tid} → {target}")
        handled_ids.add(tid)
        return
    if post_comment(tid, body):
        print(f"  commented")
    if reassign(tid, target, f"profile_inactive:{assignee}→{target}"):
        print(f"  reassigned → {target}")
        handled_ids.add(tid)
    else:
        print(f"  ERR: reassign failed")


def main() -> int:
    print(f"inactive-cards-pauser: board={BOARD} poll={POLL_INTERVAL_S}s fallback={FALLBACK}")
    print(f"  roster file: {ROSTER_FILE} ({'exists' if ROSTER_FILE.exists() else 'missing — using default'})")
    if DRY_RUN:
        print("  DRY_RUN=1 — no changes")

    handled_ids: set[str] = set()

    def stop(_sig, _frm):
        print("\nstopping")
        sys.exit(0)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    while True:
        try:
            active = load_active_roster()
            for status in WATCHED_STATUSES:
                for card in list_cards(status):
                    handle(card, active, handled_ids)
            # Roster may change at runtime (operator brought a bot up); drop
            # handled cache so we re-check (cheap — handle() short-circuits
            # if assignee is now active).
            if len(handled_ids) > 256:
                handled_ids.clear()
        except Exception as e:
            print(f"  poll error: {e}")
        time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    raise SystemExit(main())
