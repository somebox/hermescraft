"""Single-line append to the dispatcher log.

Designed to be the only output sink for `gate-check` runs. The
dispatcher's bash loop tails the same file, so operators see plugin
output interleaved with `hermes kanban dispatch` output in one place.
"""

from __future__ import annotations

import datetime
import os

from . import config


def write_dispatcher_log(line: str) -> None:
    """Append ``[HH:MM:SS] {line}`` to ``config.LOG_PATH``.

    Errors are swallowed — logging must never break the gate-check.
    """
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    try:
        parent = os.path.dirname(config.LOG_PATH)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(config.LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {line}\n")
    except Exception:  # noqa: BLE001 — intentional: logging must not break dispatch
        pass
