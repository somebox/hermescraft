"""RconClient — rcon to the MC server, over ssh+docker OR native TCP.

Two transports, selected by config.rcon.mode:
  - "ssh" (default): shells out to ssh+docker+rcon-cli (the LAN/CI server).
  - "tcp" / "direct": native rcon over TCP via `mcrcon`, for a local Paper
    server (see server/local-setup.sh + config $overrides.local).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Iterable

# Collapse embedded newlines so a batched response keeps one line per command —
# sample_blocks() indexes results by line ordinal.
_BATCH_LINE_NORMALIZE = str.maketrans({"\n": " ", "\r": " "})


def _read_rcon_password(rcon: dict) -> str:
    """Resolve the rcon password from `rcon.password` or `rcon.password_file`."""
    if rcon.get("password"):
        return str(rcon["password"]).strip()
    pf = rcon.get("password_file")
    if pf:
        return Path(str(pf)).expanduser().read_text(encoding="utf-8").strip()
    raise ValueError("tcp rcon requires rcon.password or rcon.password_file")


class RconClient:
    """Send rcon commands to the MC server defined in config.rcon.

    Use `run()` for a single command and `batch()` for many — batched form is
    drastically faster because it's one ssh round-trip for N commands instead
    of N round-trips.
    """

    def __init__(self, config: dict):
        rcon = config["rcon"]
        self.mode = rcon.get("mode", "ssh")
        self.world = config["mc"]["world"]
        self.command_timeout = rcon.get("command_timeout_s", 20)
        self.batch_timeout = rcon.get("batch_timeout_s", 60)

        if self.mode == "ssh":
            self.ssh_host = rcon["ssh_host"]
            self.container = rcon["docker_container"]
            self.cli = rcon["cli"]
            self.ssh_multiplex = bool(rcon.get("ssh_multiplex", True))
            # Anchor ControlPath on /tmp: macOS's default $TMPDIR overflows the
            # 104-char socket-path cap, making rcon-cli silently return empty.
            self._cm_path = f"/tmp/hermes-rcon-cm-{os.getuid()}-%h-%p-%r"
        elif self.mode in ("tcp", "direct"):
            self.tcp_host = rcon.get("host", "127.0.0.1")
            self.tcp_port = int(rcon.get("port", 25575))
            self.tcp_password = _read_rcon_password(rcon)
            self.tcp_reconnect = bool(rcon.get("reconnect", True))
            self._mcr = None  # lazily-opened mcrcon.MCRcon
        else:
            raise NotImplementedError(
                f"rcon.mode={self.mode!r} not supported (use 'ssh' or 'tcp')"
            )

    # ── native TCP transport (mcrcon) ──────────────────────────────────────
    def _tcp_open(self):
        import socket as _socket

        from mcrcon import MCRcon

        # mcrcon uses signal.alarm() which needs an int timeout.
        mcr = MCRcon(
            self.tcp_host, self.tcp_password, port=self.tcp_port,
            timeout=max(1, int(self.command_timeout)),
        )
        mcr.connect()
        try:
            mcr.socket.setsockopt(_socket.IPPROTO_TCP, _socket.TCP_NODELAY, 1)
        except (OSError, AttributeError):
            pass
        self._mcr = mcr

    def _tcp_command(self, cmd: str) -> str:
        from mcrcon import MCRconException

        if self._mcr is None:
            self._tcp_open()
        try:
            return self._mcr.command(cmd)
        except (BrokenPipeError, ConnectionResetError, OSError, MCRconException):
            if not self.tcp_reconnect:
                raise
            try:
                self._mcr.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._mcr = None
            self._tcp_open()
            return self._mcr.command(cmd)

    def close(self):
        """Close the TCP connection if open (ssh mode is a no-op)."""
        if getattr(self, "_mcr", None) is not None:
            try:
                self._mcr.disconnect()
            finally:
                self._mcr = None

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
        if self.mode != "ssh":
            return self._tcp_command(cmd).strip()
        result = subprocess.run(
            self._argv(),
            input=cmd + "\n",
            capture_output=True,
            text=True,
            timeout=self.command_timeout,
        )
        return result.stdout.strip()

    def batch(self, cmds: Iterable[str]) -> str:
        """Run many rcon commands. Returns combined stdout, one line per command
        (un-stripped — caller may need line-by-line)."""
        cmds = list(cmds)
        if not cmds:
            return ""
        if self.mode != "ssh":
            # rcon is request/response per command; loop and rejoin one line each.
            return "\n".join(
                self._tcp_command(c).translate(_BATCH_LINE_NORMALIZE) for c in cmds
            )
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
