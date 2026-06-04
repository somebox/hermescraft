"""Genesis lib unit tests (no homelab ssh)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import genesis_lib as gl  # noqa: E402


def test_next_run_id_format():
    rid = gl.next_run_id()
    assert rid.startswith("g-")
    parts = rid.split("-")
    assert len(parts) >= 5


def test_parse_anchor():
    assert gl.parse_anchor("0,64,0") == {"x": 0, "y": 64, "z": 0}


def test_build_context_flat_placeholders():
    ctx = gl.build_context(run_id="g-2026-01-01-1", seed=1, anchor={"x": 0, "y": 64, "z": 0})
    assert "anchor_x" in ctx and ctx["anchor_x"] == "0"
    assert "system_chest_x" in ctx


def test_substitute_unknown_placeholder():
    with pytest.raises(KeyError):
        gl.substitute("{unknown_x}", {"anchor_x": "1"})


@patch("genesis_lib._kanban_link")
@patch("genesis_lib._kanban_create")
def test_seed_starter_cards_topology(mock_create, mock_link, tmp_path, monkeypatch):
    monkeypatch.setattr(gl, "RUNS_ROOT", tmp_path / "runs")
    create_calls = []

    def fake_create(**kw):
        tid = str(len(create_calls) + 1)
        create_calls.append(kw)
        return tid

    mock_create.side_effect = fake_create
    ctx = gl.build_context(run_id="g-2026-01-01-1", seed=1, anchor={"x": 0, "y": 64, "z": 0})
    meta = gl.seed_starter_cards("g-2026-01-01-1", ctx)
    assert len(meta["epic_ids"]) == 4
    assert len(meta["p1_card_ids"]) == 6
    # Epic chain uses depends_on as real prerequisite: P2 depends-on P1, P3
    # depends-on P2, P4 depends-on P3. Epic IDs are returned in order, so
    # call[0]=P1, call[1]=P2, etc.
    assert create_calls[0].get("depends_on") is None
    assert create_calls[1]["depends_on"] == "1"
    assert create_calls[2]["depends_on"] == "2"
    assert create_calls[3]["depends_on"] == "3"
    # P1 worker cards: NO depends_on at create-time (children of an open
    # epic shouldn't dep on the epic itself), but EVERY card carries
    # `epic_id == P1_id` so the facade can navigate the membership.
    for c in create_calls[4:]:
        assert c.get("depends_on") is None
        assert c.get("epic_id") == "1"  # P1 epic was the first card created

    # Inter-card prereqs are wired via _kanban_link AFTER create.
    # YAML topology (data/genesis/templates/phase1-cards.yaml):
    #   chests   after anchor-confirm
    #   shelter  after anchor-confirm
    #   reconcile after chests
    #   site      after reconcile AND shelter
    # = 5 link calls.
    link_calls = [c.kwargs for c in mock_link.call_args_list]
    assert len(link_calls) == 5
    # Map call4..call9 card-create order → title:
    #   call4 = [SCOUT] Confirm base anchor          → id "5"
    #   call5 = [SCOUT] Survey resources around base → id "6"
    #   call6 = [CONSTRUCT] Place four base chests    → id "7"
    #   call7 = [CONSTRUCT] Build 5x5 cobble shelter  → id "8"
    #   call8 = [RECONCILE] Promote chest marks       → id "9"
    #   call9 = [SITE] Create shelter region marker   → id "10"
    edges = {(c["parent_id"], c["child_id"]) for c in link_calls}
    assert ("5", "7") in edges   # chests after anchor confirm
    assert ("5", "8") in edges   # shelter after anchor confirm
    assert ("7", "9") in edges   # reconcile after chests
    assert ("9", "10") in edges  # site after reconcile
    assert ("8", "10") in edges  # site after shelter


def test_archive_run_state_personal_pois(tmp_path, monkeypatch):
    """Phase A6: archive_run_state must snapshot then wipe personal-pois-*.json
    alongside locations-*.json. Establish reruns rely on this so prior-run
    POIs don't leak into a fresh disc.
    """
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    runs_root = tmp_path / "runs"
    fake_db_dir = tmp_path / "kanban"
    fake_db_dir.mkdir()
    fake_db = fake_db_dir / "kanban.db"
    fake_db.write_text("sqlite-stub")

    monkeypatch.setattr(gl, "DATA_DIR", data_dir)
    monkeypatch.setattr(gl, "RUNS_ROOT", runs_root)
    monkeypatch.setattr(gl, "KANBAN_DB", fake_db)

    (data_dir / "locations-flint.json").write_text('{"home": {"x": 0, "y": 64, "z": 0}}')
    (data_dir / "locations-base.json").write_text('{"chest_a": {"x": 1, "y": 64, "z": 0}}')
    (data_dir / "personal-pois-flint.json").write_text(
        '{"spider_hill": {"name": "spider_hill", "x": 3, "y": 64, "z": 4}}'
    )
    (data_dir / "personal-pois-shared.json").write_text(
        '{"cairn_n": {"name": "cairn_n", "x": 0, "y": 64, "z": 10}}'
    )

    gl.archive_run_state("g-2026-06-04-1")

    arch = runs_root / "g-2026-06-04-1" / "archived"
    assert (arch / "personal-pois-flint.json").exists(), "per-bot POIs must be archived"
    assert (arch / "personal-pois-shared.json").exists(), "shared POI overlay must be archived"
    assert (arch / "locations-flint.json").exists(), "regression: locations still archived"

    # Live data dir must be wiped so the fresh world starts clean.
    assert not (data_dir / "personal-pois-flint.json").exists(), \
        "per-bot POIs must be removed from live data dir"
    assert not (data_dir / "personal-pois-shared.json").exists(), \
        "shared POI overlay must be removed from live data dir"
    assert not (data_dir / "locations-flint.json").exists(), \
        "regression: locations still wiped"


def test_check_phases_empty_state(tmp_path, monkeypatch):
    monkeypatch.setattr(gl, "DATA_DIR", tmp_path / "data")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "regions-world.json").write_text('{"regions": []}')
    cfg = {
        "run_id": "g-x",
        "seed": 1,
        "base_anchor": {"x": 0, "y": 64, "z": 0},
    }
    with patch("genesis_lib._kanban_list", return_value=[]):
        with patch("genesis_lib._run") as mock_run:
            mock_run.return_value = type("R", (), {"returncode": 0, "stdout": "{}"})()
            r = gl.check_phases(cfg)
    assert "P1" in r
    assert r["P1"]["pass"] is False
