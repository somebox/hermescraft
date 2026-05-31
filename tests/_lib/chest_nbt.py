"""Parse `data get block … Items` rcon output for agent-test chest predicates."""

from __future__ import annotations

import re


def sum_chest_item_from_nbt(nbt_text: str, item: str) -> int:
    """Sum stack counts for minecraft:<item> in chest Items SNBT/JSON."""
    if not nbt_text or "not a block entity" in nbt_text.lower():
        return 0
    item = item.replace("minecraft:", "")
    total = 0
    id_pat = rf'id:\s*["\'](?:minecraft:)?{re.escape(item)}["\']'
    for m in re.finditer(id_pat, nbt_text, re.IGNORECASE):
        start = max(0, m.start() - 100)
        end = min(len(nbt_text), m.end() + 100)
        window = nbt_text[start:end]
        cm = re.search(r"count:\s*(\d+)", window, re.IGNORECASE)
        if cm:
            total += int(cm.group(1))
    for m in re.finditer(
        rf'"id"\s*:\s*"(?:minecraft:)?{re.escape(item)}"[^}}]*?"count"\s*:\s*(\d+)',
        nbt_text,
        re.IGNORECASE,
    ):
        total += int(m.group(1))
    return total
