"""The gate-check pass — one idempotent SQL sweep per dispatcher tick.

Run by ``hermes landfolk gate-check`` immediately before
``hermes kanban dispatch``. Five steps in order:

  1. Release stale orchestrator claim_locks (reassignment artifacts,
     expired TTLs).
  2. Park orchestrator-assigned ready cards by writing
     ``claim_lock=orch_continuous:<assignee>`` so the dispatcher skips
     them.
  3. For each non-orchestrator assignee with cards in ``{ready, running}``,
     demote excess back to ``todo`` (keep at most one, plus any
     ``[CHAT_REQUEST]`` cards).
  4. For each non-orchestrator assignee with no active card, promote
     the highest-priority eligible ``todo`` card.
  5. Commit + return a stats dict the CLI prints.

The function never raises on individual SQL errors — they're logged to
``LOG_PATH`` and counted in the stats dict's ``errors`` field. The
dispatcher script's ``|| echo "gate-check FAILED"`` only triggers on
exit code, which we reserve for catastrophic failure (e.g. db file
missing).
"""

from __future__ import annotations

import json
import time
from typing import Any

import sqlite3  # noqa: I001

from . import config
from .mutex_key import mutex_key
from .promote import (
    _append_event,
    is_chat_request,
    park_via_lock,
    promote_next_for,
    release_mutex_lock,
)


def gate_check(conn: sqlite3.Connection) -> dict[str, int]:
    """One idempotent gate-check pass against *conn*.

    Returns a stats dict — keys are sortable and stable so log lines
    can be diffed across ticks.
    """
    stats: dict[str, int] = {
        "orch_released": 0,
        "orch_parked": 0,
        "mutex_released": 0,
        "mutex_parked": 0,
        "promoted": 0,
        "errors": 0,
    }

    if config.DISABLE_GATE:
        return stats

    now = int(time.time())
    expires = now + config.LOCK_TTL_SECONDS
    orch_profiles = list(config.ORCHESTRATOR_PROFILES)

    # ----- Step 1: release stale orchestrator parks -----------------
    # The lock survives reassignment in stock Hermes (release_stale_claims
    # only sweeps `running` tasks). If a card's assignee is no longer in
    # the orchestrator set OR the claim_expires is in the past, free it.
    if orch_profiles:
        try:
            placeholders = ",".join("?" * len(orch_profiles))
            cur = conn.execute(
                f"""
                UPDATE tasks
                SET claim_lock = NULL, claim_expires = NULL
                WHERE claim_lock LIKE ?
                  AND lower(coalesce(assignee, '')) NOT IN ({placeholders})
                """,
                [f"{config.ORCH_LOCK_PREFIX}%", *orch_profiles],
            )
            stats["orch_released"] += cur.rowcount
        except sqlite3.Error:
            stats["errors"] += 1
    # Defensive: release expired locks even when the assignee is still
    # an orchestrator. Step 2 below re-applies the lock with a fresh TTL.
    try:
        cur = conn.execute(
            """
            UPDATE tasks
            SET claim_lock = NULL, claim_expires = NULL
            WHERE claim_lock LIKE ?
              AND claim_expires IS NOT NULL
              AND claim_expires < ?
            """,
            (f"{config.ORCH_LOCK_PREFIX}%", now),
        )
        stats["orch_released"] += cur.rowcount
    except sqlite3.Error:
        stats["errors"] += 1

    # ----- Step 2: park ready cards assigned to orchestrators -------
    if orch_profiles:
        try:
            placeholders = ",".join("?" * len(orch_profiles))
            rows = conn.execute(
                f"""
                SELECT id, lower(coalesce(assignee, '')) AS assignee_lc
                FROM tasks
                WHERE status = 'ready'
                  AND claim_lock IS NULL
                  AND lower(coalesce(assignee, '')) IN ({placeholders})
                """,
                orch_profiles,
            ).fetchall()
            for row in rows:
                marker = f"{config.ORCH_LOCK_PREFIX}{row['assignee_lc']}"
                cur = conn.execute(
                    """
                    UPDATE tasks
                    SET claim_lock = ?, claim_expires = ?
                    WHERE id = ?
                      AND status = 'ready'
                      AND claim_lock IS NULL
                    """,
                    (marker, expires, row["id"]),
                )
                if cur.rowcount:
                    stats["orch_parked"] += 1
        except sqlite3.Error:
            stats["errors"] += 1

    # ----- Step 3: per-key head selection + park/release ----------
    # Unified pass: for each non-orchestrator mutex domain (bot-tagged
    # cards key on the bot; untagged cards key on assignee), pick the
    # rightful head purely by ordering (running first, then priority
    # DESC, created_at ASC, ignoring lock state). Release any mutex_park
    # lock on the head. Park all other ready siblings (except chat-
    # requests) that aren't already locked by something else.
    #
    # The mutex domain (vs raw assignee) means two cards on
    # ``assignee=navigator`` with different ``[bot:...]`` tags promote
    # concurrently — different keys, different queues. Two cards with
    # the same bot tag (across any assignee) serialize.
    #
    # This re-evaluates every tick, so priority changes on a parked
    # card promote it to head correctly, and the previous head (now
    # outranked) gets re-parked.
    try:
        # Walk every active card and compute its mutex key. Orchestrator
        # assignees are excluded (they have their own parking lane).
        rows = conn.execute(
            """
            SELECT id, title, status, assignee, priority, created_at, claim_lock
            FROM tasks
            WHERE status IN ('ready', 'running')
              AND assignee IS NOT NULL
            """,
        ).fetchall()

        # Group by mutex key.
        keyed: dict[str, list[Any]] = {}
        for row in rows:
            assignee_lc = (row["assignee"] or "").lower()
            if orch_profiles and assignee_lc in orch_profiles:
                continue
            key = mutex_key(row["assignee"], row["title"])
            if not key:
                continue
            keyed.setdefault(key, []).append(row)

        for key, cards in keyed.items():
            cards.sort(
                key=lambda c: (
                    0 if c["status"] == "running" else 1,
                    -(c["priority"] or 0),
                    c["created_at"] or 0,
                )
            )

            # Pick the head — first running, OR first non-chat-request
            # ready card.
            head_id: str | None = None
            head_lock: str | None = None
            for c in cards:
                if c["status"] == "running":
                    head_id = c["id"]
                    head_lock = c["claim_lock"]
                    break
                if is_chat_request(c["title"]):
                    continue
                head_id = c["id"]
                head_lock = c["claim_lock"]
                break

            if head_id is None:
                # All ready cards are chat-requests — leave everything alone.
                continue

            # Release the head's mutex lock if it has one (priority-promote case).
            if head_lock and head_lock.startswith(config.MUTEX_LOCK_PREFIX):
                if release_mutex_lock(conn, head_id):
                    stats["mutex_released"] += 1

            # Park all other ready cards — except chat-requests, except
            # cards with foreign locks (real worker claims, orch parks).
            for c in cards:
                if c["id"] == head_id:
                    continue
                if c["status"] != "ready":
                    continue  # never park running
                if is_chat_request(c["title"]):
                    continue
                existing_lock = c["claim_lock"] or ""
                if existing_lock and not existing_lock.startswith(config.MUTEX_LOCK_PREFIX):
                    continue  # foreign lock (orch_continuous, real worker claim)
                if existing_lock.startswith(config.MUTEX_LOCK_PREFIX):
                    continue  # already parked
                if park_via_lock(conn, c["id"], key, "per_key_mutex", expires):
                    stats["mutex_parked"] += 1
    except sqlite3.Error:
        stats["errors"] += 1

    # ----- Step 5: promote next-best for idle mutex keys ---------------
    # An idle key has at least one todo and zero ready/running
    # (excluding chat-requests, which never count as the head). Bot
    # tagging is honoured here too: ``[bot:pip]`` tagged todos sit in
    # a separate queue from untagged ``navigator`` todos.
    try:
        todo_rows = conn.execute(
            """
            SELECT id, assignee, title
            FROM tasks
            WHERE status = 'todo'
              AND assignee IS NOT NULL
            """,
        ).fetchall()
        idle_keys: set[str] = set()
        for row in todo_rows:
            assignee_lc = (row["assignee"] or "").lower()
            if orch_profiles and assignee_lc in orch_profiles:
                continue
            k = mutex_key(row["assignee"], row["title"])
            if k:
                idle_keys.add(k)

        for k in sorted(idle_keys):
            if promote_next_for(conn, k):
                stats["promoted"] += 1
    except sqlite3.Error:
        stats["errors"] += 1

    # ----- Step 6: commit ------------------------------------------
    try:
        conn.commit()
    except sqlite3.Error:
        stats["errors"] += 1

    return stats


def format_stats(stats: dict[str, int]) -> str:
    """One-line summary suitable for the dispatcher log."""
    return (
        f"orch: promoted={stats.get('promoted', 0)} "
        f"mutex_parked={stats.get('mutex_parked', 0)} "
        f"mutex_released={stats.get('mutex_released', 0)} "
        f"orch_parked={stats.get('orch_parked', 0)} "
        f"orch_released={stats.get('orch_released', 0)}"
        + (f" errors={stats['errors']}" if stats.get("errors") else "")
    )
