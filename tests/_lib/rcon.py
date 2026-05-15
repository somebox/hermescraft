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
