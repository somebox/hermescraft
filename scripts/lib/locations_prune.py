"""Prune noise from per-bot locations JSON (death_* graves, optional stale)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

DEATH_KEY = re.compile(r"^death_\d+$", re.I)


def prune_locations(
    locs: dict[str, Any],
    *,
    remove_all_deaths: bool = True,
    max_deaths: int = 3,
    remove_stale: bool = False,
) -> tuple[dict[str, Any], dict[str, int]]:
    """Return (pruned copy, stats). Does not mutate the input dict."""
    out = dict(locs)
    stats = {"removed_deaths": 0, "removed_stale": 0}

    death_keys = sorted(
        [k for k in out if DEATH_KEY.match(k)],
        key=lambda k: int(k.split("_", 1)[1]),
    )
    if remove_all_deaths:
        for k in death_keys:
            del out[k]
        stats["removed_deaths"] = len(death_keys)
    elif max_deaths >= 0 and len(death_keys) > max_deaths:
        drop = death_keys[: len(death_keys) - max_deaths]
        for k in drop:
            del out[k]
        stats["removed_deaths"] = len(drop)

    if remove_stale:
        for k in list(out.keys()):
            entry = out.get(k)
            if isinstance(entry, dict) and entry.get("stale"):
                del out[k]
                stats["removed_stale"] += 1

    return out, stats


def prune_locations_file(
    path: Path,
    *,
    dry_run: bool = False,
    **kwargs: Any,
) -> dict[str, int]:
    if not path.is_file():
        return {"skipped": 1}
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict):
        return {"skipped": 1}
    pruned, stats = prune_locations(raw, **kwargs)
    if not dry_run and pruned != raw:
        path.write_text(json.dumps(pruned, indent=2) + "\n")
    return stats
