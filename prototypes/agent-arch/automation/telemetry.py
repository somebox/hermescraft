"""JSONL telemetry emitter for agent-arch validation runs.

Stable schema so Sessions 4 (mutex demo) and 5 (capstone) can be compared
against each other and against future trials. Lands in Session 1 to lock
the schema before downstream consumers depend on it.

Design constraints:
- No dependencies beyond stdlib.
- Append-only JSONL — one event per line, easy to grep / pipe to jq.
- Stable field names; additive evolution only (don't rename, don't repurpose).
- Cheap enough to call in tight loops; no dashboard side-effects.

Usage:

    from telemetry import Run

    with Run(out_path="/tmp/proto-run.jsonl", run_id="trial-1") as run:
        run.event("session_start", session="capstone")
        run.event("card_created", card_id="t_abc", assignee="navigator")
        run.event("card_completed", card_id="t_abc", duration_s=42)
        run.summary(
            cards_created=3, cards_completed=3, cards_blocked=0,
            wall_time_s=185, per_card_retries=0, manual_interventions=0,
        )

The `summary` call writes one final line with the canonical fields and
the `kind="summary"` marker, so aggregators can find it without parsing
all events.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# Canonical summary field set — Session 1 locks this in.
# Add new fields by extending this list (never repurpose existing names).
SUMMARY_FIELDS = (
    "run_id",
    "cards_created",
    "cards_completed",
    "cards_blocked",
    "wall_time_s",
    "per_card_retries",
    "manual_interventions",
)


class Run:
    """Append-only JSONL telemetry sink for one validation trial."""

    def __init__(self, out_path: str | os.PathLike, run_id: str | None = None) -> None:
        self.out_path = Path(out_path)
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        self.run_id = run_id or datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ")
        self._started_at = time.monotonic()
        self._fp = None  # opened lazily in __enter__

    # Context-manager surface; explicit open/close also OK.
    def __enter__(self) -> "Run":
        self._fp = self.out_path.open("a", encoding="utf-8")
        self.event("run_started")
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._fp is None:
            return
        if exc is not None:
            # Capture the failure mode so post-mortem can find it.
            self.event("run_failed", error=f"{exc_type.__name__}: {exc}")
        else:
            self.event("run_ended")
        self._fp.close()
        self._fp = None

    def event(self, kind: str, **fields: Any) -> None:
        """Emit one event line. `kind` is the event tag; fields are flat dict."""
        if self._fp is None:
            # Allow ad-hoc emits without a context-manager wrap.
            self._fp = self.out_path.open("a", encoding="utf-8")
        record: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "run_id": self.run_id,
            "kind": kind,
            **fields,
        }
        self._fp.write(json.dumps(record, separators=(",", ":")) + "\n")
        self._fp.flush()

    def summary(self, **fields: Any) -> None:
        """Write the canonical summary line.

        Required fields per SUMMARY_FIELDS; extras are allowed but
        aggregators only treat the canonical set as comparable.
        """
        # Wall time defaults to monotonic delta unless caller overrides.
        if "wall_time_s" not in fields:
            fields["wall_time_s"] = round(time.monotonic() - self._started_at, 2)
        missing = set(SUMMARY_FIELDS) - {"run_id", "wall_time_s"} - set(fields)
        if missing:
            raise ValueError(
                f"summary missing required fields: {sorted(missing)} "
                f"(canonical set: {sorted(SUMMARY_FIELDS)})"
            )
        self.event("summary", **fields)
