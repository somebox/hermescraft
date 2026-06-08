from __future__ import annotations

import os
import socket
import subprocess
from typing import Iterable

from mapcatalog.rcon_protocol import RconClient


_BATCH_LINE_NORMALIZE = str.maketrans({"\n": " ", "\r": " "})


class SshDockerRcon:
    """rcon-cli over ssh+docker; implements RconClient."""

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


class LocalTcpRcon:
    """TCP rcon via mcrcon for a local Paper server; implements RconClient.

    rcon is request/response per command, so run_batch loops. Each response is
    normalized so embedded newlines collapse to spaces — probe.py and metrics.py
    index responses by line ordinal, and a drift would silently break gating.
    """

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: int = 25575,
        password: str,
        command_timeout_s: float = 30.0,
        batch_timeout_s: float = 120.0,
        reconnect: bool = True,
    ):
        if not password:
            raise ValueError("LocalTcpRcon requires a non-empty rcon password")
        self.host = host
        self.port = port
        self.password = password
        self.command_timeout_s = command_timeout_s
        self.batch_timeout_s = batch_timeout_s
        self.reconnect = reconnect
        self._mcr = None  # mcrcon.MCRcon instance, lazily opened

    def _open(self):
        from mcrcon import MCRcon

        # mcrcon uses signal.alarm() which requires an int timeout.
        mcr = MCRcon(self.host, self.password, port=self.port, timeout=max(1, int(self.command_timeout_s)))
        mcr.connect()
        try:
            mcr.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except (OSError, AttributeError):
            pass
        self._mcr = mcr

    def _ensure_open(self):
        if self._mcr is None:
            self._open()

    def _reconnect(self):
        try:
            if self._mcr is not None:
                self._mcr.disconnect()
        except Exception:
            pass
        self._mcr = None
        self._open()

    def _command_with_retry(self, cmd: str) -> str:
        from mcrcon import MCRconException

        self._ensure_open()
        try:
            return self._mcr.command(cmd)
        except (BrokenPipeError, ConnectionResetError, OSError, MCRconException):
            if not self.reconnect:
                raise
            self._reconnect()
            return self._mcr.command(cmd)

    def run(self, cmd: str) -> str:
        return self._command_with_retry(cmd).strip()

    def run_batch(self, cmds: Iterable[str]) -> str:
        cmds = list(cmds)
        if not cmds:
            return ""
        lines = []
        for c in cmds:
            resp = self._command_with_retry(c)
            # Collapse embedded newlines so the joined output keeps one line per command.
            lines.append(resp.translate(_BATCH_LINE_NORMALIZE))
        return "\n".join(lines)

    def close(self):
        if self._mcr is not None:
            try:
                self._mcr.disconnect()
            finally:
                self._mcr = None

    def __enter__(self):
        self._ensure_open()
        return self

    def __exit__(self, *exc):
        self.close()


def make_rcon(cfg) -> RconClient:
    """Dispatch on cfg.transport. Imports here to avoid circular dependency."""
    transport = getattr(cfg, "transport", "ssh_docker")
    if transport == "ssh_docker":
        return SshDockerRcon(
            ssh_host=cfg.ssh_host,
            container=cfg.container,
            cli=cfg.cli,
            command_timeout_s=cfg.command_timeout_s,
            batch_timeout_s=cfg.batch_timeout_s,
        )
    if transport == "tcp":
        return LocalTcpRcon(
            host=cfg.tcp_host,
            port=cfg.tcp_port,
            password=cfg.tcp_password,
            command_timeout_s=cfg.command_timeout_s,
            batch_timeout_s=cfg.batch_timeout_s,
        )
    raise NotImplementedError(f"rcon transport {transport!r}")
