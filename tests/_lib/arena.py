"""Arena — canonical blank-slate world setup for functional tests.

Every existing scripts/test-*.py has a near-identical preamble: kill all
non-player entities, set difficulty peaceful, set time to noon, freeze the
daylight cycle, clear the test bot's inventory, give it saturation. Some
tests also fill a bounding box with air. This class makes that one call.
"""

from __future__ import annotations

import time
from typing import Iterable

from .rcon import RconClient


class Arena:
    """Test-world setup/teardown helper. Pass an RconClient and the config dict."""

    def __init__(self, rcon: RconClient, config: dict, bot_name: str = "Tester"):
        self.rcon = rcon
        self.config = config
        self.world = config["mc"]["world"]
        self.bot_name = bot_name
        self._settle_seconds = config["test"]["settle_seconds"]

    def clean(self, bbox: tuple[int, int, int, int, int, int] | None = None) -> str:
        """Reset world state to a known-clean baseline.

        Args:
            bbox: Optional (x1,y1,z1,x2,y2,z2) — fill this box with air. Useful
                  when the test world has accumulated test-block detritus.

        Returns:
            Combined rcon stdout from the batched commands.
        """
        cmds = [
            f"execute in {self.world} run kill @e[type=!player]",
            f"execute in {self.world} run difficulty peaceful",
            f"execute in {self.world} run gamerule doDaylightCycle false",
            f"execute in {self.world} run gamerule doMobSpawning false",
            f"execute in {self.world} run time set noon",
            f"execute in {self.world} run weather clear",
            f"clear {self.bot_name}",
            f"effect clear {self.bot_name}",
            f"effect give {self.bot_name} minecraft:saturation 600 1",
        ]
        if bbox is not None:
            x1, y1, z1, x2, y2, z2 = bbox
            cmds.append(f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {y2} {z2} air")
        return self.rcon.batch(cmds)

    def prep(self, commands: Iterable[str]) -> str:
        """Run a fixture-style list of rcon commands (the `prep:` block in
        a YAML fixture). Batched."""
        return self.rcon.batch(commands)

    def cleanup(self, commands: Iterable[str]) -> str:
        """Run a fixture-style cleanup list. Batched."""
        return self.rcon.batch(commands)

    def settle(self, seconds: float | None = None) -> None:
        """Sleep `seconds` (default config.test.settle_seconds). Lets the bot's
        perception catch up with world state before assertions."""
        time.sleep(seconds if seconds is not None else self._settle_seconds)

    def rescue_tester(
        self,
        *,
        safe_xyz: tuple[float, float, float] = (0.0, 100.0, 0.0),
    ) -> None:
        """Force the Tester bot into a clean, alive, invulnerable state.

        Use at the TOP of every fixture so it doesn't matter how the previous
        test (or an external command) left the bot. Sequence:

          1. difficulty peaceful — auto-regen + no mob aggro
          2. gamemode creative   — immediate full HP, invulnerable, no fall dmg
          3. tp to safe coords   — preempt void/lava interactions

        Caller's fixture is expected to flip back to survival later, after
        the arena is built and the bot is positioned. This helper is purely
        about reaching a known-good baseline without assumptions about the
        bot's prior state (e.g. dead-mid-respawn, in the void, on fire).
        """
        sx, sy, sz = safe_xyz
        self.rcon.batch([
            f"execute in {self.world} run difficulty peaceful",
            f"gamemode creative {self.bot_name}",
            f"execute in {self.world} run tp {self.bot_name} {sx} {sy} {sz} 0 0",
        ])

    def verify_tester_ready(
        self,
        bot,
        *,
        expected_xz: tuple[float, float] | None = None,
        expected_y_at_least: float | None = None,
        min_hp: float = 19.5,
        xz_tol: float = 1.5,
    ) -> dict:
        """Assert pre-test conditions: Tester in survival mode, on the
        expected cell, at full (or near-full) HP.

        Returns the bot's lean status dict so the caller can reuse position
        / health values it already fetched. Raises AssertionError with a
        descriptive message on mismatch.
        """
        gm = self.rcon.run(
            f"execute in {self.world} run data get entity {self.bot_name} playerGameType"
        )
        # Survival=0, creative=1, adventure=2, spectator=3. Response looks
        # like "> Tester has the following entity data: 0\n>" — rcon-cli
        # tacks on prompt chars, so search for "data: <N>" rather than
        # using endswith.
        import re
        m = re.search(r"data:\s*([0-3])", gm)
        assert m and m.group(1) == "0", (
            f"setup: {self.bot_name} not in survival gamemode (rcon said: {gm!r}). "
            f"Check that the fixture flipped back from creative."
        )
        status = bot.status_lean()
        hp = status.get("health") or 0
        assert hp >= min_hp, (
            f"setup: {self.bot_name} HP={hp} (need ≥{min_hp}) — "
            f"prior test damage didn't heal or the heal didn't propagate"
        )
        pos = status.get("position") or {}
        if expected_xz is not None:
            ex, ez = expected_xz
            dx = abs((pos.get("x") or 0) - ex)
            dz = abs((pos.get("z") or 0) - ez)
            assert dx <= xz_tol and dz <= xz_tol, (
                f"setup: {self.bot_name} at {pos}, expected x≈{ex} z≈{ez} (tol {xz_tol})"
            )
        if expected_y_at_least is not None:
            assert (pos.get("y") or 0) >= expected_y_at_least, (
                f"setup: {self.bot_name} y={pos.get('y')}, expected ≥{expected_y_at_least} "
                f"(bot may have fallen off the test surface)"
            )
        return status

    def teleport_bot(self, x: float, y: float, z: float, yaw: float = 0.0, pitch: float = 0.0) -> str:
        """Convenience: tp the configured bot into the test world at coords."""
        return self.rcon.run(
            f"execute in {self.world} run tp {self.bot_name} {x} {y} {z} {yaw} {pitch}"
        )

    def flat_arena(
        self,
        bbox: tuple[int, int, int, int, int, int],
        floor: str = "grass_block",
        floor_y: int | None = None,
    ) -> str:
        """Build a flat playing field: air-fill `bbox`, then lay a single floor
        layer at the bottom (or at `floor_y` if specified).

        Replaces the legacy 4-line preamble that 30+ scripts duplicate:
            fill x1 y1 z1 x2 y2 z2 air
            fill x1 y1 z1 x2 y1 z2 <floor>

        Args:
            bbox: (x1, y1, z1, x2, y2, z2). y1 is the floor layer; y2 is the
                  top of the air column.
            floor: block name for the floor layer (default grass_block).
                  Pass 'minecraft:<kind>' or bare 'kind' — prefix added if missing.
            floor_y: override the floor row (default = y1 from bbox).
        """
        x1, y1, z1, x2, y2, z2 = bbox
        fy = y1 if floor_y is None else floor_y
        floor_full = floor if ":" in floor else f"minecraft:{floor}"
        return self.rcon.batch([
            f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air",
            f"execute in {self.world} run fill {x1} {fy} {z1} {x2} {fy} {z2} {floor_full}",
        ])

    def grid_3x3(
        self,
        center: tuple[int, int, int] = (4, 65, 4),
        block: str = "cobblestone",
        height: int = 1,
        clear_bbox: tuple[int, int, int, int, int, int] | None = None,
        floor: str = "grass_block",
    ) -> str:
        """Build the canonical 3×3 pillar grid used by mining-family tests.

        Pillar foot-cells sit at `(cx±2, cy, cz±2)` and `(cx, cy, cz)` — i.e.
        x ∈ {cx-2, cx, cx+2}, z ∈ {cz-2, cz, cz+2}, with `height` blocks each
        stacked up from cy. With the default center (4,65,4) the grid
        matches the legacy test geometry (pillars at x∈{2,4,6}, z∈{2,4,6}).

        If `clear_bbox` is given, the area is air-filled and floored first.
        Otherwise the caller is expected to have called `flat_arena` already.
        """
        cx, cy, cz = center
        cmds: list[str] = []
        if clear_bbox is not None:
            x1, y1, z1, x2, y2, z2 = clear_bbox
            floor_full = floor if ":" in floor else f"minecraft:{floor}"
            cmds.append(f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air")
            cmds.append(f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {y1} {z2} {floor_full}")
        block_full = block if ":" in block else f"minecraft:{block}"
        for dx in (-2, 0, 2):
            for dz in (-2, 0, 2):
                for dy in range(height):
                    cmds.append(
                        f"execute in {self.world} run setblock {cx + dx} {cy + dy} {cz + dz} {block_full}"
                    )
        return self.rcon.batch(cmds)

    def forceload(self, bbox: tuple[int, int, int] | tuple[int, int, int, int]) -> str:
        """Forceload a chunk or rectangular chunk range. Accepts either
        (cx, cz) for a single chunk or (cx1, cz1, cx2, cz2) for a range.

        Coordinates are CHUNK coords, not block coords. To forceload a region
        around block coord 0,0 → chunk (0,0) → call forceload((0,0)).

        Forceload is required if a test runs against chunks that aren't
        already loaded (e.g. fresh `landfolk-test` world startups). The
        legacy tests issued `forceload add ... ; forceload remove all`
        bracketing their runs; the harness defaults to NOT issuing these
        because most test runs hit already-loaded chunks. Tests that
        explicitly need it should call this helper.
        """
        if len(bbox) == 2:
            cx, cz = bbox
            return self.rcon.run(f"execute in {self.world} run forceload add {cx} {cz}")
        cx1, cz1, cx2, cz2 = bbox
        return self.rcon.run(f"execute in {self.world} run forceload add {cx1} {cz1} {cx2} {cz2}")

    def forceload_remove_all(self) -> str:
        """Mirror of `forceload`. Removes all forceloaded chunks in the world."""
        return self.rcon.run(f"execute in {self.world} run forceload remove all")
