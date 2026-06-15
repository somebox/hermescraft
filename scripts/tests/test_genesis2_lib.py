"""Offline tests for genesis2_lib (mock rcon/hermes/mc — no live Minecraft)."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import genesis2_lib as g2  # noqa: E402


def test_shelter_setblock_commands_include_east_door():
    cmds = g2.shelter_setblock_commands("genesis2", 100, 70, -50)
    joined = "\n".join(cmds)
    assert "oak_door" in joined
    assert "facing=east" in joined
    assert "execute in genesis2 run" in cmds[0]
    assert " fill " in joined and " air " in joined
    assert "setblock 104 70 -50 air" in joined


def test_surface_water_within_mock():
    def fake_rcon(_world, cmds):
        if "minecraft:water" in cmds[0] and "12" in cmds[0]:
            return "Test passed"
        return "Test failed"

    assert g2.surface_water_within("w", 0, 64, 0, radius=16, rcon_fn=fake_rcon)
    assert not g2.surface_water_within("w", 0, 64, 0, radius=16, rcon_fn=lambda *_a, **_k: "Test failed")


def test_probe_natural_spawn_requires_water(monkeypatch):
    monkeypatch.setattr(g2, "_bot_position", lambda _p: {"x": 10.0, "y": 70.0, "z": -5.0})
    monkeypatch.setattr(g2, "_rcon", lambda _c: "")

    def fake_rcon_in(_world, cmds):
        cmd = cmds[0] if cmds else ""
        # New ground finder: air-check then ground-tag. Make every probed cell a
        # dry dirt block so _ground_y resolves immediately and the probe reaches
        # the surface-water gate (the behavior under test).
        if "if block ~ ~ ~ minecraft:air" in cmd:
            return "Test failed"          # non-air → solid
        if "minecraft:dirt" in cmd:       # #minecraft:dirt ground tag
            return "Test passed"          # ground found
        if "minecraft:water" in cmd and "if block" in cmd:
            return "Test failed"          # not water / not submerged
        if "biome" in cmd:
            return "Test passed"
        return "Test failed"

    monkeypatch.setattr(g2, "rcon_in", fake_rcon_in)
    monkeypatch.setattr(g2, "surface_water_within", lambda *_a, **_k: False)
    with pytest.raises(RuntimeError, match="no surface water"):
        g2.probe_natural_spawn("genesis2", require_surface_water=True)


def test_render_regions_world_writes_buildable_shelter(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "DATA_DIR", tmp_path)
    monkeypatch.setattr(g2, "run_dir", lambda rid: tmp_path / rid)
    ctx = {"run_id": "gv2-test-1", "seed": "1", "started_at": "2026-06-15T00:00:00Z"}
    spawn = {"x": 5, "y": 70, "z": -3}
    g2.render_regions_world(spawn=spawn, ctx=ctx)
    data = json.loads((tmp_path / "regions-world.json").read_text())
    reg = next(r for r in data["regions"] if r["id"] == "shelter")
    assert reg["capabilities"]["allow_ad_hoc_place"] is True
    assert reg["intent"] == "marker"
    assert reg["anchor"]["x"] == 5


def test_check_phases_p1_shelter_buildable(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "DATA_DIR", tmp_path)
    (tmp_path / "locations-base.json").write_text(
        json.dumps({"base_anchor": {"x": 1, "y": 64, "z": 2}, "chest_a": {}, "chest_b": {}})
    )
    (tmp_path / "regions-world.json").write_text(
        json.dumps(
            {
                "regions": [
                    {
                        "id": "shelter",
                        "capabilities": {"allow_ad_hoc_place": True},
                    }
                ]
            }
        )
    )
    monkeypatch.setattr(g2, "_shared_marks", lambda: {"base_anchor", "chest_a", "chest_b"})
    monkeypatch.setattr(g2, "_regions", lambda: [{"id": "shelter", "capabilities": {"allow_ad_hoc_place": True}}])
    out = g2.check_phases()
    assert out["P1"]["pass"] is True


def test_requeue_deferred_respects_free_count(monkeypatch):
    monkeypatch.setattr(g2, "_free_body_count", lambda: 1)
    monkeypatch.setattr(g2, "load_config", lambda _r: {"epic_ids": ["e1"]})

    def fake_hermes(args, **kw):
        p = MagicMock()
        if args[0] == "list":
            p.stdout = json.dumps(
                [
                    {"id": "w1", "status": "blocked"},
                    {"id": "w2", "status": "blocked"},
                    {"id": "e1", "status": "blocked"},
                ]
            )
            p.returncode = 0
        elif args[0] == "show":
            p.stdout = json.dumps({"events": [{"kind": "blocked", "payload": {"reason": "no_free_body"}}]})
            p.returncode = 0
        elif args[0] == "unblock":
            p.returncode = 0
        else:
            p.returncode = 0
            p.stdout = "{}"
        return p

    monkeypatch.setattr(g2, "_hermes", fake_hermes)
    requeued = g2.requeue_deferred("gv2-x")
    assert len(requeued) == 1


def test_sync_body_pool_gates_blocks_ready_when_empty(monkeypatch):
    monkeypatch.setattr(g2, "_free_body_count", lambda: 0)
    monkeypatch.setattr(g2, "load_config", lambda _r: {"epic_ids": ["e1"]})
    blocks = []

    def fake_hermes(args, **kw):
        p = MagicMock()
        if args[0] == "list":
            p.stdout = json.dumps(
                [{"id": "w1", "status": "ready", "assignee": "colony-scout", "title": "[GENESIS2:P1] Scout"}]
            )
            p.returncode = 0
        elif args[0] == "block":
            blocks.append(args[1])
            p.returncode = 0
        else:
            p.returncode = 0
            p.stdout = "{}"
        return p

    monkeypatch.setattr(g2, "_hermes", fake_hermes)
    out = g2.sync_body_pool_gates("gv2-x")
    assert out["blocked"] == ["w1"]
    assert blocks == ["w1"]


def test_sync_body_pool_gates_caps_releases_to_free_count(monkeypatch):
    monkeypatch.setattr(g2, "_free_body_count", lambda: 1)
    monkeypatch.setattr(g2, "load_config", lambda _r: {"epic_ids": []})
    unblocked: list[str] = []

    def fake_hermes(args, **kw):
        p = MagicMock()
        if args[0] == "list":
            p.stdout = json.dumps(
                [
                    {"id": "a", "status": "blocked", "assignee": "colony-scout", "title": "[GENESIS2:P1] x"},
                    {"id": "b", "status": "blocked", "assignee": "colony-scout", "title": "[GENESIS2:P1] y"},
                ]
            )
            p.returncode = 0
        elif args[0] == "show":
            p.stdout = json.dumps(
                {"events": [{"kind": "blocked", "payload": {"reason": g2.AWAITING_FREE_BODY}}]}
            )
            p.returncode = 0
        elif args[0] == "unblock":
            unblocked.append(args[1])
            p.returncode = 0
        else:
            p.returncode = 0
            p.stdout = "{}"
        return p

    monkeypatch.setattr(g2, "_hermes", fake_hermes)
    out = g2.sync_body_pool_gates("gv2-x")
    assert out["released"] == ["a"]
    assert unblocked == ["a"]


def test_requeue_deferred_skips_awaiting_free_body(monkeypatch):
    monkeypatch.setattr(g2, "_free_body_count", lambda: 2)
    monkeypatch.setattr(g2, "load_config", lambda _r: {"epic_ids": []})
    unblocked: list[str] = []

    def fake_hermes(args, **kw):
        p = MagicMock()
        if args[0] == "list":
            p.stdout = json.dumps(
                [
                    {"id": "pool", "status": "blocked"},
                    {"id": "defer", "status": "blocked"},
                ]
            )
            p.returncode = 0
        elif args[0] == "show":
            tid = args[1]
            if tid == "pool":
                reason = g2.AWAITING_FREE_BODY
            else:
                reason = "no_free_body — defer"
            p.stdout = json.dumps({"events": [{"kind": "blocked", "payload": {"reason": reason}}]})
            p.returncode = 0
        elif args[0] == "unblock":
            unblocked.append(args[1])
            p.returncode = 0
        else:
            p.returncode = 0
            p.stdout = "{}"
        return p

    monkeypatch.setattr(g2, "_hermes", fake_hermes)
    requeued = g2.requeue_deferred("gv2-x")
    assert requeued == ["defer"]
    assert unblocked == ["defer"]


def test_p1_build_template_contract():
    from lib.gv2_template_contract import lint_p1_build_policy, p1_build_epic_body

    body = p1_build_epic_body()
    assert body
    errs = lint_p1_build_policy(body)
    assert not errs, errs
