"""Types / contract for agent-test procedural_env (M3 bridge)."""

from __future__ import annotations

from typing import Any, Literal, TypedDict


class ProceduralEnvSpec(TypedDict, total=False):
    fixture_id: str
    seed_mode: Literal["pinned", "variety", "from_report"]
    seed: int
    variety: dict[str, Any]
    report_path: str
    mc_version: str
    fingerprint: dict[str, Any]
    spawn: str
    muster_mark: str
    work_zones: str
    world: str


class InspectReportContract(TypedDict, total=False):
    """Fields agent-test and stamp_fixture rely on."""

    world: str
    seed: int
    spawn_feet: dict[str, int]
    muster: dict[str, int]
    work_bbox: dict[str, int]
    cleanup_bbox: dict[str, int]
    fingerprint_inputs: dict[str, Any]
    fingerprint: dict[str, str]
    metrics: dict[str, Any]
    metrics_by_shape: dict[str, Any]
