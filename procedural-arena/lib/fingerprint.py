"""Stable fingerprint for procedural env runs."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def compute_fingerprint(inputs: dict[str, Any], *, inspect_hash: str | None = None) -> dict[str, str]:
    canonical = json.dumps(inputs, sort_keys=True, default=str)
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    out = {"sha256": digest, "canonical_preview": canonical[:200]}
    if inspect_hash:
        out["inspect_hash"] = inspect_hash
    return out
