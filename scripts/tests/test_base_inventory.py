"""Offline tests for base-inventory genesis-aware plumbing (mocked aggregate)."""
from __future__ import annotations

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("base_inventory", REPO / "scripts" / "base-inventory.py")
bi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bi)


def test_ports_for_pool_selects_genesis_bodies():
    g = bi.ports_for_pool("genesis-v2")
    assert g == bi.GENESIS_POOL
    assert set(g.values()) == {3007, 3005, 3006}        # Mox/Pip/Zee — NOT the prod 3001-3005 set
    assert bi.ports_for_pool("prod") == bi.BOT_PORTS
    assert 3007 not in bi.BOT_PORTS.values()             # prod set misses genesis Mox


def test_compute_deficits_typed_with_genesis_assignees(monkeypatch):
    # totals: food short, wood ok, stone+coal short
    monkeypatch.setattr(bi, "aggregate", lambda goals, marks, ports=None: {
        "totals": {"food": 10, "wood": 999, "stone": 0, "coal": 0},
        "chests": {"chest_food": {"fresh": True}, "chest_x": {"fresh": False}},
        "goals": goals,
    })
    out = bi.compute_deficits("genesis-v2")
    assert out["ok"] and out["pool"] == "genesis-v2"
    assert out["chests_fresh"] == 1
    res = {d["resource"]: d for d in out["deficits"]}
    assert "wood" not in res                              # above target_min → not a deficit
    assert res["food"]["assignee"] == "colony-gatherer"  # genesis routing, not prod 'flint'
    assert res["coal"]["assignee"] == "colony-miner"
    assert res["food"]["deficit"] == res["food"]["target_min"] - 10
    assert "bread" in res["food"]["items"]                # carries the goal item list


def test_compute_deficits_prod_pool_uses_goal_assignee(monkeypatch):
    monkeypatch.setattr(bi, "aggregate", lambda goals, marks, ports=None: {
        "totals": {k: 0 for k in goals}, "chests": {}, "goals": goals})
    out = bi.compute_deficits("prod")
    # prod pool keeps the goal's own assignee (default 'flint'), not genesis roles
    assert all(d["assignee"] != "colony-miner" for d in out["deficits"])
