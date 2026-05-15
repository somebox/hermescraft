"""RconClient — rcon-cli over ssh+docker.

Extracted from the run_rcon / run_rcon_batch pattern that's duplicated across
all 44 scripts/test-*.py files and scripts/agent-test.py. The implementation
shells out to ssh+docker+rcon-cli; the `mode` field on config.rcon reserves
space for a future native rcon protocol implementation.
"""

from __future__ import annotations

import subprocess
from typing import Iterable


class RconClient:
    """Send rcon commands to the MC server defined in config.rcon.

    Use `run()` for a single command and `batch()` for many — batched form is
    drastically faster because it's one ssh round-trip for N commands instead
    of N round-trips.
    """

    def __init__(self, config: dict):
        rcon = config["rcon"]
        if rcon["mode"] != "ssh":
            raise NotImplementedError(f"rcon.mode={rcon['mode']!r} not supported yet (only 'ssh')")
        self.ssh_host = rcon["ssh_host"]
        self.container = rcon["docker_container"]
        self.cli = rcon["cli"]
        self.command_timeout = rcon["command_timeout_s"]
        self.batch_timeout = rcon["batch_timeout_s"]
        self.world = config["mc"]["world"]

    def _argv(self) -> list[str]:
        return ["ssh", self.ssh_host, "sudo", "docker", "exec", "-i", self.container, self.cli]

    def run(self, cmd: str) -> str:
        """Run a single rcon command. Returns combined stdout, stripped."""
        result = subprocess.run(
            self._argv(),
            input=cmd + "\n",
            capture_output=True,
            text=True,
            timeout=self.command_timeout,
        )
        return result.stdout.strip()

    def batch(self, cmds: Iterable[str]) -> str:
        """Run many rcon commands via a single ssh+rcon-cli invocation.
        Returns combined stdout (un-stripped — caller may need line-by-line)."""
        cmds = list(cmds)
        if not cmds:
            return ""
        payload = "\n".join(cmds) + "\n"
        result = subprocess.run(
            self._argv(),
            input=payload,
            capture_output=True,
            text=True,
            timeout=self.batch_timeout,
        )
        return result.stdout

    def in_world(self, cmd: str) -> str:
        """Convenience: wrap `cmd` in `execute in <world> run ...` and dispatch."""
        return self.run(f"execute in {self.world} run {cmd}")

    def block_is(self, x: int, y: int, z: int, kind: str, world: str | None = None) -> bool:
        """Assert via rcon that the block at (x,y,z) matches `kind` (e.g. 'air',
        'cobblestone', 'oak_door[half=lower,...]'). Returns True/False.

        Uses Paper's `execute if block X Y Z minecraft:<kind>` predicate, which
        prints "Test passed" or "Test failed" to stdout. Empty stdout means
        rcon-cli errored — raise rather than silently flipping the assertion.

        This is the canonical state-verification helper for the 5
        inventory-flagged tests that today pass on `ok=true` alone without
        checking the side effect. Use this in `tests/functional/...`:

            assert rcon.block_is(0, 65, 0, "air")            # post-dig
            assert rcon.block_is(2, 65, 0, "cobblestone")     # post-place
        """
        w = world or self.world
        # Normalize: callers may pass either "cobblestone" or
        # "minecraft:cobblestone"; the predicate accepts both but our test
        # writers tend to drop the prefix.
        kind_full = kind if ":" in kind else f"minecraft:{kind}"
        out = self.run(f"execute in {w} if block {x} {y} {z} {kind_full}")
        if "Test passed" in out:
            return True
        if "Test failed" in out:
            return False
        raise RuntimeError(
            f"block_is({x},{y},{z},{kind!r}): unexpected rcon output: {out!r}"
        )
