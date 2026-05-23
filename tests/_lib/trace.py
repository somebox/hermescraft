"""Bot position trace — a low-overhead background poller for functional tests.

Each functional test gets an autouse `bot_trace` fixture (declared in
tests/conftest.py) that spawns a thread, polls the bot's
`/status?lean=true` every 0.4s, and writes one line per sample to a
per-test trace file under `<log_dir>/traces/<nodeid>.trace.log`. When a
primitive hangs, the trace file is the smoking-gun record of where the
bot got stuck.

Trace format (one line per sample):

    HH:MM:SS.mmm (x,y,z) hp=H food=F hold=ITEM[ Δ=N.NN]

The Δ field appears only when the bot moved ≥0.05 since the previous
sample, so scanning a trace for "Δ=" lines tells you exactly when the
bot was in motion. A long run of identical (x,y,z) lines without Δ is a
stall point.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from pathlib import Path


class BotTrace:
    """Background poller: sample bot status every `interval` seconds and
    append one line per sample to `output_path`. Thread is a daemon so a
    test crash doesn't leave it dangling."""

    def __init__(self, base_url: str, output_path: Path, interval: float = 1.0):
        self.base_url = base_url.rstrip("/")
        self.output_path = output_path
        self.interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._thread is not None:
            self._stop.set()
            self._thread.join(timeout=2.0)
            self._thread = None

    def _loop(self) -> None:
        prev_pos: tuple[float, float, float] | None = None
        # Append mode — the functional harness writes a structured
        # `# TEST_START ...` header to this file BEFORE start() is
        # called, and appends a `# TEST_END ...` footer AFTER stop().
        # See tests/conftest.py::_functional_harness.
        with open(self.output_path, "a") as f:
            f.write(
                f"# trace_poller_started {time.strftime('%Y-%m-%dT%H:%M:%S')} "
                f"url={self.base_url} interval={self.interval}s\n"
            )
            f.flush()
            while not self._stop.is_set():
                ts = time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"
                try:
                    with urllib.request.urlopen(
                        f"{self.base_url}/status?lean=true&preserve=true", timeout=2.0
                    ) as r:
                        d = (json.loads(r.read()) or {}).get("data") or {}
                except Exception as e:  # noqa: BLE001 — trace is observe-only
                    f.write(f"{ts} ERR {type(e).__name__}: {e}\n")
                    f.flush()
                    self._stop.wait(self.interval)
                    continue
                pos = d.get("position") or {}
                x, y, z = pos.get("x"), pos.get("y"), pos.get("z")
                hp = d.get("health")
                food = d.get("food")
                holding = d.get("holding")
                if isinstance(holding, dict):
                    holding = holding.get("name") or "?"
                moved = ""
                if x is not None and prev_pos is not None:
                    delta = (
                        abs(x - prev_pos[0])
                        + abs((y or 0) - prev_pos[1])
                        + abs((z or 0) - prev_pos[2])
                    )
                    if delta >= 0.05:
                        moved = f" Δ={delta:.2f}"
                if x is not None:
                    prev_pos = (x, y or 0, z or 0)
                f.write(
                    f"{ts} ({x},{y},{z}) hp={hp} food={food} hold={holding}{moved}\n"
                )
                f.flush()
                self._stop.wait(self.interval)
