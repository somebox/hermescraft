"""Minimal @overseer review loop.

Concern 4 of the colony validation plan (Session 3). Polls the proto
kanban DB for cards that hit `blocked` status with a structured reason
prefix, and files a `[REVIEW]` card linking back. Idempotent: re-runs
won't create duplicate reviews for the same (blocked_card, current
outcome) pair.

Design rationale:

- **Poll, not WS.** A WS subscriber would be more production-aligned, but
  the loop's correctness is the question, not its delivery mechanism. The
  contract test asserts on kanban DB state; WS vs poll is a deployment
  detail. Poll cadence is configurable; default 5 s for tests, 60 s in
  practice.

- **`metadata.review_of: <card_id>` for linkage.** Distinct from the
  `parents` system used for chain-blocking. Easy to dedup
  (`json_extract(metadata, '$.review_of') = ?`). Survives reassignment.

- **Closed reason-prefix set.** Architecture's `board-dynamics.md` § 6
  reserves `world_state_mismatch:` and `dead_mid_card:` for `@dispatcher`
  auto-repair. Overseer covers the rest: `resource_not_found:`,
  `tool_required:`, `nav_needs_<role>:`, `combat_blocked:`,
  `awaiting_operator_approval:`. Unknown prefixes still get a review,
  flagged with `unrecognized_prefix=True` so the operator can decide.

- **One review per (blocked card, current outcome).** If the blocked card
  is unblocked and later re-blocked, a second review fires (the previous
  one is closed by then). Implementation: query for any existing review
  card whose `metadata.review_of = id` AND whose status is not done /
  archived.

Used by `prototypes/agent-arch/tests/test_overseer_contract.py`. Also
runnable as a script for ad-hoc operator use.

Usage:

    python -m overseer.review_loop --once --kanban-db ~/.hermes-proto-agent-arch/kanban.db \
        --tenant proto-agent-arch
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

# Block-reason prefixes the @overseer recognizes. The architecture's
# `board-dynamics.md` reserves world_state_mismatch / dead_mid_card for
# `@dispatcher`; overseer covers the rest. New prefixes can extend this
# set without altering the contract.
RECOGNIZED_PREFIXES = (
    "resource_not_found",
    "tool_required",
    "nav_needs",  # matches nav_needs_miner, nav_needs_builder, etc.
    "combat_blocked",
    "awaiting_operator_approval",
)


@dataclass(frozen=True)
class BlockSignal:
    """One blocked event the overseer might respond to."""

    task_id: str
    blocked_at: int          # task_events.created_at (epoch seconds)
    reason: str              # the full reason string
    prefix: str              # parsed prefix (e.g. "resource_not_found"); "" if unrecognized
    rest: str                # everything after the first ":" — e.g. "iron_ore"
    tenant: str | None       # task's tenant, copied to the review card


def parse_prefix(reason: str) -> tuple[str, str]:
    """Return (prefix, rest). prefix is "" if no recognized prefix matches."""
    if not reason:
        return "", ""
    head, sep, rest = reason.partition(":")
    head = head.strip()
    if not sep:
        return "", reason.strip()
    for p in RECOGNIZED_PREFIXES:
        if head == p or head.startswith(p + "_"):
            return head, rest.strip()
    return "", reason.strip()


def find_pending_blocks(conn: sqlite3.Connection, tenant: str | None = None) -> list[BlockSignal]:
    """Find blocked events on still-blocked tasks that don't yet have an
    open review card."""
    where_tenant = "AND t.tenant = ?" if tenant else ""
    params: tuple = (tenant,) if tenant else ()

    # Latest block event per task on tasks currently status=blocked,
    # excluding tasks that already have an open [REVIEW] card linking back.
    sql = f"""
    WITH latest_block AS (
        SELECT e.task_id, MAX(e.id) AS last_block_id
        FROM task_events e
        JOIN tasks t ON t.id = e.task_id
        WHERE e.kind = 'blocked'
          AND t.status = 'blocked'
          {where_tenant}
        GROUP BY e.task_id
    )
    SELECT
        e.task_id,
        e.created_at,
        e.payload,
        t.tenant
    FROM latest_block lb
    JOIN task_events e ON e.id = lb.last_block_id
    JOIN tasks t ON t.id = e.task_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM tasks r
        WHERE json_extract(r.body, '$') IS NOT NULL  -- tolerate NULL bodies
          AND r.title LIKE '[REVIEW]%'
          AND json_extract(r.idempotency_key, '$') IS NOT NULL  -- placeholder
    ) OR NOT EXISTS (
        -- Open review = review card not in done/archived state
        SELECT 1
        FROM tasks r
        WHERE r.title LIKE '[REVIEW]%'
          AND json_extract(coalesce(json_object('review_of', '__null__'), '{{}}'), '$.review_of') = e.task_id
    )
    """
    # Note: the dedup CTE above is intentionally permissive; the actual
    # dedup happens via per-task lookup in `has_open_review`. SQLite's
    # JSON support over body/idempotency_key is too brittle to use as the
    # gate here; we filter in Python below for clarity.

    out: list[BlockSignal] = []
    cur = conn.execute(
        f"""
        SELECT e.task_id, e.created_at, e.payload, t.tenant
        FROM task_events e
        JOIN tasks t ON t.id = e.task_id
        WHERE e.kind = 'blocked'
          AND t.status = 'blocked'
          {where_tenant}
        ORDER BY e.id DESC
        """,
        params,
    )
    seen: set[str] = set()
    for task_id, created_at, payload, t_tenant in cur:
        if task_id in seen:
            continue  # only the latest block per task
        seen.add(task_id)

        reason = ""
        if payload:
            try:
                reason = (json.loads(payload) or {}).get("reason") or ""
            except json.JSONDecodeError:
                reason = payload  # raw string fallback
        prefix, rest = parse_prefix(reason)
        if has_open_review(conn, task_id):
            continue
        out.append(BlockSignal(
            task_id=task_id,
            blocked_at=int(created_at or 0),
            reason=reason,
            prefix=prefix,
            rest=rest,
            tenant=t_tenant,
        ))
    return out


def has_open_review(conn: sqlite3.Connection, blocked_task_id: str) -> bool:
    """True if there's already a [REVIEW] card pointing at this task and
    not yet done/archived."""
    cur = conn.execute(
        """
        SELECT 1
        FROM tasks r
        JOIN task_events ev ON ev.task_id = r.id AND ev.kind = 'review_link'
        WHERE r.title LIKE '[REVIEW]%'
          AND json_extract(ev.payload, '$.review_of') = ?
          AND r.status NOT IN ('done', 'archived')
        LIMIT 1
        """,
        (blocked_task_id,),
    )
    return cur.fetchone() is not None


def file_review_card(
    conn: sqlite3.Connection,
    signal: BlockSignal,
    *,
    assignee: str = "overseer",
) -> str:
    """Create a [REVIEW] card linking back to the blocked task. Returns the
    new card id."""
    review_id = "t_" + uuid.uuid4().hex[:8]
    short_reason = signal.reason.replace("\n", " ").strip()
    if len(short_reason) > 100:
        short_reason = short_reason[:97] + "..."
    title_tag = signal.prefix or "unknown_reason"
    title = f"[REVIEW] {title_tag} on {signal.task_id}"
    body = (
        f"Card {signal.task_id} is blocked.\n\n"
        f"Reason: {short_reason}\n\n"
        f"Parsed prefix: {signal.prefix or '(unrecognized)'}\n"
        f"Parsed rest:   {signal.rest}\n\n"
        f"Next step: investigate, then resolve the underlying issue and "
        f"`kanban_unblock {signal.task_id}` with a comment explaining the fix."
    )
    now = int(time.time())
    conn.execute(
        """
        INSERT INTO tasks (
            id, title, body, assignee, status, priority, created_by,
            created_at, workspace_kind, tenant
        ) VALUES (?, ?, ?, ?, 'todo', 50, 'overseer', ?, 'scratch', ?)
        """,
        (review_id, title, body, assignee, now, signal.tenant),
    )
    # `review_link` event is the durable linkage — easier to query than
    # task-body JSON, doesn't require a metadata column on `tasks`.
    conn.execute(
        """
        INSERT INTO task_events (task_id, kind, payload, created_at)
        VALUES (?, 'review_link', ?, ?)
        """,
        (review_id, json.dumps({
            "review_of": signal.task_id,
            "reason": signal.reason,
            "prefix": signal.prefix,
            "rest": signal.rest,
            "unrecognized_prefix": signal.prefix == "",
        }), now),
    )
    conn.commit()
    return review_id


def run_once(db_path: str | Path, tenant: str | None = None) -> list[str]:
    """One pass. Returns list of newly-created review card ids."""
    conn = sqlite3.connect(str(db_path))
    try:
        signals = find_pending_blocks(conn, tenant=tenant)
        created: list[str] = []
        for s in signals:
            created.append(file_review_card(conn, s))
        return created
    finally:
        conn.close()


def run_loop(db_path: str | Path, interval_s: float, tenant: str | None = None) -> None:
    """Forever loop. SIGINT to stop. Mainly for ad-hoc operator use."""
    while True:
        created = run_once(db_path, tenant=tenant)
        if created:
            print(f"[overseer] filed {len(created)} review card(s): {created}")
        time.sleep(interval_s)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--kanban-db", required=True, help="Path to proto kanban.db")
    p.add_argument("--tenant", default=None, help="Restrict to one tenant (recommended)")
    p.add_argument("--once", action="store_true", help="Single pass, then exit (for tests / cron)")
    p.add_argument("--interval", type=float, default=60.0, help="Poll interval seconds (default 60)")
    args = p.parse_args(argv)

    if args.once:
        created = run_once(args.kanban_db, tenant=args.tenant)
        print(f"filed {len(created)}: {created}")
        return 0
    run_loop(args.kanban_db, args.interval, tenant=args.tenant)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
