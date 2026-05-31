"""Unit tests for chest Items parsing (Paper SNBT from `data get block`)."""

import pytest

from tests._lib.chest_nbt import sum_chest_item_from_nbt

PAPER_ITEMS_COMPONENT = (
    '52, 65, 52 has the following block data: '
    '[{count: 8, Slot: 0b, id: "minecraft:oak_log"}]'
)

LEGACY_COMPACT = (
    'Block has the following data: '
    '{Items:[{Slot:0b,id:"minecraft:oak_log",Count:1b}]}'
)

JSON_STYLE = '{"id":"minecraft:oak_log","count":6}'


@pytest.mark.unit
@pytest.mark.parametrize(
    "text,item,want",
    [
        (PAPER_ITEMS_COMPONENT, "oak_log", 8),
        (LEGACY_COMPACT, "oak_log", 1),
        (JSON_STYLE, "oak_log", 6),
        ("The target block is not a block entity", "oak_log", 0),
        ("", "oak_log", 0),
    ],
)
def test_sum_chest_item_from_nbt(text: str, item: str, want: int) -> None:
    assert sum_chest_item_from_nbt(text, item) == want


@pytest.mark.unit
def test_sum_chest_item_stacks_multiple_slots() -> None:
    text = (
        '[{count: 3, id: "minecraft:oak_log"}, '
        '{count: 5, id: "minecraft:oak_log"}]'
    )
    assert sum_chest_item_from_nbt(text, "oak_log") == 8
