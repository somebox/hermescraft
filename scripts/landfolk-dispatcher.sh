#!/usr/bin/env bash
# landfolk-dispatcher.sh — out-of-process kanban dispatcher loop.
#
# Why this exists
# ---------------
# The gateway-embedded dispatcher (`kanban.dispatch_in_gateway: true`) has
# wedged silently 3+ times in this project's short life — gateway stays
# alive, memory monitor still fires, but the dispatcher loop stops
# ticking. Mirrors upstream issues:
#   - NousResearch/hermes-agent#29034 (dispatcher safety / defaults)
#   - NousResearch/hermes-agent#28805 (no per-host config for cap exposure)
#
# This script is a plain `while true` shell loop calling
# `hermes kanban dispatch --max N` once per interval. If the dispatcher
# wedges *inside* the CLI process, the next iteration starts a fresh
# subprocess — no shared state to corrupt.
#
# Per-assignee mutex
# ------------------
# Hermes' `--max N` is a *global* concurrency cap, NOT per-assignee. If
# Flint has three high-priority ready cards, the dispatcher will spawn
# THREE workers against the same mineflayer body — they race, the bot
# walks in circles. For Minecraft, profile=body, so we want exactly one
# worker per profile at any time.
#
# Pre-flight runs each tick: scans all (running+ready) cards grouped by
# assignee. For any assignee with >1 in-flight card, picks the head
# (status=running > ready, then priority desc, then created_at asc) and
# adds a parent dependency link from head → extras. Hermes' `claim_task`
# checks parent-done before promoting ready→running and demotes a
# parent-undone card back to todo — so the extras auto-park in todo
# until the head completes. Native Hermes primitive; no block/unblock
# churn.
#
# The SOUL rule in skills/kanban-worker.md teaches creators to add the
# `--parent` flag at create time, which is the happy path. This pre-flight
# is the deterministic safety net for the cases where creators don't
# comply (e.g., LLM forgets, external script, race).
#
# Usage
# -----
#   scripts/landfolk-dispatcher.sh                       # default: board landfolk-ops, 60s, max=3
#   BOARD=foo INTERVAL=30 MAX=5 scripts/landfolk-dispatcher.sh
#
# Lifecycle
# ---------
# Started/stopped by `scripts/landfolk` alongside the gateway. Not a
# systemd service, not launchd — keep it in the landfolk lifecycle.
set -uo pipefail

BOARD="${BOARD:-landfolk-ops}"
INTERVAL="${INTERVAL:-60}"
MAX="${MAX:-3}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/dispatcher.log}"

mkdir -p "$LOG_DIR"

trap 'echo "[$(date +%H:%M:%S)] dispatcher stopping (SIGTERM)" >>"$LOG_FILE"; exit 0' TERM INT

echo "[$(date +%H:%M:%S)] dispatcher starting: board=$BOARD interval=${INTERVAL}s max=$MAX" >>"$LOG_FILE"

# Pre-flight: per-assignee mutex enforcement via parent links.
# Returns count of new links created this tick (logged when nonzero).
enforce_assignee_mutex() {
  python3 - <<'PYEOF'
import json, subprocess, sys, os
board = os.environ.get("BOARD", "landfolk-ops")
try:
    out = subprocess.check_output(
        ["hermes", "kanban", "--board", board, "list", "--json"],
        text=True, timeout=15,
    )
    cards = json.loads(out)
except Exception as e:
    print(f"  mutex: failed to list cards: {e}", file=sys.stderr)
    print(0)
    sys.exit(0)

# ORCHESTRATOR PROTECTION (2026-05-26):
# Steward runs in continuous-agent mode (her own long-lived process planning
# the board). If the dispatcher ALSO spawns a worker for cards assigned to
# her, the new worker process collides with her continuous process — both
# try to claim port 3005 / session lock, second one dies. After 2 crashes,
# the dispatcher's circuit-breaker auto-blocks the card. Observed
# 2026-05-26 00:17 on t_361c3f3f.
#
# Fix: for any ready card assigned to an orchestrator-role profile, set
# claim_lock to a recognizable marker. The dispatcher's selection SQL is
# `WHERE status='ready' AND claim_lock IS NULL` — claimed cards are
# skipped. Steward's continuous loop still sees the card via `kanban list
# --assignee steward --status ready` (status is unchanged) and can act
# on it via her normal flow (decompose, comment, complete, reassign).
ORCHESTRATOR_PROFILES = {"steward"}
ORCH_CLAIM_LOCK_PREFIX = "orch_continuous:"
ORCH_CLAIM_TTL_SECONDS = 3600  # re-applied each tick; never expires in practice

def _orch_claim_db_path():
    return os.environ.get(
        "HERMES_KANBAN_DB",
        os.path.expanduser(f"~/.hermes/kanban/boards/{board}/kanban.db"),
    )

def park_orchestrator_cards(cards):
    """For each ready card assigned to an orchestrator, set claim_lock so the
    dispatcher skips it. Idempotent: skips cards already locked by us."""
    import sqlite3, time as _t
    locked = 0
    db = _orch_claim_db_path()
    targets = []
    for c in cards:
        a = (c.get("assignee") or "").lower()
        if a not in ORCHESTRATOR_PROFILES:
            continue
        if c.get("status") != "ready":
            continue
        # claim_lock isn't in the json list output — check via SQL below
        targets.append((c["id"], a))
    if not targets:
        return 0
    try:
        with sqlite3.connect(db, timeout=5) as con:
            now = int(_t.time())
            expires = now + ORCH_CLAIM_TTL_SECONDS
            for tid, assignee in targets:
                row = con.execute(
                    "SELECT claim_lock FROM tasks WHERE id=?",
                    (tid,),
                ).fetchone()
                if row is None:
                    continue
                existing_lock = row[0]
                # Already locked by anyone? Don't touch — could be a real
                # in-flight worker we shouldn't fight.
                if existing_lock:
                    continue
                marker = f"{ORCH_CLAIM_LOCK_PREFIX}{assignee}"
                con.execute(
                    "UPDATE tasks SET claim_lock=?, claim_expires=? "
                    "WHERE id=? AND status='ready' AND claim_lock IS NULL",
                    (marker, expires, tid),
                )
                locked += con.total_changes
            con.commit()
    except Exception as e:
        print(f"  mutex: park_orch failed: {e}", file=sys.stderr)
        return 0
    return locked

def release_stale_orchestrator_parks():
    """Counterpart to park_orchestrator_cards: release any claim_lock with the
    orch_continuous: prefix when the card is no longer assigned to an
    orchestrator profile (reassignment) OR claim_expires is in the past.

    Hermes' own release_stale_claims only handles `running` tasks (verified
    in kanban_db.py: 'Reset any running task whose claim has expired').
    A claim_lock on a READY card never gets released by Hermes — so when
    we reassign Steward's card to flint, the lock persists forever and
    dispatch silently ignores the card. Observed 2026-05-26 02:50:
    t_cda2e6d8 sat ready for 8033s with a stuck `orch_continuous:steward`
    lock even though it had been reassigned to flint.
    """
    import sqlite3, time as _t
    db = _orch_claim_db_path()
    released = 0
    try:
        with sqlite3.connect(db, timeout=5) as con:
            now = int(_t.time())
            # Release if assignee is no longer an orchestrator. The orchestrator
            # set must match what park_orchestrator_cards uses; keep them in
            # sync if you add another orchestrator profile.
            placeholders = ",".join(["?"] * len(ORCHESTRATOR_PROFILES))
            params = list(ORCHESTRATOR_PROFILES)
            cur1 = con.execute(
                f"UPDATE tasks SET claim_lock=NULL, claim_expires=NULL "
                f"WHERE claim_lock LIKE ? AND lower(coalesce(assignee,'')) NOT IN ({placeholders})",
                [f"{ORCH_CLAIM_LOCK_PREFIX}%"] + params,
            )
            released += cur1.rowcount
            # Also release if expires has passed (defensive — park_orchestrator_cards
            # re-applies the lock with a fresh TTL each tick, so this should be a
            # rare race, but better than leaking).
            cur2 = con.execute(
                "UPDATE tasks SET claim_lock=NULL, claim_expires=NULL "
                "WHERE claim_lock LIKE ? AND claim_expires IS NOT NULL AND claim_expires < ?",
                (f"{ORCH_CLAIM_LOCK_PREFIX}%", now),
            )
            released += cur2.rowcount
            con.commit()
    except Exception as e:
        print(f"  mutex: release_stale_orch failed: {e}", file=sys.stderr)
    return released

orch_released = release_stale_orchestrator_parks()
if orch_released > 0:
    print(f"  mutex: released {orch_released} stale orchestrator claim_lock(s)", file=sys.stderr)


def prune_cross_assignee_chain_edges():
    """Remove task_links edges where parent.assignee != child.assignee, child is
    still pending (todo/ready), AND parent is not yet resolved (done/archived).

    These edges accumulate when Steward reassigns cards between bots without
    unlinking the previous bot's serial-chain dependencies. Observed
    2026-05-26 03:00: Mason had 6 todo cards stuck because their chain
    parents were still in Flint's queue (running/todo). Steward intended
    Mason to work in parallel; the chain links from before reassignment
    silently re-enforced serial dependency on Flint's progress.

    Heuristic: cross-assignee + child pending + parent not resolved → mutex
    artifact, prune. Legitimate cross-bot domain deps (e.g. "flint mines →
    mason builds") would more typically have parent already done by the time
    consumer activates; if not, the consumer worker would fail on missing
    preconditions and escalate via help-needed:, which Steward can handle.

    Trade-off accepted: occasional false-positive prune of a real cross-bot
    domain dep, recoverable via the worker's failure path. Trade-off
    rejected: silently stranding cards for hours when they should be ready.
    """
    import sqlite3
    db = _orch_claim_db_path()
    pruned = 0
    try:
        with sqlite3.connect(db, timeout=5) as con:
            cur = con.execute("""
                DELETE FROM task_links
                WHERE EXISTS (
                    SELECT 1 FROM tasks p, tasks c
                    WHERE p.id = task_links.parent_id
                      AND c.id = task_links.child_id
                      AND lower(coalesce(p.assignee,'')) != lower(coalesce(c.assignee,''))
                      AND c.status IN ('todo', 'ready')
                      AND p.status NOT IN ('done', 'archived')
                )
            """)
            pruned = cur.rowcount
            con.commit()
    except Exception as e:
        print(f"  mutex: prune_cross_assignee failed: {e}", file=sys.stderr)
    return pruned

chain_pruned = prune_cross_assignee_chain_edges()
if chain_pruned > 0:
    print(f"  mutex: pruned {chain_pruned} stale cross-assignee chain edge(s)", file=sys.stderr)

orch_locked = park_orchestrator_cards(cards)
if orch_locked > 0:
    print(f"  mutex: parked {orch_locked} orchestrator card(s) (skip dispatcher spawn)", file=sys.stderr)

# Build the in-flight set grouped by assignee. running > ready ordering
# ensures we never pick a ready card as head when a running card exists.
# todo is excluded — it's already parked.
    # Include todo so we form the serial chain proactively before
    # recompute_ready promotes them. Otherwise a fan-out parent dep
    # would release every child to ready simultaneously when the head
    # completes — reproducing the race we're trying to prevent.
    # Excludes: done, archived, blocked (operator-attention required).
status_rank = {"running": 0, "ready": 1, "todo": 2}
by_assignee = {}
for c in cards:
    a = c.get("assignee")
    s = c.get("status")
    if not a or s not in status_rank:
        continue
    by_assignee.setdefault(a, []).append(c)

# Lookup of existing parent links for each card so we don't re-link.
# task_links is on-disk; the json list doesn't expose them, so we ask
# hermes for them as a one-shot per-card on demand below.
def has_parent_link(child_id, parent_id):
    # `hermes kanban show <id>` is verbose; cheaper to query the DB.
    # Use sqlite3 directly via the env-pinned KANBAN_DB.
    db = os.environ.get(
        "HERMES_KANBAN_DB",
        os.path.expanduser(f"~/.hermes/kanban/boards/{board}/kanban.db"),
    )
    try:
        import sqlite3
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as con:
            row = con.execute(
                "SELECT 1 FROM task_links WHERE parent_id=? AND child_id=? LIMIT 1",
                (parent_id, child_id),
            ).fetchone()
            return row is not None
    except Exception:
        return False

linked = 0
for assignee, group in by_assignee.items():
    if len(group) < 2:
        continue
    # SERIAL chain (not fan-out!) — A → B → C, each depends only on its
    # predecessor. Fan-out (A→{B,C,D}) would release all extras to ready
    # simultaneously when A completes, reproducing the race we're trying
    # to prevent. Serial guarantees exactly one card promotes at a time.
    #
    # Sort: status (running first, then ready), then priority desc, then
    # created_at asc. The head sits at index 0; each later card depends
    # on its immediate predecessor.
    group.sort(key=lambda c: (
        status_rank.get(c["status"], 9),
        -int(c.get("priority") or 0),
        int(c.get("created_at") or 0),
    ))
    for i in range(1, len(group)):
        prev = group[i - 1]
        curr = group[i]
        if has_parent_link(curr["id"], prev["id"]):
            continue
        try:
            subprocess.run(
                ["hermes", "kanban", "--board", board, "link", prev["id"], curr["id"]],
                check=False, capture_output=True, timeout=10,
            )
            linked += 1
            print(f"  mutex: linked {prev['id']} → {curr['id']} ({assignee} chain)", file=sys.stderr)
        except Exception as e:
            print(f"  mutex: link failed {prev['id']} → {curr['id']}: {e}", file=sys.stderr)

print(linked)
PYEOF
}

while true; do
  ts=$(date +%H:%M:%S)

  # Pre-flight: enforce per-assignee mutex via parent links.
  # Output goes to stderr (logged), tail is the link count on stdout.
  mutex_out=$(BOARD="$BOARD" enforce_assignee_mutex 2>>"$LOG_FILE")
  mutex_linked="${mutex_out//[^0-9]/}"
  if [ -n "$mutex_linked" ] && [ "$mutex_linked" -gt 0 ]; then
    echo "[$ts] mutex: linked $mutex_linked extra card(s) to head" >>"$LOG_FILE"
  fi

  # `hermes kanban dispatch` runs one tick: reclaim stale, detect crashed,
  # promote ready, spawn workers up to --max. Exit code reflects whether
  # the CLI itself succeeded, not whether work was spawned.
  out=$(hermes kanban --board "$BOARD" dispatch --max "$MAX" 2>&1)
  rc=$?
  # Compact summary — full output saved on non-trivial events only.
  spawned=$(echo "$out" | awk '/^Spawned:/ {print $2}')
  reclaimed=$(echo "$out" | awk '/^Reclaimed:/ {print $2}')
  crashed=$(echo "$out" | awk '/^Crashed:/ {print $2}')
  auto_blocked=$(echo "$out" | awk '/^Auto-blocked:/ {print $2}')
  promoted=$(echo "$out" | awk '/^Promoted:/ {print $2}')

  if [ "$rc" -ne 0 ]; then
    echo "[$ts] tick FAILED rc=$rc" >>"$LOG_FILE"
    echo "$out" | sed 's/^/    /' >>"$LOG_FILE"
  elif [ "${spawned:-0}" != "0" ] || [ "${reclaimed:-0}" != "0" ] || \
       [ "${crashed:-0}" != "0" ] || [ "${auto_blocked:-0}" != "0" ] || \
       [ "${promoted:-0}" != "0" ]; then
    echo "[$ts] tick: spawned=$spawned reclaimed=$reclaimed crashed=$crashed promoted=$promoted auto_blocked=$auto_blocked" >>"$LOG_FILE"
  else
    # Heartbeat for quiet ticks. Previously we skipped logging entirely
    # when nothing happened, which made a quiet but functional dispatcher
    # indistinguishable from a hung one — operators (and Steward) couldn't
    # tell a tidy log from a frozen process. 2026-05-26: Steward filed an
    # [INFRA] card declaring the dispatcher offline after 32min of silence;
    # the dispatcher was actually ticking normally on a stable board.
    # One terse line per tick costs ~60 lines/hour, trivially manageable,
    # and gives observability where it was missing.
    echo "[$ts] tick: idle (no spawns / reclaims / promotions / mutex actions)" >>"$LOG_FILE"
  fi

  sleep "$INTERVAL"
done
