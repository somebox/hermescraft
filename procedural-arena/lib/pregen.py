"""Force chunk generation inside the arena square."""

from __future__ import annotations

import math
from typing import Any


def pregen_tp_commands(map_cfg: dict[str, Any], world: str, params: dict[str, Any]) -> list[str]:
    pregen = params.get("pregen") or {}
    step = int(pregen.get("step", 16))
    y = int(pregen.get("y", 120))
    cx = map_cfg["center_x"]
    cz = map_cfg["center_z"]
    half = map_cfg["arena_half"]
    radius = map_cfg["border_radius"]
    cmds: list[str] = []
    seen_chunks: set[tuple[int, int]] = set()
    x = cx - half
    while x <= cx + half:
        z = cz - half
        while z <= cz + half:
            if math.hypot(x - cx, z - cz) <= radius + 0.5:
                ch = (x >> 4, z >> 4)
                if ch not in seen_chunks:
                    seen_chunks.add(ch)
                    cmds.append(f"execute in {world} run forceload add {ch[0]} {ch[1]}")
            z += step
        x += step
    return cmds
