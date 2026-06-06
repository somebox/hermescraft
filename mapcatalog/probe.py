from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Protocol


MAX_CMDS_PER_BATCH = 100


class RconClient(Protocol):
    def run_batch(self, cmds: list[str]) -> str: ...


@dataclass
class FakeRconClient:
    """Records commands and returns scripted responses for unit tests."""

    responses: list[str] = field(default_factory=list)
    call_log: list[list[str]] = field(default_factory=list)
    _line_idx: int = 0

    def run_batch(self, cmds: list[str]) -> str:
        self.call_log.append(list(cmds))
        if self.responses:
            out = self.responses.pop(0)
            return out
        lines = []
        for cmd in cmds:
            if "if block" in cmd:
                lines.append("Test passed")
            elif "scoreboard players get" in cmd:
                lines.append("#probe has 0 [mapcatalog]")
            else:
                lines.append("")
        return "\n".join(lines)


def parse_scoreboard_count(rcon_out: str, holder: str = "#probe") -> int | None:
    for line in (rcon_out or "").splitlines():
        if holder not in line or " has " not in line:
            continue
        try:
            mid = line.split(" has ", 1)[1]
            return int(mid.split()[0])
        except (IndexError, ValueError):
            continue
    return None


def line_indicates_block_match(line: str) -> bool:
    line = line or ""
    return ("Test passed" in line) or ("matches" in line) or ("passed" in line.lower())


def line_indicates_out_of_world(line: str) -> bool:
    low = (line or "").lower()
    return "out of this world" in low or "outside the world" in low


def classify_air_probe_line(line: str) -> str:
    """Classify `execute if block … #minecraft:air` stdout for heightmap scans.

    Returns ``air`` (predicate passed), ``solid`` (failed — block present), or
    ``oob`` (Y out of world bounds — keep scanning downward).
    """
    if line_indicates_out_of_world(line):
        return "oob"
    if line_indicates_block_match(line):
        return "air"
    return "solid"


def blocks_match_batch(
    client: RconClient,
    world: str,
    cells: list[tuple[int, int, int]],
    block: str,
    *,
    chunk_size: int = MAX_CMDS_PER_BATCH,
) -> list[bool]:
    if not cells:
        return []
    block_id = str(block).replace("minecraft:", "")
    cmds = [
        f"execute in {world} if block {x} {y} {z} minecraft:{block_id}"
        for x, y, z in cells
    ]
    hits: list[bool] = []
    for i in range(0, len(cmds), chunk_size):
        chunk = cmds[i : i + chunk_size]
        out = client.run_batch(chunk)
        lines = (out or "").splitlines()
        for j in range(len(chunk)):
            line = lines[j] if j < len(lines) else ""
            hits.append(line_indicates_block_match(line))
    return hits


def count_block_hits(
    client: RconClient,
    world: str,
    cells: list[tuple[int, int, int]],
    block: str,
) -> int:
    return sum(1 for h in blocks_match_batch(client, world, cells, block) if h)


@dataclass
class ProbeSession:
    world: str
    client: RconClient
    objective: str = "mapcatalog"

    def reset_objective(self) -> None:
        self.client.run_batch(
            [
                f"scoreboard objectives add {self.objective} dummy",
                f"execute in {self.world} run scoreboard players set #probe {self.objective} 0",
            ]
        )

    def count_entities_in_box(
        self,
        entity_type: str,
        x1: int,
        y1: int,
        z1: int,
        x2: int,
        y2: int,
        z2: int,
    ) -> int:
        cmds = [
            f"scoreboard objectives add {self.objective} dummy",
            f"execute in {self.world} run scoreboard players set #probe {self.objective} 0",
            (
                f"execute in {self.world} run execute as @e[type={entity_type},"
                f"x={x1},y={y1},z={z1},dx={x2-x1},dy={y2-y1},dz={z2-z1}] "
                f"run scoreboard players add #probe {self.objective} 1"
            ),
            f"scoreboard players get #probe {self.objective}",
        ]
        out = self.client.run_batch(cmds)
        return parse_scoreboard_count(out or "") or 0


def canonical_json(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))
