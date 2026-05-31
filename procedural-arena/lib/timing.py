"""Wall-clock timing buckets for generate/inspect reports."""

from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Any, Iterator


class TimingReport:
    def __init__(self) -> None:
        self._t0 = time.monotonic()
        self._wall_start = time.time()
        self.phases: dict[str, float] = {}
        self.rcon_batches: int = 0
        self.rcon_commands_sent: int = 0

    @contextmanager
    def phase(self, name: str) -> Iterator[None]:
        t0 = time.monotonic()
        try:
            yield
        finally:
            self.phases[name] = round(time.monotonic() - t0, 3)

    def note_rcon_batch(self, command_count: int) -> None:
        self.rcon_batches += 1
        self.rcon_commands_sent += command_count

    def to_dict(self) -> dict[str, Any]:
        total = round(time.monotonic() - self._t0, 3)
        out = dict(self.phases)
        out["total"] = total
        return {
            "timing_seconds": out,
            "wall_started_at": self._wall_start,
            "rcon_batches": self.rcon_batches,
            "rcon_commands_sent": self.rcon_commands_sent,
        }
