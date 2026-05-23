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
        self.ssh_multiplex = bool(rcon.get("ssh_multiplex", True))
        import os

        # SSH ControlPath length limit: Unix domain sockets cap at 104
        # chars on macOS (108 on Linux). SSH appends a per-listener
        # suffix like ".6gAdsKS7pDL7RjF8" (~17 chars) on top of the
        # %h-%p-%r expansion. macOS's default $TMPDIR
        # (/var/folders/q8/.../T/) eats 49 chars by itself — plus our
        # 41-char prefix + ssh suffix overflows the limit, and rcon-cli
        # silently returns empty stdout (exit 255 "unix_listener: path
        # too long"). Anchoring on /tmp keeps the full path well under
        # the 104-char cap.
        self._cm_path = f"/tmp/hermes-rcon-cm-{os.getuid()}-%h-%p-%r"

    def _argv(self) -> list[str]:
        base = ["ssh"]
        if self.ssh_multiplex:
            base += [
                "-o",
                "ControlMaster=auto",
                "-o",
                f"ControlPath={self._cm_path}",
                "-o",
                "ControlPersist=30m",
                "-o",
                "ServerAliveInterval=60",
            ]
        return base + [self.ssh_host, "sudo", "docker", "exec", "-i", self.container, self.cli]

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

    def sample_blocks(
        self,
        coords: list[tuple[int, int, int]],
        kind: str,
        world: str | None = None,
    ) -> list[bool]:
        """Test many cells in one rcon round-trip."""
        w = world or self.world
        kind_full = kind if ":" in kind else f"minecraft:{kind}"
        cmds = [
            f"execute in {w} if block {x} {y} {z} {kind_full}"
            for (x, y, z) in coords
        ]
        out = self.batch(cmds)
        results = []
        for line in out.splitlines():
            if "Test passed" in line:
                results.append(True)
            elif "Test failed" in line:
                results.append(False)
        if len(results) != len(coords):
            raise RuntimeError(
                f"sample_blocks: expected {len(coords)} results, got {len(results)}. "
                f"raw stdout:\n{out}"
            )
        return results

    def count_blocks_in_box(
        self,
        x1: int,
        y1: int,
        z1: int,
        x2: int,
        y2: int,
        z2: int,
        kind: str,
        world: str | None = None,
    ) -> int:
        """Count cells in the bbox matching kind (one batched payload)."""
        coords = [
            (x, y, z)
            for x in range(min(x1, x2), max(x1, x2) + 1)
            for y in range(min(y1, y2), max(y1, y2) + 1)
            for z in range(min(z1, z2), max(z1, z2) + 1)
        ]
        return sum(self.sample_blocks(coords, kind, world=world))

    def region_is_all(
        self,
        x1: int,
        y1: int,
        z1: int,
        x2: int,
        y2: int,
        z2: int,
        kind: str,
        world: str | None = None,
    ) -> bool:
        """True when every cell in the bbox matches kind."""
        volume = (
            (max(x1, x2) - min(x1, x2) + 1)
            * (max(y1, y2) - min(y1, y2) + 1)
            * (max(z1, z2) - min(z1, z2) + 1)
        )
        return (
            self.count_blocks_in_box(x1, y1, z1, x2, y2, z2, kind, world=world)
            == volume
        )

    def clone(
        self,
        src: tuple[int, int, int, int, int, int],
        dest: tuple[int, int, int],
        *,
        mask: str = "replace",
        mode: str = "normal",
        world: str | None = None,
    ) -> str:
        """Clone source bbox to dest lower-NW corner."""
        w = world or self.world
        sx1, sy1, sz1, sx2, sy2, sz2 = src
        dx, dy, dz = dest
        return self.run(
            f"execute in {w} run clone "
            f"{sx1} {sy1} {sz1} {sx2} {sy2} {sz2} {dx} {dy} {dz} {mask} {mode}"
        )
