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

    def __init__(self, rcon: RconClient, config: dict, bot_name: str = "Flint"):
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

    def teleport_bot(self, x: float, y: float, z: float, yaw: float = 0.0, pitch: float = 0.0) -> str:
        """Convenience: tp the configured bot into the test world at coords."""
        return self.rcon.run(
            f"execute in {self.world} run tp {self.bot_name} {x} {y} {z} {yaw} {pitch}"
        )
