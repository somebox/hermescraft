"""Phase 3 contract test — proves the handoff data actually flows.

The architecture in target.md asks each card's worker to read the previous
card's completion metadata. The skill text in agent-miner.md §4 declares
this ("Card metadata via kanban_show includes the parent's completion
fields"), but skill text isn't enforcement. This test reads the recorded
state of a completed scenario C run and asserts that:

  1. Card 1 (navigator) emitted exit_pos in its task_runs metadata.
  2. Card 2 (miner) was spawned with the kanban_show context that contains
     card 1's exit_pos value (as a literal substring) in its messages table.
  3. Card 2 emitted inv_delta in its task_runs metadata.
  4. Card 3 (navigator) was spawned with card 2's inv_delta value visible
     in its messages table.

The test discovers the three card IDs by looking at the most recent
proto-agent-arch tenant cards in created order. It does NOT run the
scenario itself — that's run.sh's job. Re-run as a post-scenario assertion.

Usage:

    HERMES_HOME=$HOME/.hermes-proto-agent-arch \
      python -m pytest prototypes/agent-arch/tests/test_handoff_contract.py -v

You can pin specific card IDs via env to avoid the auto-discovery:

    PROTO_NAV1=t_aaa PROTO_MINER=t_bbb PROTO_NAV2=t_ccc \
      python -m pytest tests/test_handoff_contract.py -v
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

import pytest

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes-proto-agent-arch"))
KANBAN_DB = HERMES_HOME / "kanban.db"
TENANT = os.environ.get("PROTO_TENANT", "proto-agent-arch")


def _connect(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        pytest.skip(f"DB not found: {db_path} — has the scenario been run yet?")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _scenario_cards() -> tuple[str, str, str]:
    """Return (card1_id, card2_id, card3_id) for the most recent scenario C run.

    Honor env overrides. Otherwise look for three cards in `proto-agent-arch`
    tenant with the canonical scenario C titles and pick the most recent
    matching triple.
    """
    env_ids = (
        os.environ.get("PROTO_NAV1"),
        os.environ.get("PROTO_MINER"),
        os.environ.get("PROTO_NAV2"),
    )
    if all(env_ids):
        return env_ids  # type: ignore[return-value]

    conn = _connect(KANBAN_DB)
    rows = conn.execute(
        """
        SELECT id, title, assignee, status, created_at
        FROM tasks
        WHERE tenant = ?
        ORDER BY created_at DESC
        LIMIT 12
        """,
        (TENANT,),
    ).fetchall()
    conn.close()

    # Look for the canonical 3-card pattern in the recent history.
    # Card 1: navigator to :mine_nw:
    # Card 2: miner extract ... at :ore_seam:
    # Card 3: navigator return to :base_anchor:
    triplets = []
    for i in range(len(rows) - 2):
        c1, c2, c3 = rows[i + 2], rows[i + 1], rows[i]  # oldest→newest
        if (
            c1["assignee"] == "pilot-navigator"
            and c2["assignee"] == "pilot-miner"
            and c3["assignee"] == "pilot-navigator"
            and "mine" in (c1["title"] or "").lower()
            and "extract" in (c2["title"] or "").lower()
            and "return" in (c3["title"] or "").lower()
        ):
            triplets.append((c1["id"], c2["id"], c3["id"]))

    if not triplets:
        pytest.skip(
            "No scenario C triple found in recent tenant history — "
            "run `./run.sh scenarios/C-handoff.txt` first."
        )
    return triplets[0]


def _completed_run_metadata(task_id: str) -> dict:
    conn = _connect(KANBAN_DB)
    row = conn.execute(
        """
        SELECT metadata, outcome, status
        FROM task_runs
        WHERE task_id = ? AND outcome = 'completed'
        ORDER BY started_at DESC
        LIMIT 1
        """,
        (task_id,),
    ).fetchone()
    conn.close()
    if not row:
        pytest.fail(f"No completed run for task {task_id}")
    return json.loads(row["metadata"]) if row["metadata"] else {}


def _worker_session_id(task_id: str) -> str:
    md = _completed_run_metadata(task_id)
    sid = md.get("worker_session_id")
    if not sid:
        pytest.fail(f"No worker_session_id in run metadata for {task_id}")
    return sid


def _profile_state_db(profile: str) -> Path:
    return HERMES_HOME / "profiles" / profile / "state.db"


def _message_corpus(profile: str, session_id: str) -> str:
    """Return the concatenated text of all messages in a worker session.

    Used as a flat-text haystack for substring assertions. Includes role
    in each entry so we can later distinguish system-injected handoff
    context from assistant output if we ever want to.
    """
    db = _profile_state_db(profile)
    conn = _connect(db)
    rows = conn.execute(
        """
        SELECT role, content, tool_name, tool_calls, reasoning
        FROM messages
        WHERE session_id = ?
        ORDER BY id
        """,
        (session_id,),
    ).fetchall()
    conn.close()
    parts: list[str] = []
    for row in rows:
        parts.append(f"\n[role={row['role']}]")
        if row["content"]:
            parts.append(row["content"])
        if row["tool_calls"]:
            parts.append(row["tool_calls"])
        if row["tool_name"]:
            parts.append(row["tool_name"])
        if row["reasoning"]:
            parts.append(row["reasoning"])
    return "\n".join(parts)


@pytest.fixture(scope="module")
def scenario_ids():
    return _scenario_cards()


def test_card1_emits_exit_pos(scenario_ids):
    nav1_id, _, _ = scenario_ids
    md = _completed_run_metadata(nav1_id)
    assert "exit_pos" in md, f"navigator card {nav1_id} missing exit_pos"
    assert isinstance(md["exit_pos"], list)
    assert len(md["exit_pos"]) == 3
    print(f"[ok] card1={nav1_id} exit_pos={md['exit_pos']}")


def test_card2_received_card1_exit_pos(scenario_ids):
    """The miner's worker session must contain card 1's exit_pos value.

    This is the load-bearing assertion: the skill text says "read the
    parent's exit_pos" but the actual delivery happens through
    kanban_show / worker spawn context. We probe by checking whether the
    parent's exit_pos value literally appears in the miner's message log."""
    nav1_id, miner_id, _ = scenario_ids
    parent_md = _completed_run_metadata(nav1_id)
    expected = parent_md["exit_pos"]

    miner_session = _worker_session_id(miner_id)
    corpus = _message_corpus("pilot-miner", miner_session)

    # Look for the coords as a JSON-style triple (preferred form from
    # kanban_show metadata serialization) or as a comma-separated tuple.
    json_form = json.dumps(expected, separators=(", ", ": "))
    compact = ",".join(str(v) for v in expected)
    found_json = json_form in corpus
    found_compact = compact in corpus

    assert found_json or found_compact, (
        f"miner card {miner_id} session {miner_session} did NOT contain "
        f"card 1's exit_pos {expected}. Either the kanban_show context "
        f"didn't include parent metadata, or the skill never read it."
    )
    print(f"[ok] miner saw parent exit_pos={expected} "
          f"(json={found_json}, compact={found_compact})")


def test_card2_emits_inv_delta(scenario_ids):
    _, miner_id, _ = scenario_ids
    md = _completed_run_metadata(miner_id)
    assert "inv_delta" in md, (
        f"miner card {miner_id} did not emit inv_delta — skill text says "
        f"it should. Got metadata: {sorted(md.keys())}"
    )
    inv = md["inv_delta"]
    assert isinstance(inv, dict) and inv, f"inv_delta should be a non-empty dict; got {inv!r}"
    print(f"[ok] card2={miner_id} inv_delta={inv}")


def test_card3_received_card2_inv_delta(scenario_ids):
    """The final navigator must have access to the miner's inv_delta.

    Symmetric to test_card2_received_card1_exit_pos but on the
    miner → navigator boundary."""
    _, miner_id, nav2_id = scenario_ids
    miner_md = _completed_run_metadata(miner_id)
    expected = miner_md["inv_delta"]

    nav2_session = _worker_session_id(nav2_id)
    corpus = _message_corpus("pilot-navigator", nav2_session)

    # Check that EVERY key/value pair from inv_delta appears in the corpus.
    missing = []
    for item, count in expected.items():
        # JSON dict serialization: "item_name": count
        if f'"{item}": {count}' in corpus or f'"{item}":{count}' in corpus:
            continue
        # Loose form: the item name alone (rare collision risk on common words)
        if item in corpus and str(count) in corpus:
            continue
        missing.append((item, count))

    assert not missing, (
        f"final navigator card {nav2_id} did NOT see miner's inv_delta "
        f"{expected}; missing entries: {missing}"
    )
    print(f"[ok] final navigator saw miner's inv_delta keys: {list(expected.keys())}")


def test_card3_returns_to_base_anchor(scenario_ids):
    """Soft check: the final navigator should arrive at base_anchor."""
    _, _, nav2_id = scenario_ids
    md = _completed_run_metadata(nav2_id)
    assert md.get("arrived_at") == "base_anchor", (
        f"final navigator did not arrive at base_anchor; "
        f"arrived_at={md.get('arrived_at')}"
    )
    print(f"[ok] card3={nav2_id} arrived_at=base_anchor, "
          f"distance={md.get('distance_from_mark')}")
