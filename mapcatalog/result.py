from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass
class Reject:
    ok: bool = False
    seed: str = ""
    stage: str = "pass1"
    reasons: list[str] | None = None

    def to_json(self, *, detail: str = "summary") -> dict[str, Any]:
        return {
            "ok": False,
            "seed": self.seed,
            "stage": self.stage,
            "reasons": self.reasons or [],
        }


def result_summary(
    *,
    requirements_id: str,
    seed: str,
    minecraft_version: str,
    arena: dict[str, Any],
    placements: dict[str, list[int]],
    score: float = 0.0,
    metrics_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    spawn = placements.get("spawn", [0, 64, 0])
    muster = placements.get("muster", spawn)
    return {
        "ok": True,
        "requirements_id": requirements_id,
        "seed": seed,
        "minecraft_version": minecraft_version,
        "arena": arena,
        "spawn": spawn,
        "muster": muster,
        "placements": placements,
        "score": score,
        "metrics_summary": metrics_summary or {},
    }


def fingerprint_payload(
    requirements_id: str,
    seed: str,
    minecraft_version: str,
    arena: dict[str, Any],
    placements: dict[str, list[int]],
    prep_commands: list[str],
) -> dict[str, Any]:
    return {
        "requirements_id": requirements_id,
        "seed": seed,
        "minecraft_version": minecraft_version,
        "arena": arena,
        "placements": placements,
        "prep_commands": prep_commands,
    }


def sha256_fingerprint(payload: dict[str, Any]) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def audit_block(*, pass1: dict | None = None, pass2: dict | None = None) -> dict[str, Any]:
    return {
        "pass1": pass1 or {},
        "pass2": pass2 or {},
        "fingerprint": {},
        "probed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
