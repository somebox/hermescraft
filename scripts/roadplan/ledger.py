"""Survey ledger IO (§5).

Append-only `samples.jsonl` (any writer), single-writer `state.json`
(planner only). No locks: JSONL is O_APPEND-safe, state.json uses
write-temp-rename for atomicity.

Cells are stored as flat tuples `[x, z, y, block_tag]` — the canonical
format — and mapped to K2 sample dicts (`{x, z, y, kind}`) at read time so
the on-disk shape is decoupled from any one solver's vocabulary.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

_FLUIDS = {"water", "flowing_water", "lava", "flowing_lava"}
_VEG_SUFFIXES = ("_log", "_stem", "_leaves", "_wart_block", "_sapling")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z")


def samples_path(root):
    return Path(root) / "samples.jsonl"


def observations_path(root):
    return Path(root) / "observations.jsonl"


def state_path(root):
    return Path(root) / "state.json"


def append_samples(root, src, bot, cells):
    """Append one batch to samples.jsonl. cells: iterable of
    (x, z, y, block_tag). Returns number of cells written."""
    path = samples_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": _now(),
        "src": src,
        "bot": bot,
        "cells": [list(c) for c in cells],
    }
    with path.open("a") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    return len(rec["cells"])


def append_observation(root, record):
    """Append one survey/field observation to observations.jsonl (§5).
    Append-only, multi-writer-safe; record is any JSON-able dict (a `ts` is
    added if absent). Returns the record written."""
    path = observations_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {"ts": _now(), **record}
    with path.open("a") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    return rec


def read_sample_cells(root):
    """Latest-wins dict `(x, z) -> (y, block_tag)` across the whole ledger."""
    path = samples_path(root)
    out = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        for cell in rec.get("cells", ()):
            x, z, y, tag = cell
            out[(x, z)] = (y, tag)
    return out


def _kind_from_tag(tag, y):
    if y is None or tag is None:
        return "gap"
    # Strip the namespace prefix the RCON adapter emits (`minecraft:water`),
    # so the lookup against the K1-style bare names works either way.
    name = tag.split(":", 1)[1] if ":" in tag else tag
    if name in _FLUIDS:
        return "water"
    if name.endswith(_VEG_SUFFIXES):
        return "tree"
    return "ground"


def samples_for_solver(root):
    """Materialize ledger cells as K2 samples: [{x, z, y, kind}, ...]."""
    out = []
    for (x, z), (y, tag) in read_sample_cells(root).items():
        out.append({"x": x, "z": z, "y": y, "kind": _kind_from_tag(tag, y)})
    return out


def write_state(root, state):
    """Atomic state.json write via temp + rename."""
    path = state_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def read_state(root):
    path = state_path(root)
    if not path.exists():
        return None
    return json.loads(path.read_text())
