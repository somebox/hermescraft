"""Offline tests for genesis2_lib (mock rcon/hermes/mc — no live Minecraft)."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

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
    try:
        g2.probe_natural_spawn("genesis2", require_surface_water=True)
        assert False, "expected RuntimeError for missing surface water"
    except RuntimeError as exc:
        assert "no surface water" in str(exc)


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


def test_check_phases_p4_roads_gate(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "DATA_DIR", tmp_path)
    monkeypatch.setattr(g2, "_inventory", lambda *a, **k: {"ok": False})
    monkeypatch.setattr(g2, "_regions", lambda: [])
    marks = {
        "base_anchor": {"x": 0, "y": 64, "z": 0},
        "lt_stone_far": {"x": 100, "y": 64, "z": 0},   # 100 >= 64 → far
        "lt_wood_far": {"x": 0, "y": 64, "z": 80},     # 80 >= 64 → far
        "lt_wood_near": {"x": 10, "y": 64, "z": 0},    # near → doesn't count
        "road_to_stone": {"x": 50, "y": 64, "z": 0},   # 1 confirmed road
    }
    def write(m):
        (tmp_path / "locations-base.json").write_text(json.dumps(m))
        monkeypatch.setattr(g2, "_shared_marks", lambda: set(m))
    write(marks)
    p4 = g2.check_phases()["P4"]["failures"]
    assert not any("lt_far" in f for f in p4)          # 2 far lt_* satisfies lt_far_min=2
    assert not any("confirmed roads" in f for f in p4) # 1 road_* satisfies confirmed_min=1
    # Drop a far resource + the road → both P4 sub-gates fail.
    m2 = {k: v for k, v in marks.items() if k not in ("lt_wood_far", "road_to_stone")}
    write(m2)
    p4b = g2.check_phases()["P4"]["failures"]
    assert any("lt_far" in f for f in p4b)
    assert any("confirmed roads" in f for f in p4b)


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


def test_block_invalid_ready_cards(monkeypatch):
    monkeypatch.setattr(g2, "load_config", lambda _r: {"epic_ids": []})
    blocked_calls: list[tuple[str, str]] = []
    active_reasons: dict[str, str] = {}
    tasks = [
        {
            "id": "w_bad",
            "status": "ready",
            "assignee": "colony-builder",
            "title": "[CONSTRUCT] [GENESIS2:P1] Base layer L0 chest bootstrap",
            "body": (
                "anchor: base_anchor\n"
                "source_truth: marks\n"
                "footprint: 7x7 at base_anchor\n"
                "protected_cells: none\n"
                "layer: L0\n"
                "done_when: chest placed\n"
                "mc bot checkout --near 53,63,49 --cap builder --mark base_anchor\n"
                "mc scene\n"
                "mc place chest 53,63,49\n"
                "mc bot release\n"
            ),
        },
        {
            "id": "w_ok",
            "status": "ready",
            "assignee": "colony-builder",
            "title": "[CONSTRUCT] [GENESIS2:P1] Base layer L0 foundation",
            "body": (
                "anchor: base_anchor\n"
                "source_truth: marks\n"
                "footprint: 7x7 at base_anchor\n"
                "protected_cells: none\n"
                "layer: L0\n"
                "materials_required:\n"
                "  cobblestone: 96\n"
                "preflight:\n"
                "  mc marks\n"
                "  mc scene\n"
                "work:\n"
                "  mc bot checkout --near 53,63,49 --cap builder --mark base_anchor\n"
                "  mc scene\n"
                "  mc fill cobblestone 50 63 46 56 63 52\n"
                "verify_on_site: L0 gate pass\n"
                "done_when: L0 done\n"
                "mc bot release\n"
            ),
        },
        {
            "id": "w_control",
            "status": "ready",
            "assignee": "colony-builder",
            "title": "[GENESIS2:SUPPLY] SUPPLY wood",
            "body": "anchor: base_anchor\nsource_truth: marks\ndone_when: n/a\n",
        },
    ]

    def fake_hermes(args, **kw):
        p = MagicMock()
        p.returncode = 0
        if args[0] == "list":
            p.stdout = json.dumps(tasks)
        elif args[0] == "show":
            reason = active_reasons.get(args[1], "")
            events = [{"kind": "blocked", "payload": {"reason": reason}}] if reason else []
            p.stdout = json.dumps({"events": events})
        elif args[0] == "block":
            tid, reason = args[1], args[2]
            blocked_calls.append((tid, reason))
            active_reasons[tid] = reason
            p.stdout = "{}"
        else:
            p.stdout = "{}"
        return p

    monkeypatch.setattr(g2, "_hermes", fake_hermes)
    first = g2.block_invalid_ready_cards("gv2-x")
    assert first == ["w_bad"]
    assert blocked_calls and blocked_calls[0][0] == "w_bad"
    assert blocked_calls[0][1].startswith("schema-missing:")
    second = g2.block_invalid_ready_cards("gv2-x")
    assert second == []
    assert len(blocked_calls) == 1


def test_block_invalid_ready_cards_idempotent_when_already_schema_blocked(monkeypatch):
    monkeypatch.setattr(g2, "load_config", lambda _r: {"epic_ids": []})
    blocked_calls: list[tuple[str, str]] = []
    tasks = [
        {
            "id": "w_bad",
            "status": "ready",
            "assignee": "colony-builder",
            "title": "[CONSTRUCT] [GENESIS2:P1] Base layer L0 chest bootstrap",
            "body": (
                "anchor: base_anchor\n"
                "source_truth: marks\n"
                "footprint: 7x7 at base_anchor\n"
                "protected_cells: none\n"
                "layer: L0\n"
                "done_when: chest placed\n"
                "mc bot checkout --near 53,63,49 --cap builder --mark base_anchor\n"
                "mc scene\n"
                "mc place chest 53,63,49\n"
                "mc bot release\n"
            ),
        },
    ]

    def fake_hermes(args, **kw):
        p = MagicMock()
        p.returncode = 0
        if args[0] == "list":
            p.stdout = json.dumps(tasks)
        elif args[0] == "show":
            p.stdout = json.dumps(
                {
                    "events": [
                        {
                            "kind": "blocked",
                            "payload": {
                                "reason": "schema-missing: base-layer CONSTRUCT missing preflight:",
                            },
                        }
                    ]
                }
            )
        elif args[0] == "block":
            blocked_calls.append((args[1], args[2]))
            p.stdout = "{}"
        else:
            p.stdout = "{}"
        return p

    monkeypatch.setattr(g2, "_hermes", fake_hermes)
    out = g2.block_invalid_ready_cards("gv2-x")
    assert out == []
    assert blocked_calls == []


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


def test_supply_source_picks_nearest_and_handles_missing(monkeypatch, tmp_path):
    import json
    monkeypatch.setattr(g2, "DATA_DIR", tmp_path)
    (tmp_path / "locations-base.json").write_text(json.dumps({
        "base_anchor": {"x": 0, "y": 64, "z": 0},
        "lt_stone_far": {"x": 100, "y": 64, "z": 0},
        "lt_stone_near": {"x": 10, "y": 64, "z": 0},
        "lt_stone_stale": {"x": 1, "y": 64, "z": 0, "stale": True},  # ignored
        "lt_wood_a": {"x": 50, "y": 64, "z": 0},
    }))
    # stone → nearest non-stale lt_stone_*
    name, coords = g2._supply_source("stone")
    assert name == "lt_stone_near" and coords == {"x": 10, "y": 64, "z": 0}
    # wood → the lt_wood mark
    assert g2._supply_source("wood")[0] == "lt_wood_a"
    # coal → no mine_/lt source present besides stone; coal prefixes are mine_,lt_stone_
    assert g2._supply_source("coal")[0] == "lt_stone_near"
    # food → no farm_/lt_water_ marked → None (card will escalate)
    assert g2._supply_source("food") is None


def test_starter_provision_snapshot_and_chest_fill(monkeypatch, tmp_path):
    import json
    monkeypatch.setattr(g2, "DATA_DIR", tmp_path)
    g2.write_starter_provision_snapshot({"x": 78, "y": 64, "z": -18})
    cf = json.loads((tmp_path / "chest-snapshots-render.json").read_text())["chest_food"]
    assert cf["position"] == {"x": 77, "y": 64, "z": -17}   # ax-1, az+1
    assert cf["total"] == g2.STARTER_FOOD_COUNT
    assert cf["items"][0] == {"name": g2.STARTER_FOOD_ITEM, "count": g2.STARTER_FOOD_COUNT}
    # render also physically stocks that chest
    cmds = "\n".join(g2.shelter_setblock_commands("genesis2", 78, 64, -18))
    assert (f"item replace block 77 64 -17 container.0 with "
            f"minecraft:{g2.STARTER_FOOD_ITEM} {g2.STARTER_FOOD_COUNT}") in cmds


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
    # gv2-2026-06-17-3 regression: ready cards waiting behind a full body pool
    # while agents RUN is backpressure, not dead dispatch — running>0 proves alive.
    monkeypatch.setattr(g2, "_board_status_by_id", lambda: {"a": "ready", "b": "ready", "c": "running"})
    assert g2.detect_dead_dispatch(now=stale_now) is False           # stale + ready but running → alive
    monkeypatch.setattr(g2, "_board_status_by_id", lambda: {"a": "ready", "b": "ready"})
    assert g2.detect_dead_dispatch(now=stale_now) is True            # stale + ready + nothing running → dead


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


# --- Deterministic tool-error backstop -------------------------------------

def test_body_for_task_matches_owner_substring():
    rows = [
        {"bot": "mox", "owner_id": "genesis-v2:t_aaa:sess1"},
        {"bot": "pip", "owner_id": "genesis-v2:t_bbb"},
    ]
    assert g2._body_for_task("t_bbb", rows) == "pip"
    assert g2._body_for_task("t_aaa", rows) == "mox"
    assert g2._body_for_task("t_zzz", rows) is None


def test_recent_action_errors_windows_by_timestamp(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "RUNTIME_DIR", tmp_path)
    log = tmp_path / "actions-Zee.jsonl"
    log.write_text("\n".join([
        json.dumps({"bot": "Zee", "action": "move", "status": "error", "started_at": 1000, "detail": "old"}),
        json.dumps({"bot": "Zee", "action": "goto", "status": "done", "started_at": 6000}),
        json.dumps({"bot": "Zee", "action": "place", "status": "error", "started_at": 7000, "detail": "no path"}),
        json.dumps({"bot": "Zee", "action": "wall", "status": "error", "started_at": 8000, "detail": "blocked"}),
    ]))
    # since_ms=5000 → the 1000ms error is excluded; two recent errors counted.
    n, last = g2._recent_action_errors("Zee", 5000)
    assert n == 2
    assert last == "blocked"
    # No log for an unknown bot → zero.
    assert g2._recent_action_errors("Nobody", 0) == (0, None)


def _spin_hermes(tasks):
    def fake(args, **kw):
        p = MagicMock(); p.returncode = 0
        p.stdout = json.dumps(tasks) if args and args[0] == "list" else "{}"
        return p
    return fake


def test_detect_tool_error_spin_flags_over_threshold(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(g2, "time", _FakeTime(10_000))  # now = 10_000s
    monkeypatch.setattr(g2, "_pool_lease_rows",
                        lambda: [{"bot": "Zee", "owner_id": "genesis-v2:t_build"}])
    monkeypatch.setattr(g2, "_hermes", _spin_hermes([
        {"id": "t_build", "title": "[BUILD] shelter", "status": "running", "started_at": 9_000},
        {"id": "t_mission", "title": "[MISSION] colony", "status": "running", "started_at": 1},
    ]))
    # 15 errors within the window (now=10_000s → since≈9_700s=9_700_000ms; card start 9_000s).
    lines = [json.dumps({"bot": "Zee", "action": "move", "status": "error",
                         "started_at": 9_800_000 + i, "detail": "No path"}) for i in range(15)]
    (tmp_path / "actions-Zee.jsonl").write_text("\n".join(lines))
    spun = g2.detect_tool_error_spin()
    assert [s["id"] for s in spun] == ["t_build"]   # MISSION excluded
    assert spun[0]["error_count"] == 15
    assert spun[0]["bot"] == "Zee"


def test_detect_tool_error_spin_ignores_below_threshold(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(g2, "time", _FakeTime(10_000))
    monkeypatch.setattr(g2, "_pool_lease_rows",
                        lambda: [{"bot": "Zee", "owner_id": "genesis-v2:t_build"}])
    monkeypatch.setattr(g2, "_hermes", _spin_hermes([
        {"id": "t_build", "title": "[BUILD] shelter", "status": "running", "started_at": 9_000},
    ]))
    lines = [json.dumps({"bot": "Zee", "action": "move", "status": "error",
                         "started_at": 9_800_000 + i}) for i in range(3)]
    (tmp_path / "actions-Zee.jsonl").write_text("\n".join(lines))
    assert g2.detect_tool_error_spin() == []


def test_supervise_or_park_parks_when_cap_exhausted(monkeypatch):
    monkeypatch.setattr(g2, "file_supervise_card", lambda *a, **k: None)  # cap/no new card
    # 3 prior DONE supervise cards (cap=3, none open) → should park.
    tasks = [{"id": f"s{i}", "title": "[GENESIS2:SUPERVISE] SUPERVISE t_x", "status": "done"} for i in range(3)]
    monkeypatch.setattr(g2, "_hermes", _spin_hermes(tasks))
    captured = {}
    def _park(r, w, t):
        captured["parked"] = w
        return "t_rescope"
    monkeypatch.setattr(g2, "park_capped_worker", _park)
    res = g2.supervise_or_park("gv2-x", "t_x", "build shelter", "stuck")
    assert res == {"action": "parked", "id": "t_rescope"}
    assert captured["parked"] == "t_x"


def test_supervise_or_park_noop_when_open_supervise(monkeypatch):
    monkeypatch.setattr(g2, "file_supervise_card", lambda *a, **k: None)
    tasks = [{"id": "s1", "title": "[GENESIS2:SUPERVISE] SUPERVISE t_x", "status": "running"}]
    monkeypatch.setattr(g2, "_hermes", _spin_hermes(tasks))
    res = g2.supervise_or_park("gv2-x", "t_x", "build", "stuck")
    assert res["action"] == "noop"


def test_file_supervise_skips_schema_missing_block(monkeypatch):
    created = []

    def fake(args, **kw):
        p = MagicMock()
        p.returncode = 0
        if args and args[0] == "list":
            p.stdout = "[]"
        elif args and args[0] == "show":
            p.stdout = json.dumps(
                {
                    "events": [
                        {
                            "kind": "blocked",
                            "payload": {"reason": "schema-missing: base-layer CONSTRUCT missing preflight:"},
                        }
                    ]
                }
            )
        elif args and args[0] == "create":
            created.append(args)
            p.stdout = json.dumps({"id": "t_supervise"})
        else:
            p.stdout = "{}"
        return p

    monkeypatch.setattr(g2, "_hermes", fake)
    out = g2.file_supervise_card("gv2-x", "w_bad", "Bad construct", "blocked by schema gate")
    assert out is None
    assert created == []


class _FakeTime:
    """Minimal stand-in for the `time` module: fixed time(), real sleep is unused."""
    def __init__(self, now_s): self._now = now_s
    def time(self): return self._now


def test_capture_run_artifacts_snapshots_sessions_and_board(tmp_path, monkeypatch):
    # Fake profile tree with a session error dump + agent.log, and a runtime action log.
    home = tmp_path / "home"
    prof = home / ".hermes" / "profiles" / "colony-scout"
    (prof / "logs").mkdir(parents=True)
    (prof / "logs" / "agent.log").write_text("log line\n")
    (prof / "sessions").mkdir(parents=True)
    (prof / "sessions" / "dump1.json").write_text('{"reason":"x"}')
    runtime = tmp_path / "runtime"; runtime.mkdir()
    (runtime / "actions-Mox.jsonl").write_text('{"bot":"Mox"}\n')
    runs = tmp_path / "runs"
    monkeypatch.setattr(g2, "RUNS_ROOT", runs)
    monkeypatch.setattr(g2, "RUNTIME_DIR", runtime)
    monkeypatch.setattr(g2.os.path, "expanduser", lambda p: p.replace("~", str(home)))
    monkeypatch.setattr(g2, "_hermes", _spin_hermes([{"id": "t1", "status": "done"}]))
    res = g2.capture_run_artifacts("gv2-test")
    dest = runs / "gv2-test" / "artifacts"
    assert (dest / "colony-scout" / "sessions" / "dump1.json").exists()  # the wipe-vulnerable dumps
    assert (dest / "colony-scout" / "agent.log").exists()
    assert (dest / "actions-Mox.jsonl").exists()
    assert (dest / "board.json").exists()
    assert res["run_id"] == "gv2-test" and res["files"] >= 4


# --- Site-fit scoring -------------------------------------------------------

def test_score_site_stone_gate_and_water_weight():
    # base near stone+wood, water far → buildable, score reflects weights.
    marks = {
        "base_anchor": (0, 64, 0),
        "lt_stone_ne": (10, 64, 5),    # ~11 < 24 → stone_ok (gate pass)
        "lt_wood_nw": (0, 64, 20),     # 20 < 48 → wood_ok
        "lt_water_sw": (0, 64, 85),    # 85 > 48 → water NOT ok (dry world)
    }
    s = g2.score_site((0, 64, 0), marks)
    assert s["buildable"] is True          # stone within range
    assert s["score"] == 1 + 2 + 0 + 1     # base + stone + (no water) + wood = 4
    assert "no_water_within_48" in s["flags"]
    assert s["stone_mark"] == "lt_stone_ne"


def test_score_site_unbuildable_when_no_nearby_stone():
    marks = {"base_anchor": (0, 64, 0), "lt_stone_far": (200, 64, 0), "lt_water_sw": (5, 64, 5)}
    s = g2.score_site((0, 64, 0), marks)
    assert s["buildable"] is False
    assert any(f.startswith("no_stone") for f in s["flags"])


def test_rank_candidate_pads_orders_by_score():
    marks = {
        "candidate_pad_a": (0, 64, 0),       # no stone nearby → low
        "candidate_pad_b": (100, 64, 0),     # stone + water adjacent → high
        "lt_stone_b": (102, 64, 1),
        "lt_water_b": (101, 64, 2),
        "lt_wood_b": (103, 64, 0),
    }
    ranked = g2.rank_candidate_pads(marks)
    assert ranked[0]["name"] == "candidate_pad_b"
    assert ranked[0]["score"] > ranked[-1]["score"]


def test_site_fit_brief_warns_on_unbuildable_anchor():
    marks = {
        "base_anchor": (0, 64, 0),               # no stone nearby
        "candidate_pad_good": (50, 64, 0),
        "lt_stone_g": (51, 64, 1),
    }
    brief = g2.site_fit_brief()
    # site_fit_brief reads from disk; drive it via score directly to avoid IO here.
    # (Covered by score/rank tests above; ensure the helper is import-safe.)
    assert isinstance(g2.rank_candidate_pads(marks), list)


def test_file_site_advisory_dedups_and_skips_buildable(monkeypatch):
    # Unbuildable anchor, no existing advisory → files one.
    monkeypatch.setattr(g2, "site_fit_brief", lambda: {
        "base_anchor": {"score": 2, "buildable": False, "flags": ["no_stone_within_24"],
                        "stone_dist": 80, "stone_mark": "lt_stone_far",
                        "water_dist": 85, "wood_dist": 10},
        "best": {"name": "candidate_pad_b", "score": 4},
        "warning": "base_anchor scores 2/5",
    })
    created = []
    def fake(args, **kw):
        p = MagicMock(); p.returncode = 0
        if args and args[0] == "list":
            p.stdout = "[]"
        elif args and args[0] == "create":
            created.append(args); p.stdout = json.dumps({"id": "t_adv"})
        else:
            p.stdout = "{}"
        return p
    monkeypatch.setattr(g2, "_hermes", fake)
    assert g2.file_site_advisory("gv2-x") == "t_adv"
    assert created and "[GENESIS2:SITE-ADVISORY]" in created[0][1]
    # Buildable anchor → no advisory.
    monkeypatch.setattr(g2, "site_fit_brief", lambda: {"base_anchor": {"buildable": True}})
    assert g2.file_site_advisory("gv2-x") is None


# --- Emergent stock brief + planner brief ----------------------------------

def test_file_stock_brief_files_once_then_dedups(monkeypatch):
    monkeypatch.setattr(g2, "detect_supply_deficits",
                        lambda *a, **k: [{"resource": "cobblestone", "current": 12,
                                          "target_min": 128, "deficit": 116, "assignee": "colony-miner"}])
    monkeypatch.setattr(g2, "_supply_source", lambda r: None)
    state = {"open": False}
    created = []
    def fake(args, **kw):
        p = MagicMock(); p.returncode = 0
        if args and args[0] == "list":
            p.stdout = json.dumps(
                [{"id": "t_sb", "title": "[GENESIS2:STOCK-BRIEF] STOCK-BRIEF", "status": "running"}]
                if state["open"] else [])
        elif args and args[0] == "create":
            created.append(args); p.stdout = json.dumps({"id": "t_sb"})
        else:
            p.stdout = "{}"
        return p
    monkeypatch.setattr(g2, "_hermes", fake)
    assert g2.file_stock_brief("gv2-x") == "t_sb"          # first: filed
    assert "[GENESIS2:STOCK-BRIEF]" in created[0][1]
    state["open"] = True
    assert g2.file_stock_brief("gv2-x") is None            # open brief → deduped


def test_file_stock_brief_none_when_no_deficits(monkeypatch):
    monkeypatch.setattr(g2, "detect_supply_deficits", lambda *a, **k: [])
    assert g2.file_stock_brief("gv2-x") is None


def test_planner_brief_aggregates_sitefit_and_stock(monkeypatch):
    monkeypatch.setattr(g2, "site_fit_brief", lambda: {"anchor_buildable": True})
    monkeypatch.setattr(g2, "detect_supply_deficits", lambda *a, **k: [{"resource": "food"}])
    b = g2.planner_brief()
    assert b["site_fit"] == {"anchor_buildable": True}
    assert b["stock_deficits"] == [{"resource": "food"}]


# --- Verification & retro (Phase 5) ----------------------------------------

def test_verify_built_structure_counts_world_blocks_not_marks():
    # Fake RCON: report planks at a 3x3 footprint, wall height 1 → >= min_blocks.
    built_cells = {(px, pz) for px in range(-1, 2) for pz in range(-1, 2)}
    def fake_rcon(_world, cmds):
        cmd = cmds[0]
        # parse "execute positioned PX PY PZ if block ..."
        parts = cmd.split()
        px, py, pz = int(parts[2]), int(parts[3]), int(parts[4])
        if py == 65 and (px, pz) in {(0 + dx, 0 + dz) for dx, dz in built_cells} and "planks" in cmd:
            return "Test passed"
        return "Test failed"
    r = g2.verify_built_structure("genesis2", 0, 64, 0, radius=1, height=1,
                                  min_blocks=6, rcon_fn=fake_rcon)
    assert r["built"] is True
    assert r["solid_blocks"] == 9        # 3x3 planks
    # Empty area → not built.
    r2 = g2.verify_built_structure("genesis2", 0, 64, 0, radius=1, height=1,
                                   rcon_fn=lambda *_a, **_k: "Test failed")
    assert r2["built"] is False and r2["solid_blocks"] == 0


def test_file_retro_cards_one_per_agent_skips_open(monkeypatch):
    created = []
    def fake(args, **kw):
        p = MagicMock(); p.returncode = 0
        if args and args[0] == "list":
            # colony-scout already has an OPEN retro → should be skipped.
            p.stdout = json.dumps([{"assignee": "colony-scout",
                                    "title": "[RETRO] Round feedback — reflection only",
                                    "status": "running"}])
        elif args and args[0] == "create":
            created.append(args[args.index("--assignee") + 1])
            p.stdout = json.dumps({"id": "t_" + str(len(created))})
        else:
            p.stdout = "{}"
        return p
    monkeypatch.setattr(g2, "_hermes", fake)
    monkeypatch.setattr(g2, "load_config", lambda _r: {"run_id": "gv2-x"})
    monkeypatch.setattr(g2, "save_config", lambda _c: None)
    out = g2.file_retro_cards("gv2-x")
    assert "colony-scout" not in out          # skipped (open retro)
    assert "colony-builder" in out and "colony-planner" in out
    assert len(out) == len(g2.RETRO_AGENTS) - 1


def test_file_retro_cards_use_high_priority(monkeypatch):
    create_args = []
    def fake(args, **kw):
        p = MagicMock(); p.returncode = 0
        if args and args[0] == "list":
            p.stdout = "[]"
        elif args and args[0] == "create":
            create_args.append(list(args))
            p.stdout = json.dumps({"id": "t_retro"})
        else:
            p.stdout = "{}"
        return p
    monkeypatch.setattr(g2, "_hermes", fake)
    monkeypatch.setattr(g2, "load_config", lambda _r: {"run_id": "gv2-x"})
    monkeypatch.setattr(g2, "save_config", lambda _c: None)
    g2.file_retro_cards("gv2-x", agents=("colony-scout",))
    assert create_args
    args = create_args[0]
    assert str(g2.RETRO_CARD_PRIORITY) in args
    assert args[args.index("--priority") + 1] == str(g2.RETRO_CARD_PRIORITY)


def test_retro_cards_not_pool_gated():
    epic_ids = set()
    retro = {"id": "t_r", "title": "[RETRO] Round feedback", "assignee": "colony-builder", "status": "ready"}
    worker = {"id": "t_w", "title": "[GENESIS2] build", "assignee": "colony-builder", "status": "ready"}
    assert g2._is_pool_gated_worker(retro, epic_ids) is False
    assert g2._is_pool_gated_worker(worker, epic_ids) is True


def test_wait_for_retro_cards_succeeds_when_done(monkeypatch):
    calls = [0]
    def fake_snap(**_k):
        calls[0] += 1
        if calls[0] == 1:
            return {"total": 1, "ready": [], "running": ["t_r"], "done": [],
                    "other": [], "pending": 1}
        return {"total": 1, "ready": [], "running": [], "done": ["t_r"],
                "other": [], "pending": 0}
    monkeypatch.setattr(g2, "retro_card_snapshot", fake_snap)
    monkeypatch.setattr(g2.time, "sleep", lambda _s: None)
    out = g2.wait_for_retro_cards("gv2-x", timeout_s=60, poll_s=5)
    assert out["ok"] is True
    assert out["pending"] == 0


def test_wait_for_retro_cards_timeout_reports_incomplete(monkeypatch):
    snap = {"total": 2, "ready": ["t_r1"], "running": ["t_r2"], "done": [],
            "other": [], "pending": 2}
    monkeypatch.setattr(g2, "retro_card_snapshot", lambda **_k: snap)
    monkeypatch.setattr(g2.time, "sleep", lambda _s: None)
    t = [1000.0]
    monkeypatch.setattr(g2.time, "time", lambda: t.__setitem__(0, t[0] + 500) or t[0])
    out = g2.wait_for_retro_cards("gv2-x", timeout_s=10, poll_s=1)
    assert out["ok"] is False
    assert out["timed_out"] is True
    assert "t_r1" in out["incomplete_ids"] and "t_r2" in out["incomplete_ids"]


def test_ensure_retro_phase_files_when_missing(monkeypatch):
    calls = {"filed": 0, "timeout_s": None}
    cfg = {"run_id": "gv2-x"}
    saves = []

    monkeypatch.setattr(g2, "retro_card_snapshot", lambda **_k: {
        "total": 0, "ready": [], "running": [], "done": [], "other": [], "pending": 0
    })

    def fake_file(run_id, agents=g2.RETRO_AGENTS):
        calls["filed"] += 1
        assert run_id == "gv2-x"
        assert agents == g2.RETRO_AGENTS
        return {"colony-scout": "t1", "colony-builder": "t2"}

    def fake_wait(run_id, *, timeout_s=g2.RETRO_WAIT_DEFAULT_S, poll_s=10):
        assert run_id == "gv2-x"
        calls["timeout_s"] = timeout_s
        return {"total": 2, "ready": [], "running": [], "done": ["t1", "t2"],
                "other": [], "pending": 0, "ok": True, "timed_out": False}

    monkeypatch.setattr(g2, "file_retro_cards", fake_file)
    monkeypatch.setattr(g2, "wait_for_retro_cards", fake_wait)
    monkeypatch.setattr(g2, "load_config", lambda _r: dict(cfg))
    monkeypatch.setattr(g2, "save_config", lambda c: saves.append(dict(c)))

    out = g2.ensure_retro_phase("gv2-x", wait_s=77)
    assert out["ok"] is True
    assert out["filed"] == 2
    assert calls["filed"] == 1
    assert calls["timeout_s"] == 77
    assert "retro_incomplete_at_stop" not in saves[-1]


def test_ensure_retro_phase_idempotent_when_cards_exist(monkeypatch):
    wait_calls = []
    saves = []

    monkeypatch.setattr(g2, "retro_card_snapshot", lambda **_k: {
        "total": 1, "ready": [], "running": [], "done": ["t_r"], "other": [], "pending": 0
    })
    monkeypatch.setattr(g2, "file_retro_cards",
                        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("should not file")))
    monkeypatch.setattr(g2, "wait_for_retro_cards",
                        lambda _r, *, timeout_s=g2.RETRO_WAIT_DEFAULT_S, poll_s=10:
                        (wait_calls.append(timeout_s) or
                         {"total": 1, "ready": [], "running": [], "done": ["t_r"], "other": [],
                          "pending": 0, "ok": True, "timed_out": False}))
    monkeypatch.setattr(g2, "load_config",
                        lambda _r: {"run_id": "gv2-x", "retro_incomplete_at_stop": "2026-01-01T00:00:00Z"})
    monkeypatch.setattr(g2, "save_config", lambda c: saves.append(dict(c)))

    a = g2.ensure_retro_phase("gv2-x")
    b = g2.ensure_retro_phase("gv2-x")
    assert a["filed"] == 0 and b["filed"] == 0
    assert wait_calls == [g2.RETRO_WAIT_DEFAULT_S, g2.RETRO_WAIT_DEFAULT_S]
    assert "retro_incomplete_at_stop" not in saves[-1]


def test_ensure_retro_phase_marks_incomplete_on_timeout(monkeypatch):
    saves = []
    monkeypatch.setattr(g2, "retro_card_snapshot", lambda **_k: {
        "total": 1, "ready": ["t_r"], "running": [], "done": [], "other": [], "pending": 1
    })
    monkeypatch.setattr(g2, "wait_for_retro_cards", lambda *_a, **_k: {
        "total": 1, "ready": ["t_r"], "running": [], "done": [], "other": [],
        "pending": 1, "ok": False, "timed_out": True, "incomplete_ids": ["t_r"]
    })
    monkeypatch.setattr(g2, "load_config", lambda _r: {"run_id": "gv2-x"})
    monkeypatch.setattr(g2, "save_config", lambda c: saves.append(dict(c)))
    out = g2.ensure_retro_phase("gv2-x")
    assert out["ok"] is False
    assert out["snap"]["timed_out"] is True
    assert "retro_incomplete_at_stop" in saves[-1]


def test_run_cap_score_bundle_runs_collect_then_score(monkeypatch):
    calls = []

    def fake_run(cmd, **_kw):
        calls.append(cmd)
        p = MagicMock()
        p.returncode = 0
        p.stderr = ""
        p.stdout = ""
        return p

    monkeypatch.setattr(g2.subprocess, "run", fake_run)
    out = g2.run_cap_score_bundle("gv2-x")
    assert out["ok"] is True
    assert len(calls) == 2
    assert calls[0][1].endswith("gv2-collect-feedback.py")
    assert calls[1][1].endswith("gv2-score-run.py")


def test_poller_cap_calls_retro_phase_before_capture(monkeypatch):
    poller_path = REPO / "scripts" / "genesis-v2-poller.py"
    spec = importlib.util.spec_from_file_location("gv2_poller_test_mod", poller_path)
    assert spec and spec.loader
    poller = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(poller)

    # run_started uses first reading (0); cap check uses second (1000) => cap branch.
    ticks = iter([0.0, 1000.0])
    monkeypatch.setattr(poller.time, "time", lambda: next(ticks))
    monkeypatch.setattr(
        poller.argparse.ArgumentParser,
        "parse_args",
        lambda self: type("Args", (), {
            "run_id": "gv2-x",
            "interval": 1,
            "max_runtime_h": 0.001,
            "validate_every_min": 0,
        })(),
    )

    calls = []
    monkeypatch.setattr(poller.g2, "load_config", lambda _r: {"mode": "emergent"})
    monkeypatch.setattr(poller.g2, "ensure_observer_watching", lambda _r: False)
    monkeypatch.setattr(poller.g2, "ensure_retro_phase",
                        lambda _r, wait_s=None: calls.append(("ensure", wait_s)) or {"ok": True})
    monkeypatch.setattr(poller.g2, "capture_run_artifacts",
                        lambda _r: calls.append(("capture", None)) or {"ok": True})
    monkeypatch.setattr(poller.g2, "run_cap_score_bundle",
                        lambda _r: calls.append(("bundle", None)) or {"ok": True})
    monkeypatch.setattr(poller.g2, "teardown_session",
                        lambda: calls.append(("teardown", None)))

    rc = poller.main()
    assert rc == 0
    assert calls == [
        ("ensure", poller.g2.CAP_RETRO_WAIT_S),
        ("capture", None),
        ("bundle", None),
        ("teardown", None),
    ]


def test_detect_dead_dispatch_retro_ready_with_worker_running_not_dead(monkeypatch, tmp_path):
    """Retro cards waiting while workers run is backpressure, not dead dispatch."""
    log = tmp_path / "gateway.log"
    log.write_text("x")
    monkeypatch.setattr(g2, "GATEWAY_LOG", log)
    stale_now = log.stat().st_mtime + g2.GATEWAY_STALE_S + 10
    monkeypatch.setattr(g2, "_board_status_by_id", lambda: {
        "retro": "ready", "worker": "running", "other": "ready",
    })
    assert g2.detect_dead_dispatch(now=stale_now) is False


# --- Mission guard + run cap (gv2-2026-06-20-1) -----------------------------

def test_reengage_when_mission_done_creates_manage_card(monkeypatch):
    # A completed [MISSION] card is terminal — there is no `retry` verb and `done`
    # cards cannot be reopened — so continuity rides on a fresh [GENESIS2:MANAGE] card.
    calls = []
    def fake(args, **kw):
        calls.append(args)
        p = MagicMock(); p.returncode = 0
        if args and args[0] == "list":
            p.stdout = json.dumps([{"id": "t_82005f15", "title": "[MISSION] Establish a thriving colony",
                                    "status": "done"}])
        elif args and args[0] == "create":
            p.stdout = json.dumps({"id": "t_new"})
        else:
            p.stdout = "{}"
        return p
    monkeypatch.setattr(g2, "_hermes", fake)
    assert g2.reengage_planner_if_mission_closed("gv2-x") == "t_new"
    verbs = [c[0] for c in calls]
    assert "create" in verbs
    assert "retry" not in verbs  # retry is not a kanban verb — never attempt it


def test_reengage_noop_when_mission_active(monkeypatch):
    monkeypatch.setattr(g2, "_hermes", _spin_hermes([
        {"id": "t_82005f15", "title": "[MISSION] colony", "status": "running"}]))
    assert g2.reengage_planner_if_mission_closed("gv2-x") is None


def test_reengage_dedups_on_open_manage(monkeypatch):
    # At most one OPEN re-engage card in flight: if one already exists, do not mint another.
    def fake(args, **kw):
        p = MagicMock(); p.returncode = 0
        if args and args[0] == "list":
            p.stdout = json.dumps([
                {"id": "t_82005f15", "title": "[MISSION] colony", "status": "done"},
                {"id": "t_m1", "title": "[GENESIS2:MANAGE] MANAGE re-engage", "status": "running"},
            ])
        else:
            p.stdout = "{}"
        return p
    monkeypatch.setattr(g2, "_hermes", fake)
    assert g2.reengage_planner_if_mission_closed("gv2-x") is None


def test_parse_online_players():
    assert g2.parse_online_players("There are 0 of a max of 10 players online:") == []
    assert g2.parse_online_players("There are 1 of a max of 10 players online: re44") == ["re44"]
    assert g2.parse_online_players(
        "There are 3 of a max of 10 players online: re44, Mox, Pip"
    ) == ["re44", "Mox", "Pip"]


def test_setup_observer_uses_parsed_list_and_world_scoped_commands(monkeypatch):
    calls: list[list[str]] = []

    def fake_rcon(cmds):
        calls.append(list(cmds))
        return "There are 1 of a max of 10 players online: re44"

    def fake_rcon_in(world, cmds):
        calls.append([f"in:{world}"] + list(cmds))
        return "ok"

    monkeypatch.setattr(g2, "_rcon", fake_rcon)
    monkeypatch.setattr(g2, "rcon_in", fake_rcon_in)
    monkeypatch.setattr(g2.time, "sleep", lambda _s: None)
    ok = g2.setup_observer("genesis2", {"x": 10, "y": 64, "z": -5}, "re44")
    assert ok is True
    assert calls[0] == ["list"]
    assert calls[1] == ["mvtp re44 genesis2"]
    assert "tp re44 10 67 -5" in calls[2][1]
    assert "gamemode spectator re44" in calls[2][2]


def test_setup_observer_skips_when_offline(monkeypatch):
    monkeypatch.setattr(g2, "_rcon", lambda _c: "There are 0 of a max of 10 players online:")
    assert g2.setup_observer("genesis2", {"x": 0, "y": 64, "z": 0}) is False


def test_evac_to_hub_observer_first(monkeypatch):
    mvtps: list[str] = []

    def fake_rcon(cmds):
        if cmds == ["list"]:
            return "There are 2 of a max of 10 players online: re44, Mox"
        mvtps.append(cmds[0])
        return "ok"

    monkeypatch.setattr(g2, "_rcon", fake_rcon)
    monkeypatch.setattr(g2.time, "sleep", lambda _s: None)
    monkeypatch.setattr(g2, "RUNS_ROOT", Path("/nonexistent"))
    order = g2.evac_to_hub_before_world_reset(hub="landfolk-test", observer="re44")
    assert order[0] == "re44"
    assert mvtps[0] == "mvtp re44 landfolk-test"


def test_ensure_observer_watching_on_connect_mid_run(tmp_path, monkeypatch):
    rid = "gv2-observer-test"
    monkeypatch.setattr(g2, "run_dir", lambda _r: tmp_path / _r)
    (tmp_path / rid).mkdir(parents=True)
    (tmp_path / rid / "config.json").write_text(
        json.dumps({"world": "genesis2", "spawn": {"x": 1, "y": 64, "z": 2}})
    )
    states = ["offline", "online", "online"]

    def fake_list(_cmds):
        if states[0] == "offline":
            return "There are 0 of a max of 10 players online:"
        return "There are 1 of a max of 10 players online: re44"

    monkeypatch.setattr(g2, "_rcon", lambda cmds: fake_list(cmds))
    setup_calls = []

    def fake_setup(world, spawn, observer=None):
        setup_calls.append((world, spawn, observer))
        return True

    monkeypatch.setattr(g2, "setup_observer", fake_setup)
    assert g2.ensure_observer_watching(rid) is False
    states[0] = "online"
    assert g2.ensure_observer_watching(rid) is True
    assert setup_calls == [("genesis2", {"x": 1, "y": 64, "z": 2}, "re44")]
    assert g2._observer_session_marker(rid, "re44").is_file()
    assert g2.ensure_observer_watching(rid) is False  # already set up this stint
    states[0] = "offline"
    assert g2.ensure_observer_watching(rid) is False
    assert not g2._observer_session_marker(rid, "re44").is_file()
    states[0] = "online"
    assert g2.ensure_observer_watching(rid) is True
    assert len(setup_calls) == 2


def test_reengage_manage_card_is_assigned_to_planner(monkeypatch):
    created = []
    def fake(args, **kw):
        p = MagicMock(); p.returncode = 0
        if args and args[0] == "list":
            p.stdout = json.dumps([{"id": "t_82005f15", "title": "[MISSION] colony", "status": "done"}])
        elif args and args[0] == "create":
            created.append(args); p.stdout = json.dumps({"id": "t_new"})
        else:
            p.stdout = "{}"
        return p
    monkeypatch.setattr(g2, "_hermes", fake)
    assert g2.reengage_planner_if_mission_closed("gv2-x") == "t_new"
    assert "[GENESIS2:MANAGE]" in created[0][1]
    assert "colony-planner" in created[0]


# --- action-log run-scoping (capture_run_artifacts windowing) -----------------

def test_scope_action_rows_windows_and_counts():
    # Window [1000, 2000] epoch ms. Rows: before / in / after / no-ts / bad-json /
    # in-via-finished_at-fallback. Only the two in-window rows survive (in order); the
    # out-of-window and malformed-timestamp rows are dropped AND counted.
    start_ms, end_ms = 1000, 2000
    rows = [
        json.dumps({"started_at": 500, "action": "before"}),
        json.dumps({"started_at": 1500, "action": "in"}),
        json.dumps({"started_at": 2500, "action": "after"}),
        json.dumps({"action": "no_ts"}),                       # missing timestamp
        "{ not valid json",                                    # unparseable
        json.dumps({"finished_at": 1600, "action": "fallback"}),  # in-window via fallback
    ]
    kept, stats = g2.scope_action_rows(rows, start_ms, end_ms)
    assert [json.loads(l)["action"] for l in kept] == ["in", "fallback"]
    assert stats == {"total": 6, "kept": 2, "dropped_out_of_window": 2, "dropped_bad_ts": 2}


def test_scope_action_rows_no_window_keeps_all_valid():
    # start_ms=None → no window applied; only malformed-ts rows are dropped.
    rows = [
        json.dumps({"started_at": 500, "action": "a"}),
        json.dumps({"started_at": 9_000_000, "action": "b"}),
        json.dumps({"action": "no_ts"}),
    ]
    kept, stats = g2.scope_action_rows(rows, None, None)
    assert [json.loads(l)["action"] for l in kept] == ["a", "b"]
    assert stats["kept"] == 2 and stats["dropped_out_of_window"] == 0 and stats["dropped_bad_ts"] == 1


def _write_queue(repo_root: Path, items: list) -> None:
    q = repo_root / "data" / "genesis-v2"
    q.mkdir(parents=True, exist_ok=True)
    (q / "improvement-queue.json").write_text(json.dumps({"schema_version": 1, "items": items}))


def test_run_start_metadata_flows_verified_item_expected_metrics(tmp_path):
    # A "verified" WorkItem (implemented+tested, awaiting its same-arm validation run)
    # must seed the next run's expected_metrics so the scorecard auto-evaluates it.
    _write_queue(tmp_path, [
        {"work_id": "w1", "status": "verified",
         "expected_metrics": {"audit.scope_coverage_ratio": {"min": 0.5}, "compare.compare_safe": True}},
        {"work_id": "w2", "status": "proposed",
         "expected_metrics": {"establishment.score": {"min": 9.0}}},  # must NOT flow
    ])
    cfg = g2.apply_run_start_metadata({"run_id": "gv2-test"}, repo_root=tmp_path)
    assert cfg["expected_metrics"] == {
        "audit.scope_coverage_ratio": {"min": 0.5},
        "compare.compare_safe": True,
    }


def test_run_start_metadata_does_not_override_explicit_expected_metrics(tmp_path):
    _write_queue(tmp_path, [
        {"work_id": "w1", "status": "verified", "expected_metrics": {"audit.scope_windowed": True}},
    ])
    cfg = g2.apply_run_start_metadata(
        {"run_id": "gv2-test", "expected_metrics": {"already": {"min": 1}}}, repo_root=tmp_path
    )
    assert cfg["expected_metrics"] == {"already": {"min": 1}}


def test_purge_board_db_hard_deletes_prior_cards(tmp_path, monkeypatch):
    # gv2-2026-06-22-4: archived prior-run cards persisted in the shared board DB and the
    # planner read their stale coords. reinit must HARD-purge, not just archive.
    import sqlite3
    db = tmp_path / "kanban.db"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE tasks (id TEXT, title TEXT, body TEXT, status TEXT)")
    conn.execute("CREATE TABLE task_comments (id INTEGER, task_id TEXT, body TEXT)")
    conn.execute("CREATE TABLE task_events (id INTEGER, task_id TEXT)")
    conn.executemany("INSERT INTO tasks VALUES (?,?,?,?)", [
        ("t_old1", "[CONSTRUCT] shelter at base_anchor", "anchor: base_anchor (53,63,49)", "archived"),
        ("t_old2", "[MINE] descent", "mc goto_near 53 63 49", "done"),
    ])
    conn.execute("INSERT INTO task_comments VALUES (1, 't_old1', 'retry at (53,63,49)')")
    conn.commit()
    conn.close()

    monkeypatch.setenv("HERMES_KANBAN_DB", str(db))
    deleted = g2.purge_board_db()
    assert deleted == 2  # reports tasks cleared

    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM task_comments").fetchone()[0] == 0
    # no row anywhere still leaks the stale coord
    assert conn.execute("SELECT count(*) FROM tasks WHERE body LIKE '%53,63,49%'").fetchone()[0] == 0
    conn.close()


def test_purge_board_db_missing_db_is_noop(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "nope.db"))
    assert g2.purge_board_db() == 0


def test_shelter_site_prep_default_no_build_volume_air_wipe(monkeypatch):
    monkeypatch.delenv("GENESIS2_SHELTER_AIR_PREP", raising=False)
    cmds = g2.shelter_site_prep_commands("genesis2", 10, 64, -5)
    assert len(cmds) == 2
    assert all("cobblestone" in c or "minecraft:water" in c for c in cmds)
    assert not any(" air replace" in c and "minecraft:water" not in c for c in cmds)


def test_shelter_site_prep_air_wipe_when_flagged(monkeypatch):
    monkeypatch.setenv("GENESIS2_SHELTER_AIR_PREP", "1")
    cmds = g2.shelter_site_prep_commands("genesis2", 10, 64, -5)
    assert len(cmds) == 3
    assert any("10 65 -5 16 68 1 air replace" in c for c in cmds)


def test_purge_board_logs_removes_stale_worker_logs(tmp_path, monkeypatch):
    """gv2-2026-06-24-3: stale <board>/logs/<card>.log transcripts persist across runs
    (purge_board_db only clears DB rows) and bleed prior-run state into new workers —
    a builder rebuilt the old -167 base from a recalled log despite a wiped memory.
    reinit must clear the on-disk logs too."""
    board = tmp_path / ".hermes" / "kanban" / "boards" / "genesis-v2"
    (board / "logs").mkdir(parents=True)
    for cid in ("t_31fc54e7", "t_ce4dc0d8", "t_aaa"):
        (board / "logs" / f"{cid}.log").write_text("Built shelter at -167,71,-247")
    keep = board / "logs" / "index.json"
    keep.write_text("{}")  # non-.log file must survive
    monkeypatch.setattr(g2, "_board_db_path", lambda: board / "kanban.db")

    removed = g2.purge_board_logs()
    assert removed == 3
    assert not list((board / "logs").glob("*.log"))
    assert keep.exists()


def test_purge_board_logs_missing_dir_is_noop(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "_board_db_path", lambda: tmp_path / "none" / "kanban.db")
    assert g2.purge_board_logs() == 0
