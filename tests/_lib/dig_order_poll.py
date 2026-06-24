"""Poll rcon while a dig action runs to approximate in-world break order."""

from __future__ import annotations

import threading
import time
from typing import Iterable


def poll_cells_becoming_air(
    rcon,
    cells: Iterable[tuple[int, int, int]],
    *,
    stop_event: threading.Event,
    poll_interval_s: float = 0.05,
) -> list[tuple[int, int, int]]:
    """Append (x,y,z) each time a cell first reads as air."""
    targets = list(cells)
    seen: set[tuple[int, int, int]] = set()
    order: list[tuple[int, int, int]] = []
    idle_after_stop = 0
    while True:
        for c in targets:
            if c in seen:
                continue
            x, y, z = c
            if rcon.block_is(x, y, z, "air"):
                seen.add(c)
                order.append(c)
        if len(seen) >= len(targets):
            break
        if stop_event.is_set():
            idle_after_stop += 1
            if idle_after_stop > 40:
                break
        time.sleep(poll_interval_s)
    return order


def max_horizontal_step(order: list[tuple[int, int, int]]) -> int:
    """Max Manhattan |dx|+|dz| between consecutive breaks on the same Y."""
    if len(order) < 2:
        return 0
    best = 0
    for i in range(1, len(order)):
        ax, ay, az = order[i - 1]
        bx, by, bz = order[i]
        if ay != by:
            continue
        best = max(best, abs(ax - bx) + abs(az - bz))
    return best
