"""Session 2 colony test — proves the chest object-state done-ness pattern
(Concern 2 variant 2).

This test exercises the live `mc verify chest_contains` verb via Tester.
The pattern a real worker would use:

    1. Worker reads its card body: "deposit ≥4 cobblestone at :storage:"
    2. Worker walks to :storage: (mc move @storage)
    3. Worker deposits (mc deposit ...)
    4. Worker self-checks: mc verify chest_contains storage cobblestone 4
    5. If satisfied=true → kanban_complete with the observed block
       as metadata.acceptance_evidence
    6. If satisfied=false → continue working or kanban_block

This test stubs out the "worker mined and deposited" with rcon-driven chest
state, then exercises mc verify directly. The verb-shape assertion is what
matters; the worker's path to that state is tested in other concerns.

Prereq:
  - Tester running on :3004 (scripts/run-tester-bot.sh)
  - C0 arena fixture prepped (scripts/run-fixture.sh prep
    data/test-fixtures/colony/C0_colony_arena.yaml) so :storage: is in
    Tester's marks file.

Spec: docs/architecture/mc-verify-spec.md
Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md (Session 2)
"""

from __future__ import annotations

import pytest


STORAGE_X, STORAGE_Y, STORAGE_Z = 4, 65, 0
TESTER_ADJ_X, TESTER_ADJ_Y, TESTER_ADJ_Z = 4, 65, 2  # 2 blocks south, within MAX_OPEN_DIST=4
ITEM = "cobblestone"


@pytest.fixture
def storage_chest_with_items(rcon, config):
    """Per-test chest at :storage: pre-filled with 4 cobblestone.

    Owns its own block state; doesn't rely on C0 since the autouse
    functional harness wipes the arena before every functional test
    (and colony tests run hermetic-per-test anyway).
    """
    world = config["mc"]["world"]
    # Place chest, seed it via data merge (slot 0)
    rcon.run(f"execute in {world} run setblock {STORAGE_X} {STORAGE_Y} {STORAGE_Z} minecraft:chest")
    rcon.run(
        f"execute in {world} run data merge block "
        f"{STORAGE_X} {STORAGE_Y} {STORAGE_Z} "
        f"{{Items:[{{Slot:0b,id:\"minecraft:{ITEM}\",count:4}}]}}"
    )
    yield world
    rcon.run(f"execute in {world} run setblock {STORAGE_X} {STORAGE_Y} {STORAGE_Z} minecraft:air")


@pytest.fixture
def tester_at_storage(rcon, config, tester_bot, storage_chest_with_items):
    """Move Tester adjacent to :storage: so chest_contains can open the
    chest (the verb's MAX_OPEN_DIST gate enforces adjacency)."""
    world = storage_chest_with_items
    rcon.run(
        f"execute in {world} run tp Tester "
        f"{TESTER_ADJ_X} {TESTER_ADJ_Y} {TESTER_ADJ_Z}"
    )
    # Give the bot a beat to sync its position to the rcon teleport.
    def _near_storage() -> bool:
        pos = tester_bot.position() or {}
        return abs((pos.get("x") or 0) - TESTER_ADJ_X) < 1.5

    tester_bot.wait_for_condition(_near_storage, timeout=5.0)
    yield world


@pytest.fixture
def storage_mark_on_tester(tester_bot):
    """Ensure :storage: is registered as a mark on Tester via /action/mark.

    C0 would set this via its local: curl, but variant-2's storage_chest_with_items
    fixture owns its block state independently and the storage mark may not
    survive across runs — so just (re)apply it.
    """
    tester_bot.post(
        "/action/mark",
        body={
            "name": "storage",
            "at": {"x": STORAGE_X, "y": STORAGE_Y, "z": STORAGE_Z},
        },
    )
    yield


@pytest.mark.colony
def test_chest_contains_predicate_satisfied(
    tester_bot,
    storage_mark_on_tester,
    tester_at_storage,
) -> None:
    """Concern 2 variant 2 — chest_contains predicate fires correctly.

    Pre-state: chest at :storage: has 4 cobblestone; Tester adjacent.
    Action: mc verify chest_contains storage cobblestone 4
    Expected: ok=true, satisfied=true, observed.count >= 4
    """
    resp = tester_bot.post(
        "/action/verify",
        body={
            "kind": "chest_contains",
            "mark": "storage",
            "item": ITEM,
            "min_count": 4,
        },
    )
    assert resp.get("ok") is True, f"verify failed: {resp}"
    data = resp["data"]
    assert data["kind"] == "chest_contains"
    assert data["satisfied"] is True, (
        f"expected satisfied=true; got observed={data['observed']}, "
        f"expected={data['expected']}"
    )
    assert data["observed"]["mark"] == "storage"
    assert data["observed"]["item"] == ITEM
    assert data["observed"]["count"] >= 4
    assert data["expected"]["min_count"] == 4


@pytest.mark.colony
def test_chest_contains_predicate_unsatisfied(
    rcon, config, tester_bot, storage_mark_on_tester, tester_at_storage,
) -> None:
    """Variant 2 negative — predicate reports satisfied=false when underfilled.

    Pre-state: chest has 4 cobblestone (from fixture); we ask for ≥10.
    Expected: ok=true (predicate evaluated), satisfied=false.
    The distinction between ok=false (can't evaluate) and ok=true+satisfied=false
    (evaluated; answer is no) is load-bearing for worker → overseer handoff.
    """
    resp = tester_bot.post(
        "/action/verify",
        body={
            "kind": "chest_contains",
            "mark": "storage",
            "item": ITEM,
            "min_count": 10,
        },
    )
    assert resp.get("ok") is True, (
        f"predicate evaluation should succeed even when not satisfied; got {resp}"
    )
    assert resp["data"]["satisfied"] is False
    assert resp["data"]["observed"]["count"] < 10
