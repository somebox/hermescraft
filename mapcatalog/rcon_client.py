from __future__ import annotations

import os
import subprocess
from typing import Iterable


class SshDockerRcon:
    """rcon-cli over ssh+docker; implements mapcatalog.probe.RconClient."""

    def __init__(
        self,
        *,
        ssh_host: str,
        container: str,
        cli: str = "rcon-cli",
        command_timeout_s: float = 120.0,
        batch_timeout_s: float = 600.0,
        ssh_multiplex: bool = True,
    ):
        self.ssh_host = ssh_host
        self.container = container
        self.cli = cli
        self.command_timeout_s = command_timeout_s
        self.batch_timeout_s = batch_timeout_s
        self.ssh_multiplex = ssh_multiplex
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
        result = subprocess.run(
            self._argv(),
            input=cmd + "\n",
            capture_output=True,
            text=True,
            timeout=self.command_timeout_s,
        )
        if result.returncode != 0 and not result.stdout.strip():
            err = (result.stderr or "").strip()
            raise RuntimeError(f"rcon failed ({result.returncode}): {cmd!r} stderr={err!r}")
        return result.stdout.strip()

    def run_batch(self, cmds: Iterable[str]) -> str:
        cmds = list(cmds)
        if not cmds:
            return ""
        payload = "\n".join(cmds) + "\n"
        result = subprocess.run(
            self._argv(),
            input=payload,
            capture_output=True,
            text=True,
            timeout=self.batch_timeout_s,
        )
        return result.stdout
