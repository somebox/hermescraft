from __future__ import annotations

from typing import Protocol


class RconClient(Protocol):
    """Unified interface for both ssh+docker and local TCP rcon transports."""

    def run(self, cmd: str) -> str: ...

    def run_batch(self, cmds: list[str]) -> str: ...
