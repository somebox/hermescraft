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


def test_shelter_render_makes_safe_dry_foundation():
    # gv2-2026-06-16-1: base sited over water drowned the colony. The render must
    # deterministically produce a dry, solid pad regardless of the chosen anchor:
    # a force-filled cobble foundation under the footprint+apron, then drained
    # water above it. (margin=2 → 11×11 pad around a 7×7 shell @ (47,64,-49).)
    cmds = g2.shelter_setblock_commands("genesis2", 47, 64, -49)
    joined = "\n".join(cmds)
    # Solid 2-layer foundation across the 11×11 (x 42..52, z -54..-44, y 62..63).
    assert "fill 42 62 -54 52 63 -44 minecraft:cobblestone" in joined
    # Standing water drained at foot/head height above the pad (y 64..66).
    assert "fill 42 64 -54 52 66 -44 minecraft:air replace minecraft:water" in joined


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


def test_p1_base_clear_template_contract():
    from lib.gv2_template_contract import lint_base_clear_policy, p1_build_epic_body

    errs = lint_base_clear_policy(p1_build_epic_body())
    assert not errs, errs  # template must have BASE-CLEAR with road_mode=true + execute=true + 16-col note


def test_base_clear_lint_catches_bad_flags():
    from lib.gv2_template_contract import lint_base_clear_policy

    # clear_strip without road_mode + level_ground without execute → both flagged
    bad = lint_base_clear_policy("BASE-CLEAR: mc clear_strip 0 0 9 9\nmc level_ground 0 0 3 3 (16 cols)")
    assert any("road_mode=true" in e for e in bad)
    assert any("execute=true" in e for e in bad)


def test_lint_level_columns_flags_oversized():
    from lib.gv2_template_contract import lint_level_columns

    assert lint_level_columns("mc level_ground 0 0 3 3 execute=true") == []   # 4x4 = 16, ok
    bad = lint_level_columns("mc level 0 0 9 9 execute=true")                 # 10x10 = 100
    assert bad and "100 columns" in bad[0]


def _reap_setup(monkeypatch):
    released: list[str] = []
    monkeypatch.setattr(g2, "_release_lease_by_owner", lambda o: (released.append(o) or True))
    return released


def test_reap_orphan_leases_frees_terminal_and_absent_owners(monkeypatch):
    released = _reap_setup(monkeypatch)
    rows = [
        {"bot": "mox", "owner_id": "genesis-v2:t_archived", "busy": False, "reachable": True},
        {"bot": "pip", "owner_id": "genesis-v2:t_absent", "busy": False, "reachable": True},
        {"bot": "zee", "owner_id": "genesis-v2:t_running", "busy": True, "reachable": True},
    ]
    status = {"t_archived": "archived", "t_running": "running"}  # t_absent missing → terminal
    freed = g2.reap_orphan_leases("gv2-x", status_by_id=status, lease_rows=rows)
    freed_bots = {f["bot"] for f in freed}
    assert freed_bots == {"mox", "pip"}            # terminal + absent reaped
    assert "genesis-v2:t_running" not in released   # active owner left alone


def test_reap_orphan_leases_skips_foreign_owners(monkeypatch):
    released = _reap_setup(monkeypatch)
    rows = [
        {"bot": "mox", "owner_id": "landfolk-ops:t_other", "busy": False, "reachable": True},
        {"bot": "pip", "owner_id": "cli:adhoc:operator", "busy": False, "reachable": True},
    ]
    freed = g2.reap_orphan_leases("gv2-x", status_by_id={}, lease_rows=rows)
    assert freed == []
    assert released == []                            # never touch non-genesis leases


def test_mark_shelter_chests(monkeypatch, tmp_path):
    import json
    monkeypatch.setattr(g2, "DATA_DIR", tmp_path)
    (tmp_path / "locations-base.json").write_text(json.dumps({
        "base_anchor": {"x": 78, "y": 64, "z": -18},  # pre-existing entry must survive
    }))
    written = g2.mark_shelter_chests({"x": 78, "y": 64, "z": -18})
    assert set(written) == {"chest_wood", "chest_food"}
    data = json.loads((tmp_path / "locations-base.json").read_text())
    assert "base_anchor" in data                       # merge-safe: existing kept
    assert (data["chest_wood"]["x"], data["chest_wood"]["y"], data["chest_wood"]["z"]) == (77, 64, -18)
    assert (data["chest_food"]["x"], data["chest_food"]["y"], data["chest_food"]["z"]) == (77, 64, -17)
    assert data["chest_wood"]["reconciled_from"] == ["render"]


def test_strip_worker_card_skills(monkeypatch, tmp_path):
    import sqlite3
    db = tmp_path / "kanban.db"
    con = sqlite3.connect(str(db))
    con.execute("CREATE TABLE tasks (id TEXT, assignee TEXT, skills TEXT, status TEXT)")
    con.executemany("INSERT INTO tasks VALUES (?,?,?,?)", [
        ("t_build", "colony-builder", '["minecraft-steward-blueprint-plan"]', "blocked"),
        ("t_scout", "colony-scout", '["x"]', "ready"),
        ("t_clean", "colony-gatherer", None, "ready"),       # no skills → untouched
        ("t_planner", "colony-planner", '["minecraft-steward-blueprint-plan"]', "ready"),  # not a worker → untouched
    ])
    con.commit(); con.close()
    monkeypatch.setattr(g2, "BOARD_DB", db)
    monkeypatch.setattr(g2, "COLONY_WORKER_ASSIGNEES",
                        frozenset({"colony-builder", "colony-scout", "colony-gatherer"}))
    unblocked = []
    monkeypatch.setattr(g2, "_hermes", lambda args, **kw: unblocked.append(args) or None)

    stripped = g2.strip_worker_card_skills()
    assert set(stripped) == {"t_build", "t_scout"}
    # blocked worker card was unblocked; ready one was not
    assert unblocked == [["unblock", "t_build"]]
    con = sqlite3.connect(str(db))
    skills = dict(con.execute("SELECT id, skills FROM tasks").fetchall())
    con.close()
    assert skills["t_build"] is None and skills["t_scout"] is None   # worker skills nulled
    assert skills["t_planner"] == '["minecraft-steward-blueprint-plan"]'  # planner untouched


def test_dispatch_looks_dead_thresholds():
    # stale log + work waiting → dead
    assert g2._dispatch_looks_dead(g2.GATEWAY_STALE_S + 1, pending=2) is True
    # fresh log → alive regardless of work
    assert g2._dispatch_looks_dead(5, pending=5) is False
    # stale but nothing waiting → not our problem (don't bounce an idle gateway)
    assert g2._dispatch_looks_dead(g2.GATEWAY_STALE_S + 1, pending=0) is False


def test_detect_dead_dispatch_uses_log_age_and_pending(monkeypatch, tmp_path):
    log = tmp_path / "gateway.log"
    log.write_text("x")
    monkeypatch.setattr(g2, "GATEWAY_LOG", log)
    # log mtime is ~now; with a far-future `now` it reads as stale.
    stale_now = log.stat().st_mtime + g2.GATEWAY_STALE_S + 10
    monkeypatch.setattr(g2, "_board_status_by_id", lambda: {"a": "ready", "b": "done"})
    assert g2.detect_dead_dispatch(now=stale_now) is True            # stale + a ready card
    assert g2.detect_dead_dispatch(now=log.stat().st_mtime + 1) is False  # fresh log
    monkeypatch.setattr(g2, "_board_status_by_id", lambda: {"a": "done", "b": "blocked"})
    assert g2.detect_dead_dispatch(now=stale_now) is False           # stale but no ready
    # gv2-2026-06-17-1 regression: todo cards parked behind unmet deps must NOT
    # read as dead dispatch (the dispatcher is correct not to claim them).
    monkeypatch.setattr(g2, "_board_status_by_id", lambda: {"a": "todo", "b": "todo", "c": "blocked"})
    assert g2.detect_dead_dispatch(now=stale_now) is False           # stale + todo-only → alive


def test_maybe_restart_dead_gateway_respects_cooldown(monkeypatch, tmp_path):
    monkeypatch.setattr(g2, "run_dir", lambda rid: tmp_path)
    monkeypatch.setattr(g2, "detect_dead_dispatch", lambda **_k: True)
    calls = []
    monkeypatch.setattr(g2, "restart_gateway", lambda: (calls.append(1) or True))
    t0 = 1_000_000.0
    assert g2.maybe_restart_dead_gateway("gv2-x", now=t0) is True          # first → restart
    assert g2.maybe_restart_dead_gateway("gv2-x", now=t0 + 10) is False    # within cooldown → skip
    assert g2.maybe_restart_dead_gateway("gv2-x", now=t0 + g2.GATEWAY_RESTART_COOLDOWN_S + 1) is True
    assert len(calls) == 2


def test_is_genesis_mine_by_author():
    pool_user = next(iter(g2.GENESIS_BODY_USERS))
    genesis = {"id": "m1", "entrances": [{"by": pool_user}], "points": []}
    prod = {"id": "stone_hill", "entrances": [{"by": "Flint"}], "points": [{"by": "Flint"}]}
    assert g2._is_genesis_mine(genesis) is True
    assert g2._is_genesis_mine(prod) is False
    assert g2._is_genesis_mine({"id": "x"}) is False


def test_genesis_mine_entries_filters_shared_world_file(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "DATA_DIR", tmp_path)
    pool_user = next(iter(g2.GENESIS_BODY_USERS))
    (tmp_path / "mines-world.json").write_text(json.dumps({"world": "world", "mines": [
        {"id": "stone_hill", "entrances": [{"by": "Flint"}]},          # production → excluded
        {"id": "genmine", "entrances": [{"by": pool_user}]},           # genesis → counted
    ]}))
    # per-world file absent; safe_world != 'world' → reads shared, filtered
    entries = g2._genesis_mine_entries("genesis2")
    assert [m["id"] for m in entries] == ["genmine"]


def test_wipe_world_mines_strips_genesis_keeps_production(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "DATA_DIR", tmp_path)
    pool_user = next(iter(g2.GENESIS_BODY_USERS))
    (tmp_path / "mines-world.json").write_text(json.dumps({"world": "world", "mines": [
        {"id": "stone_hill", "entrances": [{"by": "Flint"}]},     # production → kept
        {"id": "genmine", "entrances": [{"by": pool_user}]},      # genesis → stripped
    ]}))
    g2.wipe_world_mines("genesis2")
    left = json.loads((tmp_path / "mines-world.json").read_text())["mines"]
    assert [m["id"] for m in left] == ["stone_hill"]


def test_file_overseer_card_dedups_and_caps(monkeypatch):
    state = {"open": False, "count": 0, "created": 0}

    def fake_hermes(args, **kw):
        p = MagicMock(); p.returncode = 0
        if args[0] == "list":
            tasks = []
            if state["open"]:
                tasks.append({"id": "o_open", "title": "[GENESIS2:OVERSEE] OVERSEE P1", "status": "ready"})
            for i in range(state["count"]):
                tasks.append({"id": f"o{i}", "title": "[GENESIS2:OVERSEE] OVERSEE P1", "status": "done"})
            p.stdout = json.dumps(tasks)
        elif args[0] == "create":
            assert "colony-overseer" in args, "overseer card must route to colony-overseer"
            state["created"] += 1
            p.stdout = json.dumps({"id": "o_new"})
        return p

    monkeypatch.setattr(g2, "_hermes", fake_hermes)
    assert g2.file_overseer_card("gv2-x", "P1", {"pass": False, "failures": ["chest_* 1 < 2"]}) == "o_new"
    state["open"] = True
    assert g2.file_overseer_card("gv2-x", "P1", {"pass": False, "failures": []}) is None
    state["open"] = False; state["count"] = g2.MAX_OVERSEER_PER_PHASE
    assert g2.file_overseer_card("gv2-x", "P1", {"pass": False, "failures": []}) is None
    assert state["created"] == 1


def test_detect_supply_deficits_failsafe(monkeypatch):
    # unreadable inventory → no cards (fail-safe)
    monkeypatch.setattr(g2, "_inventory", lambda pool="genesis-v2": {"ok": False})
    assert g2.detect_supply_deficits() == []
    # measurable but empty base (totals all 0) → fail-safe, don't spam before stocked
    monkeypatch.setattr(g2, "_inventory", lambda pool="genesis-v2": {
        "ok": True, "totals": {"food": 0, "wood": 0},
        "deficits": [{"resource": "food", "current": 0, "target_min": 64, "assignee": "colony-gatherer"}]})
    assert g2.detect_supply_deficits() == []
    # measurable + something stocked + below target → returns the deficit
    monkeypatch.setattr(g2, "_inventory", lambda pool="genesis-v2": {
        "ok": True, "totals": {"food": 10, "wood": 200},
        "deficits": [{"resource": "food", "current": 10, "target_min": 64, "assignee": "colony-gatherer"}]})
    assert [d["resource"] for d in g2.detect_supply_deficits()] == ["food"]


def test_file_supply_card_routes_dedups_caps(monkeypatch):
    state = {"open": False, "count": 0, "created": 0, "assignee": None}

    def fake_hermes(args, **kw):
        p = MagicMock(); p.returncode = 0
        if args[0] == "list":
            tasks = []
            if state["open"]:
                tasks.append({"id": "s", "title": "[GENESIS2:SUPPLY] SUPPLY wood", "status": "ready"})
            for i in range(state["count"]):
                tasks.append({"id": f"s{i}", "title": "[GENESIS2:SUPPLY] SUPPLY wood", "status": "done"})
            p.stdout = json.dumps(tasks)
        elif args[0] == "create":
            state["created"] += 1
            state["assignee"] = args[args.index("--assignee") + 1]
            p.stdout = json.dumps({"id": "s_new"})
        return p

    monkeypatch.setattr(g2, "_hermes", fake_hermes)
    d = {"resource": "wood", "current": 10, "target_min": 128, "assignee": "colony-gatherer", "items": ["oak_log"]}
    assert g2.file_supply_card("gv2-x", d) == "s_new"
    assert state["assignee"] == "colony-gatherer"          # routed to genesis expertise
    state["open"] = True
    assert g2.file_supply_card("gv2-x", d) is None          # dedup on open card
    state["open"] = False; state["count"] = g2.MAX_SUPPLY_PER_RESOURCE
    assert g2.file_supply_card("gv2-x", d) is None          # cap reached
    assert state["created"] == 1


def test_detect_gate_gap_fires_on_frontier_when_idle(monkeypatch):
    gates = {"P1": {"pass": False, "failures": ["chest_* 1 < 2"]},
             "P2": {"pass": False, "failures": ["farm_* 0 < 1"]}}
    # no active cards + P1 failing → return frontier (lowest failing) + its failures
    assert g2.detect_gate_gap("gv2-x", gates=gates, active=0) == ("P1", ["chest_* 1 < 2"])
    # work in flight → don't act
    assert g2.detect_gate_gap("gv2-x", gates=gates, active=2) is None


def test_detect_gate_gap_none_when_all_pass(monkeypatch):
    gates = {"P1": {"pass": True, "failures": []}, "P2": {"pass": True, "failures": []}}
    assert g2.detect_gate_gap("gv2-x", gates=gates, active=0) is None


def test_file_gate_gap_card_dedups_and_caps(monkeypatch):
    state = {"open": False, "count": 0, "created": 0}

    def fake_hermes(args, **kw):
        p = MagicMock(); p.returncode = 0
        if args[0] == "list":
            tasks = []
            if state["open"]:
                tasks.append({"id": "g_open", "title": "[GENESIS2:GATE-GAP] GATE-GAP P1", "status": "ready"})
            for i in range(state["count"]):  # resolved priors count toward the cap
                tasks.append({"id": f"g{i}", "title": "[GENESIS2:GATE-GAP] GATE-GAP P1", "status": "done"})
            p.stdout = json.dumps(tasks)
        elif args[0] == "create":
            state["created"] += 1
            p.stdout = json.dumps({"id": "g_new"})
        return p

    monkeypatch.setattr(g2, "_hermes", fake_hermes)
    # clean → files one
    assert g2.file_gate_gap_card("gv2-x", "P1", ["chest_* 1 < 2"]) == "g_new"
    # an open card exists → skip (no duplicate)
    state["open"] = True
    assert g2.file_gate_gap_card("gv2-x", "P1", ["chest_* 1 < 2"]) is None
    # cap reached on resolved priors → skip
    state["open"] = False; state["count"] = g2.MAX_GATE_GAP_PER_PHASE
    assert g2.file_gate_gap_card("gv2-x", "P1", ["chest_* 1 < 2"]) is None
    assert state["created"] == 1


def test_reap_all_clears_every_genesis_lease(monkeypatch):
    released = _reap_setup(monkeypatch)
    rows = [
        {"bot": "mox", "owner_id": "genesis-v2:t_running", "busy": False, "reachable": True},
        {"bot": "pip", "owner_id": "landfolk-ops:t_keep", "busy": False, "reachable": True},
    ]
    status = {"t_running": "running"}
    freed = g2.reap_orphan_leases("gv2-x", reap_all=True, status_by_id=status, lease_rows=rows)
    assert {f["bot"] for f in freed} == {"mox"}      # genesis lease cleared despite "running"
    assert released == ["genesis-v2:t_running"]      # foreign lease still untouched
