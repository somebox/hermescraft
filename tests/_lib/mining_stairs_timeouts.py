"""HTTP timeouts and settle waits for stair / tunnel / retrace functional tests.

Client `bot.post(..., timeout=)` must exceed server work: each retrace leg
caps at ~10s pathfind + burst; tunnel slices call dig_area sequentially.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tests._lib.arena import Arena
    from tests._lib.bot import BotClient


def stair_down_timeout(length: int) -> float:
    return max(180.0, 22.0 * length)


def tunnel_timeout(length: int, width: int = 2) -> float:
    return max(360.0, 28.0 * length * max(1, width // 2))


def retrace_timeout(num_legs: int) -> float:
    return max(300.0, 40.0 * num_legs)


def goto_surface_timeout() -> float:
    return 180.0


def wait_bot_settled(
    arena: Arena,
    bot: BotClient,
    *,
    timeout_s: float = 30.0,
    stable_for_s: float = 1.0,
    after_heavy_dig: bool = False,
) -> None:
    """Wait until position is stable. Uses lean status (not /health) so a busy
    sync action does not fail a 2s health poll."""
    if after_heavy_dig:
        arena.settle_heavy()
        arena.settle(4.0)
    deadline = time.time() + timeout_s
    anchor = bot.position()
    stable_since: float | None = None
    while time.time() < deadline:
        cur = bot.position()
        if anchor and cur:
            dx = abs(cur.get("x", 0) - anchor.get("x", 0))
            dy = abs(cur.get("y", 0) - anchor.get("y", 0))
            dz = abs(cur.get("z", 0) - anchor.get("z", 0))
            if max(dx, dy, dz) <= 0.2:
                if stable_since is None:
                    stable_since = time.time()
                elif time.time() - stable_since >= stable_for_s:
                    arena.settle(2.0)
                    return
            else:
                stable_since = None
                anchor = cur
        time.sleep(0.35)
    arena.settle(3.0)
