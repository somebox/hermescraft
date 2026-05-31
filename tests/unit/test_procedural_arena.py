"""Unit tests for procedural-arena (no live MC)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARENA = ROOT / "procedural-arena"
sys.path.insert(0, str(ARENA))

from lib.config_params import load_params, resolve_map, apply_map_size_preset, map_size_help_text
from lib.fingerprint import compute_fingerprint
from lib.safety import assert_safe_world_name
from lib.score import score_report, rank_reports
from stamp_fixture import resolve_fixture, stamp_fixture


def test_safe_world_name():
    assert_safe_world_name("proc-lab")
    try:
        assert_safe_world_name("landfolk-test")
        assert False
    except ValueError:
        pass


def test_resolve_map_defaults():
    params = load_params()
    m = resolve_map(params)
    assert m["border_radius"] == 128
    assert m["diameter"] == 256


def test_map_size_preset():
    params = load_params()
    apply_map_size_preset(params, "small")
    assert resolve_map(params)["border_radius"] == 64


def test_fingerprint_stable():
    fp1 = compute_fingerprint({"seed": 1, "fixture_id": "x"})
    fp2 = compute_fingerprint({"seed": 1, "fixture_id": "x"})
    assert fp1["sha256"] == fp2["sha256"]


def test_score_rank():
    a = {"metrics": {"prep": {"largest_flat_area": 100}, "transit": {"water_pct": 0.1}}}
    b = {"metrics": {"prep": {"largest_flat_area": 10}, "transit": {"water_pct": 0.9}}}
    w = {"prep.largest_flat_area": 1.0, "transit.water_pct": 1.0}
    ranked = rank_reports([b, a], w)
    assert ranked[0][1] is a


def test_resolve_fixture():
    spec = resolve_fixture("flat_sparse_iron_oak_forest")
    assert spec["terrain"] == "flat"


def test_stamp_fixture(tmp_path):
    manifest = stamp_fixture("flat_sparse_iron_plains", tmp_path)
    assert manifest["fixture_id"] == "flat_sparse_iron_plains"
    assert (tmp_path / "manifest.json").exists()
    assert (tmp_path / "datapack" / "pack.mcmeta").exists()


def test_mv_confirm_parsing():
    from lib.lifecycle import _MV_CONFIRM_RE

    assert _MV_CONFIRM_RE.search("Run /mv confirm 926 to continue")


def test_delete_world_sync_dry_run():
    from lib.lifecycle import delete_world_sync
    from lib.rcon import ProceduralRcon

    rcon = ProceduralRcon(dry_run=True)
    delete_world_sync(rcon, "proc-unit-test")
    assert any("mv delete proc-unit-test" in c for c in rcon.planned_commands)


def test_create_world_sync_orphan_retry():
    from lib.lifecycle import create_world_sync
    from lib.rcon import ProceduralRcon

    rcon = ProceduralRcon(dry_run=True)
    params = {"create": {"generator": "NORMAL", "structures": True}}
    create_world_sync(rcon, params, "proc-unit-test", 42)
    assert any("mv create proc-unit-test" in c for c in rcon.planned_commands)


def test_map_size_help_mentions_presets():
    text = map_size_help_text()
    assert "small" in text and "medium" in text and "r=64" in text


def test_apply_procedural_env_cleanup_auto():
    sys.path.insert(0, str(ARENA))
    from lib.procedural_env import cleanup_commands_from_report

    report = {
        "world": "proc-lab",
        "cleanup_bbox": {"x1": 0, "y1": 65, "z1": 0, "x2": 10, "y2": 80, "z2": 10},
        "muster": {"x": 1, "y": 65, "z": 1},
    }
    cmds = cleanup_commands_from_report(report)
    assert any("fill" in c for c in cmds)
    assert any("proc-lab" in c for c in cmds)
