"""Session 1 colony test — proves the chest-delta done-ness pattern (Concern 2 variant 3).

This test establishes the harness pattern for object-state and delta predicates
used by Concern 2 in the [colony validation plan]. It does NOT invoke an LLM
worker — it directly mutates the chest via rcon so the assertion machinery is
provable in isolation. Later Concern 2 tests reuse this pattern with a worker
in the loop.

Pattern (the load-bearing assertion shape for Concern 2 variant 3):

    before = count(item_in_chest)
    <something happens — rcon, a worker card, an operator>
    after  = count(item_in_chest)
    assert after - before >= N

The "something happens" here is rcon `data merge block` directly. The
machinery is identical when a worker card runs.

Prereq: arena prepped via `scripts/run-fixture.sh prep
data/test-fixtures/colony/C0_colony_arena.yaml`. See tests/colony/README.md.

Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md (Session 1).
"""

from __future__ import annotations

import pytest

from tests._lib.chest_nbt import sum_chest_item_from_nbt


STORAGE_X, STORAGE_Y, STORAGE_Z = 4, 65, 0
ITEM = "cobblestone"


def _chest_count(rcon, world: str, item: str) -> int:
    """Read item count from the C0 :storage: chest via rcon `data get block`."""
    nbt = rcon.run(
        f"execute in {world} run data get block "
        f"{STORAGE_X} {STORAGE_Y} {STORAGE_Z} Items"
    )
    return sum_chest_item_from_nbt(nbt, item)


@pytest.mark.functional
@pytest.mark.colony
def test_chest_delta_predicate(rcon, config) -> None:
    """Concern 2 variant 3 — delta predicate fires correctly.

    Snapshots the :storage: chest's cobblestone count, deposits 4 via rcon,
    snapshots again, asserts the delta is exactly +4. Works regardless of
    whether the chest had pre-existing items (which is the whole point of
    delta vs absolute).
    """
    world = config["mc"]["world"]

    before = _chest_count(rcon, world, ITEM)

    # Deposit 4 cobblestone directly into the chest's first inventory slot.
    # Using `data merge block` is the most direct way to mutate chest
    # contents without involving a player; equivalent to a worker that
    # successfully deposited via `mc deposit`.
    rcon.run(
        f"execute in {world} run data merge block "
        f"{STORAGE_X} {STORAGE_Y} {STORAGE_Z} "
        f"{{Items:[{{Slot:0b,id:\"minecraft:{ITEM}\",count:4}}]}}"
    )

    after = _chest_count(rcon, world, ITEM)

    delta = after - before
    assert delta == 4, (
        f"expected chest delta of +4 {ITEM}, got {delta} (before={before}, after={after})"
    )

    # Symmetric cleanup so reruns start from a known state — empty the slot.
    rcon.run(
        f"execute in {world} run data merge block "
        f"{STORAGE_X} {STORAGE_Y} {STORAGE_Z} {{Items:[]}}"
    )
